// ============================================================
// LONGHAUL — The exterior view: what is outside, at true scale
//
// Close to other things (docking, alongside another ship, and in time a
// world's atmosphere) the ship's surroundings are drawn as they are, in
// metres: the rock a port is built on, the station's structure and its
// berths with the ships lying in them, other hulls nearby, and our own
// hull, posed as the sim has it (mated at a collar, or flying). The
// camera frames what matters and follows it smoothly; near a station
// the view is turned so the station's up is up (the ground below).
//
// Overlays for docking: the corridor down the berth's axis with its
// marks, the berth's collar, ours. The renderer reads sim state and
// never changes it; a click picks a hull (onSelect), as on the tactical
// display.
//
// The sim moves in whole minutes; the view doesn't. Everything is drawn
// at the moment between minutes the frame stands for (`alpha`): rails
// things (stations, berths, berthed hulls, the rock) exactly, from their
// orbits; things in free flight carried on their velocity. Near a
// station the view's rotation is locked to the station's own, so the
// ground doesn't swing.
// ============================================================

import { AU_M, DAY_MIN } from '../core/constants.js';
import { getWorld, orbitStateAt } from '../sim/world.js';
import { getBody, bodyPos } from '../sim/ephemeris.js';
import { hullOf } from '../sim/hulls.js';
import { stationModel, berthOf, stationAngle, berthFrame } from '../sim/stations.js';
import { matePose } from '../sim/mating.js';
import { collarFrame, dockPose, facingOf } from '../sim/docking.js';
import { liveKnowledge } from '../sim/intel.js';
import { factionColor } from '../sim/factions.js';
import { PLAYER_CLASS } from '../sim/ship-classes.js';
import { FitCanvas } from './dom.js';
import { drawHull, drawStation } from './hull-art.js';

const _q = [];
const IN_FRAME_PHASES = new Set(['approach', 'prox', 'separate', 'outbound']);
const LOOK_M = 12_000;           // objects this close are candidates for the view

export class ExteriorView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'exterior-canvas' });
    this.cam = { x: 0, y: 0, scale: 0.2, rot: 0, ready: false };
    this.t0 = performance.now();
    this._hits = [];
    this.stars = Array.from({ length: 140 }, (_, i) => ({ x: (i * 7919 % 1000) / 1000, y: (i * 104729 % 1000) / 1000, b: 0.2 + (i * 31 % 10) / 14 }));
    if (onSelect) {
      container.addEventListener('pointerdown', (e) => onSelect(this.hit(container, e)));
      container.addEventListener('pointermove', (e) => { container.style.cursor = this.hit(container, e) ? 'pointer' : 'default'; });
    }
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
        if (d.phase === 'docked' || d.phase === 'capture' || d.phase === 'seal') span = Math.max(ourL * 5, 260);
        rot = Math.atan2(fr.normal.y, fr.normal.x) - Math.PI / 2;
      }
    } else if (objects.length) {
      const n = objects.reduce((a, b) => (a.d < b.d ? a : b));
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
    const ax = f.$ax || 0, ay = f.$ay || 0;
    const us = ourPose ? ourPose.pos : { x: f.pos.x + (f.vel.vx * dtS + 0.5 * ax * dtS * dtS) / AU_M, y: f.pos.y + (f.vel.vy * dtS + 0.5 * ay * dtS * dtS) / AU_M };
    const _p = { x: 0, y: 0 }, _v = { vx: 0, vy: 0 };
    /** Where an entity is at tm: exact on rails, carried on its velocity otherwise. */
    const at = (e) => {
      if (e.orbit) { orbitStateAt(e.orbit, tm, _p, _v); return { x: _p.x, y: _p.y }; }
      const k = (tm - state.clock.minute) * 60 / AU_M;
      return { x: e.pos.x + e.vel.vx * k, y: e.pos.y + e.vel.vy * k };
    };

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
    this.smooth(objects, tm, us);
    const want = this.frame(state, objects, tm, us);
    const cam = this.cam;
    const scaleWant = Math.min(W, H) / want.span;
    if (!cam.ready || opts.snap) { Object.assign(cam, { x: want.cx, y: want.cy, scale: scaleWant, rot: want.rot, ready: true }); }
    else {
      const k = 0.12;
      cam.x += (want.cx - cam.x) * k; cam.y += (want.cy - cam.y) * k;
      cam.scale *= Math.pow(scaleWant / cam.scale, k);
      // near a station the rotation is the station's own, exactly: easing it would make the ground swing
      if (objects.some(o => o.e.type === 'station')) cam.rot = want.rot;
      else { let dr = want.rot - cam.rot; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); cam.rot += dr * k; }
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

    // A rock under a surface port
    const st = objects.find(o => o.e.type === 'station');
    if (st) drawBody(ctx, st.e, us, tm, toS, sc, W, H);

    const hits = this._hits;
    hits.length = 0;
    // Stations
    for (const o of objects) {
      if (o.e.type !== 'station') continue;
      const m = stationModel(o.e.id);
      const [sx, sy] = toS(o.dx, o.dy);
      const occ = new Set(Object.keys(o.e.berths || {}));
      drawStation(ctx, m, { x: sx, y: sy, angle: screenAngle(stationAngle(o.e.orbit, tm)), scale: sc, t, tint: factionColor(o.e.faction), occupied: occ, highlight: state.dock?.target.id === o.e.id ? state.dock.berth : null, labels: sc > 0.04 });
      hits.push({ id: o.e.id, x: sx, y: sy });
      if (sc * m.sizeM < 2000) label(ctx, o.e.name, sx, sy + 14, factionColor(o.e.faction));
    }
    // Other ships: in a berth (posed by the berth), or flying
    for (const o of objects) {
      const e = o.e;
      if (e.type !== 'ship') continue;
      const hull = hullOf(e.cls);
      if (!hull) continue;
      let pose = null;
      if (e.tags?.berth && e.tags.at) {
        const host = world.get(e.tags.at);
        const b = host && berthOf(host.id, e.tags.berth);
        const port = b && hull.ports.find(p => b.accepts.includes(p.size));
        if (b && port) {
          const fr = berthFrame(state, host, b, tm);
          const mp = matePose(fr, port);
          pose = { mx: (mp.center.x - us.x) * AU_M, my: (mp.center.y - us.y) * AU_M, facing: mp.facing, view: mp.view };
        }
      }
      if (!pose) pose = { mx: o.dx, my: o.dy, facing: facingOf(e), view: 'top' };
      const [sx, sy] = toS(pose.mx, pose.my);
      drawHull(ctx, hull, { x: sx, y: sy, facing: screenAngle(pose.facing), scale: sc, view: pose.view, tint: factionColor(e.faction), plume: e.thrust || 0, t, ports: true });
      hits.push({ id: e.id, x: sx, y: sy });
      if (hull.L * sc > 6 && opts.labels !== false) label(ctx, e.transponder ? e.name : 'unidentified', sx, sy - Math.max(10, hull.W * sc), factionColor(e.faction));
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
          if (sc * mark > 30) { ctx.font = '9px "Share Tech Mono", monospace'; ctx.fillText(`${mark} m`, mx + 5, my); }
        }
        ctx.strokeStyle = '#6EEAE0'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ax, ay, Math.max(4, 2 * sc), 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
    }

    // Our hull
    const ours = hullOf(state.ship.classId || PLAYER_CLASS);
    const mine = ourPose ? { mx: 0, my: 0, facing: ourPose.facing, view: ourPose.view } : { mx: 0, my: 0, facing: f.facing, view: 'top' };
    const [ox, oy] = toS(mine.mx, mine.my);
    drawHull(ctx, ours, { x: ox, y: oy, facing: screenAngle(mine.facing), scale: sc, view: mine.view, tint: '#4FD1C5', plume: f.thrustG, rcs: Math.min(1, (state.$dockRcs || 0) * 30 + (Math.abs(f.turning) > 0.01 ? 0.5 : 0)), t, ports: d?.port || true });
    if (ours.L * sc < 8) { ctx.fillStyle = '#4FD1C5'; ctx.fillRect(ox - 2, oy - 2, 4, 4); }

    // Scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const want80 = 80 / sc;
    const bar = nice.find(n => n >= want80) || nice[nice.length - 1];
    ctx.strokeStyle = 'rgba(79,209,197,0.7)'; ctx.fillStyle = 'rgba(79,209,197,0.8)';
    ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + bar * sc, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + bar * sc, H - 20); ctx.lineTo(14 + bar * sc, H - 12); ctx.stroke();
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 18 + bar * sc, H - 12);
    if (!objects.length && !d) { ctx.fillStyle = 'rgba(122,142,162,0.6)'; ctx.fillText('Nothing within 12 km', 14, 20); }
  }
}


function label(ctx, text, x, y, color) {
  ctx.font = '10px "Share Tech Mono", monospace';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.textAlign = 'center';
  ctx.fillText(text.length > 26 ? text.slice(0, 25) + '…' : text, x, y);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
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
  const deep = R - spanM;
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

