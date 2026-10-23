// ============================================================
// LONGHAUL — What the telescope sees of a fight: flashes, fire, debris
//
// The sim reports a detonation, a hit, an intercept, a burst of PDC fire
// as an event with a place (fx.js). Seen through the telescope each one
// becomes an effect at true scale where it happened, moving on with the
// thing it happened to (the debris keeps the hull's velocity), and the
// camera's own response on top:
//
//   NUCLEAR    a flash that whites out the sensor, then a shell of plasma
//              a few kilometres across, edge-bright and lumpy, cooling
//              from white through orange to a dull red; sparks thrown
//              out; a hull it took broken into tumbling plates
//   FUSION     a reactor letting go: brighter, longer, a shock ring
//              racing out, the ship itself in pieces, glowing, cooling
//   HE         a torpedo striking home: the hit on the hull's face, a
//              fireball tens of metres across, a spray of incandescent
//              fragments out of the hole, the air venting in a white puff,
//              the breach glowing on after
//   SLUG       a sharper, smaller hit: sparks and a puff
//   INTERCEPT  a torpedo torn apart by a PDC stream: a spark, fragments,
//              a little fire
//   PDC        the guns firing: muzzle flashes flickering at the turrets,
//              tracer streams (one round in ten) reaching out toward the
//              torpedo, or, coming at us, radiating from the mount
//   STRAFE     rounds walking over a hull: a scatter of sparks
//
// and the sensor's response to the brightest: the frame whiting out and
// recovering, a bloom streak through the flash, ghosts of the flash
// reflected in the optics, and, close to a nuclear burst, the snow of its
// radiation striking the detector. How bright each is depends on how far
// it is and the filter (sim/telescope.js flashMag, FILTERS): far off, a
// nuclear burst is still a flash; a PDC stream is a faint line.
//
// Effects run on the wall clock (seconds: a flash is a moment however
// fast time is warped), anchored in space at the moment they were seen.
// ============================================================

import { AU_M } from '../core/constants.js';
import { flashMag } from '../sim/telescope.js';
import { rng } from './scope-sky.js';

const EVENT_WORDS = {
  nuclear: 'NUCLEAR DETONATION · a shell of plasma kilometres across, cooling',
  fusion: 'REACTOR DETONATION · containment gone: the ship is a fireball',
  he: 'TORPEDO HIT · the warhead and its speed through the hull: fire, fragments, air venting',
  kinetic: 'SLUG HIT · a kinetic strike: sparks and venting',
  intercept: 'TORPEDO SHOT DOWN · torn apart by a PDC stream',
  pdc: 'POINT DEFENSE FIRING · tracer streams reaching for the torpedo',
  strafe: 'PDC FIRE ON A HULL · rounds walking over it',
};
const LIFE_MS = { nuclear: 5200, fusion: 6800, he: 3600, kinetic: 2200, intercept: 1900, pdc: 1100, strafe: 1100 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (t) => 1 - Math.pow(1 - clamp01(t), 3);

/** Blackbody-ish colour of a hot thing cooling: 0 white-hot → 1 dull red (`blue`: a fusion plasma's, starting blue-white). */
const HEAT = [[255, 255, 250], [255, 232, 160], [255, 166, 72], [226, 88, 34], [120, 30, 16]];
const PLASMA = [[200, 220, 255], [240, 236, 255], [255, 214, 150], [250, 140, 60], [150, 46, 22]];
function heat(t, blue = false) {
  t = clamp01(t);
  const stops = blue ? PLASMA : HEAT;
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export class ScopeFx {
  constructor() {
    this.list = [];
    this.seen = new WeakSet();
    this.until = 0;             // wall time (ms) the last effect ends
    this.sensor = { white: 0, snow: 0, flashes: [] };
  }

  clear() { this.list.length = 0; this.until = 0; }

  /**
   * New combat effects (fx.js entries) in or near the field become
   * telescope effects. ctx: { now, tm, near(pos) → whether it is worth
   * drawing, velOf(pos, entityId) → its velocity (m/s), pose(id) → is it
   * drawn this frame (the hull to put a hit on) }.
   */
  ingest(entries, c) {
    for (const fx of entries) {
      if (this.seen.has(fx)) continue;
      this.seen.add(fx);
      const kind = fx.kind === 'detonation' ? (fx.blast === 'nuclear' ? 'nuclear' : 'fusion')
        : fx.kind === 'hit' ? (fx.warhead === 'nuke' ? null : fx.warhead === 'he' ? 'he' : 'kinetic')
          : fx.kind === 'intercept' ? 'intercept' : fx.kind === 'pdc' ? 'pdc' : fx.kind === 'strafe' ? 'strafe' : null;
      if (!kind) continue;
      // (an effect born while the frame looked elsewhere is not worth keeping)
      const born = Math.max(fx.at, c.now - 150);
      const seed = (Math.random() * 1e9) | 0;
      if (kind === 'pdc' || kind === 'strafe') {
        const shooter = kind === 'pdc' ? fx.id : fx.from;
        if (!c.pose(shooter) && !(kind === 'strafe' && c.pose(fx.target))) continue;
        this.add({ kind, born, seed, shooter, victim: kind === 'strafe' ? fx.target : null, defending: fx.defending });
        continue;
      }
      if (fx.x == null) continue;
      const pos = { x: fx.x, y: fx.y };
      const onto = kind === 'he' || kind === 'kinetic' ? fx.target : null;
      if (!c.near(pos) && !(onto && c.pose(onto))) continue;
      const vel = c.velOf(pos, onto);
      // a hit lands on the hull's face: a point on it, kept in the hull's own frame while it lasts
      const r = rng(seed);
      const local = onto ? { x: (r() - 0.5) * 0.7, z: (r() - 0.5) * 0.5 } : null;
      // a ship that goes up with the blast leaves its pieces (the pose of it as it last was)
      const wreck = kind === 'fusion' || kind === 'nuclear' ? c.lastPoseNear(pos) : null;
      this.add({ kind, born, seed, pos, vel, tm: c.tm, scaleM: fx.scaleM, onto, local, wreck });
      if (kind === 'fusion' || kind === 'nuclear') c.burst?.(pos, (kind === 'fusion' ? Math.max(1200, (fx.scaleM || 800) * 3) * 1.15 : 2500) * 2 * 1.75, born + LIFE_MS[kind]);
    }
  }

  add(e) {
    e.life = LIFE_MS[e.kind];
    this.list.push(e);
    this.until = Math.max(this.until, e.born + e.life);
    if (this.list.length > 80) this.list.shift();
  }

  /** Effects still showing. */
  busy(now) { return this.list.some(e => now - e.born < e.life); }

  /** The biggest thing happening in the frame now, in words for the readouts (or null). */
  event(now) {
    let best = null;
    for (const e of this.list) {
      const age = (now - e.born) / e.life;
      if (age < 0 || age >= 1) continue;
      const rank = { nuclear: 5, fusion: 5, he: 3, kinetic: 2, intercept: 2, strafe: 1, pdc: 1 }[e.kind] || 0;
      if (!best || rank > best.rank) best = { rank, kind: e.kind };
    }
    return best && EVENT_WORDS[best.kind];
  }

  /**
   * Draw every effect. v: { now, tm, W, H, ppr, toScreen(pos AU) → [x, y,
   * distM], mShow, filter, psfPx, pose(id) → { x, y, pxPerM, dir, fs, hull,
   * box } | null, threat(id) → [x, y] | null, point(ctx, x, y, s, r, rgb) }.
   */
  draw(ctx, v) {
    const S = this.sensor;
    S.white = 0; S.snow = 0; S.flashes.length = 0;
    this.list = this.list.filter(e => v.now - e.born < e.life);
    ctx.save();
    for (const e of this.list) {
      const age = (v.now - e.born) / e.life;
      if (age < 0) continue;
      const fn = DRAW[e.kind];
      if (fn) fn(ctx, e, age, v, S);
    }
    ctx.restore();
  }

  /** The sensor's response to the brightest flashes, over everything (after the frame is drawn). */
  drawSensor(ctx, v) {
    const S = this.sensor;
    ctx.save();
    // ghosts: the flash reflected in the optics, along the line through the frame's centre
    for (const f of S.flashes) {
      if (f.a < 0.02) continue;
      const dx = v.W / 2 - f.x, dy = v.H / 2 - f.y;
      ctx.globalCompositeOperation = 'lighter';
      for (const [t, r, c] of [[0.55, 0.06, [120, 255, 220]], [1.3, 0.035, [255, 140, 220]], [1.75, 0.09, [140, 170, 255]], [2.2, 0.025, [255, 240, 160]]]) {
        const gx = f.x + dx * t, gy = f.y + dy * t, gr = Math.max(6, r * Math.min(v.W, v.H) * (0.6 + f.a));
        const g = ctx.createRadialGradient(gx, gy, gr * 0.6, gx, gy, gr);
        g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.8, rgba(c, 0.18 * f.a)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.fill();
      }
      // a bloom streak: the saturated column bleeding along the sensor
      ctx.fillStyle = rgba([255, 255, 255], 0.55 * f.a);
      ctx.fillRect(f.x - 1, 0, 2, v.H);
      ctx.fillStyle = rgba([255, 255, 255], 0.2 * f.a);
      ctx.fillRect(f.x - 4, 0, 8, v.H);
    }
    // radiation striking the detector: hot pixels everywhere for a moment
    if (S.snow > 0.01) {
      const n = Math.min(1600, Math.floor(S.snow * v.W * v.H / 900));
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const x = Math.random() * v.W, y = Math.random() * v.H, b = Math.random();
        ctx.fillStyle = rgba([235, 240, 255], 0.35 + 0.6 * b);
        if (b > 0.93) ctx.fillRect(x, y, 3, 1); else ctx.fillRect(x, y, 1, 1);
      }
    }
    // the frame whited out, recovering
    if (S.white > 0.005) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba([255, 253, 248], Math.min(1, S.white));
      ctx.fillRect(0, 0, v.W, v.H);
    }
    ctx.restore();
  }
}

// ---- WHERE, AND HOW BRIGHT ----

/** Screen place of an effect now: on its hull while that is drawn, else where it was, carried on its velocity. */
function placeOf(e, v) {
  if (e.onto) {
    const p = v.pose(e.onto);
    if (p) {
      const hx = (p.hull ? p.hull.L : 40) * e.local.x, hz = (p.hull ? Math.max(p.hull.W, p.hull.H || 0) : 10) * e.local.z;
      return { x: p.x + p.dir * p.fs * hx * p.pxPerM, y: p.y - hz * p.pxPerM, k: p.pxPerM, distM: p.distM, cx: p.x, cy: p.y };
    }
  }
  if (!e.pos) return null;
  const dtS = (v.tm - e.tm) * 60;
  const pos = { x: e.pos.x + (e.vel?.vx || 0) * dtS / AU_M, y: e.pos.y + (e.vel?.vy || 0) * dtS / AU_M };
  const [x, y, distM] = v.toScreen(pos);
  return { x, y, k: v.ppr / distM, distM, cx: x, cy: y };
}

/** How far the effect outshines what the frame is exposed for, as 0–1 (and the raw magnitudes above). */
function brightness(kind, distM, v) {
  const s = v.mShow - (flashMag(kind, distM) + v.filter.flash);
  return { s, k: clamp01(0.25 + s / 10) };
}

/** A glow: a radial gradient of `rgb`, alpha `a` at the core. */
function glow(ctx, x, y, r, rgb, a, core = 0.25) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba([Math.min(255, rgb[0] + 40), Math.min(255, rgb[1] + 40), Math.min(255, rgb[2] + 40)], a));
  g.addColorStop(core, rgba(rgb, a * 0.6));
  g.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/**
 * The sensor's flare round a flash it can't hold: a warm halo as wide as
 * the flash outshines the frame's exposure (s magnitudes), dying away over
 * `durS` seconds. At long range it is most of what a hit looks like.
 */
function flare(ctx, x, y, s, t, durS, psfPx, rgb = [255, 196, 130]) {
  if (s <= 3 || t >= durS) return;
  const k = 1 - t / durS;
  glow(ctx, x, y, Math.max(6, psfPx * (4 + 3 * (s - 3))) * (0.6 + 0.6 * (1 - k)), rgb, Math.min(1, (s - 3) / 6) * k * k, 0.3);
}

/** Sparks: n hot fragments thrown out from (x, y), slowing; streaked along their flight. */
function sparks(ctx, e, age, P, n, reachM, opts = {}) {
  const r = rng(e.seed + 17);
  const dir = opts.dir ?? null, spread = opts.spread ?? Math.PI;
  const lifeF = opts.life ?? 1;
  for (let i = 0; i < n; i++) {
    const th = dir == null ? r() * Math.PI * 2 : dir + (r() - 0.5) * 2 * spread;
    const sp = 0.35 + r() * 0.9, own = 0.45 + r() * 0.55;
    const t = age / (own * lifeF);
    if (t >= 1) { r(); continue; }
    const dist = reachM * sp * ease(t * 1.2);
    const vnow = reachM * sp * 3 * Math.pow(1 - clamp01(t * 1.2), 2);
    const x = P.x + Math.cos(th) * dist * P.k, y = P.y - Math.sin(th) * dist * P.k * (0.6 + 0.4 * r());
    const len = Math.max(1, Math.min(26, vnow * 0.03 * P.k));
    const c = heat(t * 0.9 + 0.08);
    const a = (1 - t) * (opts.alpha ?? 0.9);
    const tx = x - Math.cos(th) * len, ty = y + Math.sin(th) * len;
    const g = ctx.createLinearGradient(x, y, tx, ty);
    g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(heat(Math.min(1, t + 0.3)), 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(0.7, Math.min(1.6, (opts.sizeM ?? 4) * P.k));
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
  }
}

/** A lumpy shell of hot gas: radius rPx, cooling `cool` (0–1), alpha a. */
function shell(ctx, x, y, rPx, cool, a, seed, spin, blue = false) {
  const c = heat(cool, blue), rim = heat(Math.max(0, cool - 0.12), blue);
  // the body of it: thin in the middle (we look through it), its edge bright where we look along it
  const g = ctx.createRadialGradient(x, y, 0, x, y, rPx);
  g.addColorStop(0, rgba(c, a * 0.12)); g.addColorStop(0.62, rgba(c, a * 0.22)); g.addColorStop(0.88, rgba(rim, a * 0.62)); g.addColorStop(0.96, rgba(rim, a * 0.38)); g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, rPx, 0, Math.PI * 2); ctx.fill();
  // lobes and filaments on the rim: the shell is not a sphere
  const r = rng(seed);
  const n = 22;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2 + spin + (r() - 0.5) * 0.35;
    const rr = rPx * (0.84 + 0.18 * r());
    const lx = x + Math.cos(th) * rr, ly = y + Math.sin(th) * rr, lr = rPx * (0.08 + 0.1 * r());
    glow(ctx, lx, ly, lr, heat(cool + 0.14 * (r() - 0.3), blue), a * (0.14 + 0.2 * r()), 0.35);
  }
}

/** The plates of a hull blown apart: tumbling, glowing at their torn edges, cooling, lit by the Sun. */
function plates(ctx, e, age, P) {
  const w = e.wreck;
  if (!w || w.pxPerM * w.L < 8) return;
  const r = rng(e.seed + 5);
  const n = 12;
  const reach = Math.max(w.L * 2.5, (e.kind === 'fusion' ? (e.scaleM || 800) * 2.2 : 1600));
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < n; i++) {
    const ax = (r() - 0.5) * w.L, size = w.L * (0.06 + r() * 0.16);
    const th = Math.atan2((r() - 0.5) * 0.6, ax >= 0 ? 1 : -1) + (r() - 0.5) * 1.2;
    const sp = 0.3 + r() * 0.8;
    const d = reach * sp * ease(age * 1.6);
    const x = P.x + (ax * w.dir * w.fs + Math.cos(th) * d) * P.k, y = P.y - (Math.sin(th) * d + (r() - 0.5) * w.H * 0.5) * P.k;
    const rot = r() * 6 + age * (r() - 0.5) * 14;
    const s = size * P.k;
    if (s < 0.6) continue;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, -s * 0.3); ctx.lineTo(s * (0.3 + r() * 0.3), -s * (0.2 + r() * 0.3)); ctx.lineTo(s * 0.5, s * 0.35); ctx.lineTo(-s * (0.2 + r() * 0.4), s * 0.3);
    ctx.closePath();
    // sunlit metal, flashing as it turns
    const glint = Math.max(0, Math.sin(rot * 2 + i)) ** 6;
    const grey = 70 + 60 * glint;
    ctx.fillStyle = `rgba(${grey},${grey + 4},${grey + 10},${Math.min(1, 1.4 - age)})`;
    ctx.fill();
    const hot = clamp01(1 - age * 2.2);
    if (hot > 0) { ctx.strokeStyle = rgba(heat(1 - hot), hot); ctx.lineWidth = Math.max(0.8, s * 0.12); ctx.stroke(); }
    ctx.restore();
  }
  ctx.restore();
}

// ---- THE EFFECTS ----

const DRAW = {
  nuclear(ctx, e, age, v, S) { burst(ctx, e, age, v, S, { R: 2500, hot: 0.06, shock: false }); },
  fusion(ctx, e, age, v, S) { burst(ctx, e, age, v, S, { R: Math.max(1200, (e.scaleM || 800) * 3), hot: 0.0, shock: true }); },

  he(ctx, e, age, v, S) {
    const P = placeOf(e, v);
    if (!P) return;
    const { s, k } = brightness('he', P.distM, v);
    ctx.globalCompositeOperation = 'lighter';
    const t = age * e.life / 1000;                        // seconds
    // the strike: a white point on the hull's face, spikes, the sensor flaring round it
    if (t < 0.4) v.point(ctx, P.x, P.y, s * (1 - t / 0.4) + 2, v.psfPx * 1.4, [255, 248, 230]);
    flare(ctx, P.x, P.y, s, t, 1.1, v.psfPx);
    if (s > 8 && t < 0.3) S.flashes.push({ x: P.x, y: P.y, a: Math.min(0.5, (s - 8) / 8) * (1 - t / 0.3) });
    // the fireball out of the hole, tens of metres
    const fr = Math.max(v.psfPx * 2, 55 * P.k * ease(t / 0.35));
    glow(ctx, P.x, P.y, fr, heat(t / 1.4), k * clamp01(1 - t / 1.6) * 0.9, 0.35);
    // fragments: out of the face, away from the hull's middle, and some back the way the torpedo came
    const away = Math.atan2(-(P.y - P.cy), P.x - P.cx || 1e-6);
    sparks(ctx, e, age, P, 46, 260, { dir: away, spread: 0.95, sizeM: 3, alpha: k });
    sparks(ctx, { seed: e.seed + 3 }, age, P, 14, 120, { alpha: k * 0.8, sizeM: 2 });
    // the air going: a white puff, lit by the Sun, spreading and thinning
    const pr = (30 + 240 * ease(t / 2.6)) * P.k;
    ctx.globalCompositeOperation = 'screen';
    glow(ctx, P.x + Math.cos(away) * pr * 0.4, P.y - Math.sin(away) * pr * 0.4, pr, [205, 222, 240], 0.32 * k * clamp01(1 - t / 3.2), 0.5);
    // and the breach, glowing on, flickering
    ctx.globalCompositeOperation = 'lighter';
    const fl = 0.7 + 0.3 * Math.sin(t * 31 + e.seed) * Math.sin(t * 17);
    glow(ctx, P.x, P.y, Math.max(v.psfPx * 1.5, 14 * P.k), [255, 140, 60], k * 0.8 * fl * clamp01(1.2 - age), 0.4);
  },

  kinetic(ctx, e, age, v) {
    const P = placeOf(e, v);
    if (!P) return;
    const { s, k } = brightness('kinetic', P.distM, v);
    ctx.globalCompositeOperation = 'lighter';
    const t = age * e.life / 1000;
    if (t < 0.25) v.point(ctx, P.x, P.y, s * (1 - t / 0.25) + 2, v.psfPx * 1.2, [235, 245, 255]);
    flare(ctx, P.x, P.y, s, t, 0.7, v.psfPx, [225, 235, 255]);
    sparks(ctx, e, age, P, 34, 180, { sizeM: 2.5, alpha: k });
    ctx.globalCompositeOperation = 'screen';
    glow(ctx, P.x, P.y, (20 + 140 * ease(t / 1.8)) * P.k, [200, 215, 235], 0.25 * k * clamp01(1 - t / 2), 0.5);
  },

  intercept(ctx, e, age, v) {
    const P = placeOf(e, v);
    if (!P) return;
    const { s, k } = brightness('intercept', P.distM, v);
    ctx.globalCompositeOperation = 'lighter';
    const t = age * e.life / 1000;
    if (t < 0.3) v.point(ctx, P.x, P.y, s * (1 - t / 0.3) + 1.5, v.psfPx * 1.2, [255, 236, 200]);
    flare(ctx, P.x, P.y, s, t, 0.8, v.psfPx);
    glow(ctx, P.x, P.y, Math.max(v.psfPx * 2, 30 * P.k * ease(t / 0.3)), heat(t / 1.1), k * clamp01(1 - t / 1.2), 0.3);
    sparks(ctx, e, age, P, 40, 160, { sizeM: 2, alpha: k });
  },

  pdc(ctx, e, age, v) { guns(ctx, e, age, v, e.shooter, true); },
  strafe(ctx, e, age, v) {
    guns(ctx, e, age, v, e.shooter, false);
    // rounds walking over the victim: sparks scattered over its face
    const p = v.pose(e.victim);
    if (!p) return;
    const r = rng(e.seed + Math.floor(age * 18));
    ctx.globalCompositeOperation = 'lighter';
    const b = p.box;
    for (let i = 0; i < 6; i++) {
      const x = b ? b.x0 + r() * (b.x1 - b.x0) : p.x, y = b ? b.y0 + (0.25 + r() * 0.5) * (b.y1 - b.y0) : p.y;
      v.point(ctx, x, y, 3 + r() * 3, v.psfPx, [255, 220, 170]);
    }
  },
};

/** A nuclear or fusion burst: the flash (and the sensor's response), the shell, the sparks, the hull's plates. */
function burst(ctx, e, age, v, S, o) {
  const P = placeOf(e, v);
  if (!P) return;
  const kind = e.kind;
  const { s, k } = brightness(kind, P.distM, v);
  const t = age * e.life / 1000;
  ctx.globalCompositeOperation = 'lighter';
  // the flash: a moment so bright the sensor saturates (whiteout, the bloom, ghosts), recovering
  const flash = clamp01(1 - t / 0.35);
  if (flash > 0) {
    v.point(ctx, P.x, P.y, s * flash + 4, v.psfPx * 2, kind === 'fusion' ? [225, 235, 255] : [255, 255, 255]);
    if (s > 12) S.white = Math.max(S.white, Math.min(1, (s - 12) / 6) * Math.pow(flash, 2.2));
    if (s > 6) S.flashes.push({ x: P.x, y: P.y, a: Math.min(1, (s - 6) / 8) * Math.pow(flash, 1.5) });
    // the burst's gamma and X-rays reach us too: the detector snows (closer, worse)
    if (kind === 'nuclear' || kind === 'fusion') S.snow = Math.max(S.snow, clamp01(4e8 / P.distM) * Math.pow(flash, 1.2) * 0.9);
  }
  // the shell of plasma, kilometres across, cooling
  const R = o.R;
  const rPx = Math.max(v.psfPx * 2.5, R * P.k * ease(t / (e.life / 1000 * 0.28)) * (kind === 'fusion' ? 1.15 : 1));
  const fade = Math.pow(clamp01(1 - age), 1.4) * k * 0.9;
  const blue = kind === 'fusion';
  shell(ctx, P.x, P.y, rPx, o.hot + age * 0.95, fade, e.seed, t * 0.25, blue);
  // the core still glowing within
  glow(ctx, P.x, P.y, rPx * 0.45, heat(o.hot + age * 0.7, blue), fade * 0.6, 0.2);
  // the shock: a thin bright ring racing out (a reactor's)
  if (o.shock && t < 1.6) {
    const sr = R * 2.6 * ease(t / 1.4) * P.k;
    if (sr > 2) { ctx.strokeStyle = rgba([200, 225, 255], 0.55 * clamp01(1 - t / 1.6) * k); ctx.lineWidth = Math.max(1, sr * 0.012); ctx.beginPath(); ctx.arc(P.x, P.y, sr, 0, Math.PI * 2); ctx.stroke(); }
  }
  sparks(ctx, e, age, P, 64, R * 1.7, { sizeM: 10, alpha: k * 0.85, life: 0.8 });
  plates(ctx, e, age, P);
}

/** Guns firing from `shooter`: muzzle flashes at its turrets, tracer streams toward what it shoots at. */
function guns(ctx, e, age, v, shooter, defensive) {
  const p = v.pose(shooter);
  if (!p) return;
  const mounts = (p.hull?.parts || []).filter(q => q.role === 'pdc');
  const pts = mounts.length ? mounts.map(q => ({ x: p.x + p.dir * p.fs * ((q.x0 + q.x1) / 2) * p.pxPerM, y: p.y - (((q.z0 ?? 0) + (q.z1 ?? 0)) / 2) * p.pxPerM })) : [{ x: p.x, y: p.y }];
  const t = age * e.life / 1000;
  const r = rng(e.seed);
  const target = defensive ? v.threat(shooter) : (e.victim ? v.pose(e.victim) : null);
  ctx.globalCompositeOperation = 'lighter';
  pts.forEach((m, mi) => {
    // the muzzle: a flicker, burst after burst
    const fl = (Math.sin(t * 90 + mi * 2.1 + e.seed) + 1) / 2;
    if (fl > 0.35) v.point(ctx, m.x, m.y, 2.5 + fl * 2.5, Math.max(v.psfPx, 0.9), [255, 226, 170]);
    // the stream: toward the threat (off the frame or not), the gun walking its aim round it; with nothing
    // to aim at that we see, the rounds come at us: short streaks round the mount, foreshortened
    const tx = target ? target[0] ?? target.x : null, ty = target ? target[1] ?? target.y : null;
    const fade = clamp01(1.4 - age);
    if (tx != null) {
      for (let st = 0; st < 2; st++) {
        const walk = Math.sin(t * 3.1 + st * 2 + mi) * 0.035, ang = Math.atan2(ty - m.y, tx - m.x) + walk;
        const L = Math.hypot(tx - m.x, ty - m.y) * 1.05;
        for (let i = 0; i < 9; i++) {
          const ph = (t * 1.6 + i / 9 + st * 0.05) % 1;           // one round in ten a tracer: dashes running out
          const d0 = L * ph, d1 = Math.max(0, d0 - Math.max(3, L * 0.035));
          ctx.strokeStyle = rgba([255, 206, 130], 0.85 * (1 - ph * 0.8) * fade);
          ctx.lineWidth = 1.1;
          ctx.beginPath(); ctx.moveTo(m.x + Math.cos(ang) * d1, m.y + Math.sin(ang) * d1); ctx.lineTo(m.x + Math.cos(ang) * d0, m.y + Math.sin(ang) * d0); ctx.stroke();
        }
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const th = r() * Math.PI * 2, reach = Math.max(4, 120 * p.pxPerM) * (0.5 + r() * 0.5);
        const ph = (t * 2.4 + i / 4) % 1;
        ctx.strokeStyle = rgba([255, 206, 130], 0.6 * (1 - ph) * fade);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(m.x + Math.cos(th) * reach * Math.max(0, ph - 0.25), m.y + Math.sin(th) * reach * Math.max(0, ph - 0.25)); ctx.lineTo(m.x + Math.cos(th) * reach * ph, m.y + Math.sin(th) * reach * ph); ctx.stroke();
      }
    }
  });
}
