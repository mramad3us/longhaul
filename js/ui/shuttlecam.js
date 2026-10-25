// ============================================================
// LONGHAUL — The shuttle's cameras: the ride down and back, from aboard
//
// Three fixed lenses on a shuttle of ours that is out (sim/shuttles.js),
// the way the hull cameras are on our own plating (hullcam.js), a piece of
// the craft in every frame:
//
//   NOSE   over the nose, looking ahead (the nose at the frame's foot)
//   DOWN   under the belly, looking down and a little ahead: the ground
//          going by, the pad coming up
//   TAIL   over the tail, looking back down the hull and its plume
//
// The craft flies as its run's flight path has it (planetary.js: every
// stretch flown once as physics, ridden on rails), and is turned as it
// would be: on the drive, its nose along its thrust (flipped to brake);
// in the entry, belly first into the air flowing past it (the air turning
// with the world), its nose pitched up by its angle of attack, steep at
// the top and easing as it slows, level for the powered landing; on the
// pad, on its skids; climbing out, nose up, pitching over downrange.
//
// What they see is the scene the hull cameras see, posed round the
// shuttle (our own ship among it, with its plume when it burns), lit the
// same way, and the world under it from close (gl/world3d.js): its ground
// at true size, turning, from the telescope's own map, its air glowing at
// the limb from orbit and becoming the sky inside, the stars gone in
// daylight; the pad at the spaceport, its lights blinking. Through the
// entry the shock in front of the belly glows round the frame (the run's
// heat at that moment, in the air's own colour), streaming aft past the
// lenses. The caption carries the run: its stretch, height, the air's
// speed past it, the heat and the G, and when it is home.
//
// Without WebGL2 there is no picture: the cameras say so.
// ============================================================

import { AU_M, DAY_MIN, G0 } from '../core/constants.js';
import { getWorld, predictEntity } from '../sim/world.js';
import { activeRuns, runOf, runReadout } from '../sim/shuttles.js';
import { flightPathAt } from '../sim/planetary.js';
import { worldOf, worldAngle, airspaceById, airspacesOf } from '../sim/worlds.js';
import { bodyPos, bodyVel, BODIES } from '../sim/ephemeris.js';
import { hullOf, partExtent } from '../sim/hulls.js';
import { CLASSES, PLAYER_CLASS } from '../sim/ship-classes.js';
import { bodySight } from '../sim/telescope.js';
import { liveKnowledge } from '../sim/intel.js';
import { isDark, isIdentified } from '../sim/sensors.js';
import { factionColor } from '../sim/factions.js';
import { FitCanvas, fmtMeters } from './dom.js';
import { has3D, renderScene, perspectiveCamera } from './gl/ships3d.js';
import { poseObjects, gpuObjects, poseMatrix, ourPlace, SUN_RAISE } from './exterior.js';
import { SkyPainter, brightStars, surfaceMap } from './scope-sky.js';
import { Labels } from './labels.js';

export const SHUTTLE_CAMS = [
  { id: 'nose', label: 'NOSE', name: 'OVER THE NOSE · LOOKING AHEAD' },
  { id: 'down', label: 'DOWN', name: 'UNDER THE BELLY · LOOKING DOWN' },
  { id: 'tail', label: 'TAIL', name: 'OVER THE TAIL · LOOKING BACK' },
];
const LOOK_M = 80_000;            // hulls this close are drawn as solids
const HFOV = 84 * Math.PI / 180;  // the lens, across
const NEAR_M = 0.25, FAR_M = 2e6;
const STAR_LIMIT = 4.2;
const SUN_GLARE_RAD = 0.35;
const FONT = '10px "IBM Plex Mono", monospace';
const PAD_R = { gig: 25, pinnace: 40, lander: 60 };
const TURN_S = 0.45;              // how quickly the picture follows a change of attitude (s of real time)

/**
 * What each world's air does to light, for the GPU (world3d.js): its own
 * scattering's vertical optical depth at the ground by colour, at a
 * standard atmosphere (scaled by its pressure), its haze's (dust, smog,
 * Titan's photochemical orange), the haze's scale height against the
 * air's, its forward throw; the sky's brightness against the Sun's; the
 * glow of the shock in front of an entering craft.
 */
const AIR_LOOK = {
  Earth: { ray: [0.058, 0.135, 0.33], haze: [0.03, 0.032, 0.036], hazeK: 0.6, g: 0.76, skyK: 2.6, plasma: [255, 120, 150] },
  Mars: { ray: [0.032, 0.07, 0.16], haze: [0.13, 0.095, 0.065], hazeK: 0.8, g: 0.7, skyK: 2.3, plasma: [255, 150, 90] },
  Titan: { ray: [0.06, 0.12, 0.25], haze: [1.4, 2.1, 3.4], hazeK: 1.6, g: 0.6, skyK: 1.8, plasma: [210, 120, 255] },
  Venus: { ray: [0.06, 0.13, 0.3], haze: [6, 6.5, 7.5], hazeK: 1.2, g: 0.7, skyK: 1.6, plasma: [255, 170, 110] },
};
const DEFAULT_AIR = { ray: [0.058, 0.135, 0.33], haze: [0.05, 0.05, 0.05], hazeK: 0.8, g: 0.7, skyK: 2.2, plasma: [255, 140, 110] };

/** Each world's ground, for the GPU: [craters, ridged hills, relief, dunes] (0–1). */
const GROUND = { Earth: [0, 0.8, 0.8, 0], Mars: [0.35, 0.5, 1, 0.25], Titan: [0.08, 0.2, 0.6, 0.85], Luna: [1, 0.25, 1, 0], Venus: [0.15, 0.5, 0.8, 0], Io: [0.05, 0.4, 0.8, 0], Europa: [0.15, 0.6, 0.3, 0] };

const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const range = (m) => m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

/** How high anything of the hull stands at station x (its parts that span it). */
function topAt(hull, x) {
  let z = -Infinity;
  for (const p of hull.parts) { const e = partExtent(p); if (e.x0 <= x && x <= e.x1) z = Math.max(z, e.z1); }
  return isFinite(z) ? z : hull.bounds.z1;
}
/** The belly at station x: the lowest of the hull there, its skids left out (the lens goes between them). */
function bellyAt(hull, x) {
  let z = Infinity;
  for (const p of hull.parts) { if (p.role === 'leg') continue; const e = partExtent(p); if (e.x0 <= x && x <= e.x1) z = Math.min(z, e.z0); }
  return isFinite(z) ? z : hull.bounds.z0;
}
/** How high its middle stands over the ground when it rests on its skids (its lowest part). */
export const restHeight = (hull) => -hull.bounds.z0 + 0.05;

/** Where a lens sits on the craft (x bow, y starboard, z dorsal) and how it looks: { pos, dir, up }. */
export function shuttleMount(hull, id) {
  const b = hull.bounds, L = b.x1 - b.x0;
  if (id === 'down') {
    const x = b.x0 + 0.62 * L, a = 28 * Math.PI / 180;
    return { pos: [x, 0, bellyAt(hull, x) - 0.12], dir: [Math.sin(a), 0, -Math.cos(a)], up: [Math.cos(a), 0, Math.sin(a)] };
  }
  if (id === 'tail') {
    // (on a short mast near the stern: the bell and the plume below the middle of the frame)
    const x = b.x0 + 0.2 * L, p = 13 * Math.PI / 180;
    return { pos: [x, 0, topAt(hull, x) + Math.max(0.8, 0.06 * L)], dir: [-Math.cos(p), 0, -Math.sin(p)], up: [0, 0, 1] };
  }
  // (just past the nose, under its brow, looking ahead and down: the nose's front edge along the foot of the frame)
  const p = 16 * Math.PI / 180;
  return { pos: [b.x1 + 0.12, 0, topAt(hull, b.x1 - 0.1) - 0.35], dir: [Math.cos(p), 0, -Math.sin(p)], up: [0, 0, 1] };
}

/**
 * The craft's place and attitude at tm: { fp (flightPathAt), W (the world),
 * c (its centre, AU), X, Y, Z (the hull's axes, world), ur (up), vAir (the
 * air past it, m/s), plume (G) }.
 */
export function shuttleAttitude(state, run, tm) {
  const world = getWorld(state);
  const path = { world: run.world, cls: run.cls, carrier: run.carrier, legs: run.legs };
  const fp = flightPathAt(world, path, tm);
  const W = worldOf(run.world);
  const days = tm / DAY_MIN;
  const c = bodyPos(W.body, days), cv = bodyVel(W.body, days);
  const rx = (fp.pos.x - c.x) * AU_M, ry = (fp.pos.y - c.y) * AU_M, r = Math.hypot(rx, ry) || 1;
  const ur = [rx / r, ry / r, 0];
  const om = 2 * Math.PI / W.rotS;
  const east = norm([-ur[1] * Math.sign(om || 1), ur[0] * Math.sign(om || 1), 0]);
  const vr = [fp.vel.vx - cv.vx, fp.vel.vy - cv.vy, 0];
  const vAir = [vr[0] + om * ry, vr[1] - om * rx, 0];
  const craft = CLASSES[run.cls];
  // the attitude in the plane: the nose `th` above the horizontal `h` (the way it moves along the ground)
  const pitched = (h, th) => ({ X: add(scale(h, Math.cos(th)), ur, Math.sin(th)), Z: add(scale(h, -Math.sin(th)), ur, Math.cos(th)) });
  let att, plume = 0;
  const along = (v) => { const vh = add(v, ur, -dot(v, ur)), l = Math.hypot(vh[0], vh[1]); return l > 1e-6 ? scale(vh, 1 / l) : east; };
  if (fp.leg === 'ground') att = pitched(east, 0);
  else if (fp.leg === 'down' || fp.leg === 'up') {
    const s = Math.hypot(vAir[0], vAir[1]), h = along(vAir);
    const gam = s > 1 ? Math.atan2(dot(vAir, ur), dot(vAir, h)) : fp.leg === 'up' ? Math.PI / 2 : 0;
    if (fp.leg === 'down') {
      // belly first: steep at the top of the air, easing as it slows, level for the powered landing
      const aoa = (12 + 28 * smooth(600, 2500, s)) * Math.PI / 180;
      const level = 1 - smooth(120, 420, s) * smooth(1500, 6000, fp.h ?? 1e9);
      att = pitched(h, (gam + aoa) * (1 - level));
      plume = level > 0.3 ? Math.max(0.3, fp.g || 0) : 0;
    } else {
      att = pitched(h, gam);
      plume = craft.drive.maxG * 0.85;
    }
  } else if (fp.leg === 'path' || fp.leg === 'hold') {
    // on the drive: the nose along its thrust (the pull taken out of what moves it); coasting, along its way
    const fp2 = flightPathAt(world, path, tm + 1 / 60);
    const a = [(fp2.vel.vx - fp.vel.vx), (fp2.vel.vy - fp.vel.vy), 0];
    const gk = W.GM / (r * r);
    const ad = add(a, ur, gk);
    const al = Math.hypot(ad[0], ad[1]);
    const X = al > 0.25 ? scale(ad, 1 / al) : norm(Math.hypot(vr[0], vr[1]) > 1 ? vr : east);
    let Z = [-X[1], X[0], 0];
    if (dot(Z, ur) < 0) Z = scale(Z, -1);
    att = { X, Z };
    plume = al > 0.25 ? al / G0 : 0;
  } else att = pitched(east, 0);
  const X = norm(att.X), Z = norm(att.Z);
  return { fp, W, c, X, Y: cross(Z, X), Z, ur, vAir, plume, r };
}

export class ShuttleCamView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'hullcam-canvas' });
    this.cam = SHUTTLE_CAMS[0].id;
    this.run = null;
    this.t0 = performance.now();
    this.sky = new SkyPainter();
    this.labels = new Labels({ halo: 'rgba(0,0,0,0.6)', haloW: 3 });
    this._att = null;
    this._hits = [];
    if (onSelect) container.addEventListener('click', (e) => { const id = this.hit(container, e); if (id) { e.stopPropagation(); onSelect(id); } });
  }

  reset() { this._att = null; }
  select(id) { if (SHUTTLE_CAMS.some(c => c.id === id)) this.cam = id; }
  next() { const i = SHUTTLE_CAMS.findIndex(c => c.id === this.cam); this.cam = SHUTTLE_CAMS[(i + 1) % SHUTTLE_CAMS.length].id; return this.cam; }
  follow(runId) { if (runId !== this.run) { this.run = runId; this._att = null; } }

  hit(container, e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 24 * 24;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
    return best ? best.id : null;
  }

  /** The run the cameras follow: the one picked, else the first out. */
  runFor(state) {
    const out = activeRuns(state).filter(r => r.carrier === 'player');
    return out.find(r => r.id === this.run) || out[0] || null;
  }

  render(state, alpha) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h, dpr = fc.dpr;
    const t = (performance.now() - this.t0) / 1000;
    const camDef = SHUTTLE_CAMS.find(c => c.id === this.cam) || SHUTTLE_CAMS[0];
    ctx.fillStyle = '#020409';
    ctx.fillRect(0, 0, W, H);
    this._hits.length = 0;
    const run = this.runFor(state);
    if (!run) { this.osd(ctx, W, H, camDef, null, 'NO SHUTTLE OUT · launch one from the shuttle window (G)'); return; }
    if (!has3D()) { this.osd(ctx, W, H, camDef, run, 'NO PICTURE · the shuttle cameras need WebGL2'); return; }
    const tm = state.clock.minute + Math.max(0, Math.min(1, alpha ?? 1));
    const rd = runReadout(state, run, tm);
    const A = shuttleAttitude(state, run, tm);
    if (A.fp.leg === 'dock') {
      const out = rd.phase === 'launch';
      this.osd(ctx, W, H, camDef, run, out ? `IN ITS BAY · out in ${Math.max(1, Math.round(rd.legEnd))} min` : 'IN ITS BAY · aboard');
      return;
    }
    // (the picture follows a small change of attitude over a moment, as the craft turns; a big one, or
    // anything under warp, is shown as it is: blending far-apart attitudes would turn it through nonsense)
    const now = performance.now();
    const o = this._att;
    if (o && state.speed <= 1 && now - o.at < 500 && dot(o.X, A.X) > 0.64 && dot(o.Z, A.Z) > 0.64) {
      const k = 1 - Math.exp(-(now - o.at) / 1000 / TURN_S);
      const X = norm(add(o.X, add(A.X, o.X, -1), k));
      let Z = norm(add(o.Z, add(A.Z, o.Z, -1), k));
      Z = norm(add(Z, X, -dot(Z, X)));
      if (dot(Z, A.Z) > 0) { A.X = X; A.Z = Z; A.Y = cross(Z, X); }
    }
    this._att = { X: A.X, Z: A.Z, at: now };
    this.$last = { leg: A.fp.leg, h: A.fp.h, vAir: Math.hypot(A.vAir[0], A.vAir[1]), Xup: dot(A.X, A.ur), Zup: dot(A.Z, A.ur), plume: A.plume, tm };
    const hull = hullOf(run.cls);
    const mount = shuttleMount(hull, camDef.id);
    const M = (v) => add(add(scale(A.X, v[0]), A.Y, v[1]), A.Z, v[2]);
    const eye = M(mount.pos), fwd = norm(M(mount.dir)), upV = norm(M(mount.up));
    const vfov = 2 * Math.atan(Math.tan(HFOV / 2) * H / W);
    const Wd = fc.canvas.width, Hd = fc.canvas.height;
    const camera = perspectiveCamera(eye, fwd, upV, Wd, Hd, vfov, NEAR_M, FAR_M);
    const right = norm(cross(fwd, upV)), up = cross(right, fwd);
    const focal = H / 2 / Math.tan(vfov / 2);
    const toS = (p) => { const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]; const z = dot(v, fwd); return z <= 0.1 ? null : [W / 2 + focal * dot(v, right) / z, H / 2 - focal * dot(v, up) / z, z]; };
    const dirS = (d) => { const z = dot(d, fwd); return z <= 0.02 ? null : [W / 2 + focal * dot(d, right) / z, H / 2 - focal * dot(d, up) / z]; };
    const us = A.fp.pos;
    const sr = Math.hypot(us.x, us.y) || 1;
    const sunDir = [-us.x / sr * Math.cos(SUN_RAISE), -us.y / sr * Math.cos(SUN_RAISE), Math.sin(SUN_RAISE)];

    // ---- the sky behind: the stars, the other worlds, the Sun (the air in front of them is the GPU's)
    for (const s of brightStars()) {
      if (s.m > STAR_LIMIT) continue;
      const d = [s.x, s.y, s.z];
      if (dot(d, sunDir) > Math.cos(SUN_GLARE_RAD)) continue;
      const p = dirS(d);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
      ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${Math.min(0.85, 0.12 + 0.16 * (STAR_LIMIT - s.m)).toFixed(3)})`;
      const rr = s.m < 1.5 ? 1.1 : 0.7;
      ctx.fillRect(p[0] - rr, p[1] - rr, 2 * rr, 2 * rr);
    }
    for (const b of BODIES) {
      if (b.name === A.W.name) continue;
      const v = bodySight(b, tm, us);
      const d = v.sun ? sunDir : [Math.cos(v.bearing), Math.sin(v.bearing), 0];
      const p = dirS(d);
      if (!p) continue;
      const rPx = v.radRad * focal;
      if (p[0] < -rPx * 2.5 || p[0] > W + rPx * 2.5 || p[1] < -rPx * 2.5 || p[1] > H + rPx * 2.5) continue;
      if (v.sun) { this.sun(ctx, p[0], p[1], Math.max(1.5, rPx)); continue; }
      if (rPx < 1) continue;
      this.sky.drawWorld(ctx, v, p[0], p[1], rPx, { days: tm / DAY_MIN, W, H });
    }

    // ---- what is round it: our own ship (with its plume), other hulls and stations close by
    const world = getWorld(state);
    const objects = [];
    const near = world.query(us, LOOK_M / AU_M);
    for (const e of near) {
      if (e.type === 'nav' || e.type === 'ordnance' || e.$inBay || e.id === run.entity) continue;
      if (!liveKnowledge(state, e) && e.type !== 'station') continue;
      const ep = predictEntity(e, tm, world).pos;
      const dx = (ep.x - us.x) * AU_M, dy = (ep.y - us.y) * AU_M, dist = Math.hypot(dx, dy);
      if (dist > LOOK_M) continue;
      objects.push({ e, dx, dy, d: dist, size: hullOf(e.cls)?.L || 1000 });
    }
    poseObjects(state, objects, us, tm);
    const { objs } = gpuObjects(state, objects, tm, { ours: null, mine: null, ourPlume: 0, seen: (h, o) => !!o && h.L / Math.max(1, o.d) * focal >= 1.2 });
    const ourCls = state.ship.classId || PLAYER_CLASS;
    const op = ourPlace(state, tm, (tm - state.clock.minute) * 60);
    const ox = (op.x - us.x) * AU_M, oy = (op.y - us.y) * AU_M, od = Math.hypot(ox, oy);
    const ours = hullOf(ourCls);
    if (od < LOOK_M) objs.push({ kind: 'hull', key: ourCls, model: ours, tl: CLASSES[ourCls]?.tl ?? 2, m: poseMatrix({ mx: ox, my: oy, mz: 0, facing: state.flight.facing, view: 'top' }), tint: '#5FD38D', plume: state.flight.thrustG || 0, lights: true });
    objs.push({ kind: 'hull', key: run.cls, model: hull, tl: 2, m: poseMatrix({ mx: 0, my: 0, mz: 0, R: { X: A.X, Y: A.Y, Z: A.Z } }), tint: '#5FD38D', plume: A.plume, lights: true });

    // ---- the world under it (on the pad, and just over it, the craft stands on its skids: its middle half its height up)
    const Wd2 = A.W, hM = Math.max(A.r - Wd2.R, restHeight(hull));
    const S = scale(A.ur, -hM), n = A.ur;
    const s0 = worldAngle(Wd2, 0, tm);
    const look = AIR_LOOK[Wd2.name] || DEFAULT_AIR;
    const at = Wd2.atmo;
    const press = at ? Math.max(0.05, (at.surfaceKPa ?? 101.3) / 101.3) : 0;
    const air = at && !at.giant ? {
      topM: at.interfaceM, H: (at.scaleKm || 8.5) * 1000, hazeH: (at.scaleKm || 8.5) * 1000 * look.hazeK,
      ray: look.ray.map(x => x * press), haze: look.haze, g: look.g, skyK: look.skyK,
    } : null;
    const a = airspaceById(run.airspace);
    const padAng = a ? worldAngle(Wd2, a.port.ang, tm) : null;
    const padUp = padAng != null ? [Math.cos(padAng), Math.sin(padAng), 0] : null;
    const C = scale(A.ur, -(Wd2.R + hM));
    const pad = padUp ? { p: add(C, padUp, Wd2.R), up: padUp, r: PAD_R[run.cls] || 40 } : null;
    const ports = airspacesOf(Wd2).map(x => { const g = worldAngle(Wd2, x.port.ang, tm); return [Math.cos(g), Math.sin(g), 0]; });
    const sceneWorld = { name: Wd2.name, surf: surfaceMap(Wd2.name, Wd2.body.color), S, n, R: Wd2.R, ex: [Math.cos(s0), Math.sin(s0), 0], ey: [-Math.sin(s0), Math.cos(s0), 0], air, pad, ports, ter: GROUND[Wd2.name] || [0.8, 0.3, 1, 0] };

    const out = renderScene({
      w: Wd, h: Hd, ...camera, sun: sunDir, sunI: 3.2, exposure: 1, objects: objs, t, pxPerM: focal * dpr / Math.max(4, hull.L),
      shadowBox: { cx: 0, cy: 0, cz: 0, half: Math.max(60, hull.L * 2), depth: Math.max(60, hull.L * 2) }, world: sceneWorld,
      fill: { dir: [0.3, -0.2, 1], col: [0.02, 0.021, 0.025] },
    });
    if (out) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, 0, 0, Wd, Hd);
      ctx.restore();
    }

    // ---- the entry's shock, glowing in front of the belly and streaming aft past the lenses
    const q = rd.q || 0;
    // (its glow goes as the gas's temperature does, steeply at first: a Mars entry's shows, Earth's blazes)
    if (q > 1.5e4) this.plasma(ctx, W, H, Math.min(1.5, Math.sqrt(q / 3e5)), look.plasma, camDef.id, t);

    // ---- names: our ship, the pad, the hulls about
    const Lb = this.labels;
    Lb.reset();
    Lb.block(0, 0, W, 40);
    const shipP = toS([ox, oy, 0]);
    if (shipP && shipP[0] > 0 && shipP[0] < W && shipP[1] > 0 && shipP[1] < H) Lb.add(`${state.ship.name || 'our ship'} · ${range(od)}`, shipP[0], shipP[1], { off: 10, font: FONT, color: '#5FD38D', alpha: 0.95, pri: 9, above: true });
    if (pad) {
      const pp = toS(pad.p);
      const dPad = Math.hypot(pad.p[0] - eye[0], pad.p[1] - eye[1], pad.p[2] - eye[2]);
      if (pp && pp[0] > 0 && pp[0] < W && pp[1] > 0 && pp[1] < H && dPad > 200) Lb.add(`${a.port.name} · ${range(dPad)}`, pp[0], pp[1], { off: 8, font: FONT, color: 'rgba(240,200,120,0.95)', pri: 8, above: true });
    }
    for (const o of objects) {
      const p = toS([o.pose?.mx ?? o.dx, o.pose?.my ?? o.dy, o.pose?.mz || 0]);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
      this._hits.push({ id: o.e.id, x: p[0], y: p[1] });
      const e = o.e;
      const name = e.type === 'station' || isIdentified(state, e) ? e.name : isDark(e) ? 'DARK' : 'unidentified';
      Lb.add(`${name} · ${range(o.d)}`, p[0], p[1], { off: 8, font: FONT, color: factionColor(e.faction), alpha: 0.85, pri: 3 });
    }
    Lb.draw(ctx, W, H);
    this.osd(ctx, W, H, camDef, run, null, rd, A);
  }

  /**
   * The shock layer's glow: the air in front of the belly heated to a plasma,
   * wrapping the craft and streaming off it. Seen over the nose it rims the
   * frame's foot and sides; under the belly the picture looks through it;
   * over the tail it is the wake, bright down the middle. k: 0–1.5.
   */
  plasma(ctx, W, H, k, rgb, cam, t) {
    const [r, g, b] = rgb;
    const col = (a) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    const hot = (a) => `rgba(255,${Math.round(200 + 55 * Math.min(1, k))},${Math.round(160 + 60 * Math.min(1, k))},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    const fl = 0.85 + 0.15 * Math.sin(t * 23.0) * Math.sin(t * 7.3);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (cam === 'down') {
      const gr = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.1, W / 2, H * 0.55, Math.max(W, H) * 0.8);
      gr.addColorStop(0, col(0.35 * k * fl)); gr.addColorStop(0.6, col(0.22 * k * fl)); gr.addColorStop(1, col(0.5 * k * fl));
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    } else if (cam === 'tail') {
      const gr = ctx.createLinearGradient(0, H, 0, H * 0.2);
      gr.addColorStop(0, col(0.55 * k * fl)); gr.addColorStop(1, col(0));
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      const wake = ctx.createRadialGradient(W / 2, H * 0.62, 4, W / 2, H * 0.62, W * 0.35);
      wake.addColorStop(0, hot(0.5 * k * fl)); wake.addColorStop(1, col(0));
      ctx.fillStyle = wake; ctx.fillRect(0, 0, W, H);
    } else {
      const gr = ctx.createLinearGradient(0, H, 0, H * 0.35);
      gr.addColorStop(0, hot(0.7 * k * fl)); gr.addColorStop(0.35, col(0.4 * k * fl)); gr.addColorStop(1, col(0));
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      for (const side of [0, 1]) {
        const sg = ctx.createLinearGradient(side ? W : 0, 0, side ? W * 0.72 : W * 0.28, 0);
        sg.addColorStop(0, col(0.45 * k * fl)); sg.addColorStop(1, col(0));
        ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
      }
    }
    // streaks: ionized gas peeling off and streaming aft, out from where the flow parts (few, short, soft)
    const n = Math.round(14 * Math.min(1.2, k));
    const ox = W / 2, oy = cam === 'nose' ? H * 1.05 : cam === 'tail' ? H * 0.62 : H * 0.5;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const s = Math.sin(i * 12.9898 + Math.floor(t * 30) * 0.37) * 43758.5453, f = s - Math.floor(s);
      const s2 = Math.sin(i * 78.233 + 1.7) * 12345.678, f2 = s2 - Math.floor(s2);
      const ang = (cam === 'nose' ? Math.PI + f * Math.PI : f * Math.PI * 2);
      const r0 = (0.3 + 0.45 * f2) * Math.max(W, H), r1 = r0 + (0.03 + 0.07 * f) * Math.max(W, H) * k;
      const dir = cam === 'tail' ? -1 : 1;
      ctx.strokeStyle = (i % 3 ? col : hot)(0.06 + 0.14 * k * f2);
      ctx.lineWidth = 2 + 5 * f * k;
      ctx.beginPath();
      ctx.moveTo(ox + Math.cos(ang) * r0 * dir, oy + Math.sin(ang) * r0 * dir);
      ctx.lineTo(ox + Math.cos(ang) * r1 * dir, oy + Math.sin(ang) * r1 * dir);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The Sun, unfiltered: a white-hot disc, its glare, the lens' spikes. */
  sun(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 14 + 40);
    g.addColorStop(0, 'rgba(255,250,236,0.95)'); g.addColorStop(0.12, 'rgba(255,236,200,0.35)'); g.addColorStop(1, 'rgba(255,220,170,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 14 + 40, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFDF6'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** The caption: the camera, and the run as it flies. */
  osd(ctx, W, H, camDef, run, msg, rd = null, A = null) {
    const i = SHUTTLE_CAMS.indexOf(camDef) + 1;
    const head = `${run ? run.name.toUpperCase() : 'SHUTTLE'} · CAM ${i} · ${camDef.label} · ${camDef.name}`;
    ctx.font = FONT; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(10, 10, ctx.measureText(head).width + 12, 17);
    ctx.fillStyle = 'rgba(205,218,230,0.95)';
    ctx.fillText(head, 16, 22);
    if (rd && A) {
      const vAir = Math.hypot(A.vAir[0], A.vAir[1]);
      const parts = [(rd.words || rd.phase).toUpperCase(), `${run.port.name}, ${run.world}`];
      if (rd.h != null) parts.push(`${fmtMeters(Math.max(0, rd.h))} up`);
      parts.push(`${Math.round(vAir).toLocaleString()} m/s${A.W.atmo ? ' through the air' : ''}`);
      if (rd.q > 1000) parts.push(`heat ${(rd.q / 1e6).toFixed(2)} MW/m²`);
      if (rd.g > 0.05) parts.push(`${rd.g.toFixed(1)} G`);
      parts.push(`home in ${Math.max(0, Math.round(rd.eta))} min`);
      const line = parts.join(' · ');
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(10, 29, ctx.measureText(line).width + 12, 16);
      ctx.fillStyle = 'rgba(240,200,120,0.95)';
      ctx.fillText(line, 16, 40);
    }
    if (msg) { ctx.fillStyle = 'rgba(240,169,58,0.95)'; ctx.textAlign = 'center'; ctx.fillText(msg, W / 2, H / 2); ctx.textAlign = 'left'; }
  }
}
