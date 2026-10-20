// ============================================================
// LONGHAUL — Navigation: targets, plans, route estimation
//
// A *plan* is a guidance recipe (closing law with a G limit and
// optional cruise cap, a Lambert transfer, or a stance kept on a
// target until released: stance.js). The SAME guidanceStep
// drives the live autopilot and the planner's fast-forward simulation,
// so route previews (ETA, fuel, Δv, drawn trajectory) match what the
// ship will actually fly.
// ============================================================

import { AU_M, G0, MIN_S, GM_SUN, DAY_MIN } from '../core/constants.js';
import { getBody, bodyPos, bodyVel } from './ephemeris.js';
import { getWorld, predictEntity, stepFree, propagateFree } from './world.js';
import { createFlight, flightStep, fuelUsed, RCS_MAX_G, SLEW_RATE } from './flight.js';
import { playerClass, ratedG } from './ship-classes.js';

const RCS_LIMIT = RCS_MAX_G * G0;
import { relativeState, pointFrom, closingLaw, keepLaw, hasArrived, transferLaw, brakingSpeed, flipSeconds, minutesToFlip } from './guidance.js';
import { stanceStep } from './stance.js';
import { solveLambert } from './lambert.js';

// Standoff distances (m)
export const STANDOFF = {
  STATION: 3_000,        // parking slot off a station
  SHIP: 2_000,           // formation distance
  SCANNER: 0.1 * AU_M,   // long sensor range
  CLOSE: 100_000_000,    // 100,000 km — full sensor lock, comms
  TACTICAL: 2_000,       // formation: boarding, tow, EVA
};

// ---- TARGETS ----
// target spec: { kind:'body', id:'Mars' } | { kind:'entity', id:'ceres-station' }
//              | { kind:'player' } (NPC guidance flying to our ship)

export function targetName(state, target) {
  if (target.kind === 'body') return target.id;
  if (target.kind === 'player') return state.ship.name;
  return getWorld(state).get(target.id)?.name || 'Unknown';
}

export function targetExists(state, target) {
  if (target.kind === 'player') return !state.lost;
  return target.kind === 'body' ? !!getBody(target.id) : !!getWorld(state).get(target.id);
}

/** Default stop distance for a target. Bodies: a parking orbit well clear of the surface. */
export function defaultStandoff(state, target) {
  if (target.kind === 'body') {
    const b = getBody(target.id);
    return Math.max(2_000_000, (b?.radius || 0) * 1000 * 3);
  }
  const e = getWorld(state).get(target.id);
  return e?.type === 'station' ? STANDOFF.STATION : STANDOFF.SHIP;
}

/**
 * The swing of a circular orbit around its centre at `days`: the part of
 * the orbiter's velocity and acceleration that comes round every period.
 * r in AU, period in days, angle in rad.
 */
function swing(r, period, angle) {
  const w = 2 * Math.PI / (period * 86400);
  const c = Math.cos(angle), s = Math.sin(angle);
  const v = w * r * AU_M, a = w * v;
  return { vx: -v * s, vy: v * c, ax: -a * c, ay: -a * s, period: period * 86400 };
}

/** A moon's swing around its planet (none for planets and asteroids). */
function bodySwings(b, days, out) {
  if (b.parent && b.period > 0) out.push(swing(b.a, b.period, b.initAngle + 2 * Math.PI * days / b.period));
  return out;
}

/**
 * Target state {pos, vel, ax, ay} at a minute. `live` refreshes entities in
 * place (use for the current minute); otherwise predicts without mutation.
 * Rails targets also give `atx/aty`, their total acceleration, and `swings`:
 * the periodic parts of their motion (a station circling a moon, the moon
 * circling its planet), which guidance follows only near arrival.
 */
export function targetStateAt(state, target, minute, live = false) {
  if (target.kind === 'body') {
    const b = getBody(target.id);
    if (!b) return null;
    const days = minute / DAY_MIN;
    const out = { pos: bodyPos(b, days), vel: bodyVel(b, days), ax: 0, ay: 0 };
    // total acceleration (moons swing around their planet hard) for guidance feed-forward
    // average over the coming step (what the flight integrator will see)
    const v1 = bodyVel(b, (minute + 1) / DAY_MIN), v0 = out.vel;
    out.atx = (v1.vx - v0.vx) / MIN_S; out.aty = (v1.vy - v0.vy) / MIN_S;
    out.swings = bodySwings(b, days, []);
    return out;
  }
  if (target.kind === 'player') {
    // NPCs flying to us: our state now, or coasted forward under our current thrust
    const f = state.flight;
    const a = f.thrustG * G0;
    const pos = { x: f.pos.x, y: f.pos.y }, vel = { vx: f.vel.vx, vy: f.vel.vy };
    if (minute > state.clock.minute) propagateFree(pos, vel, state.clock.minute, minute, f.thrustG, f.facing, f.thrustG > 0 ? 1 : 10);
    return { pos, vel, ax: a * Math.cos(f.facing), ay: a * Math.sin(f.facing) };
  }
  const world = getWorld(state);
  const e = world.get(target.id);
  if (!e) return null;
  let pos, vel;
  if (live) {
    world.refresh(e, minute);
    world.hash.update(e);
    pos = e.pos; vel = e.vel;
  } else {
    ({ pos, vel } = predictEntity(e, minute, world));
  }
  const tg = e.orbit ? 0 : (e.thrust || 0) * G0;
  const out = { pos, vel, ax: tg * Math.cos(e.heading || 0), ay: tg * Math.sin(e.heading || 0) };
  if (e.orbit || e.transit) {
    // rails motion isn't free fall: give guidance the true total acceleration
    // average over the coming step (what the flight integrator will see)
    const a = predictEntity(e, minute + 1, world).vel;
    out.atx = (a.vx - vel.vx) / MIN_S; out.aty = (a.vy - vel.vy) / MIN_S;
  }
  const b = e.orbit && getBody(e.orbit.body);
  if (b) {
    const days = minute / DAY_MIN, o = e.orbit;
    out.swings = o.period > 0 ? [swing(o.r, o.period, o.phase + 2 * Math.PI * days / o.period)] : [];
    bodySwings(b, days, out.swings);
  }
  return out;
}

/**
 * Monotonic target predictor for fast-forward simulation: bodies and rails
 * entities are exact at any time; free-flying entities are propagated
 * incrementally from a private copy (O(1) per step, never mutates the world).
 */
export function targetTracker(state, target, t0) {
  if (target.kind === 'body') return (t) => targetStateAt(state, target, t);
  const e = getWorld(state).get(target.id);
  if (!e) return () => null;
  if (e.orbit || e.transit) return (t) => targetStateAt(state, target, t);
  const { pos, vel } = predictEntity(e, t0);
  const thrust = e.thrust || 0, heading = e.heading || 0;
  const tg = thrust * G0;
  const out = { pos, vel, ax: tg * Math.cos(heading), ay: tg * Math.sin(heading) };
  let tc = t0;
  return (t) => {
    if (t > tc) {
      while (tc < t) {
        const step = Math.min(t - tc, thrust > 0 ? 1 : 30);
        stepFree(pos, vel, step * MIN_S, thrust, heading);
        tc += step;
      }
    }
    return out;
  };
}

// ---- PLANS ----

/**
 * @param kind 'closing' | 'transfer'
 * opts: { accelG, cruise (m/s), arriveAt (minute, transfer), standoff (m), label, name }
 */
export function createPlan(kind, target, opts) {
  return {
    kind,
    target: { kind: target.kind, id: target.id },
    accelG: opts.accelG,
    cruise: opts.cruise ?? null,           // m/s cap on closing speed (economy)
    arriveAt: opts.arriveAt ?? null,       // transfer: planned arrival minute
    standoff: opts.standoff,
    stage: kind === 'transfer' ? 'transfer' : 'closing',
    name: opts.name || '',
    label: opts.label || '',
  };
}

const _rel = {};
const _relP = {};
const _cl = {};

// The closing law plans an approach from afar: the flip, the brake, the turn
// into the attitude that holding on the target takes. Close in it has no
// room to plan, and a ship that has fallen off the plan there has nothing
// to fall back on. So the keep law (guidance.js) flies the near zone when:
// - the route starts there, toward a target whose pull takes the drive (a
//   ship under thrust, a station circling a moon): no hold turn was planned;
// - the approach has fallen off its plan there: opening on the target fast.
// It hands back if the ship gets well clear again.
const NEAR_M = 100_000;              // m from the stop point
const OFF_PLAN_OPENING = 50;         // m/s opening on the target, inside NEAR_M
const HOLD_PULL = 0.8 * RCS_LIMIT;   // a pull above this takes the drive (guidance.js)

function nearHandover(plan, rel) {
  const dEff = rel.d - plan.standoff;
  if (plan.$keep == null) plan.$keep = dEff <= NEAR_M && Math.hypot(rel.ffx, rel.ffy) > HOLD_PULL;
  else if (!plan.$keep && dEff <= NEAR_M && rel.vClose < -OFF_PLAN_OPENING) plan.$keep = true;
  else if (plan.$keep && dEff > 2 * NEAR_M) plan.$keep = false;
  return plan.$keep;
}

const _tl = {};

/**
 * One guidance decision for `plan` at `minute`.
 * Returns { cmd, arrived, rel, phase, flipIn } — `phase` is a display hint:
 * 'burn' | 'coast' | 'brake' | 'approach' | 'transfer-burn', and for a
 * stance (stance.js, which never ends on arrival) 'holding' | 'watch' |
 * 'ready' | 'guard'.
 */
export function guidanceStep(plan, flight, minute, tgtNow, arrivalTarget, dtSec = MIN_S) {
  // The plan's G, or less if the machinery can't give it right now
  const aMax = Math.min(plan.accelG, flight.maxG ?? Infinity) * G0;
  const slew = flight.$slew ?? SLEW_RATE;
  if (plan.kind === 'stance') return stanceStep(plan, flight, tgtNow, { aMax, slew, dtSec });
  const rel = relativeState(flight, tgtNow, _rel);
  const cruise = plan.cruise ?? Infinity;
  const cmd = { ax: 0, ay: 0, maxG: plan.accelG, lean: true };
  let phase = 'coast';
  let flipIn = Infinity;

  if (plan.stage === 'transfer') {
    const vMax = brakingSpeed(Math.max(0, rel.d - plan.standoff), aMax, flipSeconds(flight.facing, rel.ux, rel.uy, slew));
    const timeLeft = (plan.arriveAt - minute);
    if (rel.vClose >= 0.9 * vMax || timeLeft < 60 || rel.d < 0.002 * AU_M || !arrivalTarget) {
      plan.stage = 'closing';
    } else if (minute < (plan.$coastUntil ?? -Infinity)) {
      phase = 'coast';                       // on the arc; next correction check scheduled
      cmd.face = Math.atan2(rel.uy, rel.ux);
    } else {
      const tl = transferLaw(flight, arrivalTarget, minute, plan.arriveAt, aMax, dtSec, _tl);
      if (!tl) plan.stage = 'closing';
      else {
        cmd.ax = tl.ax; cmd.ay = tl.ay;
        phase = tl.dv > 20 ? 'transfer-burn' : 'coast';
        // On the arc: re-check for mid-course corrections hourly
        if (tl.dv < 0.5) plan.$coastUntil = minute + 60;
        // Keep the nose pointed along the track while coasting (ready to burn)
        cmd.face = Math.atan2(rel.uy, rel.ux);
      }
    }
  }

  if (plan.stage === 'closing' && nearHandover(plan, rel)) {
    // Close in, off the closing law's plan: the keep law flies us onto the
    // stop point (the standoff, on the line of sight) from whatever state
    const P = pointFrom(tgtNow, rel.ux, rel.uy, -plan.standoff);
    keepLaw(relativeState(flight, P, _relP), { aMax, facing: flight.facing, slew, dtSec, settled: false }, _cl);
    cmd.ax = _cl.ax; cmd.ay = _cl.ay;
    if (_cl.face != null) cmd.face = _cl.face;
    phase = 'approach';
  } else if (plan.stage === 'closing') {
    const cl = closingLaw(rel, { aMax, standoff: plan.standoff, cruise, facing: flight.facing, slew, dtSec, memo: plan.$memo ??= {} }, _cl);
    cmd.ax = cl.ax; cmd.ay = cl.ay;
    if (cl.face != null) cmd.face = cl.face;
    const along = cl.ax * rel.ux + cl.ay * rel.uy;
    const mag = Math.hypot(cl.ax, cl.ay);
    if (cl.dEff < 1e7 && mag < 0.05 * G0) phase = 'approach';
    else if (mag < 0.002 * G0) phase = 'coast';
    else phase = along >= 0 ? 'burn' : 'brake';
    if (phase === 'coast' || phase === 'burn') {
      flipIn = minutesToFlip(rel, aMax, plan.standoff, cruise, flight.facing);
    }
  }

  // Never stall halfway through a rotation: if the command goes quiet while the
  // nose is swinging, keep swinging to the last commanded attitude.
  const mag = Math.hypot(cmd.ax, cmd.ay);
  if (mag > RCS_LIMIT) plan.$want = Math.atan2(cmd.ay, cmd.ax);
  else if (plan.$want != null && Math.abs(flight.turning) > 1e-3 && cmd.face == null) cmd.face = plan.$want;

  return {
    cmd,
    arrived: plan.stage === 'closing' && hasArrived(rel, plan.standoff),
    phase,
    flipIn,
    d: rel.d,
    dEff: Math.max(0, rel.d - plan.standoff),
    vClose: rel.vClose,
    relSpeed: rel.speed,
  };
}

// ---- ESTIMATION ----

/**
 * Fly a plan forward from the current state without touching it.
 * Returns { arrived, minutes, fuel, dv, peakSpeed, maxG, path:[{x,y}], end }.
 */
export function simulatePlan(state, planIn, { maxMinutes = 2 * 365 * DAY_MIN, pathPoints = 160 } = {}) {
  // (a copy: what the plan remembers, it remembers for the live flight only)
  const plan = { ...planIn, target: { ...planIn.target }, $memo: planIn.$memo && { ...planIn.$memo } };
  const f = createFlight(state.flight.pos, state.flight.vel, state.flight.facing);
  f.maxG = state.flight.maxG;
  const rated = ratedG(playerClass(state));
  const t0 = state.clock.minute;
  let t = t0;
  let fuel = 0, dv = 0, peak = 0, maxG = 0;
  const raw = [];
  const arrivalTgt = plan.kind === 'transfer' ? targetStateAt(state, plan.target, plan.arriveAt) : null;
  const track = targetTracker(state, plan.target, t0);
  let arrived = false;
  let steps = 0;

  while (t - t0 < maxMinutes && steps < 400_000) {
    steps++;
    const tgt = track(t);
    if (!tgt) break;
    // Coarse steps on long ballistic coasts far from the target
    let dtMin = 1;
    const rd = Math.hypot(tgt.pos.x - f.pos.x, tgt.pos.y - f.pos.y);
    if (plan.stage === 'transfer' && f.thrustG === 0 && rd > 0.05 && plan.arriveAt - t > 2 * DAY_MIN) dtMin = 30;
    const g = guidanceStep(plan, f, t, tgt, arrivalTgt, dtMin * MIN_S);
    if (g.arrived) { arrived = true; break; }
    const out = flightStep(f, g.cmd, dtMin);
    fuel += fuelUsed(out.mainG, out.rcsG, dtMin, rated);
    dv += (out.mainG + out.rcsG) * G0 * dtMin * MIN_S;
    if (out.mainG > maxG) maxG = out.mainG;
    if (g.relSpeed > peak) peak = g.relSpeed;
    if (steps % 10 === 1) raw.push({ x: f.pos.x, y: f.pos.y });
    t += dtMin;
  }
  raw.push({ x: f.pos.x, y: f.pos.y });
  const stride = Math.max(1, Math.ceil(raw.length / pathPoints));
  const path = raw.filter((_, i) => i % stride === 0 || i === raw.length - 1);
  return { arrived, minutes: t - t0, fuel, dv, peakSpeed: peak, maxG, path, end: { x: f.pos.x, y: f.pos.y } };
}

// ---- TRANSFER WINDOW SEARCH ----

/** Pick the arrival time with the lowest total Δv for a ballistic transfer. */
export function findTransfer(state, target) {
  const t0 = state.clock.minute;
  const sp = state.flight.pos, sv = state.flight.vel;
  const r1 = Math.hypot(sp.x, sp.y) * AU_M;
  const tgt0 = targetStateAt(state, target, t0);
  if (!tgt0) return null;
  const r2 = Math.hypot(tgt0.pos.x, tgt0.pos.y) * AU_M;
  const aT = (r1 + r2) / 2;
  const hohmannDays = Math.PI * Math.sqrt(aT * aT * aT / GM_SUN) / 86400;
  const lo = 2, hi = Math.min(500, Math.max(30, hohmannDays * 1.6));
  let best = null;
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const days = lo * Math.pow(hi / lo, i / N);
    const tA = t0 + Math.round(days * DAY_MIN);
    const tgt = targetStateAt(state, target, tA);
    const sol = solveLambert(sp.x * AU_M, sp.y * AU_M, tgt.pos.x * AU_M, tgt.pos.y * AU_M, days * 86400);
    if (!sol) continue;
    const dv1 = Math.hypot(sol.v1x - sv.vx, sol.v1y - sv.vy);
    const dv2 = Math.hypot(sol.v2x - tgt.vel.vx, sol.v2y - tgt.vel.vy);
    const cost = dv1 + dv2;
    if (!best || cost < best.dv) best = { arriveAt: tA, days, dv: cost, dv1, dv2 };
  }
  return best;
}

// ---- ROUTE OPTIONS ----

const OPTION_DEFS = [
  { name: 'EXPRESS', label: '3G brachistochrone', accelG: 3, desc: 'Hard burn, flip, hard brake. Fastest — crew on juice the whole way.' },
  { name: 'STANDARD', label: '1G brachistochrone', accelG: 1, desc: 'Earth-normal gravity throughout. Comfortable and quick.' },
  { name: 'BELTER', label: '0.3G brachistochrone', accelG: 0.3, desc: 'Belter standard — easy on bodies and drive. Slow but gentle.' },
  { name: 'ECONOMY', label: '0.3G burn · coast', accelG: 0.3, cruiseFrac: 0.3, desc: 'Short burns, long coast at cruise speed. Saves reaction mass.' },
];
const COMBAT_DEFS = [
  { name: 'COMBAT 5G', label: '5G brachistochrone', accelG: 5, desc: 'Combat burn. Juice mandatory; hangover guaranteed.' },
  { name: 'ASSAULT 7G', label: '7G brachistochrone', accelG: 7, desc: 'Rated maximum. Expect casualties among the unsecured.' },
  { name: 'FLANK 10G', label: '10G — drive overdriven', accelG: 10, flank: true, desc: 'Past rated limits. High-dose juice (2 med per crew, a booster a day), stroke risk, a crash of a week or more afterwards, double fuel above 7G, and every minute risks a containment failure.' },
];

/** Every route profile the planner can offer (the ship's library lists them). */
export const ROUTE_PROFILES = [...OPTION_DEFS, ...COMBAT_DEFS,
  { name: 'BALLISTIC', label: 'Lambert transfer', desc: 'Burn onto a free-fall arc and coast. Minimum fuel, very long transit.' }];

/**
 * Build and estimate route options to a target.
 * @param opts { standoff, combat (bool), includeBallistic (bool) }
 */
export function planRoutes(state, target, opts = {}) {
  const standoff = opts.standoff ?? defaultStandoff(state, target);
  const t0 = state.clock.minute;
  const tgt = targetStateAt(state, target, t0);
  if (!tgt) return [];
  const distM = Math.hypot(tgt.pos.x - state.flight.pos.x, tgt.pos.y - state.flight.pos.y) * AU_M;
  const fuelAvail = state.resources.fuel.current;
  // A thrusting target can only be caught by out-accelerating it
  const minG = opts.minG ?? 0;
  const defs = [...OPTION_DEFS, ...(opts.combat ? COMBAT_DEFS : [])]
    .filter(d => d.accelG <= state.flight.maxG && d.accelG > minG);

  const options = [];
  for (const d of defs) {
    const cruise = d.cruiseFrac ? Math.max(500, d.cruiseFrac * Math.sqrt(Math.max(0, distM - standoff) * d.accelG * G0)) : null;
    const plan = createPlan('closing', target, { accelG: d.accelG, cruise, standoff, name: d.name, label: d.label });
    const opt = finishOption(state, plan, d.desc, fuelAvail);
    opt.flank = !!d.flank;
    options.push(opt);
  }

  const ballisticOK = opts.includeBallistic !== false &&
    (target.kind === 'body' || getWorld(state).get(target.id)?.orbit) &&
    distM > 0.02 * AU_M;
  if (ballisticOK) {
    const tr = findTransfer(state, target);
    if (tr) {
      const plan = createPlan('transfer', target, { accelG: 0.3, arriveAt: tr.arriveAt, standoff, name: 'BALLISTIC', label: `Lambert transfer · ${Math.round(tr.days)}d` });
      options.push(finishOption(state, plan, 'Burn onto a free-fall arc and coast. Minimum fuel, very long transit.', fuelAvail));
    }
  }
  return options;
}

function finishOption(state, plan, desc, fuelAvail) {
  const est = simulatePlan(state, plan);
  return {
    plan,
    name: plan.name,
    label: plan.label,
    desc,
    accelG: plan.accelG,
    estimate: est,
    minutes: est.minutes + PREP_MINUTES,
    fuel: est.fuel,
    feasible: est.arrived && est.fuel <= fuelAvail * 0.95,
    reason: !est.arrived ? 'No convergent trajectory' : est.fuel > fuelAvail * 0.95 ? 'Insufficient reaction mass' : '',
    juice: plan.accelG > 1.5,
  };
}

/** Rough allowance for securing crew before the first burn. */
export const PREP_MINUTES = 10;
