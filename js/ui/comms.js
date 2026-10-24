// ============================================================
// LONGHAUL — The comms window
//
// The radio: every station and ship we can talk to (in radio range, the
// stations always first), the conversation with the one we hail (the
// topics the sim offers: sim/dialogue.js), and a card of what we know
// about them: their hull, flag and class, how many are aboard and how we
// know it (the nav computer's marks by each name on the channel list:
// marks.js), their collars, and for a station our clearances, the berth
// board and what we owe there. Some answers open another window: the
// station's board or services, the hiring hall, shore leave, trade over
// the collar, a boarding.
// ============================================================

import { ui } from './context.js';
import { $, esc, show, fmtMeters, fmtNum, fmtRewards } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M } from '../core/constants.js';
import { bus } from '../core/events.js';
import { getWorld } from '../sim/world.js';
import { signalBars, canTransmit } from '../sim/comms.js';
import { openChannel, topics, say, closeChannel, channel, attitude, persona, shipOffer, buyFromShip } from '../sim/dialogue.js';
import { knownCrew } from '../sim/manifest.js';
import { hullOf, portSummary } from '../sim/hulls.js';
import { STATIONS } from '../sim/stations.js';
import { clearanceFor, stationTraffic, zoneAt } from '../sim/traffic-control.js';
import { finesOwed, WANTED_LABEL } from '../sim/law.js';
import { classLabel, CLASSES } from '../sim/ship-classes.js';
import { FACTIONS, factionColor } from '../sim/factions.js';
import { completeRescue, missionForEntity } from '../sim/missions.js';
import { hailContractTarget } from '../sim/contracts.js';
import { contactById, isDark } from '../sim/sensors.js';
import { isDocked, dockedTo } from '../sim/docking.js';
import { drawHullPortrait } from './hull-art.js';
import { frameMarks, marksOf, markChips } from './marks.js';
import { ourName } from '../sim/service.js';

const emit = (t, p) => bus.emit(t, p);
let hooks = {};
let openSub = null;

export function initComms(h) {
  hooks = h;    // { openStation(entity, tab), openBoarding(id), setPaused(reason, on) }
  const ov = $('#dialog-comms');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeComms(); });
  ov.addEventListener('click', onClick);
}

export const commsOpen = () => $('#dialog-comms').style.display !== 'none';

/** Open the radio (on a channel, if given). */
export function openComms(entityId = null) {
  const s = ui.state;
  if (!s) return;
  show($('#dialog-comms'), true, 'flex');
  if (entityId) hailChannel(entityId);
  render();
}

export function closeComms() {
  if (!commsOpen()) return false;
  show($('#dialog-comms'), false);
  if (ui.state) closeChannel(ui.state);
  openSub = null;
  return true;
}

/** Hail: open a channel (the radio array, or close in a suit radio or a signal lamp). */
function hailChannel(id) {
  const s = ui.state;
  const e = getWorld(s).get(id);
  if (!e) return;
  const dM = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y) * AU_M;
  if (!canTransmit(s) && dM > 50_000) { toast('Comms array down — no transmitter', 'danger'); return; }
  const conv = openChannel(s, id);
  if (conv.error) { toast(conv.error, 'warn'); return; }
  // Errands that end with a hail: a rescue, a contract's target
  const m = missionForEntity(s, id);
  if (m) {
    const r = completeRescue(s, m.id);
    conv.lines.push({ who: 'sys', text: r.text });
    if (r.success) { toast('Rescue complete', 'ok'); logEntry(`Rescue of ${e.name} complete${fmtRewards(r.rewards) ? ' — ' + fmtRewards(r.rewards, ', ') : ''}`, 'ok'); }
  } else {
    const r = hailContractTarget(s, id);
    if (r) { conv.lines.push({ who: 'sys', text: r.text }); if (r.ok) { toast('Objective complete', 'ok'); logEntry(`${r.contract.title}: objective complete`, 'ok'); } }
  }
  logEntry(`Hailed ${e.transponder || e.type === 'station' ? e.name : 'unidentified contact'}`, 'comms');
  openSub = null;
}

// ---- RENDER ----

function channels(s) {
  const world = getWorld(s);
  const ids = new Set(s.comms.radio);
  if (s.dock) ids.add(s.dock.target.id);
  const out = [];
  for (const id of ids) {
    const e = world.get(id);
    if (!e || e.type === 'nav') continue;
    const dAU = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y);
    out.push({ e, dAU });
  }
  out.sort((a, b) => (b.e.type === 'station') - (a.e.type === 'station') || a.dAU - b.dAU);
  return out;
}

function render() {
  const s = ui.state;
  const body = $('#dialog-comms-body');
  const conv = channel(s);
  const list = channels(s);
  const fm = frameMarks(s);
  const row = ({ e, dAU }) => {
    const c = contactById(s, e.id);
    const known = e.type === 'station' || e.transponder || c?.name;
    const lag = dAU * AU_M / 299_792_458;
    const bars = signalBars(dAU);
    return `<div class="cm-ch ${conv?.with === e.id ? 'active' : ''}" data-act="channel" data-id="${e.id}">
      <span class="cm-ch-name" style="color:${known ? factionColor(e.faction) : '#7A8EA2'}">${e.sos ? '⚠ ' : ''}${esc(known ? e.name : 'unidentified contact')}${markChips(marksOf(fm, e.id, isDark(e), e.tags?.wreck))}</span>
      <span class="cm-ch-meta"><span>${esc(e.type === 'station' ? e.shipClass : known ? (CLASSES[e.cls]?.name || 'ship') : 'no transponder')}</span><span>${fmtMeters(dAU * AU_M)} · <span class="cm-bars" title="Signal ${bars} of 5">${'▮'.repeat(bars)}${'▯'.repeat(5 - bars)}</span>${lag >= 0.1 ? ` · ${lag.toFixed(1)} s` : ''}</span></span></div>`;
  };
  const stations = list.filter(x => x.e.type === 'station'), ships = list.filter(x => x.e.type !== 'station');
  const left = `${stations.length ? `<div class="cm-ch-sec">STATIONS</div>${stations.map(row).join('')}` : ''}<div class="cm-ch-sec">SHIPS (${ships.length}${s.comms.radioTotal > list.length ? ` of ${s.comms.radioTotal}` : ''})</div>${ships.map(row).join('') || '<div class="cm-empty">Nothing on the radio.</div>'}`;
  let mid = '<div class="cm-empty">Pick a channel to hail.</div>', card = '';
  if (conv) {
    const e = getWorld(s).get(conv.with);
    const who = e ? (e.type === 'station' || e.transponder ? e.name : 'UNIDENTIFIED') : 'CHANNEL';
    const lines = conv.lines.map(l => `<div class="cm-line cm-${l.who}">${l.who === 'them' ? `<span class="cm-who">${esc(who)}</span>` : l.who === 'us' ? `<span class="cm-who">${esc(ourName(s))}</span>` : ''}${esc(l.text)}</div>`).join('');
    const tps = topics(s).map(t => {
      if (t.sub && openSub === t.id) return `<div class="cm-sub"><span class="cm-why">${esc(t.label)}:</span>${t.sub.map(x => `<button class="cm-topic" data-act="say" data-t="${t.id}" data-arg="${x.id}">${esc(x.label)}</button>`).join('') || '<span class="cm-why">nobody in range</span>'}<button class="cm-topic" data-act="sub" data-t="">back</button></div>`;
      return `<button class="cm-topic ${t.group === 'threat' ? 'cm-threat' : ''}" data-act="${t.sub ? 'sub' : 'say'}" data-t="${t.id}" ${t.why ? 'disabled' : ''}>${esc(t.label)}${t.why ? `<span class="cm-why">${esc(t.why)}</span>` : ''}</button>`;
    }).join('');
    mid = `<div class="cm-lines">${lines}</div><div class="cm-topics">${tps}</div>`;
    card = e ? cardHTML(s, e) : '';
  }
  body.innerHTML = `<div class="cm-top"><span class="cm-title">COMMS</span><span class="cm-ch-meta">${canTransmit(s) ? 'Array up' : 'ARRAY DOWN — suit radio only'} · transponder ${s.comms.transponder ? 'ON' : 'SILENT'}</span><button class="tac-modal-close" data-act="close">&times;</button></div>
    <div class="cm-cols"><div class="cm-channels">${left}</div><div class="cm-talk">${mid}</div><div class="cm-card">${card}</div></div>`;
  const lines = body.querySelector('.cm-lines');
  if (lines) lines.scrollTop = lines.scrollHeight;
  const cv = body.querySelector('canvas[data-hull]');
  if (cv) {
    const e = getWorld(s).get(cv.dataset.hull);
    if (e?.type === 'ship') drawHullPortrait(cv, hullOf(e.cls), { tint: factionColor(e.faction) });
  }
}

function cardHTML(s, e) {
  const k = (label, v) => `<div><span class="cm-k">${label}</span><br><b>${v}</b></div>`;
  const dM = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y) * AU_M;
  const fac = FACTIONS[e.faction];
  const att = attitude(s, e);
  const mood = att > 0.3 ? 'friendly' : att > -0.1 ? 'businesslike' : att > -0.5 ? 'wary' : 'hostile';
  if (e.type === 'station') {
    const spec = STATIONS[e.id];
    const cl = clearanceFor(s, e.id);
    const t = stationTraffic(s, e);
    const owed = finesOwed(s, e.faction).reduce((a, f) => a + f.amount, 0);
    const now = s.clock.minute;
    return `${k('STATION', `<span class="lib-inline" data-lib="stn:${e.id}">${esc(e.name)}</span>`)}
      ${k('KIND', `${esc(spec?.kind || e.shipClass)} · ${spec?.site === 'surface' ? `on ${spec.body}'s surface` : `orbiting ${spec?.body}`}`)}
      ${k('FLAG', esc(fac?.name || e.faction))}
      ${k('RANGE', `${fmtMeters(dM)} · ${isDocked(s) && dockedTo(s)?.id === e.id ? 'IN A BERTH' : { keepout: 'INSIDE THE GATE', approach: 'ON THE APPROACH', control: 'CONTROL SPACE', none: 'OUTSIDE CONTROL SPACE' }[zoneAt(e, dM)]}`)}
      ${k('CLEARANCE', cl.dock ? `to dock, ${esc(cl.dock.berth)} · ${cl.dock.until - now} min` : cl.hold ? `holding ${esc(cl.hold.slot)} · ${Math.round((cl.hold.until - now) / 60)} h` : cl.approach ? 'approach' : cl.depart ? 'departure' : 'none')}
      ${k('BERTHS', `${t.used}/${t.total} taken · ${t.holding}/${t.holdingTotal} holding${t.anchored ? ` · ${t.anchored} at the anchorage` : ''}`)}
      ${k('OUR RECORD', `${e.faction in s.law.standing ? `standing ${Math.round(s.law.standing[e.faction])} · ${WANTED_LABEL[s.law.wanted[e.faction]]}` : 'independent'}${owed ? ` · ${fmtNum(owed)} MCR owed` : ''}`)}
      ${k('POPULATION', fmtNum(spec?.population || 0))}
      ${k('TONE', mood)}`;
  }
  const c = contactById(s, e.id);
  const known = e.transponder || !!c?.name;
  const crew = knownCrew(s, e, { identified: known });
  const p = persona(e);
  return `<canvas width="236" height="70" data-hull="${e.id}"></canvas>
    ${k('SHIP', esc(known ? e.name : 'unidentified'))}
    ${k('CLASS', known ? `<span class="lib-inline" data-lib="ship:${e.cls}">${esc(classLabel(e))}</span>` : '—')}
    ${k('FLAG', known ? esc(fac?.name || e.faction) : '—')}
    ${k('RANGE', fmtMeters(dM))}
    ${k('ABOARD', crew ? `${esc(crew.text)}<br><span class="cm-k">${esc(crew.src.toUpperCase())}${crew.by ? ` · ${esc(crew.by)}` : ''}${crew.ageMin > 1 ? ` · ${Math.round(crew.ageMin / 60)} h old` : ''}</span>` : 'unknown')}
    ${k('COLLARS', known ? esc(portSummary(e.cls)) : '—')}
    ${CLASSES[e.cls]?.atmo && known ? k('ATMOSPHERE', 'rated for entry') : ''}
    ${k('STATE', p === 'struck' ? 'struck its colours' : p === 'crippled' ? 'dead in space' : e.agent?.mode === 'dock-hold' ? 'holding for us' : e.thrust > 0 ? `under thrust, ${e.thrust.toFixed(1)} G` : 'coasting')}
    ${k('TONE', mood)}
    ${isDocked(s) && dockedTo(s)?.id === e.id ? k('DOCKED', 'collar to collar') : ''}`;
}

// ---- ACTIONS ----

function onClick(ev) {
  const b = ev.target.closest('[data-act]');
  if (!b || !ui.state) {
    const lib = ev.target.closest('[data-lib]');
    if (lib) hooks.openLibrary?.(lib.dataset.lib);
    return;
  }
  const s = ui.state;
  switch (b.dataset.act) {
    case 'close': closeComms(); return;
    case 'channel': hailChannel(b.dataset.id); break;
    case 'sub': openSub = b.dataset.t || null; break;
    case 'say': {
      openSub = null;
      const r = say(s, b.dataset.t, b.dataset.arg || null, emit);
      for (const l of r.lines || []) if (l.who === 'them') logEntry(`[${channelName(s)}] ${l.text}`, 'comms');
      if (r.close) { closeComms(); return; }
      if (r.open) { act(r.open); return; }
      // cleared to dock: the docking computer takes it from here (from afar, the route in first)
      if (r.dock && !(s.dock && s.dock.target.id === r.dock && s.dock.phase !== 'holding')) { closeComms(); hooks.dock?.(r.dock); return; }
      // a holding slot granted: the nav computer plots the way into it
      if (r.route && !(s.flight.hold?.kind === 'slot' && s.flight.hold.id === r.route.id)) { closeComms(); hooks.plotRoute?.(r.route); return; }
      break;
    }
  }
  render();
}

const channelName = (s) => getWorld(s).get(channel(s)?.with)?.name || 'channel';

/** An answer that opens another window. */
function act(what) {
  const s = ui.state;
  const e = getWorld(s).get(channel(s)?.with);
  closeComms();
  if (!e) return;
  if (what === 'board' || what === 'services' || what === 'hire' || what === 'leave') hooks.openStation?.(e, what);
  else if (what === 'trade') openTrade(e);
  else if (what === 'boarding') hooks.openBoarding?.(e.id);
}

/** Trade over the collar with a ship we are docked to. */
export function openTrade(e) {
  const s = ui.state;
  const render2 = () => {
    const offer = shipOffer(s, e);
    if (!offer) return '<p class="dialog-text">Not docked with them.</p>';
    return `<div class="service-list">${offer.items.map(i => `<div class="service-row"><span class="service-name">${esc(i.name)}</span><span class="service-stock">${fmtNum(s.resources[i.key].current)} / ${fmtNum(s.resources[i.key].max)} aboard · they have ${fmtNum(i.qty)} ${esc(i.unit)}</span><span class="service-price">${i.price ? `${i.price} MCR/${esc(i.unit)}` : 'free'}</span><button class="station-mission-accept" data-act="buy" data-key="${i.key}">TAKE</button></div>`).join('')}
      <div class="service-credits">Credits: <b>${fmtNum(s.resources.credits.current)} MCR</b></div></div>`;
  };
  const body = hooks.openDialog({
    title: `Trade · ${e.name}`, cls: 'dialog-wide', html: render2(),
    onAction: (a, btn) => {
      if (a !== 'buy') return;
      const r = buyFromShip(s, e, btn.dataset.key);
      toast(r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(r.text, 'system');
      body.querySelector('.dialog-content').innerHTML = render2();
    },
  });
}

/** Keep an open window current (channels move, clearances run down). */
export function updateComms() {
  if (!commsOpen() || !ui.state) return;
  const now = ui.state.clock.minute;
  if (now === updateComms.at) return;
  updateComms.at = now;
  if (now % 5 === 0) render();
}
