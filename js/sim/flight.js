// ============================================================
// LONGHAUL — Ship flight dynamics
//
// The ship is a point mass with an attitude. The Epstein drive pushes
// along the nose (`facing`); turning the nose takes time (RCS slew).
// How the nose follows a command:
// - Small corrections (< RCS_MAX_G) are RCS translation, without turning
//   (the nose swings to a requested attitude meanwhile, if one is given).
// - A command within LEAN_MAX of the nose, from a controller that asks for
//   it (`lean`: guidance, following a slowly turning thrust), is followed
//   with the drive lit: the nose leans round no faster than ALIGN_TOL a
//   minute and the drive gives what lies along it, RCS trimming the rest.
//   Evasive and hand-flown commands jump about, and firing off the vector
//   would only misdirect them, so they turn first.
// - Anything further is a real turn: a full-rate slew with the drive cold
//   until the nose is on the vector. A flip is a 180° slew.
//
// Controllers (autopilot, manual helm) hand flightStep a desired
// non-gravitational acceleration; flightStep decides what the ship
// can actually do this minute and integrates the motion.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { gravityAt, gravityEpoch } from './gravity.js';

export const SLEW_RATE = Math.PI / 6;            // rad per game-minute → full flip in 6 min
export const FLIP_MINUTES = Math.PI / SLEW_RATE;
export const RCS_MAX_G = 0.02;                   // RCS translation authority
export const ALIGN_TOL = 8 * Math.PI / 180;      // drive fires only within 8° of the commanded vector
export const LEAN_MAX = 30 * Math.PI / 180;      // up to this far off, the nose leans round with the drive lit
export const FUEL_PER_G_MIN = 0.05;              // kg of reaction mass per G per minute (main drive)
export const RCS_FUEL_PER_G_MIN = 0.6;           // RCS is ~12× less efficient
export const DRIVE_MAX_G = 10;                   // default drive limit (overdriven); a ship's class sets its own
export const FLIP_TURN = 2.4;                    // rad: a turn this big from rest is a flip, and throws anyone unstrapped (inertia.js)

export function createFlight(pos, vel, facing = 0) {
  return {
    pos: { x: pos.x, y: pos.y },     // AU, heliocentric
    vel: { vx: vel.vx, vy: vel.vy }, // m/s
    facing,                          // rad — direction the nose (and drive thrust) points
    thrustG: 0,                      // main drive output last minute (G)
    rcsG: 0,                         // RCS output last minute (G)
    turning: 0,                      // rad turned last minute (signed)
    maxG: DRIVE_MAX_G,               // drive limit right now (machinery permitting)
    hold: null,                      // station-keeping: { kind:'entity'|'body', id, ox, oy (m) }
    leaving: null,                   // clearing off a station with no route: { station, ux, uy } (autopilot.js clearOutTick)
    manual: null,                    // dev helm: { throttleG }
  };
}

/** Signed shortest angle a − b in (−π, π]. */
export function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Can the drive along `facing` plus RCS across it give the acceleration (ax, ay)? */
function fitsNose(facing, ax, ay, rcsMax) {
  const cx = Math.cos(facing), cy = Math.sin(facing);
  return ax * cx + ay * cy > 0 && Math.abs(ax * cy - ay * cx) <= rcsMax;
}

/**
 * How far (rad) the nose would swing to follow `cmd` from where it points:
 * to the attitude asked for if the command can be given from it, else to
 * the thrust's. 0 for an RCS correction with no attitude asked for.
 */
export function turnAhead(f, cmd) {
  if (!cmd) return 0;
  const mag = Math.hypot(cmd.ax, cmd.ay), rcsMax = RCS_MAX_G * G0;
  if (mag <= rcsMax) return cmd.face == null ? 0 : Math.abs(angleDiff(cmd.face, f.facing));
  const goal = cmd.face != null && fitsNose(cmd.face, cmd.ax, cmd.ay, rcsMax) ? cmd.face : Math.atan2(cmd.ay, cmd.ax);
  return Math.abs(angleDiff(goal, f.facing));
}

const _g0 = { ax: 0, ay: 0 };
const _g1 = { ax: 0, ay: 0 };

/** Integrate pos/vel over dtSec with constant non-gravitational accel (tax, tay). Velocity-Verlet. */
export function integrate(pos, vel, tax, tay, dtSec, t0 = gravityEpoch()) {
  gravityAt(pos.x, pos.y, t0, _g0);
  const ax0 = _g0.ax + tax, ay0 = _g0.ay + tay;
  pos.x += (vel.vx * dtSec + 0.5 * ax0 * dtSec * dtSec) / AU_M;
  pos.y += (vel.vy * dtSec + 0.5 * ay0 * dtSec * dtSec) / AU_M;
  gravityAt(pos.x, pos.y, t0 + dtSec / 60, _g1);
  vel.vx += 0.5 * (ax0 + _g1.ax + tax) * dtSec;
  vel.vy += 0.5 * (ay0 + _g1.ay + tay) * dtSec;
}

/**
 * One flight step.
 * @param f    flight state (mutated)
 * @param cmd  { ax, ay } desired non-gravitational accel in m/s² (solar frame),
 *             maxG drive limit for this maneuver, optional `face` (rad) to point
 *             the nose at when no main-drive burn is wanted, optional `lean`
 *             (follow a command off the nose with the drive lit)
 * @param dtMin step length in game-minutes
 * @returns {{ mainG:number, rcsG:number, turned:number, rotation:number }}
 */
export function flightStep(f, cmd, dtMin = 1) {
  const dt = dtMin * MIN_S;
  const ax = cmd ? cmd.ax : 0;
  const ay = cmd ? cmd.ay : 0;
  const maxA = Math.min(cmd?.maxG ?? f.maxG, f.maxG) * G0;
  const mag = Math.hypot(ax, ay);
  const rcsMax = RCS_MAX_G * G0;

  let tax = 0, tay = 0;     // average non-gravitational accel actually produced
  let mainA = 0, rcsA = 0;
  let turned = 0;
  let rotation = 0;         // total rotation the command asked for at the start of this step
  const slew = f.$slew ?? SLEW_RATE;            // RCS condition sets how fast the nose swings
  const maxTurn = slew * dtMin;

  const slewTo = (target) => {
    let diff = angleDiff(target, f.facing);
    // A big turn already under way keeps its direction when the goal sits
    // nearly opposite (it would otherwise dither between the two ways round)
    if (Math.abs(diff) > 2.6 && f.turning * diff < 0) diff += Math.sign(f.turning) * 2 * Math.PI;
    rotation = Math.abs(diff);
    const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
    f.facing = angleDiff(f.facing + step, 0);
    turned = step;
  };

  if (mag <= rcsMax) {
    // Fine work on RCS alone; nose optionally swings to a requested attitude
    if (cmd && cmd.face != null) slewTo(cmd.face);
    tax = ax; tay = ay;
    rcsA = mag;
  } else {
    // The attitude to steer for: the one asked for if the command can be
    // given from it (the drive along the nose, RCS across), else the thrust's
    const want = Math.atan2(ay, ax);
    const goal = cmd.face != null && fitsNose(cmd.face, ax, ay, rcsMax) ? cmd.face : want;
    const err0 = angleDiff(goal, f.facing);
    // (a turn already swinging at full rate finishes as one)
    const swinging = Math.abs(f.turning || 0) > ALIGN_TOL * dtMin * 1.01;
    if (cmd.lean && Math.abs(err0) <= LEAN_MAX && !swinging) {
      // A lean: turn no more than the alignment tolerance a minute, so the
      // drive stays lit, and give what lies along the nose; RCS trims the rest.
      // A turning thrust is followed smoothly instead of in stop-and-swing lurches.
      const step = Math.max(-ALIGN_TOL * dtMin, Math.min(ALIGN_TOL * dtMin, Math.max(-maxTurn, Math.min(maxTurn, err0))));
      rotation = Math.abs(step);
      f.facing = angleDiff(f.facing + step, 0);
      turned = step;
      const cx = Math.cos(f.facing), cy = Math.sin(f.facing);
      const a = Math.max(0, Math.min(ax * cx + ay * cy, maxA));
      tax = a * cx; tay = a * cy;
      mainA = a;
      const rx = ax - tax, ry = ay - tay;
      const rm = Math.hypot(rx, ry), k = rm > rcsMax ? rcsMax / rm : 1;
      tax += rx * k; tay += ry * k;
      rcsA = rm * k;
    } else {
      // A real turn: swing at full rate with the drive cold until the nose is
      // within tolerance
      const startErr = Math.abs(err0);
      slewTo(goal);
      const err = angleDiff(want, f.facing);
      if (Math.abs(err) <= ALIGN_TOL) {
        const coldMin = Math.max(0, startErr - ALIGN_TOL) / slew;
        const frac = Math.max(0, 1 - coldMin / dtMin);
        const a = Math.min(mag * Math.cos(err), maxA) * frac;
        const cx = Math.cos(f.facing), cy = Math.sin(f.facing);
        tax = a * cx; tay = a * cy;
        mainA = a;
        // RCS trims the residual off-axis component
        let rx = ax * frac - tax, ry = ay * frac - tay;
        const rm = Math.hypot(rx, ry);
        if (rm > 0 && a > 0) {
          const k = Math.min(1, rcsMax / rm);
          rx *= k; ry *= k;
          tax += rx; tay += ry;
          rcsA = Math.hypot(rx, ry);
        }
      }
    }
  }

  integrate(f.pos, f.vel, tax, tay, dt, f.t ?? gravityEpoch());     // (a planner's flight carries its own clock)
  f.$ax = tax; f.$ay = tay;            // (for views drawing between minutes)
  f.thrustG = mainA / G0;
  f.rcsG = rcsA / G0;
  f.turning = turned;
  return { mainG: f.thrustG, rcsG: f.rcsG, turned, rotation };
}

/**
 * Above its rated limit a drive runs hotter, thirstier and riskier. A drive
 * is rated for 70% of what its class can push (ratedG in ship-classes.js);
 * RATED_G is the armed light freighter's 10G drive.
 */
export const RATED_G = 7;

/** Reaction mass used by one step's output (overdriven thrust costs double). */
export function fuelUsed(mainG, rcsG, dtMin = 1, rated = RATED_G) {
  const over = Math.max(0, mainG - rated);
  return ((mainG + over) * FUEL_PER_G_MIN + rcsG * RCS_FUEL_PER_G_MIN) * dtMin;
}
