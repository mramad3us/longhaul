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
  container.innerHTML = '';
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

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.display = 'block';
  svg.style.background = '#030810';

  // Elapsed days for orbital calculation
  const days = gameState ? gameTimeToDays(gameState.time, gameState.stats) : 0;

  // Defs: filters for glow
  // Skip expensive SVG filters at extreme zoom (< 0.1 AU viewbox)
  const useFilters = mapState.zoom > 0.05;
  const defs = document.createElementNS(SVG_NS, 'defs');
  if (useFilters) {
    defs.innerHTML = `
      <filter id="sol-glow" x="-200%" y="-200%" width="500%" height="500%">
        <feGaussianBlur stdDeviation="${Math.max(0.001, mapState.zoom * 0.008)}" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="planet-glow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="${Math.max(0.0005, mapState.zoom * 0.003)}"/>
      </filter>
    `;
  }
  defs.innerHTML += `
    <radialGradient id="sun-grad" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#FFF8E0"/>
      <stop offset="30%" stop-color="#FDB813"/>
      <stop offset="70%" stop-color="#E8960A"/>
      <stop offset="100%" stop-color="#C06000" stop-opacity="0"/>
    </radialGradient>
  `;
  svg.appendChild(defs);

  // ---- BACKGROUND STAR FIELD ----
  // Screen-space stars for atmosphere — placed in viewBox coords from normalized positions
  const starGroup = document.createElementNS(SVG_NS, 'g');
  const starR = (vw / w) * 0.8; // sub-pixel to ~1px
  BG_STARS.forEach(s => {
    const sx = vx + s.nx * vw;
    const sy = vy + s.ny * vh;
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', sx);
    dot.setAttribute('cy', sy);
    dot.setAttribute('r', starR * s.size);
    dot.setAttribute('fill', '#FFF');
    dot.setAttribute('opacity', s.brightness);
    starGroup.appendChild(dot);
  });
  svg.appendChild(starGroup);

  // ---- AU DISTANCE RINGS ----
  const ringDistances = mapState.zoom > 15
    ? [1, 2, 3, 5, 10, 20, 30]
    : mapState.zoom > 5
      ? [0.5, 1, 1.5, 2, 3, 5]
      : mapState.zoom > 1
        ? [0.25, 0.5, 1, 1.5, 2]
        : [0.1, 0.25, 0.5, 1];

  const auGroup = document.createElementNS(SVG_NS, 'g');
  ringDistances.forEach(r => {
    if (r > mapState.zoom * 1.5) return;
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', 0);
    ring.setAttribute('cy', 0);
    ring.setAttribute('r', r);
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', '#1A2A3A');
    ring.setAttribute('stroke-width', mapState.zoom * 0.001);
    ring.setAttribute('stroke-dasharray', `${mapState.zoom * 0.005} ${mapState.zoom * 0.005}`);
    auGroup.appendChild(ring);

    // Label
    if (mapState.zoom < 40) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', mapState.zoom * 0.005);
      label.setAttribute('y', -r + mapState.zoom * 0.012);
      label.setAttribute('fill', '#2A4A5A');
      label.setAttribute('font-family', '"Press Start 2P", monospace');
      label.setAttribute('font-size', mapState.zoom * 0.015);
      label.textContent = `${r} AU`;
      auGroup.appendChild(label);
    }
  });
  svg.appendChild(auGroup);

  // ---- ASTEROID BELT DUST ----
  // Belt spans ~2.1–3.4 AU; skip entirely if viewBox can't see that range
  const beltGroup = document.createElementNS(SVG_NS, 'g');
  const beltInner = 2.0, beltOuter = 3.5;
  const viewEdge = Math.sqrt((mapState.cx ** 2) + (mapState.cy ** 2)) + halfW * 1.5;
  const beltVisible = mapState.zoom < 20 && viewEdge > beltInner && mapState.zoom > 0.5;
  if (beltVisible) {
    const visibleDust = mapState.zoom > 8
      ? BELT_DUST.filter((_, i) => i % 4 === 0)
      : mapState.zoom > 3
        ? BELT_DUST.filter((_, i) => i % 2 === 0)
        : BELT_DUST;
    visibleDust.forEach(d => {
      const a = d.angle + days * 0.0002;
      const dx = d.a * Math.cos(a);
      const dy = d.a * Math.sin(a);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', dx);
      dot.setAttribute('cy', dy);
      dot.setAttribute('r', mapState.zoom * 0.001 * d.size);
      dot.setAttribute('fill', `rgba(140, 130, 110, ${d.brightness})`);
      beltGroup.appendChild(dot);
    });
  }
  svg.appendChild(beltGroup);

  // ---- ORBIT PATHS ----
  const orbitGroup = document.createElementNS(SVG_NS, 'g');
  PLANETS.forEach(p => {
    if (p.a > mapState.zoom * 1.5) return; // off-screen
    const orbit = document.createElementNS(SVG_NS, 'circle');
    orbit.setAttribute('cx', 0);
    orbit.setAttribute('cy', 0);
    orbit.setAttribute('r', p.a);
    orbit.setAttribute('fill', 'none');
    orbit.setAttribute('stroke', '#152535');
    orbit.setAttribute('stroke-width', mapState.zoom * 0.0008);
    orbitGroup.appendChild(orbit);
  });
  // Named asteroid orbits
  if (mapState.zoom < 10) {
    ASTEROIDS.forEach(ast => {
      const orbit = document.createElementNS(SVG_NS, 'circle');
      orbit.setAttribute('cx', 0);
      orbit.setAttribute('cy', 0);
      orbit.setAttribute('r', ast.a);
      orbit.setAttribute('fill', 'none');
      orbit.setAttribute('stroke', '#121F2A');
      orbit.setAttribute('stroke-width', mapState.zoom * 0.0004);
      orbit.setAttribute('stroke-dasharray', `${mapState.zoom * 0.003} ${mapState.zoom * 0.006}`);
      orbitGroup.appendChild(orbit);
    });
  }
  svg.appendChild(orbitGroup);

  // ---- SUN ----
  const sunR = Math.max(mapState.zoom * 0.012, 0.01);
  // Outer corona
  const corona = document.createElementNS(SVG_NS, 'circle');
  corona.setAttribute('cx', 0);
  corona.setAttribute('cy', 0);
  corona.setAttribute('r', sunR * 3);
  corona.setAttribute('fill', 'url(#sun-grad)');
  corona.setAttribute('opacity', '0.4');
  svg.appendChild(corona);
  // Core
  const sun = document.createElementNS(SVG_NS, 'circle');
  sun.setAttribute('cx', 0);
  sun.setAttribute('cy', 0);
  sun.setAttribute('r', sunR);
  sun.setAttribute('fill', '#FDB813');
  if (useFilters) sun.setAttribute('filter', 'url(#sol-glow)');
  svg.appendChild(sun);

  // Track Sun position
  bodyPositions.push({ name: 'Sol', type: 'star', x: 0, y: 0, r: sunR });

  // Pixel size helper — how many AU per pixel
  const auPerPx = vw / w;
  const minBodyR = auPerPx * 2.5; // minimum 2.5px visual radius

  // ---- PLANETS ----
  const planetGroup = document.createElementNS(SVG_NS, 'g');
  PLANETS.forEach(p => {
    const pos = orbitalPos(p, days);
    // Skip if far off screen
    if (Math.abs(pos.x - mapState.cx) > halfW * 1.5 ||
        Math.abs(pos.y - mapState.cy) > halfH * 1.5) return;

    // Scale planet radius — larger at close zoom for visual impact
    const closeZoomBoost = mapState.zoom < 0.2 ? 1.8 : mapState.zoom < 1 ? 1.3 : 1.0;
    const pR = Math.max(minBodyR * closeZoomBoost, mapState.zoom * 0.005);

    // Outer atmosphere haze (only at close zoom for more visual presence)
    if (mapState.zoom < 0.5) {
      const haze = document.createElementNS(SVG_NS, 'circle');
      haze.setAttribute('cx', pos.x);
      haze.setAttribute('cy', pos.y);
      haze.setAttribute('r', pR * 5);
      haze.setAttribute('fill', 'none');
      haze.setAttribute('stroke', p.color);
      haze.setAttribute('stroke-width', pR * 0.3);
      haze.setAttribute('opacity', '0.06');
      planetGroup.appendChild(haze);
    }

    // Glow behind planet
    const glow = document.createElementNS(SVG_NS, 'circle');
    glow.setAttribute('cx', pos.x);
    glow.setAttribute('cy', pos.y);
    glow.setAttribute('r', pR * 2.5);
    glow.setAttribute('fill', p.color);
    glow.setAttribute('opacity', '0.15');
    if (useFilters) glow.setAttribute('filter', 'url(#planet-glow)');
    planetGroup.appendChild(glow);

    // Planet body
    const body = document.createElementNS(SVG_NS, 'circle');
    body.setAttribute('cx', pos.x);
    body.setAttribute('cy', pos.y);
    body.setAttribute('r', pR);
    body.setAttribute('fill', p.color);
    planetGroup.appendChild(body);

    // Inner highlight — terminator-style half-lit effect
    if (mapState.zoom < 1) {
      const highlight = document.createElementNS(SVG_NS, 'circle');
      highlight.setAttribute('cx', pos.x - pR * 0.2);
      highlight.setAttribute('cy', pos.y - pR * 0.2);
      highlight.setAttribute('r', pR * 0.7);
      highlight.setAttribute('fill', '#FFF');
      highlight.setAttribute('opacity', '0.08');
      planetGroup.appendChild(highlight);
    }

    // Track position for click detection
    bodyPositions.push({ name: p.name, type: 'planet', x: pos.x, y: pos.y, r: pR });

    // Saturn rings
    if (p.name === 'Saturn') {
      const ringEl = document.createElementNS(SVG_NS, 'ellipse');
      ringEl.setAttribute('cx', pos.x);
      ringEl.setAttribute('cy', pos.y);
      ringEl.setAttribute('rx', pR * 2.2);
      ringEl.setAttribute('ry', pR * 0.6);
      ringEl.setAttribute('fill', 'none');
      ringEl.setAttribute('stroke', '#D4C49A');
      ringEl.setAttribute('stroke-width', pR * 0.3);
      ringEl.setAttribute('opacity', '0.5');
      planetGroup.appendChild(ringEl);
    }

    // Planet label — show when zoomed close enough, but hide if it's the selected body
    // (selection ring already has its own label above)
    const isSelected = mapState.selectedBody && mapState.selectedBody.name === p.name;
    const labelThreshold = p.a * 0.4;
    if (!isSelected && mapState.zoom < Math.max(labelThreshold, 6)) {
      const fontSize = Math.max(mapState.zoom * 0.012, auPerPx * 8);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', pos.x + pR * 1.8);
      label.setAttribute('y', pos.y + fontSize * 0.3);
      label.setAttribute('fill', p.color);
      label.setAttribute('font-family', '"Press Start 2P", monospace');
      label.setAttribute('font-size', fontSize);
      label.setAttribute('opacity', '0.7');
      label.textContent = p.name.toUpperCase();
      planetGroup.appendChild(label);
    }

    // ---- MOONS ----
    // Only render moons when zoomed close to the planet
    const moonViewThreshold = p.a * 0.08;
    if (mapState.zoom < moonViewThreshold && p.moons.length > 0) {
      p.moons.forEach(m => {
        const mPos = orbitalPos(m, days);
        const mx = pos.x + mPos.x;
        const my = pos.y + mPos.y;

        // Moon orbit — brighter, dashed ring
        const mOrbit = document.createElementNS(SVG_NS, 'circle');
        mOrbit.setAttribute('cx', pos.x);
        mOrbit.setAttribute('cy', pos.y);
        mOrbit.setAttribute('r', m.a);
        mOrbit.setAttribute('fill', 'none');
        mOrbit.setAttribute('stroke', '#2A4A5A');
        mOrbit.setAttribute('stroke-width', Math.max(mapState.zoom * 0.0004, auPerPx * 0.5));
        mOrbit.setAttribute('stroke-dasharray', `${mapState.zoom * 0.002} ${mapState.zoom * 0.003}`);
        planetGroup.appendChild(mOrbit);

        // Moon glow
        const mR = Math.max(minBodyR * 0.8, mapState.zoom * 0.003);
        const mGlow = document.createElementNS(SVG_NS, 'circle');
        mGlow.setAttribute('cx', mx);
        mGlow.setAttribute('cy', my);
        mGlow.setAttribute('r', mR * 2);
        mGlow.setAttribute('fill', m.color);
        mGlow.setAttribute('opacity', '0.1');
        planetGroup.appendChild(mGlow);

        // Moon body
        const mBody = document.createElementNS(SVG_NS, 'circle');
        mBody.setAttribute('cx', mx);
        mBody.setAttribute('cy', my);
        mBody.setAttribute('r', mR);
        mBody.setAttribute('fill', m.color);
        planetGroup.appendChild(mBody);

        // Track moon position
        bodyPositions.push({ name: m.name, type: 'moon', x: mx, y: my, r: mR, parentName: p.name });

        // Moon label — always show when moons are visible, hide if selected
        const moonSelected = mapState.selectedBody && mapState.selectedBody.name === m.name;
        if (!moonSelected) {
          const mFontSize = Math.max(mapState.zoom * 0.01, auPerPx * 6);
          const mLabel = document.createElementNS(SVG_NS, 'text');
          mLabel.setAttribute('x', mx + mR * 2);
          mLabel.setAttribute('y', my + mFontSize * 0.3);
          mLabel.setAttribute('fill', m.color);
          mLabel.setAttribute('font-family', '"Press Start 2P", monospace');
          mLabel.setAttribute('font-size', mFontSize);
          mLabel.setAttribute('opacity', '0.6');
          mLabel.textContent = m.name;
          planetGroup.appendChild(mLabel);
        }
      });
    }
  });
  svg.appendChild(planetGroup);

  // ---- NAMED ASTEROIDS ----
  if (mapState.zoom < 10) {
    const astGroup = document.createElementNS(SVG_NS, 'g');
    ASTEROIDS.forEach(ast => {
      const pos = orbitalPos(ast, days);
      const aR = Math.max(minBodyR * 0.5, mapState.zoom * 0.002);
      // Irregular shape — small diamond
      const d = aR;
      const shape = document.createElementNS(SVG_NS, 'polygon');
      shape.setAttribute('points',
        `${pos.x},${pos.y - d} ${pos.x + d * 0.7},${pos.y} ${pos.x},${pos.y + d * 0.8} ${pos.x - d * 0.6},${pos.y}`);
      shape.setAttribute('fill', ast.color);
      shape.setAttribute('opacity', '0.7');
      astGroup.appendChild(shape);

      // Track asteroid position
      bodyPositions.push({ name: ast.name, type: 'asteroid', x: pos.x, y: pos.y, r: aR });

      const astSelected = mapState.selectedBody && mapState.selectedBody.name === ast.name;
      if (!astSelected && mapState.zoom < 5) {
        const fontSize = Math.max(mapState.zoom * 0.01, auPerPx * 7);
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', pos.x + d * 2);
        label.setAttribute('y', pos.y + fontSize * 0.3);
        label.setAttribute('fill', ast.color);
        label.setAttribute('font-family', '"Press Start 2P", monospace');
        label.setAttribute('font-size', fontSize);
        label.setAttribute('opacity', '0.5');
        label.textContent = ast.name;
        astGroup.appendChild(label);
      }
    });
    svg.appendChild(astGroup);
  }

  // ---- SHIP POSITION ----
  if (gameState && gameState.shipPosition) {
    const sp = gameState.shipPosition;
    const shipR = Math.max(minBodyR, mapState.zoom * 0.004);
    // Ship marker — teal blinking dot
    const shipGlow = document.createElementNS(SVG_NS, 'circle');
    shipGlow.setAttribute('cx', sp.x);
    shipGlow.setAttribute('cy', sp.y);
    shipGlow.setAttribute('r', shipR * 3);
    shipGlow.setAttribute('fill', '#4FD1C5');
    shipGlow.setAttribute('opacity', '0.2');
    const pulseAnim = document.createElementNS(SVG_NS, 'animate');
    pulseAnim.setAttribute('attributeName', 'opacity');
    pulseAnim.setAttribute('values', '0.2;0.4;0.2');
    pulseAnim.setAttribute('dur', '2s');
    pulseAnim.setAttribute('repeatCount', 'indefinite');
    shipGlow.appendChild(pulseAnim);
    svg.appendChild(shipGlow);

    const shipDot = document.createElementNS(SVG_NS, 'circle');
    shipDot.setAttribute('cx', sp.x);
    shipDot.setAttribute('cy', sp.y);
    shipDot.setAttribute('r', shipR);
    shipDot.setAttribute('fill', '#4FD1C5');
    svg.appendChild(shipDot);

    // Ship label
    const sFontSize = Math.max(mapState.zoom * 0.012, auPerPx * 8);
    const shipLabel = document.createElementNS(SVG_NS, 'text');
    shipLabel.setAttribute('x', sp.x + shipR * 2);
    shipLabel.setAttribute('y', sp.y - shipR);
    shipLabel.setAttribute('fill', '#4FD1C5');
    shipLabel.setAttribute('font-family', '"Press Start 2P", monospace');
    shipLabel.setAttribute('font-size', sFontSize);
    shipLabel.setAttribute('opacity', '0.8');
    shipLabel.textContent = gameState.ship?.name?.toUpperCase() || 'SHIP';
    svg.appendChild(shipLabel);
  }

  // ---- SELECTION RING ----
  if (mapState.selectedBody) {
    const sel = mapState.selectedBody;
    // Find current rendered position from bodyPositions
    const bp = bodyPositions.find(b => b.name === sel.name);
    if (bp) {
      const selR = Math.max(bp.r * 2.5, mapState.zoom * 0.008);
      // Pulsing selection ring
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', bp.x);
      ring.setAttribute('cy', bp.y);
      ring.setAttribute('r', selR);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#4FD1C5');
      ring.setAttribute('stroke-width', mapState.zoom * 0.0015);
      ring.setAttribute('stroke-dasharray', `${mapState.zoom * 0.004} ${mapState.zoom * 0.003}`);
      const pulseRing = document.createElementNS(SVG_NS, 'animate');
      pulseRing.setAttribute('attributeName', 'r');
      pulseRing.setAttribute('values', `${selR};${selR * 1.15};${selR}`);
      pulseRing.setAttribute('dur', '1.5s');
      pulseRing.setAttribute('repeatCount', 'indefinite');
      ring.appendChild(pulseRing);
      svg.appendChild(ring);

      // Selection label
      const selFont = Math.max(mapState.zoom * 0.014, auPerPx * 9);
      const selLabel = document.createElementNS(SVG_NS, 'text');
      selLabel.setAttribute('x', bp.x);
      selLabel.setAttribute('y', bp.y - selR - selFont * 0.5);
      selLabel.setAttribute('fill', '#4FD1C5');
      selLabel.setAttribute('font-family', '"Press Start 2P", monospace');
      selLabel.setAttribute('font-size', selFont);
      selLabel.setAttribute('text-anchor', 'middle');
      selLabel.setAttribute('opacity', '0.9');
      selLabel.textContent = `▶ ${sel.name.toUpperCase()}`;
      svg.appendChild(selLabel);
    }
  }

  // ---- HOVER RING ----
  if (mapState.hoveredBody && (!mapState.selectedBody || mapState.hoveredBody !== mapState.selectedBody.name)) {
    const hbp = bodyPositions.find(b => b.name === mapState.hoveredBody);
    if (hbp) {
      const hR = Math.max(hbp.r * 2, mapState.zoom * 0.007);
      const hoverRing = document.createElementNS(SVG_NS, 'circle');
      hoverRing.setAttribute('cx', hbp.x);
      hoverRing.setAttribute('cy', hbp.y);
      hoverRing.setAttribute('r', hR);
      hoverRing.setAttribute('fill', 'none');
      hoverRing.setAttribute('stroke', '#4FD1C5');
      hoverRing.setAttribute('stroke-width', mapState.zoom * 0.001);
      hoverRing.setAttribute('opacity', '0.4');
      svg.appendChild(hoverRing);
    }
  }

  // ---- ROUTE LINE ----
  if (routeInfo && gameState?.shipPosition) {
    const sp = gameState.shipPosition;
    const ri = routeInfo;
    const sw = mapState.zoom * 0.0012;
    const origin = ri.startPosition || sp;

    if (ri.active) {
      // Trail line: origin → current position (dotted, dim)
      const trailLine = document.createElementNS(SVG_NS, 'line');
      trailLine.setAttribute('x1', origin.x);
      trailLine.setAttribute('y1', origin.y);
      trailLine.setAttribute('x2', sp.x);
      trailLine.setAttribute('y2', sp.y);
      trailLine.setAttribute('stroke', '#4FD1C5');
      trailLine.setAttribute('stroke-width', sw);
      trailLine.setAttribute('stroke-dasharray', `${mapState.zoom * 0.003} ${mapState.zoom * 0.003}`);
      trailLine.setAttribute('opacity', '0.3');
      svg.appendChild(trailLine);

      // Remaining route: current position → destination (solid)
      const routeLine = document.createElementNS(SVG_NS, 'line');
      routeLine.setAttribute('x1', sp.x);
      routeLine.setAttribute('y1', sp.y);
      routeLine.setAttribute('x2', ri.destX);
      routeLine.setAttribute('y2', ri.destY);
      routeLine.setAttribute('stroke', '#E25555');
      routeLine.setAttribute('stroke-width', sw);
      routeLine.setAttribute('opacity', '0.6');
      svg.appendChild(routeLine);
    } else {
      // Preview line (dashed, teal)
      const routeLine = document.createElementNS(SVG_NS, 'line');
      routeLine.setAttribute('x1', sp.x);
      routeLine.setAttribute('y1', sp.y);
      routeLine.setAttribute('x2', ri.destX);
      routeLine.setAttribute('y2', ri.destY);
      routeLine.setAttribute('stroke', '#4FD1C5');
      routeLine.setAttribute('stroke-width', sw);
      routeLine.setAttribute('stroke-dasharray', `${mapState.zoom * 0.006} ${mapState.zoom * 0.004}`);
      routeLine.setAttribute('opacity', '0.4');
      svg.appendChild(routeLine);
    }

    // Flip point marker — fixed world position between route origin and destination
    if (ri.active && ri.flipFraction && !ri.flipDone) {
      const fx = origin.x + (ri.destX - origin.x) * ri.flipFraction;
      const fy = origin.y + (ri.destY - origin.y) * ri.flipFraction;
      const fR = mapState.zoom * 0.005;
      const flipMarker = document.createElementNS(SVG_NS, 'circle');
      flipMarker.setAttribute('cx', fx);
      flipMarker.setAttribute('cy', fy);
      flipMarker.setAttribute('r', fR);
      flipMarker.setAttribute('fill', '#E8D56B');
      flipMarker.setAttribute('opacity', '0.7');
      svg.appendChild(flipMarker);

      const flipFont = Math.max(mapState.zoom * 0.01, auPerPx * 6);
      const flipLabel = document.createElementNS(SVG_NS, 'text');
      flipLabel.setAttribute('x', fx + fR * 2);
      flipLabel.setAttribute('y', fy);
      flipLabel.setAttribute('fill', '#E8D56B');
      flipLabel.setAttribute('font-family', '"Press Start 2P", monospace');
      flipLabel.setAttribute('font-size', flipFont);
      flipLabel.setAttribute('opacity', '0.6');
      flipLabel.textContent = 'FLIP';
      svg.appendChild(flipLabel);
    }

    // Destination marker
    const destR = mapState.zoom * 0.006;
    const destMarker = document.createElementNS(SVG_NS, 'circle');
    destMarker.setAttribute('cx', ri.destX);
    destMarker.setAttribute('cy', ri.destY);
    destMarker.setAttribute('r', destR);
    destMarker.setAttribute('fill', 'none');
    destMarker.setAttribute('stroke', '#E25555');
    destMarker.setAttribute('stroke-width', mapState.zoom * 0.001);
    svg.appendChild(destMarker);
  }

  // ---- CROSSHAIR AT MAP CENTER (subtle) ----
  const chSize = mapState.zoom * 0.02;
  const chGroup = document.createElementNS(SVG_NS, 'g');
  chGroup.setAttribute('opacity', '0.15');
  ['h', 'v'].forEach(dir => {
    const line = document.createElementNS(SVG_NS, 'line');
    if (dir === 'h') {
      line.setAttribute('x1', mapState.cx - chSize);
      line.setAttribute('y1', mapState.cy);
      line.setAttribute('x2', mapState.cx + chSize);
      line.setAttribute('y2', mapState.cy);
    } else {
      line.setAttribute('x1', mapState.cx);
      line.setAttribute('y1', mapState.cy - chSize);
      line.setAttribute('x2', mapState.cx);
      line.setAttribute('y2', mapState.cy + chSize);
    }
    line.setAttribute('stroke', '#4FD1C5');
    line.setAttribute('stroke-width', mapState.zoom * 0.0008);
    chGroup.appendChild(line);
  });
  svg.appendChild(chGroup);

  container.appendChild(svg);

  const elapsed = performance.now() - t0;
  const nodeCount = svg.querySelectorAll('*').length;
  if (elapsed > 30 || nodeCount > 500) {
    const now = Date.now();
    if (now - _lastRenderWarn > 2000) {
      console.warn(
        `[SolarMap] SLOW render #${_renderCount}: ${elapsed.toFixed(1)}ms, ` +
        `${nodeCount} SVG nodes, zoom=${mapState.zoom.toFixed(6)}, ` +
        `center=(${mapState.cx.toFixed(4)}, ${mapState.cy.toFixed(4)})`
      );
      _lastRenderWarn = now;
    }
  }

  return svg;
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
        mapState.selectedBody = { name: best.name, type: best.type, x: best.x, y: best.y };
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
