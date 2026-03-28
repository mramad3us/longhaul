// ============================================================
// LONGHAUL — Solar System Map
// Scale-accurate solar system with planets, moons, asteroids.
// Pan/zoom SVG navigation display.
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const AU = 149_597_870.7; // km per AU
const TWO_PI = Math.PI * 2;

// ---- SOLAR SYSTEM DATA ----
// Distances in AU, orbital periods in Earth days, radii in km

const SUN = {
  name: 'Sol', radius: 696_000, color: '#FDB813',
  glowColor: 'rgba(253, 184, 19, 0.3)',
};

export const PLANETS = [
  {
    name: 'Mercury', a: 0.387, period: 87.97, radius: 2_440,
    color: '#A0926E', initAngle: 1.2, moons: [],
  },
  {
    name: 'Venus', a: 0.723, period: 224.7, radius: 6_052,
    color: '#E8CDA0', initAngle: 3.8, moons: [],
  },
  {
    name: 'Earth', a: 1.0, period: 365.25, radius: 6_371,
    color: '#4A90D9', initAngle: 0.0, moons: [
      { name: 'Luna', a: 384_400 / AU, period: 27.3, color: '#AAA', initAngle: 0 },
    ],
  },
  {
    name: 'Mars', a: 1.524, period: 687, radius: 3_390,
    color: '#C1553B', initAngle: 4.5, moons: [
      { name: 'Phobos', a: 9_377 / AU, period: 0.32, color: '#887', initAngle: 0.5 },
      { name: 'Deimos', a: 23_460 / AU, period: 1.26, color: '#776', initAngle: 2.1 },
    ],
  },
  {
    name: 'Jupiter', a: 5.203, period: 4_333, radius: 69_911,
    color: '#C4A882', initAngle: 2.1, moons: [
      { name: 'Io', a: 421_800 / AU, period: 1.77, color: '#DA5', initAngle: 0 },
      { name: 'Europa', a: 671_100 / AU, period: 3.55, color: '#ACD', initAngle: 1.5 },
      { name: 'Ganymede', a: 1_070_400 / AU, period: 7.15, color: '#998', initAngle: 3.0 },
      { name: 'Callisto', a: 1_882_700 / AU, period: 16.69, color: '#665', initAngle: 4.5 },
    ],
  },
  {
    name: 'Saturn', a: 9.537, period: 10_759, radius: 58_232,
    color: '#E8D5A3', initAngle: 5.2, moons: [
      { name: 'Mimas', a: 185_539 / AU, period: 0.94, color: '#BBB', initAngle: 0 },
      { name: 'Enceladus', a: 238_042 / AU, period: 1.37, color: '#CEE', initAngle: 1.0 },
      { name: 'Tethys', a: 294_619 / AU, period: 1.89, color: '#AAA', initAngle: 2.0 },
      { name: 'Dione', a: 377_396 / AU, period: 2.74, color: '#999', initAngle: 3.0 },
      { name: 'Rhea', a: 527_108 / AU, period: 4.52, color: '#AAA', initAngle: 4.0 },
      { name: 'Titan', a: 1_221_870 / AU, period: 15.95, color: '#D9A54A', initAngle: 5.0 },
      { name: 'Iapetus', a: 3_560_820 / AU, period: 79.3, color: '#776', initAngle: 0.5 },
    ],
  },
  {
    name: 'Uranus', a: 19.19, period: 30_687, radius: 25_362,
    color: '#7EC8D9', initAngle: 0.8, moons: [],
  },
  {
    name: 'Neptune', a: 30.07, period: 60_190, radius: 24_622,
    color: '#4B6EAF', initAngle: 4.0, moons: [],
  },
];

// Major asteroid belt objects
export const ASTEROIDS = [
  { name: 'Ceres', a: 2.77, period: 1_682, color: '#8A8A7A', initAngle: 1.0 },
  { name: 'Vesta', a: 2.36, period: 1_325, color: '#9A8A6A', initAngle: 3.5 },
  { name: 'Pallas', a: 2.77, period: 1_686, color: '#7A7A6A', initAngle: 5.8 },
  { name: 'Hygiea', a: 3.14, period: 2_030, color: '#6A6A5A', initAngle: 0.3 },
  { name: 'Juno', a: 2.67, period: 1_594, color: '#8A7A6A', initAngle: 2.2 },
  { name: 'Interamnia', a: 3.06, period: 1_950, color: '#7A6A5A', initAngle: 4.1 },
];

// Background asteroid belt dust — random orbital positions for visual filler
const BELT_DUST = [];
for (let i = 0; i < 400; i++) {
  BELT_DUST.push({
    a: 2.1 + Math.random() * 1.3,
    angle: Math.random() * TWO_PI,
    size: 0.2 + Math.random() * 0.8,
    brightness: 0.1 + Math.random() * 0.3,
  });
}

// Background star field — fixed screen-space stars for atmosphere
// Uses a seeded pattern so stars don't flicker on re-render
const BG_STARS = [];
for (let i = 0; i < 200; i++) {
  BG_STARS.push({
    // Normalized screen coords [0, 1]
    nx: (Math.sin(i * 127.1 + 311.7) * 0.5 + 0.5),
    ny: (Math.sin(i * 269.5 + 183.3) * 0.5 + 0.5),
    brightness: 0.15 + (Math.sin(i * 43.7) * 0.5 + 0.5) * 0.4,
    size: 0.3 + (Math.sin(i * 91.3) * 0.5 + 0.5) * 0.8,
  });
}

// ---- ORBITAL POSITION CALCULATION ----

function orbitalPos(body, daysSinceStart) {
  const angle = body.initAngle + (TWO_PI * daysSinceStart / body.period);
  return {
    x: body.a * Math.cos(angle),
    y: body.a * Math.sin(angle),
    angle,
  };
}

// ---- SOLAR MAP STATE ----

let mapState = {
  cx: 0, cy: 0, // center in AU
  zoom: 35, // half-width of viewBox in AU (35 = full system)
  minZoom: 0.0005, // close enough to see moon orbits
  maxZoom: 40,
  dragging: false,
  dragStart: null,
  dragCenterStart: null,
  hoveredBody: null,
  selectedBody: null,      // { name, type, x, y } — selected for route planning
};

// Track rendered body positions for click detection
let bodyPositions = []; // [{ name, type, x, y, r, parentName }]
let onBodySelectCallback = null;

export function resetMapState() {
  mapState.cx = 0;
  mapState.cy = 0;
  mapState.zoom = 35;
  mapState.hoveredBody = null;
  mapState.selectedBody = null;
}

export function setSelectedBody(body) {
  mapState.selectedBody = body;
}

export function getSelectedBody() {
  return mapState.selectedBody;
}

export function setOnBodySelect(cb) {
  onBodySelectCallback = cb;
}

// ---- ZOOM PRESETS ----
export const SOLAR_ZOOM_PRESETS = [
  { name: 'System', zoom: 35, cx: 0, cy: 0 },
  { name: 'Inner', zoom: 2.5, cx: 0, cy: 0 },
  { name: 'Belt', zoom: 4, cx: 0, cy: 0 },
  { name: 'Jupiter', zoom: 8, cx: 0, cy: 0 }, // cx/cy set dynamically
  { name: 'Saturn', zoom: 14, cx: 0, cy: 0 },
];

// ---- RENDER ----

let _renderCount = 0;
let _lastRenderWarn = 0;

export function renderSolarSystem(container, gameState, routeInfo) {
  const t0 = performance.now();
  _renderCount++;
  bodyPositions = [];

  const rect = container.getBoundingClientRect();
  const w = rect.width || 600;
  const h = rect.height || 600;
  const aspect = w / h;

  const halfW = mapState.zoom * aspect;
  const halfH = mapState.zoom;
  const vx = mapState.cx - halfW;
  const vy = mapState.cy - halfH;
  const vw = halfW * 2;
  const vh = halfH * 2;

  // Build SVG as a string — single innerHTML assignment is vastly faster
  // than hundreds of createElement + setAttribute DOM calls
  const parts = [];
  const F = '"Press Start 2P", monospace'; // font shorthand

  // Elapsed days for orbital calculation
  const days = gameState ? gameTimeToDays(gameState.time, gameState.stats) : 0;

  // Defs: filters for glow
  const useFilters = mapState.zoom > 0.05;
  parts.push('<defs>');
  if (useFilters) {
    const blurSun = Math.max(0.001, mapState.zoom * 0.008);
    const blurPlanet = Math.max(0.0005, mapState.zoom * 0.003);
    parts.push(
      `<filter id="sol-glow" x="-200%" y="-200%" width="500%" height="500%">` +
      `<feGaussianBlur stdDeviation="${blurSun}" result="b"/>` +
      `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
      `<filter id="planet-glow" x="-100%" y="-100%" width="300%" height="300%">` +
      `<feGaussianBlur stdDeviation="${blurPlanet}"/></filter>`
    );
  }
  parts.push(
    `<radialGradient id="sun-grad" cx="50%" cy="50%">` +
    `<stop offset="0%" stop-color="#FFF8E0"/>` +
    `<stop offset="30%" stop-color="#FDB813"/>` +
    `<stop offset="70%" stop-color="#E8960A"/>` +
    `<stop offset="100%" stop-color="#C06000" stop-opacity="0"/>` +
    `</radialGradient></defs>`
  );

  // ---- BACKGROUND STAR FIELD ----
  const starR = (vw / w) * 0.8;
  parts.push('<g>');
  BG_STARS.forEach(s => {
    parts.push(`<circle cx="${vx + s.nx * vw}" cy="${vy + s.ny * vh}" r="${starR * s.size}" fill="#FFF" opacity="${s.brightness}"/>`);
  });
  parts.push('</g>');

  // ---- AU DISTANCE RINGS ----
  const ringDistances = mapState.zoom > 15
    ? [1, 2, 3, 5, 10, 20, 30]
    : mapState.zoom > 5
      ? [0.5, 1, 1.5, 2, 3, 5]
      : mapState.zoom > 1
        ? [0.25, 0.5, 1, 1.5, 2]
        : [0.1, 0.25, 0.5, 1];

  const sw001 = mapState.zoom * 0.001;
  const dash005 = mapState.zoom * 0.005;
  parts.push('<g>');
  ringDistances.forEach(r => {
    if (r > mapState.zoom * 1.5) return;
    parts.push(`<circle cx="0" cy="0" r="${r}" fill="none" stroke="#1A2A3A" stroke-width="${sw001}" stroke-dasharray="${dash005} ${dash005}"/>`);
    if (mapState.zoom < 40) {
      parts.push(`<text x="${mapState.zoom * 0.005}" y="${-r + mapState.zoom * 0.012}" fill="#2A4A5A" font-family='${F}' font-size="${mapState.zoom * 0.015}">${r} AU</text>`);
    }
  });
  parts.push('</g>');

  // ---- ASTEROID BELT DUST ----
  const beltInner = 2.0;
  const viewEdge = Math.sqrt((mapState.cx ** 2) + (mapState.cy ** 2)) + halfW * 1.5;
  const beltVisible = mapState.zoom < 20 && viewEdge > beltInner && mapState.zoom > 0.5;
  if (beltVisible) {
    parts.push('<g>');
    const dustStep = mapState.zoom > 8 ? 4 : mapState.zoom > 3 ? 2 : 1;
    for (let i = 0; i < BELT_DUST.length; i += dustStep) {
      const d = BELT_DUST[i];
      const a = d.angle + days * 0.0002;
      parts.push(`<circle cx="${d.a * Math.cos(a)}" cy="${d.a * Math.sin(a)}" r="${sw001 * d.size}" fill="rgba(140,130,110,${d.brightness})"/>`);
    }
    parts.push('</g>');
  }

  // ---- ORBIT PATHS ----
  parts.push('<g>');
  const orbitSW = mapState.zoom * 0.0008;
  PLANETS.forEach(p => {
    if (p.a > mapState.zoom * 1.5) return;
    parts.push(`<circle cx="0" cy="0" r="${p.a}" fill="none" stroke="#152535" stroke-width="${orbitSW}"/>`);
  });
  if (mapState.zoom < 10) {
    const astOrbitSW = mapState.zoom * 0.0004;
    const astDash = `${mapState.zoom * 0.003} ${mapState.zoom * 0.006}`;
    ASTEROIDS.forEach(ast => {
      parts.push(`<circle cx="0" cy="0" r="${ast.a}" fill="none" stroke="#121F2A" stroke-width="${astOrbitSW}" stroke-dasharray="${astDash}"/>`);
    });
  }
  parts.push('</g>');

  // ---- SUN ----
  const sunR = Math.max(mapState.zoom * 0.012, 0.01);
  parts.push(`<circle cx="0" cy="0" r="${sunR * 3}" fill="url(#sun-grad)" opacity="0.4"/>`);
  parts.push(`<circle cx="0" cy="0" r="${sunR}" fill="#FDB813"${useFilters ? ' filter="url(#sol-glow)"' : ''}/>`);
  bodyPositions.push({ name: 'Sol', type: 'star', x: 0, y: 0, r: sunR });

  // Pixel size helper
  const auPerPx = vw / w;
  const minBodyR = auPerPx * 2.5;

  // ---- PLANETS ----
  parts.push('<g>');
  PLANETS.forEach(p => {
    const pos = orbitalPos(p, days);
    if (Math.abs(pos.x - mapState.cx) > halfW * 1.5 ||
        Math.abs(pos.y - mapState.cy) > halfH * 1.5) return;

    const closeZoomBoost = mapState.zoom < 0.2 ? 1.8 : mapState.zoom < 1 ? 1.3 : 1.0;
    const pR = Math.max(minBodyR * closeZoomBoost, mapState.zoom * 0.005);

    if (mapState.zoom < 0.5) {
      parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${pR * 5}" fill="none" stroke="${p.color}" stroke-width="${pR * 0.3}" opacity="0.06"/>`);
    }
    parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${pR * 2.5}" fill="${p.color}" opacity="0.15"${useFilters ? ' filter="url(#planet-glow)"' : ''}/>`);
    parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${pR}" fill="${p.color}"/>`);

    if (mapState.zoom < 1) {
      parts.push(`<circle cx="${pos.x - pR * 0.2}" cy="${pos.y - pR * 0.2}" r="${pR * 0.7}" fill="#FFF" opacity="0.08"/>`);
    }

    bodyPositions.push({ name: p.name, type: 'planet', x: pos.x, y: pos.y, r: pR });

    if (p.name === 'Saturn') {
      parts.push(`<ellipse cx="${pos.x}" cy="${pos.y}" rx="${pR * 2.2}" ry="${pR * 0.6}" fill="none" stroke="#D4C49A" stroke-width="${pR * 0.3}" opacity="0.5"/>`);
    }

    const isSelected = mapState.selectedBody && mapState.selectedBody.name === p.name;
    const labelThreshold = p.a * 0.4;
    if (!isSelected && mapState.zoom < Math.max(labelThreshold, 6)) {
      const fontSize = Math.max(mapState.zoom * 0.012, auPerPx * 8);
      parts.push(`<text x="${pos.x + pR * 1.8}" y="${pos.y + fontSize * 0.3}" fill="${p.color}" font-family='${F}' font-size="${fontSize}" opacity="0.7">${p.name.toUpperCase()}</text>`);
    }

    // Moons
    const moonViewThreshold = p.a * 0.08;
    if (mapState.zoom < moonViewThreshold && p.moons.length > 0) {
      p.moons.forEach(m => {
        const mPos = orbitalPos(m, days);
        const mx = pos.x + mPos.x;
        const my = pos.y + mPos.y;
        const moonOrbitSW = Math.max(mapState.zoom * 0.0004, auPerPx * 0.5);
        const moonDash = `${mapState.zoom * 0.002} ${mapState.zoom * 0.003}`;
        parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${m.a}" fill="none" stroke="#2A4A5A" stroke-width="${moonOrbitSW}" stroke-dasharray="${moonDash}"/>`);

        const mR = Math.max(minBodyR * 0.8, mapState.zoom * 0.003);
        parts.push(`<circle cx="${mx}" cy="${my}" r="${mR * 2}" fill="${m.color}" opacity="0.1"/>`);
        parts.push(`<circle cx="${mx}" cy="${my}" r="${mR}" fill="${m.color}"/>`);

        bodyPositions.push({ name: m.name, type: 'moon', x: mx, y: my, r: mR, parentName: p.name });

        const moonSelected = mapState.selectedBody && mapState.selectedBody.name === m.name;
        if (!moonSelected) {
          const mFontSize = Math.max(mapState.zoom * 0.01, auPerPx * 6);
          parts.push(`<text x="${mx + mR * 2}" y="${my + mFontSize * 0.3}" fill="${m.color}" font-family='${F}' font-size="${mFontSize}" opacity="0.6">${m.name}</text>`);
        }
      });
    }
  });
  parts.push('</g>');

  // ---- NAMED ASTEROIDS ----
  if (mapState.zoom < 10) {
    parts.push('<g>');
    ASTEROIDS.forEach(ast => {
      const pos = orbitalPos(ast, days);
      const aR = Math.max(minBodyR * 0.5, mapState.zoom * 0.002);
      const d = aR;
      parts.push(`<polygon points="${pos.x},${pos.y - d} ${pos.x + d * 0.7},${pos.y} ${pos.x},${pos.y + d * 0.8} ${pos.x - d * 0.6},${pos.y}" fill="${ast.color}" opacity="0.7"/>`);
      bodyPositions.push({ name: ast.name, type: 'asteroid', x: pos.x, y: pos.y, r: aR });

      const astSelected = mapState.selectedBody && mapState.selectedBody.name === ast.name;
      if (!astSelected && mapState.zoom < 5) {
        const fontSize = Math.max(mapState.zoom * 0.01, auPerPx * 7);
        parts.push(`<text x="${pos.x + d * 2}" y="${pos.y + fontSize * 0.3}" fill="${ast.color}" font-family='${F}' font-size="${fontSize}" opacity="0.5">${ast.name}</text>`);
      }
    });
    parts.push('</g>');
  }

  // ---- SHIP POSITION ----
  if (gameState && gameState.shipPosition) {
    const sp = gameState.shipPosition;
    const shipR = Math.max(minBodyR, mapState.zoom * 0.004);
    parts.push(
      `<circle cx="${sp.x}" cy="${sp.y}" r="${shipR * 3}" fill="#4FD1C5" opacity="0.2">` +
      `<animate attributeName="opacity" values="0.2;0.4;0.2" dur="2s" repeatCount="indefinite"/></circle>`
    );
    parts.push(`<circle cx="${sp.x}" cy="${sp.y}" r="${shipR}" fill="#4FD1C5"/>`);
    const sFontSize = Math.max(mapState.zoom * 0.012, auPerPx * 8);
    const shipName = gameState.ship?.name?.toUpperCase() || 'SHIP';
    parts.push(`<text x="${sp.x + shipR * 2}" y="${sp.y - shipR}" fill="#4FD1C5" font-family='${F}' font-size="${sFontSize}" opacity="0.8">${shipName}</text>`);
  }

  // ---- ENTITIES (stations, ships) ----
  if (gameState && gameState.entities) {
    parts.push('<g>');
    for (const entity of gameState.entities) {
      const ep = entity.position;
      if (!ep) continue;

      // Skip entities way outside view
      if (ep.x < vx - 0.1 || ep.x > vx + vw + 0.1 || ep.y < vy - 0.1 || ep.y > vy + vh + 0.1) continue;

      // Faction colors
      let eColor = '#8A8A6A'; // independent/unknown
      if (entity.faction === 'MCRN') eColor = '#C1553B';
      else if (entity.faction === 'UNN') eColor = '#4A90D9';
      else if (entity.faction === 'OPA') eColor = '#E2A355';
      else if (entity.faction === 'Belter') eColor = '#7EC8D9';

      const eR = Math.max(minBodyR * 0.8, mapState.zoom * 0.003);

      if (entity.type === 'station') {
        // Station: diamond shape
        const d = eR * 1.2;
        parts.push(`<polygon points="${ep.x},${ep.y - d} ${ep.x + d},${ep.y} ${ep.x},${ep.y + d} ${ep.x - d},${ep.y}" fill="${eColor}" opacity="0.85"/>`);
        // Glow ring
        parts.push(`<circle cx="${ep.x}" cy="${ep.y}" r="${eR * 2}" fill="none" stroke="${eColor}" stroke-width="${mapState.zoom * 0.0008}" opacity="0.3"/>`);
      } else {
        // Ship: triangle
        const d = eR;
        const heading = entity.heading || 0;
        const tx = ep.x + Math.cos(heading) * d * 1.5;
        const ty = ep.y + Math.sin(heading) * d * 1.5;
        const lx = ep.x + Math.cos(heading + 2.5) * d;
        const ly = ep.y + Math.sin(heading + 2.5) * d;
        const rx = ep.x + Math.cos(heading - 2.5) * d;
        const ry = ep.y + Math.sin(heading - 2.5) * d;
        parts.push(`<polygon points="${tx},${ty} ${lx},${ly} ${rx},${ry}" fill="${eColor}" opacity="0.85"/>`);

        // Drive plume indicator
        if (entity.thrustActive) {
          parts.push(`<circle cx="${ep.x}" cy="${ep.y}" r="${eR * 2.5}" fill="none" stroke="${eColor}" stroke-width="${mapState.zoom * 0.0006}" opacity="0.4">` +
            `<animate attributeName="opacity" values="0.4;0.1;0.4" dur="1.5s" repeatCount="indefinite"/></circle>`);
        }
      }

      // SOS beacon
      if (entity.sosActive) {
        parts.push(`<circle cx="${ep.x}" cy="${ep.y}" r="${eR * 3}" fill="none" stroke="#FF4444" stroke-width="${mapState.zoom * 0.001}" opacity="0.6">` +
          `<animate attributeName="r" values="${eR * 2};${eR * 4};${eR * 2}" dur="1s" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="0.6;0.1;0.6" dur="1s" repeatCount="indefinite"/></circle>`);
      }

      // Label
      const eFontSize = Math.max(mapState.zoom * 0.01, auPerPx * 7);
      const label = entity.transponderActive ? entity.name : (entity.thrustActive ? entity.driveSignature : null);
      if (label && mapState.zoom < 8) {
        parts.push(`<text x="${ep.x + eR * 2.5}" y="${ep.y + eFontSize * 0.3}" fill="${eColor}" font-family='${F}' font-size="${eFontSize}" opacity="0.6">${escapeXml(label)}</text>`);
      }

      // Add to clickable positions
      bodyPositions.push({ name: entity.name, type: entity.type, x: ep.x, y: ep.y, r: eR, entityId: entity.id });
    }
    parts.push('</g>');
  }

  // ---- SELECTION RING ----
  if (mapState.selectedBody) {
    const sel = mapState.selectedBody;
    const bp = bodyPositions.find(b => b.name === sel.name);
    if (bp) {
      const selR = Math.max(bp.r * 2.5, mapState.zoom * 0.008);
      const selSW = mapState.zoom * 0.0015;
      const selDash = `${mapState.zoom * 0.004} ${mapState.zoom * 0.003}`;
      parts.push(
        `<circle cx="${bp.x}" cy="${bp.y}" r="${selR}" fill="none" stroke="#4FD1C5" stroke-width="${selSW}" stroke-dasharray="${selDash}">` +
        `<animate attributeName="r" values="${selR};${selR * 1.15};${selR}" dur="1.5s" repeatCount="indefinite"/></circle>`
      );
      const selFont = Math.max(mapState.zoom * 0.014, auPerPx * 9);
      parts.push(`<text x="${bp.x}" y="${bp.y - selR - selFont * 0.5}" fill="#4FD1C5" font-family='${F}' font-size="${selFont}" text-anchor="middle" opacity="0.9">▶ ${sel.name.toUpperCase()}</text>`);
    }
  }

  // ---- HOVER RING ----
  if (mapState.hoveredBody && (!mapState.selectedBody || mapState.hoveredBody !== mapState.selectedBody.name)) {
    const hbp = bodyPositions.find(b => b.name === mapState.hoveredBody);
    if (hbp) {
      const hR = Math.max(hbp.r * 2, mapState.zoom * 0.007);
      parts.push(`<circle cx="${hbp.x}" cy="${hbp.y}" r="${hR}" fill="none" stroke="#4FD1C5" stroke-width="${sw001}" opacity="0.4"/>`);
    }
  }

  // ---- ROUTE LINE ----
  if (routeInfo && gameState?.shipPosition) {
    const sp = gameState.shipPosition;
    const ri = routeInfo;
    const sw = mapState.zoom * 0.0012;
    const origin = ri.startPosition || sp;

    if (ri.active) {
      const trailDash = `${mapState.zoom * 0.003} ${mapState.zoom * 0.003}`;
      parts.push(`<line x1="${origin.x}" y1="${origin.y}" x2="${sp.x}" y2="${sp.y}" stroke="#4FD1C5" stroke-width="${sw}" stroke-dasharray="${trailDash}" opacity="0.3"/>`);
      parts.push(`<line x1="${sp.x}" y1="${sp.y}" x2="${ri.destX}" y2="${ri.destY}" stroke="#E25555" stroke-width="${sw}" opacity="0.6"/>`);
    } else {
      const prevDash = `${mapState.zoom * 0.006} ${mapState.zoom * 0.004}`;
      parts.push(`<line x1="${sp.x}" y1="${sp.y}" x2="${ri.destX}" y2="${ri.destY}" stroke="#4FD1C5" stroke-width="${sw}" stroke-dasharray="${prevDash}" opacity="0.4"/>`);
    }

    if (ri.active && ri.flipFraction && !ri.flipDone) {
      const fx = origin.x + (ri.destX - origin.x) * ri.flipFraction;
      const fy = origin.y + (ri.destY - origin.y) * ri.flipFraction;
      const fR = mapState.zoom * 0.005;
      parts.push(`<circle cx="${fx}" cy="${fy}" r="${fR}" fill="#E8D56B" opacity="0.7"/>`);
      const flipFont = Math.max(mapState.zoom * 0.01, auPerPx * 6);
      parts.push(`<text x="${fx + fR * 2}" y="${fy}" fill="#E8D56B" font-family='${F}' font-size="${flipFont}" opacity="0.6">FLIP</text>`);
    }

    const destR = mapState.zoom * 0.006;
    parts.push(`<circle cx="${ri.destX}" cy="${ri.destY}" r="${destR}" fill="none" stroke="#E25555" stroke-width="${sw001}"/>`);
  }

  // ---- CROSSHAIR ----
  const chSize = mapState.zoom * 0.02;
  const chSW = mapState.zoom * 0.0008;
  parts.push(
    `<g opacity="0.15">` +
    `<line x1="${mapState.cx - chSize}" y1="${mapState.cy}" x2="${mapState.cx + chSize}" y2="${mapState.cy}" stroke="#4FD1C5" stroke-width="${chSW}"/>` +
    `<line x1="${mapState.cx}" y1="${mapState.cy - chSize}" x2="${mapState.cx}" y2="${mapState.cy + chSize}" stroke="#4FD1C5" stroke-width="${chSW}"/>` +
    `</g>`
  );

  // Single DOM write
  container.innerHTML = `<svg width="100%" height="100%" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet" style="display:block;background:#030810" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;

  const elapsed = performance.now() - t0;
  if (elapsed > 30) {
    const now = Date.now();
    if (now - _lastRenderWarn > 2000) {
      console.warn(`[SolarMap] render #${_renderCount}: ${elapsed.toFixed(1)}ms, zoom=${mapState.zoom.toFixed(2)}, center=(${mapState.cx.toFixed(4)}, ${mapState.cy.toFixed(4)})`);
      _lastRenderWarn = now;
    }
  }

  return container.firstChild;
}

// ---- HELPERS: screen → world coordinate conversion ----

function screenToWorld(e, container) {
  const rect = container.getBoundingClientRect();
  const mx = (e.clientX - rect.left) / rect.width;
  const my = (e.clientY - rect.top) / rect.height;
  const aspect = rect.width / rect.height;
  const halfW = mapState.zoom * aspect;
  const halfH = mapState.zoom;
  return {
    wx: mapState.cx - halfW + mx * halfW * 2,
    wy: mapState.cy - halfH + my * halfH * 2,
  };
}

function findNearestBody(wx, wy) {
  const threshold = mapState.zoom * 0.03;
  let best = null;
  let bestD = threshold;
  bodyPositions.forEach(bp => {
    const d = Math.sqrt((bp.x - wx) * (bp.x - wx) + (bp.y - wy) * (bp.y - wy));
    if (d < bestD) { bestD = d; best = bp; }
  });
  return best;
}

// ---- INTERACTION HANDLERS ----

export function initSolarMapInteraction(container) {
  // Mouse wheel zoom (centered on cursor)
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;

    const aspect = rect.width / rect.height;
    const halfW = mapState.zoom * aspect;
    const halfH = mapState.zoom;

    // World coords under cursor before zoom
    const wx = mapState.cx - halfW + mx * halfW * 2;
    const wy = mapState.cy - halfH + my * halfH * 2;

    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(mapState.minZoom, Math.min(mapState.maxZoom, mapState.zoom * factor));

    // Adjust center so point under cursor stays fixed
    const newHalfW = newZoom * aspect;
    const newHalfH = newZoom;
    mapState.cx = wx - (mx - 0.5) * newHalfW * 2;
    mapState.cy = wy - (my - 0.5) * newHalfH * 2;
    mapState.zoom = newZoom;
  }, { passive: false });

  // Mouse drag pan — track drag distance for click vs drag detection
  let dragDist = 0;
  let mouseDownPos = null;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mapState.dragging = true;
    dragDist = 0;
    mouseDownPos = { x: e.clientX, y: e.clientY };
    mapState.dragStart = { x: e.clientX, y: e.clientY };
    mapState.dragCenterStart = { x: mapState.cx, y: mapState.cy };
    container.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!mapState.dragging) {
      // Hover detection — change cursor when over a selectable body
      const rect = container.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const { wx, wy } = screenToWorld(e, container);
        const body = findNearestBody(wx, wy);
        if (body) {
          mapState.hoveredBody = body.name;
          container.style.cursor = 'pointer';
        } else {
          mapState.hoveredBody = null;
          container.style.cursor = 'grab';
        }
      }
      return;
    }
    const rect = container.getBoundingClientRect();
    const aspect = rect.width / rect.height;
    const dx = (e.clientX - mapState.dragStart.x) / rect.width * mapState.zoom * aspect * 2;
    const dy = (e.clientY - mapState.dragStart.y) / rect.height * mapState.zoom * 2;
    mapState.cx = mapState.dragCenterStart.x - dx;
    mapState.cy = mapState.dragCenterStart.y - dy;
    dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
  });

  // Use mouseup for selection instead of click — re-renders during drag can
  // remove the SVG element that received mousedown, which kills the click event.
  window.addEventListener('mouseup', (e) => {
    if (!mapState.dragging) return;
    mapState.dragging = false;

    // Was it a click (not a drag)?
    if (dragDist <= 5 && mouseDownPos) {
      const { wx, wy } = screenToWorld(e, container);
      const best = findNearestBody(wx, wy);

      if (best) {
        mapState.selectedBody = { name: best.name, type: best.type, x: best.x, y: best.y, entityId: best.entityId || null };
      } else {
        mapState.selectedBody = null;
      }
      if (onBodySelectCallback) onBodySelectCallback(mapState.selectedBody);
    }

    mouseDownPos = null;
    // Restore hover cursor
    const rect = container.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const { wx, wy } = screenToWorld(e, container);
      container.style.cursor = findNearestBody(wx, wy) ? 'pointer' : 'grab';
    } else {
      container.style.cursor = 'grab';
    }
  });

  container.style.cursor = 'grab';
}

export function zoomToPreset(preset) {
  mapState.zoom = preset.zoom;
  mapState.cx = preset.cx;
  mapState.cy = preset.cy;
}

// Zoom to a specific planet (dynamically compute its position)
export function zoomToPlanet(planetName, gameState, zoomLevel) {
  const planet = PLANETS.find(p => p.name === planetName);
  if (!planet) return;
  const days = gameState ? gameTimeToDays(gameState.time, gameState.stats) : 0;
  const pos = orbitalPos(planet, days);
  mapState.cx = pos.x;
  mapState.cy = pos.y;
  mapState.zoom = zoomLevel || planet.a * 0.15;
}

// Zoom to any body — centers on it and picks a zoom level that shows its moons/context
export function zoomToBody(bodyName, gameState) {
  const days = gameState ? gameTimeToDays(gameState.time, gameState.stats) : 0;
  const t0 = performance.now();
  let zoomTarget, reason;

  if (bodyName === 'Sol') {
    mapState.cx = 0;
    mapState.cy = 0;
    zoomTarget = 2.5;
    reason = 'Sol center';
  }

  // Check planets
  if (zoomTarget == null) {
    const planet = PLANETS.find(p => p.name === bodyName);
    if (planet) {
      const pos = orbitalPos(planet, days);
      mapState.cx = pos.x;
      mapState.cy = pos.y;
      if (planet.moons.length > 0) {
        const outerMoon = Math.max(...planet.moons.map(m => m.a));
        // Moon distances in AU can be tiny (Luna ≈ 0.0026 AU), so enforce a
        // minimum zoom that still shows the planet in useful context
        zoomTarget = Math.max(outerMoon * 3, planet.a * 0.06);
        reason = `planet ${bodyName} moons (outerMoon=${outerMoon.toFixed(6)} AU, floor=${(planet.a * 0.06).toFixed(4)})`;
      } else {
        zoomTarget = planet.a * 0.15;
        reason = `planet ${bodyName} no moons (a=${planet.a})`;
      }
    }
  }

  // Check moons — zoom to parent planet's moon system
  if (zoomTarget == null) {
    for (const p of PLANETS) {
      const moon = p.moons.find(m => m.name === bodyName);
      if (moon) {
        const pPos = orbitalPos(p, days);
        mapState.cx = pPos.x;
        mapState.cy = pPos.y;
        const outerMoon = Math.max(...p.moons.map(m => m.a));
        zoomTarget = Math.max(outerMoon * 3, p.a * 0.06);
        reason = `moon ${bodyName} of ${p.name} (outerMoon=${outerMoon.toFixed(6)} AU, floor=${(p.a * 0.06).toFixed(4)})`;
        break;
      }
    }
  }

  // Check asteroids
  if (zoomTarget == null) {
    const ast = ASTEROIDS.find(a => a.name === bodyName);
    if (ast) {
      const pos = orbitalPos(ast, days);
      mapState.cx = pos.x;
      mapState.cy = pos.y;
      zoomTarget = 1.5;
      reason = `asteroid ${bodyName}`;
    }
  }

  // Check entities (stations, ships)
  if (zoomTarget == null && gameState && gameState.entities) {
    const entity = gameState.entities.find(e => e.name === bodyName);
    if (entity && entity.position) {
      mapState.cx = entity.position.x;
      mapState.cy = entity.position.y;
      zoomTarget = entity.type === 'station' ? 0.02 : 0.05;
      reason = `entity ${bodyName} (${entity.type})`;
    }
  }

  if (zoomTarget == null) {
    console.warn(`[SolarMap] zoomToBody: unknown body "${bodyName}"`);
    return;
  }

  // Clamp zoom to safe bounds
  const rawZoom = zoomTarget;
  zoomTarget = Math.max(mapState.minZoom, Math.min(mapState.maxZoom, zoomTarget));

  mapState.zoom = zoomTarget;

  console.log(
    `[SolarMap] zoomToBody "${bodyName}" — ${reason}` +
    `\n  center=(${mapState.cx.toFixed(6)}, ${mapState.cy.toFixed(6)})` +
    `\n  rawZoom=${rawZoom.toFixed(6)}, clampedZoom=${zoomTarget.toFixed(6)}` +
    `\n  took ${(performance.now() - t0).toFixed(1)}ms`
  );
}

export function getMapState() {
  return mapState;
}

// ---- HELPERS ----

function gameTimeToDays(time, stats) {
  // Days elapsed since game start
  return (stats?.daysElapsed || 0) + (time?.hour || 0) / 24 + (time?.minute || 0) / 1440;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
