// ============================================================
// LONGHAUL — A world's space on the map
//
// When a world is picked on the SOLAR display (or we are inside its
// planetary space), the map draws what it holds round it, light and thin,
// at true scale (sim/worlds.js):
//
//   under the bodies   its pull as a faint wash, densest at the ground,
//                      gone at the edge of planetary space (0.01 G, the
//                      edge a fine solid ring), with contours at 0.03, 0.1,
//                      0.3 and 1 G; the Hill sphere a faint dashed ring far
//                      out; the high parking orbit (green: a route goes
//                      there), the stationary orbit (amber), the low orbit
//                      band (violet: ground control's), and the air, a glow
//                      in its colour from the ground to the entry interface
//   over the bodies    the airspaces round its equator: their boundaries as
//                      short ticks at the limb in their authority's colour,
//                      their names round it, the spaceports as points on it,
//                      turning with the world
//
// Each piece is drawn only when it is a few pixels or more across, so the
// system view stays clean and the rings come in as the map closes on the
// world (FOCUS frames its planetary space).
//
// Our shuttles out over the world (sim/shuttles.js) draw their way ahead
// over it (drawShuttleTracks): the rest of the run sampled off its flight
// path, in the world's frame (it moves tens of km a second round the Sun,
// and the track goes with it), its burns dashed, its coasts dotted (the
// drive cold, on a conic, or round a low orbit), the air's stretch solid,
// the pad a ring.
// ============================================================

import { AU_M } from '../core/constants.js';
import { pullAtM, airspacesOf, worldAngle } from '../sim/worlds.js';
import { factionColor } from '../sim/factions.js';
import { bodyPos } from '../sim/ephemeris.js';
import { flightPathAt } from '../sim/planetary.js';
import { activeRuns } from '../sim/shuttles.js';
import { getWorld } from '../sim/world.js';
import { DAY_MIN } from '../core/constants.js';

const WELL = '120,196,255';
const G_RINGS = [0.03, 0.1, 0.3, 1];
const AIR_TINT = { Venus: '232,205,144', Earth: '111,183,255', Mars: '217,138,106', Titan: '217,165,74', Jupiter: '214,190,150', Saturn: '232,213,163', Uranus: '126,200,217', Neptune: '75,110,175' };
const FONT = '500 10px "IBM Plex Sans", sans-serif';
const kmW = (m) => `${Math.round(m / 1000).toLocaleString()} km`;

/**
 * Draw world `w`'s space centred on screen (x, y), `pxM` px per metre.
 * pass: 'under' (before the bodies are drawn) | 'over' (after). L: the map's
 * labels (names placed clear of the rest).
 */
export function drawWorldZones(ctx, w, x, y, pxM, W, H, L, minute, pass) {
  const R = w.R * pxM, edge = w.wellM * pxM;
  if (edge < 6) return;
  const ring = (rM, style, dash = null, width = 1) => {
    const r = rM * pxM;
    if (r < 3 || r > 2e6) return false;
    ctx.save();
    ctx.strokeStyle = style; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return true;
  };
  const label = (text, rM, color, pri = 2, ang = Math.PI / 2) => {
    const r = rM * pxM;
    if (r < 12 || r > 4 * Math.max(W, H)) return;
    // (on the ring at `ang`, kept on the screen)
    const lx = x + r * Math.cos(ang), ly = y - r * Math.sin(ang);
    if (lx < -40 || lx > W + 40 || ly < -10 || ly > H + 10) return;
    L.add(text, lx, ly, { off: 4, font: FONT, color, alpha: 0.85, pri, above: true });
  };

  if (pass === 'under') {
    // ---- the pull: a wash from the ground out to the edge, faint, densest where it is strongest
    if (edge > 14 && edge < 6e4) {
      const g0 = pullAtM(w, w.R), gE = pullAtM(w, w.wellM);
      const span = Math.log(g0 / gE);
      const grd = ctx.createRadialGradient(x, y, Math.max(0, R), x, y, edge);
      for (const k of [0, 0.12, 0.3, 0.55, 0.8, 1]) {
        const rM = w.R + (w.wellM - w.R) * k;
        const a = 0.17 * Math.log(pullAtM(w, rM) / gE) / span;
        grd.addColorStop(k, `rgba(${WELL},${Math.max(0, a).toFixed(3)})`);
      }
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(x, y, edge, 0, Math.PI * 2); ctx.fill();
    }
    // ---- contours of the pull, and the edge
    for (const gG of G_RINGS) {
      const rM = Math.sqrt(w.GM / (gG * 9.80665));
      if (rM <= w.R * 1.02 || rM >= w.wellM) continue;
      if (ring(rM, `rgba(${WELL},0.22)`, [1, 3], 0.75)) label(`${gG} G`, rM, `rgba(${WELL},0.6)`, 1, 0.35);
    }
    if (ring(w.wellM, `rgba(${WELL},0.55)`, null, 1)) label(`PLANETARY SPACE · 0.01 G · ${kmW(w.wellM)}`, w.wellM, `rgba(${WELL},0.9)`, 4);
    if (ring(w.hillM, 'rgba(180,190,200,0.16)', [6, 8], 0.75)) label(`HILL SPHERE · ${kmW(w.hillM)}`, w.hillM, 'rgba(180,190,200,0.55)', 1, Math.PI * 0.62);
    // ---- the orbits: the high parking orbit, the stationary orbit, the low band
    if (ring(w.parkM, 'rgba(95,211,141,0.6)', [5, 4], 1)) label(`HIGH ORBIT · ${kmW(w.parkM)}`, w.parkM, 'rgba(95,211,141,0.9)', 3, -Math.PI / 2);
    if (w.sync && ring(w.sync, 'rgba(232,196,90,0.6)', [3, 4], 1)) label(`STATIONARY · ${kmW(w.sync)}`, w.sync, 'rgba(232,196,90,0.9)', 3, Math.PI * 0.8);
    const l0 = w.low[0] * pxM, l1 = w.low[1] * pxM;
    if (l1 > R + 2 && l1 < 2e6) {
      ctx.fillStyle = 'rgba(176,132,255,0.08)';
      ctx.beginPath(); ctx.arc(x, y, l1, 0, Math.PI * 2); ctx.arc(x, y, Math.max(0, l0), 0, Math.PI * 2, true); ctx.fill('evenodd');
      if (l1 - R > 10) label('LOW ORBIT · ground control', (w.low[0] + w.low[1]) / 2, 'rgba(176,132,255,0.85)', 2, Math.PI * 0.15);
    }
    // ---- the air, from the ground to the entry interface
    if (w.atmo && R > 3) {
      const top = (w.R + w.atmo.interfaceM) * pxM;
      const tint = AIR_TINT[w.name] || '200,200,220';
      const grd = ctx.createRadialGradient(x, y, R, x, y, Math.max(R + 1.5, top));
      grd.addColorStop(0, `rgba(${tint},0.55)`); grd.addColorStop(0.35, `rgba(${tint},0.18)`); grd.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = grd;
      // (a ring from the ground up: the disc itself is the body's, drawn dark to be written over)
      ctx.beginPath(); ctx.arc(x, y, Math.max(R + 1.5, top), 0, Math.PI * 2); ctx.arc(x, y, Math.max(0, R - 1), 0, Math.PI * 2, true); ctx.fill('evenodd');
      if (top - R > 8) label(`ATMOSPHERE · ${Math.round(w.atmo.interfaceM / 1000)} km`, w.R + w.atmo.interfaceM, `rgba(${tint},0.9)`, 2, Math.PI * 0.25);
    }
    return;
  }

  // ---- over: the airspaces at the limb, turning with the world
  const air = airspacesOf(w);
  if (!air.length || R < 18) return;
  ctx.save();
  for (const a of air) {
    const th = worldAngle(w, a.a0, minute);
    const col = a.authority ? factionColor(a.authority) : '#8A8A8A';
    const c = Math.cos(th), s = Math.sin(th);
    ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + c * R * 0.97, y - s * R * 0.97); ctx.lineTo(x + c * R * 1.07, y - s * R * 1.07); ctx.stroke();
    // its spaceport, a point on the ground
    const tp = worldAngle(w, a.port.ang, minute);
    ctx.fillStyle = col; ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.arc(x + Math.cos(tp) * R, y - Math.sin(tp) * R, 2, 0, Math.PI * 2); ctx.fill();
    // its name round the limb, at its middle
    if (R > 40) {
      const tm = worldAngle(w, (a.a0 + a.a1) / 2, minute);
      const lx = x + Math.cos(tm) * R * 1.14, ly = y - Math.sin(tm) * R * 1.14;
      // (written outward from the limb, off the disc)
      const cs = Math.cos(tm), sn = Math.sin(tm);
      const side = cs > 0.38 ? 'right' : cs < -0.38 ? 'left' : sn > 0 ? 'up' : 'down';
      if (lx > -30 && lx < W + 30 && ly > -10 && ly < H + 10) L.add(a.name.toUpperCase(), lx, ly, { off: 2, font: FONT, color: col, alpha: 0.9, pri: 2, side });
    }
  }
  ctx.restore();
}

const TRACK = '255,255,255';   // (white: no ring of a world's space is)
const TRACK_STEP_MIN = 1.5;      // the track sampled this often (min): the entry turns fast
const TRACK_MAX = 900;

/**
 * Our shuttles' way ahead round world `w` (centred on screen at x, y, `pxM`
 * px per metre): each run from now to its recovery, the points placed at
 * their minute relative to the world's centre then.
 */
export function drawShuttleTracks(ctx, state, w, x, y, pxM) {
  const runs = activeRuns(state).filter(r => r.world === w.name);
  if (!runs.length || w.wellM * pxM < 20) return;
  const world = getWorld(state), now = state.clock.minute;
  ctx.save();
  for (const run of runs) {
    const path = { world: run.world, cls: run.cls, carrier: run.carrier, legs: run.legs };
    const end = run.legs.at(-1).t0, step = Math.max(TRACK_STEP_MIN, (end - now) / TRACK_MAX);
    let kind = null;
    ctx.beginPath();
    for (let m = now; m <= end + 1e-6; m += step) {
      const p = flightPathAt(world, path, Math.min(m, end));
      const c = bodyPos(w.body, Math.min(m, end) / DAY_MIN);
      const sx = x + (p.pos.x - c.x) * AU_M * pxM, sy = y - (p.pos.y - c.y) * AU_M * pxM;
      const k = p.leg === 'down' || p.leg === 'up' ? 'air' : p.leg === 'ground' ? 'ground' : p.g > 0.01 ? 'drive' : 'coast';
      if (k !== kind) {
        if (kind) { ctx.lineTo(sx, sy); ctx.stroke(); }
        ctx.beginPath();
        ctx.setLineDash(k === 'drive' ? [5, 4] : k === 'coast' ? [1.5, 4] : []);
        ctx.strokeStyle = `rgba(${TRACK},${k === 'air' ? 0.95 : k === 'coast' ? 0.45 : 0.6})`; ctx.lineWidth = k === 'air' ? 1.8 : 1.2;
        ctx.moveTo(sx, sy);
        kind = k;
        if (k === 'ground') { ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = `rgba(${TRACK},0.95)`; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); ctx.beginPath(); ctx.moveTo(sx, sy); }
      } else ctx.lineTo(sx, sy);
    }
    if (kind) ctx.stroke();
  }
  ctx.restore();
}
