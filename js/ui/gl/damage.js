// ============================================================
// LONGHAUL — What a ship's damage looks like from outside
//
// The sim keeps a scar for every hit (sim/damage.js: the section, how
// hard, what made it, when, a place on the section). Here each scar is
// put on the hull model (sim/hulls.js) where its section is (the drive at
// the bell and the engineering deck, the reactor on its deck, the guns on
// their mounts, our own hits on the deck they holed) and turned into what
// a camera sees:
//
//   a torpedo's warhead   a hole metres across, its edge torn and curled
//                         out, scorched round, glowing for the first
//                         minutes, the air going out of it in a white jet
//   a railgun slug        a small clean hole, a little scorching
//   PDC fire, mining gear a peppering of pits over a patch of the hull
//   a blast (nuclear,     the side of the hull scorched and blistered
//   a reactor nearby)
//   a scrape (the ground, a scuff of bare metal
//   a collision)
//
// A wreck is dark (no ports lit, no nav lights), tumbling slowly with
// nothing to hold its attitude, most of them broken-backed: the hull torn
// through at a module joint near its worst wound, the after part bent
// away about the spine, both open to space at the break, and a field of
// fragments drifting off it (most nearly with it, a few faster, so a
// wreck days old still has its cloud). A ship with its reactor hurt
// shows fewer lights, flickering. Places come from hashes of the ship's
// id, never the dice, so a ship looks the same every time it is seen.
//
// damageLook() answers for an entity (or our ship) at a moment; nothing
// here touches the GPU (ships3d.js draws it, exterior.js and telescope.js
// add the venting and fires over the picture: drawVents).
// ============================================================

import { ensureHull } from '../../sim/combatants.js';

const MAX_SCARS = 16;            // the most a hull's shader takes (the worst)
const VENT_MIN = 25;             // a hole in a pressure hull vents this long (sim minutes): the air runs out
const HEAT_MIN = 4;              // a hole's torn edge glows, cooling over minutes (an e-folding, sim minutes)
const PRESSURE = new Set(['hab', 'command', 'cargo', 'hold', 'machinery', 'reactor']);
const SECTION_ROLES = {
  hull: ['hab', 'cargo', 'hold', 'command', 'machinery', 'tank', 'armor', 'container', 'ice'],
  drive: ['drive', 'machinery'], reactor: ['reactor', 'machinery'], weapons: ['pdc', 'tube', 'rail', 'armor'], sensors: ['sensor', 'command'],
  all: ['hab', 'cargo', 'hold', 'command', 'machinery', 'reactor', 'tank', 'armor', 'container', 'radiator', 'ice'],
};
const SECTION_DECKS = {
  hull: ['quarters', 'mess', 'utility', 'cargo', 'passengers', 'passengers2', 'brig'], drive: ['engineering'], reactor: ['reactor'],
  weapons: ['cargo', 'engineering'], sensors: ['bridge'],
};
/** Kinds of mark: 0 a hole, 1 a peppering, 2 scorching, 3 a scrape. */
const KIND = { he: 0, slug: 0, hit: 0, pdc: 1, gear: 1, blast: 2, impact: 3, collision: 3 };

/** A stable number in [0, 1) from a string and integers. */
export function hash01(id, a = 0, b = 0) {
  let h = 2166136261 ^ Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fract = (x) => x - Math.floor(x);

/** The outer area of a part (m²): how likely a hit on its section lands on it. */
function area(p) {
  if (p.k === 'box') { const a = p.x1 - p.x0, b = p.y1 - p.y0, c = p.z1 - p.z0; return 2 * (a * b + a * c + b * c); }
  if (p.k === 'cyl') return 2 * Math.PI * p.r * (p.x1 - p.x0);
  if (p.k === 'bell') return Math.PI * (p.r0 + p.r1) * (p.x1 - p.x0);
  return 0;
}

/** The parts a hit on `section` can land on (a deck we know, or the section's roles), never empty. */
function candidates(hull, s, deck) {
  let out = deck ? hull.parts.filter(p => p.deck === deck) : [];
  if (!out.length && SECTION_DECKS[s]) out = hull.parts.filter(p => p.deck && SECTION_DECKS[s].includes(p.deck));
  if (s === 'drive') out = out.concat(hull.parts.filter(p => p.k === 'bell'));
  if (!out.length) out = hull.parts.filter(p => SECTION_ROLES[s]?.includes(p.role) && p.k !== 'ring');
  if (!out.length) out = hull.parts.filter(p => p.k === 'box' || p.k === 'cyl');
  return out;
}

/** A point on a part's outside, and its normal, from two numbers in [0, 1). */
function surfacePoint(p, u, v) {
  const a = 0.12 + 0.76 * fract(u * 7.31), b = 0.12 + 0.76 * fract(v * 13.7);
  if (p.k === 'cyl') {
    const ang = v * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
    return { p: [p.x0 + (p.x1 - p.x0) * a, p.y + c * p.r, (p.z || 0) + s * p.r], n: [0, c, s] };
  }
  if (p.k === 'bell') {
    const ang = v * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = p.r1 + (p.r0 - p.r1) * (1 - a);
    return { p: [p.x1 - (p.x1 - p.x0) * (1 - a), c * r, s * r], n: [0.3, c, s] };
  }
  // a box: one of its four sides along the axis
  const face = Math.floor(v * 4) % 4;
  const x = p.x0 + (p.x1 - p.x0) * a;
  if (face === 0) return { p: [x, p.y1, p.z0 + (p.z1 - p.z0) * b], n: [0, 1, 0] };
  if (face === 1) return { p: [x, p.y0, p.z0 + (p.z1 - p.z0) * b], n: [0, -1, 0] };
  if (face === 2) return { p: [x, p.y0 + (p.y1 - p.y0) * b, p.z1], n: [0, 0, 1] };
  return { p: [x, p.y0 + (p.y1 - p.y0) * b, p.z0], n: [0, 0, -1] };
}

/** A scar on the hull: where, how big (m), what kind; its pressure part (does it vent). */
function place(hull, sc) {
  const parts = candidates(hull, sc.s, sc.d);
  const total = parts.reduce((t, p) => t + area(p), 0) || 1;
  let pick = parts[0], acc = sc.u * total;
  for (const p of parts) { acc -= area(p); if (acc <= 0) { pick = p; break; } }
  const at = surfacePoint(pick, sc.u, sc.v);
  const kind = KIND[sc.k] ?? 0;
  const L = hull.L;
  // a hole's size from how hard it hit: a torpedo's warhead metres across, a slug's a fist through the plate
  const sz = Math.sqrt(Math.max(0.005, sc.r) / 0.1);
  const r = kind === 0 ? Math.max(sc.k === 'slug' ? 0.25 : 0.5, Math.min(L * 0.1, (sc.k === 'slug' ? 0.012 : 0.035) * L * sz))
    : kind === 1 ? Math.max(2.5, Math.min(L * 0.16, 0.09 * L * sz))
      : kind === 2 ? Math.max(4, L * 0.35 * Math.min(1.5, sz)) : Math.max(1, Math.min(L * 0.15, 0.06 * L * sz));
  // (a burst of PDC fire spreads over metres of plating: its patch, not one hole)
  return { ...at, r, kind, pressure: PRESSURE.has(pick.role), part: pick };
}

const _placed = new WeakMap();
/** The scars of a list, placed on a hull (cached on the list, rebuilt when it grows). */
function placed(hull, list) {
  let c = _placed.get(list);
  if (c && c.n === list.length && c.hull === hull) return c.out;
  const out = list.map(sc => ({ sc, ...place(hull, sc) }));
  _placed.set(list, { n: list.length, hull, out });
  return out;
}

/**
 * Scars for a hull that was hurt before scars were kept (an old save): its
 * missing points spread over its sections, placed by its id.
 */
function synthetic(id, h, wreck) {
  const lost = wreck ? 1 : 1 - Math.max(0, h.hp) / (h.hpMax || 1);
  if (lost < 0.03) return [];
  const out = [];
  const n = Math.min(10, Math.round(2 + lost * 9));
  for (let i = 0; i < n; i++) {
    const s = ['hull', 'hull', 'drive', 'reactor', 'weapons', 'sensors'][Math.floor(hash01(id, i, 1) * 6)];
    out.push({ s, k: hash01(id, i, 2) < 0.25 ? 'pdc' : 'he', r: lost / n * 1.6, u: hash01(id, i, 3), v: hash01(id, i, 4), m: -1e9 });
  }
  return out;
}

const _synth = new Map();

/**
 * How a ship looks for its damage at minute `tm`. src: { id, combat (e.combat:
 * hp, hpMax, scars, status, reactor, wreckedAt) } for another ship, or { id:
 * 'player', hull: state.hull, decks } for ours. Returns null for a hull
 * untouched, else { scars: [{ p, n, r, kind, hole, heat, seed, vent, age }],
 * wreck, worn (0–1: soot over the whole hull), lights (0–1), flicker,
 * tumble: { axis, deg } | null, broken: { xc, hinge: [x, y, z], bend, twist,
 * gap } | null, debris: [{ dir, d0, v, axis, spin, shape, s }] | null }.
 */
export function damageLook(src, hull, tm) {
  if (!hull) return null;
  const id = src.id;
  let list, wreck = false, worn = 0, lights = 1, flicker = false, since = null;
  if (id === 'player') {
    const hp = src.hull?.integrity ?? 100;
    list = src.hull?.scars || [];
    worn = Math.max(0, Math.min(1, 1 - hp / 100));
    if (!list.length && worn < 0.03) return null;
  } else {
    const h = src.combat || ensureHull(src);
    wreck = h.status === 'wreck';
    list = h.scars?.length ? h.scars : null;
    if (!list) {
      const key = `${id}:${wreck}:${Math.round((h.hp / (h.hpMax || 1)) * 20)}`;
      list = _synth.get(key) || synthetic(id, h, wreck);
      if (_synth.size > 400) _synth.clear();
      _synth.set(key, list);
    }
    worn = wreck ? 0.7 : Math.max(0, Math.min(0.7, 1 - Math.max(0, h.hp) / (h.hpMax || 1)));
    if (!list.length && worn < 0.03 && !wreck) return null;
    lights = wreck ? 0 : h.reactor < 0.15 ? 0.15 : h.reactor < 0.5 ? 0.55 : 1;
    flicker = !wreck && h.reactor < 0.5;
    since = wreck ? (h.wreckedAt ?? (src.tags?.despawnAt != null ? src.tags.despawnAt - 10 * 1440 : tm - 60)) : null;
  }
  // the worst MAX_SCARS, as the shader takes them
  const all = placed(hull, list);
  const ranked = all.length > MAX_SCARS ? [...all].sort((a, b) => b.sc.r - a.sc.r).slice(0, MAX_SCARS) : all;
  const ourDeck = (d) => src.decks?.find(x => x.id === d);
  const scars = ranked.map((x, i) => {
    const age = Math.max(0, tm - x.sc.m);
    const holed = x.kind === 0 ? 1 : 0;
    // venting: while the air lasts (ours: while the deck it holed still has pressure)
    let vent = 0;
    if (holed && x.pressure) {
      if (id === 'player') { const dk = x.sc.d && ourDeck(x.sc.d); vent = dk?.atmosphere?.breached && (dk.atmosphere.pressure ?? 0) > 5 ? Math.min(1, dk.atmosphere.pressure / 60) : 0; }
      else vent = age < VENT_MIN && !(wreck && since != null && since < x.sc.m - 1) ? 1 - age / VENT_MIN : 0;
    }
    return { p: x.p, n: x.n, r: x.r, kind: x.kind, hole: holed, heat: holed || x.kind === 1 ? Math.exp(-age / HEAT_MIN) * (holed ? 1 : 0.5) : 0, seed: hash01(id, i, 11), vent, age };
  });
  // a wreck: tumbling, broken-backed (most), its fragments drifting off
  let tumble = null, broken = null, debris = null;
  if (wreck) {
    const a = hash01(id, 1, 21) * Math.PI * 2, b = Math.acos(2 * hash01(id, 2, 21) - 1);
    const axis = [Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b)];
    const rate = 1.5 + 4 * hash01(id, 3, 21);          // degrees a minute
    tumble = { axis, deg: rate * Math.max(0, tm - since) };
    const mods = hull.parts.filter(p => p.k === 'box' && PRESSURE.has(p.role));
    if (hash01(id, 4, 21) < 0.65 && hull.L > 20) {
      // torn through at the joint nearest the worst wound (or the middle of the hull)
      const worst = all.reduce((w, x) => (!w || x.sc.r > w.sc.r ? x : w), null);
      const L = hull.L, x0 = hull.bounds.x0 + 0.25 * L, x1 = hull.bounds.x1 - 0.25 * L;
      let xc = worst && worst.kind !== 2 ? worst.p[0] : (hull.bounds.x0 + hull.bounds.x1) / 2;
      const joints = mods.flatMap(m => [m.x0, m.x1]).filter(x => x > x0 && x < x1);
      if (joints.length) xc = joints.reduce((b2, x) => (Math.abs(x - xc) < Math.abs(b2 - xc) ? x : b2), joints[0]);
      xc = Math.max(x0, Math.min(x1, xc));
      const top = Math.max(...mods.filter(m => m.x0 <= xc + 0.5 && m.x1 >= xc - 0.5).map(m => m.z1), hull.H / 2);
      const side = hash01(id, 5, 21) < 0.5 ? 1 : -1;
      broken = { xc, hinge: [xc, 0, top * side], bend: (10 + 18 * hash01(id, 6, 21)) * side, twist: (hash01(id, 7, 21) - 0.5) * 18, gap: 0.6 + 1.6 * hash01(id, 8, 21) };
    }
    const n = Math.round(22 + Math.min(40, hull.L * 0.4));
    debris = [];
    for (let i = 0; i < n; i++) {
      const u = hash01(id, i, 31), v = hash01(id, i, 32);
      const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
      const sa = hash01(id, i, 35) * Math.PI * 2, sb = Math.acos(2 * hash01(id, i, 36) - 1);
      debris.push({
        dir: [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)],
        d0: hull.L * (0.25 + 0.45 * hash01(id, i, 33)),
        // (most nearly with the hulk, a few faster: m/s)
        v: 0.0004 + 0.05 * hash01(id, i, 34) ** 4,
        axis: [Math.sin(sb) * Math.cos(sa), Math.sin(sb) * Math.sin(sa), Math.cos(sb)],
        spin: 2 + 30 * hash01(id, i, 37), shape: Math.floor(hash01(id, i, 38) * 6),
        s: Math.min(4, hull.L * (0.012 + 0.04 * hash01(id, i, 39) ** 2)),
      });
    }
    debris.sinceS = Math.max(0, tm - since) * 60;
  }
  return { scars, wreck, worn, lights, flicker, tumble, broken, debris };
}

// ---- MATRICES FOR A LOOK ----

/** Rotation (3×3 columns) of `deg` about unit `axis`. */
export function axisAngle(axis, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = axis;
  return [[t * x * x + c, t * x * y + s * z, t * x * z - s * y], [t * x * y - s * z, t * y * y + c, t * y * z + s * x], [t * x * z + s * y, t * y * z - s * x, t * z * z + c]];
}

/** A 4×4 (column-major) from a 3×3 and a translation. */
export function mat4Of(R, t = [0, 0, 0]) {
  return new Float32Array([R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, t[0], t[1], t[2], 1]);
}

/** a · b, column-major 4×4. */
export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/**
 * The model matrices a look gives a hull posed by `m`: its tumble about its
 * centre, and for one broken-backed its two pieces (the fore piece as it is,
 * the after piece bent about the hinge and parted by the gap), each with
 * the side of the break it keeps (a plane in the hull's own frame).
 */
export function pieces(m, look) {
  const T = look?.tumble ? mul4(m, mat4Of(axisAngle(look.tumble.axis, look.tumble.deg))) : m;
  if (!look?.broken) return [{ m: T, clip: null }];
  const b = look.broken;
  // the after piece: about the hinge (y: the bend, x: a twist), drawn back by the gap
  const R = axisAngle([0, 1, 0], b.bend), Q = axisAngle([1, 0, 0], b.twist);
  const RQ = [0, 1, 2].map(c => [0, 1, 2].map(r => R[0][r] * Q[c][0] + R[1][r] * Q[c][1] + R[2][r] * Q[c][2]));
  const h = b.hinge;
  const rh = [RQ[0][0] * h[0] + RQ[1][0] * h[1] + RQ[2][0] * h[2], RQ[0][1] * h[0] + RQ[1][1] * h[1] + RQ[2][1] * h[2], RQ[0][2] * h[0] + RQ[1][2] * h[1] + RQ[2][2] * h[2]];
  const aft = mat4Of(RQ, [h[0] - rh[0] - b.gap, h[1] - rh[1], h[2] - rh[2]]);
  return [
    { m: T, clip: [1, 0, 0, b.xc] },                  // keep x > xc: the fore piece
    { m: mul4(T, aft), clip: [-1, 0, 0, -b.xc] },     // keep x < xc: the after piece
  ];
}

/** Where a fragment of a wreck is (in the hull's frame, metres) and how it is turned, at `t` s since the break-up. */
export function debrisMatrix(look, d, i) {
  const r = d.d0 + d.v * look.debris.sinceS;
  const R = axisAngle(d.axis, (d.spin * look.debris.sinceS / 60 + i * 47) % 360);
  const s = d.s;
  return mat4Of([[R[0][0] * s, R[0][1] * s, R[0][2] * s], [R[1][0] * s, R[1][1] * s, R[1][2] * s], [R[2][0] * s, R[2][1] * s, R[2][2] * s]], [d.dir[0] * r, d.dir[1] * r, d.dir[2] * r]);
}

// ---- VENTING AND FIRE, OVER THE PICTURE ----

const _sprite = new Map();
function sprite(rgb) {
  const key = String(rgb);
  let c = _sprite.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.35, `rgba(${rgb},0.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  _sprite.set(key, c);
  return c;
}

/**
 * The air going out of fresh holes (a white jet along the hole's normal,
 * puffs thinning as they spread) and the glow of a hot edge, drawn over a
 * picture. proj(p) → [x, y] screen px of a point in the hull's frame; rot(n)
 * → the normal turned into the screen's (x right, y down); pxPerM; t (s).
 */
export function drawVents(ctx, look, proj, pxPerM, t, alpha = 1) {
  if (!look) return;
  ctx.save();
  for (const s of look.scars) {
    if (s.vent <= 0 && s.heat <= 0.02) continue;
    const [x, y] = proj(s.p);
    const tip = proj([s.p[0] + s.n[0] * 10, s.p[1] + s.n[1] * 10, s.p[2] + s.n[2] * 10]);
    const dx = (tip[0] - x) / 10, dy = (tip[1] - y) / 10;              // px per metre along the normal, on the screen
    if (s.heat > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * s.heat * (0.75 + 0.25 * Math.sin(t * 17 + s.seed * 40));
      const r = Math.max(2, s.r * 1.4 * pxPerM);
      ctx.drawImage(sprite('255,150,70'), x - r, y - r, r * 2, r * 2);
    }
    if (s.vent > 0) {
      // the air going: a jet off the hole, fanning out and gone within a few hole-widths (nothing holds it
      // together in vacuum), white where the sunlight catches the freezing moisture in it, a few glints
      ctx.globalCompositeOperation = 'lighter';
      const len = (2.5 + 4 * s.vent) * Math.max(1.2, s.r) * pxPerM;
      for (let k = 0; k < 7; k++) {
        const ph = (t * (1.6 + 0.4 * s.seed) + k / 7) % 1;
        const d = len * ph, w = (s.r * pxPerM) * (0.6 + 2.4 * ph);
        const jx = Math.sin(t * 5 + k * 1.7 + s.seed * 9) * 0.3, jy = Math.cos(t * 4.3 + k * 2.1) * 0.3;
        const ux = dx / (Math.hypot(dx, dy) || 1), uy = dy / (Math.hypot(dx, dy) || 1);
        const along = Math.hypot(dx, dy) > 0.05 ? 1 : 0;           // (a jet straight at us is a glow, not a line)
        const px = x + ux * d * along + (-uy) * jx * w, py = y + uy * d * along + ux * jy * w;
        ctx.globalAlpha = alpha * s.vent * 0.5 * (1 - ph) ** 2;
        ctx.drawImage(sprite('210,225,245'), px - w, py - w, w * 2, w * 2);
      }
      ctx.globalAlpha = alpha * s.vent * 0.7;
      const core = Math.max(1.5, s.r * 0.9 * pxPerM);
      ctx.drawImage(sprite('240,246,255'), x - core, y - core, core * 2, core * 2);
      for (let k = 0; k < 5; k++) {
        const ph = (t * 2.3 + k * 0.37 + s.seed) % 1, g = Math.pow(Math.max(0, Math.sin((t + k) * 23 + s.seed * 50)), 12);
        if (g < 0.2) continue;
        const ux = dx / (Math.hypot(dx, dy) || 1), uy = dy / (Math.hypot(dx, dy) || 1);
        const px = x + ux * len * ph + Math.sin(k * 7 + s.seed) * len * 0.25 * ph, py = y + uy * len * ph + Math.cos(k * 5) * len * 0.25 * ph;
        ctx.globalAlpha = alpha * s.vent * g;
        ctx.fillStyle = '#F4F8FF';
        ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
      }
    }
  }
  ctx.restore();
}
