// ============================================================
// LONGHAUL — Ship cross-section view
// Built once per game from the deck layout (SVG, pixel art); each
// frame only updates crew transforms (interpolated between sim
// minutes), sprite states, the torch plume, RCS jets and status lights.
// ============================================================

import { SVG_NS, TileType, renderTile, renderCrewMember, INTERACTIVE_TILES, setCrewSprite } from '../svg-icons.js';
import { shipGeometry, DECK_GAP, seatKind } from '../sim/ship-layout.js';
import { atmoStatus } from '../sim/life-support.js';
import { isConscious } from '../sim/crew.js';
import { ui } from './context.js';

export const TILE = 32;
const LABEL_W = 100;
const OFFSET_Y = 20;

let root = null;        // <svg>
let crewEls = new Map();
let plumeEl = null;
let rcsEl = null;
let rcsMode = null;
let atmoDots = [];
let hullBox = null;
let handlers = {};

// ---- HULL OUTLINE (shared with the tactical renderer) ----

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

// ---- BUILD ----

/**
 * Render the ship into `container`.
 * on: { crew(id), tile(tileType, deck, x, y), deckMenu(deck, clientX, clientY) }
 */
export function buildShipView(container, state, on) {
  handlers = on;
  container.innerHTML = '';
  crewEls = new Map();
  atmoDots = [];
  rcsEl = null; rcsMode = null;
  const ship = state.ship;
  const geo = shipGeometry(ship);
  const cols = geo.cols;
  const W = cols * TILE + LABEL_W + 40;
  const H = geo.totalRows * TILE + OFFSET_Y + 120;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.style.display = 'block';
  root = svg;

  const hull = buildHullPath(ship.decks, LABEL_W, OFFSET_Y);
  const parts = [];
  parts.push(`<defs>
    <filter id="hull-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="ambient-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="torch-glow" x="-100%" y="-50%" width="300%" height="300%"><feGaussianBlur stdDeviation="12" result="b1"/><feGaussianBlur stdDeviation="28" result="b2"/><feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="torch-bloom" x="-200%" y="-100%" width="500%" height="400%"><feGaussianBlur stdDeviation="40"/></filter>
    <filter id="rcs-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="plume-grad-main" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/><stop offset="5%" stop-color="#FFFFFF" stop-opacity="0.85"/>
      <stop offset="12%" stop-color="#E0E8FF" stop-opacity="0.7"/><stop offset="20%" stop-color="#C0D8FF" stop-opacity="0.5"/>
      <stop offset="40%" stop-color="#80B0FF" stop-opacity="0.3"/><stop offset="70%" stop-color="#5090FF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#3060CC" stop-opacity="0.02"/></linearGradient>
    <linearGradient id="plume-grad-glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.5"/><stop offset="10%" stop-color="#D0E8FF" stop-opacity="0.3"/>
      <stop offset="30%" stop-color="#80C0FF" stop-opacity="0.1"/><stop offset="100%" stop-color="#4080FF" stop-opacity="0"/></linearGradient>
  </defs>`);
  if (hull) {
    parts.push(`<path d="${hull}" fill="none" stroke="#2D5A6A" stroke-width="6" filter="url(#hull-glow)" opacity="0.3"/>`);
    parts.push(`<path class="hull-outline" d="${hull}" fill="none" stroke="#2D5A6A" stroke-width="2" opacity="0.6"/>`);
  }
  svg.innerHTML = parts.join('');

  // Decks: tiles, labels, status lights, shaft connectors
  ship.decks.forEach((deck, di) => {
    const y0 = geo.deckStart[di];
    const rows = deck.tiles.length;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'deck-group');
    g.dataset.deck = di;
    if (deck.glow) {
      g.insertAdjacentHTML('beforeend', `<rect x="${LABEL_W + TILE}" y="${OFFSET_Y + y0 * TILE}" width="${(cols - 2) * TILE}" height="${rows * TILE}" fill="${deck.glow.color}" filter="url(#ambient-glow)"/>`);
    }
    g.insertAdjacentHTML('beforeend', `<rect class="deck-highlight" x="${LABEL_W}" y="${OFFSET_Y + y0 * TILE}" width="${cols * TILE}" height="${rows * TILE}" fill="rgba(79, 209, 197, 0.03)"/>`);
    deck.tiles.forEach((row, ry) => row.forEach((t, rx) => {
      if (t === TileType.EMPTY) return;
      const tile = renderTile(t, 0, 0, null);
      tile.setAttribute('transform', `translate(${LABEL_W + rx * TILE}, ${OFFSET_Y + (y0 + ry) * TILE})`);
      if (INTERACTIVE_TILES.has(t)) {
        tile.dataset.deck = di; tile.dataset.x = rx; tile.dataset.y = ry;
        tile.addEventListener('click', (e) => { e.stopPropagation(); handlers.tile?.(t, di, rx, ry); });
      }
      g.appendChild(tile);
    }));
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); handlers.deckMenu?.(di, e.clientX, e.clientY); });
    svg.appendChild(g);

    const cy = OFFSET_Y + (y0 + rows / 2) * TILE;
    svg.insertAdjacentHTML('beforeend',
      `<text class="deck-label" x="${LABEL_W - 10}" y="${cy + 3}" font-family='"Press Start 2P", monospace' font-size="7" fill="#3A4E62" text-anchor="end">${deck.name.toUpperCase()}</text>` +
      `<rect x="${LABEL_W - 6}" y="${cy - 1}" width="3" height="3" fill="${deck.glow?.accent || '#3A4E62'}" opacity="0.6"/>` +
      `<rect class="atmo-indicator" data-deck-atmo="${di}" x="${LABEL_W - 6}" y="${cy + 5}" width="3" height="3" fill="#4FD1C5"><title>Atmosphere</title></rect>`);
    atmoDots[di] = svg.lastElementChild;

    if (di < ship.decks.length - 1) {
      const gy = OFFSET_Y + (y0 + rows) * TILE;
      svg.insertAdjacentHTML('beforeend',
        `<rect x="${LABEL_W}" y="${gy}" width="${TILE}" height="${DECK_GAP * TILE}" fill="#0C1420" stroke="#162030"/>` +
        `<rect x="${LABEL_W + (cols - 1) * TILE}" y="${gy}" width="${TILE}" height="${DECK_GAP * TILE}" fill="#0C1420" stroke="#162030"/>`);
      for (const sh of geo.shafts.filter(s => s.upper === di)) {
        svg.insertAdjacentHTML('beforeend',
          `<rect x="${LABEL_W + sh.x * TILE + 8}" y="${gy}" width="${TILE - 16}" height="${DECK_GAP * TILE}" fill="#0C1420" stroke="#3A4A5A" stroke-width="0.5"/>` +
          `<line x1="${LABEL_W + sh.x * TILE + 11}" y1="${gy + 4}" x2="${LABEL_W + sh.x * TILE + 21}" y2="${gy + 4}" stroke="#3A4A5A"/>` +
          `<line x1="${LABEL_W + sh.x * TILE + 11}" y1="${gy + 14}" x2="${LABEL_W + sh.x * TILE + 21}" y2="${gy + 14}" stroke="#3A4A5A"/>` +
          `<line x1="${LABEL_W + sh.x * TILE + 11}" y1="${gy + 24}" x2="${LABEL_W + sh.x * TILE + 21}" y2="${gy + 24}" stroke="#3A4A5A"/>`);
      }
    }
  });

  // Exterior plating (shown while fast-forwarding)
  svg.insertAdjacentHTML('beforeend', exteriorSVG(ship, geo, hull));

  // Crew
  const crewLayer = document.createElementNS(SVG_NS, 'g');
  crewLayer.setAttribute('class', 'crew-layer');
  ship.crew.forEach((m, i) => {
    const el = renderCrewMember(0, 0, i, `${m.name} (${m.role})`);
    el.dataset.crewId = m.id;
    el.addEventListener('click', (e) => { e.stopPropagation(); handlers.crew?.(m.id); });
    crewLayer.appendChild(el);
    crewEls.set(m.id, el);
  });
  svg.appendChild(crewLayer);

  // Drive plume + nozzle
  const bottom = OFFSET_Y + geo.totalRows * TILE;
  svg.insertAdjacentHTML('beforeend', plumeSVG(cols, bottom));
  plumeEl = svg.querySelector('#engine-plume');
  svg.insertAdjacentHTML('beforeend', nozzleSVG(cols, bottom));

  container.appendChild(svg);
  const outline = svg.querySelector('.hull-outline');
  hullBox = outline ? outline.getBBox() : null;
  fitToViewport(container, W, H);
}

// ---- FIT ----
// The cross-section scales to the viewport (never above 1:1, so the pixel
// art stays crisp on screens big enough to show the whole ship).

let fitObserver = null;
function fitToViewport(container, W, H) {
  fitObserver?.disconnect();
  const viewport = container.parentElement;
  if (!viewport || typeof ResizeObserver === 'undefined') return;
  const apply = () => {
    const k = Math.min(1, (viewport.clientWidth - 24) / W, (viewport.clientHeight - 16) / H);
    const scale = Math.max(0.45, k);
    root.style.width = `${Math.round(W * scale)}px`;
    root.style.height = `${Math.round(H * scale)}px`;
  };
  fitObserver = new ResizeObserver(apply);
  fitObserver.observe(viewport);
  apply();
}

function exteriorSVG(ship, geo, hull) {
  const T = TILE, ox = LABEL_W, oy = OFFSET_Y;
  const p = [`<g class="ship-exterior" display="none">`];
  if (hull) p.push(`<path d="${hull}" fill="#0E1E2E"/>`);
  ship.decks.forEach((deck, di) => {
    let l = Infinity, r = -1;
    deck.tiles.forEach(row => row.forEach((t, x) => { if (t !== TileType.EMPTY) { l = Math.min(l, x); r = Math.max(r, x); } }));
    const top = oy + geo.deckStart[di] * T, h = deck.tiles.length * T;
    const x0 = ox + l * T, w = (r - l + 1) * T;
    p.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="${di % 2 ? '#162E40' : '#142838'}" opacity="0.6"/>`);
    for (let k = 1; k < deck.tiles.length; k++) p.push(`<line x1="${x0 + 2}" y1="${top + k * T}" x2="${x0 + w - 2}" y2="${top + k * T}" stroke="#223C50" stroke-width="0.5" opacity="0.4"/>`);
    for (let c = l + 2; c <= r; c += 2) p.push(`<line x1="${ox + c * T}" y1="${top + 2}" x2="${ox + c * T}" y2="${top + h - 2}" stroke="#223C50" stroke-width="0.5" opacity="0.3"/>`);
    for (let k = 0; k < deck.tiles.length; k++) {
      p.push(`<rect x="${x0 + 3}" y="${top + k * T + T / 2 - 1}" width="2" height="2" fill="#2A4A60" opacity="0.5"/>`);
      p.push(`<rect x="${x0 + w - 5}" y="${top + k * T + T / 2 - 1}" width="2" height="2" fill="#2A4A60" opacity="0.5"/>`);
    }
    const n = di === 0 ? 3 : di === ship.decks.length - 1 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const px = ox + (l + (di % 2 ? 3 : 2) + k * 2) * T + T / 2 - 3, py = top + Math.floor(deck.tiles.length / 2) * T + T / 2 - 2;
      p.push(`<rect x="${px - 1}" y="${py - 1}" width="8" height="6" fill="#1A3A4A" rx="1"/><rect x="${px}" y="${py}" width="6" height="4" fill="${deck.glow?.accent || '#3A8A9A'}" opacity="0.6" rx="1"/>`);
    }
  });
  const cx = ox + geo.cols * T / 2;
  p.push(`<line x1="${cx}" y1="${oy - 16}" x2="${cx}" y2="${oy}" stroke="#2A4A60" stroke-width="2"/>`);
  p.push(`<path d="M ${cx - 8} ${oy - 12} Q ${cx} ${oy - 20} ${cx + 8} ${oy - 12}" fill="none" stroke="#2D5A6A" stroke-width="1.5" opacity="0.6"/>`);
  p.push(`<text x="${cx}" y="${oy + 3 * T + T / 2}" text-anchor="middle" font-family='"Press Start 2P", monospace' font-size="6" fill="#2D5A6A" opacity="0.5" letter-spacing="2">${ship.name.toUpperCase().replace(/[<&>]/g, '')}</text>`);
  p.push('</g>');
  return p.join('');
}

function plumeSVG(cols, hullBottom) {
  const shipW = cols * TILE;
  const cx = LABEL_W + shipW / 2;
  const top = hullBottom + 24;
  const halfW = shipW * 0.65, len = shipW * 4;
  const nozzleHalf = 1.25 * TILE;
  const fire = len * 0.15, tail = len * 0.85;
  const peak = nozzleHalf + (halfW - nozzleHalf) * Math.sin(0.7 * Math.PI);
  const widthAt = (d) => d < fire ? nozzleHalf + (halfW - nozzleHalf) * Math.sin(d / fire * Math.PI * 0.7) : Math.max(2, peak * Math.pow(1 - Math.min((d - fire) / tail, 1), 0.6));
  const L = [], R = [];
  for (let i = 0; i <= 60; i++) { const d = i / 60 * len; const w = widthAt(d); L.push(`${cx - w},${top + d}`); R.push(`${cx + w},${top + d}`); }
  const outline = `M ${L.join(' L ')} L ${R.reverse().join(' L ')} Z`;
  const cL = [], cR = [];
  for (let i = 0; i <= 30; i++) { const t = i / 30, d = t * fire * 1.5; const w = Math.max(1, widthAt(d) * (0.4 - t * 0.25)); cL.push(`${cx - w},${top + d}`); cR.push(`${cx + w},${top + d}`); }
  const core = `M ${cL.join(' L ')} L ${cR.reverse().join(' L ')} Z`;
  return `<g id="engine-plume" class="engine-exhaust" display="none">
    <path d="${outline}" fill="url(#plume-grad-glow)" filter="url(#torch-glow)" opacity="0.6"><animate attributeName="opacity" values="0.4;0.7;0.4" dur="0.15s" repeatCount="indefinite"/></path>
    <path d="${outline}" fill="url(#plume-grad-main)" opacity="0.9"><animate attributeName="opacity" values="0.8;0.95;0.8" dur="0.08s" repeatCount="indefinite"/></path>
    <path d="${core}" fill="#FFFFFF" opacity="0.8"><animate attributeName="opacity" values="0.7;0.9;0.7" dur="0.05s" repeatCount="indefinite"/></path>
    <ellipse cx="${cx}" cy="${top + fire * 0.35}" rx="${halfW * 1.4}" ry="${fire * 0.8}" fill="#FFFFFF" opacity="0.05" filter="url(#torch-bloom)"/>
  </g>`;
}

function nozzleSVG(cols, hullBottom) {
  const cx = LABEL_W + cols * TILE / 2;
  const P = 4, topW = 5 * TILE, botW = 2.5 * TILE;
  const p = ['<g id="engine-nozzle">'];
  for (let r = 0; r < 6; r++) {
    const t = r / 5, w = topW - t * (topW - botW), s = Math.round(14 + t * 8), h = Math.round(35 + t * 15);
    p.push(`<rect x="${cx - w / 2}" y="${hullBottom + r * P}" width="${w}" height="${P}" fill="rgb(${s},${s + 12},${s + 20})" stroke="rgb(${h},${h + 20},${h + 30})" stroke-width="0.5"/>`);
  }
  p.push(`<rect x="${cx - botW / 4}" y="${hullBottom + P}" width="${botW / 2}" height="${5 * P}" fill="#060C14" opacity="0.7"/>`);
  p.push('</g>');
  return p.join('');
}

// ---- PER-FRAME UPDATE ----

export function spriteKey(m, g) {
  const floating = g < 0.01;
  const suit = m.suit?.wearing;
  const seat = seatKind(m.seat);
  if (seat === 'medbay') return 'medbay';
  if (seat === 'couch') return suit ? 'suitedSecured' : 'secured';
  if (seat === 'bunk') return 'sleeping';
  if (seat === 'helm' || seat === 'ops' || seat === 'engStation') return suit ? 'suitedSecured' : 'seated';
  if (m.dead || !isConscious(m) || m.task?.type === 'carried') {
    if (suit) return floating ? 'suitedProneFloat' : 'suitedProne';
    return floating ? 'unconsciousFloat' : 'unconsciousFloor';
  }
  if (m.gState === 'prone' || m.conditions.includes('crushed')) return suit ? 'suitedProne' : 'prone';
  if (floating) return suit ? 'suitedFloat' : 'floating';
  return suit ? 'suited' : 'standing';
}

export function updateShipView(state, alpha) {
  if (!root) return;
  const f = state.flight;
  const g = f.thrustG + f.rcsG;
  const selected = ui.selection.crew;

  for (const m of state.ship.crew) {
    const el = crewEls.get(m.id);
    if (!el) continue;
    const px = m.$px ?? m.pos.sx, py = m.$py ?? m.pos.sy;
    let x = px + (m.pos.sx - px) * alpha;
    let y = py + (m.pos.sy - py) * alpha;
    if (m.task?.type === 'carried') x += 0.3;
    el.setAttribute('transform', `translate(${(LABEL_W + x * TILE).toFixed(1)}, ${(OFFSET_Y + y * TILE).toFixed(1)})`);
    setCrewSprite(el, spriteKey(m, g));
    el.classList.toggle('selected', selected === m.id);
    el.classList.toggle('crew-dead', !!m.dead);
  }

  // Torch: visible whenever the main drive is lit, brightness ∝ thrust
  if (plumeEl) {
    const on = f.thrustG > 0.02;
    plumeEl.setAttribute('display', on ? 'inline' : 'none');
    if (on) plumeEl.setAttribute('opacity', Math.min(1, 0.35 + Math.sqrt(f.thrustG / 3) * 0.65).toFixed(2));
  }
  const mode = Math.abs(f.turning) > 0.2 ? 'flip' : (Math.abs(f.turning) > 0.001 || f.rcsG > 0.0005) ? 'trim' : null;
  if (mode !== rcsMode) { rcsMode = mode; drawRCS(mode); }

  // Compartment status lights
  const COLORS = { nominal: '#4FD1C5', warning: '#E2A355', critical: '#E25555', breached: '#FF2222', vented: '#FF2222', vacuum: '#661111', unknown: '#3A4E62' };
  state.ship.decks.forEach((d, i) => {
    const dot = atmoDots[i];
    if (dot) {
      const c = COLORS[atmoStatus(d.atmosphere)] || COLORS.unknown;
      if (dot.getAttribute('fill') !== c) dot.setAttribute('fill', c);
    }
  });

  // Tile selection highlight
  root.querySelectorAll('.tile-selected').forEach(t => {
    const s = ui.selection.tile;
    if (!s || +t.dataset.deck !== s.deck || +t.dataset.x !== s.x || +t.dataset.y !== s.y) t.classList.remove('tile-selected');
  });
  const s = ui.selection.tile;
  if (s) root.querySelector(`.tile-interactive[data-deck="${s.deck}"][data-x="${s.x}"][data-y="${s.y}"]`)?.classList.add('tile-selected');
}

function drawRCS(mode) {
  rcsEl?.remove();
  rcsEl = null;
  if (!mode || !hullBox || !root) return;
  const { x, y, width, height } = hullBox;
  const jets = [
    { x: x - 4, y: y + height * 0.15, d: -1, pair: 'a' }, { x: x + width + 4, y: y + height * 0.15, d: 1, pair: 'b' },
    { x: x - 4, y: y + height * 0.78, d: -1, pair: 'b' }, { x: x + width + 4, y: y + height * 0.78, d: 1, pair: 'a' },
  ];
  const parts = jets.map(j => {
    const base = j.x + j.d, tip = base + j.d * 20, core = base + j.d * 12;
    const plume = `${base},${j.y - 2} ${base},${j.y + 2} ${tip},${j.y + 6} ${tip},${j.y - 6}`;
    const coreP = `${base},${j.y - 2} ${base},${j.y + 2} ${core},${j.y + 3} ${core},${j.y - 3}`;
    const vals = mode === 'flip' ? '0.5;0.9;0.6;1;0.5' : j.pair === 'a' ? '0;0.8;0.6;0;0;0;0;0.7;0' : '0;0;0;0;0.7;0.8;0;0;0';
    const dur = mode === 'flip' ? '0.12s' : '2.4s';
    const nz = j.d > 0 ? j.x - 2 : j.x - 4;
    return `<rect x="${nz}" y="${j.y - 5}" width="6" height="10" fill="#1A2A3A" stroke="#3D7A8A" stroke-width="0.5" opacity="0.8"/>
      <polygon points="${plume}" fill="#E2A355" opacity="0" filter="url(#rcs-glow)"><animate attributeName="opacity" values="${vals}" dur="${dur}" repeatCount="indefinite"/></polygon>
      <polygon points="${coreP}" fill="#FFDD77" opacity="0"><animate attributeName="opacity" values="${vals}" dur="${dur}" repeatCount="indefinite"/></polygon>`;
  });
  rcsEl = document.createElementNS(SVG_NS, 'g');
  rcsEl.innerHTML = parts.join('');
  root.appendChild(rcsEl);
}

/** Pause/resume the SVG animations (paused game). */
export function setShipAnimationsPaused(paused) {
  if (!root) return;
  if (paused) root.pauseAnimations(); else root.unpauseAnimations();
}
