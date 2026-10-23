// ============================================================
// LONGHAUL — Application shell
// Screens, game lifecycle, frame loop wiring. The game screen is the
// ship's console (console.js: docks, panels, windows; nav.js: the main
// view's displays; stage.js: the exterior cameras).
// ============================================================

import { orderSuits } from '../sim/life-support.js';
import { ui } from './context.js';
import { $, $$, esc, show, toggleClass, setText } from './dom.js';
import { toast } from './toast.js';
import { initLog, logEntry, renderLog, resetLogView } from './log.js';
import { initHud, updateHud, updatePerf, setResourceAlertHandler, resetResourceAlerts, setHailHandler, setRouteHandler, setDockHandler } from './hud.js';
import { initNav, updateNav, openNav, closeNav, toggleNav, openRoutePanel, resetNavForGame, showOnBoard, setTab, currentTab, selectTarget, toggleFlagOnPick } from './nav.js';
import { resetTacCache } from './tac.js';
import { initConsole, closeTopWindow, setExteriorFloating, exteriorIsFloating, showPanel, toggleLog } from './console.js';
import { initTooltips, initPointers } from './tooltip.js';
import { initAiLine, updateAi, resetAiLine } from './ai-line.js';
import { initCams, buildCams, updateCams, setCamsVisible } from './cams.js';
import { requestDocking, requestDeparture } from '../sim/traffic-control.js';
import { overrideSecure, forceTurn } from '../sim/autopilot.js';
import { setPdcMode, setEvasive } from '../sim/combat.js';
import { toggleTransponder } from '../sim/comms.js';
import { orderShutdown } from '../sim/reactor.js';
import { acceptMission } from '../sim/missions.js';
import { initSelection, selectCrew, selectTile, clearSelection, renderSelection, showDeckMenu } from './selection.js';
import { initDialogs, openDialog, closeDialog, closeTopDialog, openMissions, openJobs, openStation, answerRequestById } from './dialogs.js';
import { initPresenter, resourceAlert } from './presenter.js';
import { openSystems, openRoster } from './shipboard.js';
import { initSettings, renderSettings } from './settings.js';
import { saveCurrent, loadSave, latestSave, renderSaveList, scheduleAutosave, stopAutosave } from './persistence.js';
import { initKeyboard } from './keyboard.js';
import { initLibrary, toggleLibrary, closeLibrary, openLibrary } from './library.js';
import { initStage, updateStage, resetStage, lookAt, toggleScope } from './stage.js';
import { initComms, openComms, closeComms, updateComms, commsOpen } from './comms.js';
import { initBoarding, openBoarding, closeBoarding, updateBoarding } from './boarding.js';
import { initService, openService } from './service.js';
import { setPhase } from '../sim/politics.js';
import { addRep } from '../sim/service.js';
import { clearTicker } from './ticker.js';
import { beginDocking } from '../sim/docking.js';
import { keepOutM } from '../sim/traffic-control.js';
import { getWorld } from '../sim/world.js';
import { AU_M } from '../core/constants.js';
import { initStorage } from '../storage.js';
import { VERSION } from '../version.js';
import { bus } from '../core/events.js';
import { createGame, GameLoop, advance } from '../sim/game.js';
import { maxSpeed, releaseHold } from '../sim/autopilot.js';
import { randomCaptainName, ROLES } from '../sim/crew.js';
import { dockedStation } from '../sim/contracts.js';
import { forceDistress } from '../sim/missions.js';
import { damageSystem, meteoroidStrike, shipSystems } from '../sim/systems.js';
import { spawnTrafficShip } from '../sim/traffic.js';
import { spawnEncounter } from '../sim/conflict.js';
import { controlAt, factionColor, FACTIONS } from '../sim/factions.js';
import { initFx, resetFx } from './fx.js';
import { renderShipPicker, crewRange, shipAllowed } from './ship-picker.js';
import { CLASSES, TECH, PLAYER_CLASS, maxCrew } from '../sim/ship-classes.js';
import {
  iconNewGame, iconLoadGame, iconSettings, iconPause, iconHudSettings, iconHudSave, iconHudExit,
  iconMinus, iconPlus, logoShip, createStarfield,
} from '../svg-icons.js';

let crewCount = 4;
let shipClass = PLAYER_CLASS;
let license = null;
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
    if (a === 'new-game') { renderLicenses(); openShipPicker(); updateCrewHint(); showScreen('new-game'); }
    if (a === 'load-game') { renderSaveList($('#save-list'), loadAndStart); showScreen('load-game'); }
    if (a === 'settings') { renderSettings($('#screen-settings [data-settings]')); showScreen('settings'); }
    if (a === 'continue') latestSave().then(s => s && loadAndStart(s.id));
  }));
  $$('[data-action="back"]').forEach(b => b.addEventListener('click', () => { refreshContinue(); showScreen('landing'); }));
  $('#crew-minus').addEventListener('click', () => { crewCount = Math.max(1, crewCount - 1); updateCrewHint(); });
  $('#crew-plus').addEventListener('click', () => { crewCount = Math.min(maxCrew(shipClass), crewCount + 1); updateCrewHint(); });
  $('[data-action="start-game"]').addEventListener('click', newGame);
  refreshContinue();

  // In-game UI: the console first (it lays out the panels the rest render into)
  initTooltips();
  initPointers();
  initConsole({
    closeDialog: (id) => closeDialog(id), closeComms: () => closeComms(), closeBoarding: () => closeBoarding(), closeLibrary: () => closeLibrary(),
    onExteriorPlaced: (floating) => { if (!floating && currentTab() !== 'exterior') setTab('exterior'); },
    roomsVisible: (on) => setCamsVisible(on),
  });
  initCams({ selectCrew: (id) => selectCrew(id), selectTile: (t, d, x, y) => selectTile(t, d, x, y), deckMenu: (d, x, y) => showDeckMenu(d, x, y) });
  initAiLine(aiHooks());
  initHud(requestSpeed, toggleCombat, openSystems, () => openNav('combat'), toggleSuits);
  initFx();
  ui.toggleCombat = toggleCombat;
  initLog();
  setResourceAlertHandler(resourceAlert);
  initNav({ hail: (id) => openComms(id), openStation: () => openStation(), board: (id) => openBoarding(id), dock: (target) => dockWith(target), showPanel, look: (id) => lookAt(id) });
  initSelection({ hail: (id) => openComms(id), openNav, showPanel });
  initDialogs({ plotRoute: (t, o) => openRoutePanel(t, o), setPaused, openComms: (id) => openComms(id), crewChanged: rebuildCrewViews, beginDocking: (id) => dockWith({ kind: 'station', id }) });
  initComms({ openStation: (e, tab) => openStation(e, tab), openBoarding: (id) => openBoarding(id), openDialog, openLibrary: (id) => openLibrary(id), plotRoute: (t) => openRoutePanel(t), dock: (id) => dockWith({ kind: 'station', id }) });
  setRouteHandler((t) => openRoutePanel(t));
  setDockHandler((id) => dockWith({ kind: 'station', id }));
  initBoarding();
  initService({ openDialog, closeDialog, plotRoute: (t, o) => openRoutePanel(t, o) });
  setHailHandler((id) => openComms(id));
  initStage({ state: () => ui.state, select: (id) => showOnBoard(id), currentTab, setTab, isFloating: exteriorIsFloating, pick: pickedEntity,
    back: () => { if (!exteriorIsFloating()) openNav('solar'); } });
  initPresenter();
  initLibrary();
  initKeyboard({
    speed: requestSpeed, togglePause, nav: (tab) => toggleNav(tab), missions: openMissions, jobs: openJobs,
    systems: openSystems, roster: openRoster,
    station: () => dockedStation(ui.state) ? openStation() : toast('Not docked', 'warn'),
    combat: toggleCombat, suits: toggleSuits, weapons: () => toggleNav('combat'), library: toggleLibrary, service: openService, escape: onEscape, save: () => quickSave(), devFlip, devCut,
    exterior: () => exteriorIsFloating() ? setExteriorFloating(false) : toggleNav('exterior'), scope: () => toggleScope(pickedEntity()), log: () => toggleLog(), flag: toggleFlagOnPick,
    comms: () => commsOpen() ? closeComms() : openComms(),
  });
  $$('[data-action]').forEach(b => {
    const a = b.dataset.action;
    const fn = {
      'open-map': () => openNav('solar'), 'open-station': () => openStation(), 'open-missions': openMissions, 'open-comms': () => openComms(),
      'open-jobs': openJobs, 'open-systems': openSystems, 'open-roster': openRoster, 'open-library': () => toggleLibrary(), 'open-service': openService, 'game-settings': openSettingsDialog, 'save-game': openSaveDialog, 'exit-game': openExitDialog,
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
    start: (state) => startGame(state, false),      // play a game state built by hand (a scene for a test)
  };
  console.log(`[LONGHAUL] v${VERSION} ready`);
}

function updateCrewHint() {
  const [lo, hi] = crewRange(shipClass);
  setText($('#crew-count'), crewCount);
  setText($('#crew-hint'), `${ROLES.slice(0, crewCount).join(' · ')}${crewCount < lo ? ` — short-handed: this ship wants ${lo}–${hi}` : ''}`);
  toggleClass($('#crew-hint'), 'form-hint-warn', crewCount < lo);
}

/**
 * The license a new captain starts under (sim/service.js): none, or one
 * power's. It decides where the game starts (that power's yards) and
 * which navy's hulls the picker lets us take.
 */
const LICENSES = [
  { id: null, name: 'None', text: 'A civilian captain. Start at Ceres. Navy hulls stay locked.' },
  { id: 'UN', name: 'UNN', text: 'UN Navy contractor. Start at Luna Shipyards. Unlocks the Harrier.' },
  { id: 'MCR', name: 'MCRN', text: 'Martian Navy contractor. Start at Phobos. Unlocks the Tharsis.' },
  { id: 'OPA', name: 'OPA', text: 'OPA contractor. Start at Tycho. Unlocks the refit corvette.' },
];

function renderLicenses() {
  const box = $('#license-picker');
  box.innerHTML = LICENSES.map(l => `<button type="button" class="license-opt ${l.id === license ? 'active' : ''}" data-license="${l.id || ''}" style="--fc:${l.id ? factionColor(l.id) : 'var(--hull-accent)'}"><b>${l.name}</b>${l.text}</button>`).join('');
  setText($('#license-hint'), license ? 'A license and one of its navy\'s hulls make you its contractor: you fly its flag, its enemies are yours, and its command ships send you to its fights. One license at a time.' : 'Military kit (navy hulls, nuclear torpedoes) is illegal without a license. Licenses can also be applied for in port.');
  box.onclick = (e) => {
    const b = e.target.closest('[data-license]');
    if (!b) return;
    license = b.dataset.license || null;
    renderLicenses();
    openShipPicker();
  };
}

/** The ship list on the new-game screen; picking a hull fills its minimum crew. */
function openShipPicker() {
  if (!shipAllowed(shipClass, license)) shipClass = PLAYER_CLASS;
  renderShipPicker($('#ship-picker'), shipClass, (id) => {
    shipClass = id;
    crewCount = Math.min(maxCrew(id), Math.max(crewCount, CLASSES[id].crew[0]));
    updateCrewHint();
  }, { license });
}

async function refreshContinue() {
  if (!storageOK) { show($('#menu-continue'), false); return; }
  const s = await latestSave().catch(() => null);
  show($('#menu-continue'), !!s);
}

// ---- GAME LIFECYCLE ----

function newGame() {
  const shipName = $('#input-ship-name').value.trim() || 'Longhaul';
  const captainName = $('#input-captain-name').value.trim() || randomCaptainName();
  const state = createGame({ shipName, captainName, crewCount, classId: shipClass, license });
  startGame(state, true);
  logEntry(`Mission start — ${state.ship.name}, ${CLASSES[shipClass].name} (${TECH[state.ship.tl].label}), Captain ${captainName}${license ? `, ${FACTIONS[license].navy} contractor's license` : ''}`, 'system');
  const port = getWorld(state).get(state.dock?.target.id);
  logEntry(`Docked at ${port?.name || 'port'}, berth ${state.dock?.berth}. Crew of ${state.ship.crew.length}. Hail the station (H) for contracts, clearances and the hiring hall; your service record and the powers are under SERVICE (V).`, 'nav');
  toast('Good luck, Captain.', 'ok');
}

async function loadAndStart(id) {
  try {
    const { state } = await loadSave(id);
    startGame(state, false);
    toast('Mission loaded', 'ok');
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
  closeLibrary();
  resetTacCache();
  resetFx();
  resetLogView();
  resetResourceAlerts();
  resetStage();
  clearTicker();
  closeComms(); closeBoarding();
  rebuildCrewViews();
  resetAiLine();
  clearSelection();
  if (fresh) state.speed = 1;
  ui.loop = new GameLoop(state, { onFrame: frame, onError: (e) => { console.error('[sim]', e); } });
  ui.loop.start();
  showScreen('game');
  if (storageOK) scheduleAutosave();
  renderLog();
}

/** (Re)build what shows the crew: a new game, a hand signed on or paid off. */
function rebuildCrewViews() {
  const state = ui.state;
  if (!state) return;
  buildCams(state);
}

/**
 * Dock with a station or a ship: close in, the docking computer flies the
 * final approach; far off, the route planner plots the way to the gate
 * (or to the ship) first.
 */
/** What is picked on the displays, if it is a contact (the telescope's target for LOOK and Z). */
const pickedEntity = () => ui.nav.target?.kind === 'entity' ? ui.nav.target.id : null;

function dockWith(target) {
  const s = ui.state;
  if (!s) return;
  const e = getWorld(s).get(target.id);
  if (!e) return;
  const dM = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y) * AU_M;
  const near = target.kind === 'ship' ? dM < 200_000 : dM < keepOutM(e.id) * 3;
  if (!near) { openRoutePanel({ kind: 'entity', id: e.id }, { dock: true }); return; }
  const r = beginDocking(s, target, { mode: 'auto' }, (t, p) => bus.emit(t, p));
  toast(r.text, r.ok ? 'nav' : 'warn');
  logEntry(r.text, r.ok ? 'nav' : 'warn');
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
  stopAutosave();
  closeNav();
  document.body.classList.remove('reactor-offline', 'ship-blackout', 'inertia-active');
  refreshContinue();
  showScreen('landing');
}

// ---- THE SHIP'S AI: what its buttons do ----

function aiHooks() {
  const emit = (t, p) => bus.emit(t, p);
  const say = (r) => { if (!r) return; toast(r.text, r.ok ? 'ok' : 'warn'); logEntry(r.text, r.ok ? 'system' : 'warn'); };
  return {
    plotRoute: (target, opts) => {
      // (plotting to a distress call answers it: the AI offers it as one click)
      const offered = ui.state.missions.list.find(m => m.status === 'offered' && m.entityId === target.id);
      if (offered) acceptMission(ui.state, offered.id);
      openRoutePanel(target, opts);
    },
    select: (target) => selectTarget(target),
    open: (what, id, tab) => {
      const s = ui.state;
      if (what === 'station') openStation(id ? getWorld(s).get(id) : undefined, tab || null);
      else if (what === 'missions') openMissions();
      else if (what === 'comms') openComms(id);
      else if (what === 'systems') openSystems();
      else if (what === 'roster') openRoster();
      else if (what === 'service') openService();
      else if (what === 'boarding') openBoarding(id);
      else if (what === 'jobs') openJobs();
      else if (what === 'weapons') openNav('combat');
      else if (what === 'map') openNav('solar');
      else if (what === 'library') openLibrary(id);
    },
    toggleCombat, toggleSuits,
    respond: (id, opt) => answerRequestById(id, opt),
    hail: (id) => openComms(id),
    requestDocking: (id) => {
      const s = ui.state;
      const r = requestDocking(s, id);
      say(r);
      if (r.ok && s.dock && ['awaiting', 'holding'].includes(s.dock.phase)) { const d = beginDocking(s, s.dock.target, { mode: s.dock.mode }, emit); if (!d.ok) toast(d.text, 'warn'); }
    },
    requestDeparture: (id) => say(requestDeparture(ui.state, id)),
    dock: (id) => dockWith({ kind: 'station', id }),
    speed: (v) => requestSpeed(v),
    order: (what) => {
      const s = ui.state;
      if (what === 'scram') { const r = orderShutdown(s); say({ ok: !!r?.success, text: r?.message || 'Shutdown ordered' }); }
      else if (what === 'execute') { if (overrideSecure(s)) logEntry('Captain: execute — not waiting for the rest of the crew', 'warn'); }
      else if (what === 'flip-now') { if (forceTurn(s)) logEntry('Captain: flip now — not waiting for the crew', 'danger'); }
      else if (what === 'pdc-auto') { setPdcMode(s, 'auto'); logEntry('Point defense to AUTO', 'system'); }
      else if (what === 'evasive') { setEvasive(s, true); logEntry('Evasive maneuvering', 'warn'); }
      else if (what === 'transponder-on') { if (!s.comms.transponder) toggleTransponder(s); logEntry('Transponder on', 'system'); }
    },
  };
}

// ---- FRAME ----

function frame(state, alpha) {
  ui.alpha = alpha;
  updateHud(state);
  updateCams(state, alpha);
  updateAi(state);
  updateStage(state, alpha);
  updateNav(state, alpha);
  updateComms();
  updateBoarding();
  renderSelection();
  renderLog();

  const body = document.body;
  toggleClass(body, 'reactor-offline', state.reactor.status !== 'online' && !state.reactor.blackout);
  toggleClass(body, 'ship-blackout', state.reactor.blackout);
  toggleClass($('#screen-game'), 'game-paused', state.speed === 0);
  toggleClass($('#screen-game'), 'battle-stations', state.combatStations);

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

function toggleSuits() {
  const s = ui.state;
  if (!s) return;
  const on = orderSuits(s, !s.suitsOn);
  if (on) { toast('ALL HANDS: SUIT UP', 'warn'); logEntry('All hands into EVA suits, and keep them on', 'warn'); }
  else { toast('Suits off when the air is good', 'ok'); logEntry('Suit order lifted: suits off where the air is good', 'system'); }
}

function onEscape() {
  if (document.getElementById('compartment-menu')) { document.getElementById('compartment-menu').remove(); return; }
  if (closeTopWindow()) return;
  if (ui.nav.card || ui.nav.target) { closeNav(); ui.nav.target = null; clearSelection(); return; }
  closeNav();
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
    ['WEAR ALL', () => { for (const id of shipSystems(ui.state)) ui.state.systems.units[id].integrity = Math.max(0, ui.state.systems.units[id].integrity - 40); }],
    ['+10 SPARES', () => { const p = ui.state.resources.parts; p.current = Math.min(p.max, p.current + 10); }],
    ['REFUEL', () => { ui.state.resources.fuel.current = ui.state.resources.fuel.max; }],
    ['PIRATE', () => spawnEncounter(ui.state, { kind: 'pirate' }, (t, p) => bus.emit(t, p))],
    ['AMBUSH', () => spawnEncounter(ui.state, { kind: 'ambush' }, (t, p) => bus.emit(t, p))],
    ['PATROL', () => { const f = controlAt(ui.state.flight.pos.x, ui.state.flight.pos.y, ui.state.clock.minute).faction || 'OPA'; spawnEncounter(ui.state, { kind: 'patrol', faction: f }, (t, p) => bus.emit(t, p)); }],
    ['BATTLE', () => spawnEncounter(ui.state, { kind: 'battle', zone: { id: null, factions: ['UN', 'MCR'] } }, (t, p) => bus.emit(t, p))],
    ['WAR UN·MCR', () => { setPhase(ui.state, 'UN', 'MCR', 'war'); toast('Earth and Mars are at war (dev)', 'danger'); }],
    ['CRISIS UN·MCR', () => { setPhase(ui.state, 'UN', 'MCR', 'crisis'); toast('Earth–Mars crisis (dev)', 'warn'); }],
    ['+500 REP', () => { addRep(ui.state, 500, 'dev'); }],
    ['+TORPS', () => { const M = ui.state.magazine; M.he = M.capacity - M.nuke; }],
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
