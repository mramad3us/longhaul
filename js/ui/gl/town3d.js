// ============================================================
// LONGHAUL — A spaceport and its town, from close
//
// What stands on a world's ground round the pad a shuttle lands at
// (shuttlecam.js; the ground itself is world3d.js): purely a picture,
// nothing in it simulated. Laid out once per spaceport from a seed of its
// own (townOf), in the pad's frame on the ground (the same frame the
// ground's pad is drawn in), each thing seated on the world's curve:
//
//   THE PORT     the other pads round ours, ringed with lights; hangars;
//                the terminal facing the pads; the control tower with its
//                glass cab and its beacon; a tank farm; floodlights round
//                the perimeter; now and then another craft lifting off a
//                pad on its plume
//   THE ROAD     out to the town, lamps along it, traffic both ways
//   THE TOWN     in the world's own way of living (STYLES): Earth's
//                towers and blocks, thinning out from a core; Mars's domes
//                over their districts, tubes between them, industry
//                outside; Luna's habitats under regolith berms, solar
//                arrays, the mass driver's rail; Ganymede's farms under
//                green-lit domes and mirrors; Callisto's base; Europa's
//                rigs; Titan's stations on stilts
//
// Drawn in the hulls' pass (ships3d.js renderScene), depth-tested with
// them and the ground, in the same air as the ground (world3d.js
// AIR_GLSL): a tower a few kilometres off is blued as the ground beside
// it. By day the Sun through the air lights it, the sky fills its
// shadows; by night its windows are lit, its lamps and beacons burn and
// its traffic moves. Only near the ground (TOWN_ALT_M): from higher, the
// ground's own town lights are the town.
// ============================================================

import { program } from './gl.js';
import { AIR_GLSL, setAir } from './air3d.js';

export const TOWN_ALT_M = 60_000;          // drawn below this (m up)

// ---- THE LAYOUT ----

/**
 * Each world's way of building: its walls, its window light, what its town
 * is made of; its ground's colour near the port (the light it throws back
 * onto walls) and how much of its dust lies on everything.
 */
const STYLES = {
  Earth: { ground: [0.09, 0.1, 0.075], built: [0.075, 0.08, 0.065], dust: 0.08, town: 'city', wall: [0.40, 0.40, 0.42], roof: [0.2, 0.2, 0.21], glow: [1.0, 0.78, 0.52], glow2: [0.75, 0.85, 1.0], core: 260, mid: 55, low: 16, radius: 3200, road: 3600 },
  Mars: { ground: [0.33, 0.15, 0.07], dust: 0.45, town: 'domes', wall: [0.46, 0.36, 0.29], roof: [0.3, 0.24, 0.2], glow: [1.0, 0.75, 0.5], glow2: [1.0, 0.86, 0.65], core: 45, mid: 22, low: 9, radius: 2600, road: 3000 },
  Luna: { ground: [0.13, 0.13, 0.13], dust: 0.3, town: 'warrens', wall: [0.34, 0.34, 0.35], roof: [0.26, 0.26, 0.27], glow: [1.0, 0.82, 0.6], glow2: [0.8, 0.88, 1.0], core: 18, mid: 9, low: 6, radius: 2200, road: 2600 },
  Ganymede: { ground: [0.24, 0.23, 0.21], dust: 0.15, town: 'farms', wall: [0.5, 0.51, 0.53], roof: [0.36, 0.37, 0.38], glow: [1.0, 0.8, 0.55], glow2: [0.55, 1.0, 0.55], core: 20, mid: 10, low: 6, radius: 2000, road: 2400 },
  Callisto: { ground: [0.12, 0.11, 0.1], dust: 0.25, town: 'base', wall: [0.44, 0.45, 0.46], roof: [0.3, 0.3, 0.31], glow: [1.0, 0.8, 0.6], glow2: [1.0, 0.4, 0.3], core: 16, mid: 9, low: 6, radius: 1600, road: 2000 },
  Europa: { ground: [0.5, 0.48, 0.45], dust: 0.1, town: 'rigs', wall: [0.52, 0.54, 0.57], roof: [0.38, 0.4, 0.42], glow: [1.0, 0.82, 0.6], glow2: [0.7, 0.85, 1.0], core: 14, mid: 8, low: 5, radius: 1500, road: 1800 },
  Titan: { ground: [0.2, 0.14, 0.07], dust: 0.3, town: 'stilts', wall: [0.42, 0.37, 0.3], roof: [0.3, 0.27, 0.22], glow: [1.0, 0.78, 0.5], glow2: [1.0, 0.9, 0.6], core: 12, mid: 7, low: 5, radius: 1200, road: 1600 },
};
const DEFAULT_STYLE = STYLES.Luna;

// Things by shape: boxes, cylinders, domes. Kinds (the fragment shader's materials):
const K = { BLOCK: 0, HANGAR: 1, TOWER: 2, TANK: 3, DOME: 4, SLAB: 5, ARRAY: 6, BERM: 7, CAB: 8, TUBE: 9, FARM: 10, MAST: 11 };
// Lights: lamps (by night), beacons (blinking red), traffic (moving), pad rings (blinking amber), strobes, a craft on its plume
const L = { LAMP: 0, BEACON: 1, CAR: 2, TAIL: 3, PADRING: 4, STROBE: 5, CRAFT: 6, FLOOD: 7 };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const towns = new Map();

/**
 * A spaceport and its town (laid out once, kept): instance lists by shape
 * ({ box, cyl, dome }: [x, y, z0, sx, sy, sz, rot, kind, seed] each, m in
 * the pad's frame) and its lights ([ax, ay, az, bx, by, bz, speed, phase,
 * kind, size]).
 */
export function townOf(world, portId, padR = 40) {
  const key = `${world}:${portId}`;
  let t = towns.get(key);
  if (t) return t;
  const st = STYLES[world] || DEFAULT_STYLE, R = rng(hash(key));
  const box = [], cyl = [], dome = [], lights = [];
  const rand = (a, b) => a + R() * (b - a);
  const B = (x, y, z0, sx, sy, sz, rot, kind) => box.push(x, y, z0, sx, sy, sz, rot, kind, R());
  const Cy = (x, y, z0, d, h, kind) => cyl.push(x, y, z0, d, d, h, 0, kind, R());
  const Do = (x, y, d, h, kind) => dome.push(x, y, 0, d, d, h, 0, kind, R());
  const Li = (ax, ay, az, kind, size = 1, bx = ax, by = ay, bz = az, speed = 0, phase = R()) => lights.push(ax, ay, az, bx, by, bz, speed, phase, kind, size);
  const free = [];                                       // (footprints taken: x, y, radius)
  const clear = (x, y, r) => free.every(([fx, fy, fr]) => Math.hypot(x - fx, y - fy) > r + fr);
  const take = (x, y, r) => free.push([x, y, r]);
  take(0, 0, padR * 4.2);                                // (our pad and its apron, drawn by the ground)

  // ---- the port: other pads round ours, ringed with lights
  const pads = [];
  const nPads = 4 + Math.floor(R() * 4);
  for (let i = 0, tries = 0; pads.length < nPads && tries < 60; tries++, i++) {
    const a = R() * Math.PI * 2, d = rand(280, 640), x = Math.cos(a) * d, y = Math.sin(a) * d, r = rand(28, 46);
    if (!clear(x, y, r * 2.6)) continue;
    take(x, y, r * 2.6);
    pads.push([x, y, r]);
    Cy(x, y, 0, r * 2, 0.35, K.SLAB);
    for (let k = 0; k < 12; k++) { const g = k / 12 * Math.PI * 2; Li(x + Math.cos(g) * r * 1.02, y + Math.sin(g) * r * 1.02, 0.6, L.PADRING, 0.9); }
    // (now and then a craft lifts off it, or comes down on it, on its plume)
    if (R() < 0.6) Li(x, y, 0, L.CRAFT, 6, x, y, 4000, rand(0.0012, 0.003));
  }
  // the town's bearing; the port built up on every side of the pads
  const tb = R() * Math.PI * 2, tdx = Math.cos(tb), tdy = Math.sin(tb);
  const toward = (d, side = 0) => [tdx * d - tdy * side, tdy * d + tdx * side];
  const at = (g, d) => [Math.cos(g) * d, Math.sin(g) * d];
  // the terminal, facing the pads
  { const [x, y] = toward(520, rand(-120, 120)); B(x, y, 0, 150, 38, 15, tb + Math.PI / 2, K.BLOCK); take(x, y, 80); }
  // rows of hangars on three bearings
  for (let row = 0; row < 3; row++) {
    const g = tb + (row + 0.5) * Math.PI * 2 / 3 + rand(-0.3, 0.3), n = 3 + Math.floor(R() * 4), d0 = rand(330, 520);
    for (let i = 0; i < n; i++) {
      const [x0, y0] = at(g, d0), w = rand(55, 80), [x, y] = [x0 - Math.sin(g) * (i - n / 2) * (w + 14), y0 + Math.cos(g) * (i - n / 2) * (w + 14)];
      if (!clear(x, y, w * 0.6)) continue;
      B(x, y, 0, w, rand(42, 58), rand(16, 26), g + Math.PI / 2, K.HANGAR); take(x, y, w * 0.6);
      Li(x + Math.cos(g) * 30, y + Math.sin(g) * 30, 12, L.FLOOD, 1.1);
    }
  }
  // service buildings, sheds and stores scattered between and beyond
  for (let q = 0, n = 0; q < 160 && n < 46; q++) {
    const g = R() * Math.PI * 2, d = rand(300, 1100), [x, y] = at(g, d), w = rand(14, 40);
    if (!clear(x, y, w * 0.7)) continue;
    take(x, y, w * 0.7); n++;
    if (R() < 0.75) B(x, y, 0, w, rand(10, 30), rand(5, 13), g + rand(-0.2, 0.2), R() < 0.5 ? K.BLOCK : K.HANGAR);
    else Cy(x, y, 0, rand(8, 14), rand(8, 16), K.TANK);
  }
  // the control tower: shaft, glass cab, beacon and strobe on its top
  { const [x, y] = toward(430, rand(-260, -160)); const h = rand(38, 58);
    B(x, y, 0, 9, 9, h, tb, K.BLOCK); B(x, y, h, 17, 17, 6, tb, K.CAB); B(x, y, h + 6, 12, 12, 1.5, tb, K.BLOCK);
    Li(x, y, h + 9, L.BEACON, 1.4); Li(x + 4, y, h + 8, L.STROBE, 1.1); take(x, y, 14); }
  // the tank farm
  { const [cx, cy] = toward(rand(700, 900), rand(250, 420) * (R() < 0.5 ? -1 : 1)); const n = 6 + Math.floor(R() * 5);
    for (let i = 0; i < n; i++) { const x = cx + (i % 4) * 30 - 45, y = cy + Math.floor(i / 4) * 32; Cy(x, y, 0, rand(14, 22), rand(14, 26), K.TANK); }
    take(cx, cy, 90); }
  // floodlights round the port's edge
  for (let k = 0; k < 40; k++) { const g = k / 40 * Math.PI * 2; Li(Math.cos(g) * 950, Math.sin(g) * 950, 18, L.FLOOD, 1.4); }

  // ---- the roads out of the port, the main one to town: lamps along both sides, traffic both ways
  const road = st.road;
  const roads = [[tb, road + 400, world === 'Earth' ? 26 : world === 'Mars' ? 14 : 6]];
  for (let k = 1; k < 4; k++) roads.push([tb + k * Math.PI / 2 + rand(-0.4, 0.4), rand(2500, 4200), world === 'Earth' ? 8 : 3]);
  for (const [g, len, cars] of roads) {
    const cx = Math.cos(g), cy = Math.sin(g), side = (d, o) => [cx * d - cy * o, cy * d + cx * o];
    for (let d = 960; d < len; d += 45) { const [x1, y1] = side(d, 14), [x2, y2] = side(d, -14); Li(x1, y1, 9, L.LAMP, 1); Li(x2, y2, 9, L.LAMP, 1); }
    const [a0x, a0y] = side(950, 4), [a1x, a1y] = side(len, 4), [b0x, b0y] = side(len, -4), [b1x, b1y] = side(950, -4);
    for (let i = 0; i < cars; i++) {
      const v = rand(14, 24);
      Li(a0x, a0y, 1.2, L.CAR, 0.8, a1x, a1y, 1.2, v, R());
      Li(b0x, b0y, 1.2, L.TAIL, 0.7, b1x, b1y, 1.2, v, R());
    }
  }
  // ---- the outskirts all round, thinning out: sheds, works, the odd tank, a mast with its beacon
  const nOut = world === 'Earth' ? 220 : world === 'Mars' ? 110 : 60;
  for (let q = 0, n = 0; q < nOut * 3 && n < nOut; q++) {
    const g = R() * Math.PI * 2, d = 1200 + Math.pow(R(), 1.6) * 3200, [x, y] = at(g, d), w = rand(12, 44);
    if (!clear(x, y, w * 0.7)) continue;
    take(x, y, w * 0.7); n++;
    const k = R();
    if (k < 0.7) B(x, y, 0, w, rand(10, 36), rand(4, world === 'Earth' ? 22 : 12), rand(0, 3), R() < 0.55 ? K.BLOCK : K.HANGAR);
    else if (k < 0.9) Cy(x, y, 0, rand(8, 18), rand(8, 20), K.TANK);
    else { const h = rand(30, 70); B(x, y, 0, 2.5, 2.5, h, 0, K.MAST); Li(x, y, h + 1, L.BEACON, 1.1); }
  }

  // ---- the town, the world's own way
  const [ox, oy] = toward(road * 0.55 + st.radius * 0.6);
  const inTown = (fn) => fn(ox, oy);
  inTown((ox, oy) => {
    if (st.town === 'city') city(ox, oy);
    else if (st.town === 'domes') domes(ox, oy);
    else outpost(ox, oy, st.town);
  });

  function city(ox, oy) {
    const cell = 132, rad = st.radius, n = Math.ceil(rad / cell);
    const ang = tb + rand(-0.3, 0.3), c = Math.cos(ang), s = Math.sin(ang);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const lx = i * cell + rand(-8, 8), ly = j * cell + rand(-8, 8), d = Math.hypot(lx, ly);
      if (d > rad || R() < 0.12) continue;                                    // (parks, lots)
      const x = ox + c * lx - s * ly, y = oy + s * lx + c * ly;
      const core = Math.max(0, 1 - d / 700), mid = Math.max(0, 1 - d / 1700);
      const h = core > 0.05 && R() < 0.7 ? rand(0.35, 1) * st.core * core + 40 : mid > 0 ? rand(0.4, 1) * st.mid * mid + 12 : rand(0.5, 1) * st.low + 4;
      const fw = h > 90 ? rand(32, 48) : rand(46, 96), fd = h > 90 ? rand(32, 48) : rand(40, 90);
      B(x, y, 0, fw, fd, h, ang + (R() < 0.15 ? rand(-0.4, 0.4) : 0), h > 90 ? K.TOWER : K.BLOCK);
      if (h > 110) Li(x, y, h + 2, L.BEACON, 1.3);
      // a lamp at the block's corner
      Li(x + c * cell / 2 - s * cell / 2, y + s * cell / 2 + c * cell / 2, 8, L.LAMP, 0.9);
    }
    // traffic on two avenues through the centre
    for (const g of [ang, ang + Math.PI / 2]) {
      const gx = Math.cos(g), gy = Math.sin(g);
      for (let k = 0; k < 18; k++) {
        const v = rand(10, 18);
        Li(ox - gx * rad + gy * 6, oy - gy * rad - gx * 6, 1.2, L.CAR, 0.8, ox + gx * rad + gy * 6, oy + gy * rad - gx * 6, 1.2, v, R());
        Li(ox + gx * rad - gy * 6, oy + gy * rad + gx * 6, 1.2, L.TAIL, 0.7, ox - gx * rad - gy * 6, oy - gy * rad + gx * 6, 1.2, v, R());
      }
    }
  }

  function domes(ox, oy) {
    const n = 3 + Math.floor(R() * 4), centres = [];
    for (let k = 0, tries = 0; centres.length < n && tries < 80; tries++, k++) {
      const a = R() * Math.PI * 2, d = centres.length ? rand(500, st.radius) : 0, dd = rand(320, 820);
      const x = ox + Math.cos(a) * d, y = oy + Math.sin(a) * d;
      if (centres.some(([cx, cy, cd]) => Math.hypot(x - cx, y - cy) < (dd + cd) / 2 + 120)) continue;
      centres.push([x, y, dd]);
      Do(x, y, dd, dd * rand(0.32, 0.42), K.DOME);
      // its district under it: low and mid blocks, the taller toward the middle
      const m = Math.floor(dd / 55);
      for (let q = 0; q < m * m * 0.6; q++) {
        const r = Math.sqrt(R()) * dd * 0.4, g = R() * Math.PI * 2, f = 1 - r / (dd * 0.42);
        const h = Math.min(dd * 0.3 * Math.sqrt(Math.max(0, 1 - (r / (dd * 0.45)) ** 2)), rand(0.4, 1) * st.core * f + st.low);
        B(x + Math.cos(g) * r, y + Math.sin(g) * r, 0, rand(18, 40), rand(18, 40), h, rand(0, 3), K.BLOCK);
      }
      Li(x, y, dd * 0.38, L.BEACON, 1.3);
    }
    // tubes between them
    for (let k = 1; k < centres.length; k++) {
      const [x1, y1, d1] = centres[k], [x0, y0] = centres.reduce((b, c) => c !== centres[k] && Math.hypot(c[0] - x1, c[1] - y1) < Math.hypot(b[0] - x1, b[1] - y1) ? c : b, centres[0]);
      const len = Math.hypot(x1 - x0, y1 - y0), g = Math.atan2(y1 - y0, x1 - x0);
      B((x0 + x1) / 2, (y0 + y1) / 2, 0, len, 9, 7, g, K.TUBE);
      for (let s = 0; s < len; s += 60) Li(x0 + Math.cos(g) * s, y0 + Math.sin(g) * s, 8, L.LAMP, 0.7);
    }
    // industry outside: sheds and tanks
    for (let q = 0; q < 26; q++) {
      const a = R() * Math.PI * 2, d = rand(st.radius * 0.9, st.radius * 1.4), x = ox + Math.cos(a) * d, y = oy + Math.sin(a) * d;
      if (R() < 0.6) B(x, y, 0, rand(40, 90), rand(30, 60), rand(10, 20), rand(0, 3), K.HANGAR); else Cy(x, y, 0, rand(12, 20), rand(12, 22), K.TANK);
    }
  }

  function outpost(ox, oy, kind) {
    const rad = st.radius;
    const spot = () => { const r = Math.sqrt(R()) * rad, g = R() * Math.PI * 2; return [ox + Math.cos(g) * r, oy + Math.sin(g) * r]; };
    if (kind === 'warrens') {
      for (let q = 0; q < 70; q++) { const [x, y] = spot(); B(x, y, 0, rand(40, 95), rand(18, 40), rand(4, 8), rand(0, 3), K.BERM); if (R() < 0.3) Li(x, y, 7, L.LAMP, 0.8); }
      for (let q = 0; q < 24; q++) { const [x, y] = spot(); B(x, y, 0, rand(10, 18), rand(10, 18), rand(6, 14), rand(0, 3), K.BLOCK); }
      for (let q = 0; q < 6; q++) { const [x, y] = spot(); Do(x, y, rand(60, 140), rand(25, 50), K.DOME); }
      // solar arrays in rows, on posts
      const [ax, ay] = toward(road * 0.6, rand(500, 800) * (R() < 0.5 ? -1 : 1));
      for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) B(ax + i * 34, ay + j * 14, 2.4, 30, 9, 0.35, 0, K.ARRAY);
      // the mass driver's rail, off past the town
      const g = tb + rand(-0.8, 0.8);
      for (let s = 0; s < 4000; s += 200) { B(ox + Math.cos(g) * (rad + s + 100), oy + Math.sin(g) * (rad + s + 100), 3, 200, 5, 3, g, K.TUBE); if (s % 400 === 0) Li(ox + Math.cos(g) * (rad + s), oy + Math.sin(g) * (rad + s), 8, L.BEACON, 1); }
      return;
    }
    if (kind === 'farms') {
      for (let q = 0; q < 9; q++) { const [x, y] = spot(); const d = rand(180, 420); if (!clear(x, y, d / 2)) continue; take(x, y, d / 2); Do(x, y, d, d * 0.3, K.FARM); }
      for (let q = 0; q < 40; q++) { const [x, y] = spot(); B(x, y, 0, rand(16, 40), rand(14, 30), rand(5, 14), rand(0, 3), K.BLOCK); }
      // the mirrors: arrays raised high, catching the Sun for the domes
      for (let q = 0; q < 14; q++) { const [x, y] = spot(); B(x, y, 0, 3, 3, 26, 0, K.MAST); B(x, y, 26, 40, 22, 0.4, rand(0, 3), K.ARRAY); }
      return;
    }
    if (kind === 'base') {
      for (let q = 0; q < 14; q++) { const [x, y] = spot(); B(x, y, 0, rand(50, 80), rand(40, 56), rand(14, 22), tb, K.HANGAR); }
      for (let q = 0; q < 30; q++) { const [x, y] = spot(); B(x, y, 0, rand(20, 60), rand(16, 30), rand(4, 7), rand(0, 3), K.BERM); }
      for (let q = 0; q < 6; q++) { const [x, y] = spot(); const h = rand(40, 80); B(x, y, 0, 2.5, 2.5, h, 0, K.MAST); Li(x, y, h + 1, L.BEACON, 1.2); }
      for (let q = 0; q < 4; q++) { const [x, y] = spot(); Do(x, y, rand(80, 160), rand(30, 60), K.DOME); }
      return;
    }
    if (kind === 'rigs') {
      for (let q = 0; q < 10; q++) { const [x, y] = spot(); const h = rand(40, 90); B(x, y, 0, rand(10, 16), rand(10, 16), h, rand(0, 3), K.MAST); B(x, y, h, 24, 24, 8, 0, K.BLOCK); Li(x, y, h + 10, L.BEACON, 1.3); Cy(x + 22, y, 0, 14, 18, K.TANK); }
      for (let q = 0; q < 34; q++) { const [x, y] = spot(); B(x, y, 0, rand(16, 36), rand(14, 26), rand(5, 11), rand(0, 3), K.BLOCK); }
      for (let q = 0; q < 5; q++) { const [x, y] = spot(); Do(x, y, rand(70, 140), rand(25, 50), K.DOME); }
      return;
    }
    // (stilts: Titan's research stations, modules up on legs over the wet ground)
    for (let q = 0; q < 26; q++) {
      const [x, y] = spot(), w = rand(16, 34), d = rand(10, 20), z0 = rand(3, 6), g = rand(0, 3);
      B(x, y, z0, w, d, rand(4, 7), g, K.BLOCK);
      for (const [lx, ly] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) B(x + Math.cos(g) * lx * w - Math.sin(g) * ly * d, y + Math.sin(g) * lx * w + Math.cos(g) * ly * d, 0, 0.8, 0.8, z0, 0, K.MAST);
      if (R() < 0.5) Li(x, y, z0 + 8, L.LAMP, 0.9);
    }
    for (let q = 0; q < 4; q++) { const [x, y] = spot(); Do(x, y, rand(50, 100), rand(20, 36), K.DOME); }
  }

  // the pools of light the lamps and floodlights throw on the ground (x, y, radius, strength: a
  // sodium lamp's warm, a floodlight's white given as less than nothing)
  const pools = [];
  for (let i = 0; i < lights.length; i += 10) {
    const k = lights[i + 8];
    if (k === L.LAMP) pools.push(lights[i], lights[i + 1], 15, 0.42);
    else if (k === L.FLOOD) pools.push(lights[i], lights[i + 1], 44 + 16 * R(), -0.2);
  }
  // how far out it is built (the farthest thing from the pad, and a little)
  let reach = 0;
  for (const arr of [box, cyl, dome]) for (let i = 0; i < arr.length; i += 9) reach = Math.max(reach, Math.hypot(arr[i], arr[i + 1]) + arr[i + 3]);
  t = { style: st, reach: reach + 400, box: new Float32Array(box), cyl: new Float32Array(cyl), dome: new Float32Array(dome), lights: new Float32Array(lights), pools: new Float32Array(pools), $gl: null };
  towns.set(key, t);
  return t;
}

/** What the ground under a town is, for the ground's shader (world3d.js): [its reach (m), the built ground's colour, or none]. */
export function townGround(world, portId, padR) {
  const t = townOf(world, portId, padR);
  return [t.reach, ...(t.style.built || [0, 0, 0])];
}

// ---- THE SHAPES ----

function boxShape() {
  const v = [];
  const face = (n, a, b, c, d) => { for (const p of [a, b, c, a, c, d]) v.push(...p, ...n); };
  const x0 = -0.5, x1 = 0.5, y0 = -0.5, y1 = 0.5, z0 = 0, z1 = 1;
  face([0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  face([1, 0, 0], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  face([-1, 0, 0], [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  face([0, 1, 0], [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  face([0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  return v;
}
function cylShape(n = 20) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
    const ca = Math.cos(a) * 0.5, sa = Math.sin(a) * 0.5, cb = Math.cos(b) * 0.5, sb = Math.sin(b) * 0.5;
    const na = [Math.cos(a), Math.sin(a), 0], nb = [Math.cos(b), Math.sin(b), 0];
    v.push(ca, sa, 0, ...na, cb, sb, 0, ...nb, cb, sb, 1, ...nb, ca, sa, 0, ...na, cb, sb, 1, ...nb, ca, sa, 1, ...na);
    v.push(0, 0, 1, 0, 0, 1, ca, sa, 1, 0, 0, 1, cb, sb, 1, 0, 0, 1);
  }
  return v;
}
function domeShape(n = 24, m = 10) {
  const v = [];
  const pt = (i, j) => { const a = i / n * Math.PI * 2, e = j / m * Math.PI / 2; return [Math.cos(a) * Math.cos(e) * 0.5, Math.sin(a) * Math.cos(e) * 0.5, Math.sin(e), Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)]; };
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    v.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return v;
}

// ---- THE SHADERS ----

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec3 iPos;          // x, y in the pad's frame, the base's height (m)
layout(location = 3) in vec4 iSize;         // across, deep, high (m), its turn about the up
layout(location = 4) in vec2 iKind;         // its material, a seed
uniform mat4 uVP;
uniform vec3 uO, uE1, uE2, uU;              // the pad's frame (m from the scene's origin)
uniform float uRw;                          // the world's radius (m)
out vec3 vW, vN, vL, vS, vLN;
flat out vec2 vK;
void main() {
  vec3 l = aPos * iSize.xyz;
  float c = cos(iSize.w), s = sin(iSize.w);
  vec2 xy = vec2(c * l.x - s * l.y, s * l.x + c * l.y) + iPos.xy;
  float z = l.z + iPos.z - dot(xy, xy) / (2.0 * uRw);          // (the ground curving away from the pad)
  vec3 w = uO + uE1 * xy.x + uE2 * xy.y + uU * z;
  vec3 n = aNrm / max(iSize.xyz, vec3(0.01));
  n = normalize(vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z));
  vW = w; vN = uE1 * n.x + uE2 * n.y + uU * n.z; vL = l; vS = iSize.xyz; vK = iKind; vLN = aNrm;
  gl_Position = uVP * vec4(w, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vW, vN, vL, vS, vLN;
flat in vec2 vK;
uniform vec3 uU;
uniform vec3 uWall, uRoof, uGlow, uGlow2, uGround;
uniform float uDust, uPass;                 // the dust on it; 0: the solid things, 1: the domes' glass, blended over them
${AIR_GLSL}
out vec4 frag;
void main() {
  int kind = int(vK.x + 0.5);
  float seed = vK.y;
  vec3 N = normalize(vN);
  vec3 dir = vW - uP0;
  float dist = length(dir);
  dir /= dist;
  if (dot(N, dir) > 0.0 && kind != 4 && kind != 10) N = -N;
  float mu0 = dot(uU, uSun);
  bool air = uAir.z > 0.5;
  float night = 1.0 - smoothstep(-0.12, 0.05, mu0);
  vec3 sunT = air ? exp(-(uRay + uHaze) * airmass(mu0)) : vec3(1.0);
  vec3 skyAmb = air ? (uRay * 0.35 + uHaze * 0.25) * clamp(mu0 * 2.0 + 0.4, 0.0, 1.0) * uSunI * 0.25 : vec3(0.004);
  float self = smoothstep(-0.04, 0.1, mu0);
  float up = dot(N, uU);
  bool wall = abs(up) < 0.5;
  // (each building its own: concrete, stone, brick, white render, the world's own dusty tones)
  vec3 tone = vec3(1.0);
  float pick = h21(vec2(seed * 31.7, 5.3));
  if (kind == 0 || kind == 2) tone = pick < 0.3 ? vec3(1.0) : pick < 0.5 ? vec3(1.18, 1.08, 0.9) : pick < 0.65 ? vec3(1.05, 0.62, 0.48) : pick < 0.82 ? vec3(1.35, 1.33, 1.28) : vec3(0.8, 0.84, 0.9);
  else tone = vec3(0.85 + 0.3 * pick);
  vec3 alb = (wall ? uWall : uRoof) * tone;
  vec3 emit = vec3(0.0);
  float glassy = 0.0;
  // the materials: a building's faces in floors and bays of windows; sheds' doors; tanks' bands; domes' glass in a lattice
  vec2 fp = vec2(abs(vLN.x) > abs(vLN.y) ? vL.y : vL.x, vL.z);     // (on a wall, in its own frame: along it, up it)
  float grime = 0.88 + 0.24 * vn(fp * 0.15 + seed * 50.0);
  if (kind == 0 || kind == 2 || kind == 8) {
    if (wall) {
      float fl = kind == 2 ? 3.6 : 3.3, bay = kind == 2 ? 1.8 : 2.6;
      vec2 cell = floor(vec2(fp.x / bay, fp.y / fl));
      vec2 f = fract(vec2(fp.x / bay, fp.y / fl));
      float win = kind == 8 ? step(0.1, f.y) : step(0.18, f.x) * step(f.x, kind == 2 ? 0.96 : 0.78) * step(0.28, f.y) * step(f.y, 0.86);
      if (vL.z < 3.0 && kind != 8) win *= 0.5;
      float on = step(h21(cell + seed * 97.0), kind == 8 ? 1.0 : 0.38 * night + 0.03);
      vec3 gc = h21(cell + seed * 13.0) < 0.7 ? uGlow : uGlow2;
      vec3 glass = vec3(0.05, 0.065, 0.08);
      alb = mix(alb * grime, glass, win);
      glassy = win * (kind == 2 ? 1.0 : 0.6);
      emit += gc * win * on * (kind == 8 ? 1.4 : 0.95) * (0.6 + 0.8 * h21(cell + seed)) * (0.08 + 0.92 * night);   // (a lit room by day: not seen)
    } else alb *= grime;
  } else if (kind == 1) {
    // a shed: ribbed metal, a great door on its front
    alb = uWall * 0.9 * (0.9 + 0.1 * step(0.5, fract(fp.x / 1.2)));
    if (wall && abs(vLN.y) > 0.5 && abs(vL.x) < vS.x * 0.36 && vL.z < vS.z * 0.8) alb *= 0.55;
    if (!wall) alb = uRoof * (0.85 + 0.15 * step(0.5, fract(vL.x / 2.0)));
    emit += uGlow * 0.08 * night * step(0.9, fract(fp.x / 24.0)) * step(vL.z, 4.0);
  } else if (kind == 3) {
    alb = vec3(0.62, 0.62, 0.6) * (0.92 + 0.08 * step(0.5, fract(vL.z / 4.0)));
  } else if (kind == 4 || kind == 10) {
    // glass in a lattice of ribs: the district under it seen through (this is drawn over it, blended),
    // the sky given back at a grazing look, by night its lights glowing in the glass (a farm's green)
    vec3 h = vL / max(vS, vec3(1.0));
    float lon = atan(h.y, h.x) * 24.0 / 6.2831853, lat = asin(clamp(h.z * 2.0, 0.0, 1.0)) * 9.0 / 1.5707963;
    // (the ribs as lines of a width, smoothed over a pixel however far: no dashes in the distance)
    float dl = min(fract(lon), 1.0 - fract(lon)), dt = min(fract(lat), 1.0 - fract(lat));
    float wl = fwidth(lon), wt = fwidth(lat);
    float rib = max(1.0 - smoothstep(0.025 - wl, 0.025 + wl, dl), 1.0 - smoothstep(0.03 - wt, 0.03 + wt, dt));
    rib *= mix(1.0, 0.5, smoothstep(0.08, 0.3, max(wl, wt)));             // (a lattice finer than the pixels: a haze of frame)
    alb = mix(vec3(0.02), uRoof * 0.9, rib);
    glassy = 1.0 - rib;
    emit += (kind == 10 ? uGlow2 * 0.18 : uGlow * 0.05) * (1.0 - rib) * night * (0.6 + 0.4 * vn(h.xy * 8.0 + seed * 10.0));
  } else if (kind == 5) {
    alb = vec3(0.16, 0.156, 0.15) * (0.92 + 0.08 * vn(vL.xy / 2.0));
  } else if (kind == 6) {
    vec2 g = fract(vL.xy / vec2(1.1, 1.1));
    alb = mix(vec3(0.02, 0.03, 0.06), vec3(0.3), max(step(0.94, g.x), step(0.94, g.y)));
    glassy = 0.7;
  } else if (kind == 7) {
    // a habitat under a berm of the ground's own dust; a lit port in its end now and then
    alb = uWall * 0.85 * (0.8 + 0.4 * vn(vL.xy / 6.0 + seed * 40.0));
    if (wall) emit += uGlow * 0.5 * night * step(0.985, h21(floor(fp / 3.0) + seed * 7.0)) * step(1.0, vL.z) * step(vL.z, 2.6);
  } else if (kind == 9) {
    alb = uWall * (0.85 + 0.15 * step(0.5, fract(vL.x / 6.0)));
    if (wall) emit += uGlow * 0.25 * night * step(0.82, fract(vL.x / 10.0)) * step(2.0, vL.z) * step(vL.z, 4.5);
  } else if (kind == 11) {
    alb = vec3(0.5, 0.5, 0.48) * (0.9 + 0.1 * step(0.5, fract(vL.z / 3.0)));
  }
  // the world's dust on it (the more on what faces up); a little darker near the ground, where the light is shut out
  alb = mix(alb, uGround * 1.4, uDust * (up > 0.5 ? 1.0 : 0.45) * (1.0 - glassy));
  float ao = 0.65 + 0.35 * smoothstep(0.0, 6.0, vL.z + (up > 0.5 ? 6.0 : 0.0));
  // the Sun through the air, the sky's light, and the sunlit ground's thrown back onto what faces it
  vec3 bounce = uGround * sunT * uSunI * 0.7 * max(mu0, 0.0) * 0.5 * (1.0 - up);
  // (by night, the lit ground round it throws a little of its light up its walls)
  vec3 lamplit = uGlow * 0.05 * night * (1.0 - smoothstep(0.0, 30.0, vL.z)) * (1.0 - max(up, 0.0));
  vec3 col = alb * ao * (uSunI * 0.7 * max(dot(N, uSun), 0.0) * self * sunT + skyAmb * (0.7 + 0.3 * up) + bounce + lamplit + vec3(0.012) * night);
  // glass gives back the sky (more at a grazing look), the Sun's glint
  float fres = pow(1.0 - abs(dot(N, dir)), 4.0);
  vec3 hv = normalize(uSun - dir);
  col += glassy * (skyAmb * 1.6 * (0.2 + 0.8 * fres) + sunT * uSunI * 0.5 * pow(max(dot(N, hv), 0.0), 120.0) * self);
  col += emit;
  // glass (a dome's): what it gives back, over what is behind it (premultiplied: its frame solid)
  float a = 1.0;
  if (kind == 4 || kind == 10) { a = mix(0.1 + 0.55 * fres, 1.0, 1.0 - glassy); col = mix(col * a, col, 1.0 - glassy); }
  // the air between it and the eye, as the ground's
  if (air) {
    vec3 q = uP0 - uS;
    vec2 ta = shell(q, dir, uR + uAir.x, uAir.x);
    vec3 tauV, Lr, Lm;
    if (ta.y > 0.0) { airAlong(q, dir, max(ta.x, 0.0), min(dist, ta.y), tauV, Lr, Lm); col = col * exp(-tauV) + skyOf(dir, Lr, Lm) * a; }
  }
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  frag = vec4(col, a);
}`;

// lights: points, sized by distance, through the air; the moving ones along their way
const LVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aA;
layout(location = 1) in vec3 aB;
layout(location = 2) in vec4 aP;            // speed (m/s; 0: fixed), phase, kind, size (m)
uniform mat4 uVP;
uniform vec3 uO, uE1, uE2, uU;
uniform float uRw, uFocal;
${AIR_GLSL}
out vec3 vC;
out float vI;
void main() {
  int kind = int(aP.z + 0.5);
  vec3 p = aA;
  float night = 1.0 - smoothstep(-0.12, 0.05, dot(uU, uSun));
  float I = 1.0;
  vec3 c = vec3(1.0, 0.8, 0.55);
  if (kind == 0) { c = vec3(1.0, 0.72, 0.42); I = night * 1.4; }
  else if (kind == 1) { c = vec3(1.0, 0.12, 0.06); I = 2.2 * step(0.55, fract(uTime * 0.5 + aP.y)); }
  else if (kind == 2 || kind == 3) {
    float len = max(length(aB - aA), 1.0);
    p = mix(aA, aB, fract(aP.y + uTime * aP.x / len));
    c = kind == 2 ? vec3(1.0, 0.95, 0.85) : vec3(1.0, 0.1, 0.05);
    I = (kind == 2 ? 1.5 : 0.9) * (0.35 + 0.65 * night);
  }
  else if (kind == 4) { c = vec3(1.0, 0.7, 0.3); I = 1.6 * (0.6 + 0.4 * step(0.5, fract(uTime * 0.8 + aP.y * 3.0))); }
  else if (kind == 5) { c = vec3(0.9, 0.95, 1.0); I = 6.0 * step(0.96, fract(uTime * 0.7 + aP.y)); }
  else if (kind == 6) {
    // a craft lifting off its pad (or coming down to it): up on its plume, a few minutes of a cycle
    float k = fract(aP.y + uTime * aP.x);
    float rise = smoothstep(0.55, 1.0, k);
    p = vec3(aA.xy, aB.z * rise * rise);
    c = vec3(1.0, 0.62, 0.3);
    I = rise > 0.001 ? 12.0 : 0.0;
  }
  else if (kind == 7) { c = vec3(0.95, 0.93, 0.85); I = night * 2.2; }
  float z = p.z - dot(p.xy, p.xy) / (2.0 * uRw);
  vec3 w = uO + uE1 * p.x + uE2 * p.y + uU * z;
  vec3 d = w - uP0;
  float dist = length(d);
  // (a lamp is a fixed few pixels wide however far: its light thins as its disc would)
  float px = aP.w * uFocal / max(dist, 1.0);
  gl_PointSize = clamp(px * 6.0, 2.0, 28.0);
  I *= min(1.0, px * 6.0 / 2.0);
  vec3 T = vec3(1.0);
  if (uAir.z > 0.5) {
    vec3 q = uP0 - uS, dir = d / max(dist, 1.0);
    vec2 ta = shell(q, dir, uR + uAir.x, uAir.x);
    vec3 tauV, Lr, Lm;
    if (ta.y > 0.0) { airAlong(q, dir, max(ta.x, 0.0), min(dist, ta.y), tauV, Lr, Lm); T = exp(-tauV); }
  }
  vC = c * T;
  vI = I;
  gl_Position = uVP * vec4(w, 1.0);
}`;

const LFS = `#version 300 es
precision highp float;
in vec3 vC;
in float vI;
uniform float uTonemap, uExposure;
out vec4 frag;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  float a = exp(-r2 * 9.0) + 0.25 * exp(-r2 * 2.0);
  vec3 col = vC * vI * a;
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  frag = vec4(col, 0.0);
}`;

// the pools of light on the ground under the lamps by night: a disc lying on the ground, its light
// what the ground there gives back of it, through the air to the eye
const PVS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQ;
layout(location = 1) in vec4 iP;            // x, y (m, the pad's frame), its radius (m), its strength
uniform mat4 uVP;
uniform vec3 uO, uE1, uE2, uU;
uniform float uRw;
out vec2 vQ;
out vec3 vW;
out float vI;
void main() {
  vec2 xy = iP.xy + aQ * iP.z;
  float z = 0.05 - dot(xy, xy) / (2.0 * uRw);
  vec3 w = uO + uE1 * xy.x + uE2 * xy.y + uU * z;
  vQ = aQ; vW = w; vI = iP.w;
  gl_Position = uVP * vec4(w, 1.0);
}`;
const PFS = `#version 300 es
precision highp float;
in vec2 vQ;
in vec3 vW;
in float vI;
uniform vec3 uU, uGround, uGlow;
${AIR_GLSL}
out vec4 frag;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float night = 1.0 - smoothstep(-0.12, 0.05, dot(uU, uSun));
  vec3 lc = vI < 0.0 ? vec3(0.85, 0.9, 1.0) : uGlow;
  vec3 col = lc * (uGround * 2.2 + 0.05) * abs(vI) * night * pow(1.0 - r2, 2.0);
  vec3 dir = vW - uP0;
  float dist = length(dir);
  dir /= dist;
  if (uAir.z > 0.5) {
    vec3 q = uP0 - uS;
    vec2 ta = shell(q, dir, uR + uAir.x, uAir.x);
    vec3 tauV, Lr, Lm;
    if (ta.y > 0.0) { airAlong(q, dir, max(ta.x, 0.0), min(dist, ta.y), tauV, Lr, Lm); col *= exp(-tauV); }
  }
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  frag = vec4(col, 0.0);
}`;

// ---- DRAWING ----

let P = null;

function setup(gl) {
  if (P && P.gl === gl) return P;
  P = { gl, prog: program(gl, VS, FS), lprog: program(gl, LVS, LFS), pprog: program(gl, PVS, PFS), shapes: {} };
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  P.quad = qb;
  for (const [k, v] of Object.entries({ box: boxShape(), cyl: cylShape(), dome: domeShape() })) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    P.shapes[k] = { buf, n: v.length / 6 };
  }
  return P;
}

/** A town's buffers on this GL context (made once). */
function buffersOf(gl, p, t) {
  if (t.$gl?.gl === gl) return t.$gl;
  const vaos = {};
  for (const k of ['box', 'cyl', 'dome']) {
    const data = t[k];
    if (!data.length) continue;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.shapes[k].buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const S = 36;
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, S, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 12); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, S, 28); gl.vertexAttribDivisor(4, 1);
    vaos[k] = { vao, n: p.shapes[k].n, count: data.length / 9 };
  }
  let lights = null;
  if (t.lights.length) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const lb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lb);
    gl.bufferData(gl.ARRAY_BUFFER, t.lights, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
    lights = { vao, count: t.lights.length / 10 };
  }
  let pools = null;
  if (t.pools.length) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, t.pools, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(1, 1);
    pools = { vao, count: t.pools.length / 4 };
  }
  gl.bindVertexArray(null);
  t.$gl = { gl, vaos, lights, pools };
  return t.$gl;
}

/**
 * Draw the spaceport and town round scene.world.pad (scene.world.town:
 * { world, port }), when the eye is near enough the ground to see them.
 */
export function drawTown(gl, scene) {
  const w = scene.world, pad = w?.pad, tw = w?.town;
  if (!pad || !tw || !scene.ray || (w.eyeH ?? 0) > TOWN_ALT_M) return;
  const p = setup(gl);
  const t = townOf(tw.world, tw.port, pad.r);
  const bufs = buffersOf(gl, p, t);
  const U = pad.up, E1 = norm3(cross3(U, [0, 0, 1])), E2 = cross3(U, E1);
  // the buildings
  gl.useProgram(p.prog.p);
  let u = p.prog.u;
  setAir(gl, u, scene);
  gl.uniformMatrix4fv(u.uVP, false, scene.ray.VP);
  gl.uniform3fv(u.uO, pad.p); gl.uniform3fv(u.uE1, E1); gl.uniform3fv(u.uE2, E2); gl.uniform3fv(u.uU, U);
  gl.uniform1f(u.uRw, w.R);
  gl.uniform3fv(u.uWall, t.style.wall); gl.uniform3fv(u.uRoof, t.style.roof); gl.uniform3fv(u.uGlow, t.style.glow); gl.uniform3fv(u.uGlow2, t.style.glow2);
  gl.uniform3fv(u.uGround, t.style.ground); gl.uniform1f(u.uDust, t.style.dust);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  // the solid things first, then the domes' glass over them (blended, behind nothing it doesn't hide)
  gl.uniform1f(u.uPass, 0);
  for (const k of ['box', 'cyl']) {
    const v = bufs.vaos[k];
    if (!v) continue;
    gl.bindVertexArray(v.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, v.n, v.count);
  }
  if (bufs.vaos.dome) {
    gl.uniform1f(u.uPass, 1);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(bufs.vaos.dome.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, bufs.vaos.dome.n, bufs.vaos.dome.count);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
  // the pools of light on the ground, added (drawn a hair toward the eye, so the ground under them doesn't hide them)
  if (bufs.pools) {
    gl.useProgram(p.pprog.p);
    u = p.pprog.u;
    setAir(gl, u, scene);
    gl.uniformMatrix4fv(u.uVP, false, scene.ray.VP);
    gl.uniform3fv(u.uO, pad.p); gl.uniform3fv(u.uE1, E1); gl.uniform3fv(u.uE2, E2); gl.uniform3fv(u.uU, U);
    gl.uniform1f(u.uRw, w.R);
    gl.uniform3fv(u.uGround, t.style.ground); gl.uniform3fv(u.uGlow, t.style.glow);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -8);
    gl.bindVertexArray(bufs.pools.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, bufs.pools.count);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
  // the lights, added over what is there, hidden by what stands in front of them
  if (bufs.lights) {
    gl.useProgram(p.lprog.p);
    u = p.lprog.u;
    setAir(gl, u, scene);
    gl.uniformMatrix4fv(u.uVP, false, scene.ray.VP);
    gl.uniform3fv(u.uO, pad.p); gl.uniform3fv(u.uE1, E1); gl.uniform3fv(u.uE2, E2); gl.uniform3fv(u.uU, U);
    gl.uniform1f(u.uRw, w.R);
    gl.uniform1f(u.uFocal, scene.focalPx || 1);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(bufs.lights.vao);
    gl.drawArrays(gl.POINTS, 0, bufs.lights.count);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
  gl.bindVertexArray(null);
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
