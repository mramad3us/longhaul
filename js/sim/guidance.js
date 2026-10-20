// ============================================================
// LONGHAUL — Guidance laws (pure functions)
//
// CLOSING LAW — rendezvous with a moving target, closed loop.
//   Work in the target's frame. Command the relative velocity that
//   points at the stop point with the largest speed we can still
//   brake from, capped by an optional cruise speed. That yields a
//   burn → flip → brake brachistochrone from rest, cancels sideways
//   drift and follows the target's own acceleration every minute.
//   What keeps it tidy (tests/guidance.test.mjs holds it to that):
//   - Whole-step braking. The drive acts once a minute, and at 10G a
//     minute sheds 5.9 km/s. The braking curve is built from whole
//     steps that end exactly on the mark, and each step aims at where
//     the curve will be when the step ends.
//   - Committed flips. One curve says when the ship must brake (with
//     the turn still to make), a second when it may burn (as if a
//     whole flip were still ahead), and between them it coasts. A
//     ship mid-flip finishes it, and a ship in braking attitude turns
//     back only for a real shortfall.
//   - The hold turn. Holding on a target that pulls with more than RCS
//     can match (a ship under thrust, a station circling a moon) takes
//     the drive, so the brake ends with a planned turn into that
//     attitude: a swing with the drive idle while the target's own pull
//     brakes us, or a sweep with the drive lit, like a gravity turn.
//   - Swings by period. A station circling a moon, and the moon circling
//     its planet, are followed only once the time to go is short against
//     their period; till then they are planned against at their worst.
//   - The drive is shared sideways first (keeping up with the target,
//     plus room to correct drift), and when that takes much of it the
//     flip is a lit sweep through the pull's direction.
//   - No turn that isn't meant: commands are kept to what the drive can
//     lean to with the nose where it is, and the attitude to hold is
//     passed to the flight step alongside the thrust.
//   - The last 25 km are flown on RCS (with the drive's lean when
//     holding takes it) unless we come in too fast or drifting.
//
// KEEP LAW — onto a point and kept there, from any state.
//   The closing law plans a long approach and has nothing to fall back
//   on near the end if the ship is off that plan (or starts there, the
//   nose any which way, the target pulling hard). The keep law plans
//   nothing: each minute, the fastest speed toward the point the ship
//   can still stop from (on RCS, or on the drive after the turn it
//   would need), a burn only below the curve that allows for a whole
//   flip, and the target frame's pull passed through. Settled, a
//   critically damped pull back on RCS. It flies stances (stance.js),
//   and the near zone of routes the closing law can't plan (nav.js).
//
// TRANSFER LAW — fuel-cheap ballistic arc.
//   Solve Lambert from the ship to where the target will be at the
//   planned arrival time, burn to that velocity, coast, re-solve
//   periodically for small corrections; hand over to the closing law
//   once braking is due.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { solarGravity } from './ephemeris.js';
import { solveLambert } from './lambert.js';
import { RCS_MAX_G, SLEW_RATE, ALIGN_TOL, LEAN_MAX, angleDiff } from './flight.js';

export const BRAKE_MARGIN = 0.85;     // plan braking at 85% of available thrust
export const ARRIVE_SPEED = 3;        // m/s relative — "stopped"

const _gs = { ax: 0, ay: 0 };
const _gt = { ax: 0, ay: 0 };

const NO_SWINGS = [];

/**
 * Relative state of a target as seen from the ship.
 * target: { pos:{x,y} AU, vel:{vx,vy} m/s, ax?, ay? (target's own thrust, m/s²),
 *          atx?, aty? (target's total acceleration, for rails/moon targets),
 *          swings? ([{vx, vy, ax, ay, period}]: the periodic parts of a rails
 *          target's motion, see nav.targetStateAt) }
 */
export function relativeState(flight, target, out = {}) {
  const dx = (target.pos.x - flight.pos.x) * AU_M;
  const dy = (target.pos.y - flight.pos.y) * AU_M;
  const d = Math.hypot(dx, dy);
  const dvx = flight.vel.vx - target.vel.vx;   // ship relative to target
  const dvy = flight.vel.vy - target.vel.vy;
  solarGravity(flight.pos.x, flight.pos.y, _gs);
  solarGravity(target.pos.x, target.pos.y, _gt);
  out.dx = dx; out.dy = dy; out.d = d;
  out.ux = d > 0 ? dx / d : 0;
  out.uy = d > 0 ? dy / d : 0;
  out.dvx = dvx; out.dvy = dvy;
  out.speed = Math.hypot(dvx, dvy);
  out.vClose = dvx * out.ux + dvy * out.uy;    // > 0: closing
  // feed-forward: how the target's frame accelerates relative to free fall at our position.
  // Rails/moon targets supply their total acceleration; free ones = gravity + own thrust.
  if (target.atx != null) {
    out.ffx = target.atx - _gs.ax;
    out.ffy = target.aty - _gs.ay;
  } else {
    out.ffx = (_gt.ax - _gs.ax) + (target.ax || 0);
    out.ffy = (_gt.ay - _gs.ay) + (target.ay || 0);
  }
  out.swings = target.swings || NO_SWINGS;
  return out;
}

/**
 * A target's state moved `m` metres along (ux, uy): the stance point, or a
 * route's stop point (the standoff on the line of sight, m < 0 toward us).
 */
export function pointFrom(tgt, ux, uy, m) {
  const P = { pos: { x: tgt.pos.x + ux * m / AU_M, y: tgt.pos.y + uy * m / AU_M }, vel: tgt.vel, ax: tgt.ax || 0, ay: tgt.ay || 0, swings: tgt.swings };
  if (tgt.atx != null) { P.atx = tgt.atx; P.aty = tgt.aty; }
  return P;
}

// Terminal zone: the last stretch is flown on RCS alone (no drive, no flips).
export const TERMINAL_RANGE = 25_000;                 // m
const RCS_A = RCS_MAX_G * G0;
const RCS_PLAN_A = RCS_A * 0.7;                       // plan RCS braking with margin
// With the drive lit, the nose follows a turning thrust at most this fast:
// the drive fires only within ALIGN_TOL of the nose, so a slow sweep keeps
// it lit nearly the whole minute
const SWEEP_DRIVE = 8 * Math.PI / 180;               // rad per minute
// Sideways drift is taken out within this long (see closingLaw)
const LATERAL_MAX_S = 3600;
// ...and the hold turn is planned a little slower, so that a ship behind or
// ahead of the plan can catch up by turning faster or slower
const SWEEP_PLAN = 6 * Math.PI / 180;
// A target frame pulling harder than this can't be held on RCS: holding on
// it takes the drive, and the ship must finish in that attitude
const HOLD_RCS_A = RCS_A * 0.8;
// A nominal flip, burn attitude to braking attitude (flip countdowns)
const FULL_FLIP_S = (Math.PI - ALIGN_TOL) / SLEW_RATE * MIN_S;

/** Seconds the drive stays cold while the nose swings from `facing` to `toward`. */
function turnSeconds(facing, toward, slew) {
  return Math.max(0, Math.abs(angleDiff(toward, facing)) - ALIGN_TOL) / slew * MIN_S;
}

/**
 * Seconds the drive stays cold while the nose swings from `facing` to the
 * braking attitude (pointing away from the target along −u).
 */
export function flipSeconds(facing, ux, uy, slew = SLEW_RATE) {
  return turnSeconds(facing, Math.atan2(-uy, -ux), slew);
}

/**
 * The fastest we can be going D metres before a mark and still pass it at vT,
 * braking at up to `a` in whole steps. The drive acts once a minute, and at
 * 10G one minute takes 5.9 km/s off. So the continuous curve √(vT² + 2aD)
 * can't be flown exactly in its last minute: the ship stops partway through
 * the step and reverses. This curve brakes in full steps, then one partial
 * step that ends exactly on the mark. For long distances it is the continuous
 * curve.
 */
function stepStopSpeed(D, a, vT, dt) {
  const Ddt = Math.max(0, D) / dt;
  if (Ddt <= vT) return 2 * Ddt - vT;                // one step from here to the mark
  const s = a * dt;                                  // speed shed by one full step
  // m full steps then a last step shedding w (0..s): D/dt = (m+1)·vT + (m+½)·w + s·m²/2
  const m = Math.floor((-vT + Math.sqrt(vT * vT + 2 * s * (Ddt - vT))) / s);
  const w = Math.min(s, (Ddt - (m + 1) * vT - s * m * m / 2) / (m + 0.5));
  return vT + w + m * s;
}

// The drive hands over to RCS at the terminal boundary at the speed RCS can still stop from
const TERMINAL_V = stepStopSpeed(TERMINAL_RANGE, RCS_PLAN_A, 0, MIN_S);   // ≈ 80 m/s

const rcsCurve = (dEff, dt) => stepStopSpeed(dEff, RCS_PLAN_A, 0, dt);

/**
 * Drive braking curve: the max closing speed dEff from the stop point that
 * still passes the handover (Dh from the stop point) at vh, braking at a
 * relative to the target. The nose must first finish turning (flipSec of
 * cold drive), and meanwhile the target's own pull f along the line of
 * sight changes the closing speed by −f per second.
 */
function driveCurve(dEff, a, flipSec, f, Dh, vh, dt) {
  const D = dEff - Dh;
  if (D <= 0) return -Infinity;
  if (flipSec <= 0) return stepStopSpeed(D, a, vh, dt);
  // the coast, sized with the continuous curve: (v − fF)² − vh² = 2a(D − vF + ½fF²)
  const F = flipSec, b = (a - f) * F;
  const vc = -b + Math.sqrt(Math.max(0, b * b - f * f * F * F + vh * vh + 2 * a * D + a * f * F * F));
  return stepStopSpeed(D - vc * F + 0.5 * f * F * F, a, vh, dt) + f * F;
}

/** Braking curve at the planning margin, for a target with no pull of its own (route checks, flip countdowns). */
export function brakingSpeed(dEff, aMax, flipSec, cruise = Infinity, dtSec = MIN_S) {
  const v = Math.max(rcsCurve(dEff, dtSec), driveCurve(dEff, BRAKE_MARGIN * aMax, flipSec, 0, TERMINAL_RANGE, TERMINAL_V, dtSec));
  return Math.min(cruise, v);
}

/**
 * The speed toward a mark `d` metres off to hold at the end of this step so
 * that the ship can still stop on it: braking at `a` on the drive after
 * `turnSec` of cold turn, or on RCS. Whole steps, aimed ahead (as the closing
 * law's curves). v0: the speed toward it now.
 */
export function stopSpeed(d, v0, a, turnSec, dtSec = MIN_S) {
  return aimSpeed((x) => Math.max(rcsCurve(x, dtSec), driveCurve(x, a, turnSec, 0, 0, 0, dtSec)), d, v0, dtSec);
}

/**
 * The closing speed to hold at the END of this step so that the ship sits on
 * `curve` there. The drive acts once a minute and a step at 10G covers
 * hundreds of km, so aiming at the curve where we are now would lag it.
 * Solves v1 = curve(d − (v0 + v1)·dt/2) by bisection (the right side falls as
 * v1 rises). If even stopping dead overshoots, return the speed that lands
 * exactly on the stop point.
 */
function aimSpeed(curve, dEff, v0, dtSec) {
  if (dEff - Math.max(0, v0) * dtSec / 2 <= 0) return 2 * dEff / dtSec - v0;
  let lo = 0, hi = Math.max(0, curve(dEff));
  for (let i = 0; i < 24 && hi - lo > 0.05; i++) {
    const mid = (lo + hi) / 2;
    if (curve(dEff - (v0 + mid) * dtSec / 2) >= mid) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * The hold turn. Holding on a target whose frame pulls with H (a ship under
 * thrust, a station circling a moon) takes the thrust T = H. If that is more
 * than RCS can give, the ship must end the approach with its nose along H.
 * Braking ends with T = H + w·b, where w is the relative deceleration along b
 * (away from the target), so the end of the brake brings w down from full
 * (aR) to nothing while the nose comes round from the braking thrust to H.
 * There are two ways round:
 * - Swing. When T passes within reach of RCS on the way (H has little
 *   sideways part), idle the drive at the w where T is least, let RCS give
 *   that, and swing the nose round at full rate. The relative deceleration meanwhile is the target's
 *   own pull. Chasing a ship that accelerates away is this case: we turn
 *   nose-on while its thrust does the braking.
 * - Sweep. Otherwise walk w down a minute at a time, as fast as the nose can
 *   follow T with the drive lit (SWEEP_DRIVE a minute).
 * `keep` is the kind of a turn already under way (true: swing, false: sweep).
 * `drift` is how fast (rad/min) the holding attitude itself turns (a station
 * circling a moon swings its pull round): the turn is paced for what's left.
 * Returns { ws: per-minute decelerations, swing }, or null when no turn is
 * needed (the pull is RCS-sized, or braking already points the nose along it).
 */
function holdTurn(Hx, Hy, bx, by, aR, slew, keep = null, drift = 0) {
  if (Math.hypot(Hx, Hy) <= HOLD_RCS_A) return null;
  const angOf = (w) => Math.atan2(Hy + w * by, Hx + w * bx);
  const hold = Math.atan2(Hy, Hx);
  const span = Math.abs(angleDiff(angOf(aR), hold));
  if (span <= SWEEP_DRIVE) return null;
  const wMin = Math.max(0, Math.min(aR, -(Hx * bx + Hy * by)));   // where T is least
  const side = Math.abs(Hx * by - Hy * bx);
  // (a turn under way keeps its kind: the pull's sideways part can hover at
  // the line as a station orbits, and switching mid-turn would stall it)
  if (keep !== false && wMin > 0 && side <= (keep ? 1.5 : 0.9) * RCS_A) {
    const n = Math.ceil((span - SWEEP_DRIVE) / (0.9 * slew - drift));
    return { ws: new Array(n).fill(wMin), swing: true };
  }
  const ws = [];
  let w = aR, nose = angOf(aR);
  const pace = Math.max(SWEEP_PLAN / 3, SWEEP_PLAN - drift);
  for (let k = 0; k < 90 && Math.abs(angleDiff(hold, nose)) > pace; k++) {
    // the furthest down the brake the nose can follow this minute with the
    // drive lit (T's direction turns monotonically as w falls)
    const reach = (x) => Math.abs(angleDiff(angOf(x), nose)) <= pace;
    let lo = 0, hi = w;
    if (reach(0)) hi = 0;
    else for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (reach(mid)) hi = mid; else lo = mid; }
    w = hi;
    nose = angOf(w);
    ws.push(w);
  }
  return ws.length ? { ws, swing: false } : null;
}

/**
 * The part of the thrust (ax, ay) the ship can give without turning away
 * from `axis`: the drive along it (never backwards), leaning up to `lean`
 * off it, and RCS for the rest in any direction. `face` is the attitude to
 * ask for: where the drive then points, if it is doing real work.
 */
function withinCone(ax, ay, axis, aMax, lean = SWEEP_DRIVE) {
  const nx = Math.cos(axis), ny = Math.sin(axis);
  const along = Math.max(0, Math.min(aMax, ax * nx + ay * ny));
  const lim = along * Math.tan(lean);
  const across = Math.max(-lim, Math.min(lim, -ax * ny + ay * nx));
  const dx = along * nx - across * ny, dy = along * ny + across * nx;   // the drive, leaning
  let rx = ax - dx, ry = ay - dy;
  const rm = Math.hypot(rx, ry), k = rm > 0.95 * RCS_A ? 0.95 * RCS_A / rm : 1;
  return { x: dx + rx * k, y: dy + ry * k, face: along > RCS_A ? Math.atan2(dy, dx) : axis };
}

/**
 * Hold turn as a speed table, built back from the terminal handover: the turn
 * starts D[0] before it at V[0]. Segment k (D[k+1]..D[k]) decelerates at ws[k].
 */
function turnTable(ws, dt) {
  const n = ws.length;
  const D = new Array(n + 1), V = new Array(n + 1);
  D[n] = 0; V[n] = TERMINAL_V;
  for (let k = n - 1; k >= 0; k--) {
    V[k] = V[k + 1] + ws[k] * dt;
    D[k] = D[k + 1] + (V[k] + V[k + 1]) / 2 * dt;
  }
  return { ws, D, V, n };
}

function turnSpeed(t, D) {
  for (let k = t.n - 1; k >= 0; k--) {
    if (D <= t.D[k]) return Math.sqrt(t.V[k + 1] * t.V[k + 1] + 2 * t.ws[k] * Math.max(0, D - t.D[k + 1]));
  }
  return t.V[0];
}

/**
 * How much of a periodic swing (a station circling a moon, a moon circling
 * its planet) to follow with `ttg` seconds to go. Over many periods it
 * averages out, so a fast swing is ignored far out and followed fully once
 * the time to go is down to a quarter period.
 */
function swingShare(period, ttg) {
  return Math.max(0, Math.min(1, (period - ttg) / (0.75 * period)));
}

/**
 * Closing law. Writes desired non-grav accel (m/s²) into out.ax/out.ay, and
 * the attitude to hold while the drive is idle into out.face (or null).
 * p: { aMax (m/s²), standoff (m), cruise (m/s), facing (rad), slew (rad/min), dtSec,
 *      memo (an object kept with the plan: what the law must remember) }
 *
 * Along the line of sight the closing speed is bounded by two curves:
 *   braking curve — computed with the turn the nose still has to make. Above
 *     it the ship must brake.
 *   burning curve — computed as if a whole flip were still ahead. Below it the
 *     ship may burn toward the target.
 * Between them it coasts. A ship halfway through its flip therefore finishes
 * the flip instead of turning back because the curve moved. Once in braking
 * attitude, it never swings round to close faster unless it has really fallen
 * short.
 *
 * Each curve is a full brake (at what the drive can spare after keeping up
 * with the target's sideways pull), then the hold turn into the attitude that
 * holding on the target takes, then the RCS terminal.
 */
export function closingLaw(rel, p, out = {}) {
  const dt = p.dtSec;
  const slew = p.slew ?? SLEW_RATE;
  const dEff = Math.max(0, rel.d - p.standoff);
  const cruise = p.cruise ?? Infinity;
  const { ux, uy } = rel;
  const aMax = Math.max(RCS_A, p.aMax);

  // The target frame as we will fly against it: swings faster than the time
  // to go are left out (and budgeted for, since they will be followed later)
  const ttg = Math.min(dEff / Math.max(rel.vClose, 1), 2 * Math.sqrt(dEff / (BRAKE_MARGIN * aMax)));
  let dvx = rel.dvx, dvy = rel.dvy, Hx = rel.ffx, Hy = rel.ffy, reserve = 0;
  let dHx = 0, dHy = 0;                                  // how the pull followed changes in a minute
  for (const sw of rel.swings) {
    const follow = swingShare(sw.period, ttg), ignore = 1 - follow;
    const r = 2 * Math.PI * MIN_S / sw.period, cr = Math.cos(r) - 1, sr = Math.sin(r);
    dHx += follow * (sw.ax * cr - sw.ay * sr); dHy += follow * (sw.ax * sr + sw.ay * cr);
    const a = Math.hypot(sw.ax, sw.ay);
    // a swing followed is steady only over the last twelfth of its period
    // (30° of turn); before that its pull will come round, so the braking
    // plan takes it at its worst, not at what it happens to be now
    const unsteady = follow * Math.max(0, Math.min(1, 12 * ttg / sw.period));
    reserve += ignore * a + unsteady * (sw.ax * ux + sw.ay * uy + a);
    if (ignore <= 0) continue;
    dvx += ignore * sw.vx; dvy += ignore * sw.vy;
    Hx -= ignore * sw.ax; Hy -= ignore * sw.ay;
  }
  const v0 = dvx * ux + dvy * uy;                       // closing speed (> 0: closing)
  const f = Hx * ux + Hy * uy;                          // the target's pull along the line of sight (+: away from us)
  // Drive left along the line after keeping up sideways, and (when that
  // takes much of it) after keeping some in hand to correct sideways drift:
  // at speed, an uncorrected drift grows as the line of sight swings round
  const side = Math.sqrt(Math.max(0, Hx * Hx + Hy * Hy - f * f));
  const sideSpare = side > 0.25 * aMax ? (aMax - side) / 4 : 0;
  const aLine = Math.sqrt(Math.max(0, aMax * aMax - (side + sideSpare) ** 2));
  const aR = Math.max(RCS_PLAN_A, BRAKE_MARGIN * aLine + f - reserve);   // relative braking
  const aBurn = Math.max(RCS_A, aLine - f);             // relative acceleration toward it

  // Attitudes: braking thrust, burning thrust, holding thrust
  const angBrake = Math.atan2(Hy - aR * uy, Hx - aR * ux);
  const angBurn = Math.atan2(Hy + aBurn * uy, Hx + aBurn * ux);
  const holdDrive = Math.hypot(Hx, Hy) > HOLD_RCS_A;
  const closing = v0 > 0;
  // The flip. Normally a full-rate swing with the drive cold. But when keeping
  // up with the target's sideways pull takes much of the drive, the burning
  // and braking attitudes both lean toward that pull and lie less than 120°
  // apart. A cold flip would then drift a long way sideways, so the nose
  // sweeps from one to the other through the pull's direction with the drive
  // lit, like a lander tilting from one side to the other.
  const hS = -Hx * uy + Hy * ux;                        // the target frame's pull sideways
  const litFlip = Math.abs(hS) > 0.25 * aMax && Math.abs(angleDiff(angBurn, angBrake)) <= 2 * Math.PI / 3;
  const turnTime = (from, to) => litFlip ? Math.abs(angleDiff(to, from)) / SWEEP_PLAN * MIN_S : turnSeconds(from, to, slew);
  const fullFlip = turnTime(angBurn, angBrake);
  const flipSec = closing ? turnTime(p.facing, angBrake) : 0;
  // (closing speed meanwhile falls by the target's pull, or, sweeping lit,
  // by the average of burning and braking)
  const fFlip = litFlip ? (aR - aBurn) / 2 : f;
  const inBrake = Math.abs(angleDiff(angBrake, p.facing)) < Math.PI / 2;

  // The speed schedule: full brake → hold turn → RCS terminal
  const memo = p.memo || {};
  const holdDrift = Math.abs(angleDiff(Math.atan2(Hy + dHy, Hx + dHx), Math.atan2(Hy, Hx)));
  const hold = closing ? holdTurn(Hx, Hy, -ux, -uy, aR, slew, memo.swing ?? null, holdDrift) : null;
  const turn = hold && turnTable(hold.ws, dt);
  const Dh = TERMINAL_RANGE + (turn ? turn.D[0] : 0), vh = turn ? turn.V[0] : TERMINAL_V;
  // Short of the handover the curve never dips below the coasting curve: with
  // the drive cold the closing speed falls only by the target's own pull
  // (nothing, without one), and braking less than that would take a turn.
  const coastTo = (d) => Math.sqrt(vh * vh + 2 * Math.max(0, f) * (d - Dh));
  const curve = (F) => (d) => {
    const rcs = rcsCurve(d, dt);
    if (d <= TERMINAL_RANGE) return rcs;
    if (d <= Dh) return Math.max(rcs, turnSpeed(turn, d - TERMINAL_RANGE));
    return Math.max(rcs, coastTo(d), driveCurve(d, aR, F, fFlip, Dh, vh, dt));
  };
  const vBrake = Math.min(cruise, aimSpeed(curve(flipSec), dEff, v0, dt));
  // (a ship not yet closing, at rest or drifting away, will still have the
  // whole flip to make before it can brake: near the target a minute's burn
  // that forgets it is already more than the flip can stop)
  const vBurn = closing && flipSec >= fullFlip - 1 ? vBrake
    : Math.min(vBrake, cruise, aimSpeed(curve(fullFlip), dEff, v0, dt));
  // In braking attitude a small shortfall is not worth flipping back for
  // (coasting a few percent under the curve costs as many percent of the
  // time left, and the curve shifts a little as the geometry turns anyway),
  // nor is a cruise shortfall
  const vLow = closing && inBrake ? Math.min(vBurn, 0.97 * vBrake, 0.9 * cruise) : vBurn;
  const vAlong = v0 > vBrake ? vBrake : v0 < vLow ? vLow : v0;

  // The correction, in line-of-sight terms (l: 90° left of u). Along the line
  // the speed is met this step. Sideways drift only has to be gone well
  // before arrival, so it is taken out over a quarter of the time to go (a
  // steady lean through the burn rather than a lurch when the burn ends),
  // but within the hour, while the drive is lit anyway: left for the coast
  // it would be trimmed off on RCS, at twelve times the reaction mass.
  const vSide = -dvx * uy + dvy * ux;
  let cA = (vAlong - v0) / dt;
  let cS = -vSide / Math.max(dt, Math.min(ttg / 4, LATERAL_MAX_S));

  const terminal = dEff <= TERMINAL_RANGE;
  // (a sweep takes over a step early: the brake's last, partial step would
  // otherwise leave a minute of coasting on the target's pull, which may
  // point well off the nose)
  const turning = !terminal && turn != null && (dEff <= Dh || (!hold.swing && dEff - Math.max(0, v0) * dt <= Dh));
  memo.swing = turning ? hold.swing : null;
  // Fine approach: corrections on RCS only, unless we come in too fast or
  // drifting sideways more than RCS can take out in a couple of minutes
  const fine = terminal && Math.hypot(dvx, dvy) < 2 * Math.max(0, vBrake) + 10 && Math.abs(vSide) < 2 * RCS_A * dt;
  const c = Math.hypot(cA, cS);
  if (fine && c > RCS_A) { cA *= RCS_A / c; cS *= RCS_A / c; }
  // The thrust: the target frame's pull passes through (holding formation
  // with a ship under thrust means burning with it), plus the correction.
  // The budget is the drive, or RCS alone while the nose swings round to the
  // holding attitude. It is shared sideways first: keeping up with the
  // target's sideways pull plus half of what's left for corrections (at
  // least half of the budget, which leaves more than the braking margin
  // along the line), and the line gets the rest.
  const holdAng = Math.atan2(Hy, Hx);
  const holdOff = Math.abs(angleDiff(holdAng, p.facing));
  const swinging = turning && hold.swing && holdOff > SWEEP_DRIVE;
  const cap = swinging ? RCS_A : aMax;
  let tS = hS + cS;
  const sideMax = swinging ? cap : Math.max(0.5 * cap, (cap + Math.abs(hS)) / 2);
  if (Math.abs(tS) > sideMax) tS = Math.sign(tS) * sideMax;
  const room = Math.sqrt(Math.max(0, cap * cap - tS * tS));
  let tA = Math.max(-room, Math.min(room, f + cA));
  let T = { x: tA * ux - tS * uy, y: tA * uy + tS * ux };
  let sweepAxis = null, coneAxis = null;
  const coasting = vAlong === v0;
  if (closing && inBrake && v0 >= vLow && !fine && !turning) {
    // In braking attitude and not short of the curve: never swing round to
    // push toward the target (RCS does any of that), and until the hold turn
    // nothing the nose can't lean to with the drive lit: when the brake eases
    // the thrust left is the target frame's pull, which may point anywhere.
    // (Coasting, not even that far: the drive isn't chasing the pull.)
    const along = T.x * ux + T.y * uy;
    if (along > RCS_A) { T.x -= (along - RCS_A) * ux; T.y -= (along - RCS_A) * uy; }
    if (Math.abs(angleDiff(angBrake, p.facing)) <= 2 * SWEEP_DRIVE) { T = withinCone(T.x, T.y, p.facing, aMax, coasting ? SWEEP_DRIVE : LEAN_MAX); coneAxis = T.face; }
  } else if (fine || (holdDrive && terminal) || (holdDrive && turning && !swinging && holdOff <= 2 * SWEEP_DRIVE)) {
    // In the holding attitude: keep near it. Leaning off it, as far as the
    // drive can lean lit, is what gives control along the line of sight
    // (and never further from where the nose is than it can lean to). The
    // fine approach turns nothing either: if the target's pull no longer
    // needs the drive (it fades as some stations come round), the nose
    // stays where it is and RCS does the rest.
    // (short of the holding attitude, the nose finishes the turn at a sweep's pace)
    const axis = !holdDrive ? p.facing
      : holdOff <= 2 * SWEEP_DRIVE ? holdAng
      : p.facing + Math.sign(angleDiff(holdAng, p.facing)) * SWEEP_DRIVE;
    T = withinCone(T.x, T.y, axis, aMax, holdOff <= 2 * SWEEP_DRIVE ? LEAN_MAX : 0);
    coneAxis = T.face;
    const lean = angleDiff(Math.atan2(T.y, T.x), p.facing);
    if (Math.abs(lean) > LEAN_MAX) T = withinCone(T.x, T.y, p.facing + Math.sign(lean) * LEAN_MAX, aMax, 0);
  } else if (litFlip && !turning && !fine && Math.abs(angleDiff(Math.atan2(T.y, T.x), p.facing)) > SWEEP_DRIVE) {
    // The lit flip: round at the planned pace, the drive pushing along the
    // nose all the way (it is what holds us level with the target sideways)
    const lead = angleDiff(Math.atan2(T.y, T.x), p.facing);
    sweepAxis = p.facing + Math.sign(lead) * SWEEP_DRIVE;
    T = withinCone(T.x, T.y, sweepAxis, aMax, 0);
  } else if (turning && !hold.swing) {
    // The sweep works like a gravity turn: for each attitude there is one
    // thrust that keeps us from drifting sideways, and with it one
    // deceleration. So the attitude is what's steered: round toward the one
    // that gives the deceleration wanted (sideways corrections left out of
    // it), no faster than SWEEP_DRIVE a minute. The drive gives what lies
    // along it and RCS the rest.
    const want = Math.atan2(Hy + cA * uy, Hx + cA * ux);
    const lead = angleDiff(want, p.facing);
    sweepAxis = p.facing + Math.max(-SWEEP_DRIVE, Math.min(SWEEP_DRIVE, lead));
    T = withinCone(T.x, T.y, sweepAxis, aMax, 0);
  }
  if (sweepAxis == null && !swinging && !fine && Math.hypot(T.x, T.y) > RCS_A) {
    // A thrust off the nose but within a lean is reached by leaning no more
    // than SWEEP_DRIVE this minute (the flight step does no more with the
    // drive lit); ask for exactly what that gives, so that next minute's
    // correction starts from what really happened
    const lead = angleDiff(Math.atan2(T.y, T.x), p.facing);
    if (Math.abs(lead) > SWEEP_DRIVE && Math.abs(lead) <= LEAN_MAX) {
      sweepAxis = p.facing + Math.sign(lead) * SWEEP_DRIVE;
      T = withinCone(T.x, T.y, sweepAxis, aMax, 0);
    }
  }
  let ax = T.x, ay = T.y;
  out.ax = ax; out.ay = ay;
  // The attitude asked for: the holding attitude once that is what's left
  // to do, the sweep's, the braking attitude while braking or ready to brake
  // (with the sideways correction it carries), or while coasting short of
  // the curve, ready to burn. The flight step holds to it only for commands
  // it can give from there, so a small thrust can't steer the nose about.
  // Otherwise the nose follows the thrust.
  out.face = fine || coneAxis != null && terminal ? coneAxis
    : turning && hold.swing ? (holdDrive ? holdAng : null)
    : turning || sweepAxis != null ? sweepAxis
    : closing && v0 >= vLow ? Math.atan2(Hy - aR * uy + cS * ux, Hx - aR * ux - cS * uy)
    : !coasting ? null
    : Math.atan2(Hy + aBurn * uy + cS * ux, Hx + aBurn * ux - cS * uy);
  // (a command kept within a cone asks for the cone's axis, so that the
  // flight step gives it from there instead of turning to it)
  if (coneAxis != null && sweepAxis == null) out.face = coneAxis;
  out.vMax = vBrake;
  out.dEff = dEff;
  out.terminal = terminal;
  return out;
}

/**
 * Keep law: hold a point that rides with a target (a stance, stance.js), and
 * get back onto it from close by whatever the state: the nose the wrong way,
 * drifting, the target pulling hard in any direction. The closing law flies
 * a planned approach along the line of sight (flip, brake, hold turn), and
 * a ship well off that plan near the end has nothing to fall back on. This
 * law has no plan to fall off. Each minute it asks for the relative velocity
 * that heads for the point at the fastest speed the ship can still stop
 * from: on the drive, with the turn to the braking attitude still to make,
 * or on RCS without one. Then it asks for the thrust that reaches that
 * velocity this minute, on top of the target frame's pull. Settled (`settled`:
 * inside the band and slow), it pulls back on RCS alone, critically damped
 * with time constant T, and the drive only carries the target's pull.
 * p: { aMax (m/s²), facing (rad), slew (rad/min), dtSec, settled, T (s) }
 * Writes out.ax/out.ay and out.face: settled, the holding attitude when the
 * pull takes the drive; coming in, the nose's own when the thrust can be
 * given from it; else null (the nose follows the thrust).
 */
export function keepLaw(rel, p, out = {}) {
  const dt = p.dtSec;
  const Hx = rel.ffx, Hy = rel.ffy, h = Math.hypot(Hx, Hy);
  // rel.dx/dy points from us to the point; rel.dvx/dvy is our velocity relative to it
  let cx, cy, cap;
  if (p.settled) {
    cx = (rel.dx / p.T - 2 * rel.dvx) / p.T;
    cy = (rel.dy / p.T - 2 * rel.dvy) / p.T;
    cap = RCS_A;
  } else {
    cap = Math.max(RCS_A, p.aMax - h);
    const a = BRAKE_MARGIN * cap;
    const { ux, uy } = rel;
    // The braking curves (whole steps, as the closing law's), on RCS with no
    // turn or on the drive after the turn to the braking attitude (the pull,
    // and the brake pushing back along the line). Above the first the ship
    // brakes; it speeds up on the drive only below the second, drawn as if a
    // whole flip were still ahead (after burning toward the point, it is);
    // between them it coasts. Speeding up on RCS turns nothing.
    const slew = p.slew ?? SLEW_RATE;
    const angBrake = Math.atan2(Hy - a * uy, Hx - a * ux), angBurn = Math.atan2(Hy + a * uy, Hx + a * ux);
    const F = turnSeconds(p.facing, angBrake, slew) + dt;
    const Ffull = turnSeconds(angBurn, angBrake, slew) + dt;
    const v0 = rel.vClose;
    const vBrake = aimSpeed((d) => Math.max(rcsCurve(d, dt), driveCurve(d, a, F, 0, 0, 0, dt)), rel.d, v0, dt);
    const vBurn = Math.min(vBrake, aimSpeed((d) => Math.max(rcsCurve(d, dt), driveCurve(d, a, Ffull, 0, 0, 0, dt)), rel.d, v0, dt));
    const vAlong = v0 > vBrake ? vBrake : v0 < vBurn ? vBurn : Math.min(vBrake, v0 + RCS_A * dt);
    const cA = (vAlong - v0) / dt;
    // sideways drift is taken out over a couple of minutes
    const cS = (rel.dvx * uy - rel.dvy * ux) / (2 * dt);
    cx = cA * ux - cS * uy;
    cy = cA * uy + cS * ux;
    // A correction RCS can make in a few minutes isn't worth turning the ship for
    if (Math.hypot(cx, cy) < 3 * RCS_A) cap = RCS_A;
  }
  const cm = Math.hypot(cx, cy);
  if (cm > cap) { cx *= cap / cm; cy *= cap / cm; }
  let ax = Hx + cx, ay = Hy + cy;
  // Settled, the nose holds the pull's attitude (corrections are RCS across
  // it); coming in, it follows the thrust (asking for the hold attitude only
  // when the thrust happens to fit it would dither between the two)
  out.face = null;
  if (p.settled && h > HOLD_RCS_A) out.face = Math.atan2(Hy, Hx);
  else if (p.settled) {
    // RCS alone: the nose stays where it is
    const m = Math.hypot(ax, ay);
    if (m > RCS_A) { ax *= RCS_A / m; ay *= RCS_A / m; }
  } else {
    // and no turn for a thrust the drive can give from where the nose is,
    // RCS taking what lies across it
    const nx = Math.cos(p.facing), ny = Math.sin(p.facing);
    if (ax * nx + ay * ny > 0 && Math.abs(-ax * ny + ay * nx) <= 0.95 * RCS_A) out.face = p.facing;
  }
  out.ax = ax; out.ay = ay;
  return out;
}

export function arrivalTolerance(standoff) {
  return Math.max(100, standoff * 0.02);
}

export function hasArrived(rel, standoff) {
  return rel.d - standoff <= arrivalTolerance(standoff) && rel.speed <= ARRIVE_SPEED;
}

/**
 * Estimate game-minutes until the closing law will flip from accelerating to
 * braking (1D, constant thrust). Returns Infinity if not accelerating toward target.
 */
export function minutesToFlip(rel, aMax, standoff, cruise = Infinity, facing = 0, horizon = 90) {
  const nose = Math.cos(facing) * rel.ux + Math.sin(facing) * rel.uy > 0;
  if (!nose) return Infinity;
  let v = rel.vClose;
  let d = Math.max(0, rel.d - standoff);
  for (let t = 0; t <= horizon; t++) {
    const vMax = brakingSpeed(d, aMax, FULL_FLIP_S, cruise);
    if (v >= vMax * 0.98) return v >= cruise * 0.98 && cruise < Infinity ? Infinity : t;
    v = Math.min(v + aMax * MIN_S, cruise);
    d -= v * MIN_S;
    if (d <= 0) return t;
  }
  return Infinity;
}

/**
 * Transfer law: velocity needed now to coast onto the target at `arriveMinute`.
 * Returns { ax, ay, dv } or null when Lambert has no solution.
 */
export function transferLaw(flight, targetAtArrival, minute, arriveMinute, aMax, dtSec, out = {}) {
  const tof = (arriveMinute - minute) * MIN_S;
  if (tof <= 0) return null;
  const sol = solveLambert(
    flight.pos.x * AU_M, flight.pos.y * AU_M,
    targetAtArrival.pos.x * AU_M, targetAtArrival.pos.y * AU_M,
    tof,
  );
  if (!sol) return null;
  const dvx = sol.v1x - flight.vel.vx;
  const dvy = sol.v1y - flight.vel.vy;
  const dv = Math.hypot(dvx, dvy);
  let ax = dvx / dtSec, ay = dvy / dtSec;
  const a = Math.hypot(ax, ay);
  if (a > aMax) { ax *= aMax / a; ay *= aMax / a; }
  // Residuals under 0.5 m/s aren't worth a correction; small ones end up on RCS (flightStep)
  if (dv < 0.5) { ax = 0; ay = 0; }
  out.ax = ax; out.ay = ay; out.dv = dv;
  out.v2x = sol.v2x; out.v2y = sol.v2y;
  return out;
}
