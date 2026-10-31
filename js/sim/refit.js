// ============================================================
// LONGHAUL — Refit: what a yard is for
//
// A crew keeps a hurt ship going; only a yard makes it whole. Aboard, a
// machine that took a heavy hit is rigged to run at half power, and the
// hull is patched with cut plate (systems.js). What that leaves wants a
// slip, a gang and time: new frames, new plating, a drive taken down to
// its bearings. A refit is that work, days to weeks of it, the ship in
// its berth and going nowhere until it is done or called off.
//
// Who can do what:
//   a YARD (services: 'yard': Ceres, Tycho, Luna, Phobos, Ganymede) does
//     all of it: the hull to 100% sound, every machine back to spec, the
//     heavy damage gone, the scars with it.
//   a port's REPAIR dock, or a command ship's field repair gang, does
//     what a crew could do given hands and stores: wear and ordinary
//     faults put right, heavy damage rigged, the hull patched as far as
//     a patch goes, in hours to a day or two. It sends us on to a yard.
//
// A plan (refitPlan) is priced and timed before we sign. The time is the
// hull's (a quarter of a day for each percent of it lost, at a medium
// hull, by size and by how the ship was built) plus the machinery's, which
// two gangs work through side by side. The bill is paid up front; called
// off, what wasn't done is refunded and what was done stands. While it
// lasts the berth goes with the job (leases.js) and the ship won't undock.
//
// Work comes off one machine at a time and the hull a little every
// minute, so a look at the ship in the yard sees it coming back.
// ============================================================

import { getWorld } from './world.js';
import { CLASSES, PLAYER_CLASS, TECH, hullPoints } from './ship-classes.js';
import { STATIONS } from './stations.js';
import { Status, SYSTEMS, shipSystems, unit, hullSound, hullPatchLimit } from './systems.js';
import { restockSuits } from './life-support.js';
import { dockedPort } from './contracts.js';
import { supplyPriceFactor, flagOf } from './service.js';

export const HULL_DAYS_PER_PCT = 0.25;      // a slip's days for each percent of hull lost, a medium hull at TL2
export const SIZE_WORK = { S: 0.6, M: 1, L: 1.6, XL: 2.5 };
const GANGS = 2;                            // machinery gangs working side by side
const HEAVY_DAYS = 2;                       // a machine that took a heavy hit, taken down and rebuilt
const HEAVY_DAYS_PER_LOSS = 0.04;           // …and the more for how hard it was hit
const FAULT_MIN = { major: 720, minor: 240 };
const WEAR_MIN_PER_POINT = 6;
const WEAR_FROM = 90;                       // a machine this sound isn't worth a gang's time
const DOCK_RIG_MIN = 480;                   // a port's fitters rigging a heavy hit
const DOCK_PATCH_MIN_PER_PCT = 40;          // and patching a percent of hull
const REFIT_MIN = 6 * 60;                   // nothing is signed for under a shift

const HULL_PER_PCT = 30;                    // MCR a percent of a 120-DP hull, at TL2
const HEAVY_MCR = 900;                      // a heavy hit, rebuilt
const SLIP_MCR_DAY = 120;                   // the slip, by the day, by size

const techOf = (state) => TECH[state.ship.tl || CLASSES[state.ship.classId || PLAYER_CLASS].tl];
const classOf = (state) => CLASSES[state.ship.classId || PLAYER_CLASS];

/** What a port offers: 'yard', 'dock' (a port's repair dock, a command ship's gang), or null. */
export function refitKind(port) {
  if (!port) return null;
  if (port.tags?.command) return 'dock';
  const sv = STATIONS[port.id]?.services;
  return sv?.includes('yard') ? 'yard' : sv?.includes('repair') ? 'dock' : null;
}

/** The nearest yard that would have us, by what is known of the ports: { st, km } or null. */
export function nearestYard(state) {
  const world = getWorld(state), f = state.flight.pos;
  let best = null;
  for (const st of world.stations) {
    if (!STATIONS[st.id]?.services.includes('yard')) continue;
    if (STATIONS[st.id].military && st.faction !== flagOf(state) && (state.law.standing[st.faction] ?? 0) < 20) continue;
    const d = Math.hypot(st.pos.x - f.x, st.pos.y - f.y);
    if (!best || d < best.d) best = { st, d };
  }
  return best;
}

/**
 * What a refit here would take: { kind, minutes, cost, hull: { from, to,
 * minutes } | null, items: [{ id, what, minutes, heavy }], leaves } or null
 * if there is nothing to do. `leaves`: what this port can't do, for a yard.
 */
export function refitPlan(state, port = dockedPort(state)) {
  const kind = refitKind(port);
  if (!kind) return null;
  const yard = kind === 'yard', T = techOf(state), c = classOf(state), size = SIZE_WORK[c.size] ?? 1;
  const items = [];
  let cost = 250, leaves = 0;
  for (const id of shipSystems(state)) {
    const u = unit(state, id);
    if (u.heavy) {
      const minutes = yard ? (HEAVY_DAYS + (u.heavy.loss || 0) * HEAVY_DAYS_PER_LOSS) * 1440 : u.status === Status.RIGGED ? 0 : DOCK_RIG_MIN;
      if (!yard) leaves++;
      if (minutes) { items.push({ id, what: yard ? 'rebuilt' : 'rigged', minutes: minutes * size * T.repairTime, heavy: true }); cost += yard ? HEAVY_MCR : 300; }
    } else if (u.status !== Status.NOMINAL) {
      items.push({ id, what: 'repaired', minutes: FAULT_MIN[u.fault?.severity || 'major'] * T.repairTime });
      cost += u.fault?.severity === 'major' ? 450 : 150;
    } else if (u.integrity < WEAR_FROM) {
      items.push({ id, what: 'serviced', minutes: (100 - u.integrity) * WEAR_MIN_PER_POINT * T.repairTime });
      cost += (100 - u.integrity) * 8;
    }
  }
  const sound = hullSound(state), now = state.hull.integrity;
  const to = yard ? 100 : Math.max(now, hullPatchLimit(state));
  const hullMin = to > now + 0.1 || (yard && sound < 99.9)
    ? (yard ? (100 - sound) * HULL_DAYS_PER_PCT * 1440 : (to - now) * DOCK_PATCH_MIN_PER_PCT) * size * T.repairTime : 0;
  if (!yard && sound < 99.9) leaves++;
  if (state.reactor.breach && state.reactor.status === 'offline') { items.push({ id: 'reactor', what: 'containment restored', minutes: 1440 * T.repairTime }); cost += 800; }
  if (!items.length && !hullMin) return null;
  cost += (yard ? 100 - sound : to - now) * HULL_PER_PCT * hullPoints(c) / 120;
  const minutes = Math.max(REFIT_MIN, hullMin + items.reduce((s, x) => s + x.minutes, 0) / GANGS);
  if (yard) cost += minutes / 1440 * SLIP_MCR_DAY * size;
  return {
    kind, minutes: Math.round(minutes), items, leaves,
    hull: hullMin ? { from: now, to, minutes: Math.round(hullMin), patched0: state.hull.patched || 0 } : null,
    cost: Math.round(cost * T.price * supplyPriceFactor(state) / 10) * 10,
  };
}

/** Sign for a refit: the bill paid, the ship in the yard's hands. */
export function startRefit(state) {
  const port = dockedPort(state);
  if (!port) return { ok: false, text: 'Not docked.' };
  if (state.refit) return { ok: false, text: 'The yard already has us.' };
  const plan = refitPlan(state, port);
  if (!plan) return { ok: false, text: refitKind(port) ? 'Nothing here for them to do.' : 'No repair dock here.' };
  if (state.resources.credits.current < plan.cost) return { ok: false, text: `Not enough credits: ${plan.cost.toLocaleString()} MCR.` };
  state.resources.credits.current -= plan.cost;
  const now = state.clock.minute;
  // (the machinery comes off in turn, two gangs side by side)
  const gangs = new Array(GANGS).fill(now);
  const items = [...plan.items].sort((a, b) => b.minutes - a.minutes).map(x => {
    const g = gangs.indexOf(Math.min(...gangs));
    gangs[g] += x.minutes;
    return { ...x, at: Math.round(gangs[g]), done: false };
  });
  state.refit = { port: port.id, name: port.name, kind: plan.kind, since: now, until: now + plan.minutes, cost: plan.cost, hull: plan.hull, items };
  return { ok: true, text: `${plan.kind === 'yard' ? 'In the yard' : 'On the repair dock'} at ${port.name}: ${describeTime(plan.minutes)}, ${plan.cost.toLocaleString()} MCR paid.` };
}

/** One piece of the work done. */
function finishItem(state, x) {
  const u = unit(state, x.id), full = state.refit.kind === 'yard';
  if (x.id === 'reactor') { state.reactor.breach = false; return; }
  if (!u) return;
  u.fault = x.heavy && !full ? u.fault : null;
  u.patchUntil = null;
  u.enabled = true;
  if (x.heavy && !full) { u.status = Status.RIGGED; return; }
  u.heavy = null;
  u.status = Status.NOMINAL;
  u.integrity = 100;
}

/** Per minute: the work goes on. */
export function refitTick(state, emit = () => {}) {
  const R = state.refit;
  if (!R) return;
  const now = state.clock.minute;
  if (dockedPort(state)?.id !== R.port) { endEarly(state, emit, 'The ship left the yard'); return; }
  if (R.hull) {
    const k = Math.min(1, (now - R.since) / R.hull.minutes);
    state.hull.integrity = Math.max(state.hull.integrity, R.hull.from + (R.hull.to - R.hull.from) * k);
    // (a yard takes the patches off as it builds: what it puts back is sound; a dock's work is more patch)
    state.hull.patched = R.kind === 'yard' ? R.hull.patched0 * (1 - k) : R.hull.patched0 + (R.hull.to - R.hull.from) * k;
  }
  for (const x of R.items) {
    if (x.done || now < x.at) continue;
    x.done = true;
    finishItem(state, x);
    emit('refit-progress', { text: `${x.id === 'reactor' ? 'Reactor' : SYSTEMS[x.id].name} ${x.what}.` });
  }
  if (now < R.until) return;
  if (R.kind === 'yard') {
    state.hull.scars = []; state.hull.patched = 0; state.hull.integrity = 100;
    // (handed back to spec: what came off the list early has stood in the yard since)
    for (const x of R.items) { const u = unit(state, x.id); if (u) u.integrity = 100; }
  }
  for (const d of state.ship.decks) if (d.atmosphere) d.atmosphere.breached = false;
  restockSuits(state);
  state.refit = null;
  emit('refit-done', { kind: R.kind, text: R.kind === 'yard' ? `The yard at ${R.name} hands her back: hull and every system to spec.` : `The dock at ${R.name} is done: the rest is a yard's work.` });
}

/** Stopped short: what wasn't done is refunded, what was done stands. */
function endEarly(state, emit, why) {
  const R = state.refit, now = state.clock.minute;
  const left = Math.max(0, Math.min(1, (R.until - now) / Math.max(1, R.until - R.since)));
  const back = Math.round(R.cost * left / 10) * 10;
  state.resources.credits.current += back;
  state.refit = null;
  emit('refit-stopped', { why, back, text: `${why}: ${back.toLocaleString()} MCR refunded.` });
  return back;
}

/** Call the work off: we can go, as she stands. */
export function callOffRefit(state, emit = () => {}) {
  if (!state.refit) return { ok: false, text: 'No work in hand.' };
  const back = endEarly(state, emit, 'Work called off');
  return { ok: true, text: `Work called off, ${back.toLocaleString()} MCR back. She goes as she stands.` };
}

/** The refit in hand: { kind, name, left (min), share done, next } or null. */
export function refitStatus(state) {
  const R = state.refit;
  if (!R) return null;
  const now = state.clock.minute, left = Math.max(0, R.until - now);
  return { kind: R.kind, name: R.name, left, share: 1 - left / Math.max(1, R.until - R.since), cost: R.cost, done: R.items.filter(x => x.done).length, of: R.items.length };
}

/** A span of work in words. */
export const describeTime = (min) => min >= 2 * 1440 ? `${Math.round(min / 1440)} days` : min >= 1440 ? `${Math.round(min / 144) / 10} days` : `${Math.round(min / 60)} hours`;
