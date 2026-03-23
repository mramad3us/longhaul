// ============================================================
// LONGHAUL — Main Application Controller
// Crew selection, toasts, particles, critical alerts
// ============================================================

import {
  iconNewGame, iconLoadGame, iconSettings, iconPause,
  iconHudSettings, iconHudSave, iconHudExit,
  iconMinus, iconPlus, iconDelete, iconThrust,
  iconFuel, iconOxygen, iconWater, iconFood, iconCrew, iconPower,
  logoShip, createStarfield, setCrewGravity,
} from './svg-icons.js';

import { initStorage, saveGame, loadGame, listSaves, deleteSave } from './storage.js';
import { createGameState, formatDate, formatTime, GameLoop } from './game.js';
import { renderShip, renderTacView } from './ship.js';
import { VERSION } from './version.js';
import { toggleThrust, setThrustLevel, startFlip, updateFlip, CrewState } from './physics.js';

// ---- STATE ----
let currentScreen = 'landing';
let gameState = null;
let gameLoop = null;
let crewCount = 4;
let selectedCrew = null;
let particleInterval = null;
let lastCrewStateKey = null;
let lastThrustActive = null;
let lastTacVelocityBucket = null;
let tacZoomLevel = 0;
let flipAnimFrame = null;

// ---- SHIP'S LOG ----
const MAX_LOG_ENTRIES = 200;
let logEntries = [];
let logExpanded = false;

// Log categories with icons (pixel-art style Unicode)
const LOG_ICONS = {
  thrust:  '\u25B2', // ▲
  danger:  '\u2716', // ✖
  warn:    '\u26A0', // ⚠
  ok:      '\u2714', // ✔
  crew:    '\u263A', // ☺
  system:  '\u25C8', // ◈
  nav:     '\u25C6', // ◆
};

function addLogEntry(message, category = 'system') {
  if (!gameState) return;
  const time = formatTime(gameState.time);
  const entry = { time, message, category };
  logEntries.unshift(entry); // newest first
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.pop();
  renderLogEntries();
}

function renderLogEntries() {
  const container = document.getElementById('log-entries');
  const countEl = document.getElementById('log-count');
  if (!container) return;

  // Only render visible entries
  const visibleCount = logExpanded ? logEntries.length : Math.min(3, logEntries.length);
  const entries = logEntries.slice(0, visibleCount);

  container.innerHTML = entries.map(e =>
    `<div class="log-entry log-${e.category}">
      <span class="log-entry-time">${e.time}</span>
      <span class="log-entry-icon">${LOG_ICONS[e.category] || LOG_ICONS.system}</span>
      <span class="log-entry-msg">${escapeHtml(e.message)}</span>
    </div>`
  ).join('');

  if (countEl) countEl.textContent = logEntries.length;
}

function initLog() {
  const expandBtn = document.getElementById('log-expand-btn');
  const logContainer = document.getElementById('log-container');

  expandBtn.addEventListener('click', () => {
    logExpanded = !logExpanded;
    logContainer.classList.toggle('expanded', logExpanded);
    document.getElementById('log-expand-text').textContent =
      logExpanded ? 'COLLAPSE' : 'SHOW FULL LOG';
    renderLogEntries();
    if (logExpanded) {
      logContainer.scrollTop = 0;
    }
  });
}

function clearLog() {
  logEntries = [];
  logExpanded = false;
  const logContainer = document.getElementById('log-container');
  if (logContainer) logContainer.classList.remove('expanded');
  const expandText = document.getElementById('log-expand-text');
  if (expandText) expandText.textContent = 'SHOW FULL LOG';
  renderLogEntries();
}

// ---- SCREEN MANAGEMENT ----

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    if (s.classList.contains('active')) {
      s.classList.add('fade-out');
      s.classList.remove('active');
      setTimeout(() => s.classList.remove('fade-out'), 500);
    }
  });

  setTimeout(() => {
    const screen = document.getElementById(`screen-${name}`);
    if (screen) {
      screen.classList.add('active');
    }
    currentScreen = name;
  }, 120);
}

// ---- TOAST NOTIFICATION SYSTEM ----

function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type ? 'toast-' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 3200);
}

// ---- FLOATING PARTICLES ----

function initParticles() {
  const container = document.getElementById('viewport-particles');
  if (!container) return;

  if (particleInterval) clearTimeout(particleInterval);

  function spawnParticle() {
    if (currentScreen !== 'game') {
      particleInterval = setTimeout(spawnParticle, 400);
      return;
    }

    const p = document.createElement('div');
    p.className = 'particle';

    // Particles reflect velocity RELATIVE TO THE SHIP.
    // Camera is attached to the ship, so when we flip 180°,
    // we're now moving backwards — particles must reverse.
    // relativeVel > 0 = moving forward (particles flow down past us)
    // relativeVel < 0 = moving backward (particles flow up past us)
    const phys = gameState ? gameState.physics : null;
    const absVelocity = phys ? phys.velocity : 0;     // absolute frame velocity
    const heading = phys ? phys.heading : 0;
    const velocity = heading === 0 ? absVelocity : -absVelocity; // ship-relative
    const absVel = Math.abs(velocity);

    // Speed factor: 0 = stationary, 1 = very fast (100 km/s+)
    const speedFactor = Math.min(1, absVel / 100000);

    if (absVel < 1) {
      // Nearly stationary: gentle random micro-debris drift
      const dx = (Math.random() - 0.5) * 20;
      const dy = (Math.random() - 0.5) * 20;
      p.style.setProperty('--dx', dx + 'px');
      p.style.setProperty('--dy', dy + 'px');
      p.style.width = '2px';
      p.style.height = '2px';
      p.style.left = Math.random() * 100 + '%';
      p.style.top = Math.random() * 100 + '%';
    } else {
      // Moving: particles stream opposite to velocity direction
      // velocity > 0 → flowDir = +1 (particles move down on screen)
      // velocity < 0 → flowDir = -1 (particles move up on screen)
      const flowDir = velocity > 0 ? 1 : -1;

      // Lateral drift decreases as speed increases (tighter streaks)
      const lateralDrift = (1 - speedFactor) * 0.6;
      const dx = (Math.random() - 0.5) * 30 * lateralDrift;
      const dy = flowDir * (20 + speedFactor * 200) + (Math.random() - 0.5) * 10 * lateralDrift;

      p.style.setProperty('--dx', dx + 'px');
      p.style.setProperty('--dy', dy + 'px');

      // Streak length: proportional to speed. Dots when slow, long streaks when fast.
      const streakH = Math.max(2, 2 + speedFactor * 14);
      const streakW = speedFactor > 0.3 ? 1 : 2;
      p.style.width = streakW + 'px';
      p.style.height = streakH + 'px';

      // Spawn from the edge particles are flowing FROM
      p.style.left = Math.random() * 100 + '%';
      if (speedFactor > 0.15) {
        p.style.top = (flowDir > 0 ? (Math.random() * 25) : (75 + Math.random() * 25)) + '%';
      } else {
        p.style.top = Math.random() * 100 + '%';
      }
    }

    // Duration: faster = shorter time on screen
    const dur = Math.max(1.5, 6 - speedFactor * 4) + Math.random() * 2;
    p.style.animationDuration = dur + 's';

    // Color variation
    if (Math.random() > 0.7) {
      p.style.background = '#E2A355';
    }

    container.appendChild(p);
    setTimeout(() => {
      if (p.parentNode) p.parentNode.removeChild(p);
    }, dur * 1000);

    // Schedule next particle — more particles at higher speed
    particleInterval = setTimeout(spawnParticle, speedParticleRate());
  }

  particleInterval = setTimeout(spawnParticle, 400);
}

// Ship-relative velocity: what the crew perceives.
// Positive = moving forward, negative = moving backward.
function getRelativeVelocity(phys) {
  if (!phys) return 0;
  return phys.heading === 0 ? phys.velocity : -phys.velocity;
}

function speedParticleRate() {
  if (!gameState) return 400;
  const absVel = Math.abs(gameState.physics.velocity);
  const speedFactor = Math.min(1, absVel / 100000);
  // More particles at high speed: 400ms → 120ms
  return Math.max(120, 400 - speedFactor * 280);
}

// ---- LANDING SCREEN ----

function initLanding() {
  document.getElementById('landing-logo').appendChild(logoShip());
  document.getElementById('icon-new-game').appendChild(iconNewGame());
  document.getElementById('icon-load-game').appendChild(iconLoadGame());
  document.getElementById('icon-settings-menu').appendChild(iconSettings());

  createStarfield(document.querySelector('.landing-bg'));

  document.querySelectorAll('.menu-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'new-game') showScreen('new-game');
      else if (action === 'load-game') {
        refreshSaveList();
        showScreen('load-game');
      }
      else if (action === 'settings') showScreen('settings');
    });
  });
}

// ---- NEW GAME SCREEN ----

function initNewGame() {
  document.getElementById('icon-minus').appendChild(iconMinus());
  document.getElementById('icon-plus').appendChild(iconPlus());

  document.getElementById('crew-minus').addEventListener('click', () => {
    crewCount = Math.max(1, crewCount - 1);
    document.getElementById('crew-count').textContent = crewCount;
  });

  document.getElementById('crew-plus').addEventListener('click', () => {
    crewCount = Math.min(8, crewCount + 1);
    document.getElementById('crew-count').textContent = crewCount;
  });
}

// ---- LOAD GAME SCREEN ----

async function refreshSaveList() {
  const list = document.getElementById('save-list');
  const saves = await listSaves();

  if (saves.length === 0) {
    list.innerHTML = '<p class="save-empty">No saved missions found.</p>';
    return;
  }

  list.innerHTML = '';
  saves.forEach(save => {
    const item = document.createElement('div');
    item.className = 'save-item';

    const date = new Date(save.timestamp);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    item.innerHTML = `
      <div class="save-item-info">
        <span class="save-item-name">${escapeHtml(save.name)}</span>
        <span class="save-item-meta">${escapeHtml(save.state.ship.name)} — ${dateStr}</span>
      </div>
      <div class="save-item-actions">
        <button class="save-item-delete" data-save-id="${save.id}" title="Delete"></button>
      </div>
    `;

    item.addEventListener('click', async (e) => {
      if (e.target.closest('.save-item-delete')) return;
      const saveData = await loadGame(save.id);
      gameState = saveData.state;
      startGame();
      showToast('Mission loaded', 'ok');
    });

    const delBtn = item.querySelector('.save-item-delete');
    delBtn.appendChild(iconDelete());
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSave(save.id);
      refreshSaveList();
      showToast('Save deleted');
    });

    list.appendChild(item);
  });
}

// ---- HUD ICONS ----

function initHud() {
  document.getElementById('icon-pause').appendChild(iconPause());
  document.getElementById('icon-hud-settings').appendChild(iconHudSettings());
  document.getElementById('icon-hud-save').appendChild(iconHudSave());
  document.getElementById('icon-hud-exit').appendChild(iconHudExit());
  document.getElementById('icon-thrust').appendChild(iconThrust());

  // Thrust toggle button — toggles between off and last slider value
  document.getElementById('thrust-toggle').addEventListener('click', () => {
    if (!gameState) return;
    const phys = gameState.physics;
    const slider = document.getElementById('thrust-slider');

    if (phys.thrustActive) {
      // Turn off
      setThrustLevel(phys, 0);
      slider.value = 0;
      updateThrustSliderUI(0);
      addLogEntry('Torch engine shutdown — entering micro-G', 'thrust');
    } else {
      // Turn on to slider value or default 20% (2G)
      const level = parseFloat(slider.value) / 100 || 0.2;
      setThrustLevel(phys, level);
      slider.value = level * 100;
      updateThrustSliderUI(level);
      const gVal = (level * phys.maxThrust).toFixed(1);
      addLogEntry(`Torch engine firing at ${gVal}G`, 'thrust');
    }
  });

  // Thrust slider
  const slider = document.getElementById('thrust-slider');
  slider.addEventListener('input', () => {
    if (!gameState) return;
    const level = parseFloat(slider.value) / 100;
    setThrustLevel(gameState.physics, level);
    updateThrustSliderUI(level);
  });

  // Log on slider release for significant changes
  let lastLoggedG = 0;
  slider.addEventListener('change', () => {
    if (!gameState) return;
    const gVal = gameState.physics.thrustLevel * gameState.physics.maxThrust;
    if (Math.abs(gVal - lastLoggedG) > 0.3) {
      if (gVal === 0) {
        addLogEntry('Torch engine shutdown — entering micro-G', 'thrust');
      } else {
        addLogEntry(`Thrust adjusted to ${gVal.toFixed(1)}G`, 'thrust');
      }
      lastLoggedG = gVal;
    }
  });

  initLog();

  // Flip maneuver button
  document.getElementById('flip-toggle').addEventListener('click', () => {
    if (!gameState) return;
    const phys = gameState.physics;
    if (phys.flipping) return; // already flipping

    if (startFlip(phys)) {
      addLogEntry('Flip maneuver initiated', 'nav');

      // Update thrust UI since flip cuts thrust
      const sliderEl = document.getElementById('thrust-slider');
      sliderEl.value = 0;
      updateThrustSliderUI(0);

      // Show RCS thrusters on main view
      showRcsThrusters(true);

      const flipBtn = document.getElementById('flip-toggle');
      flipBtn.classList.add('flipping');

      // Animate flip in real-time
      let lastTime = performance.now();
      function animateFlip(now) {
        const deltaSec = (now - lastTime) / 1000;
        lastTime = now;
        const complete = updateFlip(phys, deltaSec);

        // Update RCS on tac view during flip (close zoom only)
        const tacScreen = document.getElementById('tac-screen');
        if (tacScreen && tacZoomLevel === 0) {
          renderTacView(gameState.ship, tacScreen, phys.thrustActive, tacZoomLevel, phys.flipping, getRelativeVelocity(phys));
        }

        if (complete) {
          flipBtn.classList.remove('flipping');
          const relV = getRelativeVelocity(phys);
          const headingLabel = relV >= 0 ? 'PRO' : 'RETRO';
          document.getElementById('flip-heading').textContent = headingLabel;
          addLogEntry(`Flip complete — now ${relV >= 0 ? 'prograde' : 'retrograde'}`, 'nav');
          showRcsThrusters(false);
          // Re-render tac view
          if (tacScreen) {
            renderTacView(gameState.ship, tacScreen, phys.thrustActive, tacZoomLevel, false, phys.velocity);
          }
          flipAnimFrame = null;
          return;
        }
        flipAnimFrame = requestAnimationFrame(animateFlip);
      }
      flipAnimFrame = requestAnimationFrame(animateFlip);
    }
  });

  // Tac zoom controls
  const rangeLabels = ['1 km', '5 km', '25 km'];
  document.querySelectorAll('.tac-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tacZoomLevel = parseInt(btn.dataset.tacZoom);
      document.querySelectorAll('.tac-zoom-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tac-range').textContent = rangeLabels[tacZoomLevel];
      // Re-render tac view
      const tacScreen = document.getElementById('tac-screen');
      if (tacScreen && gameState) {
        renderTacView(gameState.ship, tacScreen, gameState.physics.thrustActive, tacZoomLevel, false, getRelativeVelocity(gameState.physics));
      }
    });
  });
}

// ---- RCS THRUSTER VISUALS (main view) ----
function showRcsThrusters(active) {
  const existing = document.getElementById('rcs-thrusters');
  if (!active) {
    if (existing) existing.setAttribute('display', 'none');
    return;
  }

  if (existing) {
    existing.setAttribute('display', 'inline');
    return;
  }

  // Create RCS thruster group on the ship SVG
  const shipSvg = document.querySelector('#ship-container svg');
  if (!shipSvg) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const rcs = document.createElementNS(SVG_NS, 'g');
  rcs.setAttribute('id', 'rcs-thrusters');

  // Find hull bounds from the ship SVG viewBox
  const vb = shipSvg.getAttribute('viewBox').split(' ').map(Number);
  const svgW = vb[2];

  // Ship hull: roughly tiles at offsetX to offsetX + shipWidth
  // We'll position RCS at corners of the hull outline
  const hullEl = shipSvg.querySelector('path[stroke]');
  if (!hullEl) return;

  const bbox = hullEl.getBBox();
  const hx = bbox.x;
  const hy = bbox.y;
  const hw = bbox.width;
  const hh = bbox.height;

  // 4 RCS thruster positions: top-left, top-right, bottom-left, bottom-right
  const positions = [
    { x: hx - 6, y: hy + 8, dir: -1 },       // top-left: fires left
    { x: hx + hw + 6, y: hy + 8, dir: 1 },    // top-right: fires right
    { x: hx - 6, y: hy + hh - 8, dir: 1 },    // bottom-left: fires right (torque)
    { x: hx + hw + 6, y: hy + hh - 8, dir: -1 }, // bottom-right: fires left (torque)
  ];

  const thrusterParts = [];
  positions.forEach((pos, i) => {
    const plumeW = 8;
    const plumeH = 3;
    // Small blocky RCS plume pointing outward
    const px = pos.dir > 0 ? pos.x : pos.x - plumeW;
    thrusterParts.push(`
      <rect x="${px}" y="${pos.y - plumeH / 2}" width="${plumeW}" height="${plumeH}"
        fill="#E2A355" opacity="0.9">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="0.08s" repeatCount="indefinite"/>
      </rect>
      <rect x="${px + (pos.dir > 0 ? plumeW : -3)}" y="${pos.y - 1}" width="3" height="2"
        fill="#FFCC66" opacity="0.7">
        <animate attributeName="opacity" values="0.4;0.8;0.4" dur="0.06s" repeatCount="indefinite"/>
      </rect>
    `);
  });

  rcs.innerHTML = thrusterParts.join('');
  shipSvg.appendChild(rcs);
}

function updateThrustSliderUI(level) {
  const phys = gameState ? gameState.physics : null;
  const maxG = phys ? phys.maxThrust : 10;
  const gVal = level * maxG;
  const valueEl = document.getElementById('thrust-slider-value');
  const sliderEl = document.getElementById('thrust-slider');

  valueEl.textContent = `${gVal.toFixed(1)}G`;

  // Style based on G-force danger
  valueEl.classList.remove('active', 'danger');
  sliderEl.classList.remove('active');
  if (gVal >= 2.5) {
    valueEl.classList.add('danger');
    sliderEl.classList.add('active');
  } else if (gVal > 0) {
    valueEl.classList.add('active');
    sliderEl.classList.add('active');
  }
}

// ---- CREW SELECTION ----

function selectCrew(member) {
  selectedCrew = member;

  // Update visual selection
  document.querySelectorAll('.crew-symbol').forEach(el => {
    el.classList.remove('selected');
    if (parseInt(el.getAttribute('data-crew-id')) === member.id) {
      el.classList.add('selected');
    }
  });

  // Update info panel
  const crewInfo = document.getElementById('crew-info');
  crewInfo.innerHTML = `
    <div class="crew-detail-name">${escapeHtml(member.name)}</div>
    <div class="crew-detail-role">${member.role}</div>
    <div class="crew-stat">
      <span class="crew-stat-label">Health</span>
      <div class="crew-stat-bar"><div class="crew-stat-fill health" style="width: ${member.health}%"></div></div>
    </div>
    <div class="crew-stat">
      <span class="crew-stat-label">Morale</span>
      <div class="crew-stat-bar"><div class="crew-stat-fill morale" style="width: ${member.morale}%"></div></div>
    </div>
    <div class="info-line" style="margin-top: 6px">
      <span class="info-key">Deck</span>
      <span class="info-val">${gameState.ship.decks[member.deck].name}</span>
    </div>
  `;
}

// ---- RESOURCE PANEL ----

const RESOURCE_CONFIG = [
  { key: 'fuel', name: 'Fuel', icon: iconFuel, barClass: 'bar-fuel' },
  { key: 'oxygen', name: 'O2', icon: iconOxygen, barClass: 'bar-oxygen' },
  { key: 'water', name: 'H2O', icon: iconWater, barClass: 'bar-water' },
  { key: 'food', name: 'Food', icon: iconFood, barClass: 'bar-food' },
  { key: 'power', name: 'Power', icon: iconPower, barClass: 'bar-power' },
];

function initResourcePanel() {
  const panel = document.getElementById('resource-panel');
  // Keep the tac view and panel header
  const tacView = panel.querySelector('.tac-view');
  const header = panel.querySelector('.panel-header');
  panel.innerHTML = '';
  if (tacView) panel.appendChild(tacView);
  if (header) panel.appendChild(header);

  // Crew count
  const crewItem = document.createElement('div');
  crewItem.className = 'resource-item';
  crewItem.id = 'resource-crew';
  crewItem.innerHTML = `
    <div class="resource-icon" id="res-icon-crew"></div>
    <div class="resource-info">
      <div class="resource-name">Crew</div>
      <div class="resource-value" id="res-val-crew">0</div>
    </div>
  `;
  panel.appendChild(crewItem);
  document.getElementById('res-icon-crew').appendChild(iconCrew());

  // Resources
  RESOURCE_CONFIG.forEach(cfg => {
    const item = document.createElement('div');
    item.className = 'resource-item';
    item.id = `resource-${cfg.key}`;
    item.innerHTML = `
      <div class="resource-icon" id="res-icon-${cfg.key}"></div>
      <div class="resource-info">
        <div class="resource-name">${cfg.name}</div>
        <div class="resource-value" id="res-val-${cfg.key}">0</div>
        <div class="resource-bar"><div class="resource-bar-fill ${cfg.barClass}" id="res-bar-${cfg.key}"></div></div>
      </div>
    `;
    panel.appendChild(item);
    document.getElementById(`res-icon-${cfg.key}`).appendChild(cfg.icon());
  });
}

// Track previous resource levels for alerts
let prevResourceLevels = {};

function updateResourcePanel(state) {
  document.getElementById('res-val-crew').textContent = state.ship.crew.length;

  let hasCritical = false;
  const alerts = [];

  RESOURCE_CONFIG.forEach(cfg => {
    const res = state.resources[cfg.key];
    if (!res) return;

    const pct = (res.current / res.max) * 100;
    const valEl = document.getElementById(`res-val-${cfg.key}`);
    const barEl = document.getElementById(`res-bar-${cfg.key}`);
    const itemEl = document.getElementById(`resource-${cfg.key}`);

    valEl.textContent = `${Math.round(res.current)} / ${res.max}`;
    barEl.style.width = `${pct}%`;

    itemEl.classList.remove('warning', 'critical');
    if (pct < 15) {
      itemEl.classList.add('critical');
      hasCritical = true;
      alerts.push(`${cfg.name} critical: ${Math.round(pct)}%`);

      // Toast + log on first entry to critical
      const prevPct = prevResourceLevels[cfg.key] || 100;
      if (prevPct >= 15 && pct < 15) {
        showToast(`${cfg.name} CRITICAL`, 'danger');
        addLogEntry(`${cfg.name} critical — ${Math.round(pct)}% remaining`, 'danger');
      }
    } else if (pct < 30) {
      itemEl.classList.add('warning');
      alerts.push(`${cfg.name} low: ${Math.round(pct)}%`);

      const prevPct = prevResourceLevels[cfg.key] || 100;
      if (prevPct >= 30 && pct < 30) {
        showToast(`${cfg.name} running low`, 'warn');
        addLogEntry(`${cfg.name} low — ${Math.round(pct)}% remaining`, 'warn');
      }
    }

    prevResourceLevels[cfg.key] = pct;
  });

  // Alert border
  const alertBorder = document.getElementById('alert-border');
  if (alertBorder) {
    if (hasCritical) {
      alertBorder.classList.add('critical');
    } else {
      alertBorder.classList.remove('critical');
    }
  }

  // Alerts are now shown in the ship's log — no separate alerts list needed
}

// ---- SPEED CONTROLS ----

function initSpeedControls() {
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseInt(btn.dataset.speed);
      if (gameLoop) {
        gameLoop.setSpeed(speed);
        updateSpeedUI(speed);
      }
    });
  });
}

function updateSpeedUI(speed) {
  document.querySelectorAll('.speed-btn').forEach(btn => {
    const btnSpeed = parseInt(btn.dataset.speed);
    btn.classList.remove('active', 'paused');
    if (btnSpeed === speed) {
      btn.classList.add(speed === 0 ? 'paused' : 'active');
    }
  });

  // Pause/unpause all animations
  const gameScreen = document.getElementById('screen-game');
  const shipSvg = document.querySelector('#ship-container svg');
  if (speed === 0) {
    gameScreen.classList.add('game-paused');
    if (shipSvg) shipSvg.pauseAnimations();
  } else {
    gameScreen.classList.remove('game-paused');
    if (shipSvg) shipSvg.unpauseAnimations();
  }
}

// ---- HUD UPDATE ----

function updateHud(state) {
  document.getElementById('hud-date').textContent = formatDate(state.time);
  document.getElementById('hud-time').textContent = formatTime(state.time);
  document.getElementById('hud-ship-name').textContent = state.ship.name;

  const phys = state.physics;
  const hasGravity = state.navigation.thrust > 0;

  // Ship status info
  document.getElementById('info-torch').textContent =
    phys.thrustActive ? `ON (${(phys.thrustLevel * phys.maxThrust).toFixed(1)}g)` : 'CUTOFF';
  document.getElementById('info-torch').style.color =
    phys.thrustActive ? '#FFFFFF' : '';
  document.getElementById('info-thrust').textContent =
    hasGravity ? `${state.navigation.thrust.toFixed(1)}g` : '0.0g';
  const relVelForHeading = getRelativeVelocity(phys);
  const headingText = phys.flipping ? 'FLIPPING' :
    (relVelForHeading >= 0 ? 'PROGRADE' : 'RETROGRADE');
  document.getElementById('info-heading').textContent = headingText;
  document.getElementById('info-heading').style.color =
    phys.flipping ? '#E2A355' : '';
  const flipHeadingEl = document.getElementById('flip-heading');
  if (flipHeadingEl && !phys.flipping) {
    flipHeadingEl.textContent = relVelForHeading >= 0 ? 'PRO' : 'RETRO';
  }
  // Velocity displayed relative to ship heading (camera follows ship)
  document.getElementById('info-velocity').textContent =
    formatVelocity(getRelativeVelocity(phys));
  document.getElementById('info-mass').textContent =
    `${(phys.shipMass / 1000).toFixed(1)} t`;

  // Thrust button + slider state
  const thrustBtn = document.getElementById('thrust-toggle');
  const thrustStatus = document.getElementById('thrust-status');
  const thrustSlider = document.getElementById('thrust-slider');
  if (phys.thrustActive) {
    thrustBtn.classList.add('active');
    thrustStatus.textContent = `${(phys.thrustLevel * phys.maxThrust).toFixed(1)}G`;
  } else {
    thrustBtn.classList.remove('active');
    thrustStatus.textContent = 'OFF';
  }
  // Sync slider if physics changed thrust externally (fuel out, etc.)
  if (thrustSlider && !thrustSlider.matches(':active')) {
    thrustSlider.value = phys.thrustLevel * 100;
    updateThrustSliderUI(phys.thrustLevel);
  }

  // Engine plume visibility + intensity scaling with thrust level
  const plume = document.getElementById('engine-plume');
  if (plume) {
    if (!phys.thrustActive) {
      plume.setAttribute('display', 'none');
    } else {
      plume.setAttribute('display', 'inline');
      // Scale opacity: min thrust = 0.4, max thrust = 1.0
      const intensity = 0.4 + phys.thrustLevel * 0.6;
      plume.setAttribute('opacity', intensity.toFixed(2));
    }
  }

  // Update tactical view when thrust state or velocity changes significantly
  // Bucket velocity so we don't re-render every frame
  const relVel = getRelativeVelocity(phys);
  const velSign = relVel >= 0 ? 1 : -1;
  const velBucket = velSign * Math.floor(Math.abs(relVel) / 5000);
  const tacNeedsUpdate = phys.thrustActive !== lastThrustActive || velBucket !== lastTacVelocityBucket;
  if (tacNeedsUpdate) {
    lastThrustActive = phys.thrustActive;
    lastTacVelocityBucket = velBucket;
    const tacScreen = document.getElementById('tac-screen');
    if (tacScreen) {
      renderTacView(state.ship, tacScreen, phys.thrustActive, tacZoomLevel, phys.flipping, getRelativeVelocity(phys));
    }
  }

  // Update crew visual states from physics
  const shipContainer = document.getElementById('ship-container');
  if (shipContainer) {
    // Build a serialized key of all crew states to detect changes
    const crewStateKey = JSON.stringify(phys.crewStates);
    if (crewStateKey !== lastCrewStateKey) {
      lastCrewStateKey = crewStateKey;
      setCrewGravity(shipContainer, hasGravity, phys.crewStates);
    }
  }
}

function formatVelocity(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs < 1000) return `${sign}${Math.round(abs)} m/s`;
  if (abs < 1000000) return `${sign}${(abs / 1000).toFixed(1)} km/s`;
  return `${sign}${(abs / 1000000).toFixed(2)} Mm/s`;
}

// ---- START GAME ----

function startGame() {
  showScreen('game');
  initResourcePanel();
  prevResourceLevels = {};
  selectedCrew = null;

  // Reset crew info panel
  const crewInfo = document.getElementById('crew-info');
  if (crewInfo) crewInfo.innerHTML = '<p class="info-line info-dim">Click a crew member</p>';

  // Render ship with crew click handler
  const shipContainer = document.getElementById('ship-container');
  renderShip(gameState.ship, shipContainer, (member) => {
    selectCrew(member);
  });

  // Render tactical view
  const tacScreen = document.getElementById('tac-screen');
  if (tacScreen) {
    renderTacView(gameState.ship, tacScreen, gameState.physics.thrustActive, tacZoomLevel, false, getRelativeVelocity(gameState.physics));
  }

  // Set initial gravity state (thrust=0 at start = micro-G)
  const hasGravity = gameState.navigation.thrust > 0;
  lastCrewStateKey = null;
  setCrewGravity(shipContainer, hasGravity, gameState.physics.crewStates);

  // Init log and add launch entry
  clearLog();
  addLogEntry(`Mission started — ${gameState.ship.name}`, 'system');
  addLogEntry(`Crew complement: ${gameState.ship.crew.length}`, 'crew');
  addLogEntry(`Ship mass: ${(gameState.physics.shipMass / 1000).toFixed(1)}t`, 'nav');

  // Sync thrust slider and flip heading to physics state
  const slider = document.getElementById('thrust-slider');
  if (slider) {
    slider.value = gameState.physics.thrustLevel * 100;
    updateThrustSliderUI(gameState.physics.thrustLevel);
  }
  const flipHeading = document.getElementById('flip-heading');
  if (flipHeading) {
    flipHeading.textContent = getRelativeVelocity(gameState.physics) >= 0 ? 'PRO' : 'RETRO';
  }

  // Start particles
  initParticles();

  // Update HUD
  updateHud(gameState);
  updateResourcePanel(gameState);
  updateSpeedUI(gameState.speed);

  // Start game loop
  if (gameLoop) gameLoop.stop();
  gameLoop = new GameLoop(gameState, (state) => {
    updateHud(state);
    updateResourcePanel(state);
  }, (event, data) => {
    if (event === 'crewStateChange') {
      data.forEach(({ member, oldState, newState }) => {
        if (newState === CrewState.PRONE) {
          showToast(`${member.name} crushed under high-G!`, 'danger');
          addLogEntry(`${member.name} (${member.role}) crushed — ${gameState.physics.gForce.toFixed(1)}G without crash couch`, 'danger');
        } else if (newState === CrewState.STRAINED) {
          addLogEntry(`${member.name} straining under ${gameState.physics.gForce.toFixed(1)}G`, 'warn');
        } else if (newState === CrewState.FLOATING && oldState === CrewState.STANDING) {
          addLogEntry(`${member.name} entering micro-G`, 'crew');
        } else if (newState === CrewState.STANDING && oldState === CrewState.FLOATING) {
          addLogEntry(`${member.name} on feet — gravity restored`, 'crew');
        } else if (oldState === CrewState.PRONE && newState !== CrewState.PRONE) {
          showToast(`${member.name} recovering from high-G`, 'ok');
          addLogEntry(`${member.name} recovering from high-G exposure`, 'ok');
        }
      });
    }
  });
  gameLoop.start();
}

// ---- HUD ACTIONS ----

function initHudActions() {
  // Save
  document.querySelector('[data-action="save-game"]').addEventListener('click', () => {
    document.getElementById('dialog-save').style.display = 'flex';
    document.getElementById('input-save-name').value = '';
    document.getElementById('input-save-name').focus();
  });

  document.querySelector('[data-action="confirm-save"]').addEventListener('click', async () => {
    const name = document.getElementById('input-save-name').value.trim() || 'Quicksave';
    await saveGame(gameState, name);
    document.getElementById('dialog-save').style.display = 'none';
    showToast('Mission saved', 'ok');
    addLogEntry(`Mission saved: "${name}"`, 'system');
  });

  document.querySelector('[data-action="cancel-save"]').addEventListener('click', () => {
    document.getElementById('dialog-save').style.display = 'none';
  });

  // Exit
  document.querySelector('[data-action="exit-game"]').addEventListener('click', () => {
    if (gameLoop) gameLoop.setSpeed(0);
    updateSpeedUI(0);
    document.getElementById('dialog-exit').style.display = 'flex';
  });

  document.querySelector('[data-action="confirm-exit"]').addEventListener('click', () => {
    document.getElementById('dialog-exit').style.display = 'none';
    if (gameLoop) gameLoop.stop();
    if (particleInterval) clearTimeout(particleInterval);
    gameState = null;
    selectedCrew = null;
    showScreen('landing');
  });

  document.querySelector('[data-action="cancel-exit"]').addEventListener('click', () => {
    document.getElementById('dialog-exit').style.display = 'none';
  });

  // In-game settings
  document.querySelector('[data-action="game-settings"]').addEventListener('click', () => {
    if (gameLoop) gameLoop.setSpeed(0);
    updateSpeedUI(0);
    showToast('Game paused');
  });
}

// ---- BACK BUTTONS ----

function initBackButtons() {
  document.querySelectorAll('[data-action="back"]').forEach(btn => {
    btn.addEventListener('click', () => showScreen('landing'));
  });
}

// ---- SETTINGS SCREEN ----

function initSettings() {
  const toggle = document.getElementById('setting-tooltips');
  toggle.addEventListener('click', () => {
    toggle.classList.toggle('active');
    toggle.textContent = toggle.classList.contains('active') ? 'ON' : 'OFF';
  });

  // Dev mode toggle
  const devToggle = document.getElementById('setting-devmode');
  devToggle.addEventListener('click', () => {
    devToggle.classList.toggle('active');
    const isActive = devToggle.classList.contains('active');
    devToggle.textContent = isActive ? 'ON' : 'OFF';
    document.body.classList.toggle('dev-mode', isActive);

    // Persist dev mode setting
    import('./storage.js').then(s => s.saveSetting('devMode', isActive));
  });
}

async function loadDevMode() {
  const { loadSetting } = await import('./storage.js');
  const devMode = await loadSetting('devMode', false);
  if (devMode) {
    document.body.classList.add('dev-mode');
    const toggle = document.getElementById('setting-devmode');
    if (toggle) {
      toggle.classList.add('active');
      toggle.textContent = 'ON';
    }
  }
}

// ---- START GAME FROM NEW GAME SCREEN ----

function initStartGame() {
  document.querySelector('[data-action="start-game"]').addEventListener('click', () => {
    const shipName = document.getElementById('input-ship-name').value.trim() || 'RSV Canterbury';
    const captainName = document.getElementById('input-captain-name').value.trim() || 'J. Holden';
    gameState = createGameState(shipName, captainName, crewCount);
    startGame();
    showToast('Mission started. Good luck, Captain.', 'ok');
  });
}

// ---- UTILITY ----

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- KEYBOARD SHORTCUTS ----

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (currentScreen !== 'game') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (gameLoop) {
          const newSpeed = gameState.speed === 0 ? 1 : 0;
          gameLoop.setSpeed(newSpeed);
          updateSpeedUI(newSpeed);
          if (newSpeed === 0) showToast('Paused');
        }
        break;
      case '1':
        if (gameLoop) { gameLoop.setSpeed(1); updateSpeedUI(1); }
        break;
      case '2':
        if (gameLoop) { gameLoop.setSpeed(2); updateSpeedUI(2); }
        break;
      case '3':
        if (gameLoop) { gameLoop.setSpeed(3); updateSpeedUI(3); }
        break;
      case 't':
      case 'T':
        // Dev mode only: toggle thrust
        if (document.body.classList.contains('dev-mode')) {
          document.getElementById('thrust-toggle').click();
        }
        break;
      case 'f':
      case 'F':
        // Dev mode only: flip maneuver
        if (document.body.classList.contains('dev-mode')) {
          document.getElementById('flip-toggle').click();
        }
        break;
      case 'Escape':
        // Deselect crew
        selectedCrew = null;
        document.querySelectorAll('.crew-symbol').forEach(el => el.classList.remove('selected'));
        const crewInfo = document.getElementById('crew-info');
        if (crewInfo) crewInfo.innerHTML = '<p class="info-line info-dim">Click a crew member</p>';
        break;
    }
  });
}

// ---- INIT ----

async function init() {
  await initStorage();

  initLanding();
  initNewGame();
  initHud();
  initSpeedControls();
  initHudActions();
  initBackButtons();
  initSettings();
  initStartGame();
  initKeyboard();
  await loadDevMode();

  // Set version in landing screen
  const versionEl = document.querySelector('.landing-version');
  if (versionEl) versionEl.textContent = `v${VERSION}`;

  console.log(`[LONGHAUL] v${VERSION} initialized`);
}

init();
