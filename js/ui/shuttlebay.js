// ============================================================
// LONGHAUL — The shuttle window: our bays, a run planned, a run flown
//
// What our shuttles are doing (sim/shuttles.js), and where they can go:
// from a world's high orbit (the parking orbit or a stationary one held:
// worlds.js), a spaceport in one of its airspaces. The plan is the run's
// whole timeline before anything moves (a wait in the bay for its window,
// the way down, burn, coast, burn, by a low orbit if that is quicker, the
// entry and what it costs the shield and the crew, the landing, the
// turnaround, the climb, the way back), its controller's answer to the
// landing, and the
// freight bound for that pad that will go down with it (PLANETSIDE
// contracts), who goes (the pilot, the riders in its seats, and ASHORE:
// a run ashore at the spaceport, the pad held eight hours, each who goes
// doing one thing there: leave, a course, the hospital, retiring; the hurt
// riding down as patients: sim/ground.js), the spaceport's hall (hands to
// sign on at the pad, up in the seats left free), and the
// world's market (sim/market.js, its prices live from
// its space): goods of ours to sell down, and one to buy and bring up, in
// the shuttle's room. Launched, the window follows it: its phase, its height and
// speed, the heat and the G of the entry as they come, and its log, and it
// can be called back (CALL BACK: shuttles.js abortRun), ridden along on
// its cameras (CAMERA: shuttlecam.js), followed on the map (MAP). G opens it; a
// world's sheet sends a shuttle to an airspace (SEND SHUTTLE).
// ============================================================

import { ui } from './context.js';
import { $, esc, show, fmtMeters, fmtNum } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { bus } from '../core/events.js';
import { formatDuration } from '../core/clock.js';
import { CLASSES } from '../sim/ship-classes.js';
import { airspacesOf, worldOfs } from '../sim/worlds.js';
import { runRefusal, planRun, launchRun, runReadout, activeRuns, landingClearance, cargoFor, shuttleCrew, shuttlePatients, seatsOf, leaveCost, abortRun, tradeRoom } from '../sim/shuttles.js';
import { errandsFor, groundHall, groundOf } from '../sim/ground.js';
import { maxCrew } from '../sim/ship-classes.js';
import { fullName } from '../sim/careers.js';
import { marketOfWorld, priceAt, quote, tradeRefusal, holdRoom, SPREAD, MARKETS } from '../sim/market.js';
import { GOODS, GOOD_IDS, tonnes } from '../sim/goods.js';
import { watchShuttle } from './stage.js';
import { followOnMap } from './nav.js';

const emit = (t, p) => bus.emit(t, p);
let chosen = { shuttle: null, airspace: null, sell: new Set(), buy: null, buyT: 0, pilot: null, riders: new Set(), leave: false, errands: {}, hires: new Set() };

export function initShuttleBay() {
  const ov = $('#dialog-shuttle');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeShuttleBay(); });
  ov.addEventListener('click', onClick);
  ov.addEventListener('change', onChange);
}

export const shuttleBayOpen = () => $('#dialog-shuttle').style.display !== 'none';

/** Open it (toward an airspace, if given). */
export function openShuttleBay(airspaceId = null) {
  const s = ui.state;
  if (!s) return;
  if (airspaceId) chosen.airspace = airspaceId;
  show($('#dialog-shuttle'), true, 'flex');
  render();
}
export function closeShuttleBay() {
  if (!shuttleBayOpen()) return false;
  show($('#dialog-shuttle'), false);
  return true;
}
export function toggleShuttleBay() { if (shuttleBayOpen()) closeShuttleBay(); else openShuttleBay(); }

const dur = (min) => formatDuration(Math.max(0, min));
/**
 * The run as it would be launched now, worked out again only as the game
 * moves on or the choice changes (a plan takes tens of milliseconds: not
 * every redraw, nor every minute of a warp); the launch plans afresh.
 */
let planMemo = null;
function planNow(s) {
  const key = `${chosen.shuttle}|${chosen.airspace}|${chosen.leave}|${s.flight.hold?.id}|${s.flight.hold?.r ?? ''}`, now = s.clock.minute;
  if (planMemo && planMemo.key === key && now >= planMemo.at && now - planMemo.at < 30 && performance.now() - planMemo.wall < 4000) return planMemo.p;
  const p = planRun(s, chosen.shuttle, chosen.airspace, { leave: chosen.leave });
  planMemo = { key, at: now, wall: performance.now(), p };
  return p;
}

function render() {
  const s = ui.state;
  const body = $('#dialog-shuttle-body');
  const bay = s.shuttles?.bay || [];
  if (!bay.length) {
    body.innerHTML = `<h3 class="dialog-title">Shuttles</h3><p class="dialog-text">This hull carries no craft to land. No hull is rated for an atmosphere: a world's ground is reached by the gig, pinnace or lander in its bays.</p><div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>`;
    return;
  }
  const runs = activeRuns(s);
  const bayRows = bay.map(sh => {
    const run = sh.run && runs.find(r => r.id === sh.run);
    const rd = run ? runReadout(s, run) : null;
    return `<div class="sb-row"><span class="sb-name">${esc(sh.name)}</span><span class="sb-class">${esc(CLASSES[sh.cls].name)} · ${CLASSES[sh.cls].cargoT} t · ${CLASSES[sh.cls].berths} seats</span>
      <span class="sb-state ${run ? 'out' : ''}">${run ? `${esc(rd.words || rd.phase)} · ${esc(run.port.name)} · home in ${dur(rd.eta)}` : 'in its bay'}</span></div>`;
  }).join('');
  const out = runs.map(run => runPanel(s, run)).join('');
  const no = runRefusal(s);
  let plan = '';
  if (no.why) plan = `<p class="dialog-text sb-why">${esc(no.why)}</p>`;
  else {
    const w = no.w;
    const air = airspacesOf(w);
    if (!air.length) plan = `<p class="dialog-text sb-why">Nobody lives on ${esc(w.name)}: no spaceports, no ground control, nowhere to land.</p>`;
    else {
      const free = bay.filter(x => !x.run);
      if (!free.length) plan = runs.length ? '' : '<p class="dialog-text sb-why">Every shuttle is out.</p>';
      else {
        if (!free.some(x => x.id === chosen.shuttle)) chosen.shuttle = free[0].id;
        // (the first time, the pad our freight is bound for)
        if (!air.some(a => a.id === chosen.airspace)) chosen.airspace = (air.find(a => cargoFor(s, a.id, 'lander').items.length) || air[0]).id;
        const p = planNow(s);
        const clr = landingClearance(s, chosen.airspace, p.ok ? p.plan.groundMin : undefined);
        const sh = bay.find(x => x.id === chosen.shuttle);
        const load = cargoFor(s, chosen.airspace, sh.cls);
        const pilot = pickCrew(s, sh, w.name);
        plan = `<div class="sb-plan">
          <div class="sb-pick"><label>SHUTTLE <select data-pick="shuttle">${free.map(x => `<option value="${x.id}" ${x.id === chosen.shuttle ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <label>TO <select data-pick="airspace">${air.map(a => `<option value="${a.id}" ${a.id === chosen.airspace ? 'selected' : ''}>${esc(a.port.name)} · ${esc(a.controller)}</option>`).join('')}</select></label></div>
          ${p.ok ? timeline(p.plan.summary) : `<p class="dialog-text sb-why">${esc(p.why)}</p>`}
          <div class="sb-line"><b>CLEARANCE</b> <span class="${clr.ok ? 'sb-ok' : 'sb-bad'}">${esc(clr.text)}</span></div>
          <div class="sb-line"><b>FREIGHT</b> ${load.items.length ? `${load.items.map(i => `${Math.round(i.mass).toLocaleString()} kg of ${esc(i.name)}`).join(', ')} (of ${Math.round(load.room).toLocaleString()} kg room)` : 'nothing aboard bound for this pad'}</div>
          ${crewHTML(s, sh, airspacesOf(w).find(a => a.id === chosen.airspace), w.name)}
          ${hallHTML(s, sh, w.name)}
          ${tradeHTML(s, w, sh)}
          <div class="form-actions"><button class="btn btn-primary" data-act="launch" ${p.ok && clr.ok && pilot ? '' : 'disabled'}>LAUNCH ${esc(sh.name.toUpperCase())}</button></div>
        </div>`;
      }
    }
  }
  body.innerHTML = `<h3 class="dialog-title">Shuttles</h3>
    <div class="sb-bay">${bayRows}</div>
    ${out}
    ${plan}
    <div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>`;
}

/**
 * Who goes: the pilot (the best able pilot unless another is chosen), who
 * rides down in the seats, and whether they go ashore at the spaceport (a
 * run ashore: the shuttle on the pad eight hours). Kept to who can go.
 */
function pickCrew(s, sh, world = null) {
  // (kept as strings, as the form gives them; patients ride only on a run ashore)
  const able = shuttleCrew(s), ids = new Set(able.map(m => String(m.id)));
  const patients = chosen.leave && world ? shuttlePatients(s, world) : [];
  const riderIds = new Set([...ids, ...patients.map(m => String(m.id))]);
  if (!ids.has(chosen.pilot)) chosen.pilot = able[0] ? String(able[0].id) : null;
  for (const id of [...chosen.riders]) if (!riderIds.has(id) || id === chosen.pilot) chosen.riders.delete(id);
  const seats = seatsOf(sh.cls);
  while (chosen.riders.size > seats) chosen.riders.delete([...chosen.riders].at(-1));
  return able.find(m => String(m.id) === chosen.pilot) || null;
}

function crewHTML(s, sh, a, world) {
  const able = shuttleCrew(s), seats = seatsOf(sh.cls);
  if (!able.length) return '<div class="sb-line"><b>CREW</b> <span class="sb-bad">nobody fit to fly it</span></div>';
  const full = chosen.riders.size >= seats;
  const patients = chosen.leave ? shuttlePatients(s, world) : [];
  const riders = [...able.filter(m => String(m.id) !== chosen.pilot), ...patients].map(m => {
    const on = chosen.riders.has(String(m.id)), patient = patients.includes(m);
    return `<label class="sb-check ${!on && full ? 'off' : ''}"><input type="checkbox" data-rider="${esc(m.id)}" ${on ? 'checked' : ''} ${!on && full ? 'disabled' : ''}> ${esc(m.name)} <span class="sb-dim">${esc(patient ? 'patient, for the hospital' : m.role)}</span></label>`;
  }).join('') || '<span class="sb-none">nobody else free</span>';
  const n = 1 + chosen.riders.size;
  const g = groundOf(world);
  return `<div class="sb-crew">
    <div class="sb-line"><b>PILOT</b> <select data-pick="pilot">${able.map(m => `<option value="${esc(m.id)}" ${String(m.id) === chosen.pilot ? 'selected' : ''}>${esc(m.name)} · ${esc(m.role)} · piloting ${Math.round(m.skills?.piloting || 0)}</option>`).join('')}</select></div>
    <div class="sb-riders"><span class="sb-k">RIDING DOWN</span><div class="sb-ridergrid">${riders}</div><span class="sb-seats">${chosen.riders.size} OF ${seats} SEAT${seats === 1 ? '' : 'S'} TAKEN</span></div>
    <label class="sb-leave"><input type="checkbox" data-leave ${chosen.leave ? 'checked' : ''}><span><b>ASHORE</b> ${n === 1 ? 'the pilot' : n === 2 ? 'both' : `all ${n}`} at ${esc(a?.port.name || 'the spaceport')}: the pad held eight hours, ${leaveCost(n).toLocaleString()} MCR paid there, back rested and in better spirits${g ? `; each can do one thing there (${esc(world)}'s ${g.hospital === 'full' ? 'hospitals' : 'clinic'}, ${esc(g.academy)})` : ''}</span></label>
    ${chosen.leave ? errandsHTML(s, world) : ''}
    <div class="sb-line sb-dim">Whoever goes is away from the ship until the shuttle is home: their stations go unmanned, and our routes wait for them.</div>
  </div>`;
}

/** What each who goes does ashore (sim/ground.js): leave, a course, the hospital, retiring. */
function errandsHTML(s, world) {
  const going = [chosen.pilot, ...chosen.riders].map(id => s.ship.crew.find(m => String(m.id) === id)).filter(Boolean);
  let total = 0;
  const rows = going.map(m => {
    const opts = errandsFor(s, m, world);
    const patient = shuttlePatients(s, world).includes(m);
    let pick = chosen.errands[m.id];
    if (patient) pick = 'hospital';
    if (!opts.some(o => o.id === pick && !o.why)) pick = 'leave';
    chosen.errands[m.id] = pick;
    total += opts.find(o => o.id === pick)?.cost || 0;
    return `<div class="sb-errand"><span>${esc(m.name)} <span class="sb-dim">${esc(m.role)}</span></span><select data-errand="${esc(m.id)}" ${patient ? 'disabled' : ''}>${opts.map(o => `<option value="${esc(o.id)}" ${o.id === pick ? 'selected' : ''} ${o.why ? 'disabled' : ''} title="${esc(o.why || '')}">${esc(o.label)}${o.cost ? ` · ${fmtNum(o.cost)} MCR` : ''}${o.why ? ' (not yet)' : ''}</option>`).join('')}</select></div>`;
  }).join('');
  return `<div class="sb-errands"><span class="sb-k">ASHORE</span><div>${rows}${total ? `<div class="sb-dim">${fmtNum(total)} MCR besides the leave, paid on landing</div>` : ''}</div></div>`;
}

/** The spaceport's hall (sim/ground.js groundHall): hands to sign on at the pad, up in the seats left free. */
function hallHTML(s, sh, world) {
  const hall = groundHall(s, world);
  if (!hall.length) return '';
  const retiring = Object.entries(chosen.errands).filter(([id, e]) => e === 'retire' && (id === chosen.pilot || chosen.riders.has(id))).length;
  const free = seatsOf(sh.cls) - chosen.riders.size + (chosen.leave ? retiring : 0);
  const berths = maxCrew(s.ship.classId) - s.ship.crew.filter(m => !m.dead).length + (chosen.leave ? retiring : 0);
  for (const i of [...chosen.hires]) if (!hall[+i]) chosen.hires.delete(i);
  const room = Math.min(free, berths);
  while (chosen.hires.size > Math.max(0, room)) chosen.hires.delete([...chosen.hires].at(-1));
  const sk = (p) => Object.entries(p.skills).map(([k, v]) => `${k.slice(0, 3)} ${Math.round(v)}`).join(' · ');
  const rows = hall.map((p, i) => {
    const on = chosen.hires.has(String(i)), off = !on && chosen.hires.size >= room;
    return `<label class="sb-check sb-hire ${off ? 'off' : ''}"><input type="checkbox" data-hire="${i}" ${on ? 'checked' : ''} ${off ? 'disabled' : ''}><span class="sb-who">${esc(fullName(p))}</span><span class="sb-dim">${esc(p.title)}${p.title.includes(p.role) ? '' : ` · ${esc(p.role)}`} · ${p.age} · ${esc(sk(p))} · ${fmtNum(p.fee)} MCR, ${fmtNum(p.wage)} a month</span></label>`;
  }).join('');
  return `<div class="sb-riders"><span class="sb-k">SIGN ON</span><div class="sb-ridergrid sb-hall">${rows}</div><span class="sb-seats">THE SPACEPORT'S HALL · ${Math.max(0, room)} ${room === 1 ? 'SEAT' : 'SEATS'} FREE FOR THE WAY UP${berths < free ? ` (${Math.max(0, berths)} BERTH${berths === 1 ? '' : 'S'} ABOARD)` : ''} · FEE PAID ON LANDING</span></div>`;
}

/** The world's market for the run: what of ours to sell down, what to bring up. */
function tradeHTML(s, w, sh) {
  const id = marketOfWorld(w.name);
  if (!id || !s.market) return '';
  const { freeDownT, room } = tradeRoom(s, sh.cls, chosen.airspace);
  const ours = GOOD_IDS.map(g => ({ g, t: s.cargo.filter(x => x.good === g && !x.contract).reduce((a, x) => a + x.mass, 0) / 1000 })).filter(x => x.t > 0.004);
  // (a choice made at another world, of goods this one won't buy, is let go)
  for (const g of [...chosen.sell]) if (!ours.some(x => x.g === g) || tradeRefusal(s, id, g, 'sell')) chosen.sell.delete(g);
  if (!s.cargo.length) chosen.sell.clear();
  let down = 0;
  const sells = ours.map(({ g, t }) => {
    // (refused here: not on its market, or all we hold of it stolen from this world's own power)
    const items = s.cargo.filter(x => x.good === g && !x.contract);
    const no = tradeRefusal(s, id, g, 'sell') || (items.every(x => x.stolen === MARKETS[id].faction) ? `stolen from ${MARKETS[id].faction} hulls: not here` : null);
    const on = chosen.sell.has(g) && !no;
    const take = on ? Math.min(t, Math.max(0, freeDownT - down)) : 0;
    down += take;
    return `<label class="sb-check ${no ? 'off' : ''}" title="${esc(no || '')}"><input type="checkbox" data-sell="${g}" ${on ? 'checked' : ''} ${no ? 'disabled' : ''}> ${tonnes(t)} ${esc(GOODS[g].name.toLowerCase())} · ${no ? 'not traded here' : `${fmtNum(Math.round(priceAt(s, id, g) * (1 - SPREAD)))}/t`}${on && take < t ? ` · ${tonnes(take)} fits` : ''}</label>`;
  }).join('') || '<span class="sb-none">nothing of ours to sell</span>';
  const buyable = GOOD_IDS.filter(g => !tradeRefusal(s, id, g, 'buy'));
  if (chosen.buy && !buyable.includes(chosen.buy)) chosen.buy = null;
  const maxUp = Math.min(room, holdRoom(s) / 1000);
  const t = chosen.buy ? Math.min(chosen.buyT || maxUp, maxUp) : 0;
  const q = chosen.buy && t > 0 ? quote(s, id, chosen.buy, t, 'buy') : null;
  const short = q && q.total > s.resources.credits.current;
  return `<div class="sb-trade"><div class="sb-line"><b>MARKET</b> ${esc(worldOfs(w.name))} ground, its prices live: sold and bought by radio on the pad</div>
    <div class="sb-tradecol"><span class="sb-k">SELL DOWN</span><span class="sb-sells">${sells}</span></div>
    <div class="sb-tradecol"><span class="sb-k">BRING UP</span><select data-pick="buy"><option value="">nothing</option>${buyable.map(g => `<option value="${g}" ${g === chosen.buy ? 'selected' : ''}>${esc(GOODS[g].name)} · ${fmtNum(Math.round(priceAt(s, id, g) * (1 + SPREAD)))}/t</option>`).join('')}</select>
      ${chosen.buy ? `<input type="number" data-pick="buyT" min="0" max="${maxUp.toFixed(2)}" step="0.5" value="${t.toFixed(1)}"> t of ${tonnes(maxUp)} · ${q ? `about ${fmtNum(Math.round(q.total))} MCR${short ? ` <span class="sb-bad">(we have ${fmtNum(Math.round(s.resources.credits.current))}: as much as we can pay for, after what sells)</span>` : ''}` : ''}` : ''}</div></div>`;
}

/** A plan's whole run, stretch by stretch. */
function timeline(S) {
  const step = (k, v, note = '') => `<div class="sb-step"><span class="sb-k">${k}</span><span class="sb-v">${v}</span><span class="sb-note">${note}</span></div>`;
  const by = (phased) => phased ? ', by way of a low orbit (round it until its way on comes round)' : '';
  return `<div class="sb-timeline">
    ${S.windowMin ? step('WINDOW', dur(S.windowMin), 'in the bay until the way down opens: the quickest way, waiting for it') : ''}
    ${step('DROP', dur(S.dropMin), S.air ? `a burn, a coast, a burn to the top of the air${by(S.phasedDown)}, braked to ${(S.entryV / 1000).toFixed(1)} km/s` : `a burn, a coast, a burn${by(S.phasedDown)}, to 10 km over the pad`)}
    ${S.air ? step('ENTRY', dur(S.downMin), `${(S.entryV / 1000).toFixed(1)} km/s in · heat ${(S.peakHeat / 1e6).toFixed(2)} MW/m² at its peak · ${Math.round(S.downrangeKm).toLocaleString()} km of glide · up to ${S.peakG.toFixed(1)} G · down on the drive`) : step('LANDING', dur(S.downMin), `on the drive · up to ${S.peakG.toFixed(1)} G`)}
    ${step('GROUND', dur(S.groundMin + (S.padWaitMin || 0)), `${chosen.leave ? 'a run ashore for whoever goes; the freight off' : 'the freight off, the pad cleared'}${S.padWaitMin ? `; then ${dur(S.padWaitMin)} on the pad for its window up` : ''}`)}
    ${step('CLIMB', dur(S.upMin), S.air ? 'through the air on the drive' : 'off the pad on the drive')}
    ${step('BACK', dur(S.returnMin), `a burn, a coast, a burn${by(S.phasedUp)}, up to us on our orbit`)}
    ${step('TOTAL', dur(S.totalMin), `${S.fuelKg.toFixed(1)} kg of reaction mass`)}
  </div>`;
}

/** A run under way: where it is, how it flies, its log. */
function runPanel(s, run) {
  const rd = runReadout(s, run);
  const live = rd.h != null ? `${fmtMeters(rd.h)} up · ${Math.round(rd.v).toLocaleString()} m/s${rd.q > 1000 ? ` · heat ${(rd.q / 1e6).toFixed(2)} MW/m²` : ''}${rd.g > 0.05 ? ` · ${rd.g.toFixed(1)} G` : ''}` : 'in the bay';
  return `<div class="sb-run"><div class="bd-phase">${esc(run.name.toUpperCase())} · ${esc((rd.words || rd.phase).toUpperCase())} · ${esc(run.port.name)}, ${esc(run.world)}</div>
    <div class="sb-line">${live} · this stretch ${dur(rd.legEnd)} more · home in ${dur(rd.eta)}</div>
    <div class="bd-actions"><button class="btn btn-secondary" data-act="watch" data-run="${esc(run.id)}" title="Its cameras on the exterior display: NOSE, DOWN, TAIL">CAMERA</button>
      <button class="btn btn-secondary" data-act="follow" data-run="${esc(run.id)}" title="Follow it on the system display, framed on ${esc(run.world)}'s space, its track drawn">MAP</button>
      ${['window', 'launch', 'drop', 'phasing', 'deorbit', 'down', 'ground'].includes(rd.phase) && !run.aborted ? `<button class="btn btn-secondary" data-act="abort" data-run="${esc(run.id)}" title="Bring it back: from where it is on its way down while it still can, or else landing and lifting again at once">CALL BACK</button>` : ''}</div>
    <div class="bd-log">${run.log.slice().reverse().map(l => `<div>${esc(l.text)}</div>`).join('')}</div></div>`;
}

function onChange(ev) {
  const box = ev.target.closest('[data-sell]');
  if (box) { if (box.checked) chosen.sell.add(box.dataset.sell); else chosen.sell.delete(box.dataset.sell); render(); return; }
  const rider = ev.target.closest('[data-rider]');
  if (rider) { if (rider.checked) chosen.riders.add(rider.dataset.rider); else chosen.riders.delete(rider.dataset.rider); render(); return; }
  if (ev.target.closest('[data-leave]')) { chosen.leave = ev.target.checked; render(); return; }
  const er = ev.target.closest('[data-errand]');
  if (er) { chosen.errands[er.dataset.errand] = er.value; render(); return; }
  const hi = ev.target.closest('[data-hire]');
  if (hi) { if (hi.checked) chosen.hires.add(hi.dataset.hire); else chosen.hires.delete(hi.dataset.hire); render(); return; }
  const sel = ev.target.closest('[data-pick]');
  if (!sel) return;
  const k = sel.dataset.pick;
  chosen[k] = k === 'buyT' ? Math.max(0, +sel.value || 0) : k === 'buy' ? sel.value || null : sel.value;
  if (k === 'buy') chosen.buyT = 0;
  render();
}

function onClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn || !ui.state) return;
  const s = ui.state;
  switch (btn.dataset.act) {
    case 'close': closeShuttleBay(); return;
    case 'abort': { const r = abortRun(s, btn.dataset.run, emit); toast(r.text, r.ok ? 'nav' : 'warn'); if (r.ok) logEntry(r.text, 'nav'); break; }
    case 'watch': watchShuttle(btn.dataset.run); closeShuttleBay(); return;
    case 'follow': { const run = activeRuns(s).find(r => r.id === btn.dataset.run); if (run) { followOnMap({ kind: 'entity', id: run.entity }, run.world); closeShuttleBay(); } return; }
    case 'launch': {
      const p = planRun(s, chosen.shuttle, chosen.airspace, { leave: chosen.leave });
      if (!p.ok) { toast(p.why, 'warn'); break; }
      const r = launchRun(s, p.plan, emit, { crew: { pilot: chosen.pilot, riders: [...chosen.riders] }, trade: { sell: [...chosen.sell], buy: chosen.buy ? { good: chosen.buy, t: chosen.buyT || Infinity } : null },
        errands: chosen.leave ? chosen.errands : null, hires: [...chosen.hires].map(Number) });
      if (r.ok) { chosen.sell.clear(); chosen.buy = null; chosen.buyT = 0; chosen.riders.clear(); chosen.leave = false; chosen.errands = {}; chosen.hires.clear(); }
      toast(r.text, r.ok ? 'nav' : 'warn');
      if (r.ok) logEntry(r.text, 'nav');
      break;
    }
  }
  render();
}

/** While open, follow the runs (a few times a second: the entry moves fast). */
export function updateShuttleBay() {
  if (!shuttleBayOpen() || !ui.state) return;
  const now = performance.now();
  if (now - (updateShuttleBay.at || 0) < 400) return;
  updateShuttleBay.at = now;
  // (not while a select is open or a figure being typed: the redraw would lose it)
  if (['SELECT', 'INPUT'].includes(document.activeElement?.tagName)) return;
  render();
}
