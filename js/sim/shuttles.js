// ============================================================
// LONGHAUL — Shuttles: a big hull's way down to a world
//
// No hull is rated for an atmosphere; every one carries shuttles in its
// bays (ship-classes.js BAYS: a gig under a small hull's keel, a pinnace for
// people and a few tonnes, a cargo lander for sixty). Ours (state.shuttles.bay) go down from a world's high
// orbit, the parking orbit or the stationary one we hold (nav.js 'orbit'
// targets), to a spaceport in one of its airspaces (worlds.js), and come
// back. A RUN is planned whole when it is launched (planRun), each stretch
// flown as physics once (planetary.js) and ridden on rails after:
//
//   window    (if waiting is the quick way) in the bay for its window
//   launch    out of the bay (LAUNCH_MIN)
//   drop      down to the top of the air (a transfer: a burn, a coast, a
//             burn), aimed at where the entry must begin for the pad to be
//             under the glide's end (the world turns meanwhile: the plan is
//             solved for it); or down to a low orbit, round it (phasing)
//             until the entry comes round, then down (deorbit)
//   down      the entry, the glide, the powered landing (or, airless, the
//             powered landing from HOVER_M over the pad)
//   ground    at the spaceport: the cargo bound there is handed over (a
//             PLANETSIDE contract is paid for what is landed: contracts.js),
//             goods it carried down are sold on the world's market and a
//             purchase loaded to bring up (market.js shuttleTrade: paid by
//             radio), and it waits out the turnaround
//   up        the ascent, off the pad to the top of the air (the pad held
//             longer first if waiting for a window up is the quick way)
//   return    back up to us (a transfer), to where we will be on our orbit;
//             or to a low orbit (orbit), round it (phasing), then up
//   recover   into the bay (RECOVER_MIN): the crew back aboard
//
// A landing needs its airspace controller's clearance (landingClearance):
// refused to a ship its power wants, or one flying the flag of a power at
// war with it, or one it won't deal with. Who goes is chosen (launchRun
// crew: the pilot, riders up to its seats, none unfit): they are away from
// the ship meanwhile, as a boarding party is (crew m.away: the routes wait
// for them, autopilot.js). A run planned for leave (planRun opts.leave)
// holds the pad LEAVE_MIN instead of the turnaround; the party goes ashore,
// paid for on landing (LEAVE_COST a head), and comes home rested
// (crew-services.js restedAshore), unless called in off the pad. Ashore,
// each who goes does one thing there (ground.js ERRANDS: leave, a course
// at an academy, the hospital, retiring; launchRun errands), paid on
// landing and done when they are home (a course or a treatment called in
// off the pad is refunded); the hurt may ride down for the hospital, as
// patients. The spaceport's hall (ground.js groundHall) signs hands on
// at the pad (launchRun hires: the fee paid on landing), who ride up in
// the seats left free and come aboard with the shuttle. The shuttle is a
// world entity on its flight path (world.js FLIGHT_PATH), seen on the
// displays like any other hull. What it burns comes out of our tanks when
// it is home.
//
// The same planner serves an NPC carrier (planLegs with its id, and
// runMinutes for the traffic's outcome when nobody is there to see:
// traffic.js planetary calls), so the AI flies the same runs to a world as
// we do. While we are in a world's planetary space, the carriers calling
// there send their shuttles down for real (npcShuttlesTick: at most
// NPC_SHUTTLES_MAX, each on its flight path, gone when its run is done; a
// carrier waits for its shuttle before it leaves).
// ============================================================

import { AU_M, G0, DAY_MIN, MIN_S } from '../core/constants.js';
import { random, pick } from '../core/rng.js';
import { getWorld } from './world.js';
import { createEntity } from './entities.js';
import { CLASSES, bayOf, maxCrew } from './ship-classes.js';
import { bodyPos, bodyVel } from './ephemeris.js';
import { worldOf, worldAt, airspaceById, airspacesOf, worldAngle, controlWords, worldOfs } from './worlds.js';
import { entryProfile, ascentProfile, craftOf, flightPathAt, carrierPlace, placeOnLeg, airState, kepler, xferSweep, xferPlan, xferAt, xferDv, xferBurns, ENTRY_LEAD, TURN_LEAD, PLAYER_AT, HOVER_M, LAUNCH_MIN, RECOVER_MIN, GROUND_MIN } from './planetary.js';
export { LAUNCH_MIN, RECOVER_MIN, GROUND_MIN };
import { targetStateAt } from './nav.js';
import { FACTIONS } from './factions.js';
import { hostileTo } from './service.js';
import { FUEL_PER_G_MIN } from './flight.js';
import { isAble } from './crew.js';
import { shipGeometry, airlockFor } from './ship-layout.js';
import { deliverPlanetside } from './contracts.js';
import { marketOfWorld, shuttleTrade, stow, holdRoom, tradeRefusal, MARKETS } from './market.js';
import { GOODS } from './goods.js';
import { LEAVE_MIN, LEAVE_COST, restedAshore, signOn } from './crew-services.js';
import { errandsFor, errandCost, finishErrand, retireOnWorld, groundHall, treatmentFor } from './ground.js';

const RENDEZVOUS_M = 20_000;                 // a shuttle home further than this from us (we moved) chases us
const HOLD_MIN = 10;                         // …or, with us out of its world's space, orbits where it is and looks again this often
const ABORT_GROUND_MIN = 10;                 // called back with it committed to its entry, or down: off the pad this soon
const NPC_SHUTTLES_MAX = 10;                 // NPC shuttles flown where we can see them, at most
const NPC_LAUNCH_P = 0.25;                   // a carrier in a planetary call sends one down, each look (every NPC_LOOK_MIN)
const NPC_LOOK_MIN = 5;
const PHASE_WORDS = { window: 'in its bay, waiting for its window', launch: 'launching', drop: 'on its way down', phasing: 'round a low orbit, waiting for its way on to come round', deorbit: 'on its way down to the air', down: 'entry and landing', ground: 'on the ground', up: 'climbing out', orbit: 'climbing to a low orbit', return: 'coming back up', hold: 'waiting for us in orbit', recover: 'into the bay', done: 'stowed' };

/** Our shuttle bays, full (a class's BAYS): [{ id, cls, name }]. */
export function createShuttles(classId) {
  const count = {};
  return {
    bay: bayOf(classId).map((s, i) => {
      count[s.cls] = (count[s.cls] || 0) + 1;
      return { id: `sh-${i + 1}`, cls: s.cls, name: `${CLASSES[s.cls].name} ${count[s.cls]}`, run: null };
    }),
    runs: [], nextId: 1,
  };
}

export const runOf = (state, id) => state.shuttles?.runs.find(r => r.id === id) || null;
export const activeRuns = (state) => (state.shuttles?.runs || []).filter(r => r.phase !== 'done' && r.phase !== 'lost');
export const shuttleOut = (state) => activeRuns(state).length > 0;

/** Where our ship will be at `minute` (AU): on the orbit it holds, else where it is. */
function carrierAt(state, minute) {
  const f = state.flight, now = state.clock.minute;
  if (f.hold) { const t = targetStateAt(state, f.hold, minute); if (t) return { pos: t.pos, vel: t.vel }; }
  const here = minute > now && worldAt(f.pos.x, f.pos.y, now);
  if (!here) return { pos: { x: f.pos.x, y: f.pos.y }, vel: { vx: f.vel.vx, vy: f.vel.vy } };
  // coasting: our fall round the world we are at, ahead to `minute` (a burn makes it wrong; rejoin looks again)
  const w = here.w, GM = w.GM;
  const c0 = bodyPos(w.body, now / DAY_MIN), u0 = bodyVel(w.body, now / DAY_MIN);
  let x = (f.pos.x - c0.x) * AU_M, y = (f.pos.y - c0.y) * AU_M, vx = f.vel.vx - u0.vx, vy = f.vel.vy - u0.vy;
  const span = (minute - now) * MIN_S, n = Math.max(1, Math.ceil(span / 30)), dt = span / n;
  const acc = () => { const r2 = x * x + y * y, k = -GM / (r2 * Math.sqrt(r2)); return [k * x, k * y]; };
  let [ax, ay] = acc();
  for (let i = 0; i < n; i++) {
    vx += ax * dt / 2; vy += ay * dt / 2;
    x += vx * dt; y += vy * dt;
    [ax, ay] = acc();
    vx += ax * dt / 2; vy += ay * dt / 2;
  }
  const c1 = bodyPos(w.body, minute / DAY_MIN), u1 = bodyVel(w.body, minute / DAY_MIN);
  return { pos: { x: c1.x + x / AU_M, y: c1.y + y / AU_M }, vel: { vx: u1.vx + vx, vy: u1.vy + vy } };
}

PLAYER_AT.at = carrierAt;

/** Why a shuttle run can't be planned from where we are (null: it can), and the world we hold an orbit round. */
export function runRefusal(state) {
  const f = state.flight;
  const here = worldAt(f.pos.x, f.pos.y, state.clock.minute);
  if (!state.shuttles?.bay.length) return { why: 'We carry no shuttles: this hull has no bay.' };
  if (!here) return { why: 'Take us into a world\'s planetary space and a high orbit first.' };
  if (f.hold?.kind !== 'orbit' || f.hold.id !== here.w.name) return { why: `Hold a high orbit round ${here.w.name} first (ORBIT on it: its parking orbit, or a stationary one).`, w: here.w };
  if (state.dock) return { why: 'Not while docked.', w: here.w };
  return { why: null, w: here.w };
}

/**
 * A landing at an airspace's spaceport: its controller's answer. { ok, text }.
 * Refused to a ship its power wants, one flying an enemy's flag, or one it
 * won't deal with (standing under −20).
 */
export function landingClearance(state, airspaceId, groundMin = GROUND_MIN) {
  const a = airspaceById(airspaceId);
  if (!a) return { ok: false, text: 'No such airspace.' };
  const p = a.authority;
  const who = a.controller;
  if (p && (state.law.wanted?.[p] ?? 0) >= 2) return { ok: false, text: `${who}: your registry is flagged by ${FACTIONS[p]?.short || p}. Landing denied; hold your orbit.` };
  if (p && hostileTo(state, p)) return { ok: false, text: `${who}: no landings for your flag. Clear our airspace.` };
  if (p && p in (state.law.standing || {}) && state.law.standing[p] < -20) return { ok: false, text: `${who}: you are not welcome here. Landing denied.` };
  return { ok: true, text: `${who}: cleared to land at ${a.port.name}. Report at the interface; the pad is yours for ${Math.round(groundMin / 60 * 10) / 10} hours.` };
}

// ---- PLANNING A RUN ----
//
// Every stretch on the drive is a transfer (planetary.js: a burn, a coast
// on a conic, a burn), and the pilot takes the quickest of those it could
// fly that costs at most BRISK times the cheapest way to go now (or
// BRISK_SPARE more, round a small world where the cheapest is little):
// straight there, after waiting in the bay (or on the pad) up to WINDOW_MAX
// for its window where that is quicker,
// or by way of a low orbit (PHASING: well above the air, well below the
// carrier), round it until where it is going comes round, then on (a low
// orbit goes round fast: the wait is an hour or two, not the days the high
// orbit and the turning ground would take to line up). Coming down it
// arrives at the top of the air at the entry's speed and angle, upstream
// of the pad by the glide's own way over the ground (or HOVER_M over the
// pad, airless); going up, alongside its carrier, wherever it will be.

const BRISK = 2;                             // the quickest way that costs at most this many times the cheapest (Δv),
const BRISK_SPARE = 2500;                    // …or this much more (m/s: four minutes of a G), where the cheapest is little
const WINDOW_MAX = 6 * 60;                   // min: the longest a shuttle waits in its bay, or on its pad, for a window
const XFER_MAX_S = 16 * 3600;                // the longest transfer considered (s)
const PHASING = [1.12, 1.35, 1.8, 2.6];      // the low orbits it may go round, in the world's radii
const GRID = {                               // how finely the planner looks: our runs, and an NPC's (a cheaper look)
  fine: { waitStep: 20, n: 36, sigmaStep: 20 },
  coarse: { waitStep: 60, n: 24, sigmaStep: 45 },
};
const TWO_PI = 2 * Math.PI;
const wrap = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const angleOf = (s) => Math.atan2(s.y, s.x);
const radiusOf = (s) => Math.hypot(s.x, s.y);
/** A state turned by `a` round the world's centre. */
const turned = (s, a) => { const c = Math.cos(a), n = Math.sin(a); return { x: s.x * c - s.y * n, y: s.x * n + s.y * c, vx: s.vx * c - s.vy * n, vy: s.vx * n + s.vy * c }; };
/** A circular orbit's state at radius r, angle th. */
const circle = (GM, r, th) => { const v = Math.sqrt(GM / r); return { x: r * Math.cos(th), y: r * Math.sin(th), vx: -v * Math.sin(th), vy: v * Math.cos(th) }; };
/** A place (AU, m/s) at minute m as a state round world w (m, m/s from its centre). */
function stateRound(w, p, m) {
  const c = bodyPos(w.body, m / DAY_MIN), u = bodyVel(w.body, m / DAY_MIN);
  return { x: (p.pos.x - c.x) * AU_M, y: (p.pos.y - c.y) * AU_M, vx: p.vel.vx - u.vx, vy: p.vel.vy - u.vy };
}
/** How fast a state goes round (rad/s). */
const rateOf = (s) => (s.x * s.vy - s.y * s.vx) / (s.x * s.x + s.y * s.y);

const _last = new Map();
/** The most a brisk way may cost, the cheapest costing `dv`. */
const brisk = (dv) => Math.max(BRISK * dv, dv + BRISK_SPARE);

/**
 * The quickest way, within BRISK of the cheapest, from a place to where it
 * must arrive. dep(W) → { t (minute), s (state) }: where it leaves from,
 * having waited W min (`waits`: the waits it may take); arr(t) → the state
 * it must arrive in at minute t, a thing going round at `om` rad/s (the
 * turning ground's entry point, or its carrier). `lead`: seconds it coasts
 * first, turning (a transfer from a craft flying another way). Returns {
 * legs: the drive's legs (an 'xfer', or 'xfer', 'hold', 'xfer'; `names`
 * their phases), W, tArr, dv }, or null.
 */
function reach(w, cls, dep, waits, arr, om, { tail = 0, lead = 0, names, grid = GRID.fine }) {
  const GM = w.GM, acc = craftOf(cls).aCruise, air = w.atmo ? w.atmo.interfaceM : HOVER_M, rFloor = w.R + 0.9 * air;
  // (the transfers are laid out from where the coast first leaves it: `from`; their times count the coast)
  const from = (D) => lead ? kepler(GM, D.s, lead) : D.s;
  const cands = [];
  for (const W of waits) {
    const D = dep(W), S = from(D), A0 = arr(D.t), rCeil = 1.3 * Math.max(radiusOf(D.s), radiusOf(A0));
    for (const c of xferSweep(GM, S, (tof) => arr(D.t + (lead + tof) / 60), acc, { tMax: XFER_MAX_S, n: grid.n, rFloor, rCeil }))
      cands.push({ W, D, tof: lead + c.tof, dv: c.dv, total: W + (lead + c.tof) / 60 });
  }
  // by way of a low orbit: down (or up) to it, round it, then on
  const D = dep(0), S0 = from(D), rD = radiusOf(D.s), thD = angleOf(S0), A0 = arr(D.t), rA = radiusOf(A0);
  for (const k of PHASING) {
    const rP = k * w.R, nP = Math.sqrt(GM / rP ** 3);
    if (rP < w.R + 3 * air || rP > 0.7 * Math.max(rD, rA) || nP <= om * 1.2) continue;
    const last = lastLeg(w, cls, rP, turned(A0, -angleOf(A0)), om, grid, tail);
    if (!last) continue;
    for (let sg = grid.sigmaStep; sg < 360; sg += grid.sigmaStep) {
      const thP = thD + sg * Math.PI / 180, P = circle(GM, rP, thP);
      for (const c of xferSweep(GM, S0, () => P, acc, { tMax: XFER_MAX_S, n: grid.n, rFloor, rCeil: 1.3 * Math.max(rD, rP) })) {
        const tP = D.t + (lead + c.tof) / 60;
        // round the low orbit until what it goes to is `last.psi` ahead of it (it gains on it at nP − om)
        const H = wrap(angleOf(arr(tP)) - thP - last.psi) / (nP - om);
        cands.push({ W: 0, D, phased: { rP, nP, thP, tof1: lead + c.tof, H, last }, dv: c.dv + last.dv, total: (lead + c.tof + H + last.tof) / 60 });
      }
    }
  }
  if (!cands.length) return null;
  // (measured against the cheapest way to go now: a long wait for a cheap window is no reason to refuse a brisk way)
  const now = cands.filter(c => !c.W);
  const cap = brisk(Math.min(...(now.length ? now : cands).map(c => c.dv)));
  const order = [...cands.filter(c => c.dv <= cap).sort((a, b) => a.total - b.total), ...cands.filter(c => c.dv > cap).sort((a, b) => a.dv - b.dv)];
  for (const c of order.slice(0, 40)) {
    const t0 = c.D.t;
    if (!c.phased) {
      const x = xferPlan(GM, c.D.s, arr(t0 + c.tof / 60), c.tof, acc, tail, rFloor, lead);
      if (x) return { W: c.W, tArr: t0 + c.tof / 60, dv: xferDv(x), legs: [{ phase: names[0], kind: 'xfer', t0, t1: t0 + c.tof / 60, x }] };
      continue;
    }
    const p = c.phased, tP = t0 + p.tof1 / 60, tD = tP + p.H / 60, tArr = tD + p.last.tof / 60;
    const x1 = xferPlan(GM, c.D.s, circle(GM, p.rP, p.thP), p.tof1, acc, 0, rFloor, lead);
    const x2 = x1 && xferPlan(GM, circle(GM, p.rP, p.thP + p.nP * p.H), arr(tArr), p.last.tof, acc, tail, rFloor);
    if (x2) return { W: 0, tArr, dv: xferDv(x1) + xferDv(x2), legs: [
      { phase: names[1], kind: 'xfer', t0, t1: tP, x: x1 },
      { phase: 'phasing', kind: 'hold', t0: tP, t1: tD, r: p.rP, th0: p.thP },
      { phase: names[2], kind: 'xfer', t0: tD, t1: tArr, x: x2 },
    ] };
  }
  return null;
}

/**
 * The last leg from a low orbit (radius rP) to a thing going round at om
 * whose state, seen with it at angle 0, is `shape`: { psi (how far ahead of
 * the craft it must be as it leaves), tof, dv }, the quickest brisk one
 * that flies with burns of their length (cached: it depends on the world,
 * the orbit and the thing, not on when).
 */
function lastLeg(w, cls, rP, shape, om, grid, tail) {
  const key = `${w.name}|${cls}|${rP}|${Math.round(radiusOf(shape) / 1e3)}|${Math.round(shape.vx)}|${Math.round(shape.vy)}|${om.toExponential(3)}|${grid.n}|${tail}`;
  if (_last.has(key)) return _last.get(key);
  const GM = w.GM, acc = craftOf(cls).aCruise, air = w.atmo ? w.atmo.interfaceM : HOVER_M;
  const C = circle(GM, rP, 0), out = [];
  for (let deg = 0; deg < 360; deg += 5) {
    const psi = deg * Math.PI / 180;
    for (const c of xferSweep(GM, C, (tof) => turned(shape, psi + om * tof), acc, { tMax: XFER_MAX_S, n: grid.n, rFloor: w.R + 0.9 * air, rCeil: 1.3 * Math.max(rP, radiusOf(shape)) }))
      out.push({ psi, tof: c.tof, dv: c.dv });
  }
  let best = null;
  if (out.length) {
    const cap = brisk(Math.min(...out.map(c => c.dv)));
    for (const c of out.filter(c => c.dv <= cap).sort((a, b) => a.tof - b.tof).slice(0, 40)) {
      const x = xferPlan(GM, C, turned(shape, c.psi + om * c.tof), c.tof, acc, tail, w.R + 0.9 * air);
      if (x) { best = { ...c, dv: xferDv(x) }; break; }
    }
  }
  if (_last.size > 200) _last.clear();
  _last.set(key, best);
  return best;
}

/**
 * Plan a run: the shuttle `shuttle` ({ cls }) from carrier `carrier`
 * ('player' or an entity's id, whose place at a minute `carrierAt` gives),
 * down to airspace `airspaceId`'s spaceport and back, starting `t0`.
 * Returns { ok, why, legs, summary } (legs: plain data for its flight path).
 */
export function planLegs(worldName, cls, airspaceId, t0, carrierPlace, { groundMin = GROUND_MIN, npc = false } = {}) {
  const w = worldOf(worldName), a = airspaceById(airspaceId);
  if (!w || !a || a.world !== w.name) return { ok: false, why: 'No such spaceport.' };
  const down = entryProfile(w.name, cls), up = ascentProfile(w.name, cls);
  if (!down || !up) return { ok: false, why: `A ${CLASSES[cls].name.toLowerCase()} can't make ${w.name}: its air is more than its shield takes, or its pull more than its drive.` };
  const grid = npc ? GRID.coarse : GRID.fine, waits = [];
  // out of the bay (after a wait for its window, if that is the quick way)
  for (let W = 0; W <= WINDOW_MAX; W += grid.waitStep) waits.push(W);
  const D = downLegs(w, cls, a, (W) => { const t = t0 + W + LAUNCH_MIN; return { t, s: stateRound(w, carrierPlace(t), t) }; }, waits, carrierPlace, groundMin, grid);
  if (!D) return { ok: false, why: `No way down from here to ${a.port.name} and back up to us that the drive can fly.` };
  const legs = [
    ...(D.W ? [{ phase: 'window', kind: 'dock', t0, t1: t0 + D.W }] : []),
    { phase: 'launch', kind: 'dock', t0: t0 + D.W, t1: t0 + D.W + LAUNCH_MIN },
    ...D.legs,
  ];
  return { ok: true, legs, summary: summarize(w, cls, legs, down, up, groundMin, t0) };
}

/**
 * The rest of a run from where it leaves for the ground (dep(W), as reach
 * has it): the way down to where the entry begins, the entry, the pad, the
 * way back. { W, legs }, or null.
 */
function downLegs(w, cls, a, dep, waits, carrierPlace, groundMin, grid, lead = 0) {
  const down = entryProfile(w.name, cls), air = !!w.atmo, phiE = air ? a.port.ang - down.th : a.port.ang;
  const D = reach(w, cls, dep, waits, (t) => airState(w, down, phiE, t), TWO_PI / w.rotS, { tail: air ? ENTRY_LEAD : 0, lead, names: ['drop', 'drop', 'deorbit'], grid });
  if (!D) return null;
  const tE = D.tArr, tLand = tE + down.t / 60;
  const back = backLegs(w, cls, a, tLand, tLand + groundMin, carrierPlace, { grid });
  return back && { W: D.W, legs: [...D.legs, { phase: 'down', kind: 'down', t0: tE, t1: tLand, phi0: phiE }, ...back] };
}

/** A plan's numbers, for the shuttle window and the callouts. */
function summarize(w, cls, legs, down, up, groundMin, t0) {
  const air = !!w.atmo, fuel = legsFuel(w.name, cls, legs);
  const span = (from, to) => { const a = legs.find(l => from.includes(l.phase)), b = [...legs].reverse().find(l => to.includes(l.phase)); return a && b ? b.t1 - a.t0 : 0; };
  const g = legs.find(l => l.phase === 'ground');
  return {
    world: w.name, air, entryV: air ? down.entryV : 0, peakHeat: down.peakHeat, peakG: Math.max(down.peakG, up.peakG), downrangeKm: air ? down.th * w.R / 1000 : 0,
    windowMin: span(['window'], ['window']), dropMin: span(['drop'], ['deorbit', 'drop']), phasedDown: legs.some(l => l.phase === 'deorbit'), downMin: down.t / 60,
    groundMin, padWaitMin: g ? Math.max(0, g.t1 - g.t0 - groundMin) : 0, upMin: up.t / 60,
    returnMin: span(['orbit', 'return'], ['return']), phasedUp: legs.some(l => l.phase === 'orbit'), totalMin: legs.at(-1).t1 - t0,
    gMin: fuel.gMin, fuelKg: fuel.kg,
  };
}

/**
 * The way back from a pad, landed at `tLand` and free to lift at `tLift`:
 * the pad (held longer if waiting there for the window is the quick way),
 * the climb, the transfer up to the carrier, the bay. Null if the drive
 * can't fly it.
 */
function backLegs(w, cls, a, tLand, tLift, carrierPlace, { grid = GRID.fine, wait = true } = {}) {
  const up = ascentProfile(w.name, cls), phi = a.port.ang + up.th;
  const waits = [0];
  if (wait) for (let W = grid.waitStep; W <= WINDOW_MAX; W += grid.waitStep) waits.push(W);
  const om = rateOf(stateRound(w, carrierPlace(tLift), tLift));
  const dep = (W) => { const t = tLift + W + up.t / 60; return { t, s: airState(w, up, phi, t) }; }, arr = (t) => stateRound(w, carrierPlace(t), t);
  // (coasting a moment at the top of the climb to turn to its burn; a drive whose cruise can't hold it up meanwhile burns on at once)
  const R = reach(w, cls, dep, waits, arr, om, { lead: TURN_LEAD, names: ['return', 'orbit', 'return'], grid })
    || reach(w, cls, dep, waits, arr, om, { names: ['return', 'orbit', 'return'], grid });
  if (!R) return null;
  const lift = tLift + R.W, tX = lift + up.t / 60;
  return [
    { phase: 'ground', kind: 'ground', t0: tLand, t1: lift, phi: a.port.ang },
    { phase: 'up', kind: 'up', t0: lift, t1: tX, phi0: a.port.ang },
    ...R.legs,
    { phase: 'recover', kind: 'dock', t0: R.tArr, t1: R.tArr + RECOVER_MIN },
  ];
}

/** From a craft's state `s` round world `w` at minute `t`, back up to its carrier: the transfer legs and the bay, or null. */
function toCarrier(w, cls, s, t, carrierPlace, grid = GRID.fine) {
  const om = rateOf(stateRound(w, carrierPlace(t), t));
  const dep = () => ({ t, s }), arr = (m) => stateRound(w, carrierPlace(m), m);
  const R = reach(w, cls, dep, [0], arr, om, { lead: TURN_LEAD, names: ['return', 'orbit', 'return'], grid }) || reach(w, cls, dep, [0], arr, om, { names: ['return', 'orbit', 'return'], grid });
  return R && [...R.legs, { phase: 'recover', kind: 'dock', t0: R.tArr, t1: R.tArr + RECOVER_MIN }];
}

/**
 * What a run's legs burn: each transfer's Δv (one cut short by a call back,
 * as far as it was flown), the powered part of the landing (the glide is
 * the air's) and the climb. { gMin, kg }.
 */
function legsFuel(worldName, cls, legs) {
  let gMin = 0;
  for (const l of legs) {
    if (l.kind === 'xfer') gMin += xferDv(l.x, Math.max(0, l.t1 - l.t0) * MIN_S) / G0 / 60;
    else if (l.kind === 'down') gMin += entryProfile(worldName, cls).driveGmin;
    else if (l.kind === 'up') gMin += ascentProfile(worldName, cls).driveGmin;
  }
  return { gMin, kg: gMin * FUEL_PER_G_MIN * craftOf(cls).m / 1e5 };
}

/**
 * How long an NPC carrier's shuttles take to move `tonnes` to a world's
 * ground from its parking orbit, by trips (min): the traffic's outcome when
 * nobody is near to see it (traffic.js). One trip is planned as ours are,
 * from a carrier on the parking orbit, at a few phases of it, averaged
 * (worked out once a world and craft).
 */
const _trips = new Map();
export function runMinutes(worldName, cls, tonnes, shuttles = 1) {
  const key = `${worldName}|${cls}`;
  let trip = _trips.get(key);
  if (trip === undefined) {
    const w = worldOf(worldName), a = w && airspacesOf(w)[0];
    trip = null;
    if (a && entryProfile(worldName, cls) && ascentProfile(worldName, cls)) {
      const n = Math.sqrt(w.GM / w.parkM ** 3), times = [];
      for (const ph of [0, 2.1, 4.2]) {
        const at = (m) => { const c = bodyPos(w.body, m / DAY_MIN), u = bodyVel(w.body, m / DAY_MIN), s = circle(w.GM, w.parkM, ph + n * m * MIN_S);
          return { pos: { x: c.x + s.x / AU_M, y: c.y + s.y / AU_M }, vel: { vx: u.vx + s.vx, vy: u.vy + s.vy } }; };
        const p = planLegs(worldName, cls, a.id, 0, at, { npc: true });
        if (p.ok) times.push(p.summary.totalMin);
      }
      if (times.length) trip = times.reduce((s, x) => s + x, 0) / times.length;
    }
    _trips.set(key, trip);
  }
  if (trip == null) return null;
  const trips = Math.max(1, Math.ceil(tonnes / Math.max(1, CLASSES[cls].cargoT) / shuttles));
  return trip * trips;
}

/**
 * Our shuttle's run, planned from now: { ok, why, plan } (nothing launched).
 * opts.leave: whoever rides down goes ashore at the spaceport, the shuttle
 * on the pad for a run ashore (LEAVE_MIN) instead of a turnaround.
 */
export function planRun(state, shuttleId, airspaceId, opts = {}) {
  if (opts.leave) opts = { ...opts, groundMin: LEAVE_MIN };
  const sh = state.shuttles?.bay.find(s => s.id === shuttleId);
  if (!sh) return { ok: false, why: 'No such shuttle.' };
  if (sh.run) return { ok: false, why: `${sh.name} is out.` };
  const no = runRefusal(state);
  if (no.why) return { ok: false, why: no.why };
  const a = airspaceById(airspaceId);
  if (!a || a.world !== no.w.name) return { ok: false, why: `The spaceport must be on ${no.w.name}.` };
  const p = planLegs(no.w.name, sh.cls, airspaceId, state.clock.minute, (m) => carrierAt(state, m), opts);
  return p.ok ? { ok: true, plan: { ...p, shuttle: sh.id, cls: sh.cls, airspace: a.id, leave: !!opts.leave, groundMin: opts.groundMin ?? GROUND_MIN } } : { ok: false, why: p.why };
}

/** Who can go: the able crew aboard (none away, none hurt past working), the best pilots first. */
export function shuttleCrew(state) {
  return state.ship.crew.filter(m => !m.dead && !m.away && isAble(m))
    .sort((x, y) => (x.role === 'Captain') - (y.role === 'Captain') || (y.skills?.piloting || 0) - (x.skills?.piloting || 0));
}

/** Who may ride down only as a patient, for a world's hospital: hurt past working but stable (not critical), aboard. */
export function shuttlePatients(state, world) {
  return state.ship.crew.filter(m => !m.dead && !m.away && !isAble(m) && !m.conditions.includes('critical') && treatmentFor(m, world));
}

/** The seats a craft has besides its pilot's. */
export const seatsOf = (cls) => CLASSES[cls]?.berths || 0;

/** What a party's run ashore costs (LEAVE_COST a head). */
export const leaveCost = (n) => n * LEAVE_COST;

/** The crew a run takes by default: the able hand with the best piloting, the captain last. */
export function defaultPilot(state) {
  return shuttleCrew(state)[0] || null;
}

/** What of our hold can go down to this spaceport: its PLANETSIDE contracts' cargo, up to the shuttle's room. */
export function cargoFor(state, airspaceId, cls) {
  const room = CLASSES[cls].cargoT * 1000;
  const out = [];
  let left = room;
  for (const item of state.cargo) {
    const c = item.contract && state.contracts.active.find(x => x.id === item.contract);
    if (!c || c.type !== 'PLANETSIDE' || c.airspace !== airspaceId || left <= 0) continue;
    const mass = Math.min(item.mass, left);
    out.push({ contract: c.id, name: item.name, mass });
    left -= mass;
  }
  return { items: out, room, mass: room - left };
}

/**
 * Launch a planned run: its clearance asked for (refused, nothing goes),
 * its pilot and riders away (crew: { pilot, riders } ids, or a list with
 * the pilot first; the best pilot alone by default), the cargo moved into
 * the shuttle, the shuttle a world entity on its flight path. A plan made
 * for leave (planRun opts.leave) sends the party ashore at the spaceport.
 * Returns { ok, text, run }.
 */
export function launchRun(state, plan, emit = () => {}, { crew = null, trade = null, errands = null, hires = null } = {}) {
  const sh = state.shuttles.bay.find(s => s.id === plan.shuttle);
  if (!sh || sh.run) return { ok: false, text: 'That shuttle is not in its bay.' };
  const clr = landingClearance(state, plan.airspace, plan.groundMin);
  if (!clr.ok) return { ok: false, text: clr.text };
  const where = plan.summary.world;
  // (ids as the crew keep them, whether they come as numbers or as a form's strings)
  const able = shuttleCrew(state), patients = plan.leave ? shuttlePatients(state, where) : [];
  const byKey = new Map([...able, ...patients].map(m => [String(m.id), m.id]));
  const list = (Array.isArray(crew) ? crew : crew ? [crew.pilot, ...(crew.riders || [])] : []).filter(x => x != null && x !== '').map(String);
  const pilotId = list.length ? able.find(m => String(m.id) === list[0])?.id : able[0]?.id;
  if (pilotId == null) return { ok: false, text: list.length && byKey.has(list[0]) ? 'A patient can ride down, not fly.' : 'Nobody fit to fly it.' };
  if (list.slice(1).some(k => !byKey.has(k))) return { ok: false, text: 'Someone chosen to ride down is not fit to go.' };
  const riders = [...new Set(list.slice(1).map(k => byKey.get(k)))].filter(id => id !== pilotId);
  if (riders.length > seatsOf(sh.cls)) return { ok: false, text: `A ${CLASSES[sh.cls].name.toLowerCase()} seats ${seatsOf(sh.cls)} besides its pilot.` };
  const party = [pilotId, ...riders];
  // what each does ashore (a run for leave only; a patient goes for the hospital), and who signs on at the pad
  const doing = {};
  if (plan.leave) {
    for (const id of party) {
      const m = state.ship.crew.find(x => x.id === id);
      const want = errands?.[id] ?? errands?.[String(id)] ?? (patients.includes(m) ? 'hospital' : 'leave');
      const opt = errandsFor(state, m, where).find(e => e.id === want);
      if (!opt || opt.why) return { ok: false, text: `${m.name} can't do that on ${where}${opt?.why ? `: ${opt.why}` : ''}.` };
      if (patients.includes(m) && want !== 'hospital') return { ok: false, text: `${m.name} rides down only for the hospital.` };
      doing[id] = want;
    }
  }
  const hall = groundHall(state, where);
  const signing = [...new Set((hires || []).map(Number))].filter(i => hall[i]).map(i => hall[i]);
  const retiring = Object.values(doing).filter(x => x === 'retire').length;
  const upSeats = seatsOf(sh.cls) - riders.length + retiring;
  if (signing.length > upSeats) return { ok: false, text: `${signing.length} to bring up, and ${upSeats} seat${upSeats === 1 ? '' : 's'} free on the way back.` };
  const aboard = state.ship.crew.filter(m => !m.dead).length - retiring;
  if (aboard + signing.length > maxCrew(state.ship.classId)) return { ok: false, text: `No berth aboard for ${signing.length === 1 ? 'another hand' : `${signing.length} more`}.` };
  for (const p of signing) hall.splice(hall.indexOf(p), 1);
  const S = state.shuttles;
  const id = `run-${S.nextId++}`;
  const a = airspaceById(plan.airspace);
  // the cargo bound for this pad goes into the shuttle (out of our hold until it lands, or comes back)
  const freeBefore = holdRoom(state);
  const load = cargoFor(state, plan.airspace, sh.cls);
  for (const it of load.items) {
    const item = state.cargo.find(x => x.contract === it.contract);
    if (item) { item.mass -= it.mass; if (item.mass <= 0) state.cargo.splice(state.cargo.indexOf(item), 1); }
  }
  // goods to sell on the world's market go down with it too, in what room is left; a purchase comes up
  const { sell, buy } = tradeLoad(state, sh.cls, load.mass, trade, plan.summary.world, freeBefore);
  const run = {
    id, shuttle: sh.id, cls: sh.cls, name: sh.name, world: plan.summary.world, airspace: a.id, port: { id: a.port.id, name: a.port.name },
    carrier: 'player', phase: plan.legs[0].phase, legs: plan.legs, summary: plan.summary, crew: party, pilot: pilotId, leave: !!plan.leave, cargo: load.items, delivered: [], sell, buy, up: [],
    errands: doing, hires: signing, paid: {},
    clearance: clr.text, startedAt: state.clock.minute, entity: `shuttle-${id}`, log: [],
  };
  S.runs.push(run);
  if (S.runs.length > 12) S.runs.splice(0, S.runs.length - 12);
  sh.run = id;
  for (const mid of party) {
    const m = state.ship.crew.find(x => x.id === mid);
    if (m) { m.away = { op: id, shuttle: true, pilot: mid === pilotId }; m.task = null; m.seat = null; m.path = []; m.activity = 'away'; }
  }
  const world = getWorld(state);
  const e = createEntity({ id: run.entity, name: `${sh.name} (ours)`, type: 'ship', cls: sh.cls, faction: 'independent', transponder: true, t: state.clock.minute,
    pos: { ...state.flight.pos }, vel: { ...state.flight.vel }, tags: { shuttle: id, ours: true } });
  e.flightPath = { world: run.world, cls: sh.cls, carrier: 'player', legs: plan.legs };
  world.add(e);
  world.refresh(e, state.clock.minute);
  log(run, state, `Launched for ${a.port.name}, ${run.world}: ${clr.text}`);
  emit('shuttle-launched', { run: id, name: sh.name, port: a.port.name, world: run.world });
  const S0 = plan.summary, entry = (S0.windowMin || 0) + LAUNCH_MIN + S0.dropMin;
  emit('nav-callout', { level: 'info', key: 'shuttle', text: `${sh.name} ${S0.windowMin ? `waiting in its bay ${Math.round(S0.windowMin)} min for its window to ${a.port.name}, ${run.world}` : `away for ${a.port.name}, ${run.world}`}: ${S0.air ? 'entry' : 'over the pad'} in ${Math.round(entry)} min, down in ${Math.round(entry + S0.downMin)}.` });
  return { ok: true, text: clr.text, run };
}

const log = (run, state, text) => { run.log.push({ at: state.clock.minute, text }); if (run.log.length > 20) run.log.shift(); };

/** Where a run's shuttle is and how it flies at `minute`: { phase, pos, vel, h, v, q, g, eta (min to recovery) }. */
export function runReadout(state, run, minute = state.clock.minute) {
  if (run.phase === 'done' || run.phase === 'lost') return { phase: run.phase };
  const p = flightPathAt(getWorld(state), { world: run.world, cls: run.cls, carrier: run.carrier, legs: run.legs }, minute);
  const leg = [...run.legs].reverse().find(l => minute >= l.t0) || run.legs[0];
  return { ...p, phase: leg.phase, words: PHASE_WORDS[leg.phase], eta: run.legs.at(-1).t1 - minute, legEnd: leg.t1 - minute };
}

const legIndex = (run, minute) => { let i = 0; run.legs.forEach((l, k) => { if (minute >= l.t0) i = k; }); return i; };

/** A run's legs replaced from leg `i` on (the entity's flight path with them), and what it will burn counted again. */
function relay(state, run, i, legs) {
  run.legs = [...run.legs.slice(0, i), ...legs];
  const f = legsFuel(run.world, run.cls, run.legs);
  const back = run.legs.filter(l => l.phase === 'return' || l.phase === 'orbit' || (l.phase === 'phasing' && run.legs.indexOf(l) > run.legs.findIndex(x => x.phase === 'up')));
  run.summary = { ...run.summary, gMin: f.gMin, fuelKg: f.kg, totalMin: run.legs.at(-1).t1 - run.startedAt, returnMin: back.length ? back.at(-1).t1 - back[0].t0 : 0 };
  const e = getWorld(state).get(run.entity);
  if (e?.flightPath) { e.flightPath.legs = run.legs; getWorld(state).refresh(e, state.clock.minute); }
}

/**
 * Where a craft is on a drive's leg (a transfer, or round an orbit) at
 * `minute`: its state round the world (m, m/s from its centre).
 */
function craftState(w, leg, minute) {
  const s = Math.max(0, (minute - leg.t0) * MIN_S);
  if (leg.kind === 'xfer') { const p = xferAt(w.GM, leg.x, s); return { x: p.x, y: p.y, vx: p.vx, vy: p.vy }; }
  if (leg.kind === 'hold') return circle(w.GM, leg.r, leg.th0 + Math.sqrt(w.GM / leg.r ** 3) * s);
  return null;
}

/**
 * Call a run back. Still in its bay: it stays there, its crew and cargo
 * back aboard. On its way down with room to turn back: from where it is,
 * a transfer back up to us (or by way of a low orbit). Once its last burn
 * has begun it is committed to its entry, so, as in its entry or on the
 * pad, it lands, lifts again as soon as it can (ABORT_GROUND_MIN) and comes
 * back. Climbing or coming back, it is on its way already. Returns { ok,
 * text }.
 */
export function abortRun(state, runId, emit = () => {}) {
  const run = runOf(state, runId);
  if (!run || !activeRuns(state).includes(run)) return { ok: false, text: 'No such run under way.' };
  const now = state.clock.minute, w = worldOf(run.world), a = airspaceById(run.airspace);
  const at = (m) => carrierAt(state, m);
  let i = legIndex(run, now);
  const leg = run.legs[i];
  if (leg.phase === 'launch' || leg.phase === 'window') {
    // nothing burned yet: the run is called off in the bay
    run.legs = run.legs.slice(0, i + 1).map(l => ({ ...l, t1: now }));
    run.summary = { ...run.summary, fuelKg: 0 };
    run.aborted = true;
    log(run, state, 'Called off in the bay');
    recover(state, run, emit);
    return { ok: true, text: `${run.name} stays in its bay.` };
  }
  const downward = ['drop', 'phasing', 'deorbit'].includes(leg.phase);
  if (downward) {
    // (committed once the burn into the air has begun)
    const entering = run.legs[i + 1]?.kind === 'down' && leg.kind === 'xfer' && (now - leg.t0) * MIN_S >= xferBurns(w.GM, leg.x).t2;
    const back = !entering && toCarrier(w, run.cls, craftState(w, leg, now), now, at);
    if (back) {
      relay(state, run, i, [{ ...leg, t1: now }, ...back]);
      run.aborted = true;
      log(run, state, 'Called back: turning back short of the air');
      emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} called back: on its drive back up to us from where it is. Alongside in ${Math.round(run.legs.at(-1).t0 - now)} min.` });
      return { ok: true, text: `${run.name} turning back.` };
    }
  }
  if (downward || ['down', 'ground'].includes(leg.phase)) {
    const gi = run.legs.findIndex(l => l.phase === 'ground');
    const ground = run.legs[gi];
    const lift = Math.max(now + 1, ground.t0 + ABORT_GROUND_MIN);
    if (lift >= ground.t1) return { ok: false, text: `${run.name} lifts off in ${Math.max(1, Math.round(ground.t1 - now))} min anyway.` };
    const back = backLegs(w, run.cls, a, ground.t0, lift, at, { wait: false });
    if (!back) return { ok: false, text: `${run.name} can't find a way back up to us from the pad yet: it keeps to its plan.` };
    relay(state, run, gi, back);
    run.aborted = true;
    if (run.ashore) run.leaveCut = true;                   // (called in from leave: no better for it)
    const why = leg.phase === 'ground' ? 'lifting off now' : leg.phase === 'down' ? 'it lands first, then lifts at once' : 'committed to its entry: it lands, then lifts at once';
    log(run, state, `Called back: ${why}`);
    emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} called back: ${why}. Alongside in ${Math.round(run.legs.at(-1).t0 - now)} min.` });
    return { ok: true, text: `${run.name} called back: ${why}.` };
  }
  return { ok: false, text: `${run.name} is on its way back already.` };
}

/**
 * At the end of its way back: are we where the plan put us? If we moved
 * (a burn, a new orbit), it comes after us from where it is (a transfer to
 * where we will be); if we are out of its world's space, it holds a free
 * orbit where it is and looks again in HOLD_MIN.
 */
function rejoin(state, run, i, emit) {
  const now = state.clock.minute, w = worldOf(run.world), f = state.flight;
  const prev = run.legs[i - 1];
  // (in the world's frame: it moves tens of km a second round the Sun)
  const S = craftState(w, prev, now) || stateRound(w, flightPathAt(getWorld(state), { world: run.world, cls: run.cls, carrier: run.carrier, legs: run.legs.slice(0, i) }, now), now);
  const us = stateRound(w, { pos: f.pos, vel: f.vel }, now);
  const gap = Math.hypot(S.x - us.x, S.y - us.y);
  if (gap < RENDEZVOUS_M) return false;
  const at = (m) => carrierAt(state, m);
  const inside = worldAt(state.flight.pos.x, state.flight.pos.y, now)?.w.name === w.name;
  const from = prev.kind === 'hold' && prev.phase === 'hold' ? i - 1 : i;
  const chase = inside && toCarrier(w, run.cls, S, now, at);
  if (chase) {
    relay(state, run, from, chase);
    log(run, state, `Chasing us: ${Math.round(gap / 1000).toLocaleString()} km`);
    emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} home, but we are ${Math.round(gap / 1000).toLocaleString()} km from where we said: it comes after us, alongside in ${Math.round(run.legs.at(-1).t0 - now)} min.` });
  } else {
    const P = { r: radiusOf(S), th: angleOf(S) };
    // (still out of reach: the same wait, carried on, not another leg on the end)
    relay(state, run, from, [
      { phase: 'hold', kind: 'hold', t0: now, t1: now + HOLD_MIN, r: P.r, th0: P.th },
      { phase: 'recover', kind: 'dock', t0: now + HOLD_MIN, t1: now + HOLD_MIN + RECOVER_MIN },
    ]);
    if (run.phase !== 'hold') {
      log(run, state, 'Holding orbit: we are out of reach');
      emit('nav-callout', { level: 'warn', key: 'shuttle', text: `${run.name} can't reach us out of ${worldOfs(run.world)} space: it holds its orbit there and waits for us.` });
    }
  }
  return true;
}

/**
 * A save from before 1.12.8: a run on the old spiral legs is planned again
 * from where its old leg has the craft now (in its bay: the whole run from
 * now; on its way down: on down from there; past the pad: the way back from
 * where it is), and an NPC shuttle on them is taken off. Called on load
 * (game.js upgradeState).
 */
export function upgradeRuns(state) {
  const S = state.shuttles;
  if (!S) return;
  const world = getWorld(state), now = state.clock.minute, at = (m) => carrierAt(state, m);
  for (const run of activeRuns(state)) {
    if (!run.legs.some(l => l.kind === 'path' && l.t1 > now)) continue;
    const w = worldOf(run.world), a = airspaceById(run.airspace), i = legIndex(run, now), leg = run.legs[i];
    const here = () => stateRound(w, flightPathAt(world, { world: run.world, cls: run.cls, carrier: run.carrier, legs: run.legs }, now), now);
    const ground = run.groundMin ?? run.summary.groundMin ?? GROUND_MIN;
    let legs = null, from = i;
    if (leg.kind === 'dock' && leg.phase === 'launch') {
      const p = planLegs(run.world, run.cls, run.airspace, now, at, { groundMin: ground });
      legs = p.ok ? p.legs : null;
    } else if (leg.kind === 'path' && leg.phase === 'drop') {
      // (on down from where it is; if it can't, it comes back up to us)
      const D = downLegs(w, run.cls, a, () => ({ t: now, s: here() }), [0], at, ground, GRID.fine, TURN_LEAD);
      const rest = D ? D.legs : toCarrier(w, run.cls, here(), now, at);
      legs = rest && [{ ...leg, t1: now }, ...rest];
    } else if (leg.kind === 'path') {
      const back = toCarrier(w, run.cls, here(), now, at);
      legs = back && [{ ...leg, t1: now }, ...back];
    } else if (leg.kind === 'up') {
      const up = ascentProfile(run.world, run.cls), tX = leg.t1, back = toCarrier(w, run.cls, airState(w, up, a.port.ang + up.th, tX), tX, at);
      if (back) { legs = back; from = i + 1; }
    } else {
      const gi = run.legs.findIndex(l => l.phase === 'ground'), g = run.legs[gi];
      const back = g && backLegs(w, run.cls, a, g.t0, Math.max(g.t1, now + 1), at, { wait: false });
      if (back) { legs = back; from = gi; }
    }
    if (legs) { relay(state, run, from, legs); run.entered = Math.min(run.entered ?? i, legIndex(run, now)); }
  }
  for (const id of [...(S.npc || [])]) {
    const e = world.get(id);
    if (e && !e.flightPath?.legs.some(l => l.kind === 'path')) continue;
    if (e) { const c = world.get(e.tags.carrier); if (c?.tags?.shuttleOut === id) c.tags.shuttleOut = null; world.remove(e); }
    S.npc.splice(S.npc.indexOf(id), 1);
  }
}

/** Per minute: our runs along their legs, and what each phase change brings. */
export function shuttlesTick(state, emit = () => {}) {
  const now = state.clock.minute;
  for (const run of activeRuns(state)) {
    let i = legIndex(run, now);
    // (home, or done waiting: we must be where it comes to)
    if (run.legs[i].phase === 'recover' && run.phase !== 'recover' && rejoin(state, run, i, emit)) i = legIndex(run, now);
    const end = run.legs.at(-1).t1;
    // every leg begun since the last minute, in order (a climb shorter than a minute is begun too)
    run.entered ??= Math.max(0, run.legs.findIndex(l => l.phase === run.phase));
    if (now >= end) { for (let k = run.entered + 1; k < run.legs.length; k++) enterLeg(state, run, run.legs[k], emit); recover(state, run, emit); continue; }
    for (let k = run.entered + 1; k <= i; k++) enterLeg(state, run, run.legs[k], emit);
    run.entered = Math.max(run.entered, i);
    run.phase = run.legs[i].phase;
  }
}

/** A run begins a leg: what it says, and (on the pad) its freight and its trade. */
function enterLeg(state, run, leg, emit) {
    const s = run.summary, w0 = worldOf(run.world);
    switch (leg.phase) {
      case 'drop': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} clear of the bay, on its way down: ${s.phasedDown ? 'by a low orbit, ' : ''}entry in ${Math.round(leg.t0 + s.dropMin - state.clock.minute)} min.` }); break;
      case 'phasing': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} in a low orbit round ${run.world}, its drive cold, ${Math.round(leg.t1 - leg.t0)} min until its way on comes round.` }); break;
      case 'down':
        emit('nav-callout', { level: 'info', key: 'shuttle', text: s.air ? `${run.name} at ${worldOfs(run.world)} entry interface: ${(s.entryV / 1000).toFixed(1)} km/s, the heat peaking at ${(s.peakHeat / 1e6).toFixed(2)} MW/m².` : `${run.name} over ${run.port.name}: down on its drive.` });
        log(run, state, s.air ? `Entry at ${(s.entryV / 1000).toFixed(1)} km/s` : 'Powered descent');
        break;
      case 'ground': landed(state, run, emit); break;
      case 'up': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} lifting off from ${run.port.name}.` }); log(run, state, 'Lift-off'); break;
      case 'orbit': case 'return': {
        if (run.aborted || run.log.at(-1)?.text.startsWith('Chasing')) break;
        const prev = run.legs[run.legs.indexOf(leg) - 1], home = Math.round(run.legs.at(-1).t0 - state.clock.minute);
        const out = w0?.atmo ? `out of ${worldOfs(run.world)} air` : `off ${run.world}`;
        if (prev?.phase === 'up') emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} ${out}, coming back up to us${leg.phase === 'orbit' ? ' by a low orbit' : ''}: alongside in ${home} min.` });
        else if (prev?.phase === 'phasing') emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} leaving its low orbit, up to us: alongside in ${home} min.` });
        break;
      }
      case 'deorbit': case 'abort': case 'hold': case 'window': break;
      case 'recover': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} alongside, into its bay.` }); break;
    }
}

/**
 * What a run takes down to sell (out of our hold: lots of the goods named in
 * `trade.sell`, in the room the freight leaves) and what it is to buy for
 * the way up ({ good, t }, at most a shuttle's load).
 */
function tradeLoad(state, cls, usedKg, trade, worldName, freeKg) {
  const room = CLASSES[cls].cargoT * 1000;
  // (the purchase is held room in our hold: no more than was free before anything went down)
  const freeT = freeKg / 1000;
  let left = room - usedKg;
  const sell = [];
  const mid = marketOfWorld(worldName);
  for (const g of trade?.sell || []) {
    if (!mid || tradeRefusal(state, mid, g, 'sell')) continue;
    for (const x of state.cargo.filter(c => c.good === g && !c.contract && c.stolen !== MARKETS[mid].faction)) {
      if (left <= 0.5) break;
      const kg = Math.min(x.mass, left);
      const share = kg / x.mass;
      sell.push({ ...x, mass: kg, cost: (x.cost || 0) * share });
      x.cost = (x.cost || 0) * (1 - share); x.mass -= kg; left -= kg;
    }
  }
  state.cargo = state.cargo.filter(x => x.mass > 0.5);
  const t = trade?.buy?.good && mid && !tradeRefusal(state, mid, trade.buy.good, 'buy') ? Math.min(trade.buy.t, CLASSES[cls].cargoT, freeT) : 0;
  const buy = t > 0.009 ? { good: trade.buy.good, t } : null;
  return { sell, buy };
}

/** What a plan's trade would carry down and bring up, for the window: { downT, upT, room }. */
export function tradeRoom(state, cls, airspaceId) {
  const used = cargoFor(state, airspaceId, cls).mass;
  return { room: CLASSES[cls].cargoT, freeDownT: Math.max(0, CLASSES[cls].cargoT - used / 1000) };
}

/** Down at the pad: the cargo bound there handed over (a PLANETSIDE contract paid for what lands: contracts.js), its trade done. */
function landed(state, run, emit) {
  log(run, state, `Down at ${run.port.name}`);
  const groundLeg = run.legs.find(l => l.phase === 'ground');
  const mid = marketOfWorld(run.world);
  if (mid && (run.sell?.length || run.buy)) {
    // (the purchase into the room held for it in our hold since it went: market.js heldForShuttles)
    const r = shuttleTrade(state, mid, run.sell || [], run.buy);
    run.sell = r.back;
    run.up = r.up;
    run.bought = true;
    if (r.back.length) log(run, state, `Not sold here: ${r.back.map(x => `${(x.mass / 1000).toFixed(1)} t ${x.name.toLowerCase()}`).join(', ')}`);
    if (r.text) {
      log(run, state, `Market: ${r.text}`);
      emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} at ${worldOfs(run.world)} market: ${r.text}.` });
    }
  }
  const handed = [];
  for (const it of run.cargo) {
    const c = state.contracts.active.find(x => x.id === it.contract);
    if (!c || c.airspace !== run.airspace) continue;
    deliverPlanetside(state, c.id, it.mass, emit);
    run.delivered.push(it);
    handed.push(it);
  }
  run.cargo = run.cargo.filter(it => !handed.includes(it));
  // a run ashore: paid for here, each head (short of the credits, they stay with the shuttle)
  if (run.leave && !run.aborted) {
    const cost = leaveCost(run.crew.length);
    if (state.resources.credits.current >= cost) {
      state.resources.credits.current -= cost;
      run.ashore = true;
      log(run, state, `${run.crew.length} ashore at ${run.port.name} (${cost.toLocaleString()} MCR)`);
      errandsAshore(state, run, emit);
    } else log(run, state, `No leave: ${cost.toLocaleString()} MCR to go ashore, and not that much aboard`);
  }
  // hands signed on at the pad: the fee paid here, aboard the shuttle for the way up
  if (run.hires?.length && !run.aborted) {
    for (const p of run.hires) {
      if (state.resources.credits.current < p.fee) { log(run, state, `${p.name} stays ashore: ${p.fee.toLocaleString()} MCR to sign, and not that much aboard`); continue; }
      state.resources.credits.current -= p.fee;
      const m = signOn(state, p, `${run.port.name}, ${run.world}`);
      m.away = { op: run.id, shuttle: true, pilot: false }; m.activity = 'away'; m.seat = null; m.path = [];
      run.crew.push(m.id);
      (run.joined ||= []).push(m.id);
      log(run, state, `${m.given ? `${m.given} ` : ''}${m.name} (${m.role}) signs on at the pad for ${p.fee.toLocaleString()} MCR`);
    }
    run.hires = [];
  }
  emit('shuttle-landed', { run: run.id, name: run.name, port: run.port.name, world: run.world, delivered: handed, airspace: run.airspace });
  emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} down at ${run.port.name}${handed.length ? `: ${Math.round(handed.reduce((s, x) => s + x.mass, 0)).toLocaleString()} kg of ${handed[0].name} handed over` : ''}. Lift-off in ${Math.round(groundLeg.t1 - groundLeg.t0)} min.` });
}

/**
 * On the ground, a run ashore: what each is doing there paid for (short of
 * the credits, plain leave instead), and those retiring sign off on the
 * pad. The rest is done when they are home (finishErrand).
 */
function errandsAshore(state, run, emit) {
  for (const id of [...run.crew]) {
    const m = state.ship.crew.find(x => x.id === id);
    const what = run.errands?.[id];
    if (!m || !what || what === 'leave') continue;
    if (what === 'retire') {
      if (retireOnWorld(state, m, run.world, emit)) { run.crew = run.crew.filter(x => x !== id); log(run, state, `${m.name} signs off and retires on ${run.world}`); }
      continue;
    }
    const cost = errandCost(state, m, what, run.world);
    if (state.resources.credits.current < cost) { run.errands[id] = 'leave'; log(run, state, `${m.name}: ${cost.toLocaleString()} MCR for that, and not that much aboard: leave instead`); continue; }
    state.resources.credits.current -= cost;
    run.paid[id] = cost;
    log(run, state, `${m.name}: ${what === 'hospital' ? 'to the hospital' : `a course in ${what.slice(7)}`} (${cost.toLocaleString()} MCR)`);
  }
}

/** Home: into the bay, the crew aboard at our airlock, the fuel it burned out of our tanks, the entity gone. */
function recover(state, run, emit) {
  run.phase = 'done';
  run.doneAt = state.clock.minute;
  const sh = state.shuttles.bay.find(s => s.id === run.shuttle);
  if (sh) sh.run = null;
  // anything it brought back (cargo that didn't land, goods it didn't sell) goes back in our hold, and what it bought
  for (const it of run.cargo) {
    const item = state.cargo.find(x => x.contract === it.contract);
    if (item) item.mass += it.mass; else state.cargo.push({ contract: it.contract, name: it.name, mass: it.mass });
  }
  run.cargo = [];
  for (const x of [...(run.sell || []), ...(run.up || [])]) stow(state, x);
  run.sell = []; run.up = [];
  state.resources.fuel.current = Math.max(0, state.resources.fuel.current - run.summary.fuelKg);
  const geo = shipGeometry(state.ship);
  const lock = airlockFor(state.ship, null);
  const node = lock?.access != null ? geo.nodes[lock.access] : geo.nodes[0];
  for (const m of state.ship.crew) {
    if (m.away?.op !== run.id) continue;
    m.away = null;
    m.pos = { sx: node.sx, sy: node.sy };
    m.$px = node.sx; m.$py = node.sy;
    m.task = null; m.path = []; m.seat = null;
    // (back from a run ashore, unless it was cut short: called back off the pad, what was paid for
    // and not done refunded; a hand who signed on at the pad just comes aboard; a run flown is experience)
    const errand = run.errands?.[m.id];
    if (run.joined?.includes(m.id)) { /* new aboard */ }
    else if (run.ashore && !run.leaveCut) {
      restedAshore(m, state.clock.minute, { world: run.world, work: !!errand && errand !== 'leave' });
      finishErrand(state, m, errand, run.world);
    } else if (run.paid?.[m.id]) { state.resources.credits.current += run.paid[m.id]; run.paid[m.id] = 0; }
    m.xp = (m.xp || 0) + (m.id === run.pilot ? 3 : 0.5);
  }
  const world = getWorld(state);
  const e = world.get(run.entity);
  if (e) world.remove(e);
  log(run, state, 'Recovered');
  emit('shuttle-recovered', { run: run.id, name: run.name });
  emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} in its bay, its crew aboard.${run.summary.fuelKg > 0 ? ` ${run.summary.fuelKg.toFixed(1)} kg of reaction mass to refill it.` : ''}` });
}

/**
 * Per minute: NPC shuttles where we can see them. Inside a world's
 * planetary space, now and then a carrier holding its parking orbit there
 * on a planetary call (traffic.js) sends one of its shuttles to one of the
 * world's spaceports, planned and flown as ours are; one whose run is over
 * is taken off.
 */
export function npcShuttlesTick(state) {
  const S = state.shuttles;
  if (!S) return;
  S.npc ||= [];
  const world = getWorld(state), now = state.clock.minute;
  for (const id of [...S.npc]) {
    const e = world.get(id);
    if (e && now < e.tags.until && world.get(e.tags.carrier)) continue;
    if (e) { const c = world.get(e.tags.carrier); if (c?.tags?.shuttleOut === id) c.tags.shuttleOut = null; world.remove(e); }
    S.npc.splice(S.npc.indexOf(id), 1);
  }
  const w = state.flight.world && worldOf(state.flight.world.name);
  if (!w || now % NPC_LOOK_MIN || S.npc.length >= NPC_SHUTTLES_MAX || !airspacesOf(w).length) return;
  const centre = bodyPos(w.body, now / DAY_MIN);
  const near = [];
  world.query(centre, w.wellM / AU_M, near);
  for (const carrier of near) {
    if (S.npc.length >= NPC_SHUTTLES_MAX) break;
    if (!carrier.tags?.traffic || carrier.tags.call?.phase !== 'planet' || carrier.tags.planet !== w.name || carrier.tags.shuttleOut || now >= carrier.tags.until) continue;
    if (random() > NPC_LAUNCH_P) continue;
    const bay = bayOf(carrier.cls);
    if (!bay.length) continue;
    const cls = pick(bay).cls, a = pick(airspacesOf(w));
    const p = planLegs(w.name, cls, a.id, now, (m) => carrierPlace(world, carrier.id, m), { npc: true });
    // (none that would keep it past the end of its call)
    if (!p.ok || p.legs.at(-1).t1 > carrier.tags.until) continue;
    const id = `npcsh-${carrier.id}-${now}`;
    const e = createEntity({ id, name: `${carrier.name} · ${CLASSES[cls].name.toLowerCase()}`, type: 'ship', cls, faction: carrier.faction, transponder: true, t: now,
      pos: { ...carrier.pos }, vel: { ...carrier.vel }, tags: { shuttle: true, npc: true, carrier: carrier.id, until: p.legs.at(-1).t1, port: a.port.name } });
    e.flightPath = { world: w.name, cls, carrier: carrier.id, legs: p.legs };
    world.add(e);
    world.refresh(e, now);
    carrier.tags.shuttleOut = id;
    S.npc.push(id);
  }
}

export { PHASE_WORDS };
