// ============================================================
// LONGHAUL — Autopilot & station-keeping
//
// Lifecycle of a route:
//   prepare — all hands to crash couches, pilot at the helm. Engages
//             automatically when everyone able is strapped in, or on
//             the captain's override (unsecured crew may get hurt).
//   active  — guidance flies the plan (burn / flip / brake / coast /
//             RCS approach), re-planning every minute.
//   arrive  — co-moving within the standoff: hold station on target.
//
// Holding station: the ship rides with its target at a fixed offset
// (parked off a station, formation with a ship, parking orbit at a
// body). If the target is under thrust, holding means burning with it.
// ============================================================

import { AU_M, G0, DAY_MIN } from '../core/constants.js';
import { getWorld } from './world.js';
import { targetStateAt, targetName, guidanceStep } from './nav.js';
import { crewSecureStatus } from './crew-ai.js';

/** Begin flying a plan. opts: { missionId, intercept, estimate } */
export function engageRoute(state, plan, opts = {}) {
  const f = state.flight;
  state.autopilot = {
    plan: { ...plan, target: { ...plan.target } },
    phase: 'prepare',
    display: 'prepare',
    override: false,
    createdAt: state.clock.minute,
    engagedAt: null,
    ignitedAt: null,
    startPos: { x: f.pos.x, y: f.pos.y },
    fuelStart: state.resources.fuel.current,
    estimate: opts.estimate ? { minutes: opts.estimate.minutes, fuel: opts.estimate.fuel, path: opts.estimate.path } : null,
    missionId: opts.missionId ?? null,
    intercept: opts.intercept ?? null,
    peakG: 0,
    flipIn: Infinity,
    d: null, vClose: 0, relSpeed: 0,
  };
  return state.autopilot;
}

export function abortRoute(state, emit = () => {}) {
  if (!state.autopilot) return false;
  const name = targetName(state, state.autopilot.plan.target);
  state.autopilot = null;
  state.flight.thrustG = 0;
  emit('route-aborted', { target: name });
  return true;
}

export function overrideSecure(state) {
  if (state.autopilot?.phase !== 'prepare') return false;
  state.autopilot.override = true;
  return true;
}

/** Hold station on a target at the current relative offset. */
export function holdStation(state, target) {
  const tgt = targetStateAt(state, target, state.clock.minute, true);
  if (!tgt) return false;
  const f = state.flight;
  state.flight.hold = {
    kind: target.kind, id: target.id,
    ox: (f.pos.x - tgt.pos.x) * AU_M,
    oy: (f.pos.y - tgt.pos.y) * AU_M,
  };
  f.vel.vx = tgt.vel.vx; f.vel.vy = tgt.vel.vy;
  return true;
}

export function releaseHold(state) {
  state.flight.hold = null;
}

/**
 * Keep the ship on its held offset for the current minute (after the
 * world has advanced). Returns the G the ship must burn to keep up.
 */
export function holdStep(state) {
  const h = state.flight.hold;
  if (!h) return 0;
  const tgt = targetStateAt(state, h, state.clock.minute, true);
  if (!tgt) { state.flight.hold = null; return 0; }
  const f = state.flight;
  f.pos.x = tgt.pos.x + h.ox / AU_M;
  f.pos.y = tgt.pos.y + h.oy / AU_M;
  f.vel.vx = tgt.vel.vx; f.vel.vy = tgt.vel.vy;
  const g = Math.hypot(tgt.ax, tgt.ay) / G0;
  if (g > 0) f.facing = Math.atan2(tgt.ay, tgt.ax);
  return g;
}

export function holdTargetName(state) {
  const h = state.flight.hold;
  return h ? targetName(state, h) : null;
}

/**
 * One minute of autopilot decision-making. Returns the flight command
 * (or null when not flying), and updates the display status.
 */
export function autopilotTick(state, emit = () => {}) {
  const ap = state.autopilot;
  if (!ap) return null;
  const now = state.clock.minute;
  const plan = ap.plan;
  const tgt = targetStateAt(state, plan.target, now, true);
  if (!tgt) {
    state.autopilot = null;
    emit('route-target-lost', {});
    return null;
  }

  if (ap.phase === 'prepare') {
    const st = crewSecureStatus(state);
    ap.display = 'prepare';
    ap.secure = { secured: st.secured, total: st.total, pilotReady: st.pilotReady, pilot: st.pilot?.name || null, helpless: st.helpless.length };
    const allIn = st.unsecured.length === 0;
    if ((st.pilotReady || !st.pilot) && (allIn || ap.override) || (ap.override && !st.pilot)) {
      ap.phase = 'active';
      ap.engagedAt = now;
      state.flight.hold = null;
      emit('route-engaged', { target: targetName(state, plan.target), unsecured: st.unsecured.map(m => m.name), override: ap.override && !allIn });
    } else {
      return null;
    }
  }

  const arrival = plan.kind === 'transfer' ? arrivalTarget(state, ap) : null;
  const g = guidanceStep(plan, state.flight, now, tgt, arrival);
  ap.d = g.d; ap.vClose = g.vClose; ap.relSpeed = g.relSpeed; ap.flipIn = g.flipIn;
  ap.display = g.phase;
  if (g.arrived) {
    const name = targetName(state, plan.target);
    const fuelUsed = ap.fuelStart - state.resources.fuel.current;
    state.autopilot = null;
    holdStation(state, plan.target);
    emit('route-arrived', { target: name, targetSpec: plan.target, minutes: now - (ap.engagedAt ?? now), fuelUsed, peakG: ap.peakG, missionId: ap.missionId, intercept: ap.intercept });
    return null;
  }
  return g.cmd;
}

function arrivalTarget(state, ap) {
  // Rails targets are exact; refresh a free target's predicted arrival point daily
  if (!ap.$arrival || state.clock.minute - (ap.$arrivalAt ?? -Infinity) >= DAY_MIN) {
    ap.$arrival = targetStateAt(state, ap.plan.target, ap.plan.arriveAt);
    ap.$arrivalAt = state.clock.minute;
  }
  return ap.$arrival;
}

/** Bookkeeping after the flight step (ignition times, peak G, flip display). */
export function autopilotAfterStep(state, out) {
  const ap = state.autopilot;
  if (!ap || ap.phase !== 'active') return;
  if (out.mainG > 0.05 && ap.ignitedAt == null) ap.ignitedAt = state.clock.minute;
  if (out.mainG <= 0.05) ap.ignitedAt = null;
  ap.peakG = Math.max(ap.peakG, out.mainG);
  if (Math.abs(out.turned) > 0.2) ap.display = ap.flipIn === 0 || ap.display === 'brake' ? 'flip' : 'orient';
}

// ---- POLICIES ----

/** Should the crew be in couches right now? */
export function crewPolicy(state) {
  if (state.combatStations) return 'secure';
  const f = state.flight;
  if (f.thrustG > 1.5 || (f.hold && holdBurnG(state) > 1.5)) return 'secure';
  if (f.manual && f.manual.throttleG > 1.5) return 'secure';
  const ap = state.autopilot;
  if (!ap) return 'free';
  if (ap.phase === 'prepare') return 'secure';
  if (ap.plan.accelG > 1.5 && (ap.display === 'burn' || ap.display === 'brake' || ap.display === 'transfer-burn')) return 'secure';
  if (ap.display === 'flip' || ap.display === 'orient') return 'secure';
  if (ap.flipIn <= 30) return 'secure';                               // re-secure ahead of the flip
  if (ap.ignitedAt != null && state.clock.minute - ap.ignitedAt < 10) return 'secure';  // settle into the burn
  if (ap.display === 'approach' && ap.d != null && ap.d < 50_000_000) return 'free';
  return 'free';
}

function holdBurnG(state) {
  const h = state.flight.hold;
  if (!h || h.kind !== 'entity') return 0;
  const e = getWorld(state).get(h.id);
  return e && !e.orbit ? (e.thrust || 0) : 0;
}

/** KSP-style time warp limits: fast-forward only through quiet stretches. */
export function maxSpeed(state) {
  if (state.combatStations) return 1;
  const ap = state.autopilot;
  const f = state.flight;
  if (f.manual && f.manual.throttleG > 0) return 1;
  if (!ap) return 3;
  if (ap.phase === 'prepare') return 1;
  if (ap.display === 'flip' || ap.display === 'orient') return 1;
  if (ap.flipIn <= 15) return 1;
  if (ap.ignitedAt != null && state.clock.minute - ap.ignitedAt < 5) return 1;
  const eta = ap.vClose > 1 && ap.d != null ? (ap.d - ap.plan.standoff) / ap.vClose / 60 : Infinity;
  if (ap.display === 'approach' || eta < 45) return 1;
  if (f.thrustG > 0.05) return 2;
  if (ap.flipIn > 6 * 60 && eta > 12 * 60) return 3;
  return 2;
}

