// ============================================================
// LONGHAUL — Planetary flight: between orbit and a world's ground
//
// How a craft rated for an atmosphere (a big hull's shuttle, ship-
// classes.js BAYS; later a rated hull of our own) goes down to a world's
// ground and back up. Each stretch is flown as physics, once, and the craft
// rides what was flown afterwards on rails (a `flightPath`: world.js), so
// one shuttle or a hundred NPC ones cost the same:
//
//   DROP     from its carrier's high orbit down to the top of the air, on
//            the drive: a powered spiral round the world (pathLeg: a cubic
//            in the log of its radius, leaving level as the carrier goes
//            round and meeting the air at the entry's own angle), speeding
//            up, then braking to the speed it will enter at (in the frame
//            that doesn't turn: the ground's speed under it added), along
//            the path's length (measured in ARC_N steps)
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
//            through the air to its top (drag against it), and a powered
//            spiral back up to the carrier (pathLeg again: leaving at the
//            climb's speed and angle, alongside going round as it goes)
//
// The profiles depend only on the world and the craft (entryProfile,
// ascentProfile, cached): where a run lands, it starts upstream of the pad
// by the profile's own downrange, its drop leg aimed there for when it will
// arrive (shuttles.js plans it). Angles are a world's body-frame angles
// (worlds.js groundAngle) for the ground, and plane angles round its centre
// for orbit.
//
// Cost: an entry is a few thousand steps of a few dozen flops, once per
// world and craft; a path's place is a table lookup.
// ============================================================

import { AU_M, G0, DAY_MIN, MIN_S } from '../core/constants.js';
import { bodyPos, bodyVel } from './ephemeris.js';
import { worldOf, atmosphere, entryHeat, worldAngle, groundPoint } from './worlds.js';
import { CLASSES } from './ship-classes.js';
import { hullOf } from './hulls.js';
import { FLIGHT_PATH, getWorld, predictEntity } from './world.js';

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

// ---- THE DRIVE'S LEGS: a powered spiral round the world ----

/**
 * A powered leg round a world, in its plane (Θ eastward, round its centre):
 * from radius rA at ΘA to rB, `span` rad further on; the radius eased in so
 * the end is level (`flat: 'end'`), or the start (`'start'`), or both
 * (`'both'`), or at given angles ({ t0, t1, span }: a leg that leaves a
 * carrier going round with it and meets the air coming down into it, or
 * leaves the air climbing and comes alongside level); its speed along the
 * path from vA to vB under acceleration `a` (more, if the change of speed
 * wants more in the length), accelerating then braking. Returns the leg's
 * numbers, its length and time.
 */
export function pathLeg(rA, thA, rB, span, flat, vA, vB, a) {
  const L = spiralLength(rA, rB, span, flat);
  if (L > 1) a = Math.max(a, Math.abs(vA * vA - vB * vB) / (2 * L) * 1.02);
  const vm = Math.max(vA, vB, Math.sqrt((2 * a * L + vA * vA + vB * vB) / 2));
  const T = (vm - vA) / a + (vm - vB) / a;
  return { rA, thA, rB, span, flat, vA, vB, a, L, vm, T };
}
/**
 * The radius `u` of the way along a leg. `flat` names the shape: 'end'
 * (level at its end), 'start', 'both', or { t0, t1, span }: leaving at a
 * flight-path angle whose tangent is t0 and arriving at t1's (climbing out
 * of the air, coming down into it). 'both' and the angled shapes are a
 * cubic in the radius' logarithm (a spiral eased at both ends): a leg that
 * climbs from a world's air to ten times as far out within a radian round
 * bends gently all the way, not hard at its start.
 */
function radiusAt(rA, rB, u, flat) {
  if (flat === 'end') return rB + (rA - rB) * (1 - u) * (1 - u);
  if (flat === 'start') return rA + (rB - rA) * u * u;
  const a = Math.log(rA), b = Math.log(rB);
  if (flat === 'both') return Math.exp(a + (b - a) * u * u * (3 - 2 * u));
  // (d ln r / du = span · tan γ at each end)
  const u2 = u * u, u3 = u2 * u, m0 = flat.span * flat.t0, m1 = flat.span * flat.t1;
  return Math.exp((2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * m0 + (3 * u2 - 2 * u3) * b + (u3 - u2) * m1);
}
/**
 * A leg's length along its curve, sample by sample (ARC_N of them: a curve
 * that climbs steeply out of the air changes fast at its start, and too
 * few samples there place the craft too slowly along it): the cumulative
 * length at each sample. Kept beside the leg, not in it (the save carries
 * the leg's numbers only; a loaded leg works it out again).
 */
const ARC_N = 400;
const _arcs = new WeakMap();
function arcTable(rA, rB, span, flat) {
  const Ls = new Float64Array(ARC_N + 1);
  let r0 = rA;
  for (let i = 1; i <= ARC_N; i++) {
    const u = i / ARC_N, r1 = radiusAt(rA, rB, u, flat);
    Ls[i] = Ls[i - 1] + Math.hypot(r1 - r0, 0.5 * (r0 + r1) * span / ARC_N);
    r0 = r1;
  }
  return Ls;
}
const arcOf = (g) => { let t = _arcs.get(g); if (!t) { t = arcTable(g.rA, g.rB, g.span, g.flat); _arcs.set(g, t); } return t; };
function spiralLength(rA, rB, span, flat) { return arcTable(rA, rB, span, flat)[ARC_N]; }
/**
 * How far along a leg (m) it is `s` seconds in. (A leg cut from another, a
 * shuttle braking along the way it was flying, starts `d0` along it.)
 */
export function distanceAt(g, s) {
  const t1 = (g.vm - g.vA) / g.a, d0 = g.d0 || 0;
  if (s <= t1) return d0 + g.vA * s + 0.5 * g.a * s * s;
  const s1 = g.vA * t1 + 0.5 * g.a * t1 * t1, tau = Math.min(s - t1, (g.vm - g.vB) / g.a);
  return d0 + s1 + g.vm * tau - 0.5 * g.a * tau * tau;
}
/** Its speed along a leg `s` seconds in (m/s). */
export function speedAt(g, s) {
  const t1 = (g.vm - g.vA) / g.a;
  return s <= t1 ? g.vA + g.a * s : Math.max(g.vB, g.vm - g.a * (s - t1));
}
/** The place on a leg `dist` metres along it: { r, th }. */
export function placeAlong(g, dist) {
  const Ls = arcOf(g);
  if (dist <= 0) return { r: g.rA, th: g.thA };
  if (dist >= Ls[ARC_N]) return { r: g.rB, th: g.thA + g.span };
  let lo = 0, hi = ARC_N;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Ls[mid] <= dist) lo = mid; else hi = mid; }
  const dl = Ls[hi] - Ls[lo], uu = (lo + (dl > 0 ? (dist - Ls[lo]) / dl : 0)) / ARC_N;
  return { r: radiusAt(g.rA, g.rB, uu, g.flat), th: g.thA + g.span * uu };
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
 * vel (m/s), leg, h, v (along its leg), q, g } — the legs are plain data
 * (shuttles.js builds them): 'dock' (in its carrier), 'path' (a pathLeg),
 * 'down' and 'up' (a profile from ground angle phi0, or to it), 'ground',
 * 'hold' (a free orbit at r from th0).
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
  // (its velocity: its place a second on, along the same leg, less this one)
  const on = placeOnLeg(path, leg, minute + 1 / 60);
  return { ...here, vel: { vx: (on.pos.x - here.pos.x) * AU_M, vy: (on.pos.y - here.pos.y) * AU_M }, leg: leg.kind };
}

/** A craft's place on one leg of its path at `minute`: { pos (AU), h, v, q, g }. */
export function placeOnLeg(path, leg, minute) {
  const w = worldOf(path.world);
  const s = Math.max(0, (minute - leg.t0) * MIN_S);
  if (leg.kind === 'path') {
    const c = bodyPos(w.body, minute / DAY_MIN);
    const p = placeAlong(leg.g, distanceAt(leg.g, s));
    return { pos: { x: c.x + p.r * Math.cos(p.th) / AU_M, y: c.y + p.r * Math.sin(p.th) / AU_M }, h: p.r - w.R, v: speedAt(leg.g, s), q: 0, g: leg.g.a / G0 };
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
 * How long an NPC carrier's shuttles take to move `tonnes` to a world's
 * ground from its parking orbit, by trips (min): the traffic's outcome when
 * nobody is near to see it (traffic.js).
 */
const _trips = new Map();
export function runMinutes(worldName, cls, tonnes, shuttles = 1) {
  const key = `${worldName}|${cls}`;
  let trip = _trips.get(key);
  if (trip === undefined) {
    // (one trip, as ours are flown: from the parking orbit going round with it, into the air at the entry's speed, and back; worked out once)
    const w = worldOf(worldName), down = entryProfile(worldName, cls), up = ascentProfile(worldName, cls);
    if (!w || !down || !up) trip = null;
    else {
      const acc = craftOf(cls).aCruise, vPark = Math.sqrt(w.GM / w.parkM);
      const leg = (rA, rB, vA, vB) => pathLeg(rA, 0, rB, 1, 'both', vA, vB, acc).T / 60;
      trip = LAUNCH_MIN + leg(w.parkM, w.R + down.topM, vPark, down.vRound) + down.t / 60 + GROUND_MIN + up.t / 60 + leg(w.R + up.topM, w.parkM, up.vRound, vPark) + RECOVER_MIN;
    }
    _trips.set(key, trip);
  }
  if (trip == null) return null;
  const trips = Math.max(1, Math.ceil(tonnes / Math.max(1, CLASSES[cls].cargoT) / shuttles));
  return trip * trips;
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
  // (in its carrier's bay it is part of the carrier: the sensors and the pictures pass it by)
  e.$inBay = p.leg === 'dock';
};
