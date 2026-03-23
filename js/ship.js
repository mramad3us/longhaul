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
  // Epic Epstein drive plume: blindingly white core, blue-white corona
  // Completely dark when off, supernova-bright when firing
  const exhaustY = offsetY + (currentY - deckGap) * TILE_SIZE;
  const exhaustX = offsetX + 3 * TILE_SIZE;
  const nozzleCenterX = exhaustX + 3 * TILE_SIZE / 2; // center of 3-tile reactor base
  const plumeW = TILE_SIZE * 3;

  // Add plume glow filter to defs
  const plumeFilter = document.createElementNS(SVG_NS, 'filter');
  plumeFilter.id = 'torch-glow';
  plumeFilter.setAttribute('x', '-100%');
  plumeFilter.setAttribute('y', '-50%');
  plumeFilter.setAttribute('width', '300%');
  plumeFilter.setAttribute('height', '300%');
  plumeFilter.innerHTML = `
    <feGaussianBlur stdDeviation="8" result="blur1"/>
    <feGaussianBlur stdDeviation="16" result="blur2"/>
    <feMerge>
      <feMergeNode in="blur2"/>
      <feMergeNode in="blur1"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  `;
  defs.appendChild(plumeFilter);

  const exhaust = document.createElementNS(SVG_NS, 'g');
  exhaust.setAttribute('class', 'engine-exhaust');
  exhaust.setAttribute('id', 'engine-plume');
  exhaust.setAttribute('display', 'none'); // OFF by default

  // Nozzle opening (always dark metallic)
  const nozzleY = exhaustY - 2;
  exhaust.innerHTML = `
    <!-- Nozzle ring -->
    <rect x="${nozzleCenterX - 20}" y="${nozzleY}" width="40" height="4" fill="#1A2A3A"/>

    <!-- PLUME CORE: pure white, maximum intensity -->
    <rect x="${nozzleCenterX - 12}" y="${exhaustY}" width="24" height="8" fill="#FFFFFF" opacity="1">
      <animate attributeName="opacity" values="0.95;1;0.95" dur="0.08s" repeatCount="indefinite"/>
    </rect>
    <!-- Core taper -->
    <rect x="${nozzleCenterX - 10}" y="${exhaustY + 8}" width="20" height="8" fill="#FFFFFF" opacity="0.95">
      <animate attributeName="opacity" values="0.85;0.95;0.85" dur="0.1s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX - 8}" y="${exhaustY + 16}" width="16" height="8" fill="#FFFFFF" opacity="0.9">
      <animate attributeName="opacity" values="0.8;0.95;0.8" dur="0.12s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX - 6}" y="${exhaustY + 24}" width="12" height="8" fill="#F0F4FF" opacity="0.85">
      <animate attributeName="opacity" values="0.7;0.9;0.7" dur="0.15s" repeatCount="indefinite"/>
      <animate attributeName="height" values="8;12;8" dur="0.2s" repeatCount="indefinite"/>
    </rect>

    <!-- INNER CORONA: blue-white -->
    <rect x="${nozzleCenterX - 16}" y="${exhaustY + 2}" width="4" height="14" fill="#D0E8FF" opacity="0.8">
      <animate attributeName="opacity" values="0.6;0.9;0.6" dur="0.12s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX + 12}" y="${exhaustY + 2}" width="4" height="14" fill="#D0E8FF" opacity="0.8">
      <animate attributeName="opacity" values="0.7;0.95;0.7" dur="0.1s" repeatCount="indefinite"/>
    </rect>

    <!-- OUTER CORONA: spreading blue glow -->
    <rect x="${nozzleCenterX - 20}" y="${exhaustY + 4}" width="4" height="10" fill="#8ECAFF" opacity="0.5">
      <animate attributeName="opacity" values="0.3;0.6;0.3" dur="0.15s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX + 16}" y="${exhaustY + 4}" width="4" height="10" fill="#8ECAFF" opacity="0.5">
      <animate attributeName="opacity" values="0.35;0.65;0.35" dur="0.13s" repeatCount="indefinite"/>
    </rect>

    <!-- PLUME TAIL: fading blue-white tendrils -->
    <rect x="${nozzleCenterX - 4}" y="${exhaustY + 32}" width="8" height="6" fill="#B0D8FF" opacity="0.6">
      <animate attributeName="opacity" values="0.3;0.7;0.3" dur="0.2s" repeatCount="indefinite"/>
      <animate attributeName="height" values="6;14;6" dur="0.3s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX - 2}" y="${exhaustY + 40}" width="4" height="4" fill="#80B8FF" opacity="0.4">
      <animate attributeName="opacity" values="0.1;0.5;0.1" dur="0.25s" repeatCount="indefinite"/>
      <animate attributeName="height" values="4;10;4" dur="0.35s" repeatCount="indefinite"/>
    </rect>

    <!-- EXHAUST PARTICLES: white-hot sparks shooting out -->
    <rect x="${nozzleCenterX - 1}" y="${exhaustY + 46}" width="2" height="2" fill="#FFFFFF" opacity="0">
      <animate attributeName="opacity" values="0;0.9;0.5;0" dur="0.4s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${exhaustY + 46};${exhaustY + 70}" dur="0.4s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX + 3}" y="${exhaustY + 44}" width="2" height="2" fill="#D0E8FF" opacity="0">
      <animate attributeName="opacity" values="0;0.7;0.3;0" dur="0.5s" begin="0.15s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${exhaustY + 44};${exhaustY + 68}" dur="0.5s" begin="0.15s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX - 5}" y="${exhaustY + 48}" width="2" height="2" fill="#FFFFFF" opacity="0">
      <animate attributeName="opacity" values="0;0.8;0.2;0" dur="0.35s" begin="0.08s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${exhaustY + 48};${exhaustY + 72}" dur="0.35s" begin="0.08s" repeatCount="indefinite"/>
    </rect>
    <rect x="${nozzleCenterX + 5}" y="${exhaustY + 42}" width="2" height="2" fill="#8ECAFF" opacity="0">
      <animate attributeName="opacity" values="0;0.6;0" dur="0.6s" begin="0.25s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${exhaustY + 42};${exhaustY + 66}" dur="0.6s" begin="0.25s" repeatCount="indefinite"/>
    </rect>

    <!-- GLOW: massive bloom effect behind everything -->
    <rect x="${nozzleCenterX - 24}" y="${exhaustY - 4}" width="48" height="56" fill="#FFFFFF" opacity="0.15" filter="url(#torch-glow)">
      <animate attributeName="opacity" values="0.1;0.2;0.1" dur="0.15s" repeatCount="indefinite"/>
    </rect>
  `;
  svgEl.appendChild(exhaust);

  container.appendChild(svgEl);
}
