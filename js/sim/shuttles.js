// ============================================================
// LONGHAUL — Shuttles: a big hull's way down to a world
//
// A ship too big to be rated for an atmosphere carries shuttles in its bays
// (ship-classes.js BAYS: a pinnace for people and a few tonnes, a cargo
// lander for sixty). Ours (state.shuttles.bay) go down from a world's high
// orbit, the parking orbit or the stationary one we hold (nav.js 'orbit'
// targets), to a spaceport in one of its airspaces (worlds.js), and come
// back. A RUN is planned whole when it is launched (planRun), each stretch
// flown as physics once (planetary.js) and ridden on rails after:
//
//   launch    out of the bay (LAUNCH_MIN)
//   drop      down to the top of the air on the drive, aimed at where the
//             entry must begin for the pad to be under the glide's end (the
//             world turns meanwhile: the plan is solved for it)
//   down      the entry, the glide, the powered landing (or, airless, the
//             powered landing from HOVER_M over the pad)
//   ground    at the spaceport: the cargo bound there is handed over (a
//             PLANETSIDE contract is paid for what is landed: contracts.js),
//             goods it carried down are sold on the world's market and a
//             purchase loaded to bring up (market.js shuttleTrade: paid by
//             radio), and it waits out the turnaround
//   up        the ascent, off the pad to the top of the air
//   return    back up to us on the drive, to where we will be on our orbit
//   recover   into the bay (RECOVER_MIN): the crew back aboard
//
// A landing needs its airspace controller's clearance (landingClearance):
// refused to a ship its power wants, or one flying the flag of a power at
// war with it, or one it won't deal with. The shuttle's pilot (and anyone
// riding down) is away from the ship meanwhile, as a boarding party is
// (crew m.away: the routes wait for them, autopilot.js). The shuttle is a
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
import { CLASSES, bayOf } from './ship-classes.js';
import { bodyPos, bodyVel } from './ephemeris.js';
import { worldOf, worldAt, airspaceById, airspacesOf, worldAngle, controlWords, worldOfs } from './worlds.js';
import { entryProfile, ascentProfile, pathLeg, craftOf, flightPathAt, carrierPlace, placeOnLeg, distanceAt, speedAt, placeAlong, PLAYER_AT, HOVER_M, LAUNCH_MIN, RECOVER_MIN, GROUND_MIN, runMinutes } from './planetary.js';
export { LAUNCH_MIN, RECOVER_MIN, GROUND_MIN, runMinutes };
import { targetStateAt } from './nav.js';
import { FACTIONS } from './factions.js';
import { hostileTo } from './service.js';
import { FUEL_PER_G_MIN } from './flight.js';
import { isAble } from './crew.js';
import { shipGeometry, airlockFor } from './ship-layout.js';
import { deliverPlanetside } from './contracts.js';
import { marketOfWorld, shuttleTrade, stow, holdRoom } from './market.js';
import { GOODS } from './goods.js';

const SPAN_MIN = 0.4;                        // a leg round a world goes at least this far round (rad): a gentle spiral, never a plunge
const RENDEZVOUS_M = 20_000;                 // a shuttle home further than this from us (we moved) chases us
const HOLD_MIN = 10;                         // …or, with us out of its world's space, orbits where it is and looks again this often
const ABORT_GROUND_MIN = 10;                 // called back with it committed to its entry, or down: off the pad this soon
const NPC_SHUTTLES_MAX = 10;                 // NPC shuttles flown where we can see them, at most
const NPC_LAUNCH_P = 0.25;                   // a carrier in a planetary call sends one down, each look (every NPC_LOOK_MIN)
const NPC_LOOK_MIN = 5;
const PHASE_WORDS = { launch: 'launching', drop: 'dropping to the air', abort: 'braking, called back', down: 'entry and landing', ground: 'on the ground', up: 'climbing out', return: 'coming back up', hold: 'waiting for us in orbit', recover: 'into the bay', done: 'stowed' };

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
export function landingClearance(state, airspaceId) {
  const a = airspaceById(airspaceId);
  if (!a) return { ok: false, text: 'No such airspace.' };
  const p = a.authority;
  const who = a.controller;
  if (p && (state.law.wanted?.[p] ?? 0) >= 2) return { ok: false, text: `${who}: your registry is flagged by ${FACTIONS[p]?.short || p}. Landing denied; hold your orbit.` };
  if (p && hostileTo(state, p)) return { ok: false, text: `${who}: no landings for your flag. Clear our airspace.` };
  if (p && p in (state.law.standing || {}) && state.law.standing[p] < -20) return { ok: false, text: `${who}: you are not welcome here. Landing denied.` };
  return { ok: true, text: `${who}: cleared to land at ${a.port.name}. Report at the interface; the pad is yours for ${Math.round(GROUND_MIN / 60 * 10) / 10} hours.` };
}

const wrapSpan = (d) => SPAN_MIN + (((d - SPAN_MIN) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/**
 * Plan a run: the shuttle `shuttle` ({ cls }) from carrier `carrier`
 * ('player' or an entity's id, whose place at a minute `carrierAt` gives),
 * down to airspace `airspaceId`'s spaceport and back, starting `t0`.
 * Returns { ok, why, legs, summary } (legs: plain data for its flight path).
 */
export function planLegs(worldName, cls, airspaceId, t0, carrierPlace, { groundMin = GROUND_MIN } = {}) {
  const w = worldOf(worldName), a = airspaceById(airspaceId);
  if (!w || !a || a.world !== w.name) return { ok: false, why: 'No such spaceport.' };
  const down = entryProfile(w.name, cls), up = ascentProfile(w.name, cls);
  if (!down || !up) return { ok: false, why: `A ${CLASSES[cls].name.toLowerCase()} can't make ${w.name}: its air is more than its shield takes, or its pull more than its drive.` };
  const craft = craftOf(cls), acc = craft.aCruise;
  const air = !!w.atmo;
  const tA = t0 + LAUNCH_MIN;
  const C = polarOf(w, carrierPlace(tA).pos, tA);
  // the drop: aimed at the entry point (upstream of the pad by the glide's own way over the ground), for when it gets there
  const phiE = air ? a.port.ang - down.th : a.port.ang;
  const rE = w.R + down.topM, vB = air ? down.entryV : 0;
  let g = null, T = 3600, span = null;
  for (let k = 0; k < 12; k++) {
    const thE = worldAngle(w, phiE, tA + T / 60);
    span = keepSpan(span, thE - C.th, wrapSpan);
    g = pathLeg(C.r, C.th, rE, span, 'end', 0, vB, acc);
    if (Math.abs(g.T - T) < 1) break;
    T = g.T;
  }
  const tE = tA + g.T / 60, tLand = tE + down.t / 60, tLift = tLand + groundMin;
  const legs = [
    { phase: 'launch', kind: 'dock', t0, t1: tA },
    { phase: 'drop', kind: 'path', t0: tA, t1: tE, g },
    { phase: 'down', kind: 'down', t0: tE, t1: tLand, phi0: phiE },
    { phase: 'ground', kind: 'ground', t0: tLand, t1: tLift, phi: a.port.ang },
    ...backLegs(w, cls, a, tLift, carrierPlace),
  ];
  const back = legs.find(l => l.phase === 'return').g;
  const fuel = legsFuel(w.name, cls, legs);
  return {
    ok: true, legs,
    summary: {
      world: w.name, air, entryV: air ? down.entryV : 0, peakHeat: down.peakHeat, peakG: Math.max(down.peakG, up.peakG), downrangeKm: air ? down.th * w.R / 1000 : 0,
      dropMin: g.T / 60, downMin: down.t / 60, groundMin, upMin: up.t / 60, returnMin: back.T / 60, totalMin: legs.at(-1).t1 - t0,
      gMin: fuel.gMin, fuelKg: fuel.kg,
    },
  };
}

const polarOf = (w, p, m) => { const c = bodyPos(w.body, m / DAY_MIN); const dx = (p.x - c.x) * AU_M, dy = (p.y - c.y) * AU_M; return { r: Math.hypot(dx, dy), th: Math.atan2(dy, dx) }; };

/**
 * A leg from (r, th) round world `w`, at speed v0 at minute `t`, to where
 * the carrier will be when it gets there (iterated: the carrier moves on
 * its orbit meanwhile). `span`: how the angle between is taken (wrapSpan
 * for a leg that spirals out from the air; the short way for a hop).
 */
function chaseLeg(w, r, th, v0, t, carrierPlace, acc, flat, wrap = wrapSpan) {
  let g = null, T = 3600, span = null;
  for (let k = 0; k < 12; k++) {
    const tArr = t + T / 60;
    const P = polarOf(w, carrierPlace(tArr).pos, tArr);
    span = keepSpan(span, P.th - th, wrap);
    g = pathLeg(r, th, P.r, span, flat, v0, 0, acc);
    if (Math.abs(g.T - T) < 1) break;
    T = g.T;
  }
  return g;
}
const shortSpan = (d) => Math.atan2(Math.sin(d), Math.cos(d));
/**
 * The span for an angle `d` between, wrapped the first time and kept
 * continuous with the last after (an aim that crosses the wrap would
 * otherwise flip between going round a little and going round a whole
 * turn, and the time never settle).
 */
const keepSpan = (last, d, wrap) => last == null ? wrap(d) : last + shortSpan(d - last);

/** The way back from a pad, lifting at `tLift`: the climb, the leg up to the carrier, the bay. */
function backLegs(w, cls, a, tLift, carrierPlace) {
  const up = ascentProfile(w.name, cls);
  const tX = tLift + up.t / 60;
  const g2 = chaseLeg(w, w.R + up.topM, worldAngle(w, a.port.ang + up.th, tX), up.v, tX, carrierPlace, craftOf(cls).aCruise, 'start');
  const tArr = tX + g2.T / 60;
  return [
    { phase: 'up', kind: 'up', t0: tLift, t1: tX, phi0: a.port.ang },
    { phase: 'return', kind: 'path', t0: tX, t1: tArr, g: g2 },
    { phase: 'recover', kind: 'dock', t0: tArr, t1: tArr + RECOVER_MIN },
  ];
}

/** What a run's legs burn: the legs at their acceleration, the landing and the climb on the drive. { gMin, kg }. */
function legsFuel(worldName, cls, legs) {
  let gMin = 0;
  for (const l of legs) {
    if (l.kind === 'path') gMin += (l.g.T / 60) * (l.g.a / G0);
    else if (l.kind === 'down') gMin += (entryProfile(worldName, cls).t / 60) * 1.2;
    else if (l.kind === 'up') gMin += (ascentProfile(worldName, cls).t / 60) * 1.2;
  }
  return { gMin, kg: gMin * FUEL_PER_G_MIN * craftOf(cls).m / 1e5 };
}

/** Our shuttle's run, planned from now: { ok, why, plan } (nothing launched). */
export function planRun(state, shuttleId, airspaceId, opts = {}) {
  const sh = state.shuttles?.bay.find(s => s.id === shuttleId);
  if (!sh) return { ok: false, why: 'No such shuttle.' };
  if (sh.run) return { ok: false, why: `${sh.name} is out.` };
  const no = runRefusal(state);
  if (no.why) return { ok: false, why: no.why };
  const a = airspaceById(airspaceId);
  if (!a || a.world !== no.w.name) return { ok: false, why: `The spaceport must be on ${no.w.name}.` };
  const p = planLegs(no.w.name, sh.cls, airspaceId, state.clock.minute, (m) => carrierAt(state, m), opts);
  return p.ok ? { ok: true, plan: { ...p, shuttle: sh.id, cls: sh.cls, airspace: a.id } } : { ok: false, why: p.why };
}

/** The crew a run takes by default: the able hand with the best piloting, the captain last. */
export function defaultPilot(state) {
  const able = state.ship.crew.filter(m => !m.dead && !m.away && isAble(m));
  able.sort((x, y) => (x.role === 'Captain') - (y.role === 'Captain') || (y.skills?.piloting || 0) - (x.skills?.piloting || 0));
  return able[0] || null;
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
 * the pilot away, the cargo moved into the shuttle, the shuttle a world
 * entity on its flight path. Returns { ok, text, run }.
 */
export function launchRun(state, plan, emit = () => {}, { crew = null, trade = null } = {}) {
  const sh = state.shuttles.bay.find(s => s.id === plan.shuttle);
  if (!sh || sh.run) return { ok: false, text: 'That shuttle is not in its bay.' };
  const clr = landingClearance(state, plan.airspace);
  if (!clr.ok) return { ok: false, text: clr.text };
  const pilot = crew?.length ? null : defaultPilot(state);
  const party = crew?.length ? crew : pilot ? [pilot.id] : [];
  if (!party.length) return { ok: false, text: 'Nobody fit to fly it.' };
  const S = state.shuttles;
  const id = `run-${S.nextId++}`;
  const a = airspaceById(plan.airspace);
  // the cargo bound for this pad goes into the shuttle (out of our hold until it lands, or comes back)
  const load = cargoFor(state, plan.airspace, sh.cls);
  for (const it of load.items) {
    const item = state.cargo.find(x => x.contract === it.contract);
    if (item) { item.mass -= it.mass; if (item.mass <= 0) state.cargo.splice(state.cargo.indexOf(item), 1); }
  }
  // goods to sell on the world's market go down with it too, in what room is left; a purchase comes up
  const { sell, buy } = tradeLoad(state, sh.cls, load.mass, trade);
  const run = {
    id, shuttle: sh.id, cls: sh.cls, name: sh.name, world: plan.summary.world, airspace: a.id, port: { id: a.port.id, name: a.port.name },
    carrier: 'player', phase: 'launch', legs: plan.legs, summary: plan.summary, crew: party, cargo: load.items, delivered: [], sell, buy, up: [],
    clearance: clr.text, startedAt: state.clock.minute, entity: `shuttle-${id}`, log: [],
  };
  S.runs.push(run);
  if (S.runs.length > 12) S.runs.splice(0, S.runs.length - 12);
  sh.run = id;
  for (const mid of party) {
    const m = state.ship.crew.find(x => x.id === mid);
    if (m) { m.away = { op: id, shuttle: true }; m.task = null; m.seat = null; m.path = []; m.activity = 'away'; }
  }
  const world = getWorld(state);
  const e = createEntity({ id: run.entity, name: `${sh.name} (ours)`, type: 'ship', cls: sh.cls, faction: 'independent', transponder: true, t: state.clock.minute,
    pos: { ...state.flight.pos }, vel: { ...state.flight.vel }, tags: { shuttle: id, ours: true } });
  e.flightPath = { world: run.world, cls: sh.cls, carrier: 'player', legs: plan.legs };
  world.add(e);
  world.refresh(e, state.clock.minute);
  log(run, state, `Launched for ${a.port.name}, ${run.world}: ${clr.text}`);
  emit('shuttle-launched', { run: id, name: sh.name, port: a.port.name, world: run.world });
  emit('nav-callout', { level: 'info', key: 'shuttle', text: `${sh.name} away for ${a.port.name}, ${run.world}: entry in ${Math.round(plan.summary.dropMin)} min, down in ${Math.round(plan.summary.dropMin + plan.summary.downMin)}.` });
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
  run.summary = { ...run.summary, gMin: f.gMin, fuelKg: f.kg, totalMin: run.legs.at(-1).t1 - run.startedAt, returnMin: (run.legs.find(l => l.phase === 'return')?.g.T || 0) / 60 };
  const e = getWorld(state).get(run.entity);
  if (e?.flightPath) { e.flightPath.legs = run.legs; getWorld(state).refresh(e, state.clock.minute); }
}

/**
 * Call a run back. Still in its bay: it stays there, its crew and cargo
 * back aboard. On its drop with room to stop short of the air: it brakes
 * along its way, then comes back up to us. Past that point it is committed
 * to its entry, so, as in its entry or on the pad, it lands, lifts again as
 * soon as it can (ABORT_GROUND_MIN) and comes back. Climbing or coming
 * back, it is on its way already. Returns { ok, text }.
 */
export function abortRun(state, runId, emit = () => {}) {
  const run = runOf(state, runId);
  if (!run || !activeRuns(state).includes(run)) return { ok: false, text: 'No such run under way.' };
  const now = state.clock.minute, w = worldOf(run.world), a = airspaceById(run.airspace);
  const at = (m) => carrierAt(state, m);
  let i = legIndex(run, now);
  const leg = run.legs[i];
  if (leg.phase === 'launch') {
    // nothing burned yet: the run is called off in the bay
    run.legs = run.legs.slice(0, i + 1).map(l => ({ ...l, t1: now }));
    run.summary = { ...run.summary, fuelKg: 0 };
    run.aborted = true;
    log(run, state, 'Called off in the bay');
    recover(state, run, emit);
    return { ok: true, text: `${run.name} stays in its bay.` };
  }
  if (leg.phase === 'drop') {
    const g = leg.g, s = (now - leg.t0) * MIN_S, d = distanceAt(g, s), v = speedAt(g, s);
    const stop = d + v * v / (2 * g.a);
    if (stop < g.L * 0.97) {
      const tB = now + v / g.a / 60, p = placeAlong(g, stop);
      const back = chaseLeg(w, p.r, p.th, 0, tB, at, g.a, 'start', shortSpan);
      const tArr = tB + back.T / 60;
      relay(state, run, i, [
        { ...leg, t1: now },
        { phase: 'abort', kind: 'path', t0: now, t1: tB, g: { ...g, vA: v, vm: v, vB: 0, d0: d, T: v / g.a } },
        { phase: 'return', kind: 'path', t0: tB, t1: tArr, g: back },
        { phase: 'recover', kind: 'dock', t0: tArr, t1: tArr + RECOVER_MIN },
      ]);
      run.aborted = true;
      log(run, state, 'Called back: braking short of the air');
      emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} called back: braking, ${Math.round((v / g.a) / 60)} min, then up to us. Alongside in ${Math.round(tArr - now)} min.` });
      return { ok: true, text: `${run.name} turning back.` };
    }
    i = run.legs.findIndex(l => l.phase === 'down');
  }
  if (['drop', 'down', 'ground'].includes(leg.phase)) {
    const gi = run.legs.findIndex(l => l.phase === 'ground');
    const ground = run.legs[gi];
    const lift = Math.max(now + 1, ground.t0 + ABORT_GROUND_MIN);
    if (lift >= ground.t1) return { ok: false, text: `${run.name} lifts off in ${Math.max(1, Math.round(ground.t1 - now))} min anyway.` };
    relay(state, run, gi, [{ ...ground, t1: lift }, ...backLegs(w, run.cls, a, lift, at)]);
    run.aborted = true;
    const why = leg.phase === 'ground' ? 'lifting off now' : leg.phase === 'down' ? 'it lands first, then lifts at once' : 'too near the air to stop: it lands, then lifts at once';
    log(run, state, `Called back: ${why}`);
    emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} called back: ${why}. Alongside in ${Math.round(run.legs.at(-1).t0 - now)} min.` });
    return { ok: true, text: `${run.name} called back: ${why}.` };
  }
  return { ok: false, text: `${run.name} is on its way back already.` };
}

/**
 * At the end of its way back: are we where the plan put us? If we moved
 * (a burn, a new orbit), it chases us, a short leg to where we will be; if
 * we are out of its world's space, it holds a free orbit where it is and
 * looks again in HOLD_MIN.
 */
function rejoin(state, run, i, emit) {
  const now = state.clock.minute, w = worldOf(run.world), f = state.flight;
  const prev = run.legs[i - 1];
  // (in the world's frame: it moves tens of km a second round the Sun; and where we were when it got there)
  const t = prev.kind === 'hold' ? now : prev.t1;
  const P = polarOf(w, placeOnLeg({ world: run.world, cls: run.cls }, prev, t).pos, t);
  const c = bodyPos(w.body, now / DAY_MIN), u = bodyVel(w.body, now / DAY_MIN), back = (now - t) * MIN_S;
  const ux = (f.pos.x - c.x) * AU_M - (f.vel.vx - u.vx) * back, uy = (f.pos.y - c.y) * AU_M - (f.vel.vy - u.vy) * back;
  const gap = Math.hypot(P.r * Math.cos(P.th) - ux, P.r * Math.sin(P.th) - uy);
  if (gap < RENDEZVOUS_M) return false;
  const at = (m) => carrierAt(state, m);
  const inside = worldAt(state.flight.pos.x, state.flight.pos.y, now)?.w.name === w.name;
  if (inside) {
    const g = chaseLeg(w, P.r, P.th, 0, now, at, craftOf(run.cls).aCruise, 'start', shortSpan);
    relay(state, run, i, [
      { phase: 'return', kind: 'path', t0: now, t1: now + g.T / 60, g },
      { phase: 'recover', kind: 'dock', t0: now + g.T / 60, t1: now + g.T / 60 + RECOVER_MIN },
    ]);
    log(run, state, `Chasing us: ${Math.round(gap / 1000).toLocaleString()} km`);
    emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} home, but we are ${Math.round(gap / 1000).toLocaleString()} km from where we said: it comes after us, alongside in ${Math.round(g.T / 60)} min.` });
  } else {
    relay(state, run, i, [
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

/** Per minute: our runs along their legs, and what each phase change brings. */
export function shuttlesTick(state, emit = () => {}) {
  const now = state.clock.minute;
  for (const run of activeRuns(state)) {
    let i = legIndex(run, now);
    // (home, or done waiting: we must be where it comes to)
    if (run.legs[i].phase === 'recover' && run.phase !== 'recover' && rejoin(state, run, i, emit)) i = legIndex(run, now);
    const leg = run.legs[i];
    const end = run.legs.at(-1).t1;
    if (now >= end) { recover(state, run, emit); continue; }
    if (leg.phase === run.phase) continue;
    run.phase = leg.phase;
    const s = run.summary, w0 = worldOf(run.world);
    switch (leg.phase) {
      case 'drop': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} clear of the bay, on its drive for ${worldOfs(run.world)} air.` }); break;
      case 'down':
        emit('nav-callout', { level: 'info', key: 'shuttle', text: s.air ? `${run.name} at ${worldOfs(run.world)} entry interface: ${(s.entryV / 1000).toFixed(1)} km/s, the heat peaking at ${(s.peakHeat / 1e6).toFixed(2)} MW/m².` : `${run.name} over ${run.port.name}: down on its drive.` });
        log(run, state, s.air ? `Entry at ${(s.entryV / 1000).toFixed(1)} km/s` : 'Powered descent');
        break;
      case 'ground': landed(state, run, emit); break;
      case 'up': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} lifting off from ${run.port.name}.` }); log(run, state, 'Lift-off'); break;
      case 'return': if (!run.aborted && !run.log.at(-1)?.text.startsWith('Chasing')) emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} ${w0?.atmo ? `out of ${worldOfs(run.world)} air` : `off ${run.world}`}, coming back up to us: alongside in ${Math.round(s.returnMin)} min.` }); break;
      case 'abort': case 'hold': break;
      case 'recover': emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} alongside, into its bay.` }); break;
    }
  }
}

/**
 * What a run takes down to sell (out of our hold: lots of the goods named in
 * `trade.sell`, in the room the freight leaves) and what it is to buy for
 * the way up ({ good, t }, at most a shuttle's load).
 */
function tradeLoad(state, cls, usedKg, trade) {
  const room = CLASSES[cls].cargoT * 1000;
  let left = room - usedKg;
  const sell = [];
  for (const g of trade?.sell || []) {
    for (const x of state.cargo.filter(c => c.good === g && !c.contract)) {
      if (left <= 0.5) break;
      const kg = Math.min(x.mass, left);
      const share = kg / x.mass;
      sell.push({ ...x, mass: kg, cost: (x.cost || 0) * share });
      x.cost = (x.cost || 0) * (1 - share); x.mass -= kg; left -= kg;
    }
  }
  state.cargo = state.cargo.filter(x => x.mass > 0.5);
  const buy = trade?.buy?.good && trade.buy.t > 0 ? { good: trade.buy.good, t: Math.min(trade.buy.t, CLASSES[cls].cargoT) } : null;
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
    // (the purchase no more than will fit in our hold when it is home)
    const buy = run.buy ? { ...run.buy, t: Math.min(run.buy.t, holdRoom(state) / 1000) } : null;
    const r = shuttleTrade(state, mid, run.sell || [], buy);
    run.sell = r.back;
    run.up = r.up;
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
  emit('shuttle-landed', { run: run.id, name: run.name, port: run.port.name, world: run.world, delivered: handed, airspace: run.airspace });
  emit('nav-callout', { level: 'info', key: 'shuttle', text: `${run.name} down at ${run.port.name}${handed.length ? `: ${Math.round(handed.reduce((s, x) => s + x.mass, 0)).toLocaleString()} kg of ${handed[0].name} handed over` : ''}. Lift-off in ${Math.round(groundLeg.t1 - groundLeg.t0)} min.` });
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
    if (e && now < e.tags.until) continue;
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
    if (!carrier.tags?.traffic || carrier.tags.call?.phase !== 'planet' || carrier.tags.planet !== w.name || carrier.tags.shuttleOut) continue;
    if (random() > NPC_LAUNCH_P) continue;
    const bay = bayOf(carrier.cls);
    if (!bay.length) continue;
    const cls = pick(bay).cls, a = pick(airspacesOf(w));
    const p = planLegs(w.name, cls, a.id, now, (m) => carrierPlace(world, carrier.id, m));
    if (!p.ok) continue;
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
