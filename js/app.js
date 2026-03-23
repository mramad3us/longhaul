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
import { renderShip } from './ship.js';
import { VERSION } from './version.js';
import { toggleThrust, CrewState } from './physics.js';

// ---- STATE ----
let currentScreen = 'landing';
let gameState = null;
let gameLoop = null;
let crewCount = 4;
let selectedCrew = null;
let particleInterval = null;
let lastCrewStateKey = null;

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

  if (particleInterval) clearInterval(particleInterval);

  particleInterval = setInterval(() => {
    if (currentScreen !== 'game') return;

    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';

    const dx = (Math.random() - 0.5) * 60;
    const dy = (Math.random() - 0.5) * 60;
    p.style.setProperty('--dx', dx + 'px');
    p.style.setProperty('--dy', dy + 'px');

    const dur = 6 + Math.random() * 8;
    p.style.animationDuration = dur + 's';

    // Vary particle appearance
    const size = Math.random() > 0.8 ? 3 : 2;
    p.style.width = size + 'px';
    p.style.height = size + 'px';

    if (Math.random() > 0.7) {
      p.style.background = '#E2A355';
    }

    container.appendChild(p);
    setTimeout(() => {
      if (p.parentNode) p.parentNode.removeChild(p);
    }, dur * 1000);
  }, 400);
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

  // Thrust toggle button
  document.getElementById('thrust-toggle').addEventListener('click', () => {
    if (!gameState) return;
    const isActive = toggleThrust(gameState.physics);
    if (isActive) {
      showToast(`Torch engine firing — ${gameState.physics.maxThrust}G thrust`, 'warn');
    } else {
      showToast('Torch engine off — entering micro-G');
    }
  });
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
  // Keep the panel header
  const header = panel.querySelector('.panel-header');
  panel.innerHTML = '';
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

      // Toast on first entry to critical
      const prevPct = prevResourceLevels[cfg.key] || 100;
      if (prevPct >= 15 && pct < 15) {
        showToast(`${cfg.name} CRITICAL`, 'danger');
      }
    } else if (pct < 30) {
      itemEl.classList.add('warning');
      alerts.push(`${cfg.name} low: ${Math.round(pct)}%`);

      const prevPct = prevResourceLevels[cfg.key] || 100;
      if (prevPct >= 30 && pct < 30) {
        showToast(`${cfg.name} running low`, 'warn');
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

  // Update alerts list
  const alertsList = document.getElementById('alerts-list');
  if (alertsList) {
    if (alerts.length === 0) {
      alertsList.innerHTML = '<p class="info-line alert-ok">All systems nominal</p>';
    } else {
      alertsList.innerHTML = alerts.map(a => {
        const isDanger = a.includes('critical');
        return `<p class="info-line" style="color: ${isDanger ? 'var(--danger)' : 'var(--warning)'}; font-family: var(--font-pixel); font-size: 0.3rem; line-height: 2;">${a}</p>`;
      }).join('');
    }
  }
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
    phys.thrustActive ? `ON (${(phys.thrustLevel * phys.maxThrust).toFixed(1)}g)` : 'OFF';
  document.getElementById('info-torch').style.color =
    phys.thrustActive ? '#FFFFFF' : '';
  document.getElementById('info-thrust').textContent =
    hasGravity ? `${state.navigation.thrust.toFixed(1)}g` : '0.0g';
  document.getElementById('info-heading').textContent =
    state.navigation.heading || '---';
  document.getElementById('info-velocity').textContent =
    formatVelocity(state.navigation.velocity);
  document.getElementById('info-mass').textContent =
    `${(phys.shipMass / 1000).toFixed(1)} t`;

  // Thrust button state
  const thrustBtn = document.getElementById('thrust-toggle');
  const thrustStatus = document.getElementById('thrust-status');
  if (phys.thrustActive) {
    thrustBtn.classList.add('active');
    thrustStatus.textContent = `${(phys.thrustLevel * phys.maxThrust).toFixed(1)}G`;
  } else {
    thrustBtn.classList.remove('active');
    thrustStatus.textContent = 'OFF';
  }

  // Engine plume visibility
  const plume = document.getElementById('engine-plume');
  if (plume) {
    plume.setAttribute('display', phys.thrustActive ? 'inline' : 'none');
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
  if (abs < 1000) return `${Math.round(abs)} m/s`;
  if (abs < 1000000) return `${(abs / 1000).toFixed(1)} km/s`;
  return `${(abs / 1000000).toFixed(2)} Mm/s`;
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

  // Set initial gravity state (thrust=0 at start = micro-G)
  const hasGravity = gameState.navigation.thrust > 0;
  lastCrewStateKey = null;
  setCrewGravity(shipContainer, hasGravity, gameState.physics.crewStates);

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
        } else if (newState === CrewState.STRAINED) {
          showToast(`${member.name} struggling under ${gameState.physics.gForce.toFixed(1)}G`, 'warn');
        } else if (oldState === CrewState.PRONE && newState !== CrewState.PRONE) {
          showToast(`${member.name} recovering from high-G`, 'ok');
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
    if (particleInterval) clearInterval(particleInterval);
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
        if (gameState) {
          const isActive = toggleThrust(gameState.physics);
          if (isActive) {
            showToast(`Torch engine firing — ${gameState.physics.maxThrust}G thrust`, 'warn');
          } else {
            showToast('Torch engine off — entering micro-G');
          }
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

  // Set version in landing screen
  const versionEl = document.querySelector('.landing-version');
  if (versionEl) versionEl.textContent = `v${VERSION}`;

  console.log(`[LONGHAUL] v${VERSION} initialized`);
}

init();
