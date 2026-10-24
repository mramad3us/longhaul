// ============================================================
// LONGHAUL — The exterior view: our ship and what is round it, at true scale
//
// The picture a camera drone of ours sends from outside the hull, on
// station off the plane and looking down (sim/drones.js; without one out
// there is no picture: stage.js). Close to other things (docking,
// alongside another ship, and in time a world's atmosphere) the ship's
// surroundings are drawn as they are, in metres: the rock a port is built
// on, the station's structure and its berths with the ships lying in
// them, other hulls nearby, and our own hull, posed as the sim has it
// (mated at a collar, or flying). The camera (the drone flies where it
// frames this) frames what matters and follows it smoothly; near a
// station the view is turned so the station's up is up (the ground
// below).
//
// The picture is rendered on the GPU (gl/ships3d.js): the hulls and
// stations as lit solids, built from those same models (gl/hullmesh.js),
// the rock as a sphere of cratered regolith, in sunlight with shadows, the
// drive plumes as glowing columns, the whole exposed as a camera would
// (gl/post.js). The drone hangs off the plane looking down at it a little
// from the side, its picture plane kept parallel to the plane, so the
// plane maps to the screen exactly as the overlays have it (OBLIQUE_K: a
// hull's top and one flank show). The Sun lies in the plane; its light is
// raised out of it (SUN_RAISE) so the tops of hulls take it, and a port on
// its rock's night side is floodlit. Without WebGL2 everything is drawn
// flat from hull-art.js instead. Damage shows as the sim left it (gl/
// damage.js): holes, scorching, venting; a wreck tumbling, in pieces, its
// fragments round it.
//
// Overlays for docking: the corridor down the berth's axis with its
// marks, the berth's collar, ours. Names go beside the hulls, never on
// one (labels.js), with the nav computer's marks (marks.js): DARK for a
// hull with no transponder, the job for what our work points at, and a
// flag's pennant at the hull's shoulder. The renderer reads sim state and
// never changes it; a click picks a hull (onSelect), as on the tactical
// display.
//
// The sim moves in whole minutes; the view doesn't. Everything is drawn
// at the moment between minutes the frame stands for (`alpha`), where the
// sim itself would put it (world.predictEntity): rails things (stations,
// berths, berthed hulls, the rock) and traffic on its transit exactly;
// things in free flight flown on, under their thrust and the pull. Our own
// ship the same way, or, holding station on something, at its place off
// that thing: so a ship we hold formation with stays put on the screen
// even under thrust (carried on velocity alone, a ship burning at half a
// G drifts nine kilometres off its place in a minute, and snaps back).
// Near a station the view's rotation is locked to the station's own, so
// the ground doesn't swing.
//
// The camera frames what matters and keeps to it: it stays on the thing it
// is framing until something else comes much closer; it eases there over a
// quarter of a second, and its zoom over most of a second (by the clock, not
// the frame rate), so small changes don't make it breathe. Kilometres from a
// berth (the final approach, the climb out) it frames us and marks the
// station at the screen's edge.
// ============================================================

import { AU_M, DAY_MIN } from '../core/constants.js';
import { getWorld, predictEntity, stepFree } from '../sim/world.js';
import { targetStateAt } from '../sim/nav.js';
import { holdOffset } from '../sim/autopilot.js';
import { getBody, bodyPos } from '../sim/ephemeris.js';
import { hullOf } from '../sim/hulls.js';
import { stationModel, berthOf, stationAngle, berthFrame } from '../sim/stations.js';
import { matePose, turn } from '../sim/mating.js';
import { collarFrame, dockPose, facingOf } from '../sim/docking.js';
import { liveKnowledge } from '../sim/intel.js';
import { isDark, isIdentified } from '../sim/sensors.js';
import { factionColor } from '../sim/factions.js';
import { PLAYER_CLASS, CLASSES } from '../sim/ship-classes.js';
import { FitCanvas, pointAt } from './dom.js';
import { drawHull, drawHullMarks, drawStation } from './hull-art.js';
import { has3D, renderScene, obliqueCamera, hullMatrix, stationMatrix } from './gl/ships3d.js';
import { mat4 } from './gl/gl.js';
import { damageLook, pieces, debrisMatrix, drawVents, mul4 } from './gl/damage.js';
import { Labels } from './labels.js';
import { frameMarks, marksOf, markPri, labelTags, drawMissionMark, drawFlagMark, MARK_COL } from './marks.js';

const _q = [];
const IN_FRAME_PHASES = new Set(['approach', 'prox', 'separate', 'outbound']);
const LOOK_M = 12_000;           // objects this close are candidates for the view
const CAM_TAU_S = 0.25;          // the camera eases toward its framing over this (s)
const ZOOM_TAU_S = 0.8;          // …and its zoom more slowly, so small changes don't make it breathe
const LOCK_EASE_S = 0.8;         // a station come into view: the turn to its up eased over this, then locked
const FAR_FRAME_M = 8_000;       // docking further than this from the berth: we are framed, the station marked
const FAR_SPAN_M = 3_000;
const FOCUS_SWITCH = 0.7;        // another thing takes the frame when it is this much closer than the one framed
const OBLIQUE_K = 0.42;          // the drone looks down at ~23° off the plane's normal: z metres off the plane show k·z to the right
const SUN_RAISE = 48 * Math.PI / 180;  // the Sun's light raised out of the plane (it lies in it) so the tops of hulls take it

export class ExteriorView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'exterior-canvas' });
    this.cam = { x: 0, y: 0, scale: 0.2, rot: 0, ready: false };
    this.t0 = performance.now();
    this._hits = [];
    this.stars = Array.from({ length: 140 }, (_, i) => ({ x: (i * 7919 % 1000) / 1000, y: (i * 104729 % 1000) / 1000, b: 0.2 + (i * 31 % 10) / 14 }));
    if (onSelect) {
      // (a hull clicked is selected; the click goes no further: in the inset it would swap the views too)
      container.addEventListener('click', (e) => { const id = this.hit(container, e); if (id) { e.stopPropagation(); onSelect(id); } });
      container.addEventListener('pointermove', (e) => pointAt(this.fc.canvas, this.hit(container, e)));
    }
  }

  /** A new game, a load: nothing carried over from the last one. */
  reset() {
    this.cam = { x: 0, y: 0, scale: 0.2, rot: 0, ready: false };
    this._sm = null;
    this.focus = null;
  }

  hit(container, e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 24 * 24;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
    return best ? best.id : null;
  }

  /**
   * Our drawn place, against the nearest station: where the sim moves us
   * by a whole minute's worth at once (the first minute of a docking phase
   * is flown inside the minute tick), the step is spread over a third of a
   * second instead of shown as a jump. A step that agrees with how we were
   * moving isn't one; a jump of kilometres (a new game, a long warp) is
   * shown as it is. Shifts `us` and the objects' offsets in place.
   */
  smooth(objects, tm, us) {
    const st = objects.find(o => o.e.type === 'station');
    const sm = this._sm ||= { id: null, tm: 0, x: 0, y: 0, vx: 0, vy: 0, ex: 0, ey: 0, wall: performance.now() };
    const now = performance.now(), wall = Math.min(0.25, (now - sm.wall) / 1000);
    sm.wall = now;
    if (!st || st.e.id !== sm.id) { Object.assign(sm, { id: st?.e.id ?? null, tm, x: st ? -st.dx : 0, y: st ? -st.dy : 0, vx: 0, vy: 0, ex: 0, ey: 0 }); return; }
    const x = -st.dx, y = -st.dy, dS = (tm - sm.tm) * 60;      // us from the station (m); sim seconds since the last frame
    if (dS > 0) {
      const px = sm.x + sm.vx * dS, py = sm.y + sm.vy * dS;
      const jx = x - px, jy = y - py, j = Math.hypot(jx, jy);
      if (j > Math.max(2, 4 * Math.hypot(sm.vx, sm.vy) * dS) && j < 20_000) { sm.ex -= jx; sm.ey -= jy; }
      else { sm.vx = (x - sm.x) / dS; sm.vy = (y - sm.y) / dS; }
      sm.x = x; sm.y = y; sm.tm = tm;
    } else if (dS < 0) Object.assign(sm, { tm, x, y, ex: 0, ey: 0 });
    const k = Math.exp(-wall / 0.12);
    sm.ex *= k; sm.ey *= k;
    if (Math.hypot(sm.ex, sm.ey) < 0.05) { sm.ex = sm.ey = 0; return; }
    us.x += sm.ex / AU_M; us.y += sm.ey / AU_M;
    for (const o of objects) { o.dx -= sm.ex; o.dy -= sm.ey; o.d = Math.hypot(o.dx, o.dy); }
  }

  /** What to look at: the dock's berth and us, or us and the nearest thing close by. */
  frame(state, objects, tm, us) {
    const st = objects.find(o => o.e.type === 'station');
    const d = state.dock;
    let cx = 0, cy = 0, span = 400, rot = 0;
    if (d && (d.phase !== 'inbound' && d.phase !== 'awaiting')) {
      const fr = collarFrame(state, d, tm);
      if (fr) {
        const bx = (fr.pos.x - us.x) * AU_M, by = (fr.pos.y - us.y) * AU_M;
        const ourL = hullOf(state.ship.classId || PLAYER_CLASS).L;
        const r = Math.hypot(bx, by);
        cx = bx / 2; cy = by / 2;
        span = Math.max(ourL * 3, r * 1.4 + ourL * 2);
        // kilometres off (the final approach from the gate, the climb out to it): us, at a scale that
        // shows a hull, and the station off the edge of the screen (drawn as a marker: edgeMarker)
        if (r > FAR_FRAME_M) { cx = 0; cy = 0; span = FAR_SPAN_M; }
        if (d.phase === 'docked' || d.phase === 'capture' || d.phase === 'seal') span = Math.max(ourL * 5, 260);
        rot = Math.atan2(fr.normal.y, fr.normal.x) - Math.PI / 2;
      }
    } else if (objects.length) {
      // the nearest thing, but the one framed keeps the frame until another is much closer
      let n = objects.reduce((a, b) => (a.d < b.d ? a : b));
      const kept = this.focus && objects.find(o => o.e.id === this.focus);
      if (kept && n !== kept && n.d > kept.d * FOCUS_SWITCH) n = kept;
      this.focus = n.e.id;
      cx = n.dx / 2; cy = n.dy / 2;
      span = Math.max(300, n.d * 1.5 + (n.size || 100));
    }
    if (st) {
      // the station's up is the screen's up: the rock (if any) below
      const o = st.e.orbit;
      rot = stationAngle(o, tm) - Math.PI / 2;
    }
    return { cx, cy, span, rot };
  }

  /**
   * The picture on the GPU (gl/ships3d.js): the rock under a surface port,
   * the stations, the other hulls and ours as lit solids in sunlight, copied
   * in over the stars and under the overlays. False without a GPU (the flat
   * drawing stands in).
   */
  solid(state, objects, st, us, tm, t, fc, { ours, mine, ourPlume }) {
    if (!has3D()) return false;
    const cam = this.cam, dpr = fc.dpr;
    const Wd = fc.canvas.width, Hd = fc.canvas.height, sc = cam.scale * dpr;
    const objs = [], looks = [];
    for (const o of objects) {
      const e = o.e, p = o.pose;
      if (!p) continue;
      if (e.type === 'station') {
        const model = stationModel(e.id);
        if (model) objs.push({ kind: 'station', key: e.id, model, m: stationMatrix(p.mx, p.my, p.angle), tint: factionColor(e.faction), lights: true });
      } else if (o.hull && o.hull.L * cam.scale >= 1.5) {
        const look = damageLook(e, o.hull, tm);
        this.hulk(objs, looks, look, { kind: 'hull', key: e.cls, model: o.hull, tl: CLASSES[e.cls]?.tl ?? 2, m: poseMatrix(p), tint: factionColor(e.faction), plume: e.thrust || 0, lights: !isDark(e) && !e.tags?.wreck });
      }
    }
    const ourCls = state.ship.classId || PLAYER_CLASS;
    if (ours.L * cam.scale >= 1.5) {
      const look = damageLook({ id: 'player', hull: state.hull, decks: state.ship.decks }, ours, tm);
      this.hulk(objs, looks, look, { kind: 'hull', key: ourCls, model: ours, tl: CLASSES[ourCls]?.tl ?? 2, m: poseMatrix(mine), tint: '#5FD38D', plume: ourPlume || 0, lights: true });
    }
    const rock = st ? rockOf(st, us, tm) : null;
    if (!objs.length && !rock) return false;
    const camera = obliqueCamera(Wd, Hd, sc, cam.rot, cam.x, cam.y, OBLIQUE_K, Math.max(60_000, Math.max(Wd, Hd) / sc * 4));
    const r = Math.hypot(us.x, us.y) || 1;
    const sun = [-us.x / r * Math.cos(SUN_RAISE), -us.y / r * Math.cos(SUN_RAISE), Math.sin(SUN_RAISE)];
    const half = Math.min(Math.max(Wd, Hd) / sc * 0.62, 5000);
    const out = renderScene({
      w: Wd, h: Hd, ...camera, sun, sunI: 3.2, exposure: 1, objects: objs, t, pxPerM: sc,
      shadowBox: { cx: cam.x, cy: cam.y, cz: 0, half, depth: half }, rock,
      // the sunlit ground below lights the undersides a little
      bounce: rock ? { dir: rock.n, col: rock.albedo.map(v => v * 0.45 * Math.max(0, rock.n[0] * sun[0] + rock.n[1] * sun[1] + 0.3)) } : null,
      fill: fillLight(st, rock, sun),
    });
    if (!out) return false;
    const ctx = fc.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, 0, 0, Wd, Hd);
    ctx.restore();
    // the air going out of fresh holes, the glow of hot edges: over the picture, where the camera puts them
    const cr = Math.cos(-cam.rot), sr = Math.sin(-cam.rot), W = fc.w, H = fc.h;
    const screen = (w) => { const x = w[0] - cam.x, y = w[1] - cam.y; return [W / 2 + (x * cr - y * sr) * cam.scale + OBLIQUE_K * w[2] * cam.scale, H / 2 - (x * sr + y * cr) * cam.scale]; };
    for (const { look, parts } of looks) {
      const at = (q) => { const piece = parts.find(x => !x.clip || x.clip[0] * q[0] + x.clip[1] * q[1] + x.clip[2] * q[2] >= x.clip[3]) || parts[0]; const M = piece.m; return screen([M[0] * q[0] + M[4] * q[1] + M[8] * q[2] + M[12], M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13], M[2] * q[0] + M[6] * q[1] + M[10] * q[2] + M[14]]); };
      drawVents(ctx, look, at, cam.scale, t);
    }
    return true;
  }

  /**
   * A hull for the GPU with its damage (gl/damage.js): tumbling and in pieces
   * if it is a wreck, its fragments round it; untouched, as it is.
   */
  hulk(objs, looks, look, o) {
    if (!look) { objs.push(o); return; }
    const parts = pieces(o.m, look);
    // (a fresh break still glows along the tear)
    const fresh = look.debris ? Math.max(0, 1 - look.debris.sinceS / 60 / 20) : 0;
    for (const pc of parts) objs.push({ ...o, m: pc.m, clip: pc.clip, clipHeat: fresh, damage: look, plume: look.wreck ? 0 : o.plume });
    if (look.debris) look.debris.forEach((d, i) => objs.push({ kind: 'debris', key: String(d.shape), m: mul4(o.m, debrisMatrix(look, d, i)), tint: o.tint, tl: 1, lights: false }));
    looks.push({ look, parts });
  }

  render(state, alpha, opts = {}) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const t = (performance.now() - this.t0) / 1000;
    const f = state.flight;
    const world = getWorld(state);
    // The moment this frame stands for, between two sim minutes
    const a = Math.max(0, Math.min(1, alpha ?? 1));
    const tm = state.clock.minute + a, dtS = a * 60;
    const d = state.dock;
    const held = d && d.phase !== 'inbound' && d.phase !== 'awaiting';
    // Held by a dock, our place is rel in the collar's frame; in the frame
    // phases rel has been flown to dock.t seconds into the minute, and the
    // rest is carried on its rates (a minute flown whole leaves dock.t at 0)
    let ourPose = null;
    if (held) {
      const lead = d.rel && IN_FRAME_PHASES.has(d.phase) ? Math.max(0, dtS - (d.t || 0)) : 0;
      const dd = lead ? { ...d, rel: { ...d.rel, x: d.rel.x + (d.rel.vx || 0) * lead, y: d.rel.y + (d.rel.vy || 0) * lead, yaw: (d.rel.yaw || 0) + (d.rel.wy || 0) * lead } } : d;
      ourPose = dockPose(state, dd, collarFrame(state, d, tm));
    }
    const us = ourPose ? ourPose.pos : ourPlace(state, tm, dtS);
    /** Where an entity is at tm: where the sim would put it (rails and transits exactly, free flight flown on). */
    const at = (e) => predictEntity(e, tm, world).pos;

    // Who is close
    _q.length = 0;
    world.query(f.pos, LOOK_M / AU_M, _q);
    const objects = [];
    for (const e of _q) {
      if (e.type === 'nav' || e.type === 'ordnance') continue;
      if (!liveKnowledge(state, e) && e.type !== 'station') continue;
      const ep = at(e);
      const dx = (ep.x - us.x) * AU_M, dy = (ep.y - us.y) * AU_M;
      const d = Math.hypot(dx, dy);
      if (d > LOOK_M) continue;
      const size = e.type === 'station' ? stationModel(e.id)?.sizeM || 1000 : hullOf(e.cls)?.L || 50;
      objects.push({ e, dx, dy, d, size });
    }
    // the station a dock holds us to is always in the picture, however far (its rock, the frame's turn)
    if (held && d.target.kind === 'station' && !objects.some(o => o.e.id === d.target.id)) {
      const e = world.get(d.target.id);
      if (e) { const ep = at(e); const dx = (ep.x - us.x) * AU_M, dy = (ep.y - us.y) * AU_M; objects.push({ e, dx, dy, d: Math.hypot(dx, dy), size: stationModel(e.id)?.sizeM || 1000 }); }
    }
    this.smooth(objects, tm, us);
    const want = this.frame(state, objects, tm, us);
    const cam = this.cam;
    const wallNow = performance.now(), wall = Math.min(0.25, (wallNow - (cam.wall ?? wallNow)) / 1000);
    cam.wall = wallNow;
    // the span followed slowly (a log-space low-pass): small changes don't make it breathe, a climb or an
    // approach zooms smoothly rather than in steps
    if (!cam.ready || opts.snap || !cam.span) cam.span = want.span;
    else cam.span *= Math.pow(want.span / cam.span, 1 - Math.exp(-wall / ZOOM_TAU_S));
    const scaleWant = Math.min(W, H) / cam.span;
    if (!cam.ready || opts.snap) { Object.assign(cam, { x: want.cx, y: want.cy, scale: scaleWant, rot: want.rot, ready: true }); }
    else {
      const k = 1 - Math.exp(-wall / CAM_TAU_S);
      cam.x += (want.cx - cam.x) * k; cam.y += (want.cy - cam.y) * k;
      cam.scale *= Math.pow(scaleWant / cam.scale, k);
      // near a station the rotation is the station's own, exactly (easing it would make the ground swing),
      // once the view has turned to it: a station come into the picture is eased into, not snapped to
      const stNow = objects.find(o => o.e.type === 'station');
      if (stNow && cam.lockId !== stNow.e.id) { cam.lockId = stNow.e.id; cam.lockEase = LOCK_EASE_S; }
      if (!stNow) cam.lockId = null;
      cam.lockEase = Math.max(0, (cam.lockEase || 0) - wall);
      if (stNow && cam.lockEase <= 0) cam.rot = want.rot;
      else { let dr = want.rot - cam.rot; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); cam.rot += dr * (stNow ? 1 - Math.exp(-wall / 0.2) : k); }
    }
    const sc = cam.scale;
    const cr = Math.cos(-cam.rot), sr = Math.sin(-cam.rot);
    // our-ship-relative metres → screen
    const toS = (mx, my) => { const x = mx - cam.x, y = my - cam.y; return [W / 2 + (x * cr - y * sr) * sc, H / 2 - (x * sr + y * cr) * sc]; };
    const screenAngle = (a) => a - cam.rot;

    // Space
    ctx.fillStyle = '#03060B';
    ctx.fillRect(0, 0, W, H);
    for (const s of this.stars) { ctx.fillStyle = `rgba(200,215,235,${s.b * 0.5})`; ctx.fillRect(s.x * W, s.y * H, 1, 1); }

    // What is in the picture, posed: stations turned with their rock, hulls in a berth (posed by it) or
    // flying, and ours (mated at a collar, or flying)
    for (const o of objects) {
      const e = o.e;
      if (e.type === 'station') { o.pose = { mx: o.dx, my: o.dy, mz: 0, angle: stationAngle(e.orbit, tm) }; continue; }
      const hull = e.type === 'ship' ? hullOf(e.cls) : null;
      if (!hull) continue;
      let pose = null;
      if (e.tags?.berth && e.tags.at) {
        const host = world.get(e.tags.at);
        const b = host && berthOf(host.id, e.tags.berth);
        const port = b && hull.ports.find(p => b.accepts.includes(p.size));
        if (b && port) {
          const fr = berthFrame(state, host, b, tm);
          const mp = matePose(fr, port);
          pose = { mx: (mp.center.x - us.x) * AU_M, my: (mp.center.y - us.y) * AU_M, mz: mp.offZ, facing: mp.facing, view: mp.view, R: mp.R };
        }
      }
      o.pose = pose || { mx: o.dx, my: o.dy, mz: 0, facing: facingOf(e), view: 'top', R: null };
      o.hull = hull;
    }
    const ours = hullOf(state.ship.classId || PLAYER_CLASS);
    const mine = { mx: 0, my: 0, mz: 0, facing: ourPose ? ourPose.facing : f.facing, view: ourPose ? ourPose.view : 'top', R: null };
    if (ourPose?.R) {
      // mated: the collar's rotation, turned by the yaw the dock holds; our centre off the plane by our port's place
      const yaw = d.rel?.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
      const rz = (v) => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
      mine.R = { X: rz(ourPose.R.X), Y: rz(ourPose.R.Y), Z: rz(ourPose.R.Z) };
      const port = ours.ports.find(p => p.id === d.port) || ours.ports[0];
      mine.mz = -turn(ourPose.R, [port.x, port.y, port.z])[2];
    }
    const ourPlume = d?.phase === 'approach' ? state.$dockThrust || 0 : f.thrustG;
    const ourRcs = Math.min(1, (d && IN_FRAME_PHASES.has(d.phase) ? state.$dockRcs || 0 : 0) * 30 + (Math.abs(f.turning) > 0.01 ? 0.5 : 0));

    // The picture itself: on the GPU, lit solids in sunlight (ships3d.js); else drawn flat
    const st = objects.find(o => o.e.type === 'station');
    const solid = opts.gpu !== false && this.solid(state, objects, st, us, tm, t, fc, { ours, mine, ourPlume });
    if (!solid && st) drawBody(ctx, st.e, us, tm, toS, sc, W, H);
    // (a thing off the plane shows to the side as the drone looks down at it: OBLIQUE_K)
    const toS3 = (mx, my, mz) => { const [x, y] = toS(mx, my); return [x + (solid ? OBLIQUE_K * mz * sc : 0), y]; };

    const hits = this._hits;
    hits.length = 0;
    const L = this.labels || (this.labels = new Labels());
    L.reset();
    const fm = frameMarks(state);
    const marks = opts.labels !== false;
    // Stations
    for (const o of objects) {
      if (o.e.type !== 'station') continue;
      const m = stationModel(o.e.id);
      const [sx, sy] = toS(o.dx, o.dy);
      const occ = new Set(Object.keys(o.e.berths || {}));
      drawStation(ctx, m, { x: sx, y: sy, angle: screenAngle(o.pose.angle), scale: sc, t, tint: factionColor(o.e.faction), occupied: occ, highlight: state.dock?.target.id === o.e.id ? state.dock.berth : null, labels: sc > 0.04, partsOff: solid });
      hits.push({ id: o.e.id, x: sx, y: sy });
      const mk = marksOf(fm, o.e.id);
      if (sc * m.sizeM < 2000) L.add(o.e.name, sx, sy, { off: 14, font: LABEL_FONT, color: factionColor(o.e.faction), alpha: 0.85, pri: 5 + markPri(mk), above: true, tags: labelTags(mk) });
      if (marks && mk.flag) drawFlagMark(ctx, sx, sy, 12, mk.flag, L);
    }
    // Other ships: in a berth (posed by the berth), or flying
    for (const o of objects) {
      const e = o.e, hull = o.hull, pose = o.pose;
      if (e.type !== 'ship' || !hull) continue;
      const [sx, sy] = toS3(pose.mx, pose.my, pose.mz);
      if (!solid) drawHull(ctx, hull, { x: sx, y: sy, facing: screenAngle(pose.facing), scale: sc, view: pose.view, tint: factionColor(e.faction), plume: e.thrust || 0, t, ports: true });
      // (kilometres out a hull is a few pixels: a mark in its colour, as ours has; hollow if it runs dark)
      const mk = marksOf(fm, e.id, isDark(e), e.tags?.wreck);
      if (hull.L * sc < 8) {
        ctx.fillStyle = factionColor(e.faction); ctx.strokeStyle = ctx.fillStyle;
        if (mk.dark || mk.wreck) ctx.strokeRect(sx - 2.5, sy - 2.5, 5, 5); else ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      }
      hits.push({ id: e.id, x: sx, y: sy });
      // (its name beside the hull, never on it or on another's: labels.js; until we know it, what it is to us)
      const [hx, hy] = hullBox(hull, screenAngle(pose.facing), sc, solid, solid && !!e.tags?.wreck);
      if (hull.L * sc > 6) L.block(sx - hx, sy - hy, sx + hx, sy + hy);
      if (marks) {
        const r = Math.max(hx, hy, 4);
        if (mk.mission && r < 60) drawMissionMark(ctx, sx, sy, r + 6);
        if (mk.flag) drawFlagMark(ctx, sx, sy, r + 3, mk.flag, L);
      }
      const name = isIdentified(state, e) ? e.name : null;
      if (hull.L * sc > 6 && marks) L.add(shortName(name || (mk.dark ? 'DARK' : mk.wreck ? 'WRECK' : 'unidentified')), sx, sy, { off: [hx + 6, hy + 7], font: LABEL_FONT,
        color: name ? factionColor(e.faction) : mk.dark ? MARK_COL.dark : MARK_COL.wreck, alpha: 0.85, pri: 3 - o.d / LOOK_M + markPri(mk), above: true, tags: labelTags(name ? mk : { mission: mk.mission }) });
    }

    // Docking overlays: the corridor and the two collars
    if (held) {
      const fr = collarFrame(state, d, tm);
      if (fr) {
        const bx = (fr.pos.x - us.x) * AU_M, by = (fr.pos.y - us.y) * AU_M;
        const [ax, ay] = toS(bx, by);
        const len = d.target.kind === 'ship' ? 300 : 1000;
        const [ex, ey] = toS(bx + fr.normal.x * len, by + fr.normal.y * len);
        ctx.strokeStyle = 'rgba(110,234,224,0.35)';
        ctx.setLineDash([4, 6]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.setLineDash([]);
        for (const mark of [10, 100, 500]) {
          if (mark > len) continue;
          const [mx, my] = toS(bx + fr.normal.x * mark, by + fr.normal.y * mark);
          ctx.fillStyle = 'rgba(110,234,224,0.6)';
          ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
          if (sc * mark > 30) { ctx.font = '9px "IBM Plex Mono", monospace'; ctx.fillText(`${mark} m`, mx + 5, my); }
        }
        ctx.strokeStyle = '#3EC7E6'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ax, ay, Math.max(4, 2 * sc), 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
    }

    // The station we are docking with, off the edge of the screen while we are framed far from it
    // (the final approach, the climb out): where it lies, and how far
    if (held && d.target.kind === 'station' && (d.phase === 'approach' || d.phase === 'outbound')) {
      const o = objects.find(x => x.e.id === d.target.id);
      if (o && o.d > FAR_FRAME_M) {
        const [sx, sy] = toS(o.dx, o.dy);
        if (sx < 0 || sx > W || sy < 0 || sy > H) edgeMarker(ctx, sx, sy, W, H, `${o.e.name} · ${fmtKm(o.d)}`, factionColor(o.e.faction));
      }
    }

    // Our hull
    const [ox, oy] = toS3(mine.mx, mine.my, mine.mz);
    const ourArt = { x: ox, y: oy, facing: screenAngle(mine.facing), scale: sc, view: mine.view, tint: '#5FD38D', plume: ourPlume, rcs: ourRcs, t, ports: d?.port || true };
    if (solid) drawHullMarks(ctx, ours, ourArt);
    else drawHull(ctx, ours, ourArt);
    if (ours.L * sc < 8) { ctx.fillStyle = '#5FD38D'; ctx.fillRect(ox - 2, oy - 2, 4, 4); }
    { const [hx, hy] = hullBox(ours, screenAngle(mine.facing), sc, solid); L.block(ox - hx, oy - hy, ox + hx, oy + hy); }

    // The names, placed last (the scale bar keeps its corner)
    L.block(0, H - 28, 220, H);
    L.draw(ctx, W, H);

    // Scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
    const want80 = 80 / sc;
    const bar = nice.find(n => n >= want80) || nice[nice.length - 1];
    ctx.strokeStyle = 'rgba(148,163,178,0.9)'; ctx.fillStyle = 'rgba(148,163,178,0.95)';
    ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + bar * sc, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + bar * sc, H - 20); ctx.lineTo(14 + bar * sc, H - 12); ctx.stroke();
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 18 + bar * sc, H - 12);
    if (!objects.length && !d) { ctx.fillStyle = 'rgba(122,142,162,0.6)'; ctx.fillText('Nothing within 12 km', 14, 20); }
  }
}


/**
 * Our place at tm (between the minute the sim has flown and the next):
 * holding station, at the hold's place off what we hold on (so the two
 * never drift apart on the screen); flying, flown on under the drive's
 * last thrust and the pull, as the sim flies everything else.
 */
const _op = { x: 0, y: 0 }, _ov = { vx: 0, vy: 0 };
export function ourPlace(state, tm, dtS) {
  const f = state.flight;
  if (f.hold) {
    const t = targetStateAt(state, f.hold, tm);
    const o = t && holdOffset(state, f.hold, tm);
    if (t) return { x: t.pos.x + o.x / AU_M, y: t.pos.y + o.y / AU_M };
  }
  _op.x = f.pos.x; _op.y = f.pos.y; _ov.vx = f.vel.vx; _ov.vy = f.vel.vy;
  if (dtS > 0) stepFree(_op, _ov, dtS, f.thrustG || 0, f.facing || 0, state.clock.minute);
  return { x: _op.x, y: _op.y };
}

/** An arrow at the screen's edge toward something off it (sx, sy: where it would be drawn), and a label. */
function edgeMarker(ctx, sx, sy, W, H, text, color) {
  const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy;
  const m = 18, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-9), (H / 2 - m) / Math.abs(dy || 1e-9));
  const x = cx + dx * k, y = cy + dy * k, a = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = color; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillStyle = color;
  const tw = ctx.measureText(text).width;
  const lx = Math.max(6, Math.min(W - tw - 6, x - tw / 2 - Math.cos(a) * (tw / 2 + 14)));
  const ly = Math.max(14, Math.min(H - 30, y - Math.sin(a) * 16 + 4));     // (clear of the scale bar)
  ctx.fillText(text, lx, ly);
}

const fmtKm = (m) => m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

const LABEL_FONT = '10px "IBM Plex Mono", monospace';
const shortName = (text) => text.length > 26 ? text.slice(0, 25) + '…' : text;

/** Half the screen box a hull fills, turned to `angle`: [across, up and down] in px (solid: its height shows to the side too). */
function hullBox(hull, angle, sc, solid = false, tumbling = false) {
  if (tumbling) { const r = Math.hypot(hull.L, hull.W) / 2 * sc; return [r, r]; }
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  return [((c * hull.L + s * hull.W) / 2 + (solid ? OBLIQUE_K * hull.H / 2 : 0)) * sc, (s * hull.L + c * hull.W) / 2 * sc];
}

/** A hull's model matrix from its pose: the rotation a collar gives it, or flying in the plane. */
function poseMatrix(p) {
  return p.R ? mat4.basis(p.R.X, p.R.Y, p.R.Z, [p.mx, p.my, p.mz || 0]) : hullMatrix(p.mx, p.my, p.facing, p.view, p.mz || 0);
}

/**
 * Light besides the Sun's: near a port its floodlights, strong when the port
 * is on its rock's night side (shining down off the towers, out of the plane
 * toward the drone); far from one only the faint glow of the sky.
 */
function fillLight(st, rock, sun) {
  if (!st) return { dir: [0.3, -0.2, 1], col: [0.02, 0.021, 0.025] };
  const up = rock ? rock.n : [0, 1, 0];
  const day = rock ? Math.max(0, Math.min(1, (up[0] * sun[0] + up[1] * sun[1]) * 3 + 0.4)) : 1;
  const k = 0.15 + 1.3 * (1 - day);
  return { dir: [up[0] * 0.5 - 0.2, up[1] * 0.5 + 0.1, 1], col: [k * 0.95, k * 0.98, k * 1.04] };
}

/** The ground's albedo (linear) on the rocks ports stand on: Ceres and Phobos dark, Vesta bright. */
const ROCK_ALBEDO = { Ceres: [0.1, 0.095, 0.09], Pallas: [0.15, 0.155, 0.16], Vesta: [0.32, 0.29, 0.26], Phobos: [0.075, 0.066, 0.06] };

/** The rock under a surface port as the GPU draws it (ships3d.js): its surface under the station, its radius. */
function rockOf(st, us, tm) {
  const b = getBody(st.e.orbit?.body);
  if (!b || st.e.orbit.r * AU_M > b.radius * 1000 * 1.05) return null;
  const c = bodyPos(b, tm / DAY_MIN);
  const cx = (c.x - us.x) * AU_M, cy = (c.y - us.y) * AU_M, R = b.radius * 1000;
  const dx = st.dx - cx, dy = st.dy - cy, l = Math.hypot(dx, dy) || 1;
  const n = [dx / l, dy / l, 0];
  let seed = 0;
  for (const ch of b.name) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  return { S: [cx + n[0] * R, cy + n[1] * R, 0], n, along: [-n[1], n[0], 0], R, albedo: ROCK_ALBEDO[b.name] || [0.12, 0.115, 0.11], seed };
}

/**
 * The body a surface port stands on, drawn at its true radius: from a
 * kilometre up, Ceres is a horizon, not a ball. Only the arc across the
 * screen is drawn (a polygon), so the numbers stay sane.
 */
function drawBody(ctx, st, us, tm, toS, sc, W, H) {
  if (st.orbit?.r * AU_M > (getBody(st.orbit.body)?.radius || 0) * 1000 * 1.05) return;   // an orbital station: no ground close by
  const b = getBody(st.orbit.body);
  if (!b) return;
  const c = bodyPos(b, tm / DAY_MIN);
  const cx = (c.x - us.x) * AU_M, cy = (c.y - us.y) * AU_M;
  const R = b.radius * 1000;
  // the arc of the surface nearest us, ± what the screen spans
  const toUs = Math.atan2(-cy, -cx);
  const spanM = Math.max(W, H) / sc * 1.5;
  const half = Math.min(Math.PI, spanM / R);
  const pts = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const a = toUs - half + 2 * half * i / N;
    pts.push(toS(cx + R * Math.cos(a), cy + R * Math.sin(a)));
  }
  // close the shape deep below the surface
  const deep = Math.max(0.2 * R, R - spanM);          // (a small rock wider than the screen: the whole disc)
  pts.push(toS(cx + deep * Math.cos(toUs + half), cy + deep * Math.sin(toUs + half)));
  pts.push(toS(cx + deep * Math.cos(toUs - half), cy + deep * Math.sin(toUs - half)));
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#2A2723');
  grad.addColorStop(1, '#141210');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,150,130,0.4)';
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const p = pts[i]; if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
  ctx.stroke();
}

