// ============================================================
// LONGHAUL — Ship Data Model & Cross-Section Renderer
// Expanse-style vertical ship with hull outline, ambient glow
// ============================================================

import { SVG_NS, TileType, renderTile, renderCrewMember } from './svg-icons.js';

const TILE_SIZE = 32;

// Ship deck definitions — top to bottom (bow to stern)
export function createDefaultShip(crewCount = 4) {
  const T = TileType;

  return {
    name: 'RSV Canterbury',
    decks: [
      {
        name: 'Bridge',
        id: 'bridge',
        glow: { color: 'rgba(91, 192, 235, 0.06)', accent: '#5BC0EB' },
        tiles: [
          [T.EMPTY,     T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.EMPTY],
          [T.HULL_WALL, T.NAV_CONSOLE,T.FLOOR,      T.CONSOLE,    T.FLOOR,      T.CONSOLE,    T.FLOOR,      T.NAV_CONSOLE,T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
          [T.HULL_WALL, T.CONSOLE,    T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.CONSOLE,    T.HULL_WALL],
        ],
      },
      {
        name: 'Quarters',
        id: 'quarters',
        glow: { color: 'rgba(192, 132, 252, 0.04)', accent: '#C084FC' },
        tiles: [
          [T.HULL_WALL, T.BUNK,       T.BUNK,       T.FLOOR,      T.LADDER,     T.FLOOR,      T.BUNK,       T.BUNK,       T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
          [T.HULL_WALL, T.BUNK,       T.BUNK,       T.FLOOR,      T.DOOR,       T.FLOOR,      T.MEDBAY,     T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Mess',
        id: 'mess',
        glow: { color: 'rgba(107, 203, 119, 0.04)', accent: '#6BCB77' },
        tiles: [
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
          [T.HULL_WALL, T.TABLE,      T.FLOOR,      T.TABLE,      T.FLOOR,      T.TABLE,      T.FLOOR,      T.LIFE_SUPPORT, T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Cargo',
        id: 'cargo',
        glow: { color: 'rgba(79, 209, 197, 0.03)', accent: '#4FD1C5' },
        tiles: [
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
          [T.HULL_WALL, T.STORAGE,    T.STORAGE,    T.FLOOR,      T.FLOOR,      T.FLOOR,      T.STORAGE,    T.STORAGE,    T.HULL_WALL],
          [T.HULL_WALL, T.STORAGE,    T.FLOOR,      T.FLOOR,      T.AIRLOCK,    T.FLOOR,      T.FLOOR,      T.STORAGE,    T.HULL_WALL],
        ],
      },
      {
        name: 'Engine',
        id: 'engineering',
        glow: { color: 'rgba(226, 163, 85, 0.06)', accent: '#E2A355' },
        tiles: [
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.LADDER,     T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
          [T.HULL_WALL, T.CONSOLE,    T.FLOOR,      T.ENGINE,     T.FLOOR,      T.ENGINE,     T.FLOOR,      T.CONSOLE,    T.HULL_WALL],
          [T.HULL_WALL, T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.FLOOR,      T.HULL_WALL],
        ],
      },
      {
        name: 'Reactor',
        id: 'reactor',
        glow: { color: 'rgba(226, 85, 85, 0.06)', accent: '#E25555' },
        tiles: [
          [T.EMPTY,     T.HULL_WALL,  T.HULL_WALL,  T.FLOOR,      T.LADDER,     T.FLOOR,      T.HULL_WALL,  T.HULL_WALL,  T.EMPTY],
          [T.EMPTY,     T.HULL_WALL,  T.FLOOR,      T.REACTOR,    T.FLOOR,      T.REACTOR,    T.FLOOR,      T.HULL_WALL,  T.EMPTY],
          [T.EMPTY,     T.EMPTY,      T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.HULL_WALL,  T.EMPTY,      T.EMPTY],
        ],
      },
    ],
    crew: generateCrew(crewCount),
  };
}

function generateCrew(count) {
  const names = ['Chen', 'Nakamura', 'Okafor', 'Petrov', 'Morales', 'Kim', 'Al-Rashid', 'Johansson'];
  const roles = ['Captain', 'Pilot', 'Engineer', 'Medic', 'Gunner', 'Mechanic', 'Scientist', 'Cook'];
  const crew = [];

  const defaultPositions = [
    { deck: 0, x: 3, y: 1 },
    { deck: 0, x: 5, y: 1 },
    { deck: 4, x: 3, y: 1 },
    { deck: 2, x: 3, y: 1 },
    { deck: 1, x: 1, y: 0 },
    { deck: 3, x: 4, y: 1 },
    { deck: 1, x: 6, y: 2 },
    { deck: 4, x: 5, y: 1 },
  ];

  for (let i = 0; i < Math.min(count, 8); i++) {
    const pos = defaultPositions[i];
    crew.push({
      id: i,
      name: names[i],
      role: roles[i],
      deck: pos.deck,
      x: pos.x,
      y: pos.y,
      health: 85 + Math.floor(Math.random() * 15),
      morale: 70 + Math.floor(Math.random() * 30),
    });
  }

  return crew;
}

// ---- HULL OUTLINE BUILDER ----
// Traces the outer edge of non-empty tiles across all decks

function buildHullPath(ship, offsetX, offsetY, deckGap) {
  // Collect all deck bounding info
  const segments = [];
  let currentY = 0;

  ship.decks.forEach((deck) => {
    const deckStartY = currentY;
    const rows = deck.tiles;

    for (let ry = 0; ry < rows.length; ry++) {
      const row = rows[ry];
      let leftMost = -1;
      let rightMost = -1;

      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== TileType.EMPTY) {
          if (leftMost === -1) leftMost = rx;
          rightMost = rx;
        }
      }

      if (leftMost !== -1) {
        segments.push({
          y: deckStartY + ry,
          left: leftMost,
          right: rightMost + 1,
        });
      }
    }

    currentY += rows.length + deckGap;
  });

  if (segments.length === 0) return '';

  // Build path going down the left side, then up the right side
  const pts = [];
  const T = TILE_SIZE;
  const margin = 3; // pixels outside tiles

  // Left side (top to bottom)
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const x = offsetX + s.left * T - margin;
    const y1 = offsetY + s.y * T;
    const y2 = offsetY + (s.y + 1) * T;

    if (i === 0) {
      pts.push(`M ${offsetX + s.left * T} ${y1 - margin}`);
      pts.push(`L ${x} ${y1}`);
    }

    // Step in/out for width changes
    if (i > 0) {
      const prev = segments[i - 1];
      const prevX = offsetX + prev.left * T - margin;
      if (x !== prevX) {
        pts.push(`L ${prevX} ${offsetY + s.y * T}`);
        pts.push(`L ${x} ${offsetY + s.y * T}`);
      }
    }

    pts.push(`L ${x} ${y2}`);
  }

  // Bottom
  const last = segments[segments.length - 1];
  const bottomY = offsetY + (last.y + 1) * T + margin;
  pts.push(`L ${offsetX + last.left * T} ${bottomY}`);
  pts.push(`L ${offsetX + last.right * T} ${bottomY}`);

  // Right side (bottom to top)
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const x = offsetX + s.right * T + margin;
    const y1 = offsetY + (s.y + 1) * T;
    const y2 = offsetY + s.y * T;

    pts.push(`L ${x} ${y1}`);

    if (i > 0) {
      const prev = segments[i - 1];
      const prevX = offsetX + prev.right * T + margin;
      if (x !== prevX) {
        pts.push(`L ${x} ${offsetY + s.y * T}`);
        pts.push(`L ${prevX} ${offsetY + s.y * T}`);
      }
    }

    pts.push(`L ${x} ${y2}`);
  }

  // Close at top
  const first = segments[0];
  pts.push(`L ${offsetX + first.right * T} ${offsetY + first.y * T - margin}`);
  pts.push('Z');

  return pts.join(' ');
}

// ---- SHIP RENDERER ----

export function renderShip(ship, container, onCrewClick) {
  container.innerHTML = '';

  const maxWidth = Math.max(...ship.decks.map(d => d.tiles[0].length));
  const totalRows = ship.decks.reduce((sum, d) => sum + d.tiles.length, 0);
  const deckGap = 1;
  const totalHeight = totalRows + (ship.decks.length - 1) * deckGap;
  const labelWidth = 100;

  const svgWidth = maxWidth * TILE_SIZE + labelWidth + 40;
  const svgHeight = totalHeight * TILE_SIZE + 60;

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('width', svgWidth);
  svgEl.setAttribute('height', svgHeight);
  svgEl.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svgEl.setAttribute('shape-rendering', 'crispEdges');
  svgEl.style.display = 'block';

  const offsetX = labelWidth;
  const offsetY = 20;

  // --- DEFS (filters for glow) ---
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `
    <filter id="hull-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="ambient-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
  `;
  svgEl.appendChild(defs);

  // --- HULL OUTLINE (behind everything) ---
  const hullPath = buildHullPath(ship, offsetX, offsetY, deckGap);
  if (hullPath) {
    // Hull glow
    const hullGlow = document.createElementNS(SVG_NS, 'path');
    hullGlow.setAttribute('d', hullPath);
    hullGlow.setAttribute('fill', 'none');
    hullGlow.setAttribute('stroke', '#2D5A6A');
    hullGlow.setAttribute('stroke-width', '6');
    hullGlow.setAttribute('filter', 'url(#hull-glow)');
    hullGlow.setAttribute('opacity', '0.3');
    svgEl.appendChild(hullGlow);

    // Hull outline
    const hullOutline = document.createElementNS(SVG_NS, 'path');
    hullOutline.setAttribute('d', hullPath);
    hullOutline.setAttribute('fill', 'none');
    hullOutline.setAttribute('stroke', '#2D5A6A');
    hullOutline.setAttribute('stroke-width', '2');
    hullOutline.setAttribute('opacity', '0.6');
    svgEl.appendChild(hullOutline);
  }

  // --- RENDER DECKS ---
  let currentY = 0;

  ship.decks.forEach((deck, deckIndex) => {
    const deckStartY = currentY;
    const deckHeight = deck.tiles.length;

    // Deck group for hover highlighting
    const deckGroup = document.createElementNS(SVG_NS, 'g');
    deckGroup.setAttribute('class', 'deck-group');
    deckGroup.setAttribute('data-deck', deckIndex);

    // Ambient glow behind this deck
    if (deck.glow) {
      const glowRect = document.createElementNS(SVG_NS, 'rect');
      glowRect.setAttribute('x', offsetX + TILE_SIZE);
      glowRect.setAttribute('y', offsetY + deckStartY * TILE_SIZE);
      glowRect.setAttribute('width', (maxWidth - 2) * TILE_SIZE);
      glowRect.setAttribute('height', deckHeight * TILE_SIZE);
      glowRect.setAttribute('fill', deck.glow.color);
      glowRect.setAttribute('filter', 'url(#ambient-glow)');
      deckGroup.appendChild(glowRect);
    }

    // Deck highlight overlay (shown on hover via CSS)
    const highlight = document.createElementNS(SVG_NS, 'rect');
    highlight.setAttribute('x', offsetX);
    highlight.setAttribute('y', offsetY + deckStartY * TILE_SIZE);
    highlight.setAttribute('width', maxWidth * TILE_SIZE);
    highlight.setAttribute('height', deckHeight * TILE_SIZE);
    highlight.setAttribute('fill', 'rgba(79, 209, 197, 0.03)');
    highlight.setAttribute('class', 'deck-highlight');
    deckGroup.appendChild(highlight);

    // Render tiles
    deck.tiles.forEach((row, ry) => {
      row.forEach((tile, rx) => {
        if (tile !== TileType.EMPTY) {
          const tileGroup = renderTile(tile, 0, 0, null);
          tileGroup.setAttribute('transform',
            `translate(${offsetX + rx * TILE_SIZE}, ${offsetY + (deckStartY + ry) * TILE_SIZE})`);
          deckGroup.appendChild(tileGroup);
        }
      });
    });

    svgEl.appendChild(deckGroup);

    // Deck label (outside the group so it doesn't trigger hover)
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', labelWidth - 10);
    label.setAttribute('y', offsetY + (deckStartY + deckHeight / 2) * TILE_SIZE + 3);
    label.setAttribute('class', 'deck-label');
    label.setAttribute('font-family', '"Press Start 2P", monospace');
    label.setAttribute('font-size', '7');
    label.setAttribute('fill', '#3A4E62');
    label.setAttribute('text-anchor', 'end');
    label.textContent = deck.name.toUpperCase();
    svgEl.appendChild(label);

    // Deck indicator — small colored dot
    const dot = document.createElementNS(SVG_NS, 'rect');
    dot.setAttribute('x', labelWidth - 6);
    dot.setAttribute('y', offsetY + (deckStartY + deckHeight / 2) * TILE_SIZE - 1);
    dot.setAttribute('width', 3);
    dot.setAttribute('height', 3);
    dot.setAttribute('fill', deck.glow ? deck.glow.accent : '#3A4E62');
    dot.setAttribute('opacity', '0.6');
    svgEl.appendChild(dot);

    // Deck separator
    if (deckIndex < ship.decks.length - 1) {
      const sepY = offsetY + (deckStartY + deckHeight) * TILE_SIZE + (deckGap * TILE_SIZE) / 2;

      // Structural connectors (small hull pieces between decks)
      const connL = document.createElementNS(SVG_NS, 'rect');
      connL.setAttribute('x', offsetX);
      connL.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connL.setAttribute('width', TILE_SIZE);
      connL.setAttribute('height', deckGap * TILE_SIZE);
      connL.setAttribute('fill', '#0C1420');
      connL.setAttribute('stroke', '#162030');
      connL.setAttribute('stroke-width', '1');
      svgEl.appendChild(connL);

      const connR = document.createElementNS(SVG_NS, 'rect');
      connR.setAttribute('x', offsetX + (maxWidth - 1) * TILE_SIZE);
      connR.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connR.setAttribute('width', TILE_SIZE);
      connR.setAttribute('height', deckGap * TILE_SIZE);
      connR.setAttribute('fill', '#0C1420');
      connR.setAttribute('stroke', '#162030');
      connR.setAttribute('stroke-width', '1');
      svgEl.appendChild(connR);

      // Center ladder shaft connector
      const ladderX = 4; // ladder column
      const connC = document.createElementNS(SVG_NS, 'rect');
      connC.setAttribute('x', offsetX + ladderX * TILE_SIZE + 8);
      connC.setAttribute('y', offsetY + (deckStartY + deckHeight) * TILE_SIZE);
      connC.setAttribute('width', TILE_SIZE - 16);
      connC.setAttribute('height', deckGap * TILE_SIZE);
      connC.setAttribute('fill', '#0C1420');
      connC.setAttribute('stroke', '#3A4A5A');
      connC.setAttribute('stroke-width', '0.5');
      svgEl.appendChild(connC);
    }

    currentY += deckHeight + deckGap;
  });

  // --- RENDER CREW (on top of tiles) ---
  const crewLayer = document.createElementNS(SVG_NS, 'g');
  crewLayer.setAttribute('class', 'crew-layer');

  let crewCurrentY = 0;
  ship.decks.forEach((deck, deckIndex) => {
    const deckStartY = crewCurrentY;

    ship.crew.forEach((member, memberIdx) => {
      if (member.deck === deckIndex) {
        const crewEl = renderCrewMember(0, 0, memberIdx, `${member.name} (${member.role})`);
        crewEl.setAttribute('transform',
          `translate(${offsetX + member.x * TILE_SIZE}, ${offsetY + (deckStartY + member.y) * TILE_SIZE})`);
        crewEl.setAttribute('data-crew-id', member.id);

        if (onCrewClick) {
          crewEl.addEventListener('click', () => onCrewClick(member));
        }

        crewLayer.appendChild(crewEl);
      }
    });

    crewCurrentY += deck.tiles.length + deckGap;
  });

  svgEl.appendChild(crewLayer);

  // --- TORCH ENGINE PLUME (below reactor) ---
  // Massive Epstein drive plume: 30% wider than ship, extends way past viewport
  // The ship cross-section shows only the base of the plume — the rest is clipped.
  // Tactical view will show the full scale.
  const exhaustY = offsetY + (currentY - deckGap) * TILE_SIZE;
  const shipWidth = maxWidth * TILE_SIZE;
  const nozzleCenterX = offsetX + maxWidth * TILE_SIZE / 2;

  // Plume is 30% wider than the ship on each side
  const plumeHalfW = shipWidth * 0.65; // 130% of ship width / 2
  const plumeLength = shipWidth * 4;   // 4x ship width long (mostly clipped)

  // Add plume glow filters to defs
  defs.innerHTML += `
    <filter id="torch-glow" x="-100%" y="-50%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="12" result="blur1"/>
      <feGaussianBlur stdDeviation="28" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur2"/>
        <feMergeNode in="blur1"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="torch-bloom" x="-200%" y="-100%" width="500%" height="400%">
      <feGaussianBlur stdDeviation="40"/>
    </filter>
  `;

  const exhaust = document.createElementNS(SVG_NS, 'g');
  exhaust.setAttribute('class', 'engine-exhaust');
  exhaust.setAttribute('id', 'engine-plume');
  exhaust.setAttribute('display', 'none'); // OFF by default

  // Build the plume as expanding cone sections
  const sections = [];
  const numSections = 20;
  for (let i = 0; i < numSections; i++) {
    const t = i / numSections;
    const y = exhaustY + t * plumeLength;
    const h = plumeLength / numSections;
    // Cone expands: starts at nozzle width, reaches plumeHalfW
    const nozzleHalfW = 16;
    const w = nozzleHalfW + (plumeHalfW - nozzleHalfW) * Math.pow(t, 0.6);
    // Opacity decreases, color shifts from white to blue
    const opacity = Math.max(0.03, 1.0 - t * 0.9);
    // Color: white core fades to blue-white
    const r = Math.round(255 - t * 80);
    const g = Math.round(255 - t * 50);
    const b = 255;
    const color = `rgb(${r},${g},${b})`;

    sections.push(`<rect x="${nozzleCenterX - w}" y="${y}" width="${w * 2}" height="${h + 2}"
      fill="${color}" opacity="${opacity.toFixed(3)}">
      <animate attributeName="opacity"
        values="${(opacity * 0.85).toFixed(3)};${opacity.toFixed(3)};${(opacity * 0.85).toFixed(3)}"
        dur="${(0.06 + t * 0.15).toFixed(2)}s" repeatCount="indefinite"/>
    </rect>`);
  }

  // Inner core: very narrow, pure white, hottest part
  const coreH = plumeLength * 0.4;
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const y = exhaustY + t * coreH;
    const h = coreH / 8;
    const w = 10 + t * 6;
    const op = 1.0 - t * 0.3;
    sections.push(`<rect x="${nozzleCenterX - w}" y="${y}" width="${w * 2}" height="${h + 1}"
      fill="#FFFFFF" opacity="${op.toFixed(2)}">
      <animate attributeName="opacity"
        values="${(op * 0.9).toFixed(2)};${op.toFixed(2)};${(op * 0.9).toFixed(2)}"
        dur="${(0.04 + t * 0.08).toFixed(2)}s" repeatCount="indefinite"/>
    </rect>`);
  }

  // Exhaust particles — streaking out from nozzle
  for (let i = 0; i < 8; i++) {
    const px = nozzleCenterX + (Math.random() - 0.5) * 30;
    const startY = exhaustY + 10;
    const endY = exhaustY + 100 + Math.random() * 120;
    const dur = (0.3 + Math.random() * 0.4).toFixed(2);
    const begin = (Math.random() * 0.5).toFixed(2);
    const size = 2;
    const colors = ['#FFFFFF', '#D0E8FF', '#8ECAFF', '#FFFFFF'];
    const col = colors[i % colors.length];
    sections.push(`<rect x="${px}" y="${startY}" width="${size}" height="${size}" fill="${col}" opacity="0">
      <animate attributeName="opacity" values="0;0.9;0.4;0" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${startY};${endY}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>
    </rect>`);
  }

  // Massive bloom glow behind everything
  sections.push(`<rect x="${nozzleCenterX - plumeHalfW}" y="${exhaustY - 20}"
    width="${plumeHalfW * 2}" height="${plumeLength * 0.6}"
    fill="#FFFFFF" opacity="0.08" filter="url(#torch-bloom)">
    <animate attributeName="opacity" values="0.05;0.1;0.05" dur="0.2s" repeatCount="indefinite"/>
  </rect>`);

  // Nozzle ring (on top)
  sections.push(`<rect x="${nozzleCenterX - 22}" y="${exhaustY - 3}" width="44" height="5" fill="#1A2A3A"/>`);

  exhaust.innerHTML = sections.join('\n');
  svgEl.appendChild(exhaust);

  container.appendChild(svgEl);
}

// ---- TACTICAL VIEW RENDERER ----
// Shows the ship as a tiny outline with a massive plume when thrusting.
// The plume dwarfs the ship 10-20:1 — true Epstein drive scale.

export function renderTacView(ship, container, thrustActive) {
  container.innerHTML = '';

  const viewW = container.clientWidth || 186;
  const viewH = container.clientHeight || 220;

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('width', viewW);
  svgEl.setAttribute('height', viewH);
  svgEl.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
  svgEl.setAttribute('shape-rendering', 'crispEdges');

  // Grid lines (subtle)
  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('opacity', '0.08');
  const gridSpacing = 20;
  for (let x = gridSpacing; x < viewW; x += gridSpacing) {
    gridGroup.innerHTML += `<line x1="${x}" y1="0" x2="${x}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>`;
  }
  for (let y = gridSpacing; y < viewH; y += gridSpacing) {
    gridGroup.innerHTML += `<line x1="0" y1="${y}" x2="${viewW}" y2="${y}" stroke="#4FD1C5" stroke-width="0.5"/>`;
  }
  svgEl.appendChild(gridGroup);

  // Range rings (concentric from ship center)
  const cx = viewW / 2;
  const cy = viewH / 2; // ship centered
  const shipY = cy;
  const ringGroup = document.createElementNS(SVG_NS, 'g');
  ringGroup.setAttribute('opacity', '0.06');
  [30, 60, 90].forEach(r => {
    ringGroup.innerHTML += `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="#4FD1C5" stroke-width="0.5"/>`;
  });
  svgEl.appendChild(ringGroup);

  // Crosshair at center
  const chGroup = document.createElementNS(SVG_NS, 'g');
  chGroup.setAttribute('opacity', '0.1');
  chGroup.innerHTML = `
    <line x1="${cx}" y1="0" x2="${cx}" y2="${viewH}" stroke="#4FD1C5" stroke-width="0.5"/>
    <line x1="0" y1="${cy}" x2="${viewW}" y2="${cy}" stroke="#4FD1C5" stroke-width="0.5"/>
  `;
  svgEl.appendChild(chGroup);

  // Ship outline — actual hull path scaled down to fit tac view
  const deckGapTac = 1;
  const hullPath = buildHullPath(ship, 0, 0, deckGapTac);

  // Compute the hull bounding box from ship data
  const maxTileCols = Math.max(...ship.decks.map(d => d.tiles[0].length));
  const totalTileRows = ship.decks.reduce((sum, d) => sum + d.tiles.length, 0);
  const totalWithGaps = totalTileRows + (ship.decks.length - 1) * deckGapTac;
  const hullRawW = maxTileCols * TILE_SIZE;
  const hullRawH = totalWithGaps * TILE_SIZE;

  // Scale to fit roughly 20px wide in tac view (small but recognizable)
  const targetW = 16;
  const scaleFactor = targetW / hullRawW;
  const shipH = hullRawH * scaleFactor;

  const shipGroup = document.createElementNS(SVG_NS, 'g');
  if (hullPath) {
    // Transform: scale down and translate so hull is centered at (cx, cy)
    const tx = cx - (hullRawW * scaleFactor) / 2;
    const ty = cy - (hullRawH * scaleFactor) / 2;

    const hullEl = document.createElementNS(SVG_NS, 'path');
    hullEl.setAttribute('d', hullPath);
    hullEl.setAttribute('fill', '#0C1420');
    hullEl.setAttribute('stroke', '#2D5A6A');
    hullEl.setAttribute('stroke-width', `${1 / scaleFactor}`);
    hullEl.setAttribute('transform', `translate(${tx},${ty}) scale(${scaleFactor})`);
    shipGroup.appendChild(hullEl);

    // Glow outline
    const hullGlow = document.createElementNS(SVG_NS, 'path');
    hullGlow.setAttribute('d', hullPath);
    hullGlow.setAttribute('fill', 'none');
    hullGlow.setAttribute('stroke', '#3D7A8A');
    hullGlow.setAttribute('stroke-width', `${2 / scaleFactor}`);
    hullGlow.setAttribute('opacity', '0.3');
    hullGlow.setAttribute('transform', `translate(${tx},${ty}) scale(${scaleFactor})`);
    shipGroup.appendChild(hullGlow);
  }

  // Blinking center dot
  shipGroup.innerHTML += `
    <rect x="${cx - 1}" y="${cy - 1}" width="2" height="2" fill="#4FD1C5" opacity="0.8">
      <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite"/>
    </rect>
  `;
  svgEl.appendChild(shipGroup);

  // PLUME — massive, dwarfs the ship
  const plumeGroup = document.createElementNS(SVG_NS, 'g');
  plumeGroup.setAttribute('id', 'tac-plume');
  plumeGroup.setAttribute('display', thrustActive ? 'inline' : 'none');

  if (thrustActive) {
    const plumeStartY = cy + shipH / 2;
    const plumeLen = viewH * 2; // massive — extends far past the tac screen
    const maxPlumeW = viewW * 0.7; // plume fills most of the tac view width

    // Defs for tac plume glow
    const tacDefs = document.createElementNS(SVG_NS, 'defs');
    tacDefs.innerHTML = `
      <filter id="tac-glow" x="-100%" y="-50%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="6"/>
      </filter>
      <filter id="tac-bloom" x="-200%" y="-100%" width="500%" height="400%">
        <feGaussianBlur stdDeviation="14"/>
      </filter>
    `;
    svgEl.appendChild(tacDefs);

    // Outer bloom
    plumeGroup.innerHTML += `<ellipse cx="${cx}" cy="${plumeStartY + plumeLen * 0.3}"
      rx="${maxPlumeW * 0.4}" ry="${plumeLen * 0.4}"
      fill="#FFFFFF" opacity="0.04" filter="url(#tac-bloom)">
      <animate attributeName="opacity" values="0.02;0.06;0.02" dur="0.3s" repeatCount="indefinite"/>
    </ellipse>`;

    // Build expanding cone sections
    const numSections = 16;
    for (let i = 0; i < numSections; i++) {
      const t = i / numSections;
      const y = plumeStartY + t * plumeLen;
      const h = plumeLen / numSections + 1;
      const halfW = 2 + (maxPlumeW / 2 - 2) * Math.pow(t, 0.5);
      const opacity = Math.max(0.02, 0.8 - t * 0.7);
      const r = Math.round(255 - t * 100);
      const g = Math.round(255 - t * 60);
      const color = `rgb(${r},${g},255)`;

      plumeGroup.innerHTML += `<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
        fill="${color}" opacity="${opacity.toFixed(3)}">
        <animate attributeName="opacity"
          values="${(opacity * 0.8).toFixed(3)};${opacity.toFixed(3)};${(opacity * 0.8).toFixed(3)}"
          dur="${(0.08 + t * 0.2).toFixed(2)}s" repeatCount="indefinite"/>
      </rect>`;
    }

    // White-hot inner core
    const coreLen = plumeLen * 0.3;
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      const y = plumeStartY + t * coreLen;
      const h = coreLen / 6 + 1;
      const halfW = 1.5 + t * 3;
      const op = 1.0 - t * 0.4;
      plumeGroup.innerHTML += `<rect x="${cx - halfW}" y="${y}" width="${halfW * 2}" height="${h}"
        fill="#FFFFFF" opacity="${op.toFixed(2)}">
        <animate attributeName="opacity"
          values="${(op * 0.85).toFixed(2)};${op.toFixed(2)};${(op * 0.85).toFixed(2)}"
          dur="0.06s" repeatCount="indefinite"/>
      </rect>`;
    }

    // Glow halo around nozzle
    plumeGroup.innerHTML += `<ellipse cx="${cx}" cy="${plumeStartY + 4}"
      rx="12" ry="8" fill="#FFFFFF" opacity="0.2" filter="url(#tac-glow)">
      <animate attributeName="opacity" values="0.15;0.3;0.15" dur="0.15s" repeatCount="indefinite"/>
    </ellipse>`;
  }

  svgEl.appendChild(plumeGroup);

  // Ship label
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', cx + targetW / 2 + 4);
  label.setAttribute('y', cy + 2);
  label.setAttribute('font-family', '"Press Start 2P", monospace');
  label.setAttribute('font-size', '4');
  label.setAttribute('fill', '#3A4E62');
  label.textContent = ship.name.substring(0, 10).toUpperCase();
  svgEl.appendChild(label);

  container.appendChild(svgEl);
}
