// ============================================================
// LONGHAUL — Lambert's problem (universal variables, 2D)
// Given two positions round a body and a time of flight, find the
// ballistic (zero-thrust) orbit connecting them. Used for fuel-cheap
// transfers round the Sun and mid-course corrections, and for a shuttle's
// transfers round a world (planetary.js: its own GM, and no floor on the
// periapsis but the one its caller checks).
// Reference: Curtis, "Orbital Mechanics for Engineering Students", §5.3
// ============================================================

import { GM_SUN } from '../core/constants.js';

function stumpffC(z) {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + z * z / 720;
}

function stumpffS(z) {
  if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120 + z * z / 5040;
}

/**
 * Solve Lambert's problem for a prograde (counter-clockwise), single-revolution arc.
 * @param {number} r1x,r1y,r2x,r2y  positions in meters
 * @param {number} tof  time of flight in seconds (> 0)
 * @param {number} mu  the body's GM (m³/s²: the Sun's by default)
 * @param {number} rpMin  arcs whose periapsis, passed on the way, is inside this (m) are refused (0: none)
 * @returns {{v1x,v1y,v2x,v2y}|null} departure/arrival velocities in m/s, or null if no solution
 */
export function solveLambert(r1x, r1y, r2x, r2y, tof, mu = GM_SUN, rpMin = MIN_PERIHELION) {
  const r1 = Math.hypot(r1x, r1y);
  const r2 = Math.hypot(r2x, r2y);
  if (r1 === 0 || r2 === 0 || !(tof > 0)) return null;

  const cross = r1x * r2y - r1y * r2x;
  let cosDth = (r1x * r2x + r1y * r2y) / (r1 * r2);
  cosDth = Math.max(-1, Math.min(1, cosDth));
  let dth = Math.acos(cosDth);
  if (cross < 0) dth = 2 * Math.PI - dth;          // prograde: sweep counter-clockwise
  if (Math.abs(Math.sin(dth)) < 1e-9 && Math.abs(dth - Math.PI) < 1e-6) {
    dth += 1e-6;                                     // 180° transfer plane is undefined in 3D; nudge in 2D
  }

  const A = Math.sin(dth) * Math.sqrt(r1 * r2 / (1 - Math.cos(dth)));
  if (Math.abs(A) < 1e-9) return null;

  const sqrtMu = Math.sqrt(mu);
  const y = (z) => r1 + r2 + A * (z * stumpffS(z) - 1) / Math.sqrt(stumpffC(z));
  const F = (z) => {
    const yz = y(z);
    if (yz < 0) return NaN;
    const C = stumpffC(z);
    return Math.pow(yz / C, 1.5) * stumpffS(z) + A * Math.sqrt(yz) - sqrtMu * tof;
  };

  // F(z) increases monotonically on the domain where y(z) ≥ 0, reaching +∞ as
  // z → (2π)² (single revolution). Bracket the root from below by stepping
  // toward hyperbolic z < 0 until F < 0 or y(z) turns negative (where F < 0 too).
  let hi = 4 * Math.PI * Math.PI - 1e-6;
  if (!(F(hi) > 0)) return null;
  let lo = 0;
  let step = 1;
  let found = false;
  for (let i = 0; i < 64; i++) {
    const fz = F(lo);
    if (isNaN(fz)) {
      // Crossed the y = 0 boundary: F → −√μ·tof there, so the root lies above. Find the boundary.
      let a = lo, b = lo + step;
      for (let k = 0; k < 80; k++) { const m = 0.5 * (a + b); if (y(m) < 0) a = m; else b = m; }
      lo = b; found = F(lo) <= 0; break;
    }
    if (fz <= 0) { found = true; break; }
    hi = lo;
    lo -= step;
    step *= 2;
    if (lo < -1e6) break;
  }
  if (!found) return null;   // e.g. long prograde sweep in too short a time — no single-rev arc

  let z = 0;
  for (let i = 0; i < 200; i++) {
    z = 0.5 * (lo + hi);
    const fz = F(z);
    if (isNaN(fz)) { lo = z; continue; }
    if (fz > 0) hi = z; else lo = z;
    if (hi - lo < 1e-13 * Math.max(1, Math.abs(z))) break;
  }
  if (!(Math.abs(F(z)) < 1e-6 * sqrtMu * tof)) return null;

  const yz = y(z);
  const f = 1 - yz / r1;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / r2;
  if (Math.abs(g) < 1e-12) return null;
  const v1x = (r2x - f * r1x) / g;
  const v1y = (r2y - f * r1y) / g;

  // Reject sun-grazing arcs (perihelion inside ~0.15 AU): unflyable and numerically nasty.
  if (rpMin > 0) {
    const h = r1x * v1y - r1y * v1x;
    const v2 = v1x * v1x + v1y * v1y;
    const energy = v2 / 2 - mu / r1;
    const e = Math.sqrt(Math.max(0, 1 + 2 * energy * h * h / (mu * mu)));
    const rp = (h * h / mu) / (1 + e);
    // Perihelion only matters if it's actually traversed between r1 and r2
    if (rp < rpMin && rp < Math.min(r1, r2)) return null;
  }

  return {
    v1x, v1y,
    v2x: (gdot * r2x - r1x) / g,
    v2y: (gdot * r2y - r1y) / g,
  };
}

const MIN_PERIHELION = 0.15 * 149_597_870_700;
