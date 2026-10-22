// ============================================================
// LONGHAUL — The service record: our license, our flag, the powers
//
// One window for where we stand in the wider world (sim/service.js,
// sim/politics.js): the license we hold and whether we fly its flag (a
// navy hull of its power), our rank and reputation, how every faction
// sees us and why (our own standing, and under a flag our power's
// relation with theirs), the state of the powers (cold war, crisis,
// war), who has the say inside each, the orders we have been given, and
// the political news that has reached us.
// ============================================================

import { ui } from './context.js';
import { esc, fmtNum } from './dom.js';
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

let hooks = {};
export function initService(h) { hooks = h; }   // { openDialog, closeDialog, plotRoute }

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
  return `<div class="svc">
    <div class="svc-col">
      <div class="missions-section">LICENSE</div>${status}${rank}
      ${orders ? `<div class="missions-section mil">ORDERS</div>${orders}` : ''}
      <div class="missions-section">RELATIONS</div>
      <table class="svc-table"><thead><tr><th>Faction</th><th title="Our own standing with them">Ours</th><th title="Our power's relation with them (under a flag)">Flag</th><th title="How they treat us">Relation</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="svc-meta">${flag ? 'Under a flag, a faction sees us through our power: its relation with them, and a tenth of our own standing.' : 'Without a flag, each power judges us on our own standing.'}</p>
      ${record ? `<div class="missions-section">SERVICE RECORD</div>${record}` : ''}
    </div>
    <div class="svc-col">
      <div class="missions-section">THE POWERS</div>${pairs}
      ${subs}
      <div class="missions-section">POLITICAL NEWS</div>${news || '<p class="missions-empty">— nothing yet —</p>'}
    </div></div>`;
}

export function openService() {
  const s = ui.state;
  if (!s) return;
  const L = licenseOf(s);
  const body = hooks.openDialog({
    title: 'Service & Relations', cls: 'dialog-service', html: render(),
    buttons: [...(L ? [{ label: 'Resign license', act: 'resign', cls: 'btn-secondary' }] : []), { label: 'Close', act: 'close', cls: 'btn-primary' }],
    onAction: (act, b) => {
      if (act === 'plot-cmd') { hooks.closeDialog(); hooks.plotRoute({ kind: 'entity', id: b.dataset.id }, { dock: true }); return; }
      if (act === 'resign') {
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
