// ============================================================
// LONGHAUL — Hulls and stations as 3D meshes
//
// The same physical models the sim flies (sim/hulls.js, sim/stations.js),
// built into lit geometry for the GPU (ships3d.js). A hull is still its
// stack of modules: every deck a pressure can with bevelled plating, a
// frame ring where it meets the next and a row of ports round its middle
// (the bridge a band of viewports), the armour of a warship laid over
// them in plates. Then what a real hull carries outside, from the model
// where it has it and made up (seeded by the class, so a class always
// looks the same) where it doesn't: docking collars with their rims and
// hatches, cargo doors, RCS quads at the corners, conduits along the
// spine, handholds, antennas, the faction's band round the bridge, nav
// lights. Tanks have domed ends and weld seams, trusses are lattices,
// radiators are fin panels, the drive a bell of revolution with its
// throat and gimbal ring, PDC turrets domes with their barrels, sensors
// dishes and masts, ice cut and cratered.
//
// A vertex: position (m, the model's frame), normal, albedo (linear
// RGB), material (MAT below: how the surface shades: ships3d.js).
// Meshes are made once per class or station and kept.
// ============================================================

import { linear } from './gl.js';

/** Surfaces (the shader's switch): keep in step with ships3d.js. */
export const MAT = {
  PLATE: 0, ARMOR: 1, MACHINE: 2, RADIATOR: 3, TANK: 4, TRUSS: 5, BELL: 6, BELL_IN: 7,
  WINDOW: 8, DARK: 9, BAND: 10, LIGHT_R: 11, LIGHT_G: 12, LIGHT_W: 13, FOIL: 14, ICE: 15,
  CONTAINER: 16, CERAMIC: 17, PAINT: 18, GROUND: 19, LAMP: 20, HAZARD: 21, MLI: 22,
};

const FLOATS = 10;

class MeshBuilder {
  constructor() { this.v = []; }

  push(p, n, c, m) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], m); }

  tri(a, b, c, col, mat, n = null) {
    if (!n) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      n = nrm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    }
    this.push(a, n, col, mat); this.push(b, n, col, mat); this.push(c, n, col, mat);
  }

  /** A quad a→b→c→d (counter-clockwise seen from outside). */
  quad(a, b, c, d, col, mat, n = null) { this.tri(a, b, c, col, mat, n); this.tri(a, c, d, col, mat, n); }

  /** An axis-aligned box, its edges chamfered by `bev` (m). */
  box(x0, x1, y0, y1, z0, z1, col, mat, bev = 0) {
    bev = Math.max(0, Math.min(bev, (x1 - x0) * 0.3, (y1 - y0) * 0.3, (z1 - z0) * 0.3));
    if (bev < 1e-3) {
      this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, mat, [1, 0, 0]);
      this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], col, mat, [-1, 0, 0]);
      this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], col, mat, [0, 1, 0]);
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, mat, [0, -1, 0]);
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, mat, [0, 0, 1]);
      this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], col, mat, [0, 0, -1]);
      return;
    }
    // a chamfered box: the 6 faces inset, 12 edge strips, 8 corner triangles
    const b = bev;
    const X = [x0, x0 + b, x1 - b, x1], Y = [y0, y0 + b, y1 - b, y1], Z = [z0, z0 + b, z1 - b, z1];
    const P = (i, j, k) => [X[i], Y[j], Z[k]];
    // faces
    this.quad(P(3, 1, 1), P(3, 2, 1), P(3, 2, 2), P(3, 1, 2), col, mat, [1, 0, 0]);
    this.quad(P(0, 2, 1), P(0, 1, 1), P(0, 1, 2), P(0, 2, 2), col, mat, [-1, 0, 0]);
    this.quad(P(2, 3, 1), P(1, 3, 1), P(1, 3, 2), P(2, 3, 2), col, mat, [0, 1, 0]);
    this.quad(P(1, 0, 1), P(2, 0, 1), P(2, 0, 2), P(1, 0, 2), col, mat, [0, -1, 0]);
    this.quad(P(1, 1, 3), P(2, 1, 3), P(2, 2, 3), P(1, 2, 3), col, mat, [0, 0, 1]);
    this.quad(P(1, 2, 0), P(2, 2, 0), P(2, 1, 0), P(1, 1, 0), col, mat, [0, 0, -1]);
    const s = Math.SQRT1_2, t = 1 / Math.sqrt(3);
    // edges along x
    this.quad(P(1, 3, 2), P(1, 2, 3), P(2, 2, 3), P(2, 3, 2), col, mat, [0, s, s]);
    this.quad(P(1, 1, 3), P(1, 0, 2), P(2, 0, 2), P(2, 1, 3), col, mat, [0, -s, s]);
    this.quad(P(1, 2, 0), P(1, 3, 1), P(2, 3, 1), P(2, 2, 0), col, mat, [0, s, -s]);
    this.quad(P(1, 0, 1), P(1, 1, 0), P(2, 1, 0), P(2, 0, 1), col, mat, [0, -s, -s]);
    // edges along y
    this.quad(P(3, 1, 2), P(3, 2, 2), P(2, 2, 3), P(2, 1, 3), col, mat, [s, 0, s]);
    this.quad(P(1, 1, 3), P(1, 2, 3), P(0, 2, 2), P(0, 1, 2), col, mat, [-s, 0, s]);
    this.quad(P(2, 1, 0), P(2, 2, 0), P(3, 2, 1), P(3, 1, 1), col, mat, [s, 0, -s]);
    this.quad(P(0, 1, 1), P(0, 2, 1), P(1, 2, 0), P(1, 1, 0), col, mat, [-s, 0, -s]);
    // edges along z
    this.quad(P(3, 2, 1), P(2, 3, 1), P(2, 3, 2), P(3, 2, 2), col, mat, [s, s, 0]);
    this.quad(P(2, 0, 1), P(3, 1, 1), P(3, 1, 2), P(2, 0, 2), col, mat, [s, -s, 0]);
    this.quad(P(1, 3, 1), P(0, 2, 1), P(0, 2, 2), P(1, 3, 2), col, mat, [-s, s, 0]);
    this.quad(P(0, 1, 1), P(1, 0, 1), P(1, 0, 2), P(0, 1, 2), col, mat, [-s, -s, 0]);
    // corners
    for (const [i, j, k] of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]) {
      const xi = i > 0 ? 3 : 0, yi = j > 0 ? 3 : 0, zi = k > 0 ? 3 : 0;
      const xo = i > 0 ? 2 : 1, yo = j > 0 ? 2 : 1, zo = k > 0 ? 2 : 1;
      const a = P(xi, yo, zo), bb = P(xo, yi, zo), c = P(xo, yo, zi);
      const n = [i * t, j * t, k * t];
      if (i * j * k > 0) this.tri(a, bb, c, col, mat, n); else this.tri(a, c, bb, col, mat, n);
    }
  }

  /**
   * A body of revolution about the x axis through (cy, cz): profile
   * [[x, r], ...] in order; normals smoothed round. `inside`: the faces turn in.
   */
  lathe(profile, seg, cy, cz, col, mat, inside = false, a0 = 0, a1 = Math.PI * 2) {
    const ring = [];
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (a1 - a0) * k / seg;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    for (let i = 0; i < profile.length - 1; i++) {
      const [xa, ra] = profile[i], [xb, rb] = profile[i + 1];
      // normal of the profile segment (in x–r)
      const dx = xb - xa, dr = rb - ra, L = Math.hypot(dx, dr) || 1;
      let nx = -dr / L, nr = dx / L;
      if (xb < xa) { nx = -nx; nr = -nr; }
      if (inside) { nx = -nx; nr = -nr; }
      for (let k = 0; k < seg; k++) {
        const [c0, s0] = ring[k], [c1, s1] = ring[k + 1];
        const A = [xa, cy + ra * c0, cz + ra * s0], B = [xa, cy + ra * c1, cz + ra * s1];
        const C = [xb, cy + rb * c1, cz + rb * s1], D = [xb, cy + rb * c0, cz + rb * s0];
        const n0 = [nx, nr * c0, nr * s0], n1 = [nx, nr * c1, nr * s1];
        const flip = (xb > xa) !== inside;
        if (flip) {
          this.push(A, n0, col, mat); this.push(C, n1, col, mat); this.push(B, n1, col, mat);
          this.push(A, n0, col, mat); this.push(D, n0, col, mat); this.push(C, n1, col, mat);
        } else {
          this.push(A, n0, col, mat); this.push(B, n1, col, mat); this.push(C, n1, col, mat);
          this.push(A, n0, col, mat); this.push(C, n1, col, mat); this.push(D, n0, col, mat);
        }
      }
    }
  }

  /** A cylinder along x from x0 to x1 at (cy, cz), radius r; caps: 'flat' | 'dome' | null at each end. */
  cylX(x0, x1, r, cy, cz, seg, col, mat, cap0 = 'flat', cap1 = 'flat') {
    const prof = [];
    const dome = (xe, dir) => { const pts = []; for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; pts.push([xe + dir * Math.sin(a) * r * 0.45, Math.cos(a) * r]); } return pts; };
    if (cap0 === 'dome') prof.push(...dome(x0, -1).reverse());
    else if (cap0 === 'flat') prof.push([x0, 0.0001]);
    prof.push([x0, r], [x1, r]);
    if (cap1 === 'dome') prof.push(...dome(x1, 1));
    else if (cap1 === 'flat') prof.push([x1, 0.0001]);
    // (the flat caps: the profile runs into the axis)
    this.lathe(prof, seg, cy, cz, col, mat);
  }

  /** A tapered tube between two points (any axis), radii r0 → r1, closed with flat caps. */
  tube(p0, p1, r0, r1, seg, col, mat, caps = true) {
    const ax = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const L = Math.hypot(ax[0], ax[1], ax[2]);
    if (L < 1e-6) return;
    const f = [ax[0] / L, ax[1] / L, ax[2] / L];
    const ref = Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const u = nrm(crs(f, ref)), w = crs(f, u);
    const at = (p, r, a) => [p[0] + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * r, p[1] + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * r, p[2] + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * r];
    const dn = (r0 - r1) / L;
    for (let k = 0; k < seg; k++) {
      const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
      const n0 = nrm([u[0] * Math.cos(a0) + w[0] * Math.sin(a0) + f[0] * dn, u[1] * Math.cos(a0) + w[1] * Math.sin(a0) + f[1] * dn, u[2] * Math.cos(a0) + w[2] * Math.sin(a0) + f[2] * dn]);
      const n1 = nrm([u[0] * Math.cos(a1) + w[0] * Math.sin(a1) + f[0] * dn, u[1] * Math.cos(a1) + w[1] * Math.sin(a1) + f[1] * dn, u[2] * Math.cos(a1) + w[2] * Math.sin(a1) + f[2] * dn]);
      const A = at(p0, r0, a0), B = at(p0, r0, a1), C = at(p1, r1, a1), D = at(p1, r1, a0);
      this.push(A, n0, col, mat); this.push(B, n1, col, mat); this.push(C, n1, col, mat);
      this.push(A, n0, col, mat); this.push(C, n1, col, mat); this.push(D, n0, col, mat);
      if (caps) {
        this.tri(p1, D, C, col, mat, f);
        this.tri(p0, B, A, col, mat, [-f[0], -f[1], -f[2]]);
      }
    }
  }

  sphere(c, r, seg, col, mat, sz = 1) {
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg * Math.PI, t1 = (i + 1) / seg * Math.PI;
      for (let k = 0; k < seg * 2; k++) {
        const p0 = k / (seg * 2) * Math.PI * 2, p1 = (k + 1) / (seg * 2) * Math.PI * 2;
        const v = (t, p) => [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t) * sz];
        const a = v(t0, p0), b = v(t1, p0), cc = v(t1, p1), d = v(t0, p1);
        const P = (n) => [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r];
        this.push(P(a), nrm(a), col, mat); this.push(P(b), nrm(b), col, mat); this.push(P(cc), nrm(cc), col, mat);
        this.push(P(a), nrm(a), col, mat); this.push(P(cc), nrm(cc), col, mat); this.push(P(d), nrm(d), col, mat);
      }
    }
  }

  data() { return new Float32Array(this.v); }
}

const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A small seeded generator (a class always gets the same fittings). */
function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  s ||= 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---- COLOURS ----
// Albedos as a camera sees them in sunlight (linear, multiplied by light in the shader)

const C = (hex) => linear(hex);
const TONES = {
  plate: C('#9AA1A8'), plateWarm: C('#A49C90'), plateDark: C('#6E757D'), armor: C('#5D636A'), machine: C('#7C838B'),
  reactor: C('#8A8F96'), radiator: C('#3A4047'), tank: C('#B7BCC1'), truss: C('#80878F'), bell: C('#4A4E56'), mli: C('#D8D9D4'),
  bellIn: C('#A9AEB4'), dark: C('#101215'), window: C('#FFD49A'), foil: C('#C8A048'), ice: C('#DCEAF2'),
  ceramic: C('#202224'), paint: C('#C9C3B6'), steel: C('#8C9196'), leg: C('#8A8F96'), gear: C('#B08C3E'), white: C('#E6E8EA'),
  groundworks: C('#5E5852'), hab: C('#A8AEB4'), dock: C('#8D949B'), yard: C('#5D646C'), cargo: C('#8E8578'),
};
const CONTAINER_TONES = ['#7A4B3B', '#3F596B', '#8A7445', '#4E6149', '#6B4549', '#59626D', '#968D7C', '#6E6A60'].map(C);

/** Builders by TL: how worn a hull is shows in its tone (Belt refits patched, Mars clean). */
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

function weather(c, tl, r) {
  const k = tl <= 1 ? 0.18 : tl === 2 ? 0.1 : tl === 3 ? 0.06 : 0.03;
  const j = (r() - 0.5) * 2 * k;
  return [Math.max(0, c[0] * (1 + j)), Math.max(0, c[1] * (1 + j * 0.9)), Math.max(0, c[2] * (1 + j * 0.8))];
}

// ---- HULLS ----

const PRESSURE = new Set(['hab', 'command', 'cargo', 'machinery', 'reactor', 'hold']);

/**
 * The mesh of a hull model (sim/hulls.js) for a class with tech level `tl`.
 * Returns { data: Float32Array, count, lights: [{ p, kind }], bell, pdcs: [{ p, dir }] }.
 */
export function buildHullMesh(hull, tl = 2, seed = 'hull') {
  const mb = new MeshBuilder();
  const r = rng(seed);
  const W = hull.W, H = hull.H, L = hull.L;
  const bevelFor = (w, h) => Math.min(0.6, Math.min(w, h) * 0.07);
  const info = { lights: [], pdcs: [], bell: null, stripeDone: false };
  const seg = (rr) => Math.max(10, Math.min(36, Math.round(rr * 4 + 10)));
  let ci = 0;
  const modules = hull.parts.filter(p => p.k === 'box' && PRESSURE.has(p.role));
  for (const p of hull.parts) {
    if (p.k === 'box') boxPart(mb, p, r, tl, info, ci++, bevelFor);
    else if (p.k === 'cyl') tankPart(mb, p, r, tl, seg(p.r));
    else if (p.k === 'bell') bellPart(mb, p, info);
    else if (p.k === 'ring') ringPart(mb, p, tl, r);
  }
  // Frame rings where one module meets the next, and a spine of conduits along the top
  modules.sort((a, b) => b.x1 - a.x1);
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i], w = m.y1 - m.y0, h = m.z1 - m.z0;
    const t = Math.min(0.35, (m.x1 - m.x0) * 0.06);
    const o = Math.min(0.12, Math.min(w, h) * 0.02);
    for (const x of [m.x1 - t / 2, m.x0 + t / 2]) mb.box(x - t / 2, x + t / 2, m.y0 - o, m.y1 + o, m.z0 - o, m.z1 + o, weather(mix(TONES.plate, TONES.plateDark, 0.5), tl, r), MAT.MACHINE, o * 0.8);
  }
  // Collars, cargo doors
  for (const pt of hull.ports) collar(mb, pt, hull);
  for (const h of hull.hatches) hatch(mb, h, hull);
  // RCS quads at the corners of the bow and stern modules
  if (modules.length) {
    const bow = modules[0], stern = modules[modules.length - 1];
    for (const m of [bow, stern]) {
      const x = m === bow ? m.x1 - Math.min(1.5, (m.x1 - m.x0) * 0.3) : m.x0 + Math.min(1.5, (m.x1 - m.x0) * 0.3);
      for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) rcsQuad(mb, x, sy * m.y1 * 0.98, sz * m.z1 * 0.98, sy, sz, Math.max(0.25, Math.min(0.9, W * 0.04)));
    }
    // nav lights: red to port, green to starboard at the bow's shoulders; a white strobe aft
    const wide = modules.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a));
    const rl = Math.max(0.12, Math.min(0.5, W * 0.02));
    mb.sphere([wide.x1 - 0.5, wide.y0 - rl, 0], rl, 6, TONES.white, MAT.LIGHT_R);
    mb.sphere([wide.x1 - 0.5, wide.y1 + rl, 0], rl, 6, TONES.white, MAT.LIGHT_G);
    mb.sphere([stern.x0 + 0.4, 0, stern.z1 + rl], rl, 6, TONES.white, MAT.LIGHT_W);
    info.lights.push({ p: [wide.x1 - 0.5, wide.y0 - rl, 0], kind: 'red' }, { p: [wide.x1 - 0.5, wide.y1 + rl, 0], kind: 'green' }, { p: [stern.x0 + 0.4, 0, stern.z1 + rl], kind: 'strobe' });
  }
  const data = mb.data();
  return { data, count: data.length / FLOATS, ...info, L, W, H };
}

function boxPart(mb, p, r, tl, info, i, bevelFor) {
  const w = p.y1 - p.y0, h = p.z1 - p.z0, len = p.x1 - p.x0;
  const bev = bevelFor(w, h);
  switch (p.role) {
    case 'command': case 'hab': case 'cargo': case 'hold': case 'machinery': case 'reactor': {
      const tone = p.role === 'machinery' ? TONES.machine : p.role === 'reactor' ? TONES.reactor : p.role === 'cargo' || p.role === 'hold' ? TONES.plateWarm : TONES.plate;
      const mat = p.role === 'machinery' || p.role === 'reactor' ? MAT.MACHINE : MAT.PLATE;
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(tone, tl, r), mat, bev);
      if (p.role === 'command' || p.role === 'hab') portholes(mb, p, p.role === 'command');
      if (p.role === 'reactor') {
        // the hazard band round the reactor deck
        const x = (p.x0 + p.x1) / 2, t = Math.min(0.18, len * 0.04), o = 0.03;
        mb.box(x - t, x + t, p.y0 - o, p.y1 + o, p.z0 - o, p.z1 + o, TONES.gear, MAT.HAZARD, 0);
      }
      if (p.role === 'command' && !info.stripeDone) {
        // the faction's band round the bridge
        info.stripeDone = true;
        const t = Math.min(0.6, len * 0.08), x = p.x0 + len * 0.3, o = 0.04;
        mb.box(x - t / 2, x + t / 2, p.y0 - o, p.y1 + o, p.z0 - o, p.z1 + o, TONES.white, MAT.BAND, 0);
      }
      greebles(mb, p, r, tl);
      break;
    }
    case 'armor': {
      // plates laid over the hull: the sides and the top and bottom, a gap between
      const n = Math.max(2, Math.round(len / Math.max(3, h * 0.6)));
      const gap = Math.min(0.15, len * 0.006);
      for (let k = 0; k < n; k++) {
        const a = p.x0 + (len * k) / n + gap, b = p.x0 + (len * (k + 1)) / n - gap;
        const tone = weather(TONES.armor, tl, r);
        const t = Math.min(0.5, w * 0.05);
        mb.box(a, b, p.y0, p.y0 + t, p.z0 + t, p.z1 - t, tone, MAT.ARMOR, t * 0.4);
        mb.box(a, b, p.y1 - t, p.y1, p.z0 + t, p.z1 - t, tone, MAT.ARMOR, t * 0.4);
        mb.box(a, b, p.y0 + t * 0.6, p.y1 - t * 0.6, p.z1 - t, p.z1, tone, MAT.ARMOR, t * 0.4);
        mb.box(a, b, p.y0 + t * 0.6, p.y1 - t * 0.6, p.z0, p.z0 + t, tone, MAT.ARMOR, t * 0.4);
      }
      break;
    }
    case 'radiator': {
      // a fin panel, thin and broad, edge-on to the plume; a frame round it, the coolant manifold along its root
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, TONES.radiator, MAT.RADIATOR, 0);
      const t = Math.max(0.08, Math.min(0.3, (p.x1 - p.x0) * 0.01)), o = 0.025;
      const flatZ = (p.z1 - p.z0) <= (p.y1 - p.y0);
      if (flatZ) {
        const root = Math.abs(p.y0) < Math.abs(p.y1) ? p.y0 : p.y1, tip = root === p.y0 ? p.y1 : p.y0, d = Math.sign(tip - root);
        mb.box(p.x0, p.x0 + t, p.y0, p.y1, p.z0 - o, p.z1 + o, TONES.truss, MAT.MACHINE);
        mb.box(p.x1 - t, p.x1, p.y0, p.y1, p.z0 - o, p.z1 + o, TONES.truss, MAT.MACHINE);
        mb.box(p.x0, p.x1, Math.min(tip, tip - d * t), Math.max(tip, tip - d * t), p.z0 - o, p.z1 + o, TONES.truss, MAT.MACHINE);
        mb.tube([p.x0, root + d * t, (p.z0 + p.z1) / 2], [p.x1, root + d * t, (p.z0 + p.z1) / 2], t * 0.9, t * 0.9, 8, TONES.mli, MAT.MLI);
      } else {
        const root = Math.abs(p.z0) < Math.abs(p.z1) ? p.z0 : p.z1, tip = root === p.z0 ? p.z1 : p.z0, d = Math.sign(tip - root);
        mb.box(p.x0, p.x0 + t, p.y0 - o, p.y1 + o, p.z0, p.z1, TONES.truss, MAT.MACHINE);
        mb.box(p.x1 - t, p.x1, p.y0 - o, p.y1 + o, p.z0, p.z1, TONES.truss, MAT.MACHINE);
        mb.box(p.x0, p.x1, p.y0 - o, p.y1 + o, Math.min(tip, tip - d * t), Math.max(tip, tip - d * t), TONES.truss, MAT.MACHINE);
        mb.tube([p.x0, (p.y0 + p.y1) / 2, root + d * t], [p.x1, (p.y0 + p.y1) / 2, root + d * t], t * 0.9, t * 0.9, 8, TONES.mli, MAT.MLI);
      }
      break;
    }
    case 'truss': lattice(mb, p, TONES.truss); break;
    case 'pdc': turret(mb, p, info); break;
    case 'tube': {
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(TONES.machine, tl, r), MAT.MACHINE, bev);
      // the muzzle doors at the forward end
      const n = 2, ww = (p.y1 - p.y0) / n;
      for (let k = 0; k < n; k++) mb.box(p.x1 - 0.02, p.x1 + 0.05, p.y0 + ww * k + ww * 0.15, p.y0 + ww * (k + 1) - ww * 0.15, p.z0 + (p.z1 - p.z0) * 0.15, p.z1 - (p.z1 - p.z0) * 0.15, TONES.dark, MAT.DARK);
      break;
    }
    case 'rail': {
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(TONES.armor, tl, r), MAT.ARMOR, bev);
      const n = Math.max(3, Math.round((p.x1 - p.x0) / 4));
      for (let k = 1; k < n; k++) { const x = p.x0 + (p.x1 - p.x0) * k / n; mb.box(x - 0.2, x + 0.2, p.y0 - 0.12, p.y1 + 0.12, p.z0 - 0.12, p.z1 + 0.12, TONES.truss, MAT.MACHINE); }
      mb.box(p.x1, p.x1 + 0.6, p.y0 + w * 0.25, p.y1 - w * 0.25, p.z0 + h * 0.25, p.z1 - h * 0.25, TONES.dark, MAT.DARK);
      break;
    }
    case 'sensor': {
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, TONES.white, MAT.PAINT, bev);
      // a dish and a mast on top
      const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2, top = p.z1;
      const R = Math.max(0.4, Math.min(w, len) * 0.45);
      mb.tube([cx, cy, top], [cx, cy, top + R * 0.6], R * 0.08, R * 0.06, 8, TONES.truss, MAT.TRUSS);
      dish(mb, [cx, cy, top + R * 0.6], R, [0.4, 0.3, 0.86]);
      mb.tube([p.x0 + len * 0.2, cy + w * 0.3, top], [p.x0 + len * 0.2, cy + w * 0.3, top + R * 1.6], R * 0.03, R * 0.02, 6, TONES.white, MAT.PAINT);
      break;
    }
    case 'container': {
      // a box of corrugated steel: corner posts and end frames darker, the doors' locking bars at one end
      const tone = CONTAINER_TONES[Math.floor(r() * CONTAINER_TONES.length)];
      const e = Math.max(0.12, Math.min(0.35, Math.min(w, h) * 0.035));
      mb.box(p.x0 + e * 0.3, p.x1 - e * 0.3, p.y0 + e * 0.25, p.y1 - e * 0.25, p.z0 + e * 0.25, p.z1 - e * 0.25, weather(tone, 1, r), MAT.CONTAINER, 0);
      const fr = weather(mix(tone, TONES.dark, 0.45), 1, r);
      for (const y of [p.y0, p.y1 - e]) for (const z of [p.z0, p.z1 - e]) mb.box(p.x0, p.x1, y, y + e, z, z + e, fr, MAT.MACHINE);
      for (const x of [p.x0, p.x1 - e]) {
        mb.box(x, x + e, p.y0, p.y1, p.z0, p.z0 + e, fr, MAT.MACHINE); mb.box(x, x + e, p.y0, p.y1, p.z1 - e, p.z1, fr, MAT.MACHINE);
        mb.box(x, x + e, p.y0, p.y0 + e, p.z0, p.z1, fr, MAT.MACHINE); mb.box(x, x + e, p.y1 - e, p.y1, p.z0, p.z1, fr, MAT.MACHINE);
      }
      const nb = Math.max(2, Math.round(w / 1.2));
      for (let k = 0; k < nb; k++) { const y = p.y0 + w * (k + 0.5) / nb; mb.box(p.x1, p.x1 + e * 0.3, y - e * 0.12, y + e * 0.12, p.z0 + e, p.z1 - e, TONES.steel, MAT.MACHINE); }
      break;
    }
    case 'ice': ice(mb, p, r); break;
    case 'shield': mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, TONES.ceramic, MAT.CERAMIC, bev); break;
    case 'leg': {
      const cy = (p.y0 + p.y1) / 2, cz = (p.z0 + p.z1) / 2, rr = Math.min(w, h) * 0.4;
      mb.tube([p.x1, cy, cz], [p.x0, cy, cz], rr, rr * 0.8, 8, TONES.leg, MAT.MACHINE);
      mb.cylX(p.x0 - rr * 0.6, p.x0, rr * 2.2, cy, cz, 10, TONES.leg, MAT.MACHINE);
      break;
    }
    case 'gear': {
      mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(TONES.gear, 1, r), MAT.PAINT, bev);
      const cy = (p.y0 + p.y1) / 2, cz = (p.z0 + p.z1) / 2;
      mb.tube([p.x1, cy, cz], [p.x1 + Math.min(4, (p.x1 - p.x0) * 0.2), cy, cz], Math.min(w, h) * 0.3, Math.min(w, h) * 0.25, 10, TONES.dark, MAT.MACHINE);
      break;
    }
    default: mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(TONES.plateDark, tl, r), MAT.MACHINE, bev);
  }
}

/** A row of lit ports round a deck's middle (the bridge: a band of viewports). */
function portholes(mb, p, bridge) {
  const len = p.x1 - p.x0, h = p.z1 - p.z0, w = p.y1 - p.y0;
  const zc = (p.z0 + p.z1) / 2 + h * 0.08;
  const ph = Math.max(0.16, Math.min(0.42, h * 0.05)), pw = bridge ? Math.max(0.4, Math.min(0.9, len * 0.07)) : ph * 1.3;
  const step = bridge ? pw * 1.7 : Math.max(pw * 2.6, 1.7);
  const n = Math.max(1, Math.floor((len - step * 0.6) / step));
  const x0 = (p.x0 + p.x1) / 2 - (n - 1) * step / 2;
  const o = 0.025;
  const f = Math.max(0.05, ph * 0.18);
  for (let k = 0; k < n; k++) {
    const x = x0 + k * step;
    for (const y of [p.y1 + o * 0.5, p.y0 - o * 0.5]) mb.box(x - pw / 2 - f, x + pw / 2 + f, Math.min(y, y + Math.sign(y) * 0.001), Math.max(y, y + Math.sign(y) * 0.001), zc - ph / 2 - f, zc + ph / 2 + f, TONES.plateDark, MAT.DARK);
    mb.quad([x - pw / 2, p.y1 + o, zc - ph / 2], [x + pw / 2, p.y1 + o, zc - ph / 2], [x + pw / 2, p.y1 + o, zc + ph / 2], [x - pw / 2, p.y1 + o, zc + ph / 2], TONES.window, MAT.WINDOW, [0, 1, 0]);
    mb.quad([x + pw / 2, p.y0 - o, zc - ph / 2], [x - pw / 2, p.y0 - o, zc - ph / 2], [x - pw / 2, p.y0 - o, zc + ph / 2], [x + pw / 2, p.y0 - o, zc + ph / 2], TONES.window, MAT.WINDOW, [0, -1, 0]);
  }
  // the bridge looks forward and up too
  if (bridge) {
    const yc = (p.y0 + p.y1) / 2, n2 = Math.min(3, Math.max(2, Math.floor(w / (pw * 2.4))));
    for (let k = 0; k < n2; k++) {
      const y = yc - (n2 - 1) * pw * 0.8 + k * pw * 1.6;
      mb.quad([p.x1 - len * 0.2 - ph, y - pw / 2, p.z1 + o], [p.x1 - len * 0.2, y - pw / 2, p.z1 + o], [p.x1 - len * 0.2, y + pw / 2, p.z1 + o], [p.x1 - len * 0.2 - ph, y + pw / 2, p.z1 + o], TONES.window, MAT.WINDOW, [0, 0, 1]);
    }
  }
}

/** Fittings on a deck's outside: vents, junction boxes, antenna stubs, handholds (seeded). */
function greebles(mb, p, r, tl) {
  const len = p.x1 - p.x0, w = p.y1 - p.y0, h = p.z1 - p.z0;
  const area = len * w;
  const n = Math.min(14, Math.round(area / 18) + 2);
  for (let k = 0; k < n; k++) {
    const gx = p.x0 + len * (0.12 + 0.76 * r()), gy = p.y0 + w * (0.1 + 0.8 * r());
    const s = Math.max(0.15, Math.min(1.4, Math.min(len, w) * (0.04 + 0.08 * r())));
    const kind = r();
    const top = r() < 0.6;
    const zf = top ? p.z1 : p.z0, dz = top ? 1 : -1;
    if (kind < 0.45) mb.box(gx - s, gx + s, gy - s * 0.6, gy + s * 0.6, Math.min(zf, zf + dz * s * 0.5), Math.max(zf, zf + dz * s * 0.5), weather(TONES.plateDark, tl, r), MAT.MACHINE, s * 0.1);
    else if (kind < 0.7) { for (let j = 0; j < 3; j++) mb.box(gx - s + j * s * 0.75, gx - s + j * s * 0.75 + s * 0.4, gy - s * 0.5, gy + s * 0.5, Math.min(zf, zf + dz * 0.06), Math.max(zf, zf + dz * 0.06), TONES.dark, MAT.DARK); }
    else if (kind < 0.85) mb.tube([gx, gy, zf], [gx, gy, zf + dz * s * 2.2], s * 0.12, s * 0.08, 6, TONES.white, MAT.PAINT);
    else mb.box(gx - s * 1.4, gx + s * 1.4, gy - s * 0.3, gy + s * 0.3, Math.min(zf, zf + dz * s * 0.3), Math.max(zf, zf + dz * s * 0.3), TONES.foil, MAT.FOIL, 0);
  }
  // side fittings: a vent strip and a box or two on each flank
  if (h > 2) for (const s of [-1, 1]) {
    const y = s > 0 ? p.y1 : p.y0;
    const gx = p.x0 + len * (0.2 + 0.6 * r());
    const b = Math.min(0.8, h * 0.08);
    mb.box(gx - b, gx + b, Math.min(y, y + s * b * 0.5), Math.max(y, y + s * b * 0.5), p.z0 + h * 0.15, p.z0 + h * 0.15 + b * 1.2, weather(TONES.plateDark, tl, r), MAT.MACHINE, b * 0.1);
  }
}

/** A lattice: four longerons and the cross bracing between them. */
function lattice(mb, p, tone) {
  const len = p.x1 - p.x0, w = p.y1 - p.y0, h = p.z1 - p.z0;
  const rr = Math.max(0.05, Math.min(w, h) * 0.06);
  if (Math.min(w, h) < 0.6) { mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, tone, MAT.TRUSS); return; }
  const ys = [p.y0 + rr, p.y1 - rr], zs = [p.z0 + rr, p.z1 - rr];
  for (const y of ys) for (const z of zs) mb.tube([p.x0, y, z], [p.x1, y, z], rr, rr, 6, tone, MAT.TRUSS, false);
  const bay = Math.max(Math.min(w, h), 1);
  const n = Math.max(1, Math.round(len / bay));
  for (let k = 0; k <= n; k++) {
    const x = p.x0 + len * k / n;
    mb.tube([x, ys[0], zs[0]], [x, ys[1], zs[0]], rr * 0.7, rr * 0.7, 5, tone, MAT.TRUSS, false);
    mb.tube([x, ys[0], zs[1]], [x, ys[1], zs[1]], rr * 0.7, rr * 0.7, 5, tone, MAT.TRUSS, false);
    mb.tube([x, ys[0], zs[0]], [x, ys[0], zs[1]], rr * 0.7, rr * 0.7, 5, tone, MAT.TRUSS, false);
    mb.tube([x, ys[1], zs[0]], [x, ys[1], zs[1]], rr * 0.7, rr * 0.7, 5, tone, MAT.TRUSS, false);
    if (k < n) {
      const xb = p.x0 + len * (k + 1) / n;
      const flip = k % 2;
      mb.tube([x, ys[flip], zs[1]], [xb, ys[1 - flip], zs[1]], rr * 0.55, rr * 0.55, 4, tone, MAT.TRUSS, false);
      mb.tube([x, ys[1 - flip], zs[0]], [xb, ys[flip], zs[0]], rr * 0.55, rr * 0.55, 4, tone, MAT.TRUSS, false);
      mb.tube([x, ys[0], zs[flip]], [xb, ys[0], zs[1 - flip]], rr * 0.55, rr * 0.55, 4, tone, MAT.TRUSS, false);
      mb.tube([x, ys[1], zs[1 - flip]], [xb, ys[1], zs[flip]], rr * 0.55, rr * 0.55, 4, tone, MAT.TRUSS, false);
    }
  }
}

/** A tank: domed ends, weld seams round it, a strap or two holding it to the hull. */
function tankPart(mb, p, r, tl, seg) {
  const len = p.x1 - p.x0;
  const domed = len > p.r * 1.2;
  mb.cylX(p.x0 + (domed ? p.r * 0.45 : 0), p.x1 - (domed ? p.r * 0.45 : 0), p.r, p.y, p.z, seg, weather(TONES.tank, tl, r), MAT.TANK, domed ? 'dome' : 'flat', domed ? 'dome' : 'flat');
  const nW = Math.max(1, Math.round(len / Math.max(4, p.r * 2)));
  for (let k = 1; k <= nW; k++) {
    const x = p.x0 + len * k / (nW + 1);
    mb.cylX(x - Math.max(0.05, p.r * 0.03), x + Math.max(0.05, p.r * 0.03), p.r * 1.015, p.y, p.z, seg, TONES.plateDark, MAT.MACHINE, null, null);
  }
}

/** The drive: a bell of revolution (throat, contour, exit lip), its glowing throat inside, a gimbal ring. */
function bellPart(mb, p, info) {
  const xT = p.x1, xE = p.x0, rT = p.r1, rE = p.r0, len = xT - xE;
  const prof = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    // a bell contour: quick flare off the throat, nearly straight at the exit
    const k = 1 - Math.pow(1 - s, 2.2);
    prof.push([xT - len * s, rT + (rE - rT) * k]);
  }
  const t = Math.max(0.05, rE * 0.04);
  mb.lathe(prof.map(([x, rr]) => [x, rr + t]), 28, 0, 0, TONES.bell, MAT.BELL);
  mb.lathe(prof, 28, 0, 0, TONES.bellIn, MAT.BELL_IN, true);
  // the exit lip
  mb.lathe([[xE, rE], [xE, rE + t]], 28, 0, 0, TONES.bellIn, MAT.BELL);
  // gimbal ring and the thrust frame at the throat
  mb.cylX(xT - len * 0.06, xT + len * 0.04, rT * 1.25, 0, 0, 20, TONES.truss, MAT.MACHINE);
  for (let k = 0; k < 4; k++) {
    const a = k / 4 * Math.PI * 2 + Math.PI / 4;
    mb.tube([xT + len * 0.2, Math.cos(a) * rT * 2.2, Math.sin(a) * rT * 2.2], [xT - len * 0.15, Math.cos(a) * rE * 0.6, Math.sin(a) * rE * 0.6], rT * 0.08, rT * 0.08, 6, TONES.truss, MAT.TRUSS);
  }
  info.bell = { x: xE, r: rE, xT, rT };
}

/** A PDC turret: a dome on a ring, two barrels out over the flank. */
function turret(mb, p, info) {
  const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2, cz = (p.z0 + p.z1) / 2;
  const s = Math.min(p.x1 - p.x0, p.y1 - p.y0);
  const side = Math.sign(cy) || 1;
  const up = Math.sign(cz) || 1;
  mb.tube([cx, cy, cz], [cx, cy + side * s * 0.25, cz], s * 0.42, s * 0.42, 14, TONES.machine, MAT.MACHINE);
  mb.sphere([cx, cy + side * s * 0.25, cz], s * 0.36, 8, TONES.plate, MAT.PLATE);
  const dir = [0.25, side, up * 0.35];
  const L = Math.hypot(...dir);
  const d = dir.map(v => v / L);
  for (const o of [-1, 1]) {
    const b0 = [cx + o * s * 0.08, cy + side * s * 0.3, cz + up * s * 0.05];
    mb.tube(b0, [b0[0] + d[0] * s * 1.2, b0[1] + d[1] * s * 1.2, b0[2] + d[2] * s * 1.2], s * 0.05, s * 0.045, 6, TONES.dark, MAT.MACHINE);
  }
  info.pdcs.push({ p: [cx, cy + side * s * 0.3, cz], dir: d });
}

/** A dish: a shallow cone of revolution facing `n`. */
function dish(mb, c, R, n) {
  const f = nrm(n);
  const ref = Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = nrm(crs(f, ref)), w = crs(f, u);
  const seg = 16;
  const ringAt = (rr, h) => Array.from({ length: seg + 1 }, (_, k) => { const a = k / seg * Math.PI * 2; return [c[0] + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * rr + f[0] * h, c[1] + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * rr + f[1] * h, c[2] + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * rr + f[2] * h]; });
  const a = ringAt(R * 0.08, 0), b = ringAt(R, R * 0.28);
  for (let k = 0; k < seg; k++) { mb.quad(a[k], a[k + 1], b[k + 1], b[k], TONES.white, MAT.PAINT); mb.quad(b[k], b[k + 1], a[k + 1], a[k], TONES.plateDark, MAT.PAINT); }
  mb.tube(c, [c[0] + f[0] * R * 0.5, c[1] + f[1] * R * 0.5, c[2] + f[2] * R * 0.5], R * 0.02, R * 0.02, 5, TONES.truss, MAT.TRUSS);
}

/** Ice cut in blocks: the faces broken up, frosted. */
function ice(mb, p, r) {
  mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, TONES.ice, MAT.ICE, Math.min(p.y1 - p.y0, p.z1 - p.z0) * 0.12);
  const len = p.x1 - p.x0, w = p.y1 - p.y0, h = p.z1 - p.z0;
  const n = Math.round(Math.min(18, len * w / 400 + 4));
  for (let k = 0; k < n; k++) {
    const x = p.x0 + len * r(), y = p.y0 + w * r();
    const s = Math.min(len, w) * (0.04 + 0.08 * r());
    const top = r() < 0.5 ? p.z1 : p.z0, d = top === p.z1 ? 1 : -1;
    mb.box(x - s, x + s, y - s * 0.8, y + s * 0.8, Math.min(top, top + d * s * 0.4), Math.max(top, top + d * s * 0.4), TONES.ice, MAT.ICE, s * 0.25);
  }
  // the straps that hold the berg to its spine
  for (let k = 1; k < 4; k++) {
    const x = p.x0 + len * k / 4;
    mb.box(x - 0.4, x + 0.4, p.y0 - 0.2, p.y1 + 0.2, p.z0 - 0.2, p.z1 + 0.2, TONES.truss, MAT.TRUSS, 0.1);
  }
}

/** A spin ring of segments round the axis. */
function ringPart(mb, p, tl, r) {
  const n = p.n || 12;
  const R0 = p.r, R1 = p.r + p.d;
  for (let k = 0; k < n; k++) {
    const a0 = (k + 0.04) / n * Math.PI * 2, a1 = (k + 0.96) / n * Math.PI * 2;
    // (a segment: a box bent round, flat-faced)
    const segs = 3;
    for (let j = 0; j < segs; j++) {
      const b0 = a0 + (a1 - a0) * j / segs, b1 = a0 + (a1 - a0) * (j + 1) / segs;
      const P = (rr, a, x) => p.plane === 'xy' ? [p.x + rr * Math.cos(a), rr * Math.sin(a), x] : [x, rr * Math.cos(a), rr * Math.sin(a)];
      const xa = p.plane === 'xy' ? -p.w / 2 : p.x - p.w / 2, xb = p.plane === 'xy' ? p.w / 2 : p.x + p.w / 2;
      const tone = weather(TONES.hab, tl, r);
      mb.quad(P(R1, b0, xa), P(R1, b1, xa), P(R1, b1, xb), P(R1, b0, xb), tone, MAT.PLATE);
      mb.quad(P(R0, b1, xa), P(R0, b0, xa), P(R0, b0, xb), P(R0, b1, xb), tone, MAT.PLATE);
      mb.quad(P(R0, b0, xb), P(R1, b0, xb), P(R1, b1, xb), P(R0, b1, xb), tone, MAT.PLATE);
      mb.quad(P(R1, b0, xa), P(R0, b0, xa), P(R0, b1, xa), P(R1, b1, xa), tone, MAT.PLATE);
    }
  }
  // spokes to the hub
  for (let k = 0; k < 4; k++) {
    const a = k / 4 * Math.PI * 2 + 0.3;
    const P = (rr) => p.plane === 'xy' ? [p.x + rr * Math.cos(a), rr * Math.sin(a), 0] : [p.x, rr * Math.cos(a), rr * Math.sin(a)];
    mb.tube(P(R0 * 0.08), P(R0), Math.max(0.3, p.d * 0.12), Math.max(0.3, p.d * 0.12), 8, TONES.truss, MAT.TRUSS);
  }
}

/** A docking collar: a short barrel off the face, a thin marked rim, the hatch in it, latches round it. */
function collar(mb, pt, hull) {
  const R = pt.size === 'L' ? 3 : pt.size === 'M' ? 1.1 : 0.5;
  const n = { 'x+': [1, 0, 0], 'x-': [-1, 0, 0], 'y+': [0, 1, 0], 'y-': [0, -1, 0], 'z+': [0, 0, 1], 'z-': [0, 0, -1] }[pt.face];
  const at = (k) => [pt.x + n[0] * k, pt.y + n[1] * k, pt.z + n[2] * k];
  const out = Math.min(1.2, R * 0.55);
  mb.tube(at(-0.2), at(out), R * 1.12, R * 1.08, 24, TONES.plate, MAT.PLATE);
  mb.tube(at(out - 0.12), at(out + 0.04), R * 1.14, R * 1.14, 24, TONES.gear, MAT.HAZARD, false);
  mb.tube(at(out), at(out + 0.03), R * 0.86, R * 0.86, 24, TONES.dark, MAT.DARK);
  mb.tube(at(out + 0.03), at(out + 0.05), R * 0.3, R * 0.3, 12, TONES.plateDark, MAT.MACHINE);
  // latches round the rim
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = nrm(crs(n, ref)), w = crs(n, u);
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const p = at(out + 0.02), q = [p[0] + (u[0] * c + w[0] * s) * R * 0.98, p[1] + (u[1] * c + w[1] * s) * R * 0.98, p[2] + (u[2] * c + w[2] * s) * R * 0.98];
    mb.tube(q, [q[0] + n[0] * 0.12, q[1] + n[1] * 0.12, q[2] + n[2] * 0.12], R * 0.08, R * 0.06, 6, TONES.plateDark, MAT.MACHINE);
  }
}

/** A cargo door: a recessed panel outline on the face. */
function hatch(mb, h, hull) {
  const n = { 'y+': [0, 1, 0], 'y-': [0, -1, 0], 'z+': [0, 0, 1], 'z-': [0, 0, -1] }[h.face];
  if (!n) return;
  const s = Math.min(hull.L * 0.12, hull.H * 0.5);
  const o = 0.03;
  if (n[1]) {
    const y = h.y + n[1] * o;
    mb.quad([h.x - s, y, -s * 0.6], [h.x + s, y, -s * 0.6], [h.x + s, y, s * 0.6], [h.x - s, y, s * 0.6], TONES.plateDark, MAT.DARK, n[1] > 0 ? [0, 1, 0] : [0, -1, 0]);
  } else {
    const z = h.z + n[2] * o;
    mb.quad([h.x - s, -s * 0.6, z], [h.x + s, -s * 0.6, z], [h.x + s, s * 0.6, z], [h.x - s, s * 0.6, z], TONES.plateDark, MAT.DARK, n[2] > 0 ? [0, 0, 1] : [0, 0, -1]);
  }
}

/** An RCS quad: a block with four nozzles out of it. */
function rcsQuad(mb, x, y, z, sy, sz, s) {
  mb.box(x - s, x + s, Math.min(y, y + sy * s), Math.max(y, y + sy * s), Math.min(z, z + sz * s), Math.max(z, z + sz * s), TONES.plateDark, MAT.MACHINE, s * 0.15);
  const c = [x, y + sy * s * 0.5, z + sz * s * 0.5];
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, sy, 0], [0, 0, sz]]) {
    const a = [c[0] + d[0] * s * 0.9, c[1] + d[1] * s * 0.9, c[2] + d[2] * s * 0.9];
    mb.tube(a, [a[0] + d[0] * s * 0.45, a[1] + d[1] * s * 0.45, a[2] + d[2] * s * 0.45], s * 0.12, s * 0.22, 6, TONES.dark, MAT.MACHINE, false);
  }
}

// ---- STATIONS ----

const STATION_TONE = {
  'ground-works': [TONES.groundworks, MAT.GROUND], hab: [TONES.hab, MAT.PLATE], command: [TONES.plate, MAT.PLATE], tank: [TONES.tank, MAT.TANK],
  radiator: [TONES.radiator, MAT.RADIATOR], truss: [TONES.truss, MAT.TRUSS], dock: [TONES.dock, MAT.MACHINE], yard: [TONES.yard, MAT.MACHINE],
  machinery: [TONES.machine, MAT.MACHINE], cargo: [TONES.cargo, MAT.PLATE],
};

/** The mesh of a station model (sim/stations.js): its frame x up from the ground, y along it, z across. */
export function buildStationMesh(model, seed = 'station') {
  const mb = new MeshBuilder();
  const r = rng(seed);
  for (const p of model.parts) {
    const [tone, mat] = STATION_TONE[p.role] || [TONES.plate, MAT.PLATE];
    if (p.k === 'ring') { ringPart(mb, p, 3, r); continue; }
    if (p.k === 'cyl') { tankPart(mb, { ...p, y: p.y, z: p.z || 0 }, r, 3, 20); continue; }
    const w = p.y1 - p.y0, h = p.z1 - p.z0, len = p.x1 - p.x0;
    if (p.role === 'truss') { lattice(mb, p, tone); continue; }
    if (p.role === 'yard') { yardBay(mb, p, r); continue; }
    if (p.role === 'ground-works') { groundworks(mb, p, r); continue; }
    mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, weather(tone, 3, r), mat, Math.min(2, Math.min(w, h, len) * 0.06));
    if (p.role === 'hab' || p.role === 'command') stationWindows(mb, p);
    if (p.role === 'dock') {
      // the arm's working lamps along its top
      const n = Math.max(1, Math.round(w / 15));
      for (let k = 0; k < n; k++) mb.sphere([p.x1 + 0.4, p.y0 + w * (k + 0.5) / n, p.z1 * 0.5], 0.5, 5, TONES.white, MAT.LAMP);
    }
    if (p.role === 'machinery' || p.role === 'command' || p.role === 'hab') stationRoof(mb, p, r);
  }
  const data = mb.data();
  return { data, count: data.length / FLOATS };
}

/** Rows of lit windows on a station block's faces. */
function stationWindows(mb, p) {
  const len = p.x1 - p.x0, h = p.z1 - p.z0, w = p.y1 - p.y0;
  const floors = Math.max(1, Math.floor(len / 4));
  const o = 0.05, s = 1.2;
  const rowsZ = Math.max(1, Math.floor(h / 6));
  for (let f = 0; f < Math.min(floors, 40); f++) {
    const x = p.x0 + (f + 0.5) * len / floors;
    for (let k = 0; k < Math.min(rowsZ, 30); k++) {
      if (((f * 7 + k * 3) % 5) === 0) continue;          // (not every window lit)
      const z = p.z0 + (k + 0.5) * h / rowsZ;
      mb.quad([x - s * 0.4, p.y1 + o, z - s], [x + s * 0.4, p.y1 + o, z - s], [x + s * 0.4, p.y1 + o, z + s], [x - s * 0.4, p.y1 + o, z + s], TONES.window, MAT.WINDOW, [0, 1, 0]);
      mb.quad([x + s * 0.4, p.y0 - o, z - s], [x - s * 0.4, p.y0 - o, z - s], [x - s * 0.4, p.y0 - o, z + s], [x + s * 0.4, p.y0 - o, z + s], TONES.window, MAT.WINDOW, [0, -1, 0]);
    }
  }
  // the top: a pattern of skylights
  const nx = Math.min(30, Math.floor(len / 12)), ny = Math.min(30, Math.floor(w / 12));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if ((i * 13 + j * 7) % 4) continue;
    const x = p.x0 + (i + 0.5) * len / nx, y = p.y0 + (j + 0.5) * w / ny;
    mb.quad([x - 1.5, y - 1, p.z1 + o], [x + 1.5, y - 1, p.z1 + o], [x + 1.5, y + 1, p.z1 + o], [x - 1.5, y + 1, p.z1 + o], TONES.window, MAT.WINDOW, [0, 0, 1]);
  }
}

/** Plant on a station block's roof: tanks, boxes, masts. */
function stationRoof(mb, p, r) {
  const len = p.x1 - p.x0, w = p.y1 - p.y0;
  const n = Math.min(24, Math.round(len * w / 2500) + 3);
  for (let k = 0; k < n; k++) {
    const x = p.x0 + len * (0.1 + 0.8 * r()), y = p.y0 + w * (0.1 + 0.8 * r());
    const s = Math.min(len, w) * (0.03 + 0.06 * r());
    const kind = r();
    if (kind < 0.5) mb.box(x - s, x + s, y - s, y + s, p.z1, p.z1 + s * (0.6 + r()), weather(TONES.machine, 3, r), MAT.MACHINE, s * 0.08);
    else if (kind < 0.8) mb.cylX(x - s * 1.5, x + s * 1.5, s * 0.5, y, p.z1 + s * 0.5, 12, TONES.tank, MAT.TANK, 'dome', 'dome');
    else mb.tube([x, y, p.z1], [x, y, p.z1 + s * 4], s * 0.08, s * 0.05, 6, TONES.white, MAT.PAINT);
  }
}

/** A construction bay: an open frame with a hull taking shape in it. */
function yardBay(mb, p, r) {
  const len = p.x1 - p.x0, w = p.y1 - p.y0, h = p.z1 - p.z0;
  const t = Math.min(len, w) * 0.04;
  // the frame: four corner columns and beams along the top and bottom
  for (const y of [p.y0 + t, p.y1 - t]) for (const z of [p.z0 + t, p.z1 - t]) mb.tube([p.x0, y, z], [p.x1, y, z], t, t, 6, TONES.yard, MAT.TRUSS, false);
  const n = Math.max(2, Math.round(w / Math.max(h, 40)));
  for (let k = 0; k <= n; k++) {
    const y = p.y0 + w * k / n;
    for (const z of [p.z0 + t, p.z1 - t]) mb.tube([p.x0, y, z], [p.x1, y, z], t * 0.6, t * 0.6, 5, TONES.yard, MAT.TRUSS, false);
    mb.tube([p.x1, y, p.z0 + t], [p.x1, y, p.z1 - t], t * 0.6, t * 0.6, 5, TONES.yard, MAT.TRUSS, false);
  }
  // a hull on the slip: its frames and some plating
  const hx0 = p.x0 + len * 0.2, hx1 = p.x1 - len * 0.2, hw = w * 0.5, hh = h * 0.35;
  mb.box(hx0, hx1, -hw / 2 + (p.y0 + p.y1) / 2, hw / 2 + (p.y0 + p.y1) / 2, -hh / 2, hh / 2, weather(TONES.plate, 2, r), MAT.PLATE, Math.min(hh, hw) * 0.08);
  for (let k = 0; k < 8; k++) mb.sphere([hx0 + (hx1 - hx0) * r(), (p.y0 + p.y1) / 2 + (r() - 0.5) * hw, hh / 2 + 1], 1.2, 4, TONES.white, MAT.LAMP);
}

/** A field on the rock: a pad, its plating seams and lamp rows. */
function groundworks(mb, p, r) {
  mb.box(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1, TONES.groundworks, MAT.GROUND, 0);
  const w = p.y1 - p.y0, h = p.z1 - p.z0;
  const n = Math.min(40, Math.round(w / 120));
  for (let k = 0; k <= n; k++) {
    const y = p.y0 + w * k / n;
    for (let j = 0; j < 6; j++) mb.sphere([p.x1 + 0.3, y, p.z0 + h * (j + 0.5) / 6], 0.5, 4, TONES.white, MAT.LAMP);
  }
}

// ---- DEBRIS ----

/**
 * A fragment of a broken hull, about a metre across (scaled where it is
 * drawn: ships3d.js): shape 0 a plate bent double, 1 a torn panel, 2 a
 * length of spar, 3 a curved piece of tank shell, 4 a chunk of machinery,
 * 5 a radiator fin with its frame.
 */
export function buildDebrisMesh(shape) {
  const mb = new MeshBuilder();
  const k = Number(shape) || 0;
  const r = rng(`debris${k}`);
  const plate = weather(TONES.plateDark, 1, r), metal = weather(TONES.plate, 1, r);
  if (k === 0) {
    mb.box(-0.5, 0.05, -0.35, 0.35, -0.03, 0.03, plate, MAT.PLATE);
    // (the other half folded up at an angle)
    const a = 0.9, c = Math.cos(a), sn = Math.sin(a);
    const P = (x, y, z) => [0.05 + x * c - z * sn, y, x * sn + z * c];
    mb.quad(P(0, -0.35, 0.03), P(0.5, -0.35, 0.03), P(0.5, 0.3, 0.03), P(0, 0.35, 0.03), plate, MAT.PLATE);
    mb.quad(P(0, 0.35, -0.03), P(0.5, 0.3, -0.03), P(0.5, -0.35, -0.03), P(0, -0.35, -0.03), plate, MAT.PLATE);
  } else if (k === 1) {
    // a panel torn out ragged: a fan of triangles round its middle, edges uneven
    const n = 9, pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; const rr = 0.32 + 0.22 * r(); pts.push([Math.cos(a) * rr * 1.3, Math.sin(a) * rr, (r() - 0.5) * 0.12]); }
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      mb.tri([0, 0, 0.02], a, b, metal, MAT.PLATE);
      mb.tri([0, 0, -0.02], b, a, metal, MAT.PLATE);
    }
  } else if (k === 2) {
    mb.tube([-0.6, 0, 0], [0.6, 0.05, 0.08], 0.07, 0.06, 6, TONES.truss, MAT.TRUSS);
    mb.tube([0.2, 0, 0], [0.45, 0.3, 0.1], 0.04, 0.035, 5, TONES.truss, MAT.TRUSS);
  } else if (k === 3) {
    mb.lathe([[-0.4, 0.6], [0.4, 0.6]], 6, 0, -0.55, weather(TONES.tank, 1, r), MAT.TANK, false, 0.9, 2.3);
    mb.lathe([[-0.4, 0.57], [0.4, 0.57]], 6, 0, -0.55, TONES.dark, MAT.DARK, true, 0.9, 2.3);
  } else if (k === 4) {
    mb.box(-0.35, 0.35, -0.25, 0.25, -0.2, 0.2, weather(TONES.machine, 1, r), MAT.MACHINE, 0.04);
    mb.tube([0.35, 0, 0.05], [0.65, 0.1, 0.2], 0.05, 0.04, 6, TONES.dark, MAT.MACHINE);
    mb.box(-0.2, 0.1, 0.25, 0.4, -0.1, 0.12, plate, MAT.MACHINE);
  } else {
    mb.box(-0.55, 0.55, -0.3, 0.3, -0.015, 0.015, TONES.radiator, MAT.RADIATOR);
    mb.box(-0.55, 0.55, 0.3, 0.36, -0.03, 0.03, TONES.truss, MAT.MACHINE);
  }
  const data = mb.data();
  return { data, count: data.length / FLOATS, L: 1, W: 1, H: 1, bell: null, lights: [], pdcs: [] };
}

export { FLOATS, MeshBuilder };
