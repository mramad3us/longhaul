// ============================================================
// LONGHAUL — Planetary flight: between orbit and a world's ground
//
// How a craft rated for an atmosphere (a big hull's shuttle, ship-
// classes.js BAYS; later a rated hull of our own) goes down to a world's
// ground and back up. Each stretch is flown as physics, once, and the craft
// rides what was flown afterwards on rails (a `flightPath`: world.js), so
// one shuttle or a hundred NPC ones cost the same:
//
//   DROP     from its carrier's high orbit down to the top of the air, as
//            a real craft flies it (a transfer: THE DRIVE'S LEGS, below):
//            a burn onto a conic, a coast on it with the drive cold, a
//            burn to arrive at the speed and angle it will enter at (in the
//            frame that doesn't turn: the ground's speed under it added),
//            by way of a low orbit where that is quicker (shuttles.js)
//   ENTRY    from the entry interface down, integrated second by second in
//            the world's turning frame (its air at rest in it, the
//            centrifugal and Coriolis terms with it): its pull, drag
//            (ρv²/2β), lift (its lift over drag, the belly first), the
//            convective heat (Sutton–Graves, a nose NOSE_M across). It
//            enters at the speed the drive left it: the most its shield
//            takes at its peak (HEAT_LIMIT), braked further on the drive if
//            that would be too hot. Lift holds it to a steady descent (a
//            glide that bleeds its speed, a few G at most)
//   LANDING  under ~280 m/s, or low: on the drive, killing its speed over
//            the ground and coming down at a rate that slows as it nears
//            the pad. A world with no air is all landing: the drop ends
//            HOVER_M over the pad, at rest over it
//   ASCENT   off the pad on the drive, straight up, then pitching over
//            downrange (never faster along the ground than an orbit there),
//            through the air to its top (drag against it), and a transfer
//            back up to the carrier from there (alongside, going round as
//            it goes)
//
// The profiles depend only on the world and the craft (entryProfile,
// ascentProfile, cached): where a run lands, it starts upstream of the pad
// by the profile's own downrange, its way down aimed there for when it will
// arrive (shuttles.js plans it: airState is where it must be). Angles are a
// world's body-frame angles (worlds.js groundAngle) for the ground, and
// plane angles round its centre for orbit.
//
// What the drive does on a transfer (xferAt: the shuttle's cameras turn the
// craft by it) is its burns' own push, nothing between them. The craft's
// entity carries its drive as any hull's does (driveOn: thrust and heading,
// set as the world moves it), so the other views and the sensors see it lit
// on a burn and cold on a coast.
//
// Cost: an entry is a few thousand steps of a few dozen flops, once per
// world and craft; a transfer is flown once (its burns a step a second);
// its place is a burn's sample or the coast's conic in closed form.
// ============================================================

import { AU_M, G0, DAY_MIN, MIN_S } from '../core/constants.js';
import { bodyPos, bodyVel } from './ephemeris.js';
import { worldOf, atmosphere, entryHeat, worldAngle, groundPoint } from './worlds.js';
import { CLASSES } from './ship-classes.js';
import { hullOf } from './hulls.js';
import { FLIGHT_PATH, getWorld, predictEntity } from './world.js';
import { solveLambert } from './lambert.js';

/** The heat a shield takes at its peak (W/m²): a lifting body's tiles, a tail-sitter's ablative ring. */
export const HEAT_LIMIT = { 'ceramic tiles': 1.1e6, 'ablative ring': 2.5e6 };
export const HOVER_M = 10_000;               // an airless world: the drop ends this far over the pad, at rest over it
export const LAUNCH_MIN = 6;                 // a shuttle out of its bay
export const RECOVER_MIN = 8;                // …and back into it
export const GROUND_MIN = 90;                // a turnaround at the pad: the cargo off, the next on, the pad cleared
const NOSE_M = 1.5;                          // the nose (or belly) radius the heat is reckoned on
const ENTRY_GAMMA = -1.5 * Math.PI / 180;    // entering 1.5° below the horizon
const V_ENTRY_MAX = 7_200;                   // never faster than this into the air, whatever the world
const POWERED_MS = 280;                      // under this, in the air, the drive takes over for the landing
const POWERED_H = 6_000;                     // …or this low
const ASCENT_THRUST = 0.85;                  // of the drive, going up
const DT = 0.5;                              // s, the integration's step
const SAMPLE_S = 4;                          // a profile keeps a point every this many seconds
const MAX_S = 4 * 3600;

/** A craft as flight sees it: mass (kg), ballistic coefficient (kg/m², belly first), lift over drag, the drive (m/s²), the heat it takes. */
export function craftOf(cls) {
  const c = CLASSES[cls], h = hullOf(cls);
  const m = c.massT * 1000;
  const area = h.L * Math.max(h.W, h.H) * 0.6;
  return { cls, m, beta: m / area, ld: c.lift ?? (c.atmo?.entry === 'belly' ? 1 : 0.3), aMax: c.drive.maxG * G0, aCruise: c.drive.cruiseG * G0, heatMax: HEAT_LIMIT[c.atmo?.shield] ?? 0, rated: !!c.atmo };
}

// ---- THE INTEGRATOR (a world's turning frame: the ground and its air at rest) ----

/**
 * Fly down from `start` ({ h (m over the ground), v (m/s, along the ground
 * eastward), gamma (rad, below the horizon negative) }) to the ground.
 * Returns { ok, samples: [{ t, th, h, v, q, g }], t, th (the ground angle
 * covered, rad), peakHeat, peakG, peakQ, landV, entryV }.
 */
function flyDown(w, craft, start) {
  const GM = w.GM, R = w.R, om = 2 * Math.PI / w.rotS;
  let x = R + start.h, y = 0;
  let vx = start.v * Math.sin(start.gamma), vy = start.v * Math.cos(start.gamma);
  let t = 0, thPrev = 0, th = 0, nextS = 0;
  let peakHeat = 0, peakG = 0, peakQ = 0, powered = start.v === 0, driveGs = 0;
  const samples = [];
  while (t < MAX_S) {
    const r = Math.hypot(x, y), h = r - R, rx = x / r, ry = y / r;
    const v = Math.hypot(vx, vy);
    const rho = atmosphere(w, h).rho;
    // the pull, and the frame's own: centrifugal out, Coriolis across the motion
    let ax = -GM * rx / (r * r) + om * om * x + 2 * om * vy;
    let ay = -GM * ry / (r * r) + om * om * y - 2 * om * vx;
    let fx = 0, fy = 0;                                  // what the crew feels: the air and the drive
    if (rho > 0 && v > 0) {
      const D = rho * v * v / (2 * craft.beta);
      fx -= D * vx / v; fy -= D * vy / v;
      if (!powered) {
        // lift across the motion, up; how much of it points up (the bank) holds a steady sink
        let nx = -vy / v, ny = vx / v;
        if (nx * rx + ny * ry < 0) { nx = -nx; ny = -ny; }
        const hdot = vx * rx + vy * ry;
        const want = -Math.min(60, 10 + 0.004 * v);
        const k = Math.max(-1, Math.min(1, 0.4 + 0.02 * (want - hdot)));
        fx += craft.ld * D * k * nx; fy += craft.ld * D * k * ny;
      }
      peakQ = Math.max(peakQ, 0.5 * rho * v * v);
      peakHeat = Math.max(peakHeat, entryHeat(rho, v, NOSE_M));
    }
    if (!powered && ((rho > 0 && v < POWERED_MS) || h < POWERED_H)) powered = true;
    if (powered) {
      // kill the speed over the ground, come down at a rate that slows near the pad
      const hdot = vx * rx + vy * ry, vt = -vx * ry + vy * rx;
      const sink = -Math.max(2, Math.min(150, h / 12));
      const wr = (sink - hdot) * 0.25, wt = -vt * 0.08;
      let tx = wr * rx - wt * ry - (ax + fx), ty = wr * ry + wt * rx - (ay + fy);
      const tm = Math.hypot(tx, ty);
      if (tm > craft.aMax) { tx *= craft.aMax / tm; ty *= craft.aMax / tm; }
      fx += tx; fy += ty;
      driveGs += Math.min(tm, craft.aMax) / G0 * DT;
    }
    peakG = Math.max(peakG, Math.hypot(fx, fy) / G0);
    vx += (ax + fx) * DT; vy += (ay + fy) * DT;
    x += vx * DT; y += vy * DT;
    t += DT;
    const a = Math.atan2(y, x);
    let d = a - thPrev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    th += d; thPrev = a;
    const hNow = Math.hypot(x, y) - R;
    if (t >= nextS || hNow <= 0) {
      samples.push({ t, th, h: Math.max(0, hNow), v: Math.hypot(vx, vy), q: rho > 0 ? entryHeat(rho, v, NOSE_M) : 0, g: Math.hypot(fx, fy) / G0 });
      nextS = t + SAMPLE_S;
    }
    if (hNow <= 0) return { ok: Math.hypot(vx, vy) < 12, samples, t, th, peakHeat, peakG, peakQ, landV: Math.hypot(vx, vy), entryV: start.v, driveGmin: driveGs / 60 };
  }
  return { ok: false, samples, t, th, peakHeat, peakG, peakQ, landV: Infinity, entryV: start.v, driveGmin: driveGs / 60 };
}

/**
 * Fly up from the pad to `topM` over the ground: on the drive (ASCENT_THRUST
 * of it), straight up, then pitching over eastward to level at the top.
 * Returns { samples, t, th, v (at the top, along the ground), peakG, peakQ }.
 */
function flyUp(w, craft, topM) {
  const GM = w.GM, R = w.R, om = 2 * Math.PI / w.rotS;
  let x = R + 1, y = 0, vx = 0, vy = 0, t = 0, th = 0, thPrev = 0, nextS = 0, peakG = 0, peakQ = 0, driveGs = 0;
  const samples = [{ t: 0, th: 0, h: 0, v: 0, q: 0, g: 0 }];
  const a = ASCENT_THRUST * craft.aMax;
  while (t < MAX_S) {
    const r = Math.hypot(x, y), h = r - R, rx = x / r, ry = y / r;
    const v = Math.hypot(vx, vy);
    const rho = atmosphere(w, h).rho;
    let ax = -GM * rx / (r * r) + om * om * x + 2 * om * vy;
    let ay = -GM * ry / (r * r) + om * om * y - 2 * om * vx;
    let fx = 0, fy = 0;
    if (rho > 0 && v > 0) { const D = rho * v * v / (2 * craft.beta); fx -= D * vx / v; fy -= D * vy / v; peakQ = Math.max(peakQ, 0.5 * rho * v * v); }
    // pitch over from the vertical (0) to level (π/2) as it climbs; once going round as fast as an orbit
    // there would, no more along the ground: only up (a ship needn't leave the air faster than that)
    const p = Math.PI / 2 * Math.pow(Math.max(0, Math.min(1, (h - 2000) / Math.max(1, topM - 2000))), 0.6);
    const vt = -vx * ry + vy * rx, vr = vx * rx + vy * ry, vCirc = Math.sqrt(GM / r) - Math.abs(om) * r;
    const up = vt >= vCirc ? 1 : Math.cos(p), along = vt >= vCirc ? 0 : Math.sin(p);
    // (and climbing no faster than half that: past it, the drive only holds the climb against the pull)
    const hold = GM / (r * r) - om * om * r;
    const upA = vr > Math.max(300, 0.5 * vCirc) ? Math.min(a * up, Math.max(0, hold)) : a * up;
    fx += upA * rx - a * along * ry; fy += upA * ry + a * along * rx;
    driveGs += Math.hypot(upA, a * along) / G0 * DT;
    peakG = Math.max(peakG, Math.hypot(fx, fy) / G0);
    vx += (ax + fx) * DT; vy += (ay + fy) * DT;
    x += vx * DT; y += vy * DT;
    t += DT;
    const an = Math.atan2(y, x);
    let d = an - thPrev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    th += d; thPrev = an;
    const hNow = Math.hypot(x, y) - R;
    if (t >= nextS || hNow >= topM) { samples.push({ t, th, h: Math.max(0, hNow), v: Math.hypot(vx, vy), q: 0, g: Math.hypot(fx, fy) / G0 }); nextS = t + SAMPLE_S; }
    // (at the top: its speed round the world in the frame that doesn't turn, for the leg that carries on from it)
    if (hNow >= topM) { const r2 = Math.hypot(x, y); return { samples, t, th, v: Math.hypot(vx, vy), peakG, peakQ, driveGmin: driveGs / 60, vRound: (-vx * y / r2 + vy * x / r2) + om * r2, vRadial: (vx * x + vy * y) / r2 }; }
  }
  return { samples, t, th, v: Math.hypot(vx, vy), peakG, peakQ, driveGmin: driveGs / 60, vRound: Math.hypot(vx, vy), vRadial: 0 };
}

const _down = new Map(), _up = new Map();

/**
 * The way down to a world's ground for a craft (cached): from the entry
 * interface (or, airless, from HOVER_M over the pad), entering at the most
 * the shield takes, braked on the drive below that if need be. Null for a
 * craft that can't (not rated for the air, or no ground).
 */
export function entryProfile(worldName, cls) {
  const key = `${worldName}|${cls}`;
  if (_down.has(key)) return _down.get(key);
  const w = worldOf(worldName), craft = craftOf(cls);
  let p = null;
  if (w && !w.atmo?.giant && craft.aMax > 1.1 * w.g) {
    const om = 2 * Math.PI / w.rotS;
    // (vRound: its speed round the world, in the frame that doesn't turn, where the drive's legs are flown: the leg down ends at it)
    if (!w.atmo) p = { ...flyDown(w, craft, { h: HOVER_M, v: 0, gamma: 0 }), topM: HOVER_M, vRound: om * (w.R + HOVER_M), vRadial: 0 };
    else if (craft.rated) {
      const hE = w.atmo.interfaceM, rE = w.R + hE;
      let vE = Math.min(V_ENTRY_MAX, 0.95 * (Math.sqrt(w.GM / rE) - Math.abs(2 * Math.PI / w.rotS) * rE));
      for (let i = 0; i < 12; i++) {
        p = { ...flyDown(w, craft, { h: hE, v: vE, gamma: ENTRY_GAMMA }), topM: hE, vRound: vE * Math.cos(ENTRY_GAMMA) + om * rE, vRadial: vE * Math.sin(ENTRY_GAMMA) };
        if (p.ok && p.peakHeat <= craft.heatMax) break;
        vE *= 0.85;
      }
      if (p && !(p.ok && p.peakHeat <= craft.heatMax)) p = null;
    }
  }
  _down.set(key, p);
  return p;
}

/** The way up from a world's ground for a craft (cached): to the top of its air (or HOVER_M), level. */
export function ascentProfile(worldName, cls) {
  const key = `${worldName}|${cls}`;
  if (_up.has(key)) return _up.get(key);
  const w = worldOf(worldName), craft = craftOf(cls);
  const p = w && !w.atmo?.giant && craft.aMax * ASCENT_THRUST > 1.1 * w.g ? { ...flyUp(w, craft, w.atmo ? w.atmo.interfaceM : HOVER_M), topM: w.atmo ? w.atmo.interfaceM : HOVER_M } : null;
  _up.set(key, p);
  return p;
}

// ---- THE DRIVE'S LEGS: a burn, a coast, a burn ----
//
// Between a world's air and an orbit, or from one orbit to another, a
// craft flies as a real one does: it burns off where it is onto a conic (a
// free fall round the world: Lambert's problem, lambert.js, from where it
// is to where it must be, in the time it has), coasts on it with the drive
// cold, and burns again to arrive as it must (at the top of the air at the
// entry's speed and angle, alongside its carrier, round a low orbit). The
// burns are finite, at the craft's cruise: planned as impulses, then the
// conic between them found again for burns of their length, until the two
// agree (xferPlan). A transfer is flown as physics once (xferFlight): the
// first burn at a fixed attitude, the last steered to arrive exactly (the
// energy-optimal law: its push from what it would miss by, in place and
// in speed, falling from here), the coast between them exact (Kepler,
// universal variables), and, coming down, a short coast after the last
// burn (ENTRY_LEAD) so it turns belly first before the air; and one that
// begins with the craft flying another way (at the top of a climb, called
// back, chasing its carrier) a short coast before the first (TURN_LEAD),
// turning to its burn. Positions are
// metres from the world's centre in the frame that doesn't turn; a save
// keeps the plan, and a loaded leg flies it again.
//
// Which conic: xferSweep lays out the transfers from a place over a range
// of times, impulsively, each refused that would pass through the air (its
// periapsis on the way inside rFloor) or swing far out (its apoapsis past
// rCeil), or whose burns would take most of the time (XFER_FIT); the
// shuttle's planner picks among them (shuttles.js).

export const ENTRY_LEAD = 90;                // s: coming down, the last burn ends this long before the top of the air
export const TURN_LEAD = 90;                 // s: from a craft flying another way, the first burn begins this long after the leg
const XFER_DT = 1;                           // s: a burn's integration step
const XFER_SAMPLE = 4;                       // s: a burn's samples (Hermite between them)
const XFER_FIT = 0.6;                        // a transfer's burns take at most this share of its time
const XFER_ITER = 12;
const XFER_STEER_MIN = 2;                    // s: a last burn shorter than this is held at a fixed attitude (the law needs time to steer)

const hyp = (v) => Math.hypot(v[0], v[1]);

/** A world's pull at (x, y) (m from its centre). */
function pull(GM, x, y) { const r2 = x * x + y * y, k = -GM / (r2 * Math.sqrt(r2)); return [k * x, k * y]; }

function stumpC(z) {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + z * z / 720;
}
function stumpS(z) {
  if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120 + z * z / 5040;
}

/** Free fall round a world: the state { x, y, vx, vy } (m, m/s from its centre) `dt` seconds on (or back), on any conic. */
export function kepler(GM, s, dt) {
  if (!dt) return { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
  const r0 = Math.hypot(s.x, s.y), vr0 = (s.x * s.vx + s.y * s.vy) / r0, sq = Math.sqrt(GM);
  const alpha = 2 / r0 - (s.vx * s.vx + s.vy * s.vy) / GM;
  // (the universal anomaly: Newton, kept inside a bracket and bisecting when it would leave it; Kepler's
  // equation rises with it everywhere, so this always closes in, even on a conic that is nearly a line)
  let chi = Math.abs(alpha) > 1e-12 ? sq * Math.abs(alpha) * dt : sq * dt / r0, lo = -Infinity, hi = Infinity;
  for (let i = 0; i < 200; i++) {
    const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
    const F = r0 * vr0 / sq * chi * chi * C + (1 - alpha * r0) * chi * chi * chi * S + r0 * chi - sq * dt;
    const dF = r0 * vr0 / sq * chi * (1 - z * S) + (1 - alpha * r0) * chi * chi * C + r0;
    if (F > 0) hi = chi; else lo = chi;
    if (Math.abs(F) < 1e-9 * sq * Math.max(1, Math.abs(dt))) break;
    let next = chi - F / dF;
    if (!(next > lo && next < hi)) next = isFinite(lo) && isFinite(hi) ? (lo + hi) / 2 : chi + (F > 0 ? -1 : 1) * Math.max(1, Math.abs(chi));
    if (Math.abs(next - chi) < 1e-12 * Math.max(1, Math.abs(chi))) { chi = next; break; }
    chi = next;
  }
  const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
  const f = 1 - chi * chi / r0 * C, g = dt - chi * chi * chi / sq * S;
  const x = f * s.x + g * s.vx, y = f * s.y + g * s.vy, r = Math.hypot(x, y);
  const fd = sq / (r * r0) * (alpha * chi * chi * chi * S - chi), gd = 1 - chi * chi / r * C;
  return { x, y, vx: fd * s.x + gd * s.vx, vy: fd * s.y + gd * s.vy };
}

/** One step of `dt` (s, either way) under the pull and the drive's push `drive(t, state)` → [ax, ay] (RK4). */
function step(GM, s, t, dt, drive) {
  const f = (x, y, vx, vy, tt) => { const [gx, gy] = pull(GM, x, y), [ax, ay] = drive(tt, x, y, vx, vy); return [vx, vy, gx + ax, gy + ay]; };
  const k1 = f(s.x, s.y, s.vx, s.vy, t);
  const k2 = f(s.x + k1[0] * dt / 2, s.y + k1[1] * dt / 2, s.vx + k1[2] * dt / 2, s.vy + k1[3] * dt / 2, t + dt / 2);
  const k3 = f(s.x + k2[0] * dt / 2, s.y + k2[1] * dt / 2, s.vx + k2[2] * dt / 2, s.vy + k2[3] * dt / 2, t + dt / 2);
  const k4 = f(s.x + k3[0] * dt, s.y + k3[1] * dt, s.vx + k3[2] * dt, s.vy + k3[3] * dt, t + dt);
  return {
    x: s.x + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), y: s.y + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    vx: s.vx + dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]), vy: s.vy + dt / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]),
  };
}

/** A burn at a fixed attitude: from `s`, pushing `acc` along unit `d` for `b` seconds (negative: back in time to where it began). */
function burnFrom(GM, s, d, acc, b) {
  const n = Math.max(1, Math.ceil(Math.abs(b) / XFER_DT)), dt = b / n, push = () => [acc * d[0], acc * d[1]];
  let st = s;
  for (let i = 0; i < n; i++) st = step(GM, st, i * dt, dt, push);
  return st;
}

/** What the energy-optimal law pushes with, `tau` seconds from arriving at `B` (its miss, in place and in speed, falling from here). */
function steer(GM, B, tau, x, y, vx, vy) {
  if (tau < 1e-3) return [0, 0];
  const [gx, gy] = pull(GM, x, y);
  const zx = B.x - (x + vx * tau + 0.5 * gx * tau * tau), zy = B.y - (y + vy * tau + 0.5 * gy * tau * tau);
  const ex = B.vx - (vx + gx * tau), ey = B.vy - (vy + gy * tau);
  return [6 * zx / (tau * tau) - 2 * ex / tau, 6 * zy / (tau * tau) - 2 * ey / tau];
}

/**
 * Is the conic from (r1, v1) to (r2, v2) (arriving there) clear: through
 * no periapsis inside rFloor, no apoapsis past rCeil, and going round the
 * way the world turns?
 */
export function arcClear(GM, r1, v1, r2, v2, rFloor, rCeil) {
  const h = r1[0] * v1[1] - r1[1] * v1[0];
  if (h <= 0) return false;
  const R1 = hyp(r1), R2 = hyp(r2), p = h * h / GM;
  const ex = ((v1[0] * v1[0] + v1[1] * v1[1] - GM / R1) * r1[0] - (r1[0] * v1[0] + r1[1] * v1[1]) * v1[0]) / GM;
  const ey = ((v1[0] * v1[0] + v1[1] * v1[1] - GM / R1) * r1[1] - (r1[0] * v1[0] + r1[1] * v1[1]) * v1[1]) / GM;
  const e = Math.hypot(ex, ey);
  if (e < 1e-6) return R1 >= rFloor && R1 <= rCeil;
  // (true anomalies at each end, and the way round between them)
  const nu = (r, R, v) => { const a = Math.atan2(((r[0] * v[0] + r[1] * v[1]) / R) * h / GM, p / R - 1); return a < 0 ? a + 2 * Math.PI : a; };
  const n1 = nu(r1, R1, v1), n2 = nu(r2, R2, v2);
  const sweep = ((n2 - n1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), end = n1 + sweep;
  if (end >= 2 * Math.PI && p / (1 + e) < rFloor) return false;
  if (e < 1 && (n1 <= Math.PI ? end >= Math.PI : end >= 3 * Math.PI) && p / (1 - e) > rCeil) return false;
  return true;
}

/**
 * The transfers from `A` (a state at the leg's start) to `Bat(tof)` (the
 * state it must arrive in, `tof` seconds on), over times tMin–tMax (s), as
 * impulses: [{ tof, dv (m/s, both burns), dv1, dv2 }], the impossible and
 * the unflyable left out.
 */
export function xferSweep(GM, A, Bat, acc, { tMin = 600, tMax = 12 * 3600, n = 48, rFloor, rCeil }) {
  const out = [], k = Math.pow(tMax / tMin, 1 / Math.max(1, n - 1));
  for (let i = 0, tof = tMin; i < n; i++, tof *= k) {
    const B = Bat(tof), L = solveLambert(A.x, A.y, B.x, B.y, tof, GM, 0);
    if (!L || !arcClear(GM, [A.x, A.y], [L.v1x, L.v1y], [B.x, B.y], [L.v2x, L.v2y], rFloor, rCeil)) continue;
    const dv1 = Math.hypot(L.v1x - A.vx, L.v1y - A.vy), dv2 = Math.hypot(B.vx - L.v2x, B.vy - L.v2y);
    if ((dv1 + dv2) / acc > XFER_FIT * tof) continue;
    out.push({ tof, dv: dv1 + dv2, dv1, dv2 });
  }
  return out;
}

/**
 * A transfer planned for burns of their length: from `A` to `B`, `tof`
 * seconds on, at `acc` (m/s²); `lead` seconds of it a coast before the
 * first burn, `tail` seconds a coast after the last. The plan (plain data,
 * what a save keeps): { A, B, tof, acc, lead, tail, dv1, dv2 (the burns,
 * m/s as vectors) }, or null if none agrees, or if what is flown would go
 * under `rFloor` anywhere (a burn held along an impulse's line from low
 * down can carry it into the ground).
 */
export function xferPlan(GM, A0, B, tof, acc, tail = 0, rFloor = 0, lead = 0) {
  const A = lead ? kepler(GM, A0, lead) : A0;
  const Bb = tail ? kepler(GM, B, -tail) : B, T = tof - tail - lead;
  if (T <= 0) return null;
  const L = solveLambert(A.x, A.y, Bb.x, Bb.y, T, GM, 0);
  if (!L) return null;
  let d1 = [L.v1x - A.vx, L.v1y - A.vy], d2 = [Bb.vx - L.v2x, Bb.vy - L.v2y];
  for (let k = 0; k < XFER_ITER; k++) {
    const b1 = hyp(d1) / acc, b2 = hyp(d2) / acc;
    if (b1 + b2 > XFER_FIT * T) return null;
    const u1 = b1 > 0 ? [d1[0] / hyp(d1), d1[1] / hyp(d1)] : [0, 0], u2 = b2 > 0 ? [d2[0] / hyp(d2), d2[1] / hyp(d2)] : [0, 0];
    const P1 = b1 > 0 ? burnFrom(GM, A, u1, acc, b1) : A, P2 = b2 > 0 ? burnFrom(GM, Bb, u2, acc, -b2) : Bb;
    const M = solveLambert(P1.x, P1.y, P2.x, P2.y, T - b1 - b2, GM, 0);
    if (!M) return null;
    const e1 = [M.v1x - P1.vx, M.v1y - P1.vy], e2 = [P2.vx - M.v2x, P2.vy - M.v2y];
    d1 = [d1[0] + e1[0], d1[1] + e1[1]]; d2 = [d2[0] + e2[0], d2[1] + e2[1]];
    if (hyp(e1) + hyp(e2) < 0.02) break;
  }
  const st = (s) => ({ x: s.x, y: s.y, vx: s.vx, vy: s.vy });
  const x = { A: st(A0), B: st(B), tof, acc, lead, tail, dv1: d1, dv2: d2 };
  // flown, it must keep clear: its burns' samples, and the coasts round them
  const F = xferFlight(GM, x), low = (S) => S.some(p => Math.hypot(p.x, p.y) < rFloor);
  const P2 = kepler(GM, F.C, F.tc), clear = (P, Q) => arcClear(GM, [P.x, P.y], [P.vx, P.vy], [Q.x, Q.y], [Q.vx, Q.vy], rFloor, Infinity);
  if (!isFinite(P2.x) || low(F.S1) || low(F.S2) || (F.tc > 0 && !clear(F.C, P2)) || (lead && !clear(A0, A))) return null;
  return x;
}

const _flights = new WeakMap();

/**
 * A transfer as flown (cached beside its plan): { b1, tc, b2, tail (s), S1,
 * S2 (the burns' samples: { t, x, y, vx, vy, ax, ay }, t from the leg's
 * start), C (where it coasts from), E (where the last burn ends) }.
 */
export function xferFlight(GM, x) {
  let F = _flights.get(x);
  if (F) return F;
  const lead = x.lead || 0, b1 = hyp(x.dv1) / x.acc, b2 = hyp(x.dv2) / x.acc, tail = x.tail || 0, tc = Math.max(0, x.tof - lead - tail - b1 - b2);
  const Bb = tail ? kepler(GM, x.B, -tail) : x.B;
  // the first burn: at a fixed attitude
  const u1 = b1 > 0 ? [x.dv1[0] / hyp(x.dv1), x.dv1[1] / hyp(x.dv1)] : [0, 0];
  const S1 = [], push1 = () => [x.acc * u1[0], x.acc * u1[1]];
  let s = lead ? kepler(GM, x.A, lead) : x.A, n = Math.max(1, Math.ceil(b1 / XFER_DT)), dt = b1 / n;
  S1.push({ t: lead, ...s, ax: push1()[0], ay: push1()[1] });
  for (let i = 0; i < n && b1 > 0; i++) {
    s = step(GM, s, i * dt, dt, push1);
    if (lead + (i + 1) * dt >= S1.at(-1).t + XFER_SAMPLE - 1e-9 || i === n - 1) S1.push({ t: lead + (i + 1) * dt, ...s, ax: push1()[0], ay: push1()[1] });
  }
  const C = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
  // the coast, then the last burn, steered to arrive exactly
  s = kepler(GM, C, tc);
  const t2 = lead + b1 + tc, S2 = [];
  n = Math.max(1, Math.ceil(b2 / XFER_DT)); dt = b2 / n;
  const u2 = b2 > 0 ? [x.dv2[0] / hyp(x.dv2), x.dv2[1] / hyp(x.dv2)] : [0, 0];
  const drive = b2 < XFER_STEER_MIN ? () => [x.acc * u2[0], x.acc * u2[1]] : (tt, X, Y, VX, VY) => steer(GM, Bb, b2 - tt, X, Y, VX, VY);
  for (let i = 0; i < n && b2 > 0; i++) {
    const a = drive(i * dt, s.x, s.y, s.vx, s.vy);
    if (!S2.length || i * dt >= S2.at(-1).t - t2 + XFER_SAMPLE - 1e-9) S2.push({ t: t2 + i * dt, ...s, ax: a[0], ay: a[1] });
    // (the last step lands where it must: the law's own miss there is a few centimetres)
    s = i === n - 1 ? Bb : step(GM, s, i * dt, dt, drive);
  }
  if (b2 > 0) S2.push({ t: t2 + b2, ...Bb, ax: S2.at(-1).ax, ay: S2.at(-1).ay });
  F = { lead, b1, tc, b2, tail, S1, S2, C, E: Bb };
  _flights.set(x, F);
  return F;
}

/** Between two samples, cubic Hermite in place (with their velocities), linear in the push. */
function sampleAt(S, t) {
  if (t <= S[0].t) return S[0];
  if (t >= S.at(-1).t) return S.at(-1);
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].t <= t) lo = mid; else hi = mid; }
  const P = S[lo], Q = S[hi], h = Q.t - P.t, u = (t - P.t) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const d00 = (6 * u2 - 6 * u) / h, d10 = 3 * u2 - 4 * u + 1, d01 = (-6 * u2 + 6 * u) / h, d11 = 3 * u2 - 2 * u;
  return {
    t, x: h00 * P.x + h10 * h * P.vx + h01 * Q.x + h11 * h * Q.vx, y: h00 * P.y + h10 * h * P.vy + h01 * Q.y + h11 * h * Q.vy,
    vx: d00 * P.x + d10 * P.vx + d01 * Q.x + d11 * Q.vx, vy: d00 * P.y + d10 * P.vy + d01 * Q.y + d11 * Q.vy,
    ax: P.ax + (Q.ax - P.ax) * u, ay: P.ay + (Q.ay - P.ay) * u,
  };
}

/**
 * Where a transfer has the craft `s` seconds in: { x, y, vx, vy (m, m/s
 * from the world's centre), ax, ay (the drive's push, m/s²), burn (1, 2,
 * or 0 coasting) }.
 */
export function xferAt(GM, x, s) {
  const F = xferFlight(GM, x), t1 = F.lead + F.b1, t2 = t1 + F.tc;
  if (s < F.lead) return { ...kepler(GM, x.A, s), ax: 0, ay: 0, burn: 0 };
  if (s <= t1 && F.b1 > 0) return { ...sampleAt(F.S1, s), burn: 1 };
  if (s < t2 || F.b2 <= 0) return { ...kepler(GM, F.C, s - t1), ax: 0, ay: 0, burn: 0 };
  if (s <= t2 + F.b2) return { ...sampleAt(F.S2, s), burn: 2 };
  return { ...kepler(GM, F.E, s - t2 - F.b2), ax: 0, ay: 0, burn: 0 };
}

/** What a transfer burns: its two burns' Δv (m/s), all of it, or as far as `s` seconds in. */
export function xferDv(x, s = Infinity) {
  const lead = x.lead || 0, b1 = hyp(x.dv1) / x.acc, b2 = hyp(x.dv2) / x.acc, t2 = x.tof - (x.tail || 0) - b2;
  return x.acc * (Math.min(b1, Math.max(0, s - lead)) + Math.min(b2, Math.max(0, s - t2)));
}

/**
 * The directions a transfer's burns push along (unit vectors, the frame
 * that doesn't turn): { d1, d2 } (d2: as the last burn begins), and when
 * they run (s from the leg's start): the first from t0 to t1, the last from
 * t2 to t3.
 */
export function xferBurns(GM, x) {
  const F = xferFlight(GM, x), u = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
  const t1 = F.lead + F.b1, t2 = t1 + F.tc;
  return { d1: u(x.dv1), d2: F.S2.length ? u([F.S2[0].ax, F.S2[0].ay]) : u(x.dv2), t0: F.lead, t1, t2, t3: t2 + F.b2 };
}

// ---- LEGACY: the spiral legs of a save from before 1.12.8 ----
//
// Before 1.12.8 a drive's leg was a spiral round the world flown at speeds
// no drive could hold to it. A save's run on one is planned again on load
// (shuttles.js upgradeRuns), from where the old leg has it: these say where.

function legacyRadius(rA, rB, u, flat) {
  if (flat === 'end') return rB + (rA - rB) * (1 - u) * (1 - u);
  if (flat === 'start') return rA + (rB - rA) * u * u;
  const a = Math.log(rA), b = Math.log(rB);
  if (flat === 'both') return Math.exp(a + (b - a) * u * u * (3 - 2 * u));
  const u2 = u * u, u3 = u2 * u, m0 = flat.span * flat.t0, m1 = flat.span * flat.t1;
  return Math.exp((2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * m0 + (3 * u2 - 2 * u3) * b + (u3 - u2) * m1);
}

/** Where a legacy leg `g` had the craft `s` seconds in: { r, th, v }. */
export function legacyPlace(g, s) {
  const t1 = (g.vm - g.vA) / g.a;
  let d;
  if (s <= t1) d = g.vA * s + 0.5 * g.a * s * s;
  else { const tau = Math.min(s - t1, (g.vm - g.vB) / g.a); d = g.vA * t1 + 0.5 * g.a * t1 * t1 + g.vm * tau - 0.5 * g.a * tau * tau; }
  d += g.d0 || 0;
  const v = s <= t1 ? g.vA + g.a * s : Math.max(g.vB, g.vm - g.a * (s - t1));
  // (its length along the curve, step by step)
  const N = 400;
  let r0 = g.rA, L = 0;
  for (let i = 1; i <= N; i++) {
    const r1 = legacyRadius(g.rA, g.rB, i / N, g.flat), dl = Math.hypot(r1 - r0, 0.5 * (r0 + r1) * g.span / N);
    if (L + dl >= d) { const u = (i - 1 + (d - L) / dl) / N; return { r: legacyRadius(g.rA, g.rB, u, g.flat), th: g.thA + g.span * u, v }; }
    L += dl; r0 = r1;
  }
  return { r: g.rB, th: g.thA + g.span, v };
}

/**
 * The state at the top of the air (or HOVER_M over the pad, airless) over
 * ground angle `phi` at `minute`, going as profile `p` enters or leaves it
 * (its vRound and vRadial, in the frame that doesn't turn): { x, y, vx, vy }
 * (m, m/s from the world's centre). Where a transfer down must arrive, and
 * where one up begins.
 */
export function airState(w, p, phi, minute) {
  const th = worldAngle(w, phi, minute), r = w.R + p.topM, c = Math.cos(th), sn = Math.sin(th);
  return { x: r * c, y: r * sn, vx: p.vRadial * c - p.vRound * sn, vy: p.vRadial * sn + p.vRound * c };
}

// ---- RAILS: a flight path's place at any moment ----

/** A profile's point at `s` seconds in (interpolated). */
function profileAt(p, s) {
  const S = p.samples;
  if (s <= 0) return S[0];
  if (s >= p.t) return S[S.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].t <= s) lo = mid; else hi = mid; }
  const A = S[lo], B = S[hi], k = (s - A.t) / Math.max(1e-6, B.t - A.t);
  return { t: s, th: A.th + (B.th - A.th) * k, h: A.h + (B.h - A.h) * k, v: A.v + (B.v - A.v) * k, q: A.q + (B.q - A.q) * k, g: A.g + (B.g - A.g) * k };
}

/**
 * Where a craft on a flight path is at `minute` (fractional): { pos (AU),
 * vel (m/s), leg, h, v (its speed round the world), q, g } — the legs are
 * plain data (shuttles.js builds them): 'dock' (in its carrier), 'xfer' (a
 * transfer: burn, coast, burn), 'down' and 'up' (a profile from ground
 * angle phi0, or to it), 'ground', 'hold' (a free orbit at r from th0);
 * 'path' only in a save from before 1.12.8, until it is planned again.
 */
export function flightPathAt(world, path, minute) {
  const legs = path.legs;
  let leg = legs[0];
  for (const l of legs) { if (minute >= l.t0) leg = l; else break; }
  if (leg.kind === 'dock') {
    const carrier = carrierPlace(world, path.carrier, minute);
    return { pos: carrier.pos, vel: carrier.vel, leg: leg.kind, h: null, v: 0, q: 0, g: 0 };
  }
  const here = placeOnLeg(path, leg, minute);
  if (here.vel) return { ...here, leg: leg.kind };
  // (its velocity: its place a second on, along the same leg, less this one)
  const on = placeOnLeg(path, leg, minute + 1 / 60);
  return { ...here, vel: { vx: (on.pos.x - here.pos.x) * AU_M, vy: (on.pos.y - here.pos.y) * AU_M }, leg: leg.kind };
}

/** A craft's place on one leg of its path at `minute`: { pos (AU), h, v, q, g; vel (m/s) on a transfer }. */
export function placeOnLeg(path, leg, minute) {
  const w = worldOf(path.world);
  const s = Math.max(0, (minute - leg.t0) * MIN_S);
  if (leg.kind === 'xfer') {
    const c = bodyPos(w.body, minute / DAY_MIN), u = bodyVel(w.body, minute / DAY_MIN), p = xferAt(w.GM, leg.x, s), r = Math.hypot(p.x, p.y);
    return { pos: { x: c.x + p.x / AU_M, y: c.y + p.y / AU_M }, vel: { vx: u.vx + p.vx, vy: u.vy + p.vy }, h: r - w.R, v: Math.hypot(p.vx, p.vy), q: 0, g: Math.hypot(p.ax, p.ay) / G0 };
  }
  if (leg.kind === 'path') {
    const c = bodyPos(w.body, minute / DAY_MIN), p = legacyPlace(leg.g, s);
    return { pos: { x: c.x + p.r * Math.cos(p.th) / AU_M, y: c.y + p.r * Math.sin(p.th) / AU_M }, h: p.r - w.R, v: p.v, q: 0, g: leg.g.a / G0 };
  }
  if (leg.kind === 'hold') {
    // a circular orbit at radius r from th0 (waiting for its carrier: shuttles.js), free fall
    const c = bodyPos(w.body, minute / DAY_MIN), n = Math.sqrt(w.GM / leg.r ** 3), th = leg.th0 + n * s;
    return { pos: { x: c.x + leg.r * Math.cos(th) / AU_M, y: c.y + leg.r * Math.sin(th) / AU_M }, h: leg.r - w.R, v: n * leg.r, q: 0, g: 0 };
  }
  if (leg.kind === 'down' || leg.kind === 'up') {
    const prof = leg.kind === 'down' ? entryProfile(path.world, path.cls) : ascentProfile(path.world, path.cls);
    const pt = profileAt(prof, s);
    return { pos: groundPoint(w, leg.phi0 + pt.th, minute, pt.h), h: pt.h, v: pt.v, q: pt.q, g: pt.g };
  }
  return { pos: groundPoint(w, leg.phi, minute, 0), h: 0, v: 0, q: 0, g: w.GM / (w.R * w.R) / G0 };
}

/**
 * Our ship's place at a minute not now (on the orbit it holds, or its
 * coast): shuttles.js fills it in, as this module fills in world.js'
 * FLIGHT_PATH, so neither imports the navigation.
 */
export const PLAYER_AT = { at: null };

/** A carrier's place: our ship ('player'), or an entity's on its rails. */
export function carrierPlace(world, id, minute) {
  if (id === 'player') {
    if (PLAYER_AT.at && minute !== world.state.clock.minute) return PLAYER_AT.at(world.state, minute);
    const f = world.state.flight;
    return { pos: { x: f.pos.x, y: f.pos.y }, vel: { vx: f.vel.vx, vy: f.vel.vy } };
  }
  const e = world.get(id);
  return e ? predictEntity(e, minute, world) : { pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 } };
}

// (the world's rails ask this module for a flight path's place: world.js)
FLIGHT_PATH.at = (world, e, minute, pos, vel) => {
  const p = flightPathAt(world, e.flightPath, minute);
  pos.x = p.pos.x; pos.y = p.pos.y; vel.vx = p.vel.vx; vel.vy = p.vel.vy;
  // (in its carrier's bay it is part of the carrier: the sensors and the pictures pass it by; on the pad, the plot knows it
  // landed. Only as the world moves it: a look at where it will be, at another minute, leaves it as it is)
  if (pos !== e.pos) return;
  e.$inBay = p.leg === 'dock';
  e.$landed = p.leg === 'ground';
  // (and its drive, as every view and the sensors see a hull's: lit along its push on a burn, cold coasting)
  const d = driveOn(e.flightPath, minute);
  e.thrust = d.g;
  if (d.heading != null) e.heading = d.heading;
};

/**
 * A craft's drive on its flight path at `minute`: { g (G), heading (rad, the
 * way its nose points in the frame that doesn't turn; null: as it was) }.
 * On a transfer's burn, along the burn's push; coasting, held as the last
 * burn left it, turned for the next in the last minute before it (or, at
 * the top of the air coming down, the way it goes); climbing, along its
 * way at the climb's thrust; landing, up, at what the drive gives once the
 * glide is done (all of it, airless).
 */
export function driveOn(path, minute) {
  const legs = path.legs;
  let leg = legs[0];
  for (const l of legs) { if (minute >= l.t0) leg = l; else break; }
  const w = worldOf(path.world), s = Math.max(0, (minute - leg.t0) * MIN_S);
  if (leg.kind === 'xfer') {
    const q = xferAt(w.GM, leg.x, s), a = Math.hypot(q.ax, q.ay);
    if (a > 0.05) return { g: a / G0, heading: Math.atan2(q.ay, q.ax) };
    const B = xferBurns(w.GM, leg.x), d = s < B.t2 - 60 && B.t1 > B.t0 ? B.d1 : s < B.t3 ? B.d2 : null;
    return { g: 0, heading: d ? Math.atan2(d[1], d[0]) : Math.atan2(q.vy, q.vx) };
  }
  if (leg.kind === 'up' || leg.kind === 'down' || leg.kind === 'hold') {
    const c = bodyPos(w.body, minute / DAY_MIN), u = bodyVel(w.body, minute / DAY_MIN), p = placeOnLeg(path, leg, minute);
    const x = (p.pos.x - c.x) * AU_M, y = (p.pos.y - c.y) * AU_M;
    if (leg.kind === 'hold') return { g: 0, heading: Math.atan2(x, -y) };
    if (leg.kind === 'up') {
      const on = placeOnLeg(path, leg, minute + 1 / 60);
      return { g: ASCENT_THRUST * craftOf(path.cls).aMax / G0, heading: Math.atan2((on.pos.y - p.pos.y) * AU_M - u.vy, (on.pos.x - p.pos.x) * AU_M - u.vx) };
    }
    const powered = !w.atmo || p.h < POWERED_H || p.v < POWERED_MS;
    return { g: powered ? p.g : 0, heading: Math.atan2(y, x) };
  }
  return { g: 0, heading: null };
}
