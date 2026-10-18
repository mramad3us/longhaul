// ============================================================
// LONGHAUL — Navigation: targets, plans, route estimation
//
// A *plan* is a guidance recipe (closing law with a G limit and
// optional cruise cap, or a Lambert transfer). The SAME guidanceStep
// drives the live autopilot and the planner's fast-forward simulation,
// so route previews (ETA, fuel, Δv, drawn trajectory) match what the
// ship will actually fly.
// ============================================================

import { AU_M, G0, MIN_S, GM_SUN, DAY_MIN } from '../core/constants.js';
import { getBody, bodyPos, bodyVel } from './ephemeris.js';
import { getWorld, predictEntity, stepFree } from './world.js';
import { createFlight, flightStep, fuelUsed, FLIP_MINUTES } from './flight.js';
import { relativeState, closingLaw, hasArrived, transferLaw, brakingSpeed, minutesToFlip } from './guidance.js';
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

export function targetName(state, target) {
  if (target.kind === 'body') return target.id;
  return getWorld(state).get(target.id)?.name || 'Unknown';
}

export function targetExists(state, target) {
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
 * Target state {pos, vel, ax, ay} at a minute. `live` refreshes entities in
 * place (use for the current minute); otherwise predicts without mutation.
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
    return out;
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
const _cl = {};
const _tl = {};

/**
 * One guidance decision for `plan` at `minute`.
 * Returns { cmd, arrived, rel, phase, flipIn } — `phase` is a display hint:
 * 'burn' | 'coast' | 'brake' | 'approach' | 'transfer-burn'.
 */
export function guidanceStep(plan, flight, minute, tgtNow, arrivalTarget, dtSec = MIN_S) {
  const aMax = plan.accelG * G0;
  const rel = relativeState(flight, tgtNow, _rel);
  const cruise = plan.cruise ?? Infinity;
  const cmd = { ax: 0, ay: 0, maxG: plan.accelG };
  let phase = 'coast';
  let flipIn = Infinity;

  if (plan.stage === 'transfer') {
    const nose = Math.cos(flight.facing) * rel.ux + Math.sin(flight.facing) * rel.uy > 0;
    const vMax = brakingSpeed(Math.max(0, rel.d - plan.standoff), aMax, nose);
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

  if (plan.stage === 'closing') {
    const cl = closingLaw(rel, { aMax, standoff: plan.standoff, cruise, facing: flight.facing, dtSec }, _cl);
    cmd.ax = cl.ax; cmd.ay = cl.ay;
    const along = cl.ax * rel.ux + cl.ay * rel.uy;
    const mag = Math.hypot(cl.ax, cl.ay);
    if (cl.dEff < 1e7 && mag < 0.05 * G0) phase = 'approach';
    else if (mag < 0.002 * G0) phase = 'coast';
    else phase = along >= 0 ? 'burn' : 'brake';
    if (phase === 'coast' || phase === 'burn') {
      flipIn = minutesToFlip(rel, aMax, plan.standoff, cruise, flight.facing);
    }
  }

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
  const plan = { ...planIn, target: { ...planIn.target } };
  const f = createFlight(state.flight.pos, state.flight.vel, state.flight.facing);
  f.maxG = state.flight.maxG;
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
    fuel += fuelUsed(out.mainG, out.rcsG, dtMin);
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
  { name: 'ASSAULT 7G', label: '7G brachistochrone', accelG: 7, desc: 'Maximum assault burn. Expect casualties among the unsecured.' },
];

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
    options.push(finishOption(state, plan, d.desc, fuelAvail));
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
export { FLIP_MINUTES };
