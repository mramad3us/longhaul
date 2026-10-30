// ============================================================
// LONGHAUL — Tactical display (canvas)
// Ship-centred, nose-up. True positions of everything within a few
// km, interpolated between sim minutes. Not to scale for our own hull
// (it would be a few pixels); the torch plume is drawn the way it
// looks: a fireball near the nozzle, then a long taper that dwarfs
// the ship. Only what our sensors hold is drawn (intel.liveKnowledge).
// In the nav modal a click picks a contact (onSelect), which opens the
// same contact panel as the scanner; the small panel isn't clickable.
// The nav computer's marks (marks.js): a ship running dark is a hollow
// mark (seen as a hull, DARK by its name), what our work points at has
// its magenta diamond, a flag its pennant.
// ============================================================

import { AU_M } from '../core/constants.js';
import { hashString } from '../core/rng.js';
import { getWorld } from '../sim/world.js';
import { liveKnowledge } from '../sim/intel.js';
import { isDark, isIdentified, huntsOf } from '../sim/sensors.js';
import { factionColor } from '../sim/factions.js';
import { CLASSES } from '../sim/ship-classes.js';
import { hullOf } from '../sim/hulls.js';
import { drawHull as drawHullArt } from './hull-art.js';
import { fxList } from './fx.js';
import { FitCanvas, pointAt } from './dom.js';
import { TileType } from '../svg-icons.js';
import { DECK_GAP } from '../sim/ship-layout.js';
import { frameMarks, marksOf, labelTags, drawMissionMark, drawFlagMark, paintMark, MARK_COL } from './marks.js';

const TILE = 32;

// ---- OUR HULL'S OUTLINE (from the deck plan) ----

export function buildHullPath(decks, offsetX = 0, offsetY = 0) {
  const segments = [];
  let y = 0;
  for (const deck of decks) {
    deck.tiles.forEach((row, ry) => {
      let l = -1, r = -1;
      row.forEach((t, rx) => { if (t !== TileType.EMPTY) { if (l < 0) l = rx; r = rx; } });
      if (l >= 0) segments.push({ y: y + ry, left: l, right: r + 1 });
    });
    y += deck.tiles.length + DECK_GAP;
  }
  if (!segments.length) return '';
  const T = TILE, m = 3, pts = [];
  segments.forEach((s, i) => {
    const x = offsetX + s.left * T - m;
    if (i === 0) { pts.push(`M ${offsetX + s.left * T} ${offsetY + s.y * T - m}`, `L ${x} ${offsetY + s.y * T}`); }
    else {
      const px = offsetX + segments[i - 1].left * T - m;
      if (x !== px) pts.push(`L ${px} ${offsetY + s.y * T}`, `L ${x} ${offsetY + s.y * T}`);
    }
    pts.push(`L ${x} ${offsetY + (s.y + 1) * T}`);
  });
  const last = segments[segments.length - 1];
  const bottom = offsetY + (last.y + 1) * T + m;
  pts.push(`L ${offsetX + last.left * T} ${bottom}`, `L ${offsetX + last.right * T} ${bottom}`);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const x = offsetX + s.right * T + m;
    pts.push(`L ${x} ${offsetY + (s.y + 1) * T}`);
    if (i > 0) {
      const px = offsetX + segments[i - 1].right * T + m;
      if (x !== px) pts.push(`L ${x} ${offsetY + s.y * T}`, `L ${px} ${offsetY + s.y * T}`);
    }
    pts.push(`L ${x} ${offsetY + s.y * T}`);
  }
  const first = segments[0];
  pts.push(`L ${offsetX + first.right * T} ${offsetY + first.y * T - m}`, 'Z');
  return pts.join(' ');
}


export const TAC_RANGES_M = [1000, 5000, 25000];
export const TAC_LABELS = ['1 km', '5 km', '25 km'];
// On-screen hull length per zoom level (small panel / modal)
const SHIP_PX = [30, 12, 4];
const SHIP_PX_BIG = [60, 24, 8];

const _q = [];
const prevRel = new Map();     // entity id → { m: minute, x, y } relative position last minute
let hullPath2D = null;
let hullSize = null;

function hull(state) {
  if (!hullPath2D) {
    const d = buildHullPath(state.ship.decks, 0, 0);
    hullPath2D = new Path2D(d);
    const rows = state.ship.decks.reduce((s, dk) => s + dk.tiles.length + 1, -1);
    hullSize = { w: state.ship.decks[0].tiles[0].length * 32, h: rows * 32 };
  }
  return hullPath2D;
}

export function resetTacCache() {
  hullPath2D = null;
  prevRel.clear();
}

/** Nearby entities with interpolated ship-frame offsets (meters). */
function nearby(state, rangeM, alpha) {
  const f = state.flight;
  const world = getWorld(state);
  _q.length = 0;
  world.query(f.pos, rangeM * 1.6 / AU_M, _q);
  const now = state.clock.minute;
  const out = [];
  for (const e of _q) {
    if (e.type === 'nav' || !liveKnowledge(state, e)) continue;     // only what our sensors hold
    const x = (e.pos.x - f.pos.x) * AU_M, y = (e.pos.y - f.pos.y) * AU_M;
    let p = prevRel.get(e.id);
    if (!p || now - p.m > 1) p = { m: now, x, y, px: x, py: y };
    else if (p.m !== now) { p.px = p.x; p.py = p.y; p.x = x; p.y = y; p.m = now; }
    prevRel.set(e.id, p);
    out.push({ e, x: p.px + (p.x - p.px) * alpha, y: p.py + (p.y - p.py) * alpha });
  }
  if (prevRel.size > 400) for (const [id, p] of prevRel) if (now - p.m > 5) prevRel.delete(id);
  return out;
}

export class TacView {
  /** onSelect(id | null): a click on a contact (or on empty space). Without it the view isn't clickable. */
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'tac-canvas' });
    this.zoom = 0;
    this.t0 = performance.now();
    this._hits = [];
    if (onSelect) {
      container.addEventListener('pointerdown', (e) => onSelect(this.hit(container, e)));
      container.addEventListener('pointermove', (e) => pointAt(this.fc.canvas, this.hit(container, e)));
    }
  }

  /** The contact under the pointer, if any (within 18 px). */
  hit(container, e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
    return best ? best.id : null;
  }

  render(state, alpha, opts = {}) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const cx = W / 2, cy = H / 2;
    const rangeM = TAC_RANGES_M[this.zoom];
    const px = (Math.min(W, H) / 2) / rangeM;    // pixels per meter
    const t = (performance.now() - this.t0) / 1000;
    const f = state.flight;
    const big = W > 400;

    ctx.fillStyle = '#05070A';
    ctx.fillRect(0, 0, W, H);

    if (state.reactor.blackout) {
      ctx.fillStyle = '#331111';
      ctx.font = '11px "IBM Plex Sans Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NO POWER', cx, cy);
      return;
    }

    // Grid & range rings
    ctx.strokeStyle = 'rgba(42,56,70,0.32)';
    ctx.lineWidth = 1;
    const step = rangeM / 4 * px;
    ctx.beginPath();
    for (let x = cx % step; x < W; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); }
    for (let y = cy % step; y < H; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(42,56,70,0.7)';
    for (let k = 1; k <= 3; k++) { ctx.beginPath(); ctx.arc(cx, cy, rangeM * k / 3 * px, 0, Math.PI * 2); ctx.stroke(); }

    // World → screen: rotate so the nose points up
    const rot = Math.PI / 2 - f.facing;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const toScreen = (x, y) => ({ sx: cx + (x * cr - y * sr) * px, sy: cy - (x * sr + y * cr) * px });

    // Our hull and torch. A 25 m hull is sub-pixel at these ranges, so it's
    // drawn stylized — but it still shrinks with zoom, and the plume with it.
    const shipH = (big ? SHIP_PX_BIG : SHIP_PX)[this.zoom];
    if (f.thrustG > 0.02) {
      if (this.zoom === 2) drawTorchStar(ctx, cx, cy, f.thrustG, t, big);
      drawPlume(ctx, cx, cy + shipH / 2, shipH, f.thrustG, t, big && this.zoom === 0);
    }
    if (this.zoom < 2) drawHull(ctx, state, cx, cy, shipH);
    else { ctx.fillStyle = '#5FD38D'; ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); }
    if (this.zoom < 2 && (Math.abs(f.turning) > 0.001 || f.rcsG > 0.0005)) drawRcs(ctx, cx, cy, shipH, t, Math.abs(f.turning) > 0.2);

    // Contacts
    const list = nearby(state, rangeM, alpha);
    // (labels by priority: the one picked out first, then the flagged and what our work points at,
    // then the nearest; one that would overlap a label already drawn is left off: a crowded port
    // reads as dots, not a smear of names; a flag's pennant is drawn whatever happens to its name)
    const pick = opts.highlight ?? opts.selected;
    const fm = frameMarks(state), hunts = huntsOf(state);
    const rank = (e) => (fm.flags[e.id] ? 2 : 0) + (fm.missions.has(e.id) ? 1 : 0);
    list.sort((a, b) => (b.e.id === pick) - (a.e.id === pick) || rank(b.e) - rank(a.e) || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    const placed = big ? [{ x: 0, y: H - 26, w: W, h: 26 }] : [];      // (the readouts at the display's foot)
    const hits = this._hits;
    hits.length = 0;
    for (const { e, x, y } of list) {
      const { sx, sy } = toScreen(x, y);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      hits.push({ id: e.id, x: sx, y: sy });
      const heading = (e.heading || 0) + rot;   // screen-frame heading
      if (e.type === 'ordnance') { drawOrdnance(ctx, e, sx, sy, heading, t); continue; }
      const color = e.sos ? '#EF5350' : e.tags?.wreck ? '#5A5A5A' : factionColor(e.faction);
      const seed = hashString(e.id);
      const m = marksOf(fm, e.id, isDark(e), e.tags?.wreck);
      const hollow = m.dark || m.wreck;
      if (this.zoom === 0) drawSilhouette(ctx, e, sx, sy, heading, color, seed, t, big);
      else if (this.zoom === 1) drawIcon(ctx, e, sx, sy, heading, color, t, hollow);
      else drawDot(ctx, e, sx, sy, color, t, hollow);
      const mr = this.zoom === 0 ? (big ? 22 : 15) : 10;
      if (m.mission) drawMissionMark(ctx, sx, sy, mr);
      else if (m.maybe) drawMissionMark(ctx, sx, sy, mr, true);
      if (m.flag) {
        drawFlagMark(ctx, sx, sy, mr * 0.8, m.flag);
        placed.push({ x: sx + mr * 0.56, y: sy - mr * 0.56 - 14, w: 22, h: 15 });
      }
      if (e.sos) {
        const ph = (t % 1.5) / 1.5;
        ctx.strokeStyle = `rgba(226,85,85,${0.5 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(sx, sy, 6 + ph * 16, 0, Math.PI * 2); ctx.stroke();
      }
      // (its name once we know it: a transponder, or a long look; else what it is to us)
      const name = isIdentified(state, e, undefined, hunts) ? e.name : null;
      const label = name || (m.dark ? 'DARK' : m.wreck ? 'WRECK' : null);
      const tags = labelTags(name ? m : { mission: m.mission, maybe: m.maybe }) || [];
      let room = false;
      if (label && (this.zoom < 2 || big)) {
        ctx.font = `${big ? 10 : 7}px "IBM Plex Mono", monospace`;
        const text = label.length > 22 ? label.slice(0, 21) + '…' : label;
        const tw = ctx.measureText(text).width;
        const w = tags.reduce((a, g) => a + 5 + ctx.measureText(g.text).width, tw);
        const r = { x: sx + 8, y: sy - (big ? 7 : 5), w: w + 4, h: big ? 22 : 9 };
        room = e.id === pick || !placed.some(p => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
        if (room) placed.push(r);
        if (room) {
        ctx.fillStyle = name ? color : m.dark ? MARK_COL.dark : MARK_COL.wreck;
        ctx.globalAlpha = 0.85;
        ctx.textAlign = 'left';
        ctx.fillText(text, sx + 10, sy + 3);
        let tx = sx + 10 + tw;
        for (const g of tags) { ctx.fillStyle = g.color; ctx.fillText(g.text, tx += 5, sy + 3); tx += ctx.measureText(g.text).width; }
        if (big) {
          ctx.fillStyle = 'rgba(122,142,162,0.8)';
          ctx.fillText(`${(Math.hypot(x, y) / 1000).toFixed(2)} km`, sx + 10, sy + 14);
        }
        ctx.globalAlpha = 1;
        }
      }
      if (opts.highlight === e.id) {
        ctx.strokeStyle = '#5FD38D';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(sx, sy, 16, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (opts.selected === e.id) {
        ctx.strokeStyle = '#3EC7E6';
        ctx.lineWidth = 1.5;
        const r = 20 + Math.sin(t * 4) * 1.5;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) { const a0 = k * Math.PI / 2 + Math.PI / 8; ctx.arc(sx, sy, r, a0, a0 + Math.PI / 4); ctx.moveTo(sx + r * Math.cos(a0 + Math.PI / 2), sy + r * Math.sin(a0 + Math.PI / 2)); }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Combat effects: gunfire, intercepts, hits, detonations
    const relOf = (id) => {
      if (id === 'player') return { x: 0, y: 0 };
      const hit = list.find(n => n.e.id === id);
      return hit ? { x: hit.x, y: hit.y } : null;
    };
    for (const fx of fxList()) {
      if (fx.age >= 1) continue;
      const fade = 1 - fx.age;
      if (fx.kind === 'pdc' || fx.kind === 'strafe') {
        const from = relOf(fx.kind === 'pdc' ? fx.id : fx.from);
        if (!from) continue;
        const a = toScreen(from.x, from.y);
        const to = fx.kind === 'strafe' ? relOf(fx.target) : null;
        ctx.strokeStyle = `rgba(255,214,140,${0.8 * fade})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = to ? Math.atan2(-(toScreen(to.x, to.y).sy - a.sy), toScreen(to.x, to.y).sx - a.sx) + (Math.random() - 0.5) * 0.15 : Math.random() * Math.PI * 2;
          const len = to ? Math.hypot(toScreen(to.x, to.y).sx - a.sx, toScreen(to.x, to.y).sy - a.sy) : 25 + Math.random() * 40;
          const r0 = len * Math.random() * 0.6;
          ctx.moveTo(a.sx + Math.cos(ang) * r0, a.sy - Math.sin(ang) * r0);
          ctx.lineTo(a.sx + Math.cos(ang) * (r0 + Math.min(14, len * 0.2)), a.sy - Math.sin(ang) * (r0 + Math.min(14, len * 0.2)));
        }
        ctx.stroke();
        continue;
      }
      if (fx.x == null) continue;
      const rx = (fx.x - f.pos.x) * AU_M, ry = (fx.y - f.pos.y) * AU_M;
      const p = toScreen(rx, ry);
      if (p.sx < -200 || p.sx > W + 200 || p.sy < -200 || p.sy > H + 200) continue;
      if (fx.kind === 'detonation') {
        const r = Math.max(6, (fx.scaleM || 500) * 2 * px) * (0.4 + fx.age);
        const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r);
        g.addColorStop(0, `rgba(255,255,255,${fade})`);
        g.addColorStop(0.3, `rgba(255,220,160,${0.7 * fade})`);
        g.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = fx.kind === 'intercept' ? `rgba(255,214,140,${fade})` : `rgba(255,90,60,${fade})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 2 + 8 * fx.age, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Edge marker for the reference target when it's off-screen
    if (opts.reference) {
      const r = opts.reference;
      const { sx, sy } = toScreen(r.dx, r.dy);
      if (sx < 0 || sx > W || sy < 0 || sy > H) {
        const ang = Math.atan2(sy - cy, sx - cx);
        const ex = cx + Math.cos(ang) * (Math.min(W, H) / 2 - 10), ey = cy + Math.sin(ang) * (Math.min(W, H) / 2 - 10);
        ctx.fillStyle = '#5FD38D';
        ctx.beginPath();
        ctx.moveTo(ex + Math.cos(ang) * 6, ey + Math.sin(ang) * 6);
        ctx.lineTo(ex + Math.cos(ang + 2.4) * 6, ey + Math.sin(ang + 2.4) * 6);
        ctx.lineTo(ex + Math.cos(ang - 2.4) * 6, ey + Math.sin(ang - 2.4) * 6);
        ctx.fill();
        if (big) {
          // (its name on the inner side of the arrow, never on it)
          ctx.font = '10px "IBM Plex Mono", monospace';
          const w = ctx.measureText(r.name).width, side = Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang));
          const tx = side ? (Math.cos(ang) > 0 ? ex - 12 - w : ex + 12) : ex - w / 2;
          const ty = side ? ey + 4 : ey - Math.sign(Math.sin(ang)) * 16 + 4;
          ctx.textAlign = 'left';
          ctx.fillText(r.name, tx, ty);
          placed.push({ x: tx, y: ty - 10, w, h: 13 });
        }
      }
    }

    // The rings' ranges last, where no name already is, and inside the display
    if (big) {
      ctx.fillStyle = 'rgba(94,109,124,0.95)';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      for (let k = 1; k <= 3; k++) {
        const text = `${(rangeM * k / 3 / 1000).toFixed(rangeM < 5000 ? 2 : 1)} km`;
        const r = { x: cx + rangeM * k / 3 * px + 3, y: cy - 13, w: ctx.measureText(text).width, h: 12 };
        if (r.x + r.w > W - 4 || placed.some(p => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h)) continue;
        ctx.fillText(text, r.x, cy - 3);
      }
    }

    // Scale bar / heading
    if (big) {
      ctx.fillStyle = 'rgba(148,163,178,0.9)';
      ctx.font = '12px "IBM Plex Sans Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FWD', cx, 14);
    }
  }
}

function drawHull(ctx, state, cx, cy, shipH) {
  const path = hull(state);
  const s = shipH / hullSize.h;
  ctx.save();
  ctx.translate(cx - hullSize.w * s / 2, cy - shipH / 2);
  ctx.scale(s, s);
  ctx.fillStyle = '#0F151C';
  ctx.fill(path);
  ctx.lineWidth = 1.5 / s;
  ctx.strokeStyle = '#5FD38D';
  ctx.stroke(path);
  ctx.restore();
  ctx.fillStyle = '#5FD38D';
  ctx.fillRect(cx - 1, cy - 1, 2, 2);
}

/** Epstein plume: fireball (~2 ship lengths), then a long taper (~15 ship lengths). */
function drawPlume(ctx, cx, y0, shipH, g, t, big) {
  const k = Math.min(1.4, 0.45 + Math.sqrt(g) * 0.35);
  const fire = shipH * 2 * k, tail = shipH * 13 * k;
  const halfW = shipH * 0.55 * k;
  const flick = 0.85 + 0.15 * Math.sin(t * 40) * Math.sin(t * 23);
  const grad = ctx.createLinearGradient(0, y0, 0, y0 + fire + tail);
  grad.addColorStop(0, `rgba(255,255,255,${0.95 * flick})`);
  grad.addColorStop(0.08, `rgba(224,232,255,${0.8 * flick})`);
  grad.addColorStop(0.2, 'rgba(160,200,255,0.45)');
  grad.addColorStop(0.5, 'rgba(90,140,255,0.18)');
  grad.addColorStop(1, 'rgba(48,96,204,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - shipH * 0.12, y0);
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const d = i / N * (fire + tail);
    ctx.lineTo(cx - widthAt(d), y0 + d);
  }
  for (let i = N; i >= 0; i--) {
    const d = i / N * (fire + tail);
    ctx.lineTo(cx + widthAt(d), y0 + d);
  }
  ctx.closePath();
  ctx.fill();
  function widthAt(d) {
    if (d < fire) return Math.max(shipH * 0.12, halfW * Math.sin(d / fire * Math.PI * 0.7));
    const peak = halfW * Math.sin(0.7 * Math.PI);
    return Math.max(0.5, peak * Math.pow(1 - (d - fire) / tail, 0.7));
  }
  if (big) {
    ctx.fillStyle = `rgba(255,255,255,${0.6 * flick})`;
    ctx.fillRect(cx - shipH * 0.08, y0, shipH * 0.16, fire * 0.3);
  }
}

/** From 25 km a lit torch is the brightest thing in the sky. */
function drawTorchStar(ctx, cx, cy, g, t, big) {
  const r = (big ? 70 : 34) * Math.min(1.6, 0.5 + Math.sqrt(g) * 0.4) * (0.92 + 0.08 * Math.sin(t * 30));
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.08, 'rgba(225,235,255,0.7)');
  grad.addColorStop(0.3, 'rgba(140,180,255,0.18)');
  grad.addColorStop(1, 'rgba(80,120,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
}

function drawRcs(ctx, cx, cy, shipH, t, flip) {
  const w = shipH * 0.2;
  ctx.fillStyle = '#F0A93A';
  const jets = [[-1, -0.35], [1, -0.35], [-1, 0.35], [1, 0.35]];
  jets.forEach(([sx, sy], i) => {
    const on = flip ? Math.sin(t * 50 + i) > -0.2 : Math.sin(t * 3 + i * 1.7) > 0.6;
    if (!on) return;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx + sx * (w + 2) - (sx < 0 ? 5 : 0), cy + sy * shipH - 1, 5, 2);
  });
  ctx.globalAlpha = 1;
}

function drawSilhouette(ctx, e, x, y, heading, color, seed, t, big) {
  const rand = (i) => ((Math.imul(seed, 2654435761) + i * 340573321) >>> 0) / 4294967296;
  const scale = (big ? 1.6 : 1) * Math.min(2.5, Math.max(0.5, (e.mass || 50000) / 90000));
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  if (e.type === 'station') {
    const r = 12 * scale;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 0.8;
    const spokes = 3 + (seed % 3);
    const spin = t * 0.15;
    ctx.globalAlpha = 0.45;
    for (let s = 0; s < spokes; s++) {
      const a = spin + s / spokes * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.stroke();
    }
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  if (e.tags?.blown) {
    // (a ship blown apart: a scatter of its pieces, no hull)
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < 11; i++) {
      const a = rand(i * 2 + 1) * Math.PI * 2, r = 9 * scale * Math.sqrt(rand(i * 2 + 2)), w = i < 3 ? 2.5 : 1.5;
      ctx.fillRect(Math.cos(a) * r - w / 2, Math.sin(a) * r - w / 2, w, w);
    }
    ctx.restore();
    return;
  }
  // On-screen length grows with the log of the real hull length (30 m skiff … 1.4 km hauler),
  // drawn from the class's hull model
  const c = CLASSES[e.cls];
  const hull = hullOf(e.cls);
  const lenM = c?.lengthM || 60;
  const h = (10 + 9 * Math.log10(lenM / 20)) * (big ? 1.6 : 1) * (0.95 + rand(0) * 0.1);
  ctx.restore();
  if (hull) drawHullArt(ctx, hull, { x, y, facing: heading, scale: h / hull.L, view: 'top', tint: color, detail: 1, plume: e.thrust > 0 ? Math.min(3, e.thrust) * 0.3 : 0, t, lights: false, alpha: 0.9 });
}

/** A torpedo (bright point, plume when its drive is lit) or a railgun slug (a streak). */
function drawOrdnance(ctx, e, x, y, heading, t) {
  const ours = e.ord?.owner === 'player';
  const inbound = e.ord?.target === 'player';
  const color = inbound ? '#EF5350' : ours ? '#5FD38D' : '#F0A93A';
  if (e.ord?.kind === 'slug') {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(-heading) * 8, y - Math.sin(-heading) * 8); ctx.stroke();
    return;
  }
  if (e.thrust > 0) {
    ctx.strokeStyle = `rgba(200,220,255,${0.5 + 0.3 * Math.sin(t * 40)})`;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(-heading) * 14, y - Math.sin(-heading) * 14); ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
}

/** A ship's arrowhead, solid (squawking) or hollow (dark, a wreck); a station's diamond. */
function drawIcon(ctx, e, x, y, heading, color, t, hollow) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.9;
  if (e.type === 'station') {
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(-heading) * 7, y + Math.sin(-heading) * 7);
    ctx.lineTo(x + Math.cos(-heading + 2.5) * 5, y + Math.sin(-heading + 2.5) * 5);
    ctx.lineTo(x + Math.cos(-heading - 2.5) * 5, y + Math.sin(-heading - 2.5) * 5);
    ctx.closePath();
    paintMark(ctx, color, hollow);
    if (e.thrust > 0) {
      ctx.strokeStyle = `rgba(226,163,85,${0.5 + 0.4 * Math.sin(t * 20)})`;
      ctx.beginPath(); ctx.moveTo(x - Math.cos(-heading) * 5, y - Math.sin(-heading) * 5); ctx.lineTo(x - Math.cos(-heading) * 14, y - Math.sin(-heading) * 14); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawDot(ctx, e, x, y, color, t, hollow) {
  // At 25 km a running torch is the brightest thing in the sky
  if (e.thrust > 0) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, 10);
    g.addColorStop(0, `rgba(255,255,255,${0.8 + 0.2 * Math.sin(t * 25)})`);
    g.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
  }
  if (hollow) { ctx.fillStyle = '#05070A'; ctx.fillRect(x - 3, y - 3, 6, 6); ctx.strokeStyle = color; ctx.strokeRect(x - 2.5, y - 2.5, 5, 5); return; }
  ctx.fillStyle = color;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
}
