// ============================================================
// LONGHAUL — The hull cameras: fixed wide-angle lenses on our own plating
//
// A few cameras bolted to the hull, looking out, each with a piece of the
// ship in its frame, as an airliner's are: no drone to send, nothing to
// recall, always there. They show what is round us from where we are, not
// our ship in its surroundings (that is the drone's picture, exterior.js):
//
//   FWD    on a mast over the dorsal plating near the stern, looking
//          forward along the spine: the hull below, the bow ahead
//   AFT    on a mast near the bow, looking back down the hull to the
//          drive (a lit drive's plume fills it)
//   PORT   on a short boom off the port flank aft, looking forward and out:
//   STBD   the flank running along one edge of the frame (port is y−, the
//          side the red light is on: hulls.js)
//
// Each is placed on the hull model's own surface (its parts' extents at
// that station along the hull, hulls.js), so every class's cameras sit on
// its plating, and moves with the hull: flying, or mated at a collar (the
// pose the drone's picture has, exterior.js ourMount). The lens is a
// pinhole 80° across (gl/ships3d.js perspectiveCamera), the scene the one
// the drone sees (exterior.js surroundings, posed, with every hull's damage)
// out to LOOK_M, lit as the drone's picture is: the Sun's light raised out of
// the plane it lies in (exterior.js SUN_RAISE), so the plating the cameras
// look along takes it, and the Sun drawn in the sky where that light comes
// from, so a frame's light and its Sun agree.
//
// Behind the solids, the sky, drawn from numbers as the telescope's is
// (scope-sky.js): its own bright stars, as far down as a camera exposed for
// sunlit plating reaches (STAR_LIMIT); the worlds as discs at their phase,
// at their true size in the frame (a moon a station circles fills it); the
// Sun a white-hot disc with its glare; ships too far to see as hulls, a
// point of light while their drive is lit. A lit drive, near or far, ours
// too, is drawn through the lens as the Sun is, its glare as far as its
// light against the Sun's (exterior.js driveGlare: these lenses carry no
// line filter, as the telescope does): a big hull's torch a few km off
// glares as the Sun does, our own seen from our plating veils the frame. A station's rock is the GPU's
// (the ground, ray-cast per pixel through the lens). Names go beside the
// hulls and stations in the frame (labels.js), with their range; a click
// picks one (onSelect), as on the drone's picture.
//
// Without WebGL2 there is no picture: the cameras say so.
// ============================================================

import { AU_M, DAY_MIN, G0 } from '../core/constants.js';
import { getWorld } from '../sim/world.js';
import { partExtent } from '../sim/hulls.js';
import { bodySight, PLUME_W_PER_N } from '../sim/telescope.js';
import { BODIES } from '../sim/ephemeris.js';
import { isDark, isIdentified } from '../sim/sensors.js';
import { factionColor } from '../sim/factions.js';
import { FitCanvas, pointAt } from './dom.js';
import { has3D, renderScene, perspectiveCamera } from './gl/ships3d.js';
import { surroundings, smoothStep, poseObjects, ourMount, gpuObjects, ventsOver, poseMatrix, rockOf, fillLight, driveLights, driveGlare, lightK, SUN_RAISE } from './exterior.js';
import { SkyPainter, brightStars } from './scope-sky.js';
import { Labels } from './labels.js';

export const HULL_CAMS = [
  { id: 'fwd', label: 'FWD', name: 'TAIL MAST · LOOKING FORWARD' },
  { id: 'aft', label: 'AFT', name: 'BOW MAST · LOOKING AFT' },
  { id: 'port', label: 'PORT', name: 'PORT FLANK · LOOKING FORWARD' },
  { id: 'stbd', label: 'STBD', name: 'STARBOARD FLANK · LOOKING FORWARD' },
];
const LOOK_M = 80_000;           // hulls and stations this close are drawn as solids (a 100 m hull is a pixel or two out there)
const FAR_AU = 0.01;             // …and a lit drive this close as a point of light
const HFOV = 80 * Math.PI / 180; // the lens, across
const NEAR_M = 0.5, FAR_M = 120_000;
const BOW_AT = 0.35;             // a mast camera's far end of the hull sits this far below the middle of the frame (of its half-height)
const FLANK_YAW = 60 * Math.PI / 180;   // a flank camera looks this far round from straight out, along the hull
const STAR_LIMIT = 4.2;          // the faintest star a camera exposed for sunlit plating shows
const SUN_GLARE_RAD = 0.35;      // no star this close to the Sun
const FONT = '10px "IBM Plex Mono", monospace';

/**
 * The highest anything stands at station `x` along the hull (the parts that
 * span it), and how far anything reaches to a side (sign −1 port, +1
 * starboard) at `x` and height `z`: a camera beyond either is outside every
 * part. (Every part, not just the pressure hull: a radiator or a tank out
 * there would have the lens inside it.)
 */
function topAt(hull, x) {
  let z = -Infinity;
  for (const p of hull.parts) { const e = partExtent(p); if (e.x0 <= x && x <= e.x1) z = Math.max(z, e.z1); }
  return isFinite(z) ? z : hull.bounds.z1;
}
function sideAt(hull, x, z, sign) {
  let y = 0;
  for (const p of hull.parts) {
    const e = partExtent(p);
    if (e.x0 <= x && x <= e.x1 && e.z0 <= z && z <= e.z1) y = Math.max(y, sign > 0 ? e.y1 : -e.y0);
  }
  return y || hull.W / 2;
}

/**
 * Where a camera sits on this hull and which way it looks, in the ship's
 * frame (x bow, y starboard, z dorsal): { pos, dir }. A mast camera is
 * pitched so the far end of the hull sits BOW_AT below the frame's middle.
 */
export function mountOf(hull, id, vfov) {
  const b = hull.bounds, L = b.x1 - b.x0;
  const mast = Math.max(1.5, 0.04 * L);
  const pitchTo = (x0, z0, x1, z1) => Math.atan2(z0 - z1, Math.abs(x1 - x0)) - Math.atan(BOW_AT * Math.tan(vfov / 2));
  if (id === 'fwd' || id === 'aft') {
    const fwd = id === 'fwd';
    const x = fwd ? b.x0 + 0.15 * L : b.x1 - 0.12 * L;
    const z = topAt(hull, x) + mast;
    const xEnd = fwd ? b.x1 - 0.02 * L : b.x0 + 0.02 * L;
    const p = pitchTo(x, z, xEnd, topAt(hull, xEnd));
    return { pos: [x, 0, z], dir: [(fwd ? 1 : -1) * Math.cos(p), 0, -Math.sin(p)] };
  }
  const sign = id === 'stbd' ? 1 : -1;
  const x = b.x0 + 0.3 * L, z = 0.2 * topAt(hull, x);
  const y = sign * (sideAt(hull, x, z, sign) + 1.5);
  return { pos: [x, y, z], dir: [Math.sin(FLANK_YAW), sign * Math.cos(FLANK_YAW), 0] };
}

const xform = (M, v, w) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12] * w, M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13] * w, M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14] * w];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class HullCamView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'hullcam-canvas' });
    this.cam = HULL_CAMS[0].id;
    this.t0 = performance.now();
    this.sky = new SkyPainter();
    this.labels = new Labels();
    this._hits = [];
    this._sm = null;
    if (onSelect) {
      container.addEventListener('click', (e) => { const id = this.hit(container, e); if (id) { e.stopPropagation(); onSelect(id); } });
      container.addEventListener('pointermove', (e) => pointAt(this.fc.canvas, this.hit(container, e)));
    }
  }

  reset() { this._sm = null; }

  /** Which camera is on: an id of HULL_CAMS. */
  select(id) { if (HULL_CAMS.some(c => c.id === id)) this.cam = id; }
  /** The next camera round. */
  next() { const i = HULL_CAMS.findIndex(c => c.id === this.cam); this.cam = HULL_CAMS[(i + 1) % HULL_CAMS.length].id; return this.cam; }

  hit(container, e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 24 * 24;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
    return best ? best.id : null;
  }

  render(state, alpha) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h, dpr = fc.dpr;
    const t = (performance.now() - this.t0) / 1000;
    const camDef = HULL_CAMS.find(c => c.id === this.cam) || HULL_CAMS[0];
    ctx.fillStyle = '#020409';
    ctx.fillRect(0, 0, W, H);
    this._hits.length = 0;
    if (!has3D()) { this.osd(ctx, W, H, camDef, 'NO PICTURE · the hull cameras need WebGL2'); return; }

    // What is round us, posed (as the drone's picture has it), and our own hull
    const g = surroundings(state, alpha, LOOK_M);
    const { tm, objects } = g;
    const us = g.us;
    this._sm = smoothStep(this._sm, objects, tm, us);
    poseObjects(state, objects, us, tm);
    const { ours, mine, ourPlume } = ourMount(state, g);

    // The lens: where the camera is on our hull, and which way it looks, in the world (m from us)
    const vfov = 2 * Math.atan(Math.tan(HFOV / 2) * H / W);
    const mount = mountOf(ours, camDef.id, vfov);
    const M = poseMatrix(mine);
    const eye = xform(M, mount.pos, 1), fwd = norm(xform(M, mount.dir, 0)), upHull = norm(xform(M, [0, 0, 1], 0));
    const Wd = fc.canvas.width, Hd = fc.canvas.height;
    const camera = perspectiveCamera(eye, fwd, upHull, Wd, Hd, vfov, NEAR_M, FAR_M);
    const right = norm(cross(fwd, upHull)), up = cross(right, fwd);
    const focal = H / 2 / Math.tan(vfov / 2);        // CSS px
    /** A world point (m from us) on the screen (CSS px), or null behind the lens. */
    const toS = (p) => {
      const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const z = dot(v, fwd);
      if (z <= 0.1) return null;
      return [W / 2 + focal * dot(v, right) / z, H / 2 - focal * dot(v, up) / z, z];
    };
    /** A direction (unit, the sky's) on the screen, or null behind. */
    const dirS = (d) => { const z = dot(d, fwd); return z <= 0.02 ? null : [W / 2 + focal * dot(d, right) / z, H / 2 - focal * dot(d, up) / z]; };

    // ---- The sky: the stars, the worlds, the Sun
    const sr = Math.hypot(us.x, us.y) || 1;
    const sunDir = [-us.x / sr * Math.cos(SUN_RAISE), -us.y / sr * Math.cos(SUN_RAISE), Math.sin(SUN_RAISE)];
    const stars = brightStars();
    for (const s of stars) {
      if (s.m > STAR_LIMIT) continue;
      const d = [s.x, s.y, s.z];
      if (dot(d, sunDir) > Math.cos(SUN_GLARE_RAD)) continue;
      const p = dirS(d);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
      const a = Math.min(0.85, 0.12 + 0.16 * (STAR_LIMIT - s.m));
      ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${a.toFixed(3)})`;
      const r = s.m < 1.5 ? 1.1 : 0.7;
      ctx.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r);
    }
    const st = objects.find(o => o.e.type === 'station');
    const rock = st ? rockOf(st, us, tm) : null;
    const rockBody = rock ? st.e.orbit?.body : null;
    for (const b of BODIES) {
      if (b.name === rockBody) continue;                    // (the ground under a port is the GPU's)
      const v = bodySight(b, tm, us);
      const d = v.sun ? sunDir : [Math.cos(v.bearing), Math.sin(v.bearing), 0];
      const p = dirS(d);
      if (!p) continue;
      const rPx = v.radRad * focal;
      if (p[0] < -rPx * 2.5 || p[0] > W + rPx * 2.5 || p[1] < -rPx * 2.5 || p[1] > H + rPx * 2.5) continue;
      if (v.sun) { this.sun(ctx, p[0], p[1], Math.max(1.5, rPx)); continue; }   // (where its light comes from: SUN_RAISE out of the plane)
      if (rPx < 1) {
        // (a world too small to be a disc: a point, if a camera reaches it)
        if (v.mag < STAR_LIMIT) { ctx.fillStyle = `rgba(255,244,225,${Math.min(0.95, 0.2 + 0.18 * (STAR_LIMIT - v.mag)).toFixed(3)})`; ctx.fillRect(p[0] - 1, p[1] - 1, 2, 2); }
        continue;
      }
      // (turned with the lens: the disc's up is the plane's normal as the camera sees it)
      const q = dirS(norm([d[0], d[1], 0.02]));
      const roll = q ? Math.atan2(q[0] - p[0], p[1] - q[1]) : 0;
      ctx.save();
      ctx.translate(p[0], p[1]); ctx.rotate(roll); ctx.translate(-p[0], -p[1]);
      this.sky.drawWorld(ctx, v, p[0], p[1], rPx, { days: tm / DAY_MIN, W, H });
      ctx.restore();
    }
    // ships too far to see as hulls: a lit drive is a point of light, as bright as it is here (drawn with the near ones' below)
    const world = getWorld(state);
    const far = [], farLit = [];
    world.query(state.flight.pos, FAR_AU, far);
    for (const e of far) {
      if (e.type !== 'ship' || !(e.thrust > 0.01) || !state.sensors.$seen?.has(e.id)) continue;
      const dx = (e.pos.x - us.x) * AU_M, dy = (e.pos.y - us.y) * AU_M, dist = Math.hypot(dx, dy);
      if (dist < LOOK_M * 0.5) continue;
      const p = toS([dx, dy, 0]);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
      farLit.push({ x: p[0], y: p[1], k: lightK(e.thrust * G0 * (e.mass || 100) * 1000 * PLUME_W_PER_N, dist, sr) });
      this._hits.push({ id: e.id, x: p[0], y: p[1] });
    }

    // ---- The solids, through the lens
    const { objs, looks } = gpuObjects(state, objects, tm, { ours, mine, ourPlume, seen: (hull, o) => !o || hull.L / Math.max(1, o.d) * focal >= 1.2 });
    let nearM = ours.L * 1.2;
    for (const o of objects) if (o.d < 3000) nearM = Math.max(nearM, o.d + o.size / 2);
    const half = Math.min(5000, Math.max(200, nearM));
    const out = renderScene({
      w: Wd, h: Hd, ...camera, sun: sunDir, sunI: 3.2, exposure: 1, objects: objs, t, pxPerM: focal * dpr / Math.max(10, ours.L),
      shadowBox: { cx: 0, cy: 0, cz: mine.mz || 0, half, depth: half }, rock,
      bounce: rock ? { dir: rock.n, col: rock.albedo.map(v => v * 0.45 * Math.max(0, rock.n[0] * sunDir[0] + rock.n[1] * sunDir[1] + 0.3)) } : null,
      fill: fillLight(st, rock, sunDir),
    });
    if (out) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, 0, 0, Wd, Hd);
      ctx.restore();
      // (the air going out of fresh holes: each hull's at its own distance from the lens)
      for (const lk of looks) {
        const m = lk.parts[0].m;
        const dist = Math.hypot(m[12] - eye[0], m[13] - eye[1], m[14] - eye[2]);
        ventsOver(ctx, [lk], (w) => toS(w) || [-1e5, -1e5], focal / Math.max(2, dist), t);
      }
      // the lit drives through the lens, ours among them: the Sun's glare, by how bright each is here
      for (const L of driveLights(objs, () => eye, sr)) { const p = toS(L.p); if (p) driveGlare(ctx, p[0], p[1], L.k, W, H, L.direct); }
    }
    for (const L of farLit) driveGlare(ctx, L.x, L.y, L.k, W, H);

    // ---- Names beside what is in the frame, with the range
    const Lb = this.labels;
    Lb.reset();
    Lb.block(0, 0, W, 34);
    for (const o of objects) {
      const p = toS([o.pose?.mx ?? o.dx, o.pose?.my ?? o.dy, o.pose?.mz || 0]);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
      this._hits.push({ id: o.e.id, x: p[0], y: p[1] });
      const e = o.e;
      const name = e.type === 'station' || isIdentified(state, e) ? e.name : isDark(e) ? 'DARK' : e.tags?.wreck ? 'WRECK' : 'unidentified';
      const rPx = o.size / 2 / p[2] * focal;
      if (rPx > W * 0.3) continue;                          // (filling the frame: it needs no name)
      Lb.add(`${name} · ${range(o.d)}`, p[0], p[1], { off: Math.max(8, rPx * 0.6), font: FONT, color: factionColor(e.faction), alpha: 0.85, pri: 3 - o.d / LOOK_M, above: true });
    }
    Lb.draw(ctx, W, H);
    this.osd(ctx, W, H, camDef, null);
  }

  /** The Sun, unfiltered: a white-hot disc, its glare, and the lens' spikes. */
  sun(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 14 + 40);
    g.addColorStop(0, 'rgba(255,250,236,0.95)'); g.addColorStop(0.12, 'rgba(255,236,200,0.35)'); g.addColorStop(1, 'rgba(255,220,170,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 14 + 40, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,244,220,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 4 + 0.3, l = r * 8 + 60; ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * l, y - Math.sin(a) * l); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke(); }
    ctx.fillStyle = '#FFFDF6'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** The camera's own caption, as a hull camera's feed carries it. */
  osd(ctx, W, H, camDef, msg) {
    const i = HULL_CAMS.indexOf(camDef) + 1;
    ctx.font = FONT; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(10, 10, ctx.measureText(`HULL CAM ${i} · ${camDef.label} · ${camDef.name}`).width + 12, 17);
    ctx.fillStyle = 'rgba(205,218,230,0.95)';
    ctx.fillText(`HULL CAM ${i} · ${camDef.label} · ${camDef.name}`, 16, 22);
    if (msg) { ctx.fillStyle = 'rgba(240,169,58,0.95)'; ctx.textAlign = 'center'; ctx.fillText(msg, W / 2, H / 2); ctx.textAlign = 'left'; }
  }
}

const range = (m) => m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
