// ============================================================
// LONGHAUL — Stances: keeping a place relative to a target
//
// A route ends when the ship arrives. A stance is a standing order to keep
// a relation to something (a ship, a station, a body) until it is
// released. It is flown minute by minute through the same flight model and
// closing law as a route, and it rides on the autopilot (autopilot.js): it
// waits for the crew to secure, is hand-flown when the flight computer is
// down, and shows in the route status. Three orders:
//   HOLD         keep station at a range, on the bearing we settle on.
//                The hold is flown, not pinned: holding off a ship under
//                thrust means burning with it, and a ship that out-turns us
//                shakes us loose until we catch up again.
//   KEEP OUT     never closer than the range.
//   KEEP WITHIN  never further than the range.
//
// MOVING. Getting into place is the closing law flown to the *stance
// point*: the point at the stance range on the line from the target to
// us. So the ship closes or opens straight along the line of sight and
// never crosses in front of the target. The point rides with the target,
// its thrust included.
//
// HOLDING. On the point, HOLD keeps it with a critically damped correction
// on RCS, on top of the target's own pull (which takes the drive when it is
// a ship under thrust). The band says how hard it tries. TIGHT is 0.5% of
// the range, at least 200 m. LOOSE is 10%, at least 1 km: corrections come
// slower and cheaper, and with a target that isn't thrusting the drive
// stays cold, so the hold shows no plume. Pushed out of three bands, the
// ship moves again.
//
// GUARDING. KEEP OUT and KEEP WITHIN keep the range inside a window: KEEP
// OUT between the range and twice it, KEEP WITHIN between half the range
// and the range. The order's own side is a hard limit: the range may come
// up to it no faster than the drive could stop it there (with the turn
// still to make). Short of it the guard throttles up smoothly, so a ship
// pulling away is matched with a growing share of its thrust rather than
// chased in bursts. The far side only stops the ship drifting on (out of
// sight to KEEP OUT, past the target to KEEP WITHIN). KEEP WITHIN also
// keeps up with the target's pull across the line of sight, which would
// otherwise carry it out of range sideways; KEEP OUT has no need to. Well
// outside the window, the ship moves to the stance point like HOLD.
//
// DOCTRINE (stanceDoctrine, which needs the world). With a torpedo inbound,
// the ship closes on the target no faster than 5 km/s: every m/s of closing
// speed is added to the enemy's torpedoes. With a fire-control computer
// that plots the threat axis (TL2 and up), it also turns away and burns from
// any torpedo less than 45 minutes out, as the navies do (COMBAT.md), and
// resumes the stance once none is within the hour.
//
// RANGES (stanceRanges) come from what we carry and what the target is:
// formation, our guns or mining gear, a torpedo standoff outside guns and
// railguns, the long standoff where torpedoes are seen coming for an hour,
// and the edge of what our sensors hold of it.
// ============================================================

import { AU_M, G0, MIN_S, RANGE } from '../core/constants.js';
import { getWorld } from './world.js';
import { RCS_MAX_G, ALIGN_TOL } from './flight.js';
import { relativeState, pointFrom, closingLaw, keepLaw, flipSeconds, minutesToFlip, stopSpeed, ARRIVE_SPEED, BRAKE_MARGIN, TERMINAL_RANGE } from './guidance.js';
import { CLASSES, TECH } from './ship-classes.js';
import { PLAYER, profile } from './combatants.js';
import { inboundTo, timeToGo } from './ordnance.js';
import { isTracked, signatureRange, playerSensorQuality, contactById } from './sensors.js';
import { PDC, MINING_GEAR, RAIL_RANGE_M, FAST_VC, TORPEDO_MOTOR, COUNTER_BURN_S, UNDER_FIRE_CLOSE_MS } from './weapons.js';

export const STANCE_MODES = {
  hold: { label: 'HOLD', desc: 'Keep station at this range, on the bearing we settle on. Holding off a ship under thrust means burning with it.' },
  out: { label: 'KEEP OUT', desc: 'Never closer than this range. Burns away only when the range closes faster than the drive could stop it.' },
  within: { label: 'KEEP WITHIN', desc: 'Never further than this range. Burns toward it only when the range opens faster than the drive could stop it.' },
};

const COUNTER_BURN_END_S = 60 * 60;         // turned away from torpedoes, resume once none is within this
const RCS_A = RCS_MAX_G * G0;
const KEEP_T_MIN = 5 * MIN_S;               // the hold corrects no faster than this (the drive acts once a minute)
const EXIT_BANDS = 3;                       // pushed this many bands off the point, the ship moves again
const NEAR_M = 4 * TERMINAL_RANGE;          // 100 km: closer than this to the point, the keep law flies us in
const GUARD_SOFT_S = 10 * MIN_S;            // the guard closes on its limit over about this long
const GUARD_SLACK = 0.05;                   // a guard lets the range overshoot its limit by this share (or 3 bands) before moving back
const TORPEDO_STANCE_M = 50_000_000;        // 50,000 km: outside guns and railguns
const LONG_STANCE_M = 300_000_000;          // 300,000 km: torpedoes take an hour or more
const CLOSE_STANCE_M = 100_000_000;         // 100,000 km off a station or body
const FAR_STANCE_M = 0.1 * AU_M;            // 15M km: inside long-range sensors

/** How far off the stance point the hold lets the ship wander (m). */
export function stanceBand(rangeM, tight) {
  return tight ? Math.max(200, rangeM * 0.005) : Math.max(1_000, rangeM * 0.1);
}

/** The hold's time constant (s): an error of one band takes half the RCS to correct. */
const keepT = (band) => Math.max(KEEP_T_MIN, Math.sqrt(band / (0.5 * RCS_A)));
/** Within this of the stance point (m) the keep law takes over from the closing law. */
const nearM = (band) => Math.max(NEAR_M, EXIT_BANDS * band);
/** Relative speed (m/s) slow enough to count as holding. */
const keepV = (band) => Math.max(ARRIVE_SPEED, band / (4 * keepT(band)));

/**
 * A stance plan for the autopilot.
 * opts: { mode ('hold'|'out'|'within'), rangeM, accelG, tight, evade, slow, name, label }
 *   evade: turn away from close torpedoes · slow: close no faster than 5 km/s under fire
 */
export function createStance(target, opts) {
  return {
    kind: 'stance', stage: 'stance',
    target: { kind: target.kind, id: target.id },
    mode: STANCE_MODES[opts.mode] ? opts.mode : 'hold',
    standoff: opts.rangeM,
    accelG: opts.accelG,
    cruise: null,
    tight: opts.tight !== false,
    evade: opts.evade !== false,
    slow: opts.slow !== false,
    arriveAt: null,
    name: opts.name || STANCE_MODES[opts.mode]?.label || 'HOLD',
    label: opts.label || '',
  };
}

const _rel = {};
const _cl = {};

/**
 * One minute of a stance. tgt is the target's state now (nav.targetStateAt).
 * p: { aMax (m/s²), slew (rad/min), dtSec }
 * Returns the guidanceStep shape: { cmd, arrived, phase, flipIn, d, dEff,
 * vClose, relSpeed } plus `range` (m to the target itself) and `settled`.
 * `arrived` is `settled` (the plan simulator stops there); the autopilot
 * keeps flying. d, vClose and relSpeed are measured to the stance point.
 */
export function stanceStep(plan, flight, tgt, p) {
  const R = plan.standoff, band = stanceBand(R, plan.tight);
  const dt = p.dtSec;
  // The line of sight, target to us
  const rx = (flight.pos.x - tgt.pos.x) * AU_M, ry = (flight.pos.y - tgt.pos.y) * AU_M;
  const range = Math.hypot(rx, ry);
  let bx, by;
  if (plan.mode === 'hold' && plan.$bearing) ({ x: bx, y: by } = plan.$bearing);
  else if (range > 1) { bx = rx / range; by = ry / range; }
  else ({ x: bx, y: by } = plan.$bearing || { x: 1, y: 0 });

  // The stance point rides with the target: its velocity, its pull
  const rel = relativeState(flight, pointFrom(tgt, bx, by, R), _rel);
  const res = { cmd: { ax: 0, ay: 0, maxG: plan.accelG, lean: true }, arrived: false, settled: false, phase: 'coast', flipIn: Infinity, d: rel.d, dEff: rel.d, vClose: rel.vClose, relSpeed: rel.speed, range };

  const vTol = keepV(band);
  const onPoint = rel.d <= band && rel.speed <= vTol;
  // Is the ship where the order wants it? (KEEP OUT / WITHIN: inside the allowed range)
  if (plan.mode === 'hold') {
    if (plan.$holding && (rel.d > EXIT_BANDS * band || rel.speed > EXIT_BANDS * vTol)) plan.$holding = false;
    if (!plan.$holding && onPoint) { plan.$holding = true; plan.$bearing = { x: bx, y: by }; }
    if (!plan.$holding) plan.$bearing = null;
  } else {
    // Well past the order's limit, move back to the stance point; once inside
    // the window, the guard takes over (it handles a small overshoot itself)
    const slack = Math.max(EXIT_BANDS * band, GUARD_SLACK * R);
    const outside = plan.mode === 'out' ? range < R - slack : range > R + slack;
    if (outside) plan.$moving = true;
    else if (plan.$moving && (onPoint || (plan.mode === 'out' ? range >= R : range <= R))) plan.$moving = false;
    plan.$holding = !plan.$moving;
  }

  if (!plan.$holding && rel.d <= nearM(band)) {
    // Close to the point but not on it: the keep law brings us in from any state
    keepLaw(rel, { aMax: p.aMax, facing: flight.facing, slew: p.slew, dtSec: dt, settled: false }, _cl);
    res.cmd.ax = _cl.ax; res.cmd.ay = _cl.ay;
    if (_cl.face != null) res.cmd.face = _cl.face;
    res.phase = 'approach';
    plan.$memo = null;
    return res;
  }
  if (!plan.$holding) {
    // Moving: the closing law to the stance point. Under fire, it closes on the
    // target slowly (when the point lies between us and the target)
    const cruise = plan.$underFire && plan.slow && range > R ? UNDER_FIRE_CLOSE_MS : plan.cruise ?? Infinity;
    const cl = closingLaw(rel, { aMax: p.aMax, standoff: 0, cruise, facing: flight.facing, slew: p.slew, dtSec: dt, memo: plan.$memo ??= {} }, _cl);
    res.cmd.ax = cl.ax; res.cmd.ay = cl.ay;
    if (cl.face != null) res.cmd.face = cl.face;
    const mag = Math.hypot(cl.ax, cl.ay);
    const along = cl.ax * rel.ux + cl.ay * rel.uy;
    res.phase = cl.dEff < 1e7 && mag < 0.05 * G0 ? 'approach' : mag < 0.002 * G0 ? 'coast' : along >= 0 ? 'burn' : 'brake';
    if (res.phase === 'coast' || res.phase === 'burn') res.flipIn = minutesToFlip(rel, p.aMax, 0, cruise, flight.facing);
    return res;
  }
  plan.$memo = null;
  res.settled = res.arrived = true;
  if (plan.mode === 'hold') keep(rel, band, flight, p, res);
  else guard(plan, rel, range, R, bx, by, flight.facing, p, res);
  return res;
}

/** HOLD on the point: the keep law, settled (RCS corrections; the drive only carries the target's pull). */
function keep(rel, band, flight, p, res) {
  keepLaw(rel, { aMax: p.aMax, facing: flight.facing, slew: p.slew, dtSec: p.dtSec, settled: true, T: keepT(band) }, _cl);
  res.cmd.ax = _cl.ax; res.cmd.ay = _cl.ay;
  if (_cl.face != null) res.cmd.face = _cl.face;
  res.phase = 'holding';
}

/**
 * KEEP OUT / KEEP WITHIN inside their window (or just past its limit).
 * b is the line of sight from the target to us; the range rate is + opening.
 */
function guard(plan, rel, range, R, bx, by, facing, p, res) {
  const out = plan.mode === 'out';
  const dt = p.dtSec;
  const rate = rel.dvx * bx + rel.dvy * by;
  const pull = -(rel.ffx * bx + rel.ffy * by);          // what the target's pull does to the range rate
  // The burn (along b, + away from the target) that keeps one side of the
  // window: `toward` is +1 when that side lies further out than us. `soft`
  // throttles up short of the limit instead of waiting for the curve.
  const side = (limit, toward, soft) => {
    const m = toward * (limit - range);                 // distance left to the limit (< 0: past it)
    const v = toward * rate;                            // speed toward it
    const f = toward * pull;                            // the pull, toward it
    const aR = Math.max(RCS_A, BRAKE_MARGIN * p.aMax - f);
    const F = flipSeconds(facing, toward * bx, toward * by, p.slew);   // the turn to burn away from it
    const vAllow = m >= 0 ? stopSpeed(m, v, aR, F, dt)
      : soft ? -Math.sqrt(0.5 * RCS_A * -m) : 0;          // past the hard limit, come back gently
    let burn = (v - vAllow) / dt + f;
    if (soft) burn = Math.max(burn, (v - 0.5 * vAllow) / GUARD_SOFT_S + f);
    // (ready to burn: closing on the curve that allows a whole flip, wherever the nose is now)
    const ready = m >= 0 && v > 0.35 * stopSpeed(m, v, aR, (Math.PI - ALIGN_TOL) / p.slew * MIN_S, dt);
    return { burn: Math.max(0, Math.min(p.aMax, burn)), ready, dir: -toward };
  };
  // the order's own limit, then the far side of the window
  const hard = out ? side(R, -1, true) : side(R, +1, true);
  const far = out ? side(2 * R, +1, false) : side(0.5 * R, -1, false);
  const g = hard.burn > 0 ? hard : far;
  let ax = g.dir * g.burn * bx, ay = g.dir * g.burn * by;
  if (!out) {
    // KEEP WITHIN keeps up with the target across the line of sight, and
    // trims sideways drift on RCS
    const hS = -rel.ffx * by + rel.ffy * bx;
    const vS = -rel.dvx * by + rel.dvy * bx;
    const cS = Math.max(-RCS_A, Math.min(RCS_A, -vS / GUARD_SOFT_S));
    ax += -(hS + cS) * by; ay += (hS + cS) * bx;
  }
  res.cmd.ax = ax; res.cmd.ay = ay;
  if (g.burn > 0.002 * G0) {
    res.cmd.face = Math.atan2(ay, ax);
    res.phase = 'guard';
  } else if (hard.ready) {
    // getting close to the limit: turn to the burning attitude ahead of time
    res.cmd.face = Math.atan2(hard.dir * by, hard.dir * bx);
    res.phase = 'ready';
  } else {
    res.phase = 'watch';
  }
}

/**
 * What the tactical picture asks of a stance this minute (world-aware, so it
 * lives apart from stanceStep): `underFire` when a torpedo we track is
 * inbound, and `evadeFrom`, the position of the torpedo to turn away from
 * when doctrine and the ship's fire control call for it.
 */
export function stanceDoctrine(state, plan) {
  let nearest = null, eta = Infinity, any = false;
  for (const o of inboundTo(state, PLAYER)) {
    if (o.ord.kind !== 'torpedo' || !isTracked(state, o.id)) continue;
    any = true;
    const t = timeToGo(state, o);
    if (t < eta) { eta = t; nearest = o; }
  }
  const tl = state.ship.tl || CLASSES[state.ship.classId]?.tl || 2;
  const canCounter = plan.evade && TECH[tl].counterBurn;
  // (once turned away, keep running until none is within the hour)
  const evading = canCounter && nearest && eta < (plan.$evading ? COUNTER_BURN_END_S : COUNTER_BURN_S);
  plan.$evading = !!evading;
  return { underFire: any, evadeFrom: evading ? nearest.pos : null, eta };
}

// ---- RANGES ----

/**
 * The stance ranges worth offering against a target: what our weapons need,
 * what keeps us outside theirs, and what our sensors can hold. Each is
 * { key, label, m, desc, warn? }, nearest first. `rangeNowM` is the range now.
 */
export function stanceRanges(state, target, rangeNowM) {
  const out = [];
  const add = (key, label, m, desc, warn = '') => out.push({ key, label, m: Math.round(m), desc, warn });
  const e = target.kind === 'entity' ? getWorld(state).get(target.id) : null;
  if (e?.type !== 'ship') {
    if (rangeNowM != null) add('here', 'HERE', rangeNowM, 'Keep the range we have now.');
    add('close', 'CLOSE', CLOSE_STANCE_M, 'Inside every sensor band, outside traffic control.');
    add('far', 'FAR', FAR_STANCE_M, 'Inside long-range sensors and radio.');
    return out.sort((a, b) => a.m - b.m);
  }
  const p = profile(state, PLAYER);
  const tl = p.tl;
  // What it carries, if we know its class
  const contact = contactById(state, e.id);
  const known = !!contact?.name || (!contact && e.transponder);
  const c = known ? CLASSES[e.cls] : null;
  const theirTL = c ? c.tl : null;
  const theirGuns = c ? (c.pdc ? PDC[theirTL].strafeM : c.gear ? MINING_GEAR[c.gear.type].rangeM : 0) : null;
  const theirRail = c?.railgun ? RAIL_RANGE_M : 0;
  const km = (m) => `${Math.round(m / 1000).toLocaleString()} km`;
  const inGuns = (m) => theirGuns != null && theirGuns >= m ? 'Their guns reach us here too.' : '';

  add('board', 'FORMATION', RANGE.FORMATION_M, 'Alongside: boarding, tow, EVA.', inGuns(RANGE.FORMATION_M));
  if (p.cls.pdc > 0) {
    const m = Math.round(0.6 * p.pdc.strafeM / 100) * 100;
    add('guns', 'GUNS', m, `Inside our PDC reach (${km(p.pdc.strafeM)}): on ENGAGE they rake the hull.`, inGuns(m));
  }
  if (p.gear) {
    const m = Math.round(0.6 * p.gear.rangeM / 100) * 100;
    add('gear', 'GEAR', m, `Inside the reach of our ${p.gear.name} (${km(p.gear.rangeM)}).`, inGuns(m));
  }
  if (p.cls.tubes > 0) {
    const m = Math.max(TORPEDO_STANCE_M, 1.5 * theirRail);
    const vc = FAST_VC[tl], a = TORPEDO_MOTOR[tl].maxG * G0;
    const flight = Math.round((m / vc + vc / (2 * a)) / 60);
    add('torpedo', 'TORPEDO', m, `Outside guns${theirRail ? ' and their railgun' : ' and railguns'}. A FAST torpedo takes about ${flight} min.`);
  }
  {
    const tlT = theirTL ?? 2;
    const hours = (LONG_STANCE_M / FAST_VC[tlT] / 3600).toFixed(1);
    add('long', 'LONG', LONG_STANCE_M, `Their FAST torpedoes take ${hours} h and show their plumes long before. Ours can go COLD COAST.`);
  }
  // The edge of what we hold of it (its signature as it is now)
  const hold = Math.min(signatureRange(e) * playerSensorQuality(state), RANGE.LONG) * AU_M;
  if (hold > 1.25 * LONG_STANCE_M) {
    const seen = RANGE.LONG * TECH[theirTL ?? 2].sensors * AU_M;
    add('shadow', 'SHADOW', 0.8 * hold, `The edge of our sensors on it. Hold LOOSE and the drive stays cold; lit, it shows our plume${seen > 0.8 * hold ? ` (they see a drive out to ${km(seen)})` : ''}.`,
      e.thrust > 0 || e.transponder ? 'If it goes cold we lose it.' : '');
  }
  if (rangeNowM != null) add('here', 'HERE', rangeNowM, 'Keep the range we have now.', inGuns(rangeNowM));
  return out.sort((a, b) => a.m - b.m);
}
