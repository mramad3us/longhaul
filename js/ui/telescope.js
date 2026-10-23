// ============================================================
// LONGHAUL — The telescope's picture
//
// What our telescope (sim/telescope.js) shows of the thing it holds, as
// its camera would: from where we are, along the line of sight, the
// plane's up as up. The physics decides everything drawn:
//
//   a hull many resolution elements long is its shape, side on,
//   foreshortened by the angle we see it at, lit from the Sun's side (or
//   its night side, nearly black), blurred to what the optics resolve; a
//   few elements, a smudge; under one, a point of light as bright as its
//   magnitude against what the frame reaches, never bigger than the
//   optics make a star
//   a lit drive is a star at the stern, with the mirror's diffraction
//   spikes; the hull is lost in its glare unless it is close
//   flashes in the field (detonations, hits, intercepts: fx.js) bloom the
//   frame by how far they outshine what it is exposed for; a nuclear or
//   fusion flash whites it out
//   behind, the stars, as many as the exposure picks up (a sunlit hull in
//   the frame leaves none), drifting as the mount tracks
//   the sensor's noise, rising as the camera reaches for faint things
//
// The frame closes in on a hull it resolves (framed at a third of the
// width, eased); anything smaller is shown in the camera's native field,
// a point in a great deal of black. Other things in the field (a torpedo
// closing, a ship alongside) are drawn the same way; a torpedo past its
// target is not (the sim settles that minute whole: the flash follows).
// The target is drawn where it was when the light left it. Lost, the mount
// stays where it last pointed. The readouts say what we are looking at
// and why it looks like that: range and light time, size against
// resolution, magnitude against the limit.
// ============================================================

import { AU_M } from '../core/constants.js';
import { getWorld, predictEntity } from '../sim/world.js';
import { scopeOf, scopeLock, sightOf, flashMag, ownPlumeBlinds, NATIVE_FIELD } from '../sim/telescope.js';
import { launchedBy } from '../sim/ordnance.js';
import { PLAYER } from '../sim/combatants.js';
import { isIdentified, isDark } from '../sim/sensors.js';
import { hullOf } from '../sim/hulls.js';
import { stationModel } from '../sim/stations.js';
import { factionColor } from '../sim/factions.js';
import { FitCanvas, fmtKm } from './dom.js';
import { drawHull, drawStation } from './hull-art.js';
import { ourPlace } from './exterior.js';
import { fxList } from './fx.js';
import { frameMarks, marksOf, markWords } from './marks.js';

const C_MS = 299_792_458;
const NIGHT = 2.3;               // rad of phase: past this we see the night side
const FRAME_AT = 12;            // resolution elements: a hull this long is framed (closer in); smaller, the native field
const ZOOM_TAU_S = 0.6;
const CELL = 2.5e-4;            // the sky is drawn in cells this many radians on a side
const STARS_PER_CELL = 17.6;    // down to magnitude 19 (≈ 2.8e8 per steradian)
const STAR_FAINT = 19;
const Z_SPREAD = 0.2;           // ships in the field sit off the plane by up to this share of their distance from the target (to 20 km)
const FONT = '10px "IBM Plex Mono", monospace';
const DIM = 'rgba(122,142,162,0.85)', TEXT = 'rgba(190,205,220,0.92)', CYAN = 'rgba(62,199,230,0.7)', WARN = 'rgba(240,169,58,0.95)';

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** A repeatable 0–1 from integers (the sky must be the same sky every frame). */
function hash(a, b, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const idHash = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return hash(h, 7); };

export class ScopeView {
  constructor(container) {
    this.fc = new FitCanvas(container, { className: 'scope-canvas' });
    this.off = document.createElement('canvas');
    this.noise = makeNoise();
    this.t0 = performance.now();
    this.reset();
  }

  /** A new target, a new game: the mount starts over. */
  reset() {
    this.fov = null;
    this.point = null;      // where the mount last pointed (bearing, rad)
    this.id = null;
  }

  render(state, alpha, id) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const t = (performance.now() - this.t0) / 1000;
    const wallNow = performance.now(), wall = Math.min(0.25, (wallNow - (this.wall ?? wallNow)) / 1000);
    this.wall = wallNow;
    if (id !== this.id) { this.fov = null; this.point = null; this.id = id; }
    const world = getWorld(state);
    const a = Math.max(0, Math.min(1, alpha ?? 1));
    const tm = state.clock.minute + a;
    const sc = scopeOf(state);
    const lock = id ? scopeLock(state, id, sc) : null;
    const us = ourPlace(state, tm, a * 60);
    const e = id ? world.get(id) : null;

    // The target where the light we see left it
    let sight = null, tpos = null;
    if (lock?.ok && e) {
      tpos = predictEntity(e, tm - lock.distM / C_MS / 60, world).pos;
      sight = sightOf(state, e, tpos, us, sc);
      this.point = sight.bearing;
    } else if (e && lock?.why === 'range') {
      // (beyond the lock the board still gives a bearing: the mount points there and holds nothing)
      this.point = Math.atan2(e.pos.y - us.y, e.pos.x - us.x);
    }
    const bearing = this.point;

    // The field: closed in on a hull we resolve, the native field otherwise
    const res = sc.resRad;
    const native = NATIVE_FIELD * res;
    const want = sight && sight.regime !== 'plume' && sight.elements >= FRAME_AT ? Math.min(native, sight.angRad * 3) : native;
    this.fov = !this.fov ? want : this.fov * Math.pow(want / this.fov, 1 - Math.exp(-wall / ZOOM_TAU_S));
    const fov = this.fov, ppr = W / fov;                // px per radian
    const psfPx = Math.max(0.7, 0.5 * res * ppr);       // a star's blur, px

    // What the exposure reaches: everything to the limit, unless something bright sets it
    let mShow = sc.magLimit;
    if (sight) {
      if (sight.regime === 'resolved' && sight.phase < 2.6) mShow = sc.magLimit - 10;      // a sunlit hull: a short exposure, no stars
      const brightest = Math.min(sight.hullMag, sight.plumeMag);
      if (brightest < mShow - 9) mShow = brightest + 9;
    }
    const gain = Math.max(0, Math.min(1, (mShow - (sc.magLimit - 10)) / 10));

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!sc.working) { this.hud(ctx, W, H, state, { msg: 'SENSORS DARK · no power to the telescope', warn: true }); return; }
    if (bearing == null) {
      this.grain(ctx, W, H, 0.6);
      this.hud(ctx, W, H, state, { msg: !id ? 'NO TARGET · pick a contact and LOOK (Z), or LOOK AT PICK' : `NO TRACK · ${lock?.text || ''}`, warn: !!id });
      return;
    }

    // The sky, then the noise floor
    drawStars(ctx, W, H, bearing, fov, ppr, mShow, psfPx);

    // Things in the field: the target and whatever else the board holds there
    const toScreen = (s, zM) => [W / 2 - angDiff(s.bearing, bearing) * ppr, H / 2 - (zM / s.distM) * ppr];
    let box = null;
    if (sight) box = this.drawThing(ctx, state, e, sight, W / 2, H / 2, ppr, psfPx, mShow, t);
    const others = new Set();
    for (const c of state.sensors.contacts) if (c.id !== id && Math.abs(angDiff(c.bearing, bearing)) < fov) others.add(c.id);
    for (const o of launchedBy(state, PLAYER)) if (o.id !== id) others.add(o.id);
    for (const oid of others) {
      const o = world.get(oid);
      if (!o) continue;
      const at = tm - Math.hypot(o.pos.x - us.x, o.pos.y - us.y) * AU_M / C_MS / 60;      // (its own light time)
      const p = predictEntity(o, at, world).pos;
      if (o.type === 'ordnance' && passed(o, p, world, at)) continue;
      const s = sightOf(state, o, p, us, sc);
      if (Math.abs(angDiff(s.bearing, bearing)) > fov) continue;
      // (a ship near it sits a little off the plane, as ships do; a torpedo flying at it, between it
      // and us or closing from the side, is on its way to it in the plane: it converges on it)
      const dT = tpos ? Math.hypot(p.x - tpos.x, p.y - tpos.y) * AU_M : s.distM;
      const zM = o.ord?.target === id ? 0 : (idHash(oid) - 0.5) * 2 * Z_SPREAD * Math.min(dT, 20_000);
      const [x, y] = toScreen(s, zM);
      if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
      this.drawThing(ctx, state, o, s, x, y, ppr, psfPx, mShow, t);
    }

    // Flashes in the field
    let whiteout = 0;
    for (const fx of fxList()) {
      const kind = flashKind(fx);
      if (!kind || fx.age >= 1 || fx.x == null) continue;
      const dx = (fx.x - us.x) * AU_M, dy = (fx.y - us.y) * AU_M;
      const distM = Math.max(1, Math.hypot(dx, dy));
      const off = angDiff(Math.atan2(dy, dx), bearing);
      if (Math.abs(off) > fov) continue;
      const s = mShow - flashMag(kind, distM);
      const x = W / 2 - off * ppr, y = H / 2;
      const big = kind === 'nuclear' || kind === 'fusion';
      if (big) {
        if (s > 14 && fx.age < 0.2) whiteout = Math.max(whiteout, Math.min(1, (s - 14) / 6) * (1 - fx.age / 0.2) ** 2);
        // the fireball's debris, glowing as it spreads (resolved if it is close enough)
        const rPx = Math.max(psfPx * 2, (fx.scaleM || 500) * (0.4 + 2.5 * fx.age) / distM * ppr);
        glow(ctx, x, y, rPx, (1 - fx.age) ** 1.6, kind === 'fusion' ? [255, 200, 120] : [255, 236, 210]);
        psf(ctx, x, y, s * (1 - fx.age) ** 1.5, psfPx, kind === 'fusion' ? [255, 210, 150] : [235, 240, 255]);
      } else {
        // a hit or an intercept: a spark, and a short-lived flare round it as the sensor saturates and recovers
        if (s > 3) glow(ctx, x, y, Math.max(6, psfPx * (4 + 3 * (s - 3))) * (0.6 + 0.9 * fx.age), Math.min(1, (s - 3) / 6) * (1 - fx.age) ** 2, [255, 196, 130]);
        psf(ctx, x, y, s * (1 - fx.age) ** 2, psfPx, [255, 220, 170]);
      }
    }
    if (whiteout > 0) { ctx.fillStyle = `rgba(255,255,255,${whiteout})`; ctx.fillRect(0, 0, W, H); }

    // Our own drive in the way: looking aft through the plume
    const blind = ownPlumeBlinds(state, bearing);
    if (blind) {
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(225,235,255,0.95)'); g.addColorStop(1, 'rgba(120,160,255,0.75)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    this.grain(ctx, W, H, gain);

    // The readouts
    const name = e ? (e.type === 'ordnance' ? 'Torpedo' : isIdentified(state, e) ? e.name : 'Unidentified contact') : null;
    const marks = e && e.type !== 'ordnance' ? markWords(marksOf(frameMarks(state), e.id, isDark(e), e.tags?.wreck)) : '';
    this.hud(ctx, W, H, state, { sc, sight, lock, name, marks, fov, ppr, box, blind, faction: e?.faction });
  }

  /** One thing in the field, by its regime; returns the box round it (px) for the reticle. */
  drawThing(ctx, state, e, s, x, y, ppr, psfPx, mShow, t) {
    const pxPerM = ppr / s.distM;
    const dir = s.noseRight ? 1 : -1;
    const lit = s.plumeMag < Infinity;
    // how far it is resolved, 0 (a point) to 1 (a shape), between 1.5 and 3 elements
    const shape = Math.max(0, Math.min(1, (s.elements - 1.5) / 1.5));
    let box = null;
    if (shape > 0 && e.type !== 'ordnance' && (s.regime !== 'plume' || s.elements >= 6)) {
      const dim = lit ? 0.55 : 1;      // exposed for the plume, the hull goes dark
      box = this.drawShape(ctx, e, s, x, y, pxPerM, Math.max(0, 0.45 * s.resRad * ppr), shape * dim, t);
    }
    if (shape < 1 && s.regime !== 'none') psf(ctx, x, y, (mShow - s.hullMag) * (1 - shape), psfPx, [232, 238, 245]);
    // its night side to us: what light there is comes off the sunlit limb, a thin crescent at the Sun's end
    else if (box && s.phase > NIGHT) {
      const limb = (s.sunRight ? box.x1 : box.x0) - (s.sunRight ? 1 : -1) * Math.min(6, (box.x1 - box.x0) * 0.08);
      psf(ctx, limb, y, (mShow - s.hullMag) * 0.8, psfPx, [232, 238, 245]);
    }
    if (lit) {
      // the drive: a star at the stern
      const hull = e.type === 'ship' ? hullOf(e.cls) : null;
      const sternM = hull ? hull.bounds.x0 : -3;
      const nx = x + dir * sternM * s.foreshorten * pxPerM;
      psf(ctx, nx, y, mShow - s.plumeMag, psfPx, [205, 222, 255]);
      if (box) exhaust(ctx, nx, y, -dir, Math.max(8, (hull?.L || 6) * s.foreshorten * pxPerM * 0.8), Math.max(1.5, (hull?.W || 1) * 0.18 * pxPerM));
    }
    return box || { x0: x - 10, y0: y - 10, x1: x + 10, y1: y + 10 };
  }

  /** A hull (or a station) as the optics resolve it: drawn side on, shaded by the Sun, blurred. */
  drawShape(ctx, e, s, x, y, pxPerM, blurPx, alpha, t) {
    const hull = e.type === 'ship' ? hullOf(e.cls) : null;
    const model = e.type === 'station' ? stationModel(e.id) : null;
    if (!hull && !model) return null;
    const L = hull ? hull.L : model.sizeM, Hm = hull ? Math.max(hull.bounds.z1 - hull.bounds.z0, hull.W * 0.6) : model.sizeM * 0.7;
    const wPx = L * s.foreshorten * pxPerM, hPx = Hm * pxPerM * (model ? 1 : 1.3);
    const m = Math.ceil(blurPx * 3 + 6);
    const dpr = this.fc.dpr;
    const ow = Math.min(4096, Math.ceil(wPx * 1.15 + 2 * m)), oh = Math.min(4096, Math.ceil(hPx * 1.3 + 2 * m));
    const off = this.off;
    if (off.width < ow * dpr || off.height < oh * dpr) { off.width = Math.max(off.width, Math.ceil(ow * dpr)); off.height = Math.max(off.height, Math.ceil(oh * dpr)); }
    const o = off.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, off.width, off.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.save();
    o.translate(ow / 2, oh / 2);
    o.scale((s.noseRight ? 1 : -1) * s.foreshorten, 1);
    const tint = factionColor(e.faction);
    if (hull) drawHull(o, hull, { x: 0, y: 0, facing: 0, scale: pxPerM, view: 'side', tint, plume: 0, t, ports: false });
    else drawStation(o, model, { x: 0, y: 0, angle: 0, scale: pxPerM, t, tint, labels: false });
    o.restore();
    // The Sun's side lit, the far side in shadow; seen from its night side, a silhouette
    const k = (1 - Math.cos(s.phase)) / 2;
    const near = Math.min(0.95, 0.08 + 0.78 * k), far = Math.min(0.97, 0.35 + 0.62 * k);
    const g = o.createLinearGradient(s.sunRight ? ow : 0, 0, s.sunRight ? 0 : ow, 0);
    g.addColorStop(0, `rgba(0,0,0,${near})`); g.addColorStop(1, `rgba(0,0,0,${far})`);
    o.globalCompositeOperation = 'source-atop';
    o.fillStyle = g; o.fillRect(0, 0, ow, oh);
    o.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = alpha;
    // (the model's tones are the display's, dark; in sunlight a hull is bright: exposed for it)
    ctx.filter = `${blurPx > 0.35 ? `blur(${blurPx.toFixed(1)}px) ` : ''}brightness(2.1) contrast(1.15)`;
    ctx.drawImage(off, 0, 0, ow * dpr, oh * dpr, x - ow / 2, y - oh / 2, ow, oh);
    ctx.restore();
    return { x0: x - wPx / 2, y0: y - hPx / 2, x1: x + wPx / 2, y1: y + hPx / 2 };
  }

  /** The sensor's noise: a still pattern, moved every frame. */
  grain(ctx, W, H, gain) {
    if (gain <= 0.02) return;
    const p = this._pat || (this._pat = ctx.createPattern(this.noise, 'repeat'));
    ctx.save();
    ctx.globalAlpha = 0.02 + 0.07 * gain;
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(-Math.floor(Math.random() * 128), -Math.floor(Math.random() * 128));
    ctx.fillStyle = p;
    ctx.fillRect(0, 0, W + 128, H + 128);
    ctx.restore();
  }

  hud(ctx, W, H, state, o) {
    ctx.font = FONT;
    ctx.textBaseline = 'alphabetic';
    const sc = o.sc || scopeOf(state);
    const s = o.sight;
    // the reticle: corner marks round where the target is
    if (s || o.lock?.why === 'range') {
      const b = o.box || { x0: W / 2 - 10, y0: H / 2 - 10, x1: W / 2 + 10, y1: H / 2 + 10 };
      const pad = 10, L = 8;
      const x0 = Math.max(4, b.x0 - pad), x1 = Math.min(W - 4, b.x1 + pad), y0 = Math.max(4, b.y0 - pad), y1 = Math.min(H - 30, b.y1 + pad);
      ctx.strokeStyle = CYAN; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.moveTo(cx + 0.5, cy + sy * L + 0.5); ctx.lineTo(cx + 0.5, cy + 0.5); ctx.lineTo(cx + sx * L + 0.5, cy + 0.5);
      }
      ctx.stroke();
    }
    // what we look at, and the numbers that decide how it looks
    if (o.name) {
      ctx.textAlign = 'right';
      const lines = [[o.name + (o.marks || ''), o.faction ? factionColor(o.faction) : TEXT]];
      const d = s?.distM ?? o.lock?.distM;
      if (d != null) lines.push([`RANGE ${fmtKm(d / 1000)} · LIGHT ${lightTime(d)}`, TEXT]);
      if (s) {
        lines.push([`SIZE ${fmtRad(s.angRad)} · RESOLVES ${fmtRad(s.resRad)} (${fmtLen(s.resM)})`, DIM]);
        const mags = [s.hullMag < 40 ? `HULL MAG ${s.hullMag.toFixed(1)}` : null, s.plumeMag < Infinity ? `PLUME ${s.plumeMag.toFixed(1)}` : null].filter(Boolean).join(' · ');
        lines.push([`${mags} · LIMIT ${s.magLimit.toFixed(1)}`, DIM]);
        lines.push([`FIELD ${fmtRad(o.fov)} · PHASE ${Math.round(s.phase * 180 / Math.PI)}°`, DIM]);
      }
      lines.forEach(([txt, col], i) => { ctx.fillStyle = col; ctx.fillText(txt, W - 12, 20 + i * 14); });
    }
    // scale: a bar of round metres at the target's range
    if (s && o.ppr) {
      const pxPerM = o.ppr / s.distM;
      const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6];
      const bar = nice.find(n => n * pxPerM >= 70) || nice.at(-1);
      const len = bar * pxPerM;
      ctx.strokeStyle = 'rgba(148,163,178,0.9)';
      ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + len, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + len, H - 20); ctx.lineTo(14 + len, H - 12); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(148,163,178,0.95)';
      ctx.fillText(`${fmtLen(bar)} at the target`, 18 + len, H - 12);
    }
    // what the picture is, in words
    const msg = o.msg || (o.blind ? 'BLINDED · our own drive plume is in the line of sight' : s ? REGIME[s.regime](s) : o.lock && !o.lock.ok ? lockWords(o.lock) : null);
    if (msg) {
      ctx.textAlign = 'center';
      ctx.fillStyle = o.warn || o.blind || (o.lock && !o.lock.ok) ? WARN : TEXT;
      ctx.fillText(msg, W / 2, s ? H - 36 : H - 16);
    }
    ctx.textAlign = 'left';
  }
}

const REGIME = {
  resolved: (s) => s.phase > NIGHT ? `RESOLVED · its night side to us, ${Math.round(s.elements)} resolution elements of shadow` : `RESOLVED · ${Math.round(s.elements)} resolution elements across it`,
  blob: () => 'BARELY RESOLVED · a smudge of reflected sunlight',
  point: () => 'UNRESOLVED · a point of reflected sunlight',
  plume: (s) => s.hullMag > s.magLimit ? 'DRIVE PLUME ONLY · the hull is too faint to see' : 'DRIVE PLUME · the hull is lost in its glare',
  none: (s) => s.hullMag < 40 ? `NOTHING ABOVE THE NOISE · it would be magnitude ${s.hullMag.toFixed(1)}; the camera reaches ${s.magLimit.toFixed(1)}`
    : 'NOTHING ABOVE THE NOISE · we see its night side',
};
const lockWords = (l) => l.why === 'range' ? `NO LOCK · ${fmtKm(l.distM / 1000)} out: ${l.text.toLowerCase()}` : l.why === 'track' ? 'NO TRACK · the board no longer holds it' : 'SENSORS DARK';

function lightTime(m) {
  const s = m / C_MS;
  return s < 0.01 ? `${(s * 1e3).toFixed(1)} ms` : s < 60 ? `${s.toFixed(s < 1 ? 2 : 1)} s` : `${(s / 60).toFixed(1)} min`;
}
function fmtRad(r) {
  if (!isFinite(r)) return '—';
  if (r < 1e-3) return `${(r * 1e6).toFixed(r < 1e-5 ? 1 : 0)} µrad`;
  return `${(r * 1e3).toFixed(r < 1e-2 ? 2 : 1)} mrad`;
}
const fmtLen = (m) => m < 1000 ? `${m < 10 ? m.toFixed(1) : Math.round(m)} m` : fmtKm(m / 1000);

/** Which flash an effect is, for the optics (sim/telescope.js FLASH_W), or null. */
function flashKind(fx) {
  if (fx.kind === 'detonation') return fx.blast === 'nuclear' ? 'nuclear' : 'fusion';
  if (fx.kind === 'hit') return fx.warhead === 'nuke' ? null : fx.warhead === 'he' ? 'he' : 'kinetic';
  if (fx.kind === 'intercept') return 'intercept';
  return null;
}

/**
 * Has ordnance drawn at `p` (tm) passed its target since the minute the sim
 * last flew? Then it is no longer drawn: the sim settles that minute whole,
 * and whether it hit, was shot down or missed shows when it does.
 */
function passed(o, p, world, tm) {
  const tg = o.ord?.target ? world.get(o.ord.target) : null;
  if (!tg) return false;
  const q = predictEntity(tg, tm, world).pos;
  const r0x = tg.pos.x - o.pos.x, r0y = tg.pos.y - o.pos.y;
  const r1x = q.x - p.x, r1y = q.y - p.y;
  return r0x * r1x + r0y * r1y < 0;
}

/**
 * A point of light: `s` magnitudes above what the frame shows (none at
 * 0 or less), as wide as the optics blur a star (rPx); saturated, it
 * blooms and throws the mirror's four diffraction spikes.
 */
function psf(ctx, x, y, s, rPx, rgb) {
  if (!(s > 0)) return;
  const I = Math.min(1, 0.2 + 0.13 * s);
  const r = Math.max(1.1, rPx);
  const over = Math.max(0, s - 6);           // past this the pixels saturate: the spot blooms
  const R = r * (2 + over * 0.9);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, `rgba(255,255,255,${I})`);
  g.addColorStop(Math.min(0.5, 0.45 / (1 + over * 0.3)), `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${I * 0.6})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
  if (over > 1) {
    const len = r * (4 + over * 6);
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(0.7, (over - 1) * 0.12)})`;
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len); ctx.stroke();
  }
  ctx.restore();
}

/** A soft glowing cloud (a fireball's debris), radius rPx. */
function glow(ctx, x, y, rPx, a, rgb) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, rPx);
  g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
  g.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.6 * a})`);
  g.addColorStop(1, `rgba(${rgb[0]},${Math.round(rgb[1] * 0.5)},${Math.round(rgb[2] * 0.3)},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, rPx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** The exhaust behind a resolved hull's drive: a short, hot cone (most of a fusion jet is invisible). */
function exhaust(ctx, x, y, dir, len, w) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, y, x + dir * len, y);
  g.addColorStop(0, 'rgba(235,242,255,0.9)'); g.addColorStop(0.12, 'rgba(170,200,255,0.45)'); g.addColorStop(0.5, 'rgba(110,150,255,0.12)'); g.addColorStop(1, 'rgba(90,130,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(x, y - w); ctx.quadraticCurveTo(x + dir * len * 0.3, y - w * 2.2, x + dir * len, y - w * 2.6); ctx.lineTo(x + dir * len, y + w * 2.6); ctx.quadraticCurveTo(x + dir * len * 0.3, y + w * 2.2, x, y + w); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/**
 * The sky behind, in cells of CELL radians (the same stars whatever the
 * field): as many per cell as there are stars to magnitude 19, each drawn
 * if the exposure reaches it.
 */
function drawStars(ctx, W, H, bearing, fov, ppr, mShow, psfPx) {
  const hw = fov / 2, hh = fov * H / W / 2;
  const i0 = Math.floor((bearing - hw) / CELL), i1 = Math.floor((bearing + hw) / CELL);
  const j0 = Math.floor(-hh / CELL), j1 = Math.floor(hh / CELL);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 900) return;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const n = Math.floor(STARS_PER_CELL * (0.55 + 0.9 * hash(i, j, 1)));
    for (let k = 0; k < n; k++) {
      const m = STAR_FAINT + Math.log10(Math.max(1e-9, hash(i, j, 10 + k * 3))) / 0.45;
      const s = mShow - m;
      if (s <= 0) continue;
      const az = (i + hash(i, j, 11 + k * 3)) * CELL, el = (j + hash(i, j, 12 + k * 3)) * CELL;
      const x = W / 2 - (az - bearing) * ppr, y = H / 2 - el * ppr;
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
      if (psfPx < 1.5 && s < 8) {
        ctx.fillStyle = `rgba(225,232,245,${Math.min(1, 0.12 + 0.11 * s)})`;
        const r = Math.max(0.6, psfPx * 0.8);
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      } else psf(ctx, x, y, s, psfPx, [215, 225, 245]);
    }
  }
}

/** A tile of sensor noise: faint speckle, a few hot pixels. */
function makeNoise() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const o = c.getContext('2d');
  const img = o.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.002 ? 200 : Math.floor(Math.random() ** 3 * 90);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = Math.min(255, v + 6); img.data[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return c;
}
