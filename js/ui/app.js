// ============================================================
// LONGHAUL — Application shell
// Screens, game lifecycle, frame loop wiring.
// ============================================================

import { ui } from './context.js';
import { $, $$, esc, show, toggleClass, setText } from './dom.js';
import { toast } from './toast.js';
import { initLog, logEntry, renderLog, resetLogView } from './log.js';
import { initHud, updateHud, updatePerf, setResourceAlertHandler, resetResourceAlerts } from './hud.js';
import { buildShipView, updateShipView, setShipAnimationsPaused } from './ship-view.js';
import { initNav, updateNav, openNav, closeNav, toggleNav, openRoutePanel, resetNavForGame } from './nav.js';
import { resetTacCache } from './tac.js';
import { initSelection, selectCrew, selectTile, clearSelection, renderSelection, showDeckMenu } from './selection.js';
import { initDialogs, openDialog, closeDialog, closeTopDialog, openMissions, openJobs, openStation, hail } from './dialogs.js';
import { initPresenter, resourceAlert } from './presenter.js';
import { openSystems, openRoster } from './shipboard.js';
import { initSettings, renderSettings } from './settings.js';
import { saveCurrent, loadSave, latestSave, renderSaveList, scheduleAutosave, stopAutosave } from './persistence.js';
import { startParticles, stopParticles, updateParticleMotion } from './particles.js';
import { initKeyboard } from './keyboard.js';
import { initStorage } from '../storage.js';
import { VERSION } from '../version.js';
import { bus } from '../core/events.js';
import { createGame, GameLoop, advance } from '../sim/game.js';
import { maxSpeed, releaseHold } from '../sim/autopilot.js';
import { randomCaptainName, ROLES } from '../sim/crew.js';
import { dockedStation } from '../sim/contracts.js';
import { forceDistress } from '../sim/missions.js';
import { damageSystem, meteoroidStrike, SYSTEM_IDS } from '../sim/systems.js';
import { spawnTrafficShip } from '../sim/traffic.js';
import {
  iconNewGame, iconLoadGame, iconSettings, iconPause, iconHudSettings, iconHudSave, iconHudExit,
  iconMinus, iconPlus, logoShip, createStarfield,
} from '../svg-icons.js';

let crewCount = 4;
let storageOK = true;
let speedBeforePause = 1;
let fps = { frames: 0, at: 0, value: 0 };
let gameOver = false;

// ---- SCREENS ----

function showScreen(name) {
  for (const s of $$('.screen')) {
    if (s.classList.contains('active') && s.id !== `screen-${name}`) {
      s.classList.add('fade-out');
      s.classList.remove('active');
      setTimeout(() => s.classList.remove('fade-out'), 500);
    }
  }
  setTimeout(() => $(`#screen-${name}`)?.classList.add('active'), 120);
  ui.screen = name;
}

// ---- BOOT ----

export async function boot() {
  try { await initStorage(); } catch (e) { storageOK = false; console.warn('[storage] unavailable — saves disabled', e); }
  if (storageOK) await initSettings();

  $('#landing-logo').appendChild(logoShip());
  $('#icon-new-game').appendChild(iconNewGame());
  $('#icon-continue').appendChild(iconLoadGame());
  $('#icon-load-game').appendChild(iconLoadGame());
  $('#icon-settings-menu').appendChild(iconSettings());
  $('#icon-minus').appendChild(iconMinus());
  $('#icon-plus').appendChild(iconPlus());
  $('#icon-pause').appendChild(iconPause());
  $('#icon-hud-settings').appendChild(iconHudSettings());
  $('#icon-hud-save').appendChild(iconHudSave());
  $('#icon-hud-exit').appendChild(iconHudExit());
  $$('.landing-bg').forEach(bg => createStarfield(bg));
  setText($('.landing-version'), `v${VERSION}`);

  // Menu
  $$('.menu-btn').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.action;
    if (a === 'new-game') { updateCrewHint(); showScreen('new-game'); }
    if (a === 'load-game') { renderSaveList($('#save-list'), loadAndStart); showScreen('load-game'); }
    if (a === 'settings') { renderSettings($('#screen-settings [data-settings]')); showScreen('settings'); }
    if (a === 'continue') latestSave().then(s => s && loadAndStart(s.id));
  }));
  $$('[data-action="back"]').forEach(b => b.addEventListener('click', () => { refreshContinue(); showScreen('landing'); }));
  $('#crew-minus').addEventListener('click', () => { crewCount = Math.max(1, crewCount - 1); updateCrewHint(); });
  $('#crew-plus').addEventListener('click', () => { crewCount = Math.min(8, crewCount + 1); updateCrewHint(); });
  $('[data-action="start-game"]').addEventListener('click', newGame);
  refreshContinue();

  // In-game UI
  initHud(requestSpeed, toggleCombat, openSystems);
  initLog();
  setResourceAlertHandler(resourceAlert);
  initNav({ hail, openStation: () => openStation() });
  initSelection({ hail, openNav });
  initDialogs({ plotRoute: (t) => openRoutePanel(t), setPaused });
  initPresenter();
  initKeyboard({
    speed: requestSpeed, togglePause, nav: (tab) => toggleNav(tab), missions: openMissions, jobs: openJobs,
    systems: openSystems, roster: openRoster,
    station: () => dockedStation(ui.state) ? openStation() : toast('Not docked', 'warn'),
    combat: toggleCombat, escape: onEscape, save: () => quickSave(), devFlip, devCut,
  });
  $$('[data-action]').forEach(b => {
    const a = b.dataset.action;
    const fn = {
      'open-map': () => openNav('solar'), 'open-station': () => openStation(), 'open-missions': openMissions,
      'open-jobs': openJobs, 'open-systems': openSystems, 'open-roster': openRoster, 'game-settings': openSettingsDialog, 'save-game': openSaveDialog, 'exit-game': openExitDialog,
    }[a];
    if (fn) b.addEventListener('click', fn);
  });
  initDevHelm();
  ui.onGameOver = (why) => endGame(why);
  document.addEventListener('visibilitychange', () => { if (document.hidden && ui.state && storageOK) saveCurrent('Autosave', 'autosave').catch(() => {}); });
  window.addEventListener('beforeunload', () => { if (ui.state && storageOK && ui.screen === 'game') saveCurrent('Autosave', 'autosave'); });

  // Debug handle for tooling and automated tests
  window.__longhaul = {
    get state() { return ui.state; }, get loop() { return ui.loop; }, ui, bus,
    step: (n = 1) => advance(ui.state, n),
  };
  console.log(`[LONGHAUL] v${VERSION} ready`);
}

function updateCrewHint() {
  setText($('#crew-count'), crewCount);
  setText($('#crew-hint'), ROLES.slice(0, crewCount).join(' · '));
}

async function refreshContinue() {
  if (!storageOK) { show($('#menu-continue'), false); return; }
  const s = await latestSave().catch(() => null);
  show($('#menu-continue'), !!s);
}

// ---- GAME LIFECYCLE ----

function newGame() {
  const shipName = $('#input-ship-name').value.trim() || 'UNN Longhaul';
  const captainName = $('#input-captain-name').value.trim() || randomCaptainName();
  const state = createGame({ shipName, captainName, crewCount });
  startGame(state, true);
  logEntry(`Mission start — ${state.ship.name}, Captain ${captainName}`, 'system');
  logEntry(`Docked at Ceres Station. Crew of ${state.ship.crew.length}. Hail the station for contracts.`, 'nav');
  toast('Good luck, Captain.', 'ok');
}

async function loadAndStart(id) {
  try {
    const { state, migrated, notes } = await loadSave(id);
    startGame(state, false);
    toast(migrated ? 'Save migrated from an older version' : 'Mission loaded', 'ok');
    for (const n of notes) logEntry(n, 'system');
  } catch (e) {
    console.error(e);
    toast(`Could not load save: ${e.message}`, 'danger');
  }
}

function startGame(state, fresh) {
  ui.loop?.stop();
  pauseReasons.clear();
  gameOver = false;
  ui.state = state;
  ui.selection.crew = null; ui.selection.tile = null;
  resetNavForGame();
  resetTacCache();
  resetLogView();
  resetResourceAlerts();
  buildShipView($('#ship-container'), state, {
    crew: (id) => selectCrew(id),
    tile: (t, d, x, y) => selectTile(t, d, x, y),
    deckMenu: (d, x, y) => showDeckMenu(d, x, y),
  });
  $('#ship-container').onclick = () => clearSelection();
  clearSelection();
  if (fresh) state.speed = 1;
  ui.loop = new GameLoop(state, { onFrame: frame, onError: (e) => { console.error('[sim]', e); } });
  ui.loop.start();
  showScreen('game');
  startParticles();
  if (storageOK) scheduleAutosave();
  renderLog();
}

function endGame(why) {
  if (gameOver) return;
  gameOver = true;
  ui.loop?.setSpeed(0);
  openDialog({
    title: 'SHIP LOST', html: `<p class="dialog-text">${esc(why)}</p>`,
    buttons: [{ label: 'Main Menu', act: 'menu', cls: 'btn-secondary' }, ...(storageOK ? [{ label: 'Load Last Save', act: 'load', cls: 'btn-primary' }] : [])],
    onAction: async (act) => {
      closeDialog();
      if (act === 'menu') exitToMenu();
      if (act === 'load') { const s = await latestSave(); if (s) loadAndStart(s.id); else exitToMenu(); }
    },
  });
}

function exitToMenu() {
  ui.loop?.stop();
  ui.loop = null;
  ui.state = null;
  stopParticles();
  stopAutosave();
  closeNav();
  document.body.classList.remove('reactor-offline', 'ship-blackout', 'inertia-active');
  refreshContinue();
  showScreen('landing');
}

// ---- FRAME ----

function frame(state, alpha) {
  ui.alpha = alpha;
  updateHud(state);
  updateShipView(state, alpha);
  updateNav(state, alpha);
  renderSelection();
  renderLog();
  updateParticleMotion(state);

  const body = document.body;
  toggleClass(body, 'reactor-offline', state.reactor.status !== 'online' && !state.reactor.blackout);
  toggleClass(body, 'ship-blackout', state.reactor.blackout);
  toggleClass($('#ship-container'), 'ship-fast-forward', state.speed > 1);
  toggleClass($('#screen-game'), 'game-paused', state.speed === 0);
  toggleClass($('#ship-container'), 'combat-lit', state.combatStations);
  setShipAnimationsPaused(state.speed === 0);

  if (!gameOver && state.ship.crew.every(m => m.dead)) endGame('No survivors. The ship drifts on, silent.');

  fps.frames++;
  const now = performance.now();
  if (now - fps.at >= 1000) { fps.value = Math.round(fps.frames * 1000 / (now - fps.at)); fps.frames = 0; fps.at = now; }
  updatePerf(fps.value);
}

// ---- SPEED / PAUSE ----

function requestSpeed(n) {
  if (!ui.loop) return;
  const max = maxSpeed(ui.state);
  if (n > max) toast(max === 1 ? 'Time warp locked — maneuver in progress' : 'Time warp limited', 'warn');
  ui.loop.setSpeed(n);
}

function togglePause() {
  if (!ui.loop) return;
  if (ui.state.speed === 0) ui.loop.setSpeed(speedBeforePause || 1);
  else { speedBeforePause = ui.state.speed; ui.loop.setSpeed(0); }
}

// Pauses requested by UI (dialogs, distress calls) are tracked by reason so
// overlapping open/close sequences can never leave the game stuck paused.
const pauseReasons = new Set();
function setPaused(reason, on) {
  if (!ui.loop) return;
  if (on) {
    if (!pauseReasons.size) { speedBeforePause = ui.state.speed || speedBeforePause; ui.loop.setSpeed(0); }
    pauseReasons.add(reason);
  } else if (pauseReasons.delete(reason) && !pauseReasons.size) {
    ui.loop.setSpeed(speedBeforePause || 1);
  }
}

// ---- ACTIONS ----

function toggleCombat() {
  const s = ui.state;
  if (!s) return;
  s.combatStations = !s.combatStations;
  if (s.combatStations) { toast('BATTLE STATIONS', 'danger'); logEntry('BATTLE STATIONS — all hands to crash couches, juice standing by', 'danger'); }
  else { toast('Battle stations secured', 'ok'); logEntry('Battle stations secured', 'system'); }
}

function onEscape() {
  if (closeTopDialog()) return;
  if (ui.nav.open) { closeNav(); return; }
  document.getElementById('compartment-menu')?.remove();
  clearSelection();
}

async function quickSave() {
  if (!storageOK) { toast('Storage unavailable — cannot save', 'danger'); return; }
  try { await saveCurrent('Quicksave', 'quicksave'); toast('Quicksaved', 'ok'); logEntry('Quicksave', 'system'); }
  catch (e) { toast(`Save failed: ${e.message}`, 'danger'); }
}

function openSaveDialog() {
  if (!storageOK) { toast('Storage unavailable — cannot save', 'danger'); return; }
  openDialog({
    title: 'Save Mission', pause: true,
    html: `<div class="form-group"><label class="form-label" for="input-save-name">Save name</label><input type="text" id="input-save-name" class="form-input" placeholder="${esc(ui.state.ship.name)}" maxlength="32"></div>`,
    buttons: [{ label: 'Cancel', act: 'close' }, { label: 'Save', act: 'save', cls: 'btn-primary' }],
    onAction: async (act, b, body) => {
      if (act !== 'save') return;
      const name = body.querySelector('input').value.trim() || ui.state.ship.name;
      try { await saveCurrent(name); toast('Mission saved', 'ok'); logEntry(`Saved: "${name}"`, 'system'); closeDialog(); }
      catch (e) { toast(`Save failed: ${e.message}`, 'danger'); }
    },
  });
  setTimeout(() => {
    const input = $('#input-save-name');
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#dialog-generic-body [data-act="save"]').click(); });
  }, 0);
}

function openExitDialog() {
  openDialog({
    title: 'Exit to Menu', pause: true,
    html: `<p class="dialog-text">${storageOK ? 'Your progress is autosaved on exit.' : 'Storage is unavailable — progress will be lost.'}</p>`,
    buttons: [{ label: 'Cancel', act: 'close' }, { label: 'Exit', act: 'exit', cls: 'btn-primary' }],
    onAction: async (act) => {
      if (act !== 'exit') return;
      if (storageOK) await saveCurrent('Autosave', 'autosave').catch(() => {});
      closeDialog();
      exitToMenu();
    },
  });
}

function openSettingsDialog() {
  const body = openDialog({ title: 'Settings', cls: 'dialog-wide', pause: true, html: '<div class="settings-group" data-settings></div>' });
  renderSettings(body.querySelector('[data-settings]'));
}

// ---- DEV HELM ----

function initDevHelm() {
  const slider = $('#thrust-slider');
  slider.addEventListener('input', () => {
    const s = ui.state;
    if (!s) return;
    if (s.autopilot) { slider.value = 0; toast('Autopilot has the helm — abort the route first', 'warn'); return; }
    const g = slider.value / 10;
    if (g > 0 && s.flight.hold) releaseHold(s);
    s.flight.manual = { ...(s.flight.manual || {}), throttleG: g };
    setText($('#thrust-slider-value'), `${g.toFixed(1)}G`);
  });
  $('#dev-flip').addEventListener('click', devFlip);
  $('#dev-cut').addEventListener('click', devCut);
  const tools = [
    ['DISTRESS CALL', () => forceDistress(ui.state, (t, p) => bus.emit(t, p))],
    ['+10K MCR', () => { ui.state.resources.credits.current += 10_000; }],
    ['KILL FLT CMP', () => damageSystem(ui.state, 'flightComputer', { severity: 'major', cause: 'dev' }, (t, p) => bus.emit(t, p))],
    ['METEOROID', () => meteoroidStrike(ui.state, (t, p) => bus.emit(t, p))],
    ['WEAR ALL', () => { for (const id of SYSTEM_IDS) ui.state.systems.units[id].integrity = Math.max(0, ui.state.systems.units[id].integrity - 40); }],
    ['+10 SPARES', () => { const p = ui.state.resources.parts; p.current = Math.min(p.max, p.current + 10); }],
    ['REFUEL', () => { ui.state.resources.fuel.current = ui.state.resources.fuel.max; }],
    ['+1K TRAFFIC', () => { for (let i = 0; i < 1000; i++) spawnTrafficShip(ui.state); toast(`${ui.state.entities.length} entities`); }],
    ['+50K TRAFFIC', () => { for (let i = 0; i < 50_000; i++) spawnTrafficShip(ui.state); toast(`${ui.state.entities.length} entities`); }],
  ];
  const box = $('#dev-tools');
  for (const [label, fn] of tools) {
    const b = document.createElement('button');
    b.className = 'crew-action-btn';
    b.textContent = label;
    b.addEventListener('click', () => { if (ui.state) fn(); });
    box.appendChild(b);
  }
}

function devFlip() {
  const s = ui.state;
  if (!s || s.autopilot) return;
  if (s.flight.hold) releaseHold(s);
  s.flight.manual = { ...(s.flight.manual || {}), flipTo: s.flight.facing + Math.PI, throttleG: 0 };
  $('#thrust-slider').value = 0;
  setText($('#thrust-slider-value'), '0.0G');
  logEntry('Manual flip', 'nav');
}

function devCut() {
  const s = ui.state;
  if (!s) return;
  if (s.flight.manual) s.flight.manual.throttleG = 0;
  $('#thrust-slider').value = 0;
  setText($('#thrust-slider-value'), '0.0G');
}
