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
  selectedBody: null,
};

export function resetMapState() {
  mapState.cx = 0;
  mapState.cy = 0;
  mapState.zoom = 35;
  mapState.hoveredBody = null;
  mapState.selectedBody = null;
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

export function renderSolarSystem(container, gameState) {
  container.innerHTML = '';

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
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `
    <filter id="sol-glow" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="${mapState.zoom * 0.008}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="planet-glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="${mapState.zoom * 0.003}"/>
    </filter>
    <radialGradient id="sun-grad" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#FFF8E0"/>
      <stop offset="30%" stop-color="#FDB813"/>
      <stop offset="70%" stop-color="#E8960A"/>
      <stop offset="100%" stop-color="#C06000" stop-opacity="0"/>
    </radialGradient>
  `;
  svg.appendChild(defs);

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
  const beltGroup = document.createElementNS(SVG_NS, 'g');
  if (mapState.zoom < 20) {
    const visibleDust = mapState.zoom > 8
      ? BELT_DUST.filter((_, i) => i % 4 === 0)
      : mapState.zoom > 3
        ? BELT_DUST.filter((_, i) => i % 2 === 0)
        : BELT_DUST;
    visibleDust.forEach(d => {
      // Slowly orbit the dust
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
  sun.setAttribute('filter', 'url(#sol-glow)');
  svg.appendChild(sun);

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

    const pR = Math.max(minBodyR, mapState.zoom * 0.005);

    // Glow behind planet
    const glow = document.createElementNS(SVG_NS, 'circle');
    glow.setAttribute('cx', pos.x);
    glow.setAttribute('cy', pos.y);
    glow.setAttribute('r', pR * 2.5);
    glow.setAttribute('fill', p.color);
    glow.setAttribute('opacity', '0.15');
    glow.setAttribute('filter', 'url(#planet-glow)');
    planetGroup.appendChild(glow);

    // Planet body
    const body = document.createElementNS(SVG_NS, 'circle');
    body.setAttribute('cx', pos.x);
    body.setAttribute('cy', pos.y);
    body.setAttribute('r', pR);
    body.setAttribute('fill', p.color);
    planetGroup.appendChild(body);

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

    // Planet label — show when zoomed close enough
    const labelThreshold = p.a * 0.4;
    if (mapState.zoom < Math.max(labelThreshold, 6)) {
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
      // Moon orbit rings
      p.moons.forEach(m => {
        const mPos = orbitalPos(m, days);
        const mx = pos.x + mPos.x;
        const my = pos.y + mPos.y;

        // Moon orbit
        const mOrbit = document.createElementNS(SVG_NS, 'circle');
        mOrbit.setAttribute('cx', pos.x);
        mOrbit.setAttribute('cy', pos.y);
        mOrbit.setAttribute('r', m.a);
        mOrbit.setAttribute('fill', 'none');
        mOrbit.setAttribute('stroke', '#1A2A3A');
        mOrbit.setAttribute('stroke-width', mapState.zoom * 0.0003);
        planetGroup.appendChild(mOrbit);

        // Moon body
        const mR = Math.max(minBodyR * 0.6, mapState.zoom * 0.002);
        const mBody = document.createElementNS(SVG_NS, 'circle');
        mBody.setAttribute('cx', mx);
        mBody.setAttribute('cy', my);
        mBody.setAttribute('r', mR);
        mBody.setAttribute('fill', m.color);
        planetGroup.appendChild(mBody);

        // Moon label at high zoom
        if (mapState.zoom < moonViewThreshold * 0.3) {
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

      if (mapState.zoom < 5) {
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
  return svg;
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

  // Mouse drag pan
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mapState.dragging = true;
    mapState.dragStart = { x: e.clientX, y: e.clientY };
    mapState.dragCenterStart = { x: mapState.cx, y: mapState.cy };
    container.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!mapState.dragging) return;
    const rect = container.getBoundingClientRect();
    const aspect = rect.width / rect.height;
    const dx = (e.clientX - mapState.dragStart.x) / rect.width * mapState.zoom * aspect * 2;
    const dy = (e.clientY - mapState.dragStart.y) / rect.height * mapState.zoom * 2;
    mapState.cx = mapState.dragCenterStart.x - dx;
    mapState.cy = mapState.dragCenterStart.y - dy;
  });

  window.addEventListener('mouseup', () => {
    if (mapState.dragging) {
      mapState.dragging = false;
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

export function getMapState() {
  return mapState;
}

// ---- HELPERS ----

function gameTimeToDays(time, stats) {
  // Days elapsed since game start
  return (stats?.daysElapsed || 0) + (time?.hour || 0) / 24 + (time?.minute || 0) / 1440;
}
