// ============================================================
// LONGHAUL — The service record: our license, our flag, the powers
//
// One window for where we stand in the wider world (sim/service.js,
// sim/politics.js): the license we hold and whether we fly its flag (a
// navy hull of its power), our rank and reputation, how every faction
// sees us and why (our own standing, and under a flag our power's
// relation with theirs), the state of the powers (cold war, crisis,
// war), who has the say inside each, the orders we have been given, the
// hot zones we have heard of (by faction, those needing guns first, one
// click to the map or a route, and each fight's forward commands, the FOBs:
// the navies' command ships at its rear, where they stand and how far, one
// click to them, alongside ours), and the political news that has reached us.
// ============================================================

import { ui } from './context.js';
import { esc, fmtNum, fmtKm } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { formatDuration } from '../core/clock.js';
import { bus } from '../core/events.js';
import { FACTIONS, POWERS, SUBFACTIONS, politicalSubs, factionColor } from '../sim/factions.js';
import { PAIRS, PHASES, leadingSub } from '../sim/politics.js';
import {
  licenseOf, flagOf, contractor, hullLegal, navyOf, rankOf, rankName, relationsTable, openCallups, resignLicense,
  RANK_REP, RANKS, PAY_PER_RANK,
} from '../sim/service.js';
import { WANTED_LABEL } from '../sim/law.js';
import { CLASSES } from '../sim/ship-classes.js';
import { ZONE_KINDS, zonePos } from '../sim/conflict.js';
import { getWorld } from '../sim/world.js';
import { fobsOf } from '../sim/forces.js';
import { AU_KM } from '../core/constants.js';

let hooks = {};
export function initService(h) { hooks = h; }   // { openDialog, closeDialog, plotRoute, showOnMap }

// ---- HOT ZONES ----
// What we have heard of (the plot's zones: intel.js), for one faction or all,
// those where guns are wanted first: a war front, shots fired, raiders on a
// power's shipping, pirates on the lanes, a cell's war, a blockade, a standoff.
const NEED = { front: 6, skirmish: 5, proxy: 4, pirates: 3, insurgency: 2, blockade: 1, standoff: 1 };
const ZONE_FILTERS = ['flag', 'all', 'UN', 'MCR', 'OPA', 'pirate'];
let zoneFilter = null;            // (null: our flag's, if we fly one, else all)
let confirmResign = false;        // handing back the license takes a second, deliberate click on what it costs

/** Who a zone is about, as the plot has it: the powers in it, or the pirates. */
const zoneSides = (z) => z.kind === 'pirates' ? ['pirate'] : (z.factions || []).filter(Boolean);

function zoneRows(s) {
  const flag = flagOf(s), now = s.clock.minute, world = getWorld(s);
  const filter = zoneFilter || (flag ? 'flag' : 'all');
  const want = filter === 'flag' ? flag : filter === 'all' ? null : filter;
  const f = s.flight.pos;
  const calls = new Set(openCallups(s).map(cu => cu.zoneId));
  const list = Object.entries(s.intel?.zones || {}).map(([id, z]) => {
    const sides = zoneSides(z);
    const ours = !!flag && sides.includes(flag);
    const p = zonePos({ ...z, id }, now);
    return { id, z, sides, ours, call: calls.has(id), dist: Math.hypot(p.x - f.x, p.y - f.y), need: (NEED[z.kind] || 0) * (ours ? 2 : 1) };
  }).filter(r => !want || r.sides.includes(want))
    .sort((a, b) => b.need - a.need || a.dist - b.dist);
  const btn = (k) => `<button class="svc-zf ${filter === k ? 'active' : ''}" data-act="zone-filter" data-k="${k}" ${k === 'flag' ? `title="Where the ${esc(FACTIONS[flag].navy)} is in it"` : ''}>${k === 'flag' ? 'OUR FLAG' : k === 'all' ? 'ALL' : k === 'pirate' ? 'PIRATES' : esc(FACTIONS[k].short)}</button>`;
  const filters = ZONE_FILTERS.filter(k => k !== 'flag' || flag).map(btn).join('');
  const rows = list.map(r => {
    const sides = r.sides.map(x => `<span style="color:${factionColor(x)}">${esc(x === 'pirate' ? 'pirates' : FACTIONS[x]?.short || x)}</span>`).join(' · ');
    const anchor = world.get(`anchor-${r.id}`);
    const tags = `${r.ours ? '<span class="svc-tag ours">OUR FIGHT</span>' : ''}${r.call ? '<span class="svc-tag call">CALL-UP</span>' : ''}`;
    return `<div class="svc-zone svc-need-${Math.min(3, Math.ceil((NEED[r.z.kind] || 0) / 2))}">
      <span class="svc-zone-kind">${esc(ZONE_KINDS[r.z.kind]?.label || r.z.kind)}</span>
      <span class="svc-zone-where">${esc(r.z.body)}${sides ? ` · ${sides}` : ''}${tags}</span>
      <span class="svc-meta">${fmtKm(r.dist * AU_KM)} · heard ${formatDuration(now - r.z.heard)} ago</span>
      <span class="svc-zone-acts"><button class="btn btn-secondary btn-small" data-act="zone-map" data-id="${esc(r.id)}">MAP</button><button class="btn btn-primary btn-small" data-act="zone-plot" data-id="${esc(r.id)}"${anchor ? '' : ' title="No fleet anchor charted there: a route to the body"'}>PLOT</button></span>
      ${fobRows(s, r.id, flag)}
    </div>`;
  }).join('');
  return `<div class="svc-zf-row">${filters}</div><p class="svc-meta">Where guns are wanted first: war fronts, shots fired, raiders on a power's shipping, pirates on the lanes${flag ? '; our own power\'s fights before others\'' : ''}.</p>${rows || `<p class="missions-empty">— no hot zone we have heard of${want ? ` for ${want === 'pirate' ? 'pirates' : esc(FACTIONS[want].short)}` : ''} —</p>`}`;
}

/**
 * A fight's forward commands (FOBs): each navy's command ship at its rear.
 * On its post it is charted (named, where it holds); on its way out only
 * our own navy tells us where; none in port, it says so. Ours takes us
 * alongside: missions, and supplies at a tenth.
 */
function fobRows(s, id, flag) {
  const z = s.politics.zones.find(x => x.id === id);
  const fobs = fobsOf(s, z);
  if (!fobs.length) return '';
  const f = s.flight.pos;
  return `<div class="svc-fobs">${fobs.map(({ faction, ship, status }) => {
    const ours = faction === flag;
    const who = `<span class="svc-fob-k" style="color:${factionColor(faction)}">${esc(FACTIONS[faction].short)} FOB</span>`;
    if (status === 'none') return `<div class="svc-fob">${who}<span class="svc-fob-meta">none in port yet: one goes out as soon as a yard has one</span></div>`;
    if (status === 'transit' && !ours) return `<div class="svc-fob">${who}<span class="svc-fob-meta">on its way out to the rear</span></div>`;
    const d = Math.hypot(ship.pos.x - f.x, ship.pos.y - f.y) * AU_KM;
    const what = status === 'post' ? (ours ? 'on its post, takes us alongside: missions, supplies at a tenth' : 'on its post at the rear') : 'on its way out to the rear';
    return `<div class="svc-fob">${who}<span class="svc-fob-name">${esc(ship.name)}</span><span class="svc-fob-meta">${fmtKm(d)} · ${what}</span>
      <span class="svc-fob-acts"><button class="btn btn-secondary btn-small" data-act="fob-map" data-id="${esc(ship.id)}">MAP</button>${ours ? `<button class="btn btn-primary btn-small" data-act="fob-plot" data-id="${esc(ship.id)}" title="A route alongside it, to dock">ALONGSIDE</button>` : ''}</span></div>`;
  }).join('')}</div>`;
}

/** Where to go for a zone: its fleets' anchor, if one is charted, else the body it is round. */
function zoneTarget(s, id) {
  const z = s.intel?.zones?.[id];
  if (!z) return null;
  return getWorld(s).get(`anchor-${id}`) ? { kind: 'entity', id: `anchor-${id}` } : { kind: 'body', id: z.body };
}

const BAND = { own: 'OUR FLAG', friend: 'FRIEND', neutral: 'NEUTRAL', wary: 'WARY', hostile: 'HOSTILE', enemy: 'ENEMY' };
/** Headlines older than this have reached us wherever we are in the inner system and the Belt. */
const HEARD_AFTER_MIN = 45;

function render() {
  const s = ui.state;
  const S = s.service;
  const L = licenseOf(s);
  const flag = flagOf(s);
  const now = s.clock.minute;
  const navy = navyOf(s.ship.classId);
  // ---- the license and the flag
  let status;
  if (!L) status = navy ? `<p class="svc-warn">No license. ${esc(CLASSES[s.ship.classId].name)} is ${navy === 'stolen' ? 'a stolen navy hull: illegal everywhere' : `a ${FACTIONS[navy].navy} hull: illegal to fly without its license`}.</p>`
    : '<p class="dialog-text">No military license: a civilian captain. A power\'s stations take applications from captains in good standing (10+), and its license with one of its navy\'s hulls makes you its contractor.</p>';
  else if (flag) status = `<p class="dialog-text">${esc(FACTIONS[L].navy)} contractor, flying the ${esc(FACTIONS[L].short)} flag: its enemies are ours, its friends ours. Licensed ${formatDuration(now - S.since)} ago.</p>`;
  else status = `<p class="dialog-text">${esc(FACTIONS[L].navy)} license, in a civilian hull: no flag, no call-ups. Nuclear torpedoes are legal for us in ${esc(FACTIONS[L].short)} space.</p>`;
  const rep = L ? S.rep[L] || 0 : 0;
  const r = rankOf(s);
  const next = RANK_REP[r + 1];
  const pct = next != null ? Math.round((rep - RANK_REP[r]) / (next - RANK_REP[r]) * 100) : 100;
  const rank = L ? `<div class="svc-rank" style="--fc:${factionColor(L)}">
      <div class="svc-rank-title">${esc(rankName(s))}</div>
      <div class="svc-bar"><i style="width:${pct}%"></i></div>
      <div class="svc-meta">Reputation ${fmtNum(rep)}${next != null ? ` · ${esc(RANKS[L][r + 1])} at ${fmtNum(next)}` : ' · the highest rank a contractor holds'} · military pay ×${(1 + PAY_PER_RANK * r).toFixed(2)} · ${S.kills} kills · ${S.missions} missions</div>
    </div>` : '';
  // ---- how every faction sees us
  const rows = relationsTable(s).map(x => `<tr class="svc-${x.band}">
      <td><span class="svc-dot" style="background:${factionColor(x.faction)}"></span>${esc(FACTIONS[x.faction]?.name || x.faction)}</td>
      <td>${x.standing != null ? Math.round(x.standing) : '—'}</td>
      <td>${x.mirror != null ? Math.round(x.mirror) : '—'}</td>
      <td><b>${Math.round(x.relation)}</b></td>
      <td>${BAND[x.band]}${x.atWar ? ' · AT WAR' : ''}</td>
      <td>${POWERS.includes(x.faction) ? WANTED_LABEL[s.law.wanted[x.faction]] : ''}</td></tr>`).join('');
  // ---- the powers
  const pairs = PAIRS.map(k => {
    const p = s.politics.pairs[k];
    const [a, b] = k.split('-');
    return `<div class="svc-pair svc-ph-${p.phase}"><span>${esc(FACTIONS[a].short)} · ${esc(FACTIONS[b].short)}</span><b>${PHASES[p.phase].label}</b><span class="svc-meta">${Math.round(p.rel)}${p.phase === 'war' ? ` · war ${formatDuration(now - p.since)}` : ''}</span></div>`;
  }).join('');
  const subs = POWERS.map(f => `<div class="svc-power"><div class="svc-power-name" style="color:${factionColor(f)}">${esc(FACTIONS[f].name)}</div>
      ${politicalSubs(f).map(id => { const v = s.politics.subs[id]?.influence ?? 0; return `<div class="svc-sub" title="${esc(SUBFACTIONS[id].desc)}"><span>${esc(SUBFACTIONS[id].name)}${id === leadingSub(s, f) ? ' ◂' : ''}</span><span class="svc-sub-agenda">${esc(SUBFACTIONS[id].agenda)}</span><span class="svc-bar small"><i style="width:${Math.round(v * 100)}%"></i></span></div>`; }).join('')}</div>`).join('');
  // ---- orders, news, record
  const orders = openCallups(s).map(cu => `<div class="svc-order"><span>${esc(cu.shipName)} · ${esc(cu.body)}</span><span>${cu.reported ? 'REPORTED' : 'REPORT ALONGSIDE'}</span>${cu.reported ? '' : `<button class="btn btn-primary btn-small" data-act="plot-cmd" data-id="${cu.ship}">PLOT</button>`}</div>`).join('');
  const news = s.politics.headlines.filter(h => now - h.at >= HEARD_AFTER_MIN).slice(-8).reverse().map(h => `<div class="svc-news"><span class="svc-meta">${formatDuration(now - h.at)} ago</span> ${esc(h.text)}</div>`).join('');
  const record = (S.record || []).slice(-8).reverse().map(x => `<div class="svc-news"><span class="svc-meta">${formatDuration(now - x.at)} ago</span> ${esc(x.text)}</div>`).join('');
  const resign = confirmResign && L ? `<div class="svc-confirm">
      <b>Hand back the ${esc(FACTIONS[L].navy)} license?</b>
      <p>We give up the ${esc(FACTIONS[L].short)} flag and its call-ups${navy === L ? `, and the ${esc(CLASSES[s.ship.classId].name)} becomes unlicensed military kit: illegal to fly, and every ${esc(FACTIONS[L].short)} patrol will want to see it` : ''}. Our reputation stays on their books; the license itself is applied for again at one of their stations.</p>
      <div class="svc-confirm-acts"><button class="btn btn-secondary btn-small" data-act="resign-cancel">KEEP IT</button><button class="btn btn-danger btn-small" data-act="resign-confirm">HAND IT BACK</button></div>
    </div>` : '';
  return `<div class="svc">
    <div class="svc-col">
      <div class="missions-section">LICENSE</div>${resign}${status}${rank}
      ${orders ? `<div class="missions-section mil">ORDERS</div>${orders}` : ''}
      <div class="missions-section">RELATIONS</div>
      <table class="svc-table"><thead><tr><th>Faction</th><th title="Our own standing with them">Ours</th><th title="Our power's relation with them (under a flag)">Flag</th><th title="How they treat us">Relation</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="svc-meta">${flag ? 'Under a flag, a faction sees us through our power: its relation with them, and a tenth of our own standing.' : 'Without a flag, each power judges us on our own standing.'}</p>
      ${record ? `<div class="missions-section">SERVICE RECORD</div>${record}` : ''}
    </div>
    <div class="svc-col">
      <div class="missions-section">HOT ZONES</div>${zoneRows(s)}
      <div class="missions-section">THE POWERS</div>${pairs}
      ${subs}
      <div class="missions-section">POLITICAL NEWS</div>${news || '<p class="missions-empty">— nothing yet —</p>'}
    </div></div>`;
}

export function openService() {
  const s = ui.state;
  if (!s) return;
  confirmResign = false;
  const L = licenseOf(s);
  const body = hooks.openDialog({
    title: 'Service & Relations', cls: 'dialog-service', html: render(),
    buttons: [...(L ? [{ label: 'Resign license…', act: 'resign', cls: 'btn-secondary' }] : []), { label: 'Close', act: 'close', cls: 'btn-primary' }],
    onAction: (act, b) => {
      if (act === 'plot-cmd' || act === 'fob-plot') { hooks.closeDialog(); hooks.plotRoute({ kind: 'entity', id: b.dataset.id }, { dock: true }); return; }
      if (act === 'fob-map') { hooks.closeDialog(); hooks.showOnMap({ kind: 'entity', id: b.dataset.id }); return; }
      if (act === 'zone-filter') { zoneFilter = b.dataset.k; body.querySelector('.dialog-content').innerHTML = render(); return; }
      if (act === 'zone-map' || act === 'zone-plot') {
        const t = zoneTarget(s, b.dataset.id);
        if (!t) return;
        hooks.closeDialog();
        if (act === 'zone-map') hooks.showOnMap(t); else hooks.plotRoute(t);
        return;
      }
      // (the footer's button only asks; the confirm panel's does it)
      if (act === 'resign' || act === 'resign-cancel') { confirmResign = act === 'resign'; body.querySelector('.dialog-content').innerHTML = render(); body.querySelector('.dialog-content').scrollTop = 0; return; }
      if (act === 'resign-confirm') {
        confirmResign = false;
        const r = resignLicense(s, (t, p) => bus.emit(t, p));
        toast(r.text, r.ok ? 'ok' : 'warn');
        if (r.ok) logEntry(r.text, 'system');
        hooks.closeDialog();
        return;
      }
      body.querySelector('.dialog-content').innerHTML = render();
    },
  });
}

/** The chip by our ship's name: the flag we fly and our rank, or a warning about our hull. */
export function flagChip(state) {
  const L = licenseOf(state);
  if (!hullLegal(state)) return { text: navyOf(state.ship.classId) === 'stolen' ? 'STOLEN HULL' : 'UNLICENSED HULL', cls: 'bad', color: null };
  if (!L) return null;
  if (!contractor(state)) return { text: `${FACTIONS[L].short} LICENSE`, cls: 'dim', color: factionColor(L) };
  return { text: `${FACTIONS[L].navy} · ${rankName(state).toUpperCase()}`, cls: 'flag', color: factionColor(L) };
}
