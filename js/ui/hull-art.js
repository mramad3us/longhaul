// ============================================================
// LONGHAUL — Drawing hulls and stations (canvas)
//
// Every hull and station is drawn from its physical model (sim/hulls.js,
// sim/stations.js) at true proportions, at any scale: from a few pixels
// on the tactical display to the ship picker's and the library's
// portraits. The drone's view and the telescope render the same models
// as lit solids on the GPU (gl/ships3d.js) and draw them flat from here
// only without WebGL2; over their solids, the marks that are the
// display's own come from here (drawHullMarks, drawStation's berths). A hull is seen
// from above (its back), from below (mirrored), or along a flank (its
// side), as the pose it is in shows it (sim/mating.js).
//
// Parts are filled by role in hard, unpainted tones (bare alloy, ceramic,
// radiator black, ice) with a faction's colour on the edges, drawn deepest
// first. Close in, the larger parts get panel seams and lit ports; the
// collars are marked, and the one we dock by can be picked out. A ship
// blown apart has its portrait in pieces: its parts flung out from its
// middle and turned, dimmed.
// ============================================================

const ROLE = {
  hab: ['#2E4256', '#4A6A86'], command: ['#35526C', '#5C86A8'], cargo: ['#3B4047', '#5E666F'], hold: ['#3B4047', '#5E666F'],
  container: ['#4A3E33', '#6E5C4A'], tank: ['#474D55', '#6C747E'], truss: ['#5B636E', '#7C8591'], drive: ['#2C2F33', '#4A4F55'],
  reactor: ['#45363A', '#6A5258'], machinery: ['#3A4350', '#5B6878'], radiator: ['#1A2430', '#2E4050'], armor: ['#434B54', '#646E79'],
  pdc: ['#7A8088', '#A2A8B0'], tube: ['#353D46', '#56606B'], rail: ['#4F5660', '#737B86'], sensor: ['#4E5D6C', '#75889B'],
  shield: ['#161616', '#2C2C2C'], leg: ['#6E6E6E', '#959595'], gear: ['#7A6C48', '#A08F62'], ice: ['#9FC2D6', '#D2E8F4'],
  dock: ['#59636E', '#7F8A96'], 'ground-works': ['#3A342D', '#55493E'], yard: ['#2B323B', '#4C5864'], 'tank-block': ['#474D55', '#6C747E'],
};
const CONTAINER_TONES = ['#4A3E33', '#33424F', '#4F4A3A', '#3E4A3C', '#53403C'];

/** Ship-frame point → screen, for a pose: (x along the axis, lateral) with facing and view. */
function projector(cx, cy, facing, scale, view) {
  const c = Math.cos(facing), s = Math.sin(facing);
  const flip = view === 'top-flip' || view === 'side-flip' ? -1 : 1;
  // screen y grows downward; world y up
  return (x, l) => {
    const ly = l * flip;
    const wx = x * c - ly * s, wy = x * s + ly * c;
    return [cx + wx * scale, cy - wy * scale];
  };
}

/** The extent of a part in the plane the view shows: [x0, x1, l0, l1, d0, d1] (l: lateral, d: depth). */
function planeOf(p, side) {
  if (p.k === 'box') return side ? [p.x0, p.x1, p.z0, p.z1, p.y0, p.y1] : [p.x0, p.x1, p.y0, p.y1, p.z0, p.z1];
  if (p.k === 'cyl') { const l = side ? p.z : p.y, d = side ? p.y : p.z; return [p.x0, p.x1, l - p.r, l + p.r, d - p.r, d + p.r]; }
  if (p.k === 'bell') { const r = Math.max(p.r0, p.r1); return [p.x0, p.x1, -r, r, -r, r]; }
  if (p.k === 'ring') { const R = p.r + p.d; return [p.x - p.w / 2, p.x + p.w / 2, -R, R, -R, R]; }
  return [0, 0, 0, 0, 0, 0];
}

/**
 * Draw a hull. o: { x, y (px centre), facing (rad, solar frame), scale (px/m),
 * view ('top' | 'top-flip' | 'side' | 'side-flip'), tint (edge colour),
 * detail (0 silhouette · 1 parts · 2 seams and lights), plume (G), rcs (0–1),
 * t (s, for flicker), ports: true | port id to highlight, alpha }
 */
export function drawHull(ctx, hull, o) {
  if (!hull) return;
  const side = o.view === 'side' || o.view === 'side-flip';
  const P = projector(o.x, o.y, o.facing || 0, o.scale, o.view || 'top');
  const detail = o.detail ?? (hull.L * o.scale > 120 ? 2 : hull.L * o.scale > 18 ? 1 : 0);
  const alpha = o.alpha ?? 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (detail === 0) {
    // a few pixels: the outline only
    ctx.fillStyle = o.tint || '#7EC8E3';
    const b = hull.bounds;
    poly(ctx, [P(b.x1, 0), P(b.x0, side ? b.z0 : b.y0), P(b.x0, side ? b.z1 : b.y1)]);
    ctx.fill();
    ctx.restore();
    return;
  }
  const parts = hull.parts.map((p, i) => ({ p, i, e: planeOf(p, side) })).sort((a, b) => a.e[5] - b.e[5] || a.i - b.i);
  if (o.plume > 0.01) drawPlume(ctx, hull, P, o);
  let ci = 0;
  for (const { p, e } of parts) {
    const [fill, edge] = ROLE[p.role] || ROLE.hab;
    const tone = p.role === 'container' ? CONTAINER_TONES[ci++ % CONTAINER_TONES.length] : fill;
    ctx.lineWidth = Math.max(0.6, Math.min(2, o.scale * 0.15));
    if (p.k === 'bell') {
      ctx.fillStyle = '#23262A';
      poly(ctx, [P(p.x1, -p.r1), P(p.x1, p.r1), P(p.x0, p.r0), P(p.x0, -p.r0)]);
      ctx.fill();
      ctx.strokeStyle = o.plume > 0.01 ? '#E8D9B8' : '#55595F';
      ctx.stroke();
      continue;
    }
    if (p.k === 'ring' && p.plane === 'xy' && !side) {
      // a spin ring seen face on
      ctx.fillStyle = tone; ctx.strokeStyle = edge;
      const n = p.n || 16;
      for (let k = 0; k < n; k++) {
        const a0 = (k + 0.08) / n * Math.PI * 2 + (o.t || 0) * 0.02, a1 = (k + 0.92) / n * Math.PI * 2 + (o.t || 0) * 0.02;
        const r0 = p.r, r1 = p.r + p.d;
        poly(ctx, [P(p.x + r0 * Math.cos(a0), r0 * Math.sin(a0)), P(p.x + r1 * Math.cos(a0), r1 * Math.sin(a0)), P(p.x + r1 * Math.cos(a1), r1 * Math.sin(a1)), P(p.x + r0 * Math.cos(a1), r0 * Math.sin(a1))]);
        ctx.fill(); ctx.stroke();
      }
      continue;
    }
    const [x0, x1, l0, l1] = e;
    const pts = [P(x0, l0), P(x1, l0), P(x1, l1), P(x0, l1)];
    ctx.fillStyle = tone;
    poly(ctx, pts);
    ctx.fill();
    if (p.role !== 'truss' || detail === 2) {
      ctx.strokeStyle = p.role === 'command' || p.role === 'hab' ? (o.tint || edge) : edge;
      ctx.globalAlpha = alpha * (p.role === 'command' || p.role === 'hab' ? 0.9 : 0.6);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    if (detail === 2) seams(ctx, P, p, e, o);
    if (p.role === 'radiator' && o.plume > 0.3) {
      ctx.fillStyle = `rgba(255,110,60,${Math.min(0.35, o.plume * 0.04)})`;
      poly(ctx, pts); ctx.fill();
    }
  }
  if (detail >= 1 && o.ports) {
    for (const pt of hull.ports) {
      const l = side ? pt.z : pt.y;
      if (!side && pt.face[0] === 'z') continue;
      if (side && pt.face[0] === 'y') continue;
      const [sx, sy] = P(pt.x, l);
      const r = Math.max(2, (pt.size === 'L' ? 3 : pt.size === 'M' ? 1.1 : 0.5) * o.scale);
      const hi = o.ports === pt.id;
      ctx.strokeStyle = hi ? '#6EEAE0' : 'rgba(226,163,85,0.8)';
      ctx.lineWidth = hi ? 2 : 1;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (o.rcs > 0) drawRcsPuffs(ctx, hull, P, o);
  if (detail === 2 && o.lights !== false) navLights(ctx, hull, P, side, o.t || 0);
  ctx.restore();
}

/**
 * Over a hull the GPU drew (exterior.js): only what is the display's, not
 * the hull's: the collar we dock by, picked out, and the RCS puffs.
 */
export function drawHullMarks(ctx, hull, o) {
  if (!hull) return;
  const side = o.view === 'side' || o.view === 'side-flip';
  const P = projector(o.x, o.y, o.facing || 0, o.scale, o.view || 'top');
  ctx.save();
  if (typeof o.ports === 'string' && hull.L * o.scale > 18) {
    const pt = hull.ports.find(p => p.id === o.ports);
    if (pt && !(side ? pt.face[0] === 'y' : pt.face[0] === 'z')) {
      const [sx, sy] = P(pt.x, side ? pt.z : pt.y);
      const r = Math.max(3, (pt.size === 'L' ? 3 : pt.size === 'M' ? 1.1 : 0.5) * o.scale * 1.3);
      ctx.strokeStyle = '#6EEAE0'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (o.rcs > 0) drawRcsPuffs(ctx, hull, P, o);
  ctx.restore();
}

function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Panel seams and lit ports on the larger parts, close in. */
function seams(ctx, P, p, e, o) {
  const [x0, x1, l0, l1] = e;
  const len = x1 - x0;
  const step = len > 80 ? len / Math.round(len / 25) : len > 20 ? len / 4 : 0;
  if (!step || (len * o.scale) < 40) return;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = x0 + step; x < x1 - 1e-6; x += step) { const a = P(x, l0), b = P(x, l1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  ctx.stroke();
  if (p.role === 'hab' || p.role === 'command') {
    ctx.fillStyle = 'rgba(255,214,140,0.55)';
    const n = Math.min(12, Math.floor(len / 4));
    for (let k = 0; k < n; k++) {
      const [sx, sy] = P(x0 + (k + 0.5) * len / n, l1 - (l1 - l0) * 0.12);
      ctx.fillRect(sx - 0.8, sy - 0.8, 1.6, 1.6);
    }
  }
}

/** Red to port, green to starboard, a white strobe at the stern. */
function navLights(ctx, hull, P, side, t) {
  const b = hull.bounds;
  const blink = Math.sin(t * 3) > 0.6;
  const dot = (x, l, c, r = 1.6) => { const [sx, sy] = P(x, l); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); };
  if (!side) { dot(b.x1 * 0.7, b.y0, '#E25555'); dot(b.x1 * 0.7, b.y1, '#6BCB77'); }
  if (blink) dot(b.x0 + 1, 0, '#FFFFFF', 2.2);
}

function drawPlume(ctx, hull, P, o) {
  const bell = hull.parts.find(p => p.k === 'bell');
  const x0 = bell ? bell.x0 : hull.bounds.x0, r = bell ? bell.r0 : hull.W * 0.15;
  const g = o.plume;
  const len = hull.L * Math.min(40, 3 + Math.sqrt(g) * 8);
  const flick = 0.85 + 0.15 * Math.sin((o.t || 0) * 40);
  const [ax, ay] = P(x0, 0), [bx, by] = P(x0 - len, 0);
  const grad = ctx.createLinearGradient(ax, ay, bx, by);
  grad.addColorStop(0, `rgba(255,255,255,${0.95 * flick})`);
  grad.addColorStop(0.06, 'rgba(210,225,255,0.75)');
  grad.addColorStop(0.3, 'rgba(120,170,255,0.3)');
  grad.addColorStop(1, 'rgba(60,110,230,0)');
  ctx.fillStyle = grad;
  const w = r * (1 + Math.min(2, g * 0.3));
  poly(ctx, [P(x0, -r * 0.7), P(x0, r * 0.7), P(x0 - len * 0.2, w * 1.6), P(x0 - len, w * 0.4), P(x0 - len, -w * 0.4), P(x0 - len * 0.2, -w * 1.6)]);
  ctx.fill();
}

function drawRcsPuffs(ctx, hull, P, o) {
  const b = hull.bounds;
  ctx.fillStyle = `rgba(255,236,190,${0.35 + 0.4 * Math.abs(Math.sin((o.t || 0) * 27))})`;
  const quads = [[b.x1 * 0.8, b.y0], [b.x1 * 0.8, b.y1], [b.x0 * 0.8, b.y0], [b.x0 * 0.8, b.y1]];
  for (const [x, l] of quads) {
    const [sx, sy] = P(x, l);
    const r = Math.max(1.5, Math.min(6, hull.W * 0.05 * o.scale)) * (0.6 + o.rcs);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
  }
}

// ---- STATIONS ----

/**
 * Draw a station's model. o: { x, y (px of the station's centre), angle (rad:
 * the station frame's x axis, solar frame), scale (px/m), t, tint,
 * occupied: Set of berth ids, highlight: berth id, labels, partsOff (the GPU drew the
 * structure: only the berths' lamps) }
 */
export function drawStation(ctx, model, o) {
  if (!model) return;
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const P = (x, y) => { const wx = x * c - y * s, wy = x * s + y * c; return [o.x + wx * o.scale, o.y - wy * o.scale]; };
  ctx.save();
  const parts = o.partsOff ? [] : model.parts.map((p, i) => ({ p, i })).sort((a, b) => ((a.p.z0 ?? 0) - (b.p.z0 ?? 0)) || a.i - b.i);
  for (const { p } of parts) {
    const [fill, edge] = ROLE[p.role] || ROLE.hab;
    ctx.lineWidth = Math.max(0.6, Math.min(2.5, o.scale * 2));
    if (p.k === 'ring') {
      // (it lies across the spine: seen from above, edge on, its segments in a row)
      const n = Math.max(4, Math.round((p.n || 20) / 2)), R = p.r + p.d, y0 = p.y - p.w / 2, y1 = p.y + p.w / 2;
      for (let k = 0; k < n; k++) {
        const x0 = p.x - R + 2 * R * (k + 0.06) / n, x1 = p.x - R + 2 * R * (k + 0.94) / n;
        poly(ctx, [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]);
        ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = edge; ctx.stroke();
      }
      continue;
    }
    if (p.k === 'cyl') {
      poly(ctx, [P(p.x0, p.y - p.r), P(p.x1, p.y - p.r), P(p.x1, p.y + p.r), P(p.x0, p.y + p.r)]);
    } else {
      poly(ctx, [P(p.x0, p.y0), P(p.x1, p.y0), P(p.x1, p.y1), P(p.x0, p.y1)]);
    }
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = p.role === 'command' || p.role === 'hab' ? (o.tint || edge) : edge;
    ctx.globalAlpha = 0.75; ctx.stroke(); ctx.globalAlpha = 1;
  }
  // Berths: a lamp on each arm, green free, amber taken, ours cyan
  for (const b of model.berths) {
    const [sx, sy] = P(b.x, b.y);
    const taken = o.occupied?.has(b.id);
    const ours = o.highlight === b.id;
    const r = Math.max(2, (b.accepts.includes('L') ? 4 : 1.5) * o.scale * 2);
    ctx.fillStyle = ours ? '#6EEAE0' : taken ? 'rgba(226,163,85,0.9)' : 'rgba(107,203,119,0.9)';
    ctx.beginPath(); ctx.arc(sx, sy, Math.min(r, 6), 0, Math.PI * 2); ctx.fill();
    if (o.labels && o.scale > 0.05) {
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillStyle = ours ? '#6EEAE0' : 'rgba(150,170,190,0.7)';
      ctx.fillText(b.id, sx + 6, sy - 4);
    }
  }
  ctx.restore();
}

/** A station's frame point (m) → screen, for overlays (the corridor, the berth). */
export function stationProjector(o) {
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  return (x, y) => { const wx = x * c - y * s, wy = x * s + y * c; return [o.x + wx * o.scale, o.y - wy * o.scale]; };
}

/**
 * A small static picture of a hull, nose right, sized to the box (the ship
 * picker, the library, the contact panel). view: 'top' | 'side'; blown: the
 * ship blown apart, in pieces.
 */
export function drawHullPortrait(canvas, hull, { view = 'top', tint = '#7EC8E3', ports = true, blown = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!hull) return;
  const b = hull.bounds;
  const len = b.x1 - b.x0, wid = view === 'side' ? b.z1 - b.z0 : b.y1 - b.y0;
  const scale = Math.min((W - 16) / len, (H - 12) / wid) * (blown ? 0.62 : 1);
  const cx = W / 2 - (b.x0 + b.x1) / 2 * scale;
  const cy = H / 2 + ((view === 'side' ? (b.z0 + b.z1) : (b.y0 + b.y1)) / 2) * scale;
  if (!blown) { drawHull(ctx, hull, { x: cx, y: cy, facing: 0, scale, view, tint, detail: 2, ports, lights: false }); return; }
  // its parts, each flung out from the middle along where it was (and a little round), turned about its own centre
  const side = view === 'side', ml = side ? (b.z0 + b.z1) / 2 : (b.y0 + b.y1) / 2, mx = (b.x0 + b.x1) / 2;
  const h = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
  hull.parts.forEach((p, i) => {
    const e = planeOf(p, side);
    const px = (e[0] + e[1]) / 2, pl = (e[2] + e[3]) / 2;
    const a = Math.atan2((pl - ml) * 2.5, px - mx) + (h(i, 1) - 0.5) * 1.4;
    const r = (0.25 * Math.abs(px - mx) + len * (0.04 + 0.12 * h(i, 2))) * scale;
    const [sx, sy] = [cx + px * scale + Math.cos(a) * r, cy - pl * scale - Math.sin(a) * r];
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((h(i, 3) - 0.5) * 2.2);
    drawHull(ctx, { ...hull, parts: [p], ports: [] }, { x: -px * scale, y: pl * scale, facing: 0, scale, view, tint, detail: 2, ports: false, lights: false, alpha: 0.7 });
    ctx.restore();
  });
}
