// ============================================================
// LONGHAUL — Main Application Controller
// Crew selection, toasts, particles, critical alerts
// ============================================================

import {
  iconNewGame, iconLoadGame, iconSettings, iconPause,
  iconHudSettings, iconHudSave, iconHudExit,
  iconMinus, iconPlus, iconDelete, iconThrust,
  iconFuel, iconOxygen, iconN2, iconWater, iconFood, iconCrew, iconPower, iconMedical,
  logoShip, createStarfield, setCrewGravity, TILE_NAMES, TileType,
} from './svg-icons.js';

import { initStorage, saveGame, loadGame, listSaves, deleteSave } from './storage.js';
import { createGameState, formatDate, formatTime, GameLoop } from './game.js';
import { renderShip, renderTacView, getOverallHealth } from './ship.js';
import { VERSION } from './version.js';
import { toggleThrust, setThrustLevel, startFlip, updateFlip, CrewState, stabilizeCrew } from './physics.js';
import { initCrewMovement, updateCrewMovement, getCrewMission, isBeingRescued, assignRecoverMission, assignRescueMission, cancelMission, assignSecureBurnMission, releaseSecureBurn, isSeatedInCouch, assignRepairLSMission, isRepairComplete, assignEquipSuitMission, isSuitDonned, serializeCrewMovement, restoreCrewMovement } from './crew-movement.js';
import { generateAutoJobs, clearJobs, getJobQueue, getCrewJobs, completeJob, JobPriority, JobType } from './jobs.js';
import { getAtmoStatus, getEquipmentStatusLabel, depressurizeCompartment, repressurizeCompartment, quickPatchLS, toggleLS, countSuitsOnDeck, donEvaSuit, removeEvaSuit, findNearestSuitLocker } from './life-support.js';
import { renderSolarSystem, initSolarMapInteraction, zoomToPreset, zoomToPlanet, zoomToBody, SOLAR_ZOOM_PRESETS, resetMapState, getMapState, setOnBodySelect, getSelectedBody, setSelectedBody } from './solar-system.js';
import { findBody, getBodyWorldPos, calculateRoutes, activateRoute, cancelRoute, getActiveRoute, getRouteProgress, formatDuration, formatDeltaV, serializeRoute, deserializeRoute, resetRoute, overrideSecure, markSecureComplete, isSecureBlocking } from './navigation.js';
import { initReactor, ReactorState, isReactorOnline, getReactorStatusText, beginShutdown, cancelShutdown, beginEmergencyShutoff, immediateEmergencyShutoff, cancelEmergencyShutoff, beginStartup, patchReactor, STARTUP_MIN_ENGINEERING, STARTUP_MIN_FUEL } from './reactor.js';
import { createDefaultEntities, entityTick, computeOrbitalVelocity, getEntityById, initializeEntityOrbit, entityDistanceAU, bearingTo } from './entities.js';
import { initComms, commsTick, toggleTransponder, triggerSOS, getRadioContacts, isTransponderOn, isSosActive, getHailDialogue } from './comms.js';
import { initScanner, scannerTick, renderScanner, selectContact, deselectContact, startTracking, stopTracking, setRange, getTrackedEntity, getSelectedContact, SCANNER_RANGES, getShipFacing } from './scanner.js';
import { initMissions, acceptMission, declineMission, startIntercept, cancelIntercept, computeInterceptRoute, computeFineTuneRoute, completeMissionViaHail, getActiveMissions, getMissionLog, getMissionForEntity, getInterceptState, startFineApproach, isFineApproaching, serializeMissions, deserializeMissions, INTERCEPT_TYPE, INTERCEPT_RANGE_AU } from './missions.js';
import { initInertia, triggerManeuverEvent, updateInertiaFrame, isInertiaActive, ManeuverType, enterCinematicTime, exitCinematicTime, isInCinematicTime, drainImpactEvents, internalBleedingTick } from './inertia.js';

// ---- HELPERS ----
function isBlackout() {
  return gameState && gameState.resources.power.current <= 0 && gameState.reactor && gameState.reactor.status === 'offline';
}

// Get velocity target for relative velocity display
// Priority: scanner tracked contact > route destination > solar map selection
function getVelocityTarget() {
  if (!gameState) return null;

  // Scanner tracked contact
  const tracked = getTrackedEntity(gameState);
  if (tracked) {
    return { name: tracked.name, velocity: tracked.velocity, position: tracked.position, type: 'entity' };
  }

  // Active route destination
  const route = getActiveRoute();
  if (route && route.active && route.destinationName) {
    const body = findBody(route.destinationName, gameState);
    if (body) {
      if (body.type === 'entity' && body.entity) {
        return { name: body.entity.name, velocity: body.entity.velocity, position: body.entity.position, type: 'entity' };
      }
      const days = gameState.stats?.daysElapsed || 0;
      const vel = computeOrbitalVelocity(route.destinationName, days);
      const pos = getBodyWorldPos(body, days);
      return { name: route.destinationName, velocity: vel, position: pos, type: 'body' };
    }
  }

  // Solar map selected body (or entity)
  const selBody = getSelectedBody();
  if (selBody) {
    // Check if it's an entity first
    if (selBody.entityId && gameState.entities) {
      const entity = gameState.entities.find(e => e.id === selBody.entityId);
      if (entity) {
        return { name: entity.name, velocity: entity.velocity, position: entity.position, type: 'entity' };
      }
    }
    const body = findBody(selBody.name, gameState);
    if (body) {
      if (body.type === 'entity' && body.entity) {
        return { name: body.entity.name, velocity: body.entity.velocity, position: body.entity.position, type: 'entity' };
      }
      const days = gameState.stats?.daysElapsed || 0;
      const vel = computeOrbitalVelocity(selBody.name, days);
      return { name: selBody.name, velocity: vel, position: { x: selBody.x, y: selBody.y }, type: 'body' };
    }
  }

  return null;
}

function getDisplayVelocity() {
  if (!gameState) return { text: '---', ref: null };
  const target = getVelocityTarget();
  if (!target) return { text: '---', ref: null };

  const shipVel = gameState.physics.velocity;
  const dvx = shipVel.vx - target.velocity.vx;
  const dvy = shipVel.vy - target.velocity.vy;
  const relSpeed = Math.sqrt(dvx * dvx + dvy * dvy);

  return { text: formatVelocity(relSpeed), ref: target.name };
}

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
let lastOrienting = null;
// Orient maneuver state: null | 'waiting-pilot' | 'waiting-crew' | 'active'
let _orientState = null;
let tacZoomLevel = 0;
let flipAnimFrame = null;
let crewMoveFrame = null;

// ---- DOM CACHES (populated by initHudCache) ----
let _hud = {};
let _resCache = {};    // keyed by resource key, e.g. _resCache['fuel'] = { val, bar, item }
let _solarCache = {};
let _thrustSliderActive = false;

// ---- FPS COUNTER ----
let fpsEnabled = false;
let _fpsFrames = 0;
let _fpsLastSample = 0;
let _fpsTickCounter = 0; // throttle counter for heavy per-frame work

// ---- ROUTE PLANNING ----
let routePanelOpen = false;
let computedRoutes = [];
let selectedRouteIdx = -1;

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
  debug:   '\u25CB', // ○
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

// ---- MANEUVER PROMPT ----
// Persistent overlay when orient phase is waiting for crew/pilot

function showManeuverPrompt() {
  let el = document.getElementById('maneuver-prompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'maneuver-prompt';
    el.className = 'maneuver-prompt';
    document.getElementById('screen-game')?.appendChild(el);
  }
  el.style.display = 'flex';
  updateManeuverPrompt();
}

function updateManeuverPrompt() {
  const el = document.getElementById('maneuver-prompt');
  if (!el) return;

  const pilot = gameState?.ship.crew.find(c => c.role === 'Pilot' && !c.dead);
  const pilotReady = pilot && isSeatedInCouch(pilot.id);

  const aliveCrew = gameState?.ship.crew.filter(c => !c.dead && c.consciousness > 10) || [];
  const secured = aliveCrew.filter(c => isSeatedInCouch(c.id));
  const unsecured = aliveCrew.length - secured.length;

  let statusHtml = '';
  if (!pilotReady) {
    statusHtml = `<span class="mp-status mp-waiting">PILOT EN ROUTE TO HELM</span>`;
  } else if (unsecured > 0) {
    statusHtml = `<span class="mp-status mp-caution">${unsecured} CREW UNSECURED</span>`;
  } else {
    statusHtml = `<span class="mp-status mp-ready">ALL HANDS SECURED</span>`;
  }

  const crewDots = aliveCrew.map(c => {
    const seated = isSeatedInCouch(c.id);
    const isPilot = c.role === 'Pilot';
    return `<span class="mp-dot ${seated ? 'mp-dot-ok' : 'mp-dot-wait'} ${isPilot ? 'mp-dot-pilot' : ''}" title="${c.name} — ${seated ? 'secured' : 'moving'}">${isPilot ? 'P' : '·'}</span>`;
  }).join('');

  el.innerHTML = `
    <div class="mp-header">ORIENTATION MANEUVER</div>
    <div class="mp-crew-row">${crewDots}</div>
    ${statusHtml}
    <button class="mp-engage-btn" id="mp-engage-btn" ${!pilotReady ? 'disabled' : ''}>${pilotReady ? 'ENGAGE MANEUVER' : 'WAITING FOR PILOT'}</button>
  `;

  const btn = document.getElementById('mp-engage-btn');
  if (btn && pilotReady) {
    btn.onclick = () => engageOrientManeuver(gameState);
  }
}

function engageOrientManeuver(state) {
  _orientState = 'active';
  hideManeuverPrompt();
  showRcsThrusters('orient');

  const pilot = state.ship.crew.find(c => c.role === 'Pilot' && !c.dead);
  const aliveCrew = state.ship.crew.filter(c => !c.dead && c.consciousness > 10);
  const unsecured = aliveCrew.filter(c => !isSeatedInCouch(c.id));

  if (unsecured.length > 0) {
    addLogEntry(`${pilot?.name || 'Pilot'}: engaging maneuver — ${unsecured.length} crew unsecured!`, 'warn');
    showToast(`MANEUVER — ${unsecured.length} crew unsecured!`, 'warn');
  } else {
    addLogEntry(`${pilot?.name || 'Pilot'}: all hands secured — engaging orientation`, 'nav');
  }
}

function hideManeuverPrompt() {
  const el = document.getElementById('maneuver-prompt');
  if (el) el.style.display = 'none';
}

// ---- INERTIA INTEGRATION ----

/**
 * Trigger an inertial maneuver event with cinematic slowdown.
 */
function handleInertiaEvent(type, opts = {}) {
  if (!gameState) return;

  const result = triggerManeuverEvent(type, gameState.physics, gameState.ship, opts);
  if (!result.triggered) return;

  // Enter cinematic time (slow to 1x) so player sees the crew sliding
  if (result.cinematicSlowdown && gameState.speed > 1) {
    enterCinematicTime(gameState);
    // Show cinematic indicator
    const speedBtns = document.querySelectorAll('.speed-btn');
    speedBtns.forEach(b => b.classList.add('cinematic-dim'));
    showToast('INERTIAL EVENT', 'danger');
  }
}

/**
 * Process impact events from the inertia frame update.
 */
function processImpactEvents(impacts) {
  if (!impacts || impacts.length === 0) return;

  for (const impact of impacts) {
    // Log and toast
    const severityClass = impact.severity === 'fatal' ? 'danger' :
                          impact.severity === 'lethal' || impact.severity === 'crushing' ? 'danger' :
                          impact.severity === 'bone-breaking' ? 'warn' : 'warn';

    addLogEntry(impact.message, severityClass);
    showToast(impact.message, severityClass);
  }
}

// ---- SECURE PHASE BLOCKING UI ----

let _secureBlockingInterval = null;

function showSecureBlockingPrompt() {
  let el = document.getElementById('secure-blocking-prompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'secure-blocking-prompt';
    el.className = 'secure-blocking-prompt';
    document.getElementById('screen-game')?.appendChild(el);
  }
  el.style.display = 'flex';
  updateSecureBlockingPrompt();

  // Poll crew status to auto-advance when all seated
  if (_secureBlockingInterval) clearInterval(_secureBlockingInterval);
  _secureBlockingInterval = setInterval(() => {
    if (!gameState || !isSecureBlocking()) {
      hideSecureBlockingPrompt();
      return;
    }
    updateSecureBlockingPrompt();

    // Check if all crew are seated
    const aliveCrew = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10);
    const allSeated = aliveCrew.every(c => isSeatedInCouch(c.id));
    if (allSeated) {
      markSecureComplete();
      hideSecureBlockingPrompt();
      addLogEntry('All hands secured — burn sequence proceeding', 'nav');
    }
  }, 500);
}

function updateSecureBlockingPrompt() {
  const el = document.getElementById('secure-blocking-prompt');
  if (!el || !gameState) return;

  const aliveCrew = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10);
  const secured = aliveCrew.filter(c => isSeatedInCouch(c.id));
  const unsecuredCount = aliveCrew.length - secured.length;

  const crewDots = aliveCrew.map(c => {
    const seated = isSeatedInCouch(c.id);
    const isPilot = c.role === 'Pilot';
    return `<span class="mp-dot ${seated ? 'mp-dot-ok' : 'mp-dot-wait'} ${isPilot ? 'mp-dot-pilot' : ''}" title="${c.name} — ${seated ? 'secured' : 'moving'}">${isPilot ? 'P' : '·'}</span>`;
  }).join('');

  el.innerHTML = `
    <div class="mp-header">BURN SEQUENCE HOLDING</div>
    <div class="mp-crew-row">${crewDots}</div>
    <span class="mp-status mp-caution">${unsecuredCount} CREW UNSECURED</span>
    <button class="override-btn" id="secure-override-btn">OVERRIDE — EXECUTE NOW</button>
  `;

  const btn = document.getElementById('secure-override-btn');
  if (btn) {
    btn.onclick = () => {
      overrideSecure();
      hideSecureBlockingPrompt();
      addLogEntry('OVERRIDE: burn executing with unsecured crew!', 'danger');
      showToast('OVERRIDE — UNSECURED CREW!', 'danger');
    };
  }
}

function hideSecureBlockingPrompt() {
  const el = document.getElementById('secure-blocking-prompt');
  if (el) el.style.display = 'none';
  if (_secureBlockingInterval) {
    clearInterval(_secureBlockingInterval);
    _secureBlockingInterval = null;
  }
  // Remove cinematic dim if present
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('cinematic-dim'));
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
    const speed = phys ? phys.speed : 0;
    const heading = phys ? phys.heading : 0;
    const velocity = heading === 0 ? speed : -speed; // ship-relative
    const absVel = speed;

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
  const spd = phys.speed || 0;
  return phys.heading === 0 ? spd : -spd;
}

function speedParticleRate() {
  if (!gameState) return 400;
  const absVel = gameState.physics.speed || 0;
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
      // Migrate old saves: add life support if missing
      if (!gameState.lsEquipment) {
        const { initLifeSupport } = await import('./life-support.js');
        initLifeSupport(gameState);
      }
      // Migrate old saves: add reactor if missing
      if (!gameState.reactor) {
        initReactor(gameState);
      }
      // Migrate: add ship position if missing
      if (!gameState.shipPosition) {
        gameState.shipPosition = { x: 2.77, y: 0.0 };
      }
      // Migrate: convert scalar velocity to vector
      if (typeof gameState.physics.velocity === 'number') {
        const v = gameState.physics.velocity;
        const heading = gameState.navigation.routeHeading || 0;
        gameState.physics.velocity = {
          vx: heading != null ? v * Math.cos(heading) : v,
          vy: heading != null ? v * Math.sin(heading) : 0,
        };
        gameState.physics.speed = Math.abs(v);
      }
      // Migrate: add inertia tracking fields
      if (gameState.physics._prevThrustG === undefined) {
        gameState.physics._prevThrustG = 0;
        gameState.physics._thrustDelta = 0;
      }
      // Migrate: add entities and initialize orbits for gravity
      if (!gameState.entities) {
        gameState.entities = createDefaultEntities();
      }
      // Ensure all entities have velocity vectors (pre-gravity saves had snapped positions)
      const migDays = gameState.stats?.daysElapsed || 0;
      for (const ent of gameState.entities) {
        if (!ent.velocity || (ent.velocity.vx === 0 && ent.velocity.vy === 0 && ent.orbitBody)) {
          initializeEntityOrbit(ent, migDays);
        }
      }
      // Migrate: add comms
      if (!gameState.comms) {
        initComms(gameState);
      }
      // Migrate: add scanner
      if (!gameState.scanner) {
        initScanner(gameState);
      }
      // Restore missions
      if (gameState._missions) {
        deserializeMissions(gameState._missions);
        delete gameState._missions;
      } else {
        initMissions(gameState);
      }
      // Init inertia system
      initInertia();
      // Migrate: add route navigation fields if missing
      if (!gameState.navigation.routeActive) {
        gameState.navigation.routeActive = false;
        gameState.navigation.routeHeading = null;
        gameState.navigation.routeDestination = null;
      }
      // Restore active route (reset first to clear stale state from previous game)
      resetRoute();
      if (gameState._activeRoute) {
        deserializeRoute(gameState._activeRoute, gameState);
        delete gameState._activeRoute;
      }
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
    if (!isReactorOnline(gameState)) {
      showToast('Cannot thrust \u2014 reactor offline', 'danger');
      return;
    }
    const phys = gameState.physics;
    const slider = document.getElementById('thrust-slider');

    if (phys.thrustActive) {
      // Turn off — surprise thrust cut
      const prevG = phys.thrustLevel * phys.maxThrust;
      setThrustLevel(phys, 0);
      slider.value = 0;
      updateThrustSliderUI(0);
      addLogEntry('Torch engine shutdown — entering micro-G', 'thrust');
      // Inertia: surprise burn stop
      if (prevG > 0.5) {
        handleInertiaEvent(ManeuverType.BURN_STOP, { deltaG: prevG, surprise: true });
      }
    } else {
      // Turn on to slider value or default 20% (2G) — surprise burn start
      const level = parseFloat(slider.value) / 100 || 0.2;
      setThrustLevel(phys, level);
      slider.value = level * 100;
      updateThrustSliderUI(level);
      const gVal = (level * phys.maxThrust).toFixed(1);
      addLogEntry(`Torch engine firing at ${gVal}G`, 'thrust');
      // Inertia: surprise burn start
      const newG = level * phys.maxThrust;
      if (newG > 0.5) {
        handleInertiaEvent(ManeuverType.THRUST_CHANGE, { deltaG: newG, surprise: true });
      }
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

  // Log on slider release for significant changes + inertia trigger
  let lastLoggedG = 0;
  slider.addEventListener('change', () => {
    if (!gameState) return;
    const gVal = gameState.physics.thrustLevel * gameState.physics.maxThrust;
    const deltaG = Math.abs(gVal - lastLoggedG);
    if (deltaG > 0.3) {
      if (gVal === 0) {
        addLogEntry('Torch engine shutdown — entering micro-G', 'thrust');
      } else {
        addLogEntry(`Thrust adjusted to ${gVal.toFixed(1)}G`, 'thrust');
      }
      // Inertia: surprise thrust change
      if (deltaG > 0.5) {
        handleInertiaEvent(ManeuverType.THRUST_CHANGE, { deltaG, surprise: true });
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

    // Record pre-flip thrust for inertia trigger
    const prevThrustG = phys.thrustActive ? phys.thrustLevel * phys.maxThrust : 0;

    if (startFlip(phys)) {
      addLogEntry('Flip maneuver initiated', 'nav');

      // Update thrust UI since flip cuts thrust
      const sliderEl = document.getElementById('thrust-slider');
      sliderEl.value = 0;
      updateThrustSliderUI(0);

      // Show RCS thrusters on main view
      showRcsThrusters('flip');

      const flipBtn = document.getElementById('flip-toggle');
      flipBtn.classList.add('flipping');

      // Trigger inertia for the flip (crew get thrown in random direction)
      handleInertiaEvent(ManeuverType.FLIP, { deltaG: prevThrustG });

      // Animate flip in real-time
      let lastTime = performance.now();
      function animateFlip(now) {
        const deltaSec = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;
        const complete = updateFlip(phys, deltaSec);

        // Update inertia simulation during flip
        if (isInertiaActive()) {
          const impacts = updateInertiaFrame(gameState.ship, gameState.physics, deltaSec);
          processImpactEvents(impacts);
        }

        // Update RCS on tac view during flip (close zoom only)
        const tacScreen = document.getElementById('tac-screen');
        if (tacScreen && tacZoomLevel === 0) {
          renderTacView(gameState.ship, tacScreen, phys.thrustActive, tacZoomLevel, phys.flipping, getRelativeVelocity(phys), phys.orienting, getTacNearbyEntities(gameState, tacZoomLevel));
        }

        if (complete) {
          flipBtn.classList.remove('flipping');
          const relV = getRelativeVelocity(phys);
          const headingLabel = relV >= 0 ? 'PRO' : 'RETRO';
          document.getElementById('flip-heading').textContent = headingLabel;
          addLogEntry(`Flip complete — now ${relV >= 0 ? 'prograde' : 'retrograde'}`, 'nav');
          showRcsThrusters(false);
          // End cinematic time if active
          if (isInCinematicTime()) exitCinematicTime(gameState);
          // Re-render tac view
          if (tacScreen) {
            renderTacView(gameState.ship, tacScreen, phys.thrustActive, tacZoomLevel, false, phys.speed, false, getTacNearbyEntities(gameState, tacZoomLevel));
          }
          flipAnimFrame = null;
          return;
        }
        flipAnimFrame = requestAnimationFrame(animateFlip);
      }
      flipAnimFrame = requestAnimationFrame(animateFlip);
    }
  });

  // Combat stations toggle
  document.getElementById('combat-toggle').addEventListener('click', () => {
    if (!gameState) return;
    const btn = document.getElementById('combat-toggle');
    const statusEl = document.getElementById('combat-status');

    if (gameState.combatStations) {
      // Deactivate
      gameState.combatStations = false;
      btn.classList.remove('active');
      statusEl.textContent = 'OFF';
      // Release all crew from couches
      gameState.ship.crew.forEach(member => {
        if (!member.dead) releaseSecureBurn(member.id);
      });
      // Remove red lighting
      document.querySelector('.ship-combat-lighting')?.remove();
      showToast('Combat stations secured', 'ok');
      addLogEntry('Combat stations secured — all hands resume stations', 'system');
    } else {
      // Activate
      gameState.combatStations = true;
      btn.classList.add('active');
      statusEl.textContent = 'ON';
      // All crew to crash couches — cancel any current mission first
      gameState.ship.crew.forEach(member => {
        if (!member.dead && member.consciousness > 10) {
          const currentMission = getCrewMission(member.id);
          if (currentMission && currentMission !== 'secure-burn' && currentMission !== 'healing') {
            cancelMission(member.id, gameState.ship);
          }
          const result = assignSecureBurnMission(gameState.ship, member);
          console.log(`[COMBAT] ${member.name}: assignSecureBurn=${result}, mission=${getCrewMission(member.id)}, deck=${member.deck}`);
        }
      });
      // Red combat lighting overlay on ship view
      const shipContainer = document.getElementById('ship-container');
      if (shipContainer && !shipContainer.querySelector('.ship-combat-lighting')) {
        const overlay = document.createElement('div');
        overlay.className = 'ship-combat-lighting';
        shipContainer.appendChild(overlay);
      }
      showToast('COMBAT STATIONS', 'danger');
      addLogEntry('COMBAT STATIONS — all hands to crash couches, juice standing by', 'danger');
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
        renderTacView(gameState.ship, tacScreen, gameState.physics.thrustActive, tacZoomLevel, false, getRelativeVelocity(gameState.physics), false, getTacNearbyEntities(gameState, tacZoomLevel));
      }
    });
  });

  // Tac screen click → open modal
  const tacScreenEl = document.getElementById('tac-screen');
  if (tacScreenEl) {
    tacScreenEl.style.cursor = 'pointer';
    tacScreenEl.addEventListener('click', () => openTacModal());
  }

  // Tac modal controls
  initTacModal();
  initRoutePanel();
}

// ---- TACTICAL MAP MODAL ----

let tacModalOpen = false;
let tacModalZoom = 0;
let tacModalTab = 'tactical'; // 'tactical' or 'solar'
let solarMapInitialized = false;
let solarRenderCounter = 0;
// Approach slider state for fine-tune distance control in scanner
let _approachSlider = { entityId: null, sliderValue: 100 };

function initTacModal() {
  const modal = document.getElementById('tac-modal');
  if (!modal) return;

  const rangeLabels = ['1 km', '5 km', '25 km'];

  // Close button
  document.getElementById('tac-modal-close').addEventListener('click', closeTacModal);

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeTacModal();
  });

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tacModalOpen) closeTacModal();
  });

  // Zoom controls inside modal
  document.querySelectorAll('.tac-zoom-btn-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      tacModalZoom = parseInt(btn.dataset.tacZoomModal);
      document.querySelectorAll('.tac-zoom-btn-modal').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tac-range-modal').textContent = rangeLabels[tacModalZoom];
      renderTacModal();
    });
  });

  // Tab switching (TACTICAL / SOLAR / SCANNER)
  document.querySelectorAll('.tac-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const newTab = tab.dataset.tacTab;
      if (newTab === tacModalTab) return;
      hideInterceptTypePanel();
      tacModalTab = newTab;
      document.querySelectorAll('.tac-tab').forEach(t => t.classList.toggle('active', t.dataset.tacTab === newTab));
      switchTacTab(newTab);
    });
  });

  // Solar zoom presets
  document.querySelectorAll('.solar-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.solarPreset);
      const preset = SOLAR_ZOOM_PRESETS[idx];
      if (!preset) return;

      // For Jupiter/Saturn, dynamically compute planet position
      if (preset.name === 'Jupiter') {
        zoomToPlanet('Jupiter', gameState, 0.05);
      } else if (preset.name === 'Saturn') {
        zoomToPlanet('Saturn', gameState, 0.1);
      } else {
        zoomToPreset(preset);
      }

      document.querySelectorAll('.solar-zoom-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSolarTab(true);
    });
  });

  // Scanner range buttons
  document.querySelectorAll('.scanner-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const level = parseInt(btn.dataset.scannerRange);
      if (gameState) setRange(gameState, level);
      document.querySelectorAll('.scanner-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderScannerTab();
    });
  });

  // Scanner track button
  const trackBtnEl = document.getElementById('scanner-track-btn');
  if (trackBtnEl) {
    trackBtnEl.addEventListener('mousedown', (e) => {
      e.stopPropagation(); // prevent scanner mousedown handler from firing
    });
    trackBtnEl.addEventListener('click', () => {
      if (!gameState?.scanner?.selectedContact) return;
      const result = startTracking(gameState, gameState.scanner.selectedContact);
      if (result.success) {
        showToast(result.message, result.active ? 'warn' : 'ok');
        addLogEntry(result.message, result.active ? 'warn' : 'system');
      }
      renderScannerTab();
    });
  }

  // Scanner intercept button — opens type selector instead of immediate intercept
  const interceptBtnEl = document.getElementById('scanner-intercept-btn');
  if (interceptBtnEl) {
    interceptBtnEl.addEventListener('mousedown', (e) => e.stopPropagation());
    interceptBtnEl.addEventListener('click', () => {
      if (!gameState?.scanner?.selectedContact) return;
      const entityId = gameState.scanner.selectedContact;
      const currentIntercept = getInterceptState();

      if (currentIntercept && currentIntercept.targetEntityId === entityId) {
        cancelIntercept();
        cancelRoute(gameState);
        hideInterceptTypePanel();
        showToast('Intercept cancelled', 'ok');
        addLogEntry('Intercept route cancelled', 'nav');
        renderScannerTab();
      } else {
        showInterceptTypePanel(entityId);
      }
    });
  }

  // Scanner contact clicks — use mousedown because innerHTML is replaced every frame,
  // which destroys the target element before click (mouseup) fires
  document.getElementById('scanner-screen-modal')?.addEventListener('mousedown', (e) => {
    let el = e.target;
    while (el && el !== e.currentTarget) {
      const contactId = el.getAttribute?.('data-contact');
      if (contactId) {
        if (gameState?.scanner?.selectedContact !== contactId) {
          hideInterceptTypePanel(); // new contact selected — close ITP if open
        }
        selectContact(gameState, contactId);
        renderScannerTab();
        return;
      }
      el = el.parentElement || el.parentNode;
    }
    // Clicked empty space — deselect if not locked
    if (gameState?.scanner && gameState.scanner.selectedContact !== gameState.scanner.trackedContact) {
      hideInterceptTypePanel();
      deselectContact(gameState);
      renderScannerTab();
    }
  });
}

function switchTacTab(tab) {
  const tacScreen = document.getElementById('tac-screen-modal');
  const solarScreen = document.getElementById('solar-screen-modal');
  const scannerWrapper = document.getElementById('scanner-screen-wrapper');
  const tacZoomControls = document.getElementById('tac-zoom-controls-modal');
  const solarZoomControls = document.getElementById('solar-zoom-controls');
  const scannerRangeControls = document.getElementById('scanner-range-controls');
  const rangeEl = document.getElementById('tac-range-modal');
  const routePlotBtn = document.getElementById('route-plot-btn');
  const routeZoomBtn = document.getElementById('route-zoom-btn');
  const scannerInfo = document.getElementById('scanner-contact-info');
  const scannerTrackBtn = document.getElementById('scanner-track-btn');
  const scannerInterceptBtn = document.getElementById('scanner-intercept-btn');

  // Hide all screens and controls
  tacScreen.style.display = 'none';
  solarScreen.style.display = 'none';
  if (scannerWrapper) scannerWrapper.style.display = 'none';
  tacZoomControls.style.display = 'none';
  solarZoomControls.style.display = 'none';
  scannerRangeControls.style.display = 'none';
  rangeEl.style.display = 'none';
  if (routePlotBtn) routePlotBtn.style.display = 'none';
  if (routeZoomBtn) routeZoomBtn.style.display = 'none';
  if (scannerInfo) scannerInfo.style.display = 'none';
  if (scannerTrackBtn) scannerTrackBtn.style.display = 'none';
  if (scannerInterceptBtn) scannerInterceptBtn.style.display = 'none';

  if (tab === 'tactical') {
    tacScreen.style.display = '';
    tacZoomControls.style.display = '';
    rangeEl.style.display = '';
    renderTacModal();
  } else if (tab === 'solar') {
    solarScreen.style.display = '';
    solarZoomControls.style.display = '';

    // Initialize solar map interaction once
    if (!solarMapInitialized) {
      initSolarMapInteraction(solarScreen);
      let _solarRafPending = false;
      const scheduleRender = () => {
        if (_solarRafPending) return;
        _solarRafPending = true;
        requestAnimationFrame(() => {
          _solarRafPending = false;
          renderSolarTab(true);
        });
      };
      solarScreen.addEventListener('wheel', scheduleRender);
      let _lastHover = null;
      solarScreen.addEventListener('mousemove', () => {
        const ms = getMapState();
        if (ms.dragging) {
          scheduleRender();
        } else if (ms.hoveredBody !== _lastHover) {
          _lastHover = ms.hoveredBody;
          scheduleRender();
        }
      });
      solarMapInitialized = true;
    }
    renderSolarTab(true);
  } else if (tab === 'scanner') {
    if (scannerWrapper) scannerWrapper.style.display = '';
    scannerRangeControls.style.display = '';
    renderScannerTab();
  }
}

function renderSolarTab(forceRender) {
  if (!tacModalOpen || tacModalTab !== 'solar' || !gameState) return;
  const solarScreen = document.getElementById('solar-screen-modal');
  if (!solarScreen) return;

  // Build route info for solar map rendering
  let routeInfo = null;
  const activeRt = getActiveRoute();
  const selBody = getSelectedBody();
  if (activeRt && activeRt.active) {
    const days = (gameState.stats?.daysElapsed || 0) + (gameState.time?.hour || 0) / 24;
    const destBody = findBody(activeRt.destinationName, gameState);
    if (destBody) {
      const dp = getBodyWorldPos(destBody, days);
      const progress = getRouteProgress();
      routeInfo = {
        destX: dp.x, destY: dp.y, active: true,
        flipFraction: progress?.flipFraction ?? 0.5,
        flipDone: progress?.flipDone ?? false,
        startPosition: progress?.startPosition || gameState.shipPosition,
      };
    }
  } else if (selBody && !routePanelOpen) {
    // Show dashed line to selected body
    const days = (gameState.stats?.daysElapsed || 0) + (gameState.time?.hour || 0) / 24;
    const body = findBody(selBody.name, gameState);
    if (body) {
      const dp = getBodyWorldPos(body, days);
      routeInfo = { destX: dp.x, destY: dp.y, active: false };
    }
  }

  // Throttle SVG re-render to every 60 ticks (~1s at 60fps) unless forced
  // Skip render during blackout
  if (isBlackout()) {
    if (solarScreen) solarScreen.innerHTML = '';
  } else {
    solarRenderCounter++;
    if (forceRender || solarRenderCounter % 60 === 0) {
      renderSolarSystem(solarScreen, gameState, routeInfo);
    }
  }

  // Update info bar every tick (cheap DOM updates)
  const ms = getMapState();
  const velEl = _hud.tacModalVel;
  const headEl = _hud.tacModalHead;
  const thrEl = _hud.tacModalThr;
  const plotBtn = _solarCache.routePlotBtn;
  const phys = gameState.physics;

  // Active route status bar
  const statusBar = _solarCache.routeStatusBar;
  const progress = getRouteProgress();
  if (progress) {
    if (statusBar) statusBar.style.display = 'flex';
    const destEl = _solarCache.routeStatusDest;
    const phaseEl = _solarCache.routeStatusPhase;
    const fillEl = _solarCache.routeStatusFill;
    const etaEl = _solarCache.routeStatusEta;
    if (destEl) destEl.textContent = `→ ${progress.destinationName}`;
    if (phaseEl) phaseEl.textContent = progress.currentPhase?.type?.toUpperCase() || '';
    if (fillEl) fillEl.style.width = `${(progress.fraction * 100).toFixed(1)}%`;
    if (etaEl) etaEl.textContent = `ETA ${formatDuration(progress.etaMin)}`;
    if (routeDetailOpen) updateRouteDetail();
  } else {
    if (statusBar) statusBar.style.display = 'none';
    routeDetailOpen = false;
  }

  const tacVelDisplay = getDisplayVelocity();
  if (velEl) {
    const refLabel = tacVelDisplay.ref ? ` [${tacVelDisplay.ref}]` : '';
    velEl.textContent = `VEL ${tacVelDisplay.text}${refLabel}`;
  }

  // Show body selection info or default zoom/pos display
  const zoomBtn = _solarCache.routeZoomBtn;
  if (selBody) {
    const body = findBody(selBody.name, gameState);
    if (body && headEl) {
      const days = (gameState.stats?.daysElapsed || 0) + (gameState.time?.hour || 0) / 24;
      const dp = getBodyWorldPos(body, days);
      const sp = gameState.shipPosition;
      const d = Math.sqrt((dp.x - sp.x) ** 2 + (dp.y - sp.y) ** 2);
      headEl.textContent = `${selBody.name.toUpperCase()} ${d.toFixed(2)} AU`;
    }
    if (zoomBtn) zoomBtn.style.display = '';
    if (plotBtn) plotBtn.style.display = getActiveRoute() ? 'none' : '';
    if (thrEl) thrEl.textContent = '';
    const sepThr = _solarCache.tacSepThrust;
    if (sepThr) sepThr.style.display = 'none';
  } else {
    if (headEl) headEl.textContent = `ZOOM ${ms.zoom.toFixed(ms.zoom < 1 ? 3 : 1)} AU`;
    if (thrEl) {
      const sp = gameState.shipPosition;
      if (sp) {
        const dist = Math.sqrt(sp.x * sp.x + sp.y * sp.y);
        thrEl.textContent = `POS ${dist.toFixed(2)} AU`;
      }
    }
    const sepThr = _solarCache.tacSepThrust;
    if (sepThr) sepThr.style.display = '';
    if (zoomBtn) zoomBtn.style.display = 'none';
    if (plotBtn) plotBtn.style.display = 'none';
  }
}

// ---- SCANNER TAB ----

function renderScannerTab() {
  if (!tacModalOpen || tacModalTab !== 'scanner' || !gameState) return;
  const scannerScreen = document.getElementById('scanner-screen-modal');
  if (!scannerScreen) return;

  if (isBlackout()) {
    scannerScreen.innerHTML = '';
    return;
  }

  renderScanner(scannerScreen, gameState);
  updateScannerInfoBar();
}

function updateScannerInfoBar() {
  const contact = getSelectedContact(gameState);
  const scannerInfo = document.getElementById('scanner-contact-info');
  const trackBtn = document.getElementById('scanner-track-btn');
  const interceptBtn = document.getElementById('scanner-intercept-btn');
  const detailPanel = document.getElementById('scanner-detail-panel');

  if (contact && tacModalTab === 'scanner') {
    // Info bar (compact)
    if (scannerInfo) {
      scannerInfo.style.display = '';
      const nameEl = document.getElementById('scanner-contact-name');
      const rangeEl = document.getElementById('scanner-contact-range');
      const bearingEl = document.getElementById('scanner-contact-bearing');
      if (nameEl) nameEl.textContent = contact.name || contact.driveSignature || 'UNKNOWN';
      if (rangeEl) rangeEl.textContent = formatScannerRange(contact.range);
      if (bearingEl) {
        const relBearing = ((contact.bearing - getShipFacing(gameState)) * 180 / Math.PI + 360) % 360;
        bearingEl.textContent = `${relBearing.toFixed(0)}°`;
      }
    }

    // Lock/Unlock button
    if (trackBtn) {
      trackBtn.style.display = '';
      const isTracked = gameState.scanner?.trackedContact === contact.entityId;
      trackBtn.textContent = isTracked ? 'UNLOCK' : 'LOCK';
      trackBtn.classList.toggle('tracking', isTracked);
    }

    // Intercept button
    if (interceptBtn) {
      interceptBtn.style.display = '';
      const currentIntercept = getInterceptState();
      const isIntercepting = currentIntercept && currentIntercept.targetEntityId === contact.entityId;
      interceptBtn.textContent = isIntercepting ? 'CANCEL INTERCEPT' : 'INTERCEPT';
      interceptBtn.classList.toggle('intercepting', isIntercepting);
    }

    // Detail panel — hide when intercept type panel is open
    const itpPanel = document.getElementById('intercept-type-panel');
    const itpOpen = itpPanel && itpPanel.style.display !== 'none';

    if (detailPanel && !itpOpen) {
      detailPanel.style.display = '';
      const bearingDeg = (((contact.bearing - getShipFacing(gameState)) * 180 / Math.PI + 360) % 360).toFixed(0);
      const el = (id) => document.getElementById(id);
      const header = el('scanner-detail-header');
      if (header) {
        if (contact.sosActive) {
          header.innerHTML = `<span class="scanner-sos-tag">&#x26A0; SOS</span> ${escapeHtml(contact.name || contact.driveSignature || 'CONTACT')}`;
        } else {
          header.textContent = contact.name || contact.driveSignature || 'CONTACT';
        }
      }
      const nameV = el('scanner-detail-name');
      if (nameV) {
        nameV.textContent = contact.name || '---';
        nameV.className = 'scanner-detail-val' + (contact.name ? ' scanner-val-accent' : ' scanner-val-dim');
      }
      const sigV = el('scanner-detail-sig');
      if (sigV) sigV.textContent = contact.driveSignature || '---';
      const facV = el('scanner-detail-faction');
      if (facV) {
        facV.textContent = contact.faction || '---';
        facV.className = 'scanner-detail-val' + (contact.faction ? '' : ' scanner-val-dim');
      }
      const clsV = el('scanner-detail-class');
      if (clsV) clsV.textContent = contact.shipClass || '---';
      const distV = el('scanner-detail-dist');
      if (distV) distV.textContent = formatScannerRange(contact.range);
      const relV = el('scanner-detail-relvel');
      if (relV) {
        const entity = (gameState.entities || []).find(e => e.id === contact.entityId);
        if (entity && gameState.physics?.velocity) {
          const dvx = gameState.physics.velocity.vx - entity.velocity.vx;
          const dvy = gameState.physics.velocity.vy - entity.velocity.vy;
          relV.textContent = formatVelocity(Math.sqrt(dvx * dvx + dvy * dvy));
        } else {
          relV.textContent = contact.relativeVelocity != null ? formatVelocity(Math.abs(contact.relativeVelocity)) : '---';
        }
      }
      const bearV = el('scanner-detail-bearing');
      if (bearV) bearV.textContent = `${bearingDeg}°`;
      const accV = el('scanner-detail-accel');
      if (accV) {
        accV.textContent = contact.thrustState || '---';
        accV.className = 'scanner-detail-val' + (contact.thrustState && contact.thrustState !== 'COASTING' ? ' scanner-val-warn' : '');
      }
      const massV = el('scanner-detail-mass');
      if (massV) massV.textContent = contact.mass ? `${(contact.mass / 1000).toFixed(1)}kt` : '---';

      // Fine-tune approach slider — show when within LONG scanner range (~15M km)
      const sliderContainer = document.getElementById('approach-slider-container');
      if (sliderContainer) {
        const LONG_RANGE_AU = INTERCEPT_RANGE_AU[INTERCEPT_TYPE.SCANNER];
        if (contact.range < LONG_RANGE_AU) {
          sliderContainer.style.display = '';
          updateApproachSlider(contact);
        } else {
          sliderContainer.style.display = 'none';
          if (_approachSlider.entityId !== contact.entityId) {
            _approachSlider = { entityId: null, sliderValue: 100 };
          }
        }
      }
    }
  } else {
    if (scannerInfo) scannerInfo.style.display = 'none';
    if (trackBtn) trackBtn.style.display = 'none';
    if (interceptBtn) interceptBtn.style.display = 'none';
    if (detailPanel) detailPanel.style.display = 'none';
    // Close intercept type panel if contact deselected
    const itp = document.getElementById('intercept-type-panel');
    if (itp) itp.style.display = 'none';
  }
}

function formatScannerRange(au) {
  const km = au * 149_597_870.7;
  if (km < 1000) return `${Math.round(km)} km`;
  if (km < 1_000_000) return `${(km / 1000).toFixed(0)}k km`;
  return `${(km / 1_000_000).toFixed(1)}M km`;
}

function formatApproachDist(km) {
  if (km >= 1e6) return `${(km / 1e6).toFixed(1)}M km`;
  if (km >= 1000) return `${(km / 1000).toFixed(1)}k km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round(km * 1000)} m`;
}

function getApproachSliderMin(currentDistKm) {
  if (currentDistKm >= 1000) return Math.max(0.5, currentDistKm * 0.1);
  return 0.5; // 500m floor
}

// ---- INTERCEPT TYPE PANEL ----

function buildInterceptTypeCard(type, label, rangeLabel, desc, currentDistKm, accelG = 0) {
  const targetKm = INTERCEPT_RANGE_AU[type] * 149_597_870.7;
  const inRange = currentDistKm <= targetKm;
  return `
    <div class="itp-card${inRange ? ' itp-card-inrange' : ''}${accelG > 1.5 ? ' itp-card-combat' : ''}" data-type="${type}" data-accel-g="${accelG}">
      <div class="itp-card-top">
        <span class="itp-card-label">${label}</span>
        <span class="itp-card-range">${rangeLabel}</span>
      </div>
      <div class="itp-card-desc">${desc}</div>
      ${inRange ? '<div class="itp-card-inrange-tag">ALREADY IN RANGE</div>' : ''}
    </div>`;
}

function showInterceptTypePanel(entityId) {
  const panel = document.getElementById('intercept-type-panel');
  if (!panel) return;

  const entity = (gameState.entities || []).find(e => e.id === entityId);
  const entityName = entity?.name || 'CONTACT';
  const contact = (gameState.scanner?.contacts || []).find(c => c.entityId === entityId);
  const distKm = contact ? contact.range * 149_597_870.7 : Infinity;

  panel.innerHTML = `
    <div class="itp-header">
      <span class="itp-title">INTERCEPT — ${escapeHtml(entityName)}</span>
      <button class="itp-close" id="itp-close-btn">&times;</button>
    </div>
    <div class="itp-distance">RANGE ${formatScannerRange(contact?.range ?? 0)}</div>
    <div class="itp-cards">
      ${buildInterceptTypeCard(INTERCEPT_TYPE.SCANNER,  'SCANNER RANGE', '15M km',  'Enter sensor detection range', distKm)}
      ${buildInterceptTypeCard(INTERCEPT_TYPE.CLOSE,    'CLOSE APPROACH', '100k km', 'Full sensor lock · comms range', distKm)}
      ${buildInterceptTypeCard(INTERCEPT_TYPE.TACTICAL, 'TACTICAL', '< 5 km', 'Boarding · tow · combat · EVA', distKm)}
      ${gameState.combatStations ? `
        ${buildInterceptTypeCard(INTERCEPT_TYPE.TACTICAL, 'COMBAT 5G', '< 5 km', 'High-G tactical · juice required', distKm, 5)}
        ${buildInterceptTypeCard(INTERCEPT_TYPE.TACTICAL, 'ASSAULT 7G', '< 5 km', 'Maximum burn · extreme G-force', distKm, 7)}
      ` : ''}
    </div>
    <div class="itp-actions">
      <button class="btn btn-secondary" id="itp-cancel-btn">CANCEL</button>
      <button class="btn btn-primary" id="itp-confirm-btn" disabled>CONFIRM</button>
    </div>`;

  panel.querySelector('#itp-close-btn').addEventListener('click', hideInterceptTypePanel);
  panel.querySelector('#itp-cancel-btn').addEventListener('click', hideInterceptTypePanel);

  let selectedType = null;
  let selectedAccelG = 0;
  panel.querySelectorAll('.itp-card:not(.itp-card-inrange)').forEach(card => {
    card.addEventListener('click', () => {
      selectedType = card.dataset.type;
      selectedAccelG = parseFloat(card.dataset.accelG) || 0;
      panel.querySelectorAll('.itp-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      panel.querySelector('#itp-confirm-btn').disabled = false;
    });
  });

  panel.querySelector('#itp-confirm-btn').addEventListener('click', () => {
    if (!selectedType) return;
    const targetRangeAU = INTERCEPT_RANGE_AU[selectedType];
    const opts = { targetRangeAU };
    if (selectedAccelG > 0) opts.accelG = selectedAccelG;
    const route = computeInterceptRoute(gameState, entityId, opts);
    if (!route) {
      showToast('Cannot compute intercept — already in range', 'warn');
      hideInterceptTypePanel();
      return;
    }
    const mission = getMissionForEntity(entityId);
    startIntercept(gameState, entityId, mission?.id, selectedType);
    activateRoute(gameState, route);
    hideInterceptTypePanel();
    renderScannerTab();
    showToast(`INTERCEPT: ${entityName} — ${selectedType.toUpperCase()}`, 'warn');
    addLogEntry(`Plotting ${selectedType} intercept for ${entityName}`, 'nav');
  });

  // Hide detail panel, show ITP
  const detailPanel = document.getElementById('scanner-detail-panel');
  if (detailPanel) detailPanel.style.display = 'none';
  panel.style.display = '';
}

function hideInterceptTypePanel() {
  const panel = document.getElementById('intercept-type-panel');
  if (panel) panel.style.display = 'none';
  // Restore detail panel if contact still selected
  const detailPanel = document.getElementById('scanner-detail-panel');
  const contact = getSelectedContact(gameState);
  if (detailPanel && contact) detailPanel.style.display = '';
}

// ---- APPROACH SLIDER ----

function updateApproachSlider(contact) {
  const container = document.getElementById('approach-slider-container');
  if (!container) return;

  const currentDistKm = contact.range * 149_597_870.7;
  const minKm = getApproachSliderMin(currentDistKm);

  // Rebuild DOM when entity changes
  if (_approachSlider.entityId !== contact.entityId) {
    _approachSlider.entityId = contact.entityId;
    _approachSlider.sliderValue = 100;
    buildApproachSliderDOM(container, contact);
  }

  // Update live labels every frame (range bounds shift as ship moves)
  const logMin = Math.log10(Math.max(minKm, 0.001));
  const logMax = Math.log10(Math.max(currentDistKm, minKm * 1.01));
  const frac = _approachSlider.sliderValue / 100;
  const targetKm = Math.pow(10, logMin + frac * (logMax - logMin));

  const currentEl = document.getElementById('approach-current-dist');
  const minEl = document.getElementById('approach-slider-min');
  const maxEl = document.getElementById('approach-slider-max');
  const targetEl = document.getElementById('approach-target-val');
  const slider = document.getElementById('approach-range-input');

  if (currentEl) currentEl.textContent = formatApproachDist(currentDistKm);
  if (minEl) minEl.textContent = formatApproachDist(minKm);
  if (maxEl) maxEl.textContent = formatApproachDist(currentDistKm);
  if (targetEl) targetEl.textContent = formatApproachDist(targetKm);
  // Update CSS fill track
  if (slider) slider.style.setProperty('--fill-pct', `${_approachSlider.sliderValue}`);
}

function buildApproachSliderDOM(container, contact) {
  container.innerHTML = `
    <div class="approach-slider-header">
      <span class="approach-slider-label">APPROACH DISTANCE</span>
      <span class="approach-slider-current" id="approach-current-dist"></span>
    </div>
    <div class="approach-slider-row">
      <span class="approach-range-label" id="approach-slider-min"></span>
      <input type="range" class="approach-range-input" id="approach-range-input" min="0" max="100" value="100">
      <span class="approach-range-label right" id="approach-slider-max"></span>
    </div>
    <div class="approach-target-row">
      <span class="approach-target-label">TARGET</span>
      <span class="approach-target-val" id="approach-target-val"></span>
    </div>
    <button class="approach-burn-btn" id="approach-burn-btn">EXECUTE BURN</button>`;

  container.querySelector('#approach-range-input').addEventListener('input', (e) => {
    _approachSlider.sliderValue = parseInt(e.target.value);
    updateApproachSlider(getSelectedContact(gameState));
  });

  container.querySelector('#approach-burn-btn').addEventListener('click', () => {
    const currentContact = getSelectedContact(gameState);
    if (!currentContact) return;

    const currentDistKm = currentContact.range * 149_597_870.7;
    const minKm = getApproachSliderMin(currentDistKm);
    const logMin = Math.log10(Math.max(minKm, 0.001));
    const logMax = Math.log10(Math.max(currentDistKm, minKm * 1.01));
    const frac = _approachSlider.sliderValue / 100;
    const targetKm = Math.pow(10, logMin + frac * (logMax - logMin));
    const targetAU = targetKm / 149_597_870.7;

    // Ensure an intercept state exists for the target
    let currentIntercept = getInterceptState();
    if (!currentIntercept || currentIntercept.targetEntityId !== currentContact.entityId) {
      const mission = getMissionForEntity(currentContact.entityId);
      startIntercept(gameState, currentContact.entityId, mission?.id, INTERCEPT_TYPE.TACTICAL);
      currentIntercept = getInterceptState();
    }

    // Within 500km with low relV: use RCS fine approach (no burn-flip-burn, no overshoot)
    if (currentDistKm < 500 && currentIntercept && !currentIntercept.fineApproach) {
      startFineApproach(gameState);
      showRcsThrusters('orient');
      showToast(`RCS FINE APPROACH — ${currentContact.name || 'contact'}`, 'nav');
      addLogEntry(`RCS fine approach: closing on ${currentContact.name || 'contact'} at ${formatApproachDist(currentDistKm)}`, 'nav');
      renderScannerTab();
      return;
    }

    const route = computeFineTuneRoute(gameState, currentContact.entityId, targetAU);
    if (!route) {
      showToast('Already at target distance', 'ok');
      return;
    }

    activateRoute(gameState, route);
    renderScannerTab();
    showToast(`Approach burn — target ${formatApproachDist(targetKm)}`, 'nav');
    addLogEntry(`Fine approach to ${currentContact.name || 'contact'}: ${formatApproachDist(targetKm)}`, 'nav');
  });
}

// ---- ROUTE PLANNING UI ----

function handleBodySelect(body) {
  const plotBtn = _solarCache.routePlotBtn;
  const zoomBtn = _solarCache.routeZoomBtn;
  if (body) {
    if (zoomBtn) zoomBtn.style.display = '';
    if (plotBtn) plotBtn.style.display = getActiveRoute() ? 'none' : '';
  } else {
    if (zoomBtn) zoomBtn.style.display = 'none';
    if (plotBtn) plotBtn.style.display = 'none';
  }
  renderSolarTab(true);
}

function openRoutePanel() {
  const selBody = getSelectedBody();
  if (!selBody || !gameState) return;

  const body = findBody(selBody.name, gameState);
  if (!body) return;

  computedRoutes = calculateRoutes(gameState, body);
  selectedRouteIdx = -1;
  routePanelOpen = true;

  const panel = document.getElementById('route-panel');
  if (panel) panel.style.display = 'flex';

  document.getElementById('route-dest-name').textContent = selBody.name.toUpperCase();

  const days = (gameState.stats?.daysElapsed || 0) + (gameState.time?.hour || 0) / 24;
  const dp = getBodyWorldPos(body, days);
  const sp = gameState.shipPosition;
  const dist = Math.sqrt((dp.x - sp.x) ** 2 + (dp.y - sp.y) ** 2);
  document.getElementById('route-dest-dist').textContent = `${dist.toFixed(3)} AU · ${(dist * 149.6).toFixed(0)} Mkm`;

  renderRouteCards();
}

function closeRoutePanel() {
  routePanelOpen = false;
  computedRoutes = [];
  selectedRouteIdx = -1;
  const panel = document.getElementById('route-panel');
  if (panel) panel.style.display = 'none';
  document.getElementById('route-confirm-btn').disabled = true;
}

function renderRouteCards() {
  const container = document.getElementById('route-options');
  if (!container) return;

  container.innerHTML = computedRoutes.map((r, i) => {
    const totalMin = r.phases.reduce((s, p) => s + p.durationMin, 0);
    const phaseSegments = r.phases
      .filter(p => p.durationMin > 0)
      .map(p => {
        const pct = Math.max(2, (p.durationMin / totalMin) * 100);
        return `<div class="route-phase-seg ${p.type}" style="width:${pct}%" title="${p.description}"></div>`;
      }).join('');

    return `
      <div class="route-card ${!r.feasible ? 'infeasible' : ''} ${i === selectedRouteIdx ? 'selected' : ''}" data-route-idx="${i}">
        <div class="route-card-header">
          <span class="route-card-name">${escapeHtml(r.name)}</span>
          <span class="route-card-type">${escapeHtml(r.label)}</span>
        </div>
        <div class="route-card-stats">
          <span class="route-stat">TIME <span class="route-stat-val">${formatDuration(r.totalTimeMin)}</span></span>
          <span class="route-stat">FUEL <span class="route-stat-val">${r.fuelRequired.toFixed(0)} kg (${r.fuelPercent.toFixed(1)}%)</span></span>
          <span class="route-stat">ΔV <span class="route-stat-val">${formatDeltaV(r.deltaV)}</span></span>
          <span class="route-stat">MAX-G <span class="route-stat-val ${r.accelG > 1.5 ? 'route-juice-warn' : ''}">${r.accelG.toFixed(1)}G${r.accelG > 1.5 ? ' · JUICE' : ''}</span></span>
          <span class="route-stat">PEAK-V <span class="route-stat-val">${formatVelocity(r.peakVelocity)}</span></span>
          <span class="route-stat">DIST <span class="route-stat-val">${r.distanceAU.toFixed(3)} AU</span></span>
        </div>
        <div class="route-phase-bar">${phaseSegments}</div>
        <div class="route-phase-legend">
          ${r.phases.filter(p => p.durationMin > 0).map(p =>
            `<span class="route-phase-label"><span class="route-phase-dot ${p.type}" style="background:${phaseColor(p.type)}"></span>${p.type.toUpperCase()} ${formatDuration(p.durationMin)}</span>`
          ).join('')}
        </div>
        <div class="route-card-feasibility ${r.feasible ? 'route-feasible' : 'route-infeasible'}">
          ${r.feasible ? '● FEASIBLE' : '● INSUFFICIENT FUEL'}
        </div>
        ${r.accelG > 1.5 ? `<div class="route-juice-note">⚠ Juice required — 1 med supply/crew · hangover risk (${gameState.resources.medSupplies.current} in stock)</div>` : ''}
      </div>
    `;
  }).join('');

  // Bind click handlers
  container.querySelectorAll('.route-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.routeIdx);
      if (!computedRoutes[idx]?.feasible) return;
      selectedRouteIdx = idx;
      container.querySelectorAll('.route-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('route-confirm-btn').disabled = false;
    });
  });
}

function phaseColor(type) {
  const colors = { orient: '#5A8A9A', secure: '#8B8B4A', burn: '#D16A4B', coast: '#2A5A7A', flip: '#E8D56B', arrive: '#6BCB77' };
  return colors[type] || '#444';
}

function confirmRoute() {
  if (selectedRouteIdx < 0 || !computedRoutes[selectedRouteIdx]) return;

  const route = computedRoutes[selectedRouteIdx];
  activateRoute(gameState, route);

  // Reset velocity for fresh route (keep orbital velocity — route accounts for it)
  gameState.physics.speed = 0;
  gameState.physics.heading = 0;

  addLogEntry(`Course plotted for ${route.destinationName} — ${route.name} ${route.label}`, 'nav');
  addLogEntry(`ETA: ${formatDuration(route.totalTimeMin)} · ΔV: ${formatDeltaV(route.deltaV)} · Fuel: ${route.fuelRequired.toFixed(0)} kg`, 'nav');
  showToast(`Route confirmed — game paused. Unpause when ready.`, 'ok');

  // Pause so the player can close the map before the sequence starts
  if (gameLoop) { gameLoop.setSpeed(0); updateSpeedUI(0); }

  closeRoutePanel();
  setSelectedBody(null);
  renderSolarTab(true);
}

function abortRoute() {
  const rt = getActiveRoute();
  if (!rt) return;
  cancelRoute(gameState);
  _orientState = null;
  hideManeuverPrompt();
  routeDetailOpen = false;
  showRcsThrusters(false);
  addLogEntry('Navigation route ABORTED — engines cut', 'warn');
  showToast('Route aborted', 'warn');
  renderSolarTab(true);
}

let routeDetailOpen = false;

function initRoutePanel() {
  // Zoom to selected body
  document.getElementById('route-zoom-btn')?.addEventListener('click', () => {
    const sel = getSelectedBody();
    if (sel && gameState) {
      console.log(`[App] ZOOM button clicked for "${sel.name}"`);
      const t0 = performance.now();
      zoomToBody(sel.name, gameState);
      console.log(`[App] zoomToBody took ${(performance.now() - t0).toFixed(1)}ms, starting render...`);
      const t1 = performance.now();
      renderSolarTab(true);
      console.log(`[App] renderSolarTab took ${(performance.now() - t1).toFixed(1)}ms`);
    }
  });

  // Plot Route button
  document.getElementById('route-plot-btn')?.addEventListener('click', openRoutePanel);

  // Route panel close
  document.getElementById('route-panel-close')?.addEventListener('click', closeRoutePanel);
  document.getElementById('route-cancel-btn')?.addEventListener('click', closeRoutePanel);
  document.getElementById('route-confirm-btn')?.addEventListener('click', confirmRoute);

  // Abort route button
  document.getElementById('route-abort-btn')?.addEventListener('click', abortRoute);

  // Click status bar summary to toggle detail panel
  document.getElementById('route-status-summary')?.addEventListener('click', (e) => {
    // Don't toggle if clicking the abort button
    if (e.target.closest('.route-abort-btn')) return;
    routeDetailOpen = !routeDetailOpen;
    const panel = document.getElementById('route-detail-panel');
    if (panel) {
      panel.style.display = routeDetailOpen ? 'flex' : 'none';
      if (routeDetailOpen) updateRouteDetail();
    }
  });

  // Body selection callback
  setOnBodySelect(handleBodySelect);
}

function updateRouteDetail() {
  const panel = document.getElementById('route-detail-panel');
  if (!panel || !routeDetailOpen) return;

  const rt = getActiveRoute();
  const progress = getRouteProgress();
  if (!rt || !progress) { panel.style.display = 'none'; return; }

  const phys = gameState.physics;
  const res = gameState.resources;
  const fuelUsed = (rt.fuelRequired * progress.fraction).toFixed(0);
  const fuelRemaining = res.fuel.current.toFixed(0);
  const vel = getRelativeVelocity(phys);
  const elapsed = progress.elapsed;
  const remaining = progress.etaMin;

  // Phase color map
  const phaseColors = {
    orient: '#5A8A9A', secure: '#8B8B4A', burn: '#D16A4B',
    coast: '#2A5A7A', flip: '#E8D56B', arrive: '#6BCB77',
  };

  // Phase timeline
  const phasesHtml = rt.phases.filter(p => p.durationMin > 0 || p.type === 'arrive').map((p, i) => {
    const isCurrent = i === progress.phaseIndex;
    const isDone = i < progress.phaseIndex;
    const dotClass = isCurrent ? 'current' : isDone ? 'done' : '';
    const nameClass = isCurrent ? 'current' : isDone ? 'done' : '';
    const color = phaseColors[p.type] || '#444';
    const dur = p.durationMin > 0 ? formatDuration(p.durationMin) : '';
    const phaseProgress = isCurrent && p.durationMin > 0
      ? ` (${Math.round(progress.phaseElapsed / p.durationMin * 100)}%)`
      : '';
    return `<div class="rd-phase">
      <div class="rd-phase-dot ${dotClass}" style="background:${color};color:${color}"></div>
      <span class="rd-phase-name ${nameClass}">${p.type}</span>
      <span class="rd-phase-dur">${dur}${phaseProgress}</span>
      <span class="rd-phase-desc">${p.description || ''}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="rd-row">
      <div class="rd-stat">
        <span class="rd-stat-label">Route</span>
        <span class="rd-stat-val rd-accent">${rt.name || rt.type}</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">Max G</span>
        <span class="rd-stat-val">${(rt.accelG || rt.maxG || 0).toFixed(1)}G</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">Distance</span>
        <span class="rd-stat-val">${rt.distanceAU?.toFixed(3) || '—'} AU</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">ΔV</span>
        <span class="rd-stat-val">${formatDeltaV(rt.deltaV)}</span>
      </div>
    </div>
    <div class="rd-row">
      <div class="rd-stat">
        <span class="rd-stat-label">Velocity</span>
        <span class="rd-stat-val rd-accent">${formatVelocity(vel)}</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">Elapsed</span>
        <span class="rd-stat-val">${formatDuration(elapsed)}</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">Remaining</span>
        <span class="rd-stat-val">${formatDuration(remaining)}</span>
      </div>
      <div class="rd-stat">
        <span class="rd-stat-label">Fuel used</span>
        <span class="rd-stat-val ${res.fuel.current / res.fuel.max < 0.15 ? 'rd-warn' : ''}">${fuelUsed} / ${fuelRemaining} kg</span>
      </div>
    </div>
    <div class="rd-phases">${phasesHtml}</div>
  `;
}

function openTacModal() {
  if (isBlackout()) return;
  const modal = document.getElementById('tac-modal');
  if (!modal) return;
  tacModalOpen = true;
  tacModalZoom = tacZoomLevel; // sync with small tac
  modal.style.display = 'flex';

  // Sync zoom button state
  document.querySelectorAll('.tac-zoom-btn-modal').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.tacZoomModal) === tacModalZoom);
  });
  const rangeLabels = ['1 km', '5 km', '25 km'];
  document.getElementById('tac-range-modal').textContent = rangeLabels[tacModalZoom];

  // Sync tab state
  document.querySelectorAll('.tac-tab').forEach(t => t.classList.toggle('active', t.dataset.tacTab === tacModalTab));
  switchTacTab(tacModalTab);
}

function closeTacModal() {
  const modal = document.getElementById('tac-modal');
  if (modal) modal.style.display = 'none';
  tacModalOpen = false;
  tacModalTab = 'tactical';
}

// Deterministic hash from entity ID for consistent random variations
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Compute nearby entities for the tac screen (within zoom range)
function getTacNearbyEntities(state, zoomLevel) {
  if (!state?.entities || !state.shipPosition) return null;
  const rangeKm = [1, 5, 25][zoomLevel] || 25;
  const rangeAU = rangeKm / 149_597_870.7;
  const shipPos = state.shipPosition;
  const shipFacing = getShipFacing(state);
  const AU_M = 149_597_870_700;

  const result = [];
  for (const entity of state.entities) {
    const dist = entityDistanceAU(shipPos, entity.position);
    if (dist > rangeAU) continue;
    const distM = dist * AU_M;
    const absBearing = bearingTo(shipPos, entity.position);
    result.push({
      name: entity.name,
      distM,
      relBearing: absBearing - shipFacing,
      faction: entity.faction,
      sosActive: entity.sosActive,
      thrustActive: entity.thrustActive,
      mass: entity.mass || 50000,
      shipClass: entity.shipClass || '',
      entityType: entity.type,
      seed: entity.id ? hashCode(entity.id) : 0,
    });
  }
  return result.length > 0 ? result : null;
}

function renderTacModal() {
  if (!tacModalOpen || !gameState) return;
  const tacScreen = document.getElementById('tac-screen-modal');
  if (!tacScreen) return;
  const phys = gameState.physics;
  renderTacView(gameState.ship, tacScreen, phys.thrustActive, tacModalZoom, phys.flipping, getRelativeVelocity(phys), phys.orienting, getTacNearbyEntities(gameState, tacModalZoom));

  // Update info bar
  const tacVel = getDisplayVelocity();
  if (_hud.tacModalVel) {
    const ref = tacVel.ref ? ` [${tacVel.ref}]` : '';
    _hud.tacModalVel.textContent = `VEL ${tacVel.text}${ref}`;
  }
  if (_hud.tacModalHead) _hud.tacModalHead.textContent = isFineApproaching() ? 'FINE APPROACH' : phys.flipping ? 'FLIPPING' : (getRelativeVelocity(phys) >= 0 ? 'PROGRADE' : 'RETROGRADE');
  if (_hud.tacModalThr) _hud.tacModalThr.textContent = phys.thrustActive ? `BURN ${(phys.thrustLevel * phys.maxThrust).toFixed(1)}G` : 'COAST';
}

// ---- RCS THRUSTER VISUALS (main view) ----
// mode: false/null = hide, 'flip' = all fire rapidly, 'orient' = alternating diagonal pulses
function showRcsThrusters(mode) {
  const existing = document.getElementById('rcs-thrusters');
  if (!mode) {
    if (existing) existing.remove();
    return;
  }

  // Always recreate to switch between flip/orient animation patterns
  if (existing) existing.remove();

  const shipSvg = document.querySelector('#ship-container svg');
  if (!shipSvg) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const rcs = document.createElementNS(SVG_NS, 'g');
  rcs.setAttribute('id', 'rcs-thrusters');

  const hullEl = shipSvg.querySelector('path[stroke]');
  if (!hullEl) return;

  const bbox = hullEl.getBBox();
  const hx = bbox.x;
  const hy = bbox.y;
  const hw = bbox.width;
  const hh = bbox.height;

  // Add glow filter for plumes
  let defs = shipSvg.querySelector('defs');
  if (defs && !shipSvg.querySelector('#rcs-glow')) {
    defs.innerHTML += `
      <filter id="rcs-glow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    `;
  }

  // Position thrusters at ~20% and ~80% down the hull (fore and aft pairs)
  // Each side of the hull, firing outward perpendicular
  const foreY = hy + hh * 0.15;
  const aftY = hy + hh * 0.78;
  const nozzleOffset = 4;  // how far from hull edge

  // 4 thruster positions: fore-port, fore-starboard, aft-port, aft-starboard
  // dir: -1 = fires left (port), +1 = fires right (starboard)
  const positions = [
    { x: hx - nozzleOffset, y: foreY, dir: -1, label: 'FP' },   // 0: fore-port
    { x: hx + hw + nozzleOffset, y: foreY, dir: 1, label: 'FS' },  // 1: fore-starboard
    { x: hx - nozzleOffset, y: aftY, dir: -1, label: 'AP' },    // 2: aft-port
    { x: hx + hw + nozzleOffset, y: aftY, dir: 1, label: 'AS' },   // 3: aft-starboard
  ];

  // Diagonal pairs for rotation torque:
  // Pair A: fore-port(0) + aft-starboard(3) — clockwise
  // Pair B: fore-starboard(1) + aft-port(2) — counter-clockwise
  const pairA = [0, 3];

  const thrusterParts = [];
  positions.forEach((pos, i) => {
    const isPairA = pairA.includes(i);
    const d = pos.dir;

    // Nozzle housing (small dark block on hull)
    const nzW = 6;
    const nzH = 10;
    const nzX = d > 0 ? pos.x - 2 : pos.x - nzW + 2;
    thrusterParts.push(`
      <rect x="${nzX}" y="${pos.y - nzH / 2}" width="${nzW}" height="${nzH}"
        fill="#1A2A3A" stroke="#3D7A8A" stroke-width="0.5" opacity="0.8"/>
    `);

    // Plume: conical exhaust shooting outward
    // Triangle: narrow at nozzle, wide at tip
    const plumeLen = 20;
    const plumeNarrow = 4;
    const plumeWide = 12;
    const baseX = d > 0 ? pos.x + 1 : pos.x - 1;
    const tipX = baseX + d * plumeLen;

    // Main plume triangle
    const p1x = baseX; const p1y = pos.y - plumeNarrow / 2;
    const p2x = baseX; const p2y = pos.y + plumeNarrow / 2;
    const p3x = tipX;  const p3y = pos.y - plumeWide / 2;
    const p4x = tipX;  const p4y = pos.y + plumeWide / 2;

    // Inner bright core (narrower)
    const coreLen = plumeLen * 0.6;
    const coreTipX = baseX + d * coreLen;
    const coreWide = 6;
    const c1x = baseX; const c1y = pos.y - 2;
    const c2x = baseX; const c2y = pos.y + 2;
    const c3x = coreTipX; const c3y = pos.y - coreWide / 2;
    const c4x = coreTipX; const c4y = pos.y + coreWide / 2;

    if (mode === 'flip') {
      // All fire rapidly with flickering
      thrusterParts.push(`
        <polygon points="${p1x},${p1y} ${p2x},${p2y} ${p4x},${p4y} ${p3x},${p3y}"
          fill="#E2A355" opacity="0.7" filter="url(#rcs-glow)">
          <animate attributeName="opacity" values="0.5;0.8;0.6;0.9;0.5" dur="0.12s" repeatCount="indefinite"/>
        </polygon>
        <polygon points="${c1x},${c1y} ${c2x},${c2y} ${c4x},${c4y} ${c3x},${c3y}"
          fill="#FFDD77" opacity="0.9">
          <animate attributeName="opacity" values="0.7;1;0.8;1;0.7" dur="0.08s" repeatCount="indefinite"/>
        </polygon>
      `);
    } else {
      // Orient: alternating diagonal pair pulses
      const opVals = isPairA
        ? '0;0.7;0.8;0.6;0;0;0;0;0;0.7;0.8;0;0'
        : '0;0;0;0;0;0.6;0.7;0;0;0;0;0;0';
      const coreVals = isPairA
        ? '0;0.9;1;0.8;0;0;0;0;0;0.9;1;0;0'
        : '0;0;0;0;0;0.8;0.9;0;0;0;0;0;0';
      thrusterParts.push(`
        <polygon points="${p1x},${p1y} ${p2x},${p2y} ${p4x},${p4y} ${p3x},${p3y}"
          fill="#E2A355" opacity="0" filter="url(#rcs-glow)">
          <animate attributeName="opacity" values="${opVals}" dur="2.4s" repeatCount="indefinite"/>
        </polygon>
        <polygon points="${c1x},${c1y} ${c2x},${c2y} ${c4x},${c4y} ${c3x},${c3y}"
          fill="#FFDD77" opacity="0">
          <animate attributeName="opacity" values="${coreVals}" dur="2.4s" repeatCount="indefinite"/>
        </polygon>
      `);
    }
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
  selectedTile = null;

  // Deselect tile visuals
  document.querySelectorAll('.tile-interactive').forEach(el => el.classList.remove('tile-selected'));

  // Update visual selection
  document.querySelectorAll('.crew-symbol').forEach(el => {
    el.classList.remove('selected');
    if (parseInt(el.getAttribute('data-crew-id')) === member.id) {
      el.classList.add('selected');
    }
  });

  // Update info panel
  const crewInfo = document.getElementById('crew-info');
  const b = member.body;
  const h = member.heart;
  const overall = getOverallHealth(member);

  // Color helper for health values
  const hc = v => v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--warning)' : 'var(--danger)';
  const bc = v => v >= 70 ? 'ok' : v >= 40 ? 'warning' : 'danger';

  // Heartbeat pulse: scaled so 110bpm ≈ 0.83s, slower BPM = slower pulse
  const beatDuration = h.bpm > 0 ? Math.max(0.5, 91.7 / h.bpm) : 0;

  // Conditions display
  const condLabels = {
    'dead': 'DEAD',
    'critical': 'CRITICAL',
    'brain-damage': 'BRAIN DAMAGE',
    'crushed': 'CRUSHED',
    'cardiac-stress': 'CARDIAC STRESS',
    'injured': 'INJURED',
    'unconscious': 'UNCONSCIOUS',
    'fatigued': 'FATIGUED',
    'starving': 'STARVING',
    'dehydrated': 'DEHYDRATED',
    'hypoxic': 'HYPOXIC',
    'hypercapnia': 'HYPERCAPNIA',
    'decompression': 'DECOMPRESSION',
    'juice-hangover': 'JUICE HANGOVER',
  };

  // Build condition tags — add juice status dynamically
  const liveConds = [...member.conditions];
  if (member._juiceActive) liveConds.unshift('juiced');

  const condHtml = liveConds.length > 0
    ? liveConds.map(c => {
      let severity, label;
      if (c === 'juiced') {
        severity = 'juice';
        label = 'JUICED';
      } else if (c === 'juice-hangover') {
        severity = 'hangover';
        const hrs = Math.ceil((member.juiceHangover || 0) / 60);
        label = `HANGOVER ${hrs}h`;
      } else {
        severity = (c === 'dead' || c === 'crushed' || c === 'unconscious' || c === 'decompression') ? 'danger'
          : (c === 'critical') ? 'critical'
          : (c === 'brain-damage' || c === 'cardiac-stress' || c === 'injured' || c === 'hypoxic' || c === 'hypercapnia') ? 'warning' : 'dim';
        label = condLabels[c] || c.toUpperCase();
      }
      return `<span class="crew-condition crew-condition-${severity}">${label}</span>`;
    }).join('')
    : '<span class="crew-condition crew-condition-ok">NOMINAL</span>';

  // Skill bars
  const skillDefs = [
    { key: 'piloting', label: 'PIL' },
    { key: 'security', label: 'SEC' },
    { key: 'engineering', label: 'ENG' },
    { key: 'medical', label: 'MED' },
  ];
  const skillsHtml = skillDefs.map(s => {
    const val = member.skills[s.key];
    return `<div class="crew-skill">
      <span class="crew-skill-label">${s.label}</span>
      <div class="crew-skill-bar"><div class="crew-skill-fill" style="width: ${val}%"></div></div>
      <span class="crew-skill-val">${val}</span>
    </div>`;
  }).join('');

  crewInfo.innerHTML = `
    <div class="crew-detail-name">${escapeHtml(member.name)}</div>
    <div class="crew-detail-role">${member.role}</div>

    <div class="crew-section-label">CONDITION</div>
    <div class="crew-conditions">${condHtml}</div>

    <div class="crew-section-label">VITALS</div>
    <div class="crew-vitals-row">
      <div class="crew-heart-container">
        <svg class="crew-heartbeat" viewBox="0 0 48 20" width="48" height="20">
          <polyline class="crew-heartbeat-line${member.dead ? ' flatline' : ''}" style="${beatDuration > 0 ? `animation-duration: ${beatDuration}s` : 'animation: none'}"
            points="${member.dead ? '0,10 48,10' : '0,10 8,10 12,10 15,2 18,18 21,6 24,14 27,10 32,10 40,10 48,10'}" />
        </svg>
        <span class="crew-heart-bpm${member.dead ? ' flatline' : ''}">${member.dead ? '---' : h.bpm}</span>
      </div>
      <div class="crew-vital-mini">
        <span class="crew-vital-label">Heart</span>
        <span class="crew-vital-val" style="color: ${hc(h.health)}">${Math.round(h.health)}%</span>
      </div>
      <div class="crew-vital-mini">
        <span class="crew-vital-label">Mind</span>
        <span class="crew-vital-val" style="color: ${hc(member.consciousness)}">${Math.round(member.consciousness)}%</span>
      </div>
      <div class="crew-vital-mini">
        <span class="crew-vital-label">BP</span>
        <span class="crew-vital-val${member.dead ? ' flatline' : ''}">${member.dead ? '---' : `${h.bpSystolic}/${h.bpDiastolic}`}</span>
      </div>
    </div>

    <div class="crew-section-label">BODY</div>
    <div class="crew-body-diagram">
      <div class="crew-body-row">
        <div class="crew-body-part crew-body-head ${bc(b.head)}" title="Head: ${Math.round(b.head)}%">
          <span class="crew-body-icon">&#9673;</span>
        </div>
      </div>
      <div class="crew-body-row crew-body-mid">
        <div class="crew-body-part crew-body-arm ${bc(b.leftArm)}" title="L.Arm: ${Math.round(b.leftArm)}%">
          <span class="crew-body-val">${Math.round(b.leftArm)}</span>
        </div>
        <div class="crew-body-part crew-body-torso ${bc(b.torso)}" title="Torso: ${Math.round(b.torso)}%">
          <span class="crew-body-val">${Math.round(b.torso)}</span>
        </div>
        <div class="crew-body-part crew-body-arm ${bc(b.rightArm)}" title="R.Arm: ${Math.round(b.rightArm)}%">
          <span class="crew-body-val">${Math.round(b.rightArm)}</span>
        </div>
      </div>
      <div class="crew-body-row crew-body-legs">
        <div class="crew-body-part crew-body-leg ${bc(b.leftLeg)}" title="L.Leg: ${Math.round(b.leftLeg)}%">
          <span class="crew-body-val">${Math.round(b.leftLeg)}</span>
        </div>
        <div class="crew-body-part crew-body-leg ${bc(b.rightLeg)}" title="R.Leg: ${Math.round(b.rightLeg)}%">
          <span class="crew-body-val">${Math.round(b.rightLeg)}</span>
        </div>
      </div>
    </div>

    <div class="crew-stat">
      <span class="crew-stat-label">Overall</span>
      <div class="crew-stat-bar"><div class="crew-stat-fill health" style="width: ${overall}%; background: ${hc(overall)}"></div></div>
    </div>
    <div class="crew-stat">
      <span class="crew-stat-label">Morale</span>
      <div class="crew-stat-bar"><div class="crew-stat-fill morale" style="width: ${member.morale}%"></div></div>
    </div>

    <div class="crew-section-label">SKILLS</div>
    ${skillsHtml}

    <div class="info-line" style="margin-top: 6px">
      <span class="info-key">Deck</span>
      <span class="info-val">${gameState.ship.decks[member.deck].name}</span>
    </div>
    ${member._inCrashCouch ? '<div class="crew-location-tag crew-location-couch">In Crash Couch</div>' : ''}
    ${member._inMedbay ? '<div class="crew-location-tag crew-location-medbay">In Medical Bay</div>' : ''}
    ${member._inSuit ? `<div class="crew-location-tag crew-location-suit">EVA Suit (${Math.round(member.evaSuit.o2Remaining)}h O₂)</div>` : ''}

    ${buildCrewActions(member)}
  `;

  // Wire up action buttons after innerHTML is set
  bindCrewActionButtons(member);
}

function buildCrewActions(member) {
  if (member.dead) return '';

  const mission = getCrewMission(member.id);
  const isUnconscious = member.consciousness <= 10;
  const needsHealing = getOverallHealth(member) < 100 ||
    member.heart.health < 100 ||
    member.conditions.includes('critical') ||
    member.conditions.includes('brain-damage') ||
    member.conditions.includes('injured');

  // Secured in crash couch
  if (mission === 'secure-burn') {
    return `
      <div class="crew-actions">
        <div class="crew-mission-status">Secured for burn</div>
      </div>`;
  }

  // Donning EVA suit
  if (mission === 'equip-suit') {
    return `
      <div class="crew-actions">
        <div class="crew-mission-status">Donning EVA suit...</div>
      </div>`;
  }

  // Already at medbay healing
  if (mission === 'healing') {
    return `
      <div class="crew-actions">
        <div class="crew-mission-status">Receiving treatment...</div>
        <button class="crew-action-btn crew-action-cancel" data-crew-action="cancel">CANCEL</button>
      </div>`;
  }

  // Already on recover mission
  if (mission === 'recover') {
    return `
      <div class="crew-actions">
        <div class="crew-mission-status">Moving to medbay...</div>
        <button class="crew-action-btn crew-action-cancel" data-crew-action="cancel">CANCEL</button>
      </div>`;
  }

  // Being rescued (patient side) — check if someone is rescuing this crew
  const beingRescued = isBeingRescued(member.id);

  if (!needsHealing) return '';

  const buttons = [];

  if (isUnconscious) {
    if (!beingRescued) {
      buttons.push(`<button class="crew-action-btn crew-action-rescue" data-crew-action="rescue">RESCUE</button>`);
    } else {
      buttons.push(`<div class="crew-mission-status">Rescue en route...</div>`);
    }
  } else if (member.conditions.includes('critical')) {
    // Critical but conscious — need first aid then medbay
    buttons.push(`<button class="crew-action-btn crew-action-rescue" data-crew-action="rescue">RESCUE</button>`);
  } else {
    buttons.push(`<button class="crew-action-btn crew-action-recover" data-crew-action="recover">RECOVER</button>`);
  }

  return buttons.length > 0 ? `<div class="crew-actions">${buttons.join('')}</div>` : '';
}

function bindCrewActionButtons(member) {
  const recoverBtn = document.querySelector('[data-crew-action="recover"]');
  if (recoverBtn) {
    recoverBtn.addEventListener('click', () => {
      const ok = assignRecoverMission(gameState.ship, member);
      if (ok) {
        showToast(`${member.name} heading to medbay`, 'info');
        addLogEntry(`${member.name} assigned to medbay for recovery`, 'crew');
      } else {
        showToast('No medbay available', 'danger');
      }
      selectCrew(member); // refresh panel
    });
  }

  const rescueBtn = document.querySelector('[data-crew-action="rescue"]');
  if (rescueBtn) {
    rescueBtn.addEventListener('click', () => {
      const result = assignRescueMission(gameState.ship, member);
      if (result.success) {
        showToast(`${result.medicName} dispatched to rescue ${member.name}`, 'info');
        addLogEntry(`${result.medicName} dispatched — rescuing ${member.name}`, 'crew');
      } else if (result.reason === 'no-medic') {
        showToast('No crew with medical skill > 20 available', 'danger');
      } else if (result.reason === 'dead') {
        showToast(`${member.name} is beyond help`, 'danger');
      } else {
        showToast('Cannot dispatch rescue', 'danger');
      }
      selectCrew(member); // refresh panel
    });
  }

  const cancelBtn = document.querySelector('[data-crew-action="cancel"]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelMission(member.id);
      showToast(`${member.name}'s mission cancelled`);
      selectCrew(member); // refresh panel
    });
  }
}

// ---- TILE SELECTION ----

let selectedTile = null;

const TILE_DESCRIPTIONS = {
  [TileType.CONSOLE]: 'General-purpose ship terminal. Used for comms, sensors, and system monitoring.',
  [TileType.NAV_CONSOLE]: 'Navigation and flight control. Plots courses and manages burn sequences.',
  [TileType.ENGINE]: 'Epstein fusion drive. Provides thrust for interplanetary travel.',
  [TileType.REACTOR]: 'Fusion reactor core. Powers all ship systems including the Epstein drive. Containment failure is catastrophic.',
  [TileType.STORAGE]: 'Cargo and supply storage. Holds provisions and spare parts.',
  [TileType.LIFE_SUPPORT]: 'Atmospheric recycling and O2 generation. Keeps the crew breathing.',
  [TileType.AIRLOCK]: 'Pressurized airlock for EVA operations.',
  [TileType.MEDBAY]: 'Medical bay. Auto-administers first aid and heals injured crew.',
  [TileType.CRASH_COUCH]: 'High-G crash couch. Gel-filled acceleration seat for sustained burns above 1G.',
  [TileType.TERMINAL]: 'Workstation terminal. Crew interface for system operations.',
  [TileType.EVA_LOCKER]: 'EVA suit locker. Contains one EVA suit with built-in life support.',
  [TileType.RADIO]: 'High-gain communications array. Contacts ships and stations within range. Broadcasts SOS in emergencies.',
  [TileType.TRANSPONDER]: 'Ship identity transponder. Broadcasts vessel identification. Can be disabled for stealth — but drive plume remains visible when thrusting.',
};

const TILE_STATUS_FN = {
  [TileType.ENGINE]: () => {
    if (!gameState) return 'Idle';
    const p = gameState.physics;
    return p.thrustActive ? `Active — ${p.gForce.toFixed(1)}G` : 'Idle';
  },
  [TileType.REACTOR]: () => {
    if (!gameState || !gameState.reactor) return 'Online';
    return getReactorStatusText(gameState);
  },
  [TileType.LIFE_SUPPORT]: (deckIdx) => {
    if (!gameState) return '—';
    const eq = gameState.lsEquipment?.[deckIdx];
    const statusLabel = getEquipmentStatusLabel(eq);
    const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
    if (!atmo) return statusLabel;
    return `${statusLabel}\nAtmo: ${atmo.pressure.toFixed(1)} kPa | O2 ${atmo.o2Pct.toFixed(1)}% | CO2 ${atmo.co2Pct.toFixed(2)}%`;
  },
  [TileType.MEDBAY]: () => {
    if (!gameState) return 'Ready';
    const healing = gameState.ship.crew.filter(c =>
      !c.dead && c.conditions.includes('healing')
    );
    return healing.length > 0 ? `Treating ${healing.length} patient(s)` : 'Ready';
  },
  [TileType.CRASH_COUCH]: () => {
    if (!gameState) return 'Empty';
    const g = gameState.physics.gForce;
    return g > 1.5 ? `Active — ${g.toFixed(1)}G` : 'Standby';
  },
  [TileType.EVA_LOCKER]: (deckIdx, tx, ty) => {
    if (!gameState || !gameState.suitLockers) return '—';
    const locker = gameState.suitLockers.find(l =>
      l.deckIdx === deckIdx && l.x === tx && l.y === ty
    );
    if (!locker) return 'Empty';
    return locker.hasSuit ? 'EVA Suit — Ready' : 'Empty';
  },
  [TileType.RADIO]: () => {
    if (!gameState?.comms) return '—';
    const c = gameState.comms;
    const contacts = c.radioContacts?.length || 0;
    const sos = c.sosActive ? ' | SOS ACTIVE' : '';
    return `${contacts} contact${contacts !== 1 ? 's' : ''} in range${sos}`;
  },
  [TileType.TRANSPONDER]: () => {
    if (!gameState?.comms) return '—';
    const on = gameState.comms.transponderOn;
    const thrusting = gameState.physics?.thrustActive;
    let status = on ? 'ACTIVE — Broadcasting' : 'DISABLED — Silent running';
    if (!on && thrusting) status += '\n⚠ Drive plume visible';
    return status;
  },
};

function selectTile(tileType, deckIdx, tx, ty) {
  selectedTile = { tileType, deckIdx, tx, ty };
  selectedCrew = null;

  // Deselect crew visuals
  document.querySelectorAll('.crew-symbol').forEach(el => el.classList.remove('selected'));

  // Highlight selected tile
  document.querySelectorAll('.tile-interactive').forEach(el => el.classList.remove('tile-selected'));
  // Find the tile at matching position (by transform attribute)
  const tiles = document.querySelectorAll(`.tile-interactive[data-tile-type="${tileType}"]`);
  // We match by parent deck group's data-deck and tile transform
  tiles.forEach(el => {
    const deckGroup = el.closest('[data-deck]');
    if (deckGroup && parseInt(deckGroup.getAttribute('data-deck')) === deckIdx) {
      el.classList.add('tile-selected');
    }
  });

  const crewInfo = document.getElementById('crew-info');
  const name = TILE_NAMES[tileType] || 'Unknown';
  const desc = TILE_DESCRIPTIONS[tileType] || '';
  const statusFn = TILE_STATUS_FN[tileType];
  const status = statusFn ? statusFn(deckIdx, tx, ty) : null;
  const deckName = gameState.ship.decks[deckIdx]?.name || `Deck ${deckIdx}`;

  let html = `
    <div class="tile-detail-name">${escapeHtml(name)}</div>
    <div class="tile-detail-deck">${escapeHtml(deckName.toUpperCase())}</div>
    <p class="tile-detail-desc">${escapeHtml(desc)}</p>`;

  if (status) {
    const statusLines = status.split('\n');
    html += `<div class="tile-detail-status">
      <span class="tile-status-label">STATUS</span>
      ${statusLines.map(l => `<span class="tile-status-value">${escapeHtml(l)}</span>`).join('')}
    </div>`;
  }

  // Atmosphere readout for this compartment
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (atmo) {
    const atmoStatus = getAtmoStatus(atmo);
    const statusClass = atmoStatus === 'nominal' ? 'atmo-ok'
      : (atmoStatus === 'warning' ? 'atmo-warn' : 'atmo-danger');
    html += `<div class="tile-detail-atmosphere">
      <span class="tile-status-label">COMPARTMENT</span>
      <div class="atmo-readout ${statusClass}">
        <span>${atmo.pressure.toFixed(1)} kPa</span>
        <span>O2 ${atmo.o2Pct.toFixed(1)}%</span>
        <span>N2 ${atmo.n2Pct.toFixed(1)}%</span>
        <span>CO2 ${atmo.co2Pct.toFixed(2)}%</span>
      </div>
      <div class="atmo-meta">EVA suits available: ${countSuitsOnDeck(gameState, deckIdx)}</div>
    </div>`;
  }

  // Life support toggle button
  // Radio actions
  if (tileType === TileType.RADIO && gameState.comms) {
    const contacts = gameState.comms.radioContacts || [];
    const sosActive = gameState.comms.sosActive;
    html += '<div class="tile-actions">';
    html += `<button class="crew-action-btn ${sosActive ? 'crew-action-rescue' : 'crew-action-recover'}" data-tile-action="toggle-sos">${sosActive ? 'CANCEL SOS' : 'BROADCAST SOS'}</button>`;
    if (contacts.length > 0) {
      html += '<div class="tile-status-value" style="margin-top:6px">CONTACTS:</div>';
      contacts.forEach(c => {
        const distKm = (c.distance * 149597870.7).toFixed(0);
        const label = c.name || 'UNKNOWN';
        const sosTag = c.sosActive ? ' <span style="color:var(--danger)">[SOS]</span>' : '';
        html += `<div class="radio-contact-row">`;
        html += `<span class="radio-contact-info">${escapeHtml(label)} — ${Number(distKm).toLocaleString()} km${sosTag}</span>`;
        html += `<button class="radio-hail-btn" data-tile-action="hail" data-entity="${escapeHtml(c.entityId)}">HAIL</button>`;
        html += `</div>`;
      });
    }
    html += '</div>';
  }

  // Transponder actions
  if (tileType === TileType.TRANSPONDER && gameState.comms) {
    const on = gameState.comms.transponderOn;
    html += '<div class="tile-actions">';
    html += `<button class="crew-action-btn ${on ? 'crew-action-rescue' : 'crew-action-recover'}" data-tile-action="toggle-transponder">${on ? 'DISABLE TRANSPONDER' : 'ENABLE TRANSPONDER'}</button>`;
    if (!on && gameState.physics?.thrustActive) {
      html += '<div class="tile-status-value" style="color:var(--warning);margin-top:4px">⚠ Drive plume is a unique signature — ship identifiable while thrusting</div>';
    }
    html += '</div>';
  }

  if (tileType === TileType.LIFE_SUPPORT) {
    const eq = gameState.lsEquipment?.[deckIdx];
    if (eq) {
      const isOn = eq.enabled !== false;
      html += `<div class="tile-actions">
        <button class="crew-action-btn ${isOn ? 'crew-action-recover' : 'crew-action-rescue'}"
                data-tile-action="toggle-ls" data-deck="${deckIdx}">
          ${isOn ? 'DISABLE' : 'ENABLE'} LIFE SUPPORT
        </button>
      </div>`;
    }
  }

  // Reactor action buttons
  if (tileType === TileType.REACTOR && gameState.reactor) {
    const r = gameState.reactor;
    html += '<div class="tile-actions">';

    if (r.status === 'online') {
      // Find engineers for shutdown
      const engineers = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10 && c.role === 'Engineer');
      if (engineers.length > 0) {
        engineers.forEach(eng => {
          html += `<button class="crew-action-btn crew-action-recover" data-tile-action="reactor-shutdown" data-crew="${eng.id}">SHUTDOWN (${escapeHtml(eng.name)})</button>`;
        });
      }
      html += `<button class="crew-action-btn crew-action-rescue" data-tile-action="reactor-emergency">\u26A0 EMERGENCY SHUTOFF (1h)</button>`;
    }

    if (r.status === 'shutdown-countdown') {
      html += `<button class="crew-action-btn crew-action-recover" data-tile-action="reactor-cancel-shutdown">CANCEL SHUTDOWN</button>`;
    }

    if (r.status === 'emergency-shutoff') {
      html += `<button class="crew-action-btn crew-action-recover" data-tile-action="reactor-cancel-emergency">CANCEL EMERGENCY</button>`;
      html += `<button class="crew-action-btn crew-action-rescue" data-tile-action="reactor-immediate" style="border-color:var(--danger)">\u26A0 IMMEDIATE SHUTOFF (dumps ALL fuel)</button>`;
    }

    if (r.status === 'offline') {
      if (r.containmentTriggered) {
        // Need to patch first
        const patchCrew = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10 && (c.skills?.engineering || 0) >= 10);
        patchCrew.forEach(eng => {
          html += `<button class="crew-action-btn crew-action-recover" data-tile-action="reactor-patch" data-crew="${eng.id}">PATCH CONTAINMENT (${escapeHtml(eng.name)})</button>`;
        });
      } else {
        // Startup
        const startCrew = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10 && (c.skills?.engineering || 0) >= STARTUP_MIN_ENGINEERING);
        if (startCrew.length > 0 && gameState.resources.fuel.current >= STARTUP_MIN_FUEL) {
          startCrew.forEach(eng => {
            html += `<button class="crew-action-btn crew-action-recover" data-tile-action="reactor-startup" data-crew="${eng.id}">START REACTOR (${escapeHtml(eng.name)})</button>`;
          });
        } else if (gameState.resources.fuel.current < STARTUP_MIN_FUEL) {
          html += `<span class="tile-status-value" style="color:var(--danger)">Insufficient fuel (need ${STARTUP_MIN_FUEL})</span>`;
        } else {
          html += `<span class="tile-status-value" style="color:var(--danger)">No qualified engineer (need eng \u2265 ${STARTUP_MIN_ENGINEERING})</span>`;
        }
      }
    }

    if (r.status === 'containment-failure') {
      const engineers = gameState.ship.crew.filter(c => !c.dead && c.consciousness > 10 && c.role === 'Engineer');
      if (engineers.length > 0) {
        engineers.forEach(eng => {
          html += `<button class="crew-action-btn crew-action-rescue" data-tile-action="reactor-shutdown" data-crew="${eng.id}">EMERGENCY SCRAM (${escapeHtml(eng.name)})</button>`;
        });
      }
      html += `<button class="crew-action-btn crew-action-rescue" data-tile-action="reactor-emergency">\u26A0 EMERGENCY SHUTOFF (1h)</button>`;
    }

    if (r.status === 'shutting-down') {
      html += `<span class="tile-status-value">Engineer working on shutdown...</span>`;
    }

    if (r.status === 'starting-up') {
      html += `<span class="tile-status-value">Engineer working on startup...</span>`;
    }

    html += '</div>';
  }

  crewInfo.innerHTML = html;

  // Wire up tile action buttons
  crewInfo.querySelectorAll('[data-tile-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-tile-action');
      const di = parseInt(btn.getAttribute('data-deck'));
      if (action === 'toggle-ls') {
        const nowEnabled = toggleLS(gameState, di);
        const dName = gameState.ship.decks[di]?.name || `Deck ${di}`;
        if (nowEnabled) {
          showToast(`${dName} LS enabled`, 'ok');
          addLogEntry(`Life support enabled on ${dName}`, 'system');
        } else {
          showToast(`${dName} LS DISABLED`, 'danger');
          addLogEntry(`Life support manually disabled on ${dName}`, 'danger');
        }
        // Re-render the tile detail
        selectTile(tileType, deckIdx, tx, ty);
      }
      if (action === 'toggle-sos') {
        const result = triggerSOS(gameState);
        if (result.success) {
          showToast(result.message, result.active ? 'danger' : 'ok');
          addLogEntry(result.message, result.active ? 'danger' : 'system');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'hail') {
        const entityId = btn.getAttribute('data-entity');
        openHailModal(entityId);
      }
      if (action === 'toggle-transponder') {
        const result = toggleTransponder(gameState);
        if (result.success) {
          showToast(result.message, result.active ? 'ok' : 'warn');
          addLogEntry(result.message, result.active ? 'system' : 'warn');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-shutdown') {
        const crewId = parseInt(btn.getAttribute('data-crew'));
        const result = beginShutdown(gameState, crewId);
        if (result.success) {
          showToast(result.message, 'ok');
          addLogEntry(result.message, 'system');
          // If reactor went offline (containment scram), apply red tint
          if (!isReactorOnline(gameState)) document.body.classList.add('reactor-offline');
        } else {
          showToast(result.message, 'danger');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-cancel-shutdown') {
        const result = cancelShutdown(gameState);
        showToast(result.message, result.success ? 'ok' : 'danger');
        if (result.success) addLogEntry(result.message, 'system');
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-emergency') {
        const result = beginEmergencyShutoff(gameState);
        if (result.success) {
          showToast(result.message, 'danger');
          addLogEntry(result.message, 'danger');
        } else {
          showToast(result.message, 'danger');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-immediate') {
        const result = immediateEmergencyShutoff(gameState);
        if (result.success) {
          showToast(result.message, 'danger');
          addLogEntry(result.message, 'danger');
          document.body.classList.add('reactor-offline');
        } else {
          showToast(result.message, 'danger');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-cancel-emergency') {
        const result = cancelEmergencyShutoff(gameState);
        showToast(result.message, result.success ? 'ok' : 'danger');
        if (result.success) addLogEntry(result.message, 'system');
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-startup') {
        const crewId = parseInt(btn.getAttribute('data-crew'));
        const result = beginStartup(gameState, crewId);
        if (result.success) {
          showToast(result.message, 'ok');
          addLogEntry(result.message, 'system');
        } else {
          showToast(result.message, 'danger');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
      if (action === 'reactor-patch') {
        const crewId = parseInt(btn.getAttribute('data-crew'));
        const result = patchReactor(gameState, crewId);
        if (result.success) {
          showToast(result.message, 'ok');
          addLogEntry(result.message, 'ok');
        } else {
          showToast(result.message, 'danger');
        }
        selectTile(selectedTile.tileType, selectedTile.deckIdx, selectedTile.tx, selectedTile.ty);
      }
    });
  });
}

// ---- TILE PANEL LIVE UPDATE ----
// Update dynamic values in the tile info panel without re-rendering (preserves click handlers)
function updateTilePanel() {
  if (!selectedTile || !gameState) return;
  const { tileType, deckIdx, tx, ty } = selectedTile;

  // Update status text
  const statusFn = TILE_STATUS_FN[tileType];
  if (statusFn) {
    const status = statusFn(deckIdx, tx, ty);
    const statusEls = document.querySelectorAll('#crew-info .tile-status-value');
    if (statusEls.length > 0 && status) {
      const lines = status.split('\n');
      statusEls.forEach((el, i) => {
        if (lines[i] !== undefined) el.textContent = lines[i];
      });
    }
  }

  // Update atmosphere readout
  const atmo = gameState.ship.decks[deckIdx]?.atmosphere;
  if (atmo) {
    const readout = document.querySelector('#crew-info .atmo-readout');
    if (readout) {
      const spans = readout.querySelectorAll('span');
      if (spans.length >= 4) {
        spans[0].textContent = `${atmo.pressure.toFixed(1)} kPa`;
        spans[1].textContent = `O2 ${atmo.o2Pct.toFixed(1)}%`;
        spans[2].textContent = `N2 ${atmo.n2Pct.toFixed(1)}%`;
        spans[3].textContent = `CO2 ${atmo.co2Pct.toFixed(2)}%`;
      }
      // Update status class
      const atmoStatus = getAtmoStatus(atmo);
      readout.classList.remove('atmo-ok', 'atmo-warn', 'atmo-danger');
      readout.classList.add(atmoStatus === 'nominal' ? 'atmo-ok'
        : (atmoStatus === 'warning' ? 'atmo-warn' : 'atmo-danger'));
    }
    // Update EVA suit count
    const metaEl = document.querySelector('#crew-info .atmo-meta');
    if (metaEl) {
      metaEl.textContent = `EVA suits available: ${countSuitsOnDeck(gameState, deckIdx)}`;
    }
  }
}

// ---- COMPARTMENT CONTEXT MENU ----

function showCompartmentMenu(x, y, deckIdx) {
  // Remove existing context menu
  const existing = document.getElementById('compartment-menu');
  if (existing) existing.remove();

  const deck = gameState.ship.decks[deckIdx];
  if (!deck || !deck.atmosphere) return;
  const atmo = deck.atmosphere;
  const deckName = deck.name;

  const menu = document.createElement('div');
  menu.id = 'compartment-menu';
  menu.className = 'compartment-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  let items = `<div class="ctx-header">${escapeHtml(deckName.toUpperCase())}</div>`;
  items += `<div class="ctx-info">${atmo.pressure.toFixed(1)} kPa | O2 ${atmo.o2Pct.toFixed(1)}%</div>`;

  if (atmo.depressurized) {
    items += `<div class="ctx-item" data-action="repressurize">Repressurize</div>`;
  } else if (!atmo.breached && atmo.pressure > 1) {
    items += `<div class="ctx-item ctx-danger" data-action="depressurize">Depressurize Compartment</div>`;
  }
  if (atmo.breached) {
    items += `<div class="ctx-info ctx-breach">HULL BREACH</div>`;
  }

  menu.innerHTML = items;
  document.body.appendChild(menu);

  // Actions
  menu.addEventListener('click', (e) => {
    const action = e.target.getAttribute('data-action');
    if (action === 'depressurize') {
      depressurizeCompartment(gameState, deckIdx);
      addLogEntry(`${deckName} compartment depressurized`, 'danger');
      showToast(`${deckName} DEPRESSURIZING`, 'danger');
    } else if (action === 'repressurize') {
      repressurizeCompartment(gameState, deckIdx);
      addLogEntry(`${deckName} repressurization started`, 'system');
      showToast(`${deckName} repressurizing`, 'ok');
    }
    menu.remove();
  });

  // Close on click outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

// ---- RESOURCE PANEL ----

const RESOURCE_CONFIG = [
  { key: 'fuel', name: 'Fuel', icon: iconFuel, barClass: 'bar-fuel' },
  { key: 'o2Tank', name: 'O2', icon: iconOxygen, barClass: 'bar-oxygen' },
  { key: 'n2Tank', name: 'N2', icon: iconN2, barClass: 'bar-n2' },
  { key: 'water', name: 'H2O', icon: iconWater, barClass: 'bar-water' },
  { key: 'food', name: 'Food', icon: iconFood, barClass: 'bar-food' },
  { key: 'power', name: 'Power', icon: iconPower, barClass: 'bar-power' },
  { key: 'medSupplies', name: 'Med', icon: iconMedical, barClass: 'bar-medical' },
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
let _lastResourceAlertTime = {};

function updateResourcePanel(state) {
  _resCache._crew.textContent = state.ship.crew.length;

  let hasCritical = false;
  const alerts = [];

  RESOURCE_CONFIG.forEach(cfg => {
    const res = state.resources[cfg.key];
    if (!res) return;

    const pct = (res.current / res.max) * 100;
    const cached = _resCache[cfg.key];
    const valEl = cached.val;
    const barEl = cached.bar;
    const itemEl = cached.item;

    valEl.textContent = `${Math.round(res.current)} / ${res.max}`;
    barEl.style.width = `${pct}%`;

    itemEl.classList.remove('warning', 'critical');
    if (pct < 15) {
      itemEl.classList.add('critical');
      hasCritical = true;
      alerts.push(`${cfg.name} critical: ${Math.round(pct)}%`);

      // Toast + log on first entry to critical (debounced 10s)
      const now = Date.now();
      const lastAlert = _lastResourceAlertTime[cfg.key] || 0;
      const prevPct = prevResourceLevels[cfg.key] ?? 100;
      if (prevPct >= 15 && pct < 15 && now - lastAlert > 10000) {
        _lastResourceAlertTime[cfg.key] = now;
        showToast(`${cfg.name} CRITICAL`, 'danger');
        addLogEntry(`${cfg.name} critical — ${Math.round(pct)}% remaining`, 'danger');
      }
    } else if (pct < 30) {
      itemEl.classList.add('warning');
      alerts.push(`${cfg.name} low: ${Math.round(pct)}%`);

      const now = Date.now();
      const lastAlert = _lastResourceAlertTime[cfg.key] || 0;
      const prevPct = prevResourceLevels[cfg.key] ?? 100;
      if (prevPct >= 30 && pct < 30 && now - lastAlert > 10000) {
        _lastResourceAlertTime[cfg.key] = now;
        showToast(`${cfg.name} running low`, 'warn');
        addLogEntry(`${cfg.name} low — ${Math.round(pct)}% remaining`, 'warn');
      }
    }

    prevResourceLevels[cfg.key] = pct;
  });

  // Alert border
  const alertBorder = _resCache._alertBorder;
  if (alertBorder) {
    if (hasCritical) {
      alertBorder.classList.add('critical');
    } else {
      alertBorder.classList.remove('critical');
    }
  }

  // Alerts are now shown in the ship's log — no separate alerts list needed
}

function updateAtmosphereIndicators(state) {
  const ATMO_COLORS = {
    nominal: '#4FD1C5',
    warning: '#E2A355',
    critical: '#E25555',
    breached: '#FF2222',
    depressurized: '#FF2222',
    vacuum: '#661111',
    unknown: '#3A4E62',
  };

  state.ship.decks.forEach((deck, di) => {
    const dot = document.querySelector(`[data-deck-atmo="${di}"]`);
    if (!dot || !deck.atmosphere) return;
    const status = getAtmoStatus(deck.atmosphere);
    dot.setAttribute('fill', ATMO_COLORS[status] || ATMO_COLORS.unknown);
  });
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
  const shipContainer = document.getElementById('ship-container');
  if (speed === 0) {
    gameScreen.classList.add('game-paused');
    if (shipSvg) shipSvg.pauseAnimations();
  } else {
    gameScreen.classList.remove('game-paused');
    if (shipSvg) shipSvg.unpauseAnimations();
  }
  // Hide ship interior when not at normal speed (animations don't match)
  if (shipContainer) {
    shipContainer.classList.toggle('ship-fast-forward', speed !== 1);
  }
}

// ---- HUD UPDATE ----

function initHudCache() {
  // HUD elements
  _hud = {
    date:         document.getElementById('hud-date'),
    time:         document.getElementById('hud-time'),
    shipName:     document.getElementById('hud-ship-name'),
    infoTorch:    document.getElementById('info-torch'),
    infoThrust:   document.getElementById('info-thrust'),
    infoHeading:  document.getElementById('info-heading'),
    infoVelocity: document.getElementById('info-velocity'),
    infoVelRef:   document.getElementById('info-vel-ref'),
    infoVelRefRow: document.getElementById('info-vel-ref-row'),
    infoMass:     document.getElementById('info-mass'),
    thrustToggle: document.getElementById('thrust-toggle'),
    thrustStatus: document.getElementById('thrust-status'),
    thrustSlider: document.getElementById('thrust-slider'),
    enginePlume:  document.getElementById('engine-plume'),
    flipHeading:  document.getElementById('flip-heading'),
    tacModalVel:  document.getElementById('tac-modal-velocity'),
    tacModalHead: document.getElementById('tac-modal-heading'),
    tacModalThr:  document.getElementById('tac-modal-thrust'),
    shipContainer: document.getElementById('ship-container'),
    tacScreen:    document.getElementById('tac-screen'),
  };

  // Resource panel elements
  _resCache = {};
  _resCache._crew = document.getElementById('res-val-crew');
  _resCache._alertBorder = document.getElementById('alert-border');
  RESOURCE_CONFIG.forEach(cfg => {
    _resCache[cfg.key] = {
      val:  document.getElementById(`res-val-${cfg.key}`),
      bar:  document.getElementById(`res-bar-${cfg.key}`),
      item: document.getElementById(`resource-${cfg.key}`),
    };
  });

  // Solar tab info bar elements
  _solarCache = {
    routeZoomBtn:   document.getElementById('route-zoom-btn'),
    routePlotBtn:   document.getElementById('route-plot-btn'),
    routeStatusBar: document.getElementById('route-status-bar'),
    routeStatusDest: document.getElementById('route-status-dest'),
    routeStatusPhase: document.getElementById('route-status-phase'),
    routeStatusFill: document.getElementById('route-status-fill'),
    routeStatusEta: document.getElementById('route-status-eta'),
    tacSepThrust:   document.getElementById('tac-sep-thrust'),
  };

  // Track thrust slider active state via pointer events instead of :active matches
  _thrustSliderActive = false;
  if (_hud.thrustSlider) {
    _hud.thrustSlider.addEventListener('pointerdown', () => { _thrustSliderActive = true; });
    _hud.thrustSlider.addEventListener('pointerup', () => { _thrustSliderActive = false; });
    _hud.thrustSlider.addEventListener('pointercancel', () => { _thrustSliderActive = false; });
  }
}

function updateHud(state) {
  _hud.date.textContent = formatDate(state.time);
  _hud.time.textContent = formatTime(state.time);
  _hud.shipName.textContent = state.ship.name;

  const phys = state.physics;
  const hasGravity = state.navigation.thrust > 0;

  // Ship status info
  _hud.infoTorch.textContent =
    phys.thrustActive ? `BURNING (${(phys.thrustLevel * phys.maxThrust).toFixed(1)}g)` : 'CUTOFF';
  _hud.infoTorch.style.color =
    phys.thrustActive ? '#FFFFFF' : '';
  _hud.infoThrust.textContent =
    hasGravity ? `${state.navigation.thrust.toFixed(1)}g` : '0.0g';
  const relVelForHeading = getRelativeVelocity(phys);
  const fineApproach = isFineApproaching();
  const headingText = fineApproach ? 'FINE APPROACH' :
    phys.flipping ? 'FLIPPING' :
    (relVelForHeading >= 0 ? 'PROGRADE' : 'RETROGRADE');
  _hud.infoHeading.textContent = headingText;
  _hud.infoHeading.style.color =
    fineApproach ? '#4FD1C5' : phys.flipping ? '#E2A355' : '';
  if (_hud.flipHeading && !phys.flipping) {
    _hud.flipHeading.textContent = fineApproach ? 'RCS' : (relVelForHeading >= 0 ? 'PRO' : 'RETRO');
  }
  // Velocity displayed relative to target (or "---" if none)
  const velDisplay = getDisplayVelocity();
  _hud.infoVelocity.textContent = velDisplay.text;
  if (velDisplay.ref && _hud.infoVelRef) {
    _hud.infoVelRef.textContent = velDisplay.ref;
    if (_hud.infoVelRefRow) _hud.infoVelRefRow.style.display = '';
  } else {
    if (_hud.infoVelRefRow) _hud.infoVelRefRow.style.display = 'none';
  }
  _hud.infoMass.textContent =
    `${(phys.shipMass / 1000).toFixed(1)} t`;

  // Thrust button + slider state
  if (phys.thrustActive) {
    _hud.thrustToggle.classList.add('active');
    _hud.thrustStatus.textContent = `${(phys.thrustLevel * phys.maxThrust).toFixed(1)}G`;
  } else {
    _hud.thrustToggle.classList.remove('active');
    _hud.thrustStatus.textContent = 'OFF';
  }
  // Sync slider if physics changed thrust externally (fuel out, etc.)
  if (_hud.thrustSlider && !_thrustSliderActive) {
    _hud.thrustSlider.value = phys.thrustLevel * 100;
    updateThrustSliderUI(phys.thrustLevel);
  }

  // Engine plume visibility + intensity scaling with thrust level
  if (_hud.enginePlume) {
    if (!phys.thrustActive) {
      _hud.enginePlume.setAttribute('display', 'none');
    } else {
      _hud.enginePlume.setAttribute('display', 'inline');
      // Scale opacity: min thrust = 0.4, max thrust = 1.0
      const intensity = 0.4 + phys.thrustLevel * 0.6;
      _hud.enginePlume.setAttribute('opacity', intensity.toFixed(2));
    }
  }

  // Update tactical view when thrust state or velocity changes significantly
  // Bucket velocity so we don't re-render every frame
  const relVel = getRelativeVelocity(phys);
  const velSign = relVel >= 0 ? 1 : -1;
  const velBucket = velSign * Math.floor(Math.abs(relVel) / 5000);
  const tacNeedsUpdate = phys.thrustActive !== lastThrustActive || velBucket !== lastTacVelocityBucket || !!phys.orienting !== lastOrienting;
  if (tacNeedsUpdate) {
    lastThrustActive = phys.thrustActive;
    lastTacVelocityBucket = velBucket;
    lastOrienting = !!phys.orienting;
    if (_hud.tacScreen) {
      if (isBlackout()) {
        _hud.tacScreen.innerHTML = '';
      } else {
        renderTacView(state.ship, _hud.tacScreen, phys.thrustActive, tacZoomLevel, phys.flipping, getRelativeVelocity(phys), phys.orienting, getTacNearbyEntities(state, tacZoomLevel));
      }
    }
    // Keep modal tac in sync (full re-render on significant change)
    if (tacModalOpen && tacModalTab === 'tactical' && !isBlackout()) renderTacModal();
  }
  // Orient maneuver gating: pilot must be at helm, then wait for crew (or player override)
  if (_orientState === 'waiting-pilot') {
    const pilot = state.ship.crew.find(c => c.role === 'Pilot' && !c.dead);
    if (pilot && isSeatedInCouch(pilot.id)) {
      _orientState = 'waiting-crew';
      addLogEntry(`${pilot.name} at helm — awaiting crew secure`, 'nav');
      updateManeuverPrompt();
    }
  }
  if (_orientState === 'waiting-crew') {
    const allSecured = state.ship.crew.every(c =>
      c.dead || c.consciousness <= 10 || isSeatedInCouch(c.id)
    );
    if (allSecured) {
      engageOrientManeuver(state);
    } else {
      updateManeuverPrompt();
    }
  }

  // Update tac modal info bar every tick (velocity, heading, thrust always fresh)
  if (tacModalOpen) {
    if (tacModalTab === 'tactical') {
      const tacVD = getDisplayVelocity();
      const tacRef = tacVD.ref ? ` [${tacVD.ref}]` : '';
      if (_hud.tacModalVel) _hud.tacModalVel.textContent = `VEL ${tacVD.text}${tacRef}`;
      const relVel = getRelativeVelocity(phys);
      if (_hud.tacModalHead) _hud.tacModalHead.textContent = phys.flipping ? 'FLIPPING' : (relVel >= 0 ? 'PROGRADE' : 'RETROGRADE');
      if (_hud.tacModalThr) _hud.tacModalThr.textContent = phys.thrustActive ? `BURN ${(phys.thrustLevel * phys.maxThrust).toFixed(1)}G` : 'COAST';
    } else if (tacModalTab === 'solar') {
      renderSolarTab();
    } else if (tacModalTab === 'scanner') {
      renderScannerTab();
    }
  }

  // Update crew visual states from physics
  const shipContainer = _hud.shipContainer;
  if (shipContainer) {
    // Tag crew with location flags for sprite display
    gameState.ship.crew.forEach(c => {
      c._inCrashCouch = isSeatedInCouch(c.id);
      c._inMedbay = getCrewMission(c.id) === 'healing';
      c._inSuit = c.evaSuit && c.evaSuit.wearing;
    });

    // Build a key from physics states AND crew consciousness/dead/location to detect changes
    const crewVitalKey = gameState.ship.crew.map(c =>
      `${c.id}:${c.dead ? 'D' : c.consciousness <= 10 ? 'U' : 'A'}:${c._inCrashCouch ? 'C' : c._inMedbay ? 'M' : c._inSuit ? 'S' : ''}:${c.conditions?.includes('crushed') ? 'X' : ''}`
    ).join(',');
    const crewStateKey = JSON.stringify(phys.crewStates) + '|' + crewVitalKey;
    if (crewStateKey !== lastCrewStateKey) {
      lastCrewStateKey = crewStateKey;
      setCrewGravity(shipContainer, hasGravity, phys.crewStates, gameState.ship.crew);
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

// ---- CREW MOVEMENT ANIMATION LOOP ----

function startCrewMovementLoop() {
  if (crewMoveFrame) cancelAnimationFrame(crewMoveFrame);
  let lastTime = performance.now();

  function tick(now) {
    if (currentScreen !== 'game') {
      crewMoveFrame = null;
      return;
    }
    const deltaSec = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms
    lastTime = now;

    if (gameState) {
      updateCrewMovement(
        gameState.ship,
        gameState.physics,
        deltaSec,
        gameState.speed
      );

      // Update inertia sliding (when not being driven by flip animation)
      if (isInertiaActive() && !gameState.physics.flipping) {
        const impacts = updateInertiaFrame(gameState.ship, gameState.physics, deltaSec);
        processImpactEvents(impacts);

        // Check if inertia resolved → exit cinematic time
        if (!isInertiaActive() && isInCinematicTime()) {
          exitCinematicTime(gameState);
        }
      }
    }

    crewMoveFrame = requestAnimationFrame(tick);
  }

  crewMoveFrame = requestAnimationFrame(tick);
}

// ---- START GAME ----

function startGame() {
  showScreen('game');
  initResourcePanel();
  prevResourceLevels = {};
  _lastResourceAlertTime = {};
  selectedCrew = null;

  // Reset crew info panel
  const crewInfo = document.getElementById('crew-info');
  if (crewInfo) crewInfo.innerHTML = '<p class="info-line info-dim">Click a crew member</p>';

  // Render ship with crew and tile click handlers
  const shipContainer = document.getElementById('ship-container');
  renderShip(gameState.ship, shipContainer, (member) => {
    selectCrew(member);
  }, (tileType, deckIdx, tx, ty) => {
    selectTile(tileType, deckIdx, tx, ty);
  });

  // Right-click context menu on deck groups for compartment controls
  shipContainer.querySelectorAll('.deck-group').forEach(deckGroup => {
    deckGroup.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const deckIdx = parseInt(deckGroup.getAttribute('data-deck'));
      showCompartmentMenu(e.clientX, e.clientY, deckIdx);
    });
  });

  // Render tactical view
  const tacScreen = document.getElementById('tac-screen');
  if (tacScreen) {
    renderTacView(gameState.ship, tacScreen, gameState.physics.thrustActive, tacZoomLevel, false, getRelativeVelocity(gameState.physics), false, getTacNearbyEntities(gameState, tacZoomLevel));
  }

  // Init crew movement patrol system — restore saved state if available
  if (gameState._crewMovement) {
    restoreCrewMovement(gameState.ship, gameState._crewMovement);
    delete gameState._crewMovement;
  } else {
    initCrewMovement(gameState.ship);
  }
  clearJobs();
  startCrewMovementLoop();

  // Init reactor — ensure state exists
  if (!gameState.reactor) initReactor(gameState);
  document.body.classList.remove('reactor-offline');
  if (gameState.reactor && !isReactorOnline(gameState)) {
    document.body.classList.add('reactor-offline');
  }

  // Set initial gravity state (thrust=0 at start = micro-G)
  const hasGravity = gameState.navigation.thrust > 0;
  lastCrewStateKey = null;
  setCrewGravity(shipContainer, hasGravity, gameState.physics.crewStates, gameState.ship.crew);

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

  // Cache all HUD/resource/solar DOM refs for per-frame access
  initHudCache();

  // Update HUD
  updateHud(gameState);
  updateResourcePanel(gameState);
  updateSpeedUI(gameState.speed);

  // Start game loop
  if (gameLoop) gameLoop.stop();
  // Track conditions we've already alerted on
  const alertedConditions = new Set();

  gameLoop = new GameLoop(gameState, (state) => {
    // FPS measurement
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLastSample >= 1000) {
      const fps = Math.round(_fpsFrames * 1000 / (now - _fpsLastSample));
      _fpsFrames = 0;
      _fpsLastSample = now;
      const fpsEl = document.getElementById('hud-fps');
      if (fpsEl && fpsEnabled) fpsEl.textContent = `${fps} FPS`;
    }

    updateHud(state);
    updateResourcePanel(state);

    // Throttle heavier work to every 15 ticks (~4 Hz at 60fps)
    _fpsTickCounter++;
    const slowTick = _fpsTickCounter % 15 === 0;

    if (slowTick) {
      updateAtmosphereIndicators(state);
      // Refresh crew panel so vitals/conditions update live
      if (selectedCrew) selectCrew(selectedCrew);
      // Update tile panel dynamic values (atmo, status) without re-rendering
      if (selectedTile) updateTilePanel();
    }

    // Check for critical/death events (every 15 ticks)
    if (slowTick) {
      state.ship.crew.forEach(member => {
        const deathKey = `dead-${member.id}`;
        const critKey = `critical-${member.id}`;
        const brainKey = `brain-damage-${member.id}`;

        if (member.dead && !alertedConditions.has(deathKey)) {
          alertedConditions.add(deathKey);
          showToast(`${member.name} has died`, 'danger');
          addLogEntry(`${member.name} (${member.role}) — DECEASED`, 'danger');
        } else if (member.conditions.includes('critical') && !alertedConditions.has(critKey)) {
          alertedConditions.add(critKey);
          showToast(`${member.name} is in critical condition!`, 'danger');
          addLogEntry(`${member.name} (${member.role}) — cardiac arrest, critical condition`, 'danger');
        }

        if (member.conditions.includes('brain-damage') && !alertedConditions.has(brainKey)) {
          alertedConditions.add(brainKey);
          showToast(`${member.name} has suffered brain damage`, 'danger');
          addLogEntry(`${member.name} (${member.role}) — severe head trauma, brain damage`, 'danger');
        }
      });
    }

    // Route execution now handled in _processMinute via onPhysicsEvent("routeEvents")

    // Jobs system tick — run every 60 ticks (~1 Hz)
    if (_fpsTickCounter % 60 === 0) {
      const devMode = document.body.classList.contains('dev-mode');
      const jobLogs = generateAutoJobs(state.ship, state.physics, devMode, state.lsEquipment, state);
      if (devMode) {
        jobLogs.forEach(log => addLogEntry(log, 'debug'));
      }
    }

    // Secure-for-burn & crew dispatch — every 15 ticks
    if (slowTick) {
      const routePhase = getRouteProgress()?.currentPhase?.type;
      const routeHoldingCrew = routePhase === 'secure' || routePhase === 'burn' || routePhase === 'orient' || routePhase === 'flip';
      const gForce = state.physics.gForce || 0;
      if (gForce >= 1.5) {
        state.ship.crew.forEach(member => {
          if (member.dead || member.consciousness <= 10) return;
          const mission = getCrewMission(member.id);
          if (!mission || mission === 'patrol') {
            assignSecureBurnMission(state.ship, member);
          }
        });
      } else if (!routeHoldingCrew && !state.combatStations) {
        // Release crew from couches — but NOT during combat stations
        state.ship.crew.forEach(member => {
          if (getCrewMission(member.id) === 'secure-burn') {
            releaseSecureBurn(member.id);
            cancelMission(member.id, state.ship);
          }
        });
      }

      // Dispatch and complete LS repair missions
      state.ship.crew.forEach(member => {
        if (member.dead || member.consciousness <= 10) return;
        const mission = getCrewMission(member.id);

        if (!mission) {
          const jobs = getCrewJobs(member.id);
          const lsJob = jobs.find(j => j.type === JobType.REPAIR_LS);
          if (lsJob && lsJob.target) {
            assignRepairLSMission(state.ship, member, lsJob.target.deckIdx, lsJob.target.x, lsJob.target.y);
          }
        }

        if (mission === 'repair-ls' && isRepairComplete(member.id)) {
          const jobs = getCrewJobs(member.id);
          const lsJob = jobs.find(j => j.type === JobType.REPAIR_LS);
          if (lsJob) {
            const deckName = state.ship.decks[lsJob.target.deckIdx]?.name || 'Unknown';
            const repairResult = quickPatchLS(state, lsJob.target.deckIdx, member.skills.engineering);
            completeJob(lsJob.id);
            cancelMission(member.id);
            if (repairResult.success) {
              const verb = repairResult.repairType === 'full' ? 'repaired' : 'patched';
              showToast(`${member.name} ${verb} ${deckName} LS`, 'ok');
              addLogEntry(`${member.name} ${verb} life support on ${deckName} — ${repairResult.message}`, 'ok');
            } else {
              showToast(`${member.name}: repair failed`, 'warn');
              addLogEntry(`${member.name} failed to repair ${deckName} life support — will retry`, 'warn');
            }
          }
        }
      });

      // Dispatch and complete EVA suit missions
      state.ship.crew.forEach(member => {
        if (member.dead || member.consciousness <= 10) return;
        const mission = getCrewMission(member.id);

        if (!mission) {
          const jobs = getCrewJobs(member.id);
          const evaJob = jobs.find(j => j.type === JobType.EQUIP_EVA);
          if (evaJob && evaJob.target) {
            assignEquipSuitMission(state.ship, member, evaJob.target.x, evaJob.target.y, evaJob.target.deckIdx);
          }
        }

        if (mission === 'equip-suit' && isSuitDonned(member.id)) {
          const jobs = getCrewJobs(member.id);
          const evaJob = jobs.find(j => j.type === JobType.EQUIP_EVA);
          if (evaJob) {
            const locker = state.suitLockers?.find(l =>
              l.deckIdx === evaJob.target.deckIdx && l.x === evaJob.target.x && l.y === evaJob.target.y
            );
            if (locker) {
              donEvaSuit(state, member, locker);
              showToast(`${member.name} donned EVA suit`, 'ok');
              addLogEntry(`${member.name} donned EVA suit on ${state.ship.decks[member.deck]?.name || 'unknown deck'}`, 'ok');
            }
            completeJob(evaJob.id);
          }
          cancelMission(member.id);
        }
      });

      // Remove EVA suits when atmosphere is safe again
      state.ship.crew.forEach(member => {
        if (member.dead) return;
        if (!member.evaSuit || !member.evaSuit.wearing) return;
        const deck = state.ship.decks[member.deck];
        if (!deck || !deck.atmosphere) return;
        const atmoStatus = getAtmoStatus(deck.atmosphere);
        if (atmoStatus === 'nominal') {
          removeEvaSuit(state, member);
          addLogEntry(`${member.name} removed EVA suit — atmosphere safe`, 'crew');
        }
      });

      updateJobsCount();
      updateMissionsCount();
      updateFormationIndicator();
      const jobsDlg = document.getElementById('dialog-jobs');
      if (jobsDlg && jobsDlg.style.display !== 'none') renderJobsDialog();
      // Don't re-render missions dialog on every tick — it destroys hover state.
      // Only update the timer values in-place.
      updateMissionTimers();
    }
  }, async (event, data) => {
    if (event === 'reactorEvents') {
      data.forEach(evt => {
        if (evt.type === 'supercritical') {
          showToast('REACTOR SUPERCRITICAL \u2014 CATASTROPHIC FAILURE', 'danger');
          addLogEntry('Fusion reactor went supercritical. Ship destroyed.', 'danger');
          // TODO: game over screen
          if (gameLoop) gameLoop.stop();
        } else if (evt.type === 'reactor-offline') {
          showToast('Reactor offline \u2014 emergency power', 'danger');
          addLogEntry('Fusion reactor offline. Emergency power active.', 'danger');
          document.body.classList.add('reactor-offline');
        } else if (evt.type === 'reactor-online') {
          showToast('Reactor online', 'ok');
          addLogEntry('Fusion reactor online. All systems nominal.', 'ok');
          document.body.classList.remove('reactor-offline');
          document.body.classList.remove('ship-blackout');
        } else if (evt.type === 'shutdown-countdown-started') {
          showToast('Reactor shutdown \u2014 1h countdown', 'warn');
          addLogEntry('Reactor shutdown sequence complete. 1 hour to offline.', 'warn');
        } else if (evt.type === 'shutdown-aborted') {
          showToast('Reactor shutdown aborted', 'danger');
          addLogEntry(`Reactor shutdown aborted: ${evt.reason}`, 'danger');
        } else if (evt.type === 'startup-aborted') {
          showToast('Reactor startup aborted', 'danger');
          addLogEntry(`Reactor startup aborted: ${evt.reason}`, 'danger');
        } else if (evt.type === 'emergency-shutoff-complete') {
          showToast('FUEL DUMPED \u2014 Reactor offline', 'danger');
          addLogEntry(`Emergency shutoff complete. Fuel dumped to ${evt.fuelRemaining} units.`, 'danger');
          document.body.classList.add('reactor-offline');
        } else if (evt.type === 'blackout') {
          showToast('TOTAL BLACKOUT \u2014 All systems down', 'danger');
          addLogEntry('Emergency power exhausted. Life support, navigation, and all systems offline.', 'danger');
          document.body.classList.add('ship-blackout');
        } else if (evt.type === 'blackout-end') {
          document.body.classList.remove('ship-blackout');
        }
      });
      return;
    }
    if (event === 'autosave') {
      try {
        gameState._activeRoute = serializeRoute();
        gameState._crewMovement = serializeCrewMovement();
        gameState._missions = serializeMissions();
        await saveGame(gameState, 'Autosave');
        delete gameState._activeRoute;
        delete gameState._crewMovement;
        delete gameState._missions;
      } catch (e) {
        addLogEntry('Autosave failed', 'warn');
      }
      return;
    }
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
    } else if (event === 'routeEvents') {
      const state = gameState;
      data.forEach(evt => {
        if (evt.event === 'phase-start') {
          const p = evt.phase;
          switch (p.type) {
            case 'orient': {
              addLogEntry(`Helm: plotting course for ${getActiveRoute()?.destinationName}`, 'nav');
              addLogEntry('All hands — secure for acceleration. Crash couches.', 'nav');
              showToast('SECURE FOR BURN', 'warn');
              // Send entire crew to crash couches immediately
              state.ship.crew.forEach(member => {
                if (member.dead || member.consciousness <= 10) return;
                const mission = getCrewMission(member.id);
                if (!mission || mission === 'patrol') {
                  assignSecureBurnMission(state.ship, member);
                }
              });
              const pilot = state.ship.crew.find(c => c.role === 'Pilot' && !c.dead);
              if (pilot) {
                addLogEntry(`${pilot.name} to helm`, 'nav');
              }
              // RCS waits for pilot at helm, then all crew secured (or player override)
              _orientState = 'waiting-pilot';
              showManeuverPrompt();
              break;
            }
            case 'secure':
              // Crew already moving to couches from orient — catch any stragglers
              state.ship.crew.forEach(member => {
                if (member.dead || member.consciousness <= 10) return;
                const mission = getCrewMission(member.id);
                if (!mission || mission === 'patrol') {
                  assignSecureBurnMission(state.ship, member);
                }
              });
              break;
            case 'burn': {
              addLogEntry(p.description, 'thrust');
              showToast(`BURN: ${(p.thrustG || 0).toFixed(1)}G`, 'thrust');
              // Inertia: route burn start (not surprise — alarms were blaring)
              const burnG = p.thrustG || 0;
              if (burnG > 0) {
                handleInertiaEvent(ManeuverType.BURN_START, { deltaG: burnG, surprise: false });
              }
              break;
            }
            case 'coast':
              addLogEntry('Main engine cut. Coast phase — all hands free to move.', 'nav');
              if (!state.combatStations) {
                showToast('COAST — crew released', 'ok');
                state.ship.crew.forEach(member => {
                  if (getCrewMission(member.id) === 'secure-burn') {
                    releaseSecureBurn(member.id);
                    cancelMission(member.id, state.ship);
                  }
                });
              } else {
                showToast('COAST — crew remain at battle stations', 'warn');
              }
              break;
            case 'flip':
              addLogEntry('Executing flip maneuver', 'nav');
              showToast('FLIP', 'warn');
              // Trigger inertia for route-driven flip
              handleInertiaEvent(ManeuverType.FLIP, { deltaG: 0 });
              break;
            case 'arrive':
              break;
          }
        } else if (evt.event === 'secure-blocking') {
          // Secure phase expired but crew not all seated — show blocking prompt
          showSecureBlockingPrompt();
        } else if (evt.event === 'phase-end') {
          if (evt.phase.type === 'orient') {
            _orientState = null;
            hideManeuverPrompt();
            showRcsThrusters(false);
          }
          if (evt.phase.type === 'burn') {
            // Inertia: burn stop (not surprise — expected transition)
            const burnG = evt.phase.thrustG || 0;
            if (burnG > 0) {
              handleInertiaEvent(ManeuverType.BURN_STOP, { deltaG: burnG, surprise: false });
            }
          }
          if (evt.phase.type === 'flip') {
            addLogEntry(`Flip complete — heading ${state.physics.heading === 0 ? 'PROGRADE' : 'RETROGRADE'}`, 'nav');
          }
        } else if (evt.event === 'complete') {
          addLogEntry(`Arrived at ${evt.route.destinationName}. Engines offline.`, 'nav');
          showToast(`ARRIVED: ${evt.route.destinationName}`, 'ok');
          const maxBurnG = Math.max(...(evt.route.phases || [])
            .filter(p => p.type === 'burn')
            .map(p => p.thrustG || 0), 0);
          state.ship.crew.forEach(member => {
            if (getCrewMission(member.id) === 'secure-burn' && !state.combatStations) {
              releaseSecureBurn(member.id);
              cancelMission(member.id, state.ship);
            }
            // Juice hangover for crew that were juiced during the burn
            if (!member.dead && member._juiceActive) {
              member._juiceActive = false;
              const hangoverMin = Math.round(4320 * Math.min(maxBurnG / 5, 1));
              member.juiceHangover = Math.max(member.juiceHangover || 0, hangoverMin);
              if (!member.conditions.includes('juice-hangover')) {
                member.conditions.push('juice-hangover');
              }
              const days = (hangoverMin / 1440).toFixed(1);
              addLogEntry(`${member.name}: juice hangover — ~${days}d recovery`, 'medical');
            }
          });
        }
      });
    } else if (event === 'missionEvents') {
      data.forEach(evt => {
        if (evt.type === 'event-spawned') {
          openEventModal(evt);
        } else if (evt.type === 'chatter') {
          addLogEntry(`[${evt.from}] ${evt.text}`, 'warn');
        } else if (evt.type === 'mission-failed') {
          const reason = evt.reason || 'did not reach in time';
          showToast(`Mission failed: ${evt.title}`, 'danger');
          addLogEntry(`Mission failed: ${evt.title} — ${reason}`, 'danger');
        }
      });
      updateMissionsCount();
    } else if (event === 'interceptEvents') {
      data.forEach(evt => {
        if (evt.type === 'formation-entered') {
          showRcsThrusters(false); // fine approach complete — kill RCS visuals
          showToast(`Formation with ${evt.targetName}`, 'ok');
          addLogEntry(`Formation achieved with ${evt.targetName}`, 'nav');
        } else if (evt.type === 'formation-lost') {
          showToast(`Formation lost with ${evt.targetName}`, 'warn');
          addLogEntry(`Formation lost with ${evt.targetName}`, 'nav');
        } else if (evt.type === 'intercept-lost') {
          showToast('Intercept target lost', 'danger');
          addLogEntry('Intercept target lost from sensors', 'danger');
        } else if (evt.type === 'fine-approach-start') {
          showRcsThrusters('orient');
          showToast(`RCS FINE APPROACH — ${evt.targetName}`, 'nav');
          addLogEntry(`RCS fine approach: closing on ${evt.targetName} at ${evt.distKm?.toFixed(0) || '?'} km`, 'nav');
        } else if (evt.type === 'intercept-range-reached') {
          const typeLabel = { scanner: 'SCANNER RANGE', close: 'CLOSE APPROACH', tactical: 'TACTICAL RANGE' };
          const label = typeLabel[evt.interceptType] || 'TARGET RANGE';
          showToast(`${evt.targetName} — ${label} REACHED`, 'ok');
          addLogEntry(`Intercept complete: ${evt.targetName} within ${label.toLowerCase()}`, 'nav');
          renderScannerTab();
        }
      });
      updateFormationIndicator();
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
    // Attach active route to save data
    gameState._activeRoute = serializeRoute();
    gameState._crewMovement = serializeCrewMovement();
    gameState._missions = serializeMissions();
    await saveGame(gameState, name);
    delete gameState._activeRoute;
    delete gameState._crewMovement;
    delete gameState._missions;
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
    if (crewMoveFrame) { cancelAnimationFrame(crewMoveFrame); crewMoveFrame = null; }
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
    // Sync toggle states
    const devOn = document.body.classList.contains('dev-mode');
    const ingameDev = document.getElementById('ingame-devmode');
    if (ingameDev) {
      ingameDev.classList.toggle('active', devOn);
      ingameDev.textContent = devOn ? 'ON' : 'OFF';
    }
    const ingameFps = document.getElementById('ingame-fps');
    if (ingameFps) {
      ingameFps.classList.toggle('active', fpsEnabled);
      ingameFps.textContent = fpsEnabled ? 'ON' : 'OFF';
    }
    document.getElementById('dialog-settings').style.display = '';
  });

  // Close in-game settings
  document.querySelector('[data-action="close-settings"]').addEventListener('click', () => {
    document.getElementById('dialog-settings').style.display = 'none';
  });

  // Jobs queue
  document.querySelector('[data-action="open-jobs"]').addEventListener('click', () => {
    renderJobsDialog();
    document.getElementById('dialog-jobs').style.display = '';
  });

  document.querySelector('[data-action="close-jobs"]').addEventListener('click', () => {
    document.getElementById('dialog-jobs').style.display = 'none';
  });

  // Hail dialog
  document.querySelector('[data-action="close-hail"]').addEventListener('click', () => {
    document.getElementById('dialog-hail').style.display = 'none';
  });

  // SOS Event modal — Accept
  document.querySelector('[data-action="accept-event"]').addEventListener('click', () => {
    const missionId = document.getElementById('event-mission-id').value;
    if (!missionId) return;
    acceptMission(missionId);
    document.getElementById('dialog-event').style.display = 'none';

    // Auto-start tactical intercept for the mission's entity (need formation proximity)
    // Cancel any existing route/intercept first
    const missions = getMissionLog();
    const mission = missions.find(m => m.id === missionId);
    if (mission && gameState) {
      const existingIntercept = getInterceptState();
      if (existingIntercept) cancelIntercept();
      cancelRoute(gameState);

      const route = computeInterceptRoute(gameState, mission.targetEntityId, { targetRangeAU: INTERCEPT_RANGE_AU[INTERCEPT_TYPE.TACTICAL] });
      if (route) {
        startIntercept(gameState, mission.targetEntityId, missionId, INTERCEPT_TYPE.TACTICAL);
        activateRoute(gameState, route);
        showToast('Rescue intercept plotted', 'warn');
        addLogEntry(`Rescue intercept plotted — ETA ${route.totalTimeMin} min`, 'nav');
      }
    }
  });

  // SOS Event modal — Decline
  document.querySelector('[data-action="decline-event"]').addEventListener('click', () => {
    const missionId = document.getElementById('event-mission-id').value;
    if (missionId) declineMission(missionId);
    document.getElementById('dialog-event').style.display = 'none';
    addLogEntry('Distress signal logged — continuing course', 'system');
  });

  // Mission log
  document.querySelector('[data-action="open-missions"]').addEventListener('click', () => {
    renderMissionsDialog();
    document.getElementById('dialog-missions').style.display = '';
  });
  document.querySelector('[data-action="close-missions"]').addEventListener('click', () => {
    document.getElementById('dialog-missions').style.display = 'none';
  });

  // Formation hail button (complete rescue)
  const formationHailBtn = document.getElementById('formation-hail-btn');
  if (formationHailBtn) {
    formationHailBtn.addEventListener('click', () => {
      const intercept = getInterceptState();
      if (!intercept || !intercept.formation || !intercept.missionId) return;
      const result = completeMissionViaHail(intercept.missionId, gameState);
      if (result.success) {
        // Show rescue narrative in hail dialog
        const entity = gameState.entities?.find(e => e.id === intercept.targetEntityId);
        const dialog = document.getElementById('dialog-hail');
        document.getElementById('hail-target-name').textContent = entity?.name || 'Rescued vessel';
        document.getElementById('hail-target-faction').textContent = '';
        document.getElementById('hail-narrative').textContent = result.narrative;
        document.getElementById('hail-signal-strength').textContent = '■■■■■';
        dialog.style.display = 'flex';

        // Show rewards
        const rewardParts = Object.entries(result.rewards).map(([k, v]) => `+${v} ${k}`);
        showToast(`Rescue complete! ${rewardParts.join(', ')}`, 'ok');
        addLogEntry(`Rescue complete — ${rewardParts.join(', ')}`, 'ok');

        // Hide formation indicator
        const formInd = document.getElementById('formation-indicator');
        if (formInd) formInd.style.display = 'none';
      } else {
        showToast(result.narrative, 'danger');
      }
    });
  }

  // In-game FPS toggle
  const ingameFpsBtn = document.getElementById('ingame-fps');
  if (ingameFpsBtn) {
    ingameFpsBtn.addEventListener('click', () => {
      const isActive = ingameFpsBtn.classList.toggle('active');
      ingameFpsBtn.textContent = isActive ? 'ON' : 'OFF';
      setFpsEnabled(isActive);
      // Sync with main settings toggle
      const mainBtn = document.getElementById('setting-fps');
      if (mainBtn) {
        mainBtn.classList.toggle('active', isActive);
        mainBtn.textContent = isActive ? 'ON' : 'OFF';
      }
      import('./storage.js').then(s => s.saveSetting('showFps', isActive));
    });
  }

  // In-game dev mode toggle
  const ingameDevBtn = document.getElementById('ingame-devmode');
  if (ingameDevBtn) {
    ingameDevBtn.addEventListener('click', () => {
      const isActive = ingameDevBtn.classList.toggle('active');
      ingameDevBtn.textContent = isActive ? 'ON' : 'OFF';
      document.body.classList.toggle('dev-mode', isActive);
      // Sync with main settings toggle
      const mainBtn = document.getElementById('setting-devmode');
      if (mainBtn) {
        mainBtn.classList.toggle('active', isActive);
        mainBtn.textContent = isActive ? 'ON' : 'OFF';
      }
    });
  }

  // In-game tooltips toggle
  const ingameTooltipsBtn = document.getElementById('ingame-tooltips');
  if (ingameTooltipsBtn) {
    ingameTooltipsBtn.addEventListener('click', () => {
      const isActive = ingameTooltipsBtn.classList.toggle('active');
      ingameTooltipsBtn.textContent = isActive ? 'ON' : 'OFF';
    });
  }
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

  // FPS toggle
  const fpsToggle = document.getElementById('setting-fps');
  if (fpsToggle) {
    fpsToggle.addEventListener('click', () => {
      const isActive = fpsToggle.classList.toggle('active');
      fpsToggle.textContent = isActive ? 'ON' : 'OFF';
      setFpsEnabled(isActive);
      import('./storage.js').then(s => s.saveSetting('showFps', isActive));
    });
  }

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

function setFpsEnabled(on) {
  fpsEnabled = on;
  const el = document.getElementById('hud-fps');
  if (el) el.style.display = on ? '' : 'none';
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
  const showFps = await loadSetting('showFps', false);
  if (showFps) {
    setFpsEnabled(true);
    ['setting-fps', 'ingame-fps'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.classList.add('active'); btn.textContent = 'ON'; }
    });
  }
}

// ---- HAIL MODAL ----

function openHailModal(entityId) {
  if (!gameState || !gameState.entities) return;
  const entity = gameState.entities.find(e => e.id === entityId);
  if (!entity) return;

  // Check if this is a rescue target and we're in formation
  const intercept = getInterceptState();
  const mission = getMissionForEntity(entityId);
  if (mission && intercept && intercept.formation && intercept.targetEntityId === entityId) {
    // Complete rescue via hail
    const result = completeMissionViaHail(mission.id, gameState);
    if (result.success) {
      const dialog = document.getElementById('dialog-hail');
      document.getElementById('hail-target-name').textContent = entity.name;
      document.getElementById('hail-target-faction').textContent = '';
      document.getElementById('hail-narrative').textContent = result.narrative;
      document.getElementById('hail-signal-strength').textContent = '■■■■■';
      const factionEl = document.getElementById('hail-target-faction');
      factionEl.className = 'hail-faction';
      dialog.style.display = 'flex';

      const rewardParts = Object.entries(result.rewards).map(([k, v]) => `+${v} ${k}`);
      showToast(`Rescue complete! ${rewardParts.join(', ')}`, 'ok');
      addLogEntry(`Rescue of ${entity.name} complete — ${rewardParts.join(', ')}`, 'ok');
      updateFormationIndicator();
      updateMissionsCount();
      return;
    }
  }

  const dialog = document.getElementById('dialog-hail');
  const nameEl = document.getElementById('hail-target-name');
  const factionEl = document.getElementById('hail-target-faction');
  const narrativeEl = document.getElementById('hail-narrative');
  const signalEl = document.getElementById('hail-signal-strength');

  nameEl.textContent = entity.name;
  factionEl.textContent = entity.faction !== 'independent' ? entity.faction : '';

  // Faction color class
  factionEl.className = 'hail-faction';
  if (entity.faction === 'MCRN') factionEl.classList.add('hail-faction-mcrn');
  else if (entity.faction === 'UNN') factionEl.classList.add('hail-faction-unn');
  else if (entity.faction === 'OPA') factionEl.classList.add('hail-faction-opa');
  else if (entity.faction === 'Belter') factionEl.classList.add('hail-faction-belter');

  // Get narrative dialogue
  const narrative = getHailDialogue(entity);
  narrativeEl.textContent = narrative;

  // Signal strength based on distance
  const contact = (gameState.comms?.radioContacts || []).find(c => c.entityId === entityId);
  const dist = contact ? contact.distance : 1;
  const bars = Math.max(1, Math.min(5, Math.round((1 - dist / 0.1) * 5)));
  signalEl.textContent = '■'.repeat(bars) + '□'.repeat(5 - bars);

  dialog.style.display = 'flex';
  addLogEntry(`Hailed ${entity.name} on direct channel`, 'system');
}

// ---- START GAME FROM NEW GAME SCREEN ----

function initStartGame() {
  document.querySelector('[data-action="start-game"]').addEventListener('click', () => {
    const shipName = document.getElementById('input-ship-name').value.trim() || 'RSV Canterbury';
    const captainName = document.getElementById('input-captain-name').value.trim() || 'J. Holden';
    resetRoute(); // Clear any active route from previous game
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

// ---- JOBS DIALOG ----

const PRIORITY_LABELS = ['CRIT', 'HIGH', 'NORM', 'LOW'];
const PRIORITY_CLASSES = ['critical', 'high', 'normal', 'low'];

function renderJobsDialog() {
  const container = document.getElementById('jobs-list');
  const jobs = getJobQueue();
  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'assigned');

  if (activeJobs.length === 0) {
    container.innerHTML = '<p class="jobs-empty">— No active jobs —</p>';
    const summary = document.getElementById('jobs-summary');
    if (summary) summary.innerHTML = '';
    return;
  }

  const crewMap = {};
  if (gameState && gameState.ship) {
    gameState.ship.crew.forEach(m => { crewMap[m.id] = m.name; });
  }

  const header = `<div class="jobs-header">
    <span class="jobs-col-priority">PRI</span>
    <span class="jobs-col-type">Type</span>
    <span class="jobs-col-status">Status</span>
    <span class="jobs-col-assignee">Assignee</span>
  </div>`;

  const rows = activeJobs.map(job => {
    const pIdx = Math.min(job.priority, 3);
    const assignee = job.assigneeId
      ? (crewMap[job.assigneeId] || `#${job.assigneeId}`)
      : '';
    const assigneeClass = job.assigneeId ? '' : ' job-assignee-none';
    const target = job.targetCrewId ? (crewMap[job.targetCrewId] || '') : '';
    const targetHtml = target ? ` <span class="job-type-target">→ ${escapeHtml(target)}</span>` : '';

    return `<div class="job-row">
      <span class="job-priority job-priority-${PRIORITY_CLASSES[pIdx]}">${PRIORITY_LABELS[pIdx]}</span>
      <span class="job-type">${escapeHtml(job.type)}${targetHtml}</span>
      <span class="job-status job-status-${job.status}">${job.status}</span>
      <span class="job-assignee${assigneeClass}">${assignee ? escapeHtml(assignee) : '—'}</span>
    </div>`;
  }).join('');

  container.innerHTML = header + rows;

  // Summary counts
  const pending = activeJobs.filter(j => j.status === 'pending').length;
  const assigned = activeJobs.filter(j => j.status === 'assigned').length;
  const summary = document.getElementById('jobs-summary');
  if (summary) {
    summary.innerHTML =
      `<span class="jobs-summary-pending">${pending} pending</span>` +
      `<span class="jobs-summary-assigned">${assigned} assigned</span>`;
  }
}

function updateJobsCount() {
  const jobs = getJobQueue();
  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'assigned');
  const count = activeJobs.length;
  const hasCritical = activeJobs.some(j => j.priority === 0);
  const el = document.getElementById('hud-jobs-count');
  if (el) {
    el.textContent = count;
    el.classList.toggle('has-jobs', count > 0 && !hasCritical);
    el.classList.toggle('has-critical', hasCritical);
  }
}

// ---- MISSIONS DIALOG ----

let expandedMissionId = null;

function renderMissionsDialog() {
  const container = document.getElementById('missions-list');
  const allMissions = getMissionLog();
  if (allMissions.length === 0) {
    container.innerHTML = '<p class="missions-empty">-- No missions --</p>';
    return;
  }

  const statusOrder = { offered: 0, accepted: 1, in_progress: 2, completed: 3, failed: 4, declined: 5 };
  const sorted = [...allMissions].sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));

  container.innerHTML = sorted.map(m => {
    const timerText = getMissionTimerText(m);
    const timerClass = getMissionTimerClass(m);
    const statusLabel = m.status.replace('_', ' ').toUpperCase();
    const isExpanded = expandedMissionId === m.id;
    const rewardsHtml = m.rewards ? Object.entries(m.rewards).map(([k, v]) => `<span class="mission-reward-item">+${v} ${k}</span>`).join('') : '';

    return `<div class="mission-row ${isExpanded ? 'mission-row-expanded' : ''}" data-mission-id="${m.id}">
      <div class="mission-row-header">
        <div class="mission-status-dot status-${m.status}"></div>
        <div class="mission-info">
          <div class="mission-title">${escapeHtml(m.title)}</div>
          <div class="mission-meta">${statusLabel}</div>
        </div>
        <div class="mission-timer ${timerClass}" data-mission-timer="${m.id}">${timerText}</div>
        <div class="mission-expand-icon">${isExpanded ? '\u25B4' : '\u25BE'}</div>
      </div>
      ${isExpanded ? `<div class="mission-detail">
        <div class="mission-detail-narrative">${escapeHtml(m.description)}</div>
        <div class="mission-detail-meta">
          <div class="mission-detail-row"><span class="mission-detail-key">TYPE</span><span class="mission-detail-val">${escapeHtml(m.type.replace(/_/g, ' '))}</span></div>
          <div class="mission-detail-row"><span class="mission-detail-key">STATUS</span><span class="mission-detail-val">${statusLabel}</span></div>
          ${rewardsHtml ? `<div class="mission-detail-row"><span class="mission-detail-key">REWARDS</span><span class="mission-detail-val mission-rewards">${rewardsHtml}</span></div>` : ''}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  // Wire click handlers
  container.querySelectorAll('.mission-row-header').forEach(row => {
    row.addEventListener('click', () => {
      const missionId = row.closest('.mission-row').dataset.missionId;
      expandedMissionId = expandedMissionId === missionId ? null : missionId;
      renderMissionsDialog();
    });
  });
}

function getMissionTimerText(m) {
  if (m.status === 'completed') return 'COMPLETE';
  if (m.status === 'failed') return 'FAILED';
  if (m.status === 'declined') return 'DECLINED';
  const mins = m.urgencyTimerMin;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

function getMissionTimerClass(m) {
  if (m.status === 'completed' || m.status === 'failed' || m.status === 'declined') return 'timer-done';
  const fraction = m.urgencyTimerMin / m.urgencyTimerMax;
  return fraction < 0.2 ? 'timer-critical' : '';
}

function updateMissionTimers() {
  const missionsDlg = document.getElementById('dialog-missions');
  if (!missionsDlg || missionsDlg.style.display === 'none') return;
  const allMissions = getMissionLog();
  for (const m of allMissions) {
    const timerEl = missionsDlg.querySelector(`[data-mission-timer="${m.id}"]`);
    if (timerEl) {
      timerEl.textContent = getMissionTimerText(m);
      timerEl.className = `mission-timer ${getMissionTimerClass(m)}`;
    }
  }
}

function updateMissionsCount() {
  const active = getActiveMissions();
  const count = active.length;
  const hasSOS = active.some(m => m.status === 'offered');
  const el = document.getElementById('hud-missions-count');
  if (el) {
    el.textContent = count;
    el.classList.toggle('has-missions', count > 0 && !hasSOS);
    el.classList.toggle('has-sos', hasSOS);
  }
}

function openEventModal(eventData) {
  const dialog = document.getElementById('dialog-event');
  document.getElementById('event-mission-id').value = eventData.missionId;
  document.getElementById('event-ship-name').textContent = eventData.entityName;
  document.getElementById('event-ship-class').textContent = eventData.shipClass;
  document.getElementById('event-ship-faction').textContent = eventData.faction;
  document.getElementById('event-ship-dist').textContent = eventData.distance;
  document.getElementById('event-narrative').textContent = eventData.narrative;
  document.getElementById('event-urgency').textContent = eventData.urgencyLabel;

  // Feasibility check — can we actually reach them?
  const feasEl = document.getElementById('event-feasibility');
  const acceptBtn = document.getElementById('event-accept-btn');
  const declineBtn = document.getElementById('event-decline-btn');

  if (eventData.feasibility && !eventData.feasibility.feasible) {
    feasEl.textContent = eventData.feasibility.reason;
    feasEl.style.display = '';
    feasEl.className = 'event-feasibility infeasible';
    acceptBtn.textContent = 'INTERCEPT NOT FEASIBLE';
    acceptBtn.disabled = true;
    declineBtn.textContent = eventData.declineText;
  } else {
    feasEl.style.display = 'none';
    acceptBtn.textContent = eventData.acceptText;
    acceptBtn.disabled = false;
    declineBtn.textContent = eventData.declineText;
  }

  dialog.style.display = 'flex';
  // Pause game for dramatic effect
  if (gameLoop && gameState.speed > 0) {
    gameLoop.setSpeed(0);
    updateSpeedUI(0);
  }
}

function updateFormationIndicator() {
  const indicator = document.getElementById('formation-indicator');
  if (!indicator) return;
  const intercept = getInterceptState();
  if (intercept && intercept.formation) {
    indicator.style.display = 'flex';
    const entity = gameState?.entities?.find(e => e.id === intercept.targetEntityId);
    document.getElementById('formation-target').textContent = entity?.name || 'contact';
    // Only show hail button if there's an associated mission
    const hailBtn = document.getElementById('formation-hail-btn');
    if (hailBtn) {
      hailBtn.style.display = intercept.missionId ? '' : 'none';
    }
  } else {
    indicator.style.display = 'none';
  }
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
      case 'c':
      case 'C':
        document.getElementById('combat-toggle').click();
        break;
      case 'm':
      case 'M': {
        // Toggle solar system map
        if (tacModalOpen && tacModalTab === 'solar') {
          closeTacModal();
        } else {
          tacModalTab = 'solar';
          openTacModal();
        }
        break;
      }
      case 'j':
      case 'J': {
        // Toggle jobs dialog
        const jobsDlg = document.getElementById('dialog-jobs');
        if (jobsDlg.style.display !== 'none') {
          jobsDlg.style.display = 'none';
        } else {
          renderJobsDialog();
          jobsDlg.style.display = '';
        }
        break;
      }
      case 'l':
      case 'L': {
        // Toggle missions dialog
        const missionsDlg = document.getElementById('dialog-missions');
        if (missionsDlg.style.display !== 'none') {
          missionsDlg.style.display = 'none';
        } else {
          renderMissionsDialog();
          missionsDlg.style.display = '';
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        // Close any open dialog first
        const dialogs = ['dialog-event', 'dialog-missions', 'dialog-hail', 'dialog-save', 'dialog-exit', 'dialog-settings', 'dialog-jobs'];
        let closedDialog = false;
        for (const id of dialogs) {
          const dlg = document.getElementById(id);
          if (dlg && dlg.style.display !== 'none') {
            dlg.style.display = 'none';
            closedDialog = true;
          }
        }
        // If no dialog was open, deselect crew
        if (!closedDialog) {
          selectedCrew = null;
          document.querySelectorAll('.crew-symbol').forEach(el => el.classList.remove('selected'));
          const crewInfo = document.getElementById('crew-info');
          if (crewInfo) crewInfo.innerHTML = '<p class="info-line info-dim">Click a crew member</p>';
        }
        break;
      }
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
