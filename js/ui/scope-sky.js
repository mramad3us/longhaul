// ============================================================
// LONGHAUL — The sky through the telescope: stars, worlds, the Sun
//
// Everything here is drawn from numbers, nothing loaded: the game plays
// offline. Each world gets a surface made once from its own seed (a map in
// longitude and latitude: bands and storms for the giants, oceans,
// continents and cloud for Earth, maria and craters for the Moon, rust and
// polar caps for Mars, ice and lineae for Europa…), and is drawn pixel by
// pixel as a sphere: turned by its rotation, lit from the Sun's side at
// the phase we see it (the terminator, the night side dark, Earth's
// cities on it), its limb darkened where it has an atmosphere and ringed
// by the air's scattered light, Saturn inside its rings. Small rocks are
// not round. The Sun is seen through the solar filter: a limb-darkened
// disc, granulation, sunspots turning with it.
//
// A world's picture is cached and redrawn only when it has turned, the
// phase moved, or its size on the screen changed, so a disc costs little
// a frame. The stars are the sky's own (the same stars in the same places
// whatever the field), as many as the exposure reaches; while the mount
// slews they streak.
// ============================================================

import { BODIES } from '../sim/ephemeris.js';

const TW = 512, TH = 256;                 // a surface map, longitude × latitude
const DW = 256, DH = 128;                 // …whose features are laid out on this grid (scaled up)
const MAX_R = 220;                        // a disc is ray-cast at most this many pixels in radius (then scaled)
const CELL = 2.5e-4;                      // the faint sky, in cells this many radians on a side
const STARS_PER_CELL = 17.6;              // to magnitude 19 (~2.8e8 per steradian)
const STAR_FAINT = 19;
const BRIGHT_CELL = 0.02;                 // the bright sky (to magnitude 9), for wide fields
const BRIGHT_PER_CELL = 3.6;
const BRIGHT_FAINT = 9;

// ---- RANDOMNESS (the UI's own, seeded: the same world every time) ----

/** A repeatable 0–1 from integers. */
export function hash(a, b, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const strSeed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
/** A seeded generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Smooth value noise on a wrapped grid (period px across), 0–1. */
function noise2(x, y, seed, period) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (i) => ((i % period) + period) % period;
  const v = (i, j) => hash(w(i), j, seed);
  const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Fractal noise: octaves of value noise, 0–1. */
function fbm(x, y, seed, period, oct = 4) {
  let s = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < oct; o++) { s += amp * noise2(x, y, seed + o * 101, period); norm += amp; x *= 2; y *= 2; period *= 2; amp *= 0.5; }
  return s / norm;
}

// ---- SURFACES ----

/** 0 below e0, 1 above e1, smooth between: soft edges (coasts, caps, spots) instead of steps. */
const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/**
 * How each world is made: its look ('giant', 'earth', 'rock', 'ice'…),
 * colours, and the features to paint. Worlds not listed are grey rock in
 * their ephemeris colour.
 */
const LOOK = {
  Sol: { kind: 'sun' },
  Mercury: { kind: 'rock', base: '#9C8E78', dark: '#6E6352', craters: 220 },
  Venus: { kind: 'cloud', base: '#E9D4A2', band: '#D7B983', atmo: [255, 236, 190] },
  Earth: { kind: 'earth', atmo: [120, 170, 255] },
  Luna: { kind: 'rock', base: '#A7A7A2', dark: '#5C5C5A', maria: 9, craters: 260 },
  Mars: { kind: 'mars', base: '#B9573A', dark: '#6F3423', atmo: [196, 178, 190], caps: true },   // (terraformed: a thin pale sky at its limb)
  Phobos: { kind: 'rock', base: '#6E665C', dark: '#4B453E', craters: 70, irregular: 0.28 },
  Deimos: { kind: 'rock', base: '#7A7264', dark: '#57514A', craters: 40, irregular: 0.22 },
  Jupiter: { kind: 'giant', bands: ['#D9C6A4', '#B3875C', '#E8DCC2', '#A9774E', '#DCCBAA', '#C59A6C', '#E5D7BB', '#9E6E48'], spot: '#B5523A', limb: 0.55, atmo: [255, 230, 190] },
  Io: { kind: 'io', base: '#E2C25A', dark: '#9C5A2A' },
  Europa: { kind: 'europa', base: '#D8CDB7', dark: '#8E6B4E' },
  Ganymede: { kind: 'rock', base: '#8F8676', dark: '#5D554B', light: '#C9C2B6', craters: 160 },
  Callisto: { kind: 'rock', base: '#5E564C', dark: '#3F3A34', light: '#BDB8AE', craters: 280 },
  Saturn: { kind: 'giant', bands: ['#E6D3A3', '#D1B47E', '#EADBB5', '#C9A973', '#E2CC98', '#D8BD88'], limb: 0.5, rings: true, atmo: [255, 236, 200] },
  Mimas: { kind: 'rock', base: '#BDBDB8', dark: '#8A8A86', craters: 120, big: 0.35 },
  Enceladus: { kind: 'ice', base: '#EEF4F6', dark: '#C9D6DC' },
  Tethys: { kind: 'rock', base: '#CFCFCB', dark: '#9E9E9A', craters: 140 },
  Dione: { kind: 'rock', base: '#C2C2BE', dark: '#8E8E8A', craters: 140 },
  Rhea: { kind: 'rock', base: '#BEBEBA', dark: '#888884', craters: 160 },
  Titan: { kind: 'cloud', base: '#D59A45', band: '#C38634', atmo: [235, 170, 90], haze: true },
  Iapetus: { kind: 'iapetus', base: '#C8C3B6', dark: '#3A3128' },
  Uranus: { kind: 'giant', bands: ['#9FDCE2', '#94D3DA', '#A6E0E6'], limb: 0.45, atmo: [190, 240, 245] },
  Neptune: { kind: 'giant', bands: ['#4F74C9', '#4468BB', '#5A80D2', '#4166B8'], spot: '#24366E', limb: 0.5, atmo: [150, 190, 255] },
  Ceres: { kind: 'rock', base: '#77736B', dark: '#58554F', craters: 180, bright: true },
  Vesta: { kind: 'rock', base: '#9A8C70', dark: '#6C624F', craters: 120, irregular: 0.16, big: 0.5 },
  Pallas: { kind: 'rock', base: '#7C7A70', dark: '#5A5850', craters: 110, irregular: 0.14 },
  Hygiea: { kind: 'rock', base: '#605C54', dark: '#46433D', craters: 90 },
  Juno: { kind: 'rock', base: '#8C7C68', dark: '#625748', craters: 70, irregular: 0.2 },
  Interamnia: { kind: 'rock', base: '#6E645A', dark: '#4E4740', craters: 70, irregular: 0.12 },
};

const surfaces = new Map();

/** A world's surface map: { rgb (Uint8 TW×TH×3), lights (night lights, or null), look }. */
function surfaceOf(name, color) {
  let s = surfaces.get(name);
  if (s) return s;
  const look = LOOK[name] || { kind: 'rock', base: color || '#808080', dark: '#555555', craters: 120 };
  const seed = strSeed(name);
  const rnd = rng(seed);
  const rgb = new Uint8Array(TW * TH * 3);
  const lights = look.kind === 'earth' ? new Uint8Array(TW * TH) : null;
  const put = (i, c) => { rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; };
  const base = hex(look.base || '#808080'), dark = hex(look.dark || '#404040'), light = look.light ? hex(look.light) : null;
  // features first: maria, craters, storms (centres in u, v; radii in map pixels); most craters small
  const K = TW / DW;
  const blobs = [];
  for (let k = 0; k < (look.maria || 0); k++) blobs.push({ u: rnd() * TW, v: TH * (0.22 + rnd() * 0.56), r: (10 + rnd() * 22) * K });
  const craters = [];
  for (let k = 0; k < (look.craters || 0); k++) { const r = (Math.pow(rnd(), 3) * 10 + 0.7) * K; craters.push({ u: rnd() * TW, v: TH * (0.06 + rnd() * 0.88), r, fresh: rnd() < 0.12 }); }
  if (look.big) craters.push({ u: TW * 0.3, v: TH * 0.55, r: TW * look.big * 0.25, fresh: false });
  for (let y = 0; y < TH; y++) {
    const lat = (0.5 - (y + 0.5) / TH) * Math.PI;
    for (let x = 0; x < TW; x++) {
      const i = y * TW + x, X = x / K, Y = y / K;
      const n = fbm(X / 16, Y / 16, seed, DW / 16, 5);
      let c;
      switch (look.kind) {
        case 'giant': {
          // belts and zones, their edges wavy, turbulence along them; a storm or two
          const bands = look.bands.map(hex);
          const t = (Y / DH) * bands.length * 1.7 + (fbm(X / 32, Y / 8, seed, DW / 32, 4) - 0.5) * 1.3;
          const k0 = Math.floor(t), f = t - k0;
          c = mix(bands[((k0 % bands.length) + bands.length) % bands.length], bands[(((k0 + 1) % bands.length) + bands.length) % bands.length], f * f * (3 - 2 * f));
          c = mix(c, [c[0] * 0.85, c[1] * 0.82, c[2] * 0.8], fbm(X / 8, Y / 4, seed + 7, DW / 8, 3) * 0.6);
          if (look.spot) {
            const du = Math.min(Math.abs(X - DW * 0.62), DW - Math.abs(X - DW * 0.62)) / (DW * 0.05), dv = (Y - DH * 0.64) / (DH * 0.045);
            const d = du * du + dv * dv;
            if (d < 1) c = mix(c, hex(look.spot), (1 - d) * 0.85);
          }
          break;
        }
        case 'cloud': {
          const t = Math.sin(lat * 7 + (n - 0.5) * 4) * 0.5 + 0.5;
          c = mix(base, hex(look.band), t * 0.45 + n * 0.25);
          if (look.haze) c = mix(c, base, 0.6);
          break;
        }
        case 'earth': {
          const land = fbm(X / 32, Y / 32, seed, DW / 32, 4);
          const ocean = mix([16, 42, 98], [30, 72, 140], Math.min(1, land * 1.7));
          const dry = fbm(X / 16, Y / 16, seed + 3, DW / 16, 3);
          const ground = mix(mix([52, 92, 48], [112, 108, 70], dry), [176, 146, 98], sstep(0.5, 0.62, dry) * sstep(0.6, 0.3, Math.abs(lat)));
          c = mix(ocean, ground, sstep(0.555, 0.575, land));
          c = mix(c, [228, 236, 242], sstep(1.08, 1.2, Math.abs(lat) + (n - 0.5) * 0.25));
          if (lights && land > 0.57 && Math.abs(lat) < 1.0 && rnd() < 0.07 * (land - 0.5) * 4) lights[i] = 120 + Math.floor(rnd() * 135);
          // clouds: swirled bands, thicker at the storm latitudes
          const cl = fbm(X / 16 + Math.sin(Y / 9) * 1.5, Y / 16, seed + 9, DW / 16, 5);
          const cover = Math.max(0, (cl - 0.5) * 2.6) * (0.75 + 0.25 * Math.cos(lat * 4));
          c = mix(c, [246, 248, 250], Math.min(0.92, cover));
          break;
        }
        case 'mars': {
          const d = fbm(X / 16, Y / 16, seed + 1, DW / 16, 5);
          c = mix(base, dark, sstep(0.46, 0.62, d) * 0.85);
          c = mix(c, [210, 140, 100], Math.max(0, (n - 0.6)) * 0.8);
          // terraformed: the young northern sea over the low plains, a lake in the low basins, lichen and grass round the water
          const low = 1 - sstep(0.38, 0.5, d);
          const sea = sstep(0.42, 0.55, lat + (n - 0.5) * 0.25) * low;
          c = mix(c, [112, 108, 70], sstep(0.2, 0.6, low) * 0.35 * (1 - sea));
          c = mix(c, [38, 62, 84], Math.min(1, sea * 1.4 + (d < 0.3 ? 0.8 : 0)));
          c = mix(c, [236, 232, 226], sstep(1.3, 1.4, Math.abs(lat) + (n - 0.5) * 0.2));
          break;
        }
        case 'io': {
          // sulphur plains; the volcanoes and their red rings are painted after
          c = mix(base, [236, 220, 130], n);
          c = mix(c, [214, 170, 80], sstep(0.55, 0.7, fbm(X / 16, Y / 16, seed + 5, DW / 16, 3)) * 0.5);
          break;
        }
        case 'europa': {
          c = mix(base, [236, 230, 218], n * 0.6);
          // lineae: long brownish cracks in two families, warped
          const w1 = fbm(X / 32, Y / 32, seed + 2, DW / 32, 3), w2 = fbm(X / 16, Y / 16, seed + 4, DW / 16, 3);
          const l1 = Math.abs(Math.sin(X * Math.PI * 6 / DW + Y * 0.21 + w1 * 11));
          const l2 = Math.abs(Math.sin(X * Math.PI * 10 / DW - Y * 0.17 + w2 * 9));
          c = mix(c, dark, Math.max(sstep(0.11, 0.03, l1) * 0.55, sstep(0.08, 0.02, l2) * 0.38));
          c = mix(c, [176, 132, 100], sstep(0.62, 0.75, w2) * 0.35);
          break;
        }
        case 'ice': c = mix(base, dark, n * 0.4); break;
        case 'iapetus': {
          const lead = Math.cos((X / DW) * Math.PI * 2 - 0.3);
          c = mix(base, dark, Math.max(0, Math.min(1, lead * 1.6 + (n - 0.5))));
          break;
        }
        default: c = mix(base, dark, Math.max(0, n - 0.35) * 1.1);
      }
      put(i, c);
    }
  }
  // maria (soft dark seas)
  for (const b of blobs) paint(rgb, b.u, b.v, b.r, (c, f) => mix(c, dark, Math.min(1, f * 1.6) * 0.8));
  // craters: a darker floor, a lighter rim (soft), the young ones with bright ejecta round them
  for (const cr of craters) {
    if (cr.fresh) paint(rgb, cr.u, cr.v, cr.r * 2.4, (c, f) => mix(c, light || [Math.min(255, c[0] * 1.35), Math.min(255, c[1] * 1.35), Math.min(255, c[2] * 1.35)], f * f * 0.35));
    paint(rgb, cr.u, cr.v, cr.r * 1.2, (c, f, d) => d > 0.78 ? mix(c, light || [Math.min(255, c[0] * 1.15), Math.min(255, c[1] * 1.15), Math.min(255, c[2] * 1.15)], Math.max(0, 1 - Math.abs(d - 0.88) * 9) * 0.22)
      : mix(c, dark, (0.12 + 0.14 * (1 - d)) * Math.min(1, cr.r / 3)));
  }
  // Io's volcanoes: dark vents, red and orange rings of fallout round the big ones
  if (look.kind === 'io') {
    for (let k = 0; k < 70; k++) paint(rgb, rnd() * TW, TH * (0.1 + rnd() * 0.8), (0.6 + Math.pow(rnd(), 2) * 2.2) * K, (c, f) => mix(c, dark, f * 0.85));
    for (let k = 0; k < 6; k++) {
      const u = rnd() * TW, v = TH * (0.2 + rnd() * 0.6), r = (5 + rnd() * 9) * K, sk = rnd() * 9;
      // the fallout ring: lopsided and patchy, as a plume's fallout is
      paint(rgb, u, v, r, (c, f, d) => mix(c, [196, 96, 52], Math.max(0, 1 - Math.abs(d - 0.7) * 3.2) * 0.45 * (0.4 + 0.6 * noise2(u / 3 + d * 5, v / 3 + sk, seed + k, 1e9))));
      paint(rgb, u + (rnd() - 0.5) * r * 0.3, v, r * 0.22, (c, f) => mix(c, [48, 30, 20], f * 0.85));
    }
  }
  if (look.bright) for (let k = 0; k < 3; k++) paint(rgb, rnd() * TW, TH * (0.35 + rnd() * 0.3), 0.7 * K, (c, f) => mix(c, [250, 250, 245], f));
  s = { rgb, lights, look, seed };
  surfaces.set(name, s);
  return s;
}

/** Apply `fn(colour, falloff 0–1, d (distance / r))` within r of (u, v) on the map (wrapping in longitude, squeezed toward the poles). */
function paint(rgb, u, v, r, fn) {
  for (let y = Math.max(0, Math.floor(v - r)); y <= Math.min(TH - 1, Math.ceil(v + r)); y++) {
    const lat = (0.5 - (y + 0.5) / TH) * Math.PI;
    const sx = 1 / Math.max(0.2, Math.cos(lat));
    for (let x = Math.floor(u - r * sx); x <= Math.ceil(u + r * sx); x++) {
      const dx = (x - u) / sx, dy = y - v, d = Math.hypot(dx, dy) / r;
      if (d > 1) continue;
      const xi = ((x % TW) + TW) % TW, i = (y * TW + xi) * 3;
      const c = fn([rgb[i], rgb[i + 1], rgb[i + 2]], 1 - d * d, d);
      rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
    }
  }
}

// ---- A WORLD, AS A SPHERE ----

/**
 * Draws worlds (and the Sun) through the telescope, caching each one's
 * last picture. A disc up to MAX_R pixels in radius is cast whole and
 * scaled; a bigger one (a world filling the frame) only where the frame
 * shows it, at screen resolution or near it, so a close world is as sharp
 * as a far one.
 */
export class SkyPainter {
  constructor() { this.cache = new Map(); }

  /**
   * The world `v` (sim/telescope.js bodySight) at screen (x, y), its radius
   * rPx: the box round it, for the reticle (null if off the frame). o: {
   * days (sim days: its rotation), blurPx, alpha, W, H (the frame) }.
   */
  drawWorld(ctx, v, x, y, rPx, o = {}) {
    if (v.sun) return this.drawSun(ctx, v, x, y, rPx, o);
    const b = v.body;
    const rings = !!LOOK[b.name]?.rings;
    const rot = ((o.days || 0) / Math.abs(b.rotH / 24 || 1)) % 1 * (b.rotH < 0 ? -1 : 1);
    const view = viewOf(x, y, rPx, o.W, o.H, 1.12);
    if (view) {
      const key = `${view.key}|${(v.phase * 180 / Math.PI).toFixed(0)}|${v.sunRight}|${Math.round(rot * 720)}`;
      let c = this.cache.get(b.name);
      if (!c || c.key !== key) c = this.raster(b, v.phase, v.sunRight, rot, view, key);
      ctx.save();
      ctx.globalAlpha = o.alpha ?? 1;
      if (o.blurPx > 0.4) ctx.filter = `blur(${o.blurPx.toFixed(1)}px)`;
      if (rings) this.rings(ctx, x, y, rPx, v, 'back');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c.canvas, 0, 0, view.cw, view.ch, view.dx, view.dy, view.dw, view.dh);
      if (rings) this.rings(ctx, x, y, rPx, v, 'front');
      ctx.restore();
    } else if (rings) { this.rings(ctx, x, y, rPx, v, 'back'); this.rings(ctx, x, y, rPx, v, 'front'); }
    const ext = rings ? 2.3 : 1.08;
    return { x0: x - rPx * ext, y0: y - rPx * (rings ? 0.9 : 1.08), x1: x + rPx * ext, y1: y + rPx * (rings ? 0.9 : 1.08) };
  }

  /** A canvas of `view`'s size, kept per world. */
  canvasFor(name, view) {
    let c = this.cache.get(name);
    if (!c) { const canvas = document.createElement('canvas'); c = { canvas, ctx: canvas.getContext('2d'), img: null }; }
    if (c.canvas.width !== view.cw || c.canvas.height !== view.ch) { c.canvas.width = view.cw; c.canvas.height = view.ch; c.img = null; }
    if (!c.img) c.img = c.ctx.createImageData(view.cw, view.ch);
    return c;
  }

  /** Ray-cast a world over `view`: at a phase, the Sun on one side, turned `rot` (0–1). */
  raster(b, phase, sunRight, rot, view, key) {
    const surf = surfaceOf(b.name, b.color);
    const look = surf.look;
    const c = this.canvasFor(b.name, view);
    const data = c.img.data;
    data.fill(0);
    const sgn = sunRight ? 1 : -1;
    const Sx = sgn * Math.sin(phase), Sz = Math.cos(phase);
    const irr = look.irregular || 0;
    const limbK = look.limb ?? (look.atmo ? 0.25 : 0.1);
    const atmo = look.atmo || null;
    const rgb = surf.rgb, lights = surf.lights;
    const lon0 = rot * Math.PI * 2;
    const fine = view.rPx > 260;                  // close: the surface's own grain over the map
    const edge = (th) => 1 + irr * (fbm(Math.cos(th) * 2 + 5, Math.sin(th) * 2 + 5, surf.seed, 1e9, 3) - 0.5) * 2;
    const { cw, ch, ox, oy, step, invR } = view;
    for (let j = 0; j < ch; j++) {
      const ny0 = (oy + (j + 0.5) * step) * invR;
      for (let i = 0; i < cw; i++) {
        const nx0 = (ox + (i + 0.5) * step) * invR;
        let rr = nx0 * nx0 + ny0 * ny0;
        const k = (j * cw + i) * 4;
        if (rr > 1.25) continue;
        let scale = 1;
        if (irr) { scale = edge(Math.atan2(ny0, nx0)); rr /= scale * scale; }
        if (rr > 1) {
          // the air's scattered light just past the limb: bright on the day side, a faint ring all round backlit
          if (atmo && rr < 1.07) {
            const nx = nx0 / Math.sqrt(rr), lit = nx * Sx;
            const a = (1 - (Math.sqrt(rr) - 1) / 0.035) * (0.32 * Math.max(0, lit + 0.25) + 0.25 * Math.pow(Math.max(0, -Sz), 4));
            if (a > 0) { data[k] = atmo[0]; data[k + 1] = atmo[1]; data[k + 2] = atmo[2]; data[k + 3] = Math.min(255, a * 230); }
          }
          continue;
        }
        const nx = nx0 / scale, ny = ny0 / scale, nz = Math.sqrt(1 - rr);
        // the surface point, turned: longitude about the pole (screen up), latitude from the equator
        const lon = Math.atan2(nx, nz) + lon0, lat = Math.asin(Math.max(-1, Math.min(1, -ny)));
        const uf = (((lon / (Math.PI * 2)) % 1) + 1) % 1 * TW - 0.5, vf = Math.max(0, Math.min(TH - 1.001, (0.5 - lat / Math.PI) * TH - 0.5));
        const u0 = Math.floor(uf), v0 = Math.floor(vf), fu = uf - u0, fv = vf - v0;
        const ua = ((u0 % TW) + TW) % TW, ub = (ua + 1) % TW, vb = Math.min(TH - 1, v0 + 1);
        const t00 = (v0 * TW + ua) * 3, t10 = (v0 * TW + ub) * 3, t01 = (vb * TW + ua) * 3, t11 = (vb * TW + ub) * 3;
        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        const lam = nx * Sx + nz * Sz;
        // light: Lambert, a soft terminator, limb darkening where there is air
        let I = lam > 0 ? lam : 0;
        I *= Math.min(1, (lam + 0.06) / 0.12 + 0.5);
        I = Math.max(0, I) * (1 - limbK + limbK * Math.sqrt(nz)) + 0.012;
        if (fine) I *= 0.95 + 0.1 * noise2(uf * 1.5, vf * 1.5, surf.seed + 31, TW * 1.5);
        let r = (rgb[t00] * w00 + rgb[t10] * w10 + rgb[t01] * w01 + rgb[t11] * w11) * I;
        let g = (rgb[t00 + 1] * w00 + rgb[t10 + 1] * w10 + rgb[t01 + 1] * w01 + rgb[t11 + 1] * w11) * I;
        let bl = (rgb[t00 + 2] * w00 + rgb[t10 + 2] * w10 + rgb[t01 + 2] * w01 + rgb[t11 + 2] * w11) * I;
        // Earth's night side: its cities, points of light
        if (lights && lam < 0.03) {
          const li = lights[Math.round(vf) * TW + (Math.round(uf) % TW + TW) % TW];
          if (li) {
            const cu = 1 - Math.abs(uf - Math.round(uf)) * 2, cv = 1 - Math.abs(vf - Math.round(vf)) * 2;
            const f = Math.min(1, (0.03 - lam) * 8) * li / 255 * Math.pow(Math.max(0, cu * cv), view.rPx > 120 ? 3 : 0.5);
            r += 255 * f; g += 196 * f; bl += 120 * f;
          }
        }
        data[k] = Math.min(255, r); data[k + 1] = Math.min(255, g); data[k + 2] = Math.min(255, bl); data[k + 3] = 255;
      }
    }
    c.ctx.putImageData(c.img, 0, 0);
    c.key = key;
    this.cache.set(b.name, c);
    return c;
  }

  /** Saturn's rings, half of them: 'back' (behind the planet) or 'front'. Seen 20° open, lit from the Sun's side. */
  rings(ctx, x, y, rPx, v, half) {
    const open = 0.35, sb = Math.sin(open);
    const bands = [[1.24, 1.53, 0.18], [1.53, 1.95, 0.62], [1.95, 2.03, 0.04], [2.03, 2.27, 0.42]];
    const lit = 0.3 + 0.7 * Math.max(0, Math.cos(v.phase * 0.9));
    ctx.save();
    ctx.beginPath();
    if (half === 'back') ctx.rect(x - rPx * 3, y - rPx * 3, rPx * 6, rPx * 3);
    else ctx.rect(x - rPx * 3, y, rPx * 6, rPx * 3);
    ctx.clip();
    for (const [r0, r1, a] of bands) {
      const rm = (r0 + r1) / 2 * rPx, w = (r1 - r0) * rPx;
      ctx.strokeStyle = `rgba(226,206,160,${a * lit})`;
      ctx.lineWidth = Math.max(0.6, w * sb * 1.2 + w * 0.15);
      ctx.beginPath(); ctx.ellipse(x, y, rm, rm * sb, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  /** The Sun through the solar filter: a limb-darkened disc, granulation, sunspots in groups, a thin glow. */
  drawSun(ctx, v, x, y, rPx, o) {
    const rot = ((o.days || 0) / 25.4) % 1;
    const view = viewOf(x, y, rPx, o.W, o.H, 1.02);
    ctx.save();
    const g = ctx.createRadialGradient(x, y, rPx * 0.95, x, y, rPx * 1.6);
    g.addColorStop(0, 'rgba(255,190,110,0.35)'); g.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rPx * 1.6, 0, Math.PI * 2); ctx.fill();
    if (view) {
      const key = `${view.key}|${Math.round(rot * 720)}`;
      let c = this.cache.get('Sol');
      if (!c || c.key !== key) c = this.sunRaster(rot, view, key);
      if (o.blurPx > 0.4) ctx.filter = `blur(${o.blurPx.toFixed(1)}px)`;
      ctx.drawImage(c.canvas, 0, 0, view.cw, view.ch, view.dx, view.dy, view.dw, view.dh);
    }
    ctx.restore();
    return { x0: x - rPx * 1.05, y0: y - rPx * 1.05, x1: x + rPx * 1.05, y1: y + rPx * 1.05 };
  }

  sunRaster(rot, view, key) {
    const c = this.canvasFor('Sol', view);
    const d = c.img.data;
    d.fill(0);
    // sunspots: a few groups at ±5–35° latitude, each a leader, a follower and some small ones, turning with the Sun
    const r = rng(strSeed('Sol') + Math.floor(rot * 4));
    const spots = [];
    for (let gI = 0; gI < 5; gI++) {
      const glon = r() * Math.PI * 2, glat = (r() < 0.5 ? -1 : 1) * (0.09 + r() * 0.5);
      const n = 2 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) spots.push({ lon: glon + (k === 0 ? 0 : (r() - 0.3) * 0.12), lat: glat + (r() - 0.5) * 0.04, s: (k < 2 ? 0.009 : 0.004) + r() * 0.008 });
    }
    const lon0 = rot * Math.PI * 2;
    const { cw, ch, ox, oy, step, invR } = view;
    const fineK = Math.min(900, 60 * Math.max(1, view.rPx / 180));
    const gran = granules(), cellK = Math.max(0, Math.min(1, (view.rPx / 700 / step - 2) / 3));     // (a granule this many samples across)
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const nx = (ox + (i + 0.5) * step) * invR, ny = (oy + (j + 0.5) * step) * invR, rr = nx * nx + ny * ny;
      if (rr > 1) continue;
      const nz = Math.sqrt(1 - rr), k = (j * cw + i) * 4;
      const mu = nz;
      let I = 1 - 0.62 * (1 - mu) - 0.18 * (1 - mu) * (1 - mu);
      // granulation: fine cells; faculae bright toward the limb
      const lon = Math.atan2(nx, nz) + lon0, lat = Math.asin(-ny);
      I *= 0.93 + 0.1 * (0.65 * noise2(lon * fineK, lat * fineK, 77, 1e9) + 0.35 * noise2(lon * fineK * 2.3, lat * fineK * 2.3, 78, 1e9));
      // close in: granules, bright cells parted by dark lanes (sharp only when they span pixels)
      if (cellK > 0) { const gx = ((lon * GRAN_K) % GT + GT) % GT, gy = ((lat * GRAN_K) % GT + GT) % GT; I *= 1 - cellK * 0.28 + cellK * 0.28 * gran[(gy | 0) * GT + (gx | 0)] / 255; }
      if (mu < 0.35) I *= 1 + 0.12 * Math.max(0, noise2(lon * 14, lat * 14, 79, 1e9) - 0.55) * 4;
      for (const sp of spots) {
        const dl = Math.atan2(Math.sin(lon - sp.lon), Math.cos(lon - sp.lon));
        const dd = Math.hypot(dl * Math.cos(lat), lat - sp.lat) / sp.s;
        // the umbra dark, the penumbra grey-brown round it, the edge soft
        if (dd < 1.6) I *= dd < 0.55 ? 0.24 : dd < 1 ? 0.6 + 0.08 * Math.sin(Math.atan2(lat - sp.lat, dl) * 14) : 0.6 + 0.4 * (dd - 1) / 0.6;
      }
      d[k] = Math.min(255, 255 * I); d[k + 1] = Math.min(255, 196 * I); d[k + 2] = Math.min(255, 110 * I); d[k + 3] = 255;
    }
    c.ctx.putImageData(c.img, 0, 0);
    c.key = key;
    this.cache.set('Sol', c);
    return c;
  }
}

// The photosphere's granules, a tile made once: cells (distance to the nearest jittered point) with dark lanes
const GT = 256, GRAN_K = 700 * GT / 18;     // tile texels per radian of the Sun: granules ~1/700 of its radius (1,000 km)
let granTile = null;
function granules() {
  if (granTile) return granTile;
  const t = new Uint8Array(GT * GT), N = 18, cs = GT / N, pts = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pts.push([(i + hash(i, j, 3)) * cs, (j + hash(i, j, 4)) * cs]);
  for (let y = 0; y < GT; y++) for (let x = 0; x < GT; x++) {
    const ci = Math.floor(x / cs), cj = Math.floor(y / cs);
    let d1 = 1e9, d2 = 1e9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = (ci + di + N) % N, jj = (cj + dj + N) % N, p = pts[jj * N + ii];
      const px = p[0] + (ci + di < 0 ? -GT : ci + di >= N ? GT : 0), py = p[1] + (cj + dj < 0 ? -GT : cj + dj >= N ? GT : 0);
      const d = Math.hypot(x - px, y - py);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    t[y * GT + x] = Math.max(0, Math.min(255, 70 + 185 * Math.min(1, (d2 - d1) / (cs * 0.35))));
  }
  return (granTile = t);
}

/**
 * How to cast a disc at (x, y), radius rPx, into a frame W×H: whole (up to
 * MAX_R, then scaled), or only the part the frame shows, at screen
 * resolution or near it. null when it is off the frame.
 */
function viewOf(x, y, rPx, W = 1e5, H = 1e5, ext = 1.12) {
  if (rPx <= MAX_R) {
    const R = Math.max(2, Math.round(rPx)), pad = Math.ceil(R * (ext - 1)) + 2;
    const size = 2 * (R + pad), s = rPx / R;
    return { cw: size, ch: size, ox: -(R + pad), oy: -(R + pad), step: 1, invR: 1 / R, rPx, dx: x - (R + pad) * s, dy: y - (R + pad) * s, dw: size * s, dh: size * s, key: `d${R}` };
  }
  const x0 = Math.max(0, Math.floor(x - rPx * ext)), y0 = Math.max(0, Math.floor(y - rPx * ext));
  const x1 = Math.min(W, Math.ceil(x + rPx * ext)), y1 = Math.min(H, Math.ceil(y + rPx * ext));
  if (x1 <= x0 || y1 <= y0) return null;
  const vw = x1 - x0, vh = y1 - y0, step = Math.max(1, Math.max(vw, vh) / 480);
  const cw = Math.ceil(vw / step), ch = Math.ceil(vh / step);
  return { cw, ch, ox: x0 - x, oy: y0 - y, step, invR: 1 / rPx, rPx, dx: x0, dy: y0, dw: cw * step, dh: ch * step, key: `w${x0},${y0},${cw},${ch},${Math.round(rPx)},${Math.round(x * 4)},${Math.round(y * 4)}` };
}

// ---- THE STARS ----

/**
 * The stars behind (the same stars whatever the field): faint ones in
 * fine cells when the field is narrow, the bright ones in coarse cells
 * when it is wide; each drawn if the exposure reaches it (mShow), as wide
 * as the optics blur it (psfPx), streaked `streakPx` across while slewing.
 * `point(x, y, s, r, rgb)` draws a bright one.
 */
export function drawStars(ctx, W, H, bearing, fov, ppr, mShow, psfPx, streakPx, point) {
  const hw = fov / 2, hh = fov * H / W / 2;
  const fine = ((hw * 2) / CELL) * ((hh * 2) / CELL) <= 900;
  const cell = fine ? CELL : BRIGHT_CELL, per = fine ? STARS_PER_CELL : BRIGHT_PER_CELL, faint = fine ? STAR_FAINT : BRIGHT_FAINT;
  if (((hw * 2) / cell) * ((hh * 2) / cell) > 2500) return;
  const i0 = Math.floor((bearing - hw) / cell), i1 = Math.floor((bearing + hw) / cell);
  const j0 = Math.floor(-hh / cell), j1 = Math.floor(hh / cell);
  const salt = fine ? 0 : 5000;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const n = Math.floor(per * (0.55 + 0.9 * hash(i, j, 1 + salt)));
    for (let k = 0; k < n; k++) {
      const m = faint + Math.log10(Math.max(1e-9, hash(i, j, 10 + k * 3 + salt))) / 0.45;
      const s = mShow - m;
      if (s <= 0) continue;
      const az = (i + hash(i, j, 11 + k * 3 + salt)) * cell, el = (j + hash(i, j, 12 + k * 3 + salt)) * cell;
      const x = W / 2 - (az - bearing) * ppr, y = H / 2 - el * ppr;
      if (x < -4 - streakPx || x > W + 4 + streakPx || y < -4 || y > H + 4) continue;
      // a star's colour: most white, some blue, some orange
      const tint = hash(i, j, 13 + k * 3 + salt);
      const rgb = tint < 0.2 ? [190, 210, 255] : tint > 0.8 ? [255, 214, 170] : [228, 232, 245];
      const a = Math.min(1, 0.12 + 0.11 * s);
      if (streakPx > 1.5) {
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a / Math.sqrt(streakPx / 2)})`;
        ctx.lineWidth = Math.max(1, psfPx);
        ctx.beginPath(); ctx.moveTo(x - streakPx / 2, y); ctx.lineTo(x + streakPx / 2, y); ctx.stroke();
      } else if (psfPx < 1.5 && s < 7) {
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
        const r = Math.max(0.6, psfPx * 0.8);
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      } else point(ctx, x, y, s, psfPx, rgb);
    }
  }
}

/**
 * The bright sky as directions, for a wide lens that can look any way (the
 * hull cameras, hullcam.js): the same stars drawStars puts in its wide
 * fields (its coarse cells, azimuth round the plane from −π to π,
 * elevation out of it), those down to magnitude `faintest`, each a unit
 * vector (x, y in the plane, z out of it), its magnitude and colour. Made
 * once, the first time it is asked for.
 */
let _bright = null;
export function brightStars(faintest = 6.5) {
  if (_bright?.faintest === faintest) return _bright.list;
  const list = [], cell = BRIGHT_CELL, per = BRIGHT_PER_CELL, salt = 5000;
  const i0 = Math.floor(-Math.PI / cell), i1 = Math.floor(Math.PI / cell);
  const j0 = Math.floor(-Math.PI / 2 / cell), j1 = Math.floor(Math.PI / 2 / cell);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const n = Math.floor(per * (0.55 + 0.9 * hash(i, j, 1 + salt)));
    for (let k = 0; k < n; k++) {
      const m = BRIGHT_FAINT + Math.log10(Math.max(1e-9, hash(i, j, 10 + k * 3 + salt))) / 0.45;
      if (m > faintest) continue;
      const az = (i + hash(i, j, 11 + k * 3 + salt)) * cell, el = (j + hash(i, j, 12 + k * 3 + salt)) * cell;
      if (Math.abs(el) > Math.PI / 2) continue;
      const tint = hash(i, j, 13 + k * 3 + salt);
      list.push({ x: Math.cos(el) * Math.cos(az), y: Math.cos(el) * Math.sin(az), z: Math.sin(el), m, rgb: tint < 0.2 ? [190, 210, 255] : tint > 0.8 ? [255, 214, 170] : [228, 232, 245] });
    }
  }
  _bright = { faintest, list };
  return list;
}

/** Every world (for the telescope's sky): the ephemeris list. */
export const WORLDS = BODIES;
