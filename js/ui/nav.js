// ============================================================
// LONGHAUL — Navigation UI
// Nav modal (tactical / solar / scanner), target selection, route
// planning, route and stance status, the "secure for burn" prompt,
// and the station-keeping indicator. The stance panel (stance.js)
// shares the route panel's slot. A ship that isn't on our board is
// shown as what the plot reports of it (intel.js), never as it is.
// ============================================================

import { ui } from './context.js';
import { $, $$, esc, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtKm, fmtG, fmtNum, fmtAngle } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M, AU_KM, RANGE, DAY_MIN } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getBody } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { planRoutes, simulatePlan, targetStateAt, targetName, defaultStandoff, STANDOFF, PREP_MINUTES } from '../sim/nav.js';
import { engageRoute, abortRoute, overrideSecure, forceTurn, TURN_HOLD_MAX_MIN } from '../sim/autopilot.js';
import { crewSecureStatus, isSecured } from '../sim/crew-ai.js';
import { driveLimitG, systemPerf, flightComputerState } from '../sim/systems.js';
import { isConscious } from '../sim/crew.js';
import { SENSOR_RANGES, REVEAL, setSensorRange, selectContact, toggleLock, contactById } from '../sim/sensors.js';
import { missionForEntity } from '../sim/missions.js';
import { dockedStation } from '../sim/contracts.js';
import { bus } from '../core/events.js';
import { TacView, TAC_LABELS } from './tac.js';
import { SolarMap, ageLabel } from './solar-map.js';
import { trackOf, estimate, describeRecord, liveKnowledge } from '../sim/intel.js';
import { ScannerView } from './scanner.js';
import { relativeTo, velocityReference, STANCE_PHASE } from './hud.js';
import { initStance, openStance, closeStance, stanceOpen, release as releaseStance } from './stance.js';
import { STANCE_MODES } from '../sim/stance.js';
import { ThreatView, renderFireControl, onFireControlClick, targetContact } from './combat.js';

let tacModal = null, map = null, scanner = null, tacSmall = null, threat = null;
let routeUI = null;          // { target, standoffKey, options, selected, computing }
let etaCache = { at: 0, key: '', minutes: null, path: null };
let hooks = {};

export function initNav(h) {
  hooks = h;   // { hail(entityId), openStation() }
  tacSmall = new TacView($('#tac-screen'));
  $('#tac-screen').addEventListener('click', () => openNav('tactical'));
  $$('.tac-zoom-btn').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    setTacZoom(+b.dataset.tacZoom);
  }));

  tacModal = new TacView($('[data-nav-screen="tactical"]'));
  map = new SolarMap($('[data-nav-screen="solar"]'), {
    onSelect: (sel) => { ui.nav.target = sel; renderSelection(); },
  });
  scanner = new ScannerView($('[data-nav-screen="scanner"]'), {
    onSelect: (id) => {
      if (!ui.state) return;
      selectContact(ui.state, id);
      ui.nav.target = id ? { kind: 'entity', id } : null;
      hideRoutePanel();
      renderSelection();
    },
  });

  threat = new ThreatView($('[data-nav-screen="combat"]'), {
    onSelect: (id) => { if (ui.state && id) { targetContact(ui.state, id); selectContact(ui.state, id); } },
  });
  $('#combat-panel').addEventListener('click', onFireControlClick);
  $$('[data-solar-politics]').forEach(b => b.addEventListener('click', () => { map.showPolitics = !map.showPolitics; toggleClass(b, 'active', map.showPolitics); }));
  $$('[data-solar-intel]').forEach(b => b.addEventListener('click', () => { map.showIntel = !map.showIntel; toggleClass(b, 'active', map.showIntel); }));

  $$('[data-nav-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.navTab)));
  $$('[data-tac-zoom-modal]').forEach(b => b.addEventListener('click', () => { ui.nav.modalZoom = +b.dataset.tacZoomModal; tacModal.zoom = ui.nav.modalZoom; syncButtons(); }));
  $$('[data-solar-view]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.solarView === 'target' && !navTargetPos()) { toast('No target selected', 'warn'); return; }
    map.setView(b.dataset.solarView, ui.state);
  }));
  $$('[data-scanner-range]').forEach(b => b.addEventListener('click', () => { setSensorRange(ui.state, +b.dataset.scannerRange); syncButtons(); }));
  $('#nav-modal-close').addEventListener('click', closeNav);
  $('#nav-modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'nav-modal') closeNav(); });

  // Delegated actions inside panels
  for (const id of ['#map-selection', '#scanner-detail', '#route-panel', '#route-status', '#route-mini', '#nav-prompt', '#hold-indicator']) {
    $(id).addEventListener('click', onPanelClick);
  }
  bus.on('route-arrived', () => { etaCache.key = ''; });
  initStance({
    preview: (path) => { if (map) map.preview = path; },
    closed: () => renderSelection(),
  });
}

function setTacZoom(z) {
  ui.nav.tacZoom = z;
  tacSmall.zoom = z;
  $$('.tac-zoom-btn').forEach(b => toggleClass(b, 'active', +b.dataset.tacZoom === z));
  setText($('#tac-range'), TAC_LABELS[z]);
}

export function openNav(tab = ui.nav.tab) {
  if (!ui.state) return;
  if (ui.state.reactor.blackout) { toast('No power — displays dark', 'danger'); return; }
  ui.nav.open = true;
  show($('#nav-modal'), true, 'flex');
  if (!ui.nav.modalZoomSet) { ui.nav.modalZoom = ui.nav.tacZoom; tacModal.zoom = ui.nav.modalZoom; ui.nav.modalZoomSet = true; }
  setTab(tab);
  if (tab === 'solar' && !map._init) { map._init = true; requestAnimationFrame(() => map.setView('ship', ui.state)); }
}

export function closeNav() {
  ui.nav.open = false;
  show($('#nav-modal'), false);
  hideRoutePanel();
  closeStance();
}

export function toggleNav(tab) {
  if (ui.nav.open && ui.nav.tab === tab) closeNav(); else openNav(tab);
}

function setTab(tab) {
  ui.nav.tab = tab;
  $$('[data-nav-tab]').forEach(b => toggleClass(b, 'active', b.dataset.navTab === tab));
  $$('[data-nav-screen]').forEach(s => show(s, s.dataset.navScreen === tab));
  $$('[data-tab-controls]').forEach(c => show(c, c.dataset.tabControls === tab, 'flex'));
  show($('#combat-panel'), tab === 'combat' && !stanceOpen(), 'flex');
  syncButtons();
  renderSelection();
}

function syncButtons() {
  $$('[data-tac-zoom-modal]').forEach(b => toggleClass(b, 'active', +b.dataset.tacZoomModal === ui.nav.modalZoom));
  if (ui.state) $$('[data-scanner-range]').forEach(b => toggleClass(b, 'active', +b.dataset.scannerRange === ui.state.sensors.range));
}

// ---- TARGET HELPERS ----

function navTargetPos() {
  const t = ui.nav.target;
  if (!t || !ui.state) return null;
  const r = reportFor(ui.state, t);
  if (r) {
    const est = estimate(ui.state, r, ui.state.clock.minute);
    return est ? { x: est.x, y: est.y } : null;
  }
  return targetStateAt(ui.state, t, ui.state.clock.minute)?.pos || null;
}

/** The plot's record for a target we can't see or chart right now (null if we can). */
function reportFor(state, t) {
  if (t?.kind !== 'entity') return null;
  const e = getWorld(state).get(t.id);
  if (e && liveKnowledge(state, e)) return null;
  return trackOf(state, t.id);
}

function describeTarget(state, t) {
  if (t.kind === 'body') {
    const b = getBody(t.id);
    return { name: t.id, kind: b?.type === 'star' ? 'Star' : (b?.type || 'body').replace(/^\w/, c => c.toUpperCase()), faction: null };
  }
  const e = getWorld(state).get(t.id);
  const report = reportFor(state, t);
  if (report) return { name: report.name || 'Unidentified track', kind: report.shipClass || 'Ship', faction: report.faction, entity: e, report };
  if (!e || !liveKnowledge(state, e)) return null;
  const c = contactById(state, e.id);
  const known = e.transponder || (c && c.name) || e.type === 'station' || e.type === 'nav';
  return {
    name: known ? e.name : (c?.signature || 'Unidentified contact'),
    kind: e.type === 'station' ? (e.shipClass || 'Station') : e.type === 'nav' ? 'Navigation mark' : (known ? e.shipClass || 'Ship' : 'Unknown'),
    faction: known ? e.faction : null,
    entity: e,
  };
}

/** A class or station name that opens its page in the ship's library. */
function libRef(e, html) {
  const id = e?.cls ? `ship:${e.cls}` : e?.type === 'station' ? `stn:${e.id}` : null;
  return id ? `<span class="lib-inline" data-lib="${id}" title="Ship's library">${html}</span>` : html;
}

function inRadio(state, id) {
  return state.comms.radio.includes(id);
}

// ---- SELECTION PANELS ----

function renderSelection() {
  const s = ui.state;
  const t = ui.nav.target;
  const mapPanel = $('#map-selection');
  const scanPanel = $('#scanner-detail');
  show(mapPanel, false); show(scanPanel, false);
  if (!s || !t || routeUI || stanceOpen()) return;
  const d = describeTarget(s, t);
  if (!d) return;
  const rel = relativeTo(s, t);
  const ap = s.autopilot;
  const routing = ap && ap.plan.target.id === t.id;
  const canHail = t.kind === 'entity' && inRadio(s, t.id);

  if (ui.nav.tab === 'scanner' && t.kind === 'entity') {
    const c = contactById(s, t.id);
    if (!c) return;
    const lock = s.sensors.locked === t.id;
    const row = (k, v, cls = '') => `<div class="scanner-detail-row"><span class="scanner-detail-key">${k}</span><span class="scanner-detail-val ${cls}">${v}</span></div>`;
    const html = `<div class="scanner-detail-header">${c.sos ? '<span class="scanner-sos-tag">⚠ SOS</span> ' : ''}${esc(c.name || c.signature || 'CONTACT')}</div>
      ${row('TRANSPONDER', c.name ? esc(c.name) : 'SILENT', c.name ? 'scanner-val-accent' : 'scanner-val-dim')}
      ${row('SIGNATURE', c.signature || '—')}
      ${row('FACTION', c.faction || '—', c.faction ? '' : 'scanner-val-dim')}
      ${row('CLASS', c.shipClass ? libRef(d.entity, esc(c.shipClass)) : '—')}
      ${row('RANGE', fmtKm(c.dist * AU_KM))}
      ${row('LIGHT LAG', c.lagS < 0.1 ? '< 0.1 s' : `${c.lagS.toFixed(1)} s`, 'scanner-val-dim')}
      ${row('REL SPEED', c.velocityKnown && rel ? fmtSpeed(rel.speed) : `scanning… ${Math.max(0, REVEAL.VELOCITY - c.scan)}m`)}
      ${row('BEARING', fmtAngle(c.bearing - s.flight.facing))}
      ${row('DRIVE', c.thrust || (c.scan < REVEAL.THRUST ? '…' : '—'), c.thrust && c.thrust !== 'COASTING' ? 'scanner-val-warn' : '')}
      ${row('MASS', c.mass ? fmtNum(c.mass / 1000, 1) + ' kt' : '…')}
      <div class="panel-actions">
        <button class="scanner-track-btn ${lock ? 'tracking' : ''}" data-act="lock">${lock ? 'UNLOCK' : 'LOCK'}</button>
        ${routing ? '<button class="scanner-intercept-btn intercepting" data-act="abort">ABORT INTERCEPT</button>' : '<button class="scanner-intercept-btn" data-act="plot">INTERCEPT</button>'}
        ${canHail ? '<button class="scanner-track-btn" data-act="hail">HAIL</button>' : ''}
        ${!c.ordnance ? '<button class="scanner-track-btn" data-act="stance">STANCE</button>' : ''}
        ${!c.ordnance && !c.station ? `<button class="scanner-track-btn ${s.combat.target === t.id ? 'tracking' : ''}" data-act="target">${s.combat.target === t.id ? 'TARGETED' : 'TARGET'}</button>` : ''}
      </div>`;
    setHTML(scanPanel, html);
    show(scanPanel, true);
    return;
  }

  if (ui.nav.tab !== 'solar') return;
  if (d.report) { renderReport(s, t, d, routing); return; }
  const html = `<div class="ms-header">
      <span class="ms-name">${esc(d.name)}</span>
      <span class="ms-kind">${esc(d.kind)}${d.faction && d.faction !== 'independent' ? ` · ${esc(d.faction)}` : ''}</span>
    </div>
    <div class="ms-stats">
      <span>DIST <b>${rel ? fmtMeters(rel.dist) : '—'}</b></span>
      <span>REL V <b>${rel ? fmtSpeed(rel.speed) : '—'}</b></span>
    </div>
    <div class="panel-actions">
      ${routing ? '<button class="route-abort-btn" data-act="abort">ABORT ROUTE</button>' : t.id === 'Sol' ? '' : '<button class="route-plot-btn" data-act="plot">PLOT ROUTE</button>'}
      ${t.id === 'Sol' ? '' : '<button class="route-zoom-btn" data-act="stance">STANCE</button>'}
      <button class="route-zoom-btn" data-act="focus">FOCUS</button>
      ${canHail ? '<button class="route-zoom-btn" data-act="hail">HAIL</button>' : ''}
    </div>`;
  setHTML(mapPanel, html);
  show(mapPanel, true);
}

/**
 * A ship known only from the plot: what was reported, by whom, how old it
 * is, and how far off it could be by now. A filed plan or a berth can be
 * flown to (the nav computer works from the same public data); a lost
 * contact's last fix can only be looked at until our sensors find it again.
 */
function renderReport(s, t, d, routing) {
  const r = d.report;
  const info = describeRecord(s, r);
  const est = estimate(s, r, s.clock.minute);
  const f = s.flight.pos;
  const dist = est ? Math.hypot(est.x - f.x, est.y - f.y) * AU_KM : null;
  const plotable = !!d.entity && r.kind !== 'fix';
  const html = `<div class="ms-header">
      <span class="ms-name">${esc(d.name)}</span>
      <span class="ms-kind">${esc(d.kind)}${d.faction && d.faction !== 'independent' ? ` · ${esc(d.faction)}` : ''} · <span class="ms-report">REPORTED</span></span>
    </div>
    <div class="ms-stats">
      <span>AGE <b>${ageLabel(info.ageMin)}</b></span>
      <span>FROM <b>${esc(info.src)}</b></span>
      ${info.lagMin > 0 ? `<span>LIGHT LAG <b>${info.lagMin} min</b></span>` : ''}
    </div>
    <div class="ms-stats">
      <span>${esc(info.what)}</span>
      <span>DIST <b>${dist != null ? '~' + fmtKm(dist) : '—'}</b></span>
      ${est?.sigmaAU ? `<span>± <b>${fmtKm(est.sigmaAU * AU_KM)}</b></span>` : ''}
    </div>
    <div class="panel-actions">
      ${routing ? '<button class="route-abort-btn" data-act="abort">ABORT ROUTE</button>' : plotable ? '<button class="route-plot-btn" data-act="plot" title="Fly to its filed plan; sensors take over on approach">PLOT ROUTE</button>' : '<span class="ms-hint">No live track: close in until our sensors hold it</span>'}
      <button class="route-zoom-btn" data-act="focus">FOCUS</button>
    </div>`;
  setHTML($('#map-selection'), html);
  show($('#map-selection'), true);
}

function onPanelClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !ui.state) return;
  e.stopPropagation();
  const s = ui.state;
  const t = ui.nav.target;
  switch (btn.dataset.act) {
    case 'lock':
      if (t) { const on = toggleLock(s, t.id); logEntry(on ? `Ranging laser locked on ${describeTarget(s, t)?.name}` : 'Sensor lock released', 'nav'); }
      renderSelection();
      break;
    case 'plot': if (t) openRoutePanel(t); break;
    case 'stance': if (t) showStancePanel(t); break;
    case 'stance-edit': {
      const ap = s.autopilot;
      if (ap?.plan.kind !== 'stance') break;
      if (!ui.nav.open) openNav();
      ui.nav.target = { ...ap.plan.target };
      showStancePanel(ap.plan.target);
      break;
    }
    case 'release': releaseStance(s); break;
    case 'target': if (t) { targetContact(s, t.id); setTab('combat'); } break;
    case 'hail': if (t) hooks.hail(t.id); break;
    case 'focus': if (t) { const p = navTargetPos(); if (p) map.focusOn(p, t.kind === 'entity' ? 2e6 : Math.max(map.scale, 300)); } break;
    case 'abort':
      if (abortRoute(s, (type, p) => bus.emit(type, p))) { toast('Route aborted — drive cut', 'warn'); }
      renderSelection();
      break;
    case 'standoff': routeUI.standoffKey = btn.dataset.key; computeRoutes(); break;
    case 'option': {
      const i = +btn.dataset.i;
      if (!routeUI.options[i]?.feasible) break;
      routeUI.selected = i;
      map.preview = routeUI.options[i].estimate.path;
      renderRoutePanel();
      break;
    }
    case 'confirm': confirmRoute(); break;
    case 'cancel': hideRoutePanel(); renderSelection(); break;
    case 'engage':
      if (overrideSecure(s)) { logEntry('Captain: execute — not waiting for the rest of the crew', 'warn'); }
      break;
    case 'force-turn':
      if (forceTurn(s)) { logEntry('Captain: flip now — not waiting for the crew', 'danger'); }
      break;
    case 'station': hooks.openStation(); break;
    case 'open-nav': openNav('solar'); break;
  }
}

/** The stance panel takes the slot of the route panel and the selection panels. */
function showStancePanel(target) {
  hideRoutePanel();
  show($('#map-selection'), false); show($('#scanner-detail'), false);
  openStance(target);
}

// ---- ROUTE PLANNING ----

const STANDOFFS = {
  dock: { label: 'DOCK', m: STANDOFF.STATION, desc: 'Park 3 km off the station' },
  formation: { label: 'FORMATION', m: STANDOFF.TACTICAL, desc: '2 km — boarding, tow, EVA' },
  close: { label: 'CLOSE', m: STANDOFF.CLOSE, desc: '100,000 km — full sensor lock' },
  scanner: { label: 'SCANNER', m: STANDOFF.SCANNER, desc: '15M km — inside long-range sensors' },
  orbit: { label: 'ORBIT', m: null, desc: 'Parking orbit' },
};

function standoffChoices(state, t) {
  if (t.kind === 'body') return ['orbit', 'close'];
  const e = getWorld(state).get(t.id);
  if (e?.type === 'station') return ['dock', 'close', 'scanner'];
  return ['formation', 'close', 'scanner'];
}

export function openRoutePanel(target) {
  const s = ui.state;
  if (!s) return;
  if (s.autopilot && s.autopilot.plan.kind !== 'stance' && s.autopilot.plan.target.id === target.id) { toast('Already en route', 'info'); return; }
  closeStance();
  ui.nav.target = target;
  if (!ui.nav.open) openNav(target.kind === 'entity' && contactById(s, target.id) ? 'scanner' : 'solar');
  const choices = standoffChoices(s, target);
  routeUI = { target, choices, standoffKey: choices[0], options: [], selected: -1, computing: true };
  show($('#map-selection'), false); show($('#scanner-detail'), false);
  show($('#route-panel'), true, 'flex');
  computeRoutes();
}

function computeRoutes() {
  const s = ui.state;
  routeUI.computing = true;
  routeUI.options = [];
  routeUI.selected = -1;
  map.preview = null;
  renderRoutePanel();
  setTimeout(() => {
    if (!routeUI) return;
    const t = routeUI.target;
    const so = STANDOFFS[routeUI.standoffKey];
    const standoff = so.m ?? defaultStandoff(s, t);
    const e = t.kind === 'entity' ? getWorld(s).get(t.id) : null;
    const minG = e && !e.orbit && !e.transit && e.thrust > 0 ? e.thrust : 0;
    const t0 = performance.now();
    routeUI.options = planRoutes(s, t, { standoff, combat: s.combatStations, minG });
    routeUI.ms = performance.now() - t0;
    routeUI.computing = false;
    const best = routeUI.options.findIndex(o => o.feasible && o.name === 'STANDARD');
    routeUI.selected = best >= 0 ? best : routeUI.options.findIndex(o => o.feasible);
    if (routeUI.selected >= 0) map.preview = routeUI.options[routeUI.selected].estimate.path;
    renderRoutePanel();
  }, 30);
}

function renderRoutePanel() {
  const s = ui.state;
  const panel = $('#route-panel');
  if (!routeUI) return;
  const t = routeUI.target;
  const d = describeTarget(s, t);
  const rel = relativeTo(s, t);
  const choice = routeUI.choices.map(k => `<button class="solar-zoom-btn ${k === routeUI.standoffKey ? 'active' : ''}" data-act="standoff" data-key="${k}" title="${STANDOFFS[k].desc}">${STANDOFFS[k].label}</button>`).join('');
  const cards = routeUI.computing
    ? '<div class="route-computing">Nav computer plotting trajectories…</div>'
    : routeUI.options.length === 0 ? '<div class="route-computing">Already there.</div>'
    : routeUI.options.map((o, i) => {
      const est = o.estimate;
      const crew = s.ship.crew.filter(m => !m.dead).length;
      const juiceNote = o.flank
        ? `<div class="route-juice-note">☢ OVERDRIVE: high-dose juice ≈ ${crew * 2} med (${s.resources.medSupplies.current.toFixed(0)} aboard) · stroke risk · week-long crash after · containment failure risk</div>`
        : o.juice ? `<div class="route-juice-note">⚠ Juice: crash couches the whole burn · ${s.resources.medSupplies.current.toFixed(0)} med supplies aboard</div>` : '';
      return `<div class="route-card ${o.feasible ? '' : 'infeasible'} ${i === routeUI.selected ? 'selected' : ''}" data-act="option" data-i="${i}">
        <div class="route-card-header"><span class="route-card-name">${esc(o.name)}</span><span class="route-card-type">${esc(o.label)}</span></div>
        <div class="route-card-stats">
          <span class="route-stat">TIME <span class="route-stat-val">${formatDuration(o.minutes)}</span></span>
          <span class="route-stat">FUEL <span class="route-stat-val">${fmtNum(o.fuel)} kg</span></span>
          <span class="route-stat">ΔV <span class="route-stat-val">${fmtSpeed(est.dv)}</span></span>
          <span class="route-stat">MAX G <span class="route-stat-val ${o.juice ? 'route-juice-warn' : ''}">${fmtG(est.maxG || o.accelG)}</span></span>
          <span class="route-stat">PEAK V <span class="route-stat-val">${fmtSpeed(est.peakSpeed)}</span></span>
        </div>
        <div class="route-card-desc">${esc(o.desc)}</div>
        <div class="route-card-feasibility ${o.feasible ? 'route-feasible' : 'route-infeasible'}">${o.feasible ? '● READY' : `● ${esc(o.reason)}`}</div>
        ${juiceNote}
      </div>`;
    }).join('');
  setHTML(panel, `<div class="route-panel-header"><span class="route-panel-title">NAVIGATION PLOT</span><button class="route-panel-close" data-act="cancel" aria-label="Close">&times;</button></div>
    <div class="route-dest-info">
      <span class="route-dest-label">Destination</span>
      <span class="route-dest-name">${esc(d?.name || '—')}</span>
      <span class="route-dest-dist">${rel ? `${fmtMeters(rel.dist)} · rel ${fmtSpeed(rel.speed)}` : ''}</span>
      <div class="route-standoff">${choice}</div>
    </div>
    ${machineryNote(s)}
    <div class="route-options">${cards}</div>
    <div class="route-panel-actions">
      <button class="btn btn-secondary route-btn" data-act="cancel">CANCEL</button>
      <button class="btn btn-primary route-btn" data-act="confirm" ${routeUI.selected < 0 ? 'disabled' : ''}>ENGAGE</button>
    </div>`);
}

/** What the machinery allows, shown above the plot (drive limits, manual flight). */
function machineryNote(s) {
  const notes = [];
  const limit = driveLimitG(s);
  if (limit < 3) notes.push(limit <= 0 ? 'Main drive unavailable' : `Drive limited to ${fmtG(limit)} — ${systemPerf(s, 'coolant') < 1 ? 'reactor cooling' : 'drive'} damaged`);
  else if (limit < 10) notes.push(`Drive limited to ${fmtG(limit)} (${systemPerf(s, 'drive') < 1 ? 'drive' : 'reactor cooling'} degraded)`);
  const fc = flightComputerState(s);
  if (fc === 'failed') notes.push('Flight computer down — the route will be flown by hand from the helm (more fuel, no fast-forward)');
  else if (fc === 'degraded') notes.push('Flight computer degraded — expect wandering burns');
  return notes.length ? `<div class="route-machinery">${notes.map(n => `<span>⚠ ${esc(n)}</span>`).join('')}</div>` : '';
}

function confirmRoute() {
  const s = ui.state;
  if (!routeUI || routeUI.selected < 0) return;
  const opt = routeUI.options[routeUI.selected];
  if (!opt.feasible) return;
  const t = routeUI.target;
  const mission = t.kind === 'entity' ? missionForEntity(s, t.id) : null;
  engageRoute(s, opt.plan, { estimate: opt.estimate, missionId: mission?.id, intercept: routeUI.standoffKey });
  logEntry(`Course plotted: ${targetName(s, t)} — ${opt.name} (${opt.label}), ETA ${formatDuration(opt.minutes)}, ${fmtNum(opt.fuel)} kg`, 'nav');
  logEntry('All hands — secure for acceleration', 'nav');
  toast('SECURE FOR BURN', 'warn');
  etaCache.key = '';
  hideRoutePanel();
  closeNav();
}

function hideRoutePanel() {
  routeUI = null;
  if (map) map.preview = null;
  show($('#route-panel'), false);
}

// ---- ROUTE STATUS / PROMPTS (every frame) ----

/** The flip interlock is holding a turn: who is still up, and the captain's choice. */
function renderHeldPrompt(state, box, st) {
  const ap = state.autopilot;
  const left = Math.max(0, TURN_HOLD_MAX_MIN - (state.clock.minute - ap.turnHeld));
  const up = st.unsecured.map(m => esc(m.name)).join(', ');
  setHTML(box, `<div class="mp-header mp-danger">FLIP HELD → ${esc(targetName(state, ap.plan.target))}</div>
    ${crewDots(state, st)}
    <span class="mp-status mp-caution">${st.unsecured.length} CREW ON THEIR FEET: ${up}</span>
    <span class="mp-status mp-waiting">Drive cold, nose held. Flipping when all hands are in${left ? `, or in ${left} min` : ''}</span>
    <div class="mp-actions">
      <button class="mp-engage-btn" data-act="force-turn" ${ap.forceTurn ? 'disabled' : ''}>${ap.forceTurn ? 'FLIPPING…' : 'FLIP NOW'}</button>
      <button class="route-abort-btn" data-act="abort">ABORT</button>
    </div>`);
}

function crewDots(state, st) {
  const dots = state.ship.crew.filter(isConscious).map(m => {
    const ok = isSecured(m);
    const p = st.pilot === m;
    return `<span class="mp-dot ${ok ? 'mp-dot-ok' : 'mp-dot-wait'} ${p ? 'mp-dot-pilot' : ''}" title="${esc(m.name)} — ${ok ? 'secured' : m.activity}">${p ? 'P' : '·'}</span>`;
  }).join('');
  return `<div class="mp-crew-row">${dots}</div>`;
}

function refreshEta(s) {
  const ap = s.autopilot;
  if (!ap) { etaCache.key = ''; return null; }
  const key = `${ap.plan.target.id}:${ap.createdAt}`;
  const now = performance.now();
  if (etaCache.key !== key || now - etaCache.at > 2500) {
    // (a stance that can't get into place within days is shown as such, not chased for years)
    const est = simulatePlan(s, ap.plan, { pathPoints: 120, maxMinutes: ap.plan.kind === 'stance' ? 3 * DAY_MIN : undefined });
    etaCache = { key, at: now, minutes: est.arrived ? est.minutes + (ap.phase === 'prepare' ? PREP_MINUTES : 0) : null, path: est.path, fuel: est.fuel };
  }
  return etaCache;
}

export function updateNav(state, alpha) {
  const ap = state.autopilot;
  const eta = refreshEta(state);
  if (map) map.routePath = ap ? eta?.path : null;

  // Small tac: always live
  const ref = velocityReference(state);
  const rel = ref ? relativeTo(state, ref.target) : null;
  tacSmall.render(state, alpha, { reference: rel ? { ...rel } : null, highlight: ref?.target.id });

  if (ui.nav.open) {
    if (ui.nav.tab === 'tactical') tacModal.render(state, alpha, { reference: rel, highlight: ref?.target.id });
    else if (ui.nav.tab === 'solar') map.render(state, { targetPos: navTargetPos(), targetId: ui.nav.target?.id, lockedId: state.sensors.locked });
    else if (ui.nav.tab === 'scanner') scanner.render(state);
    else if (ui.nav.tab === 'combat') {
      threat.render(state);
      show($('#combat-panel'), !stanceOpen(), 'flex');
      if (performance.now() - (ui.nav._fcAt || 0) > 250) { ui.nav._fcAt = performance.now(); renderFireControl(state, $('#combat-panel')); }
    }
    if (!routeUI && !stanceOpen() && (performance.now() - (ui.nav._selAt || 0) > 400)) { ui.nav._selAt = performance.now(); renderSelection(); }
    renderNavInfo(state, rel);
    renderRouteStatus(state, eta, $('#route-status'), true);
  }
  renderRouteStatus(state, eta, $('#route-mini'), false);
  renderPrompt(state);
  renderHold(state);
}

function renderNavInfo(state, rel) {
  const f = state.flight;
  const parts = [];
  if (ui.nav.tab === 'scanner') {
    const b = SENSOR_RANGES[state.sensors.range];
    parts.push(`${b.name} · ${state.sensors.contacts.length} contacts`);
    if (state.sensors.locked) parts.push(`LOCK ${esc(contactById(state, state.sensors.locked)?.name || 'contact')}`);
  } else if (ui.nav.tab === 'combat') {
    const tgt = state.combat.target && getWorld(state).get(state.combat.target);
    parts.push(state.combatStations ? 'BATTLE STATIONS' : 'CONDITION GREEN', `PDC ${state.combat.pdc.toUpperCase()}`, `AIM ${state.combat.aim.toUpperCase()}`);
    if (tgt) parts.push(`TARGET ${esc(tgt.transponder ? tgt.name : 'contact')}`);
  } else if (ui.nav.tab === 'solar') {
    parts.push(`SUN ${Math.hypot(f.pos.x, f.pos.y).toFixed(3)} AU`, `HELIO V ${fmtSpeed(Math.hypot(f.vel.vx, f.vel.vy))}`);
    parts.push(`LIVE ${state.sensors.contacts.length} · PLOT ${fmtNum(Object.keys(state.intel?.tracks || {}).length, 0)}`);
    const dg = Object.values(state.intel?.digests || {}).sort((a, b) => b.issued - a.issued)[0];
    if (dg) parts.push(`LAST DIGEST ${esc(dg.name)} · ${ageLabel(state.clock.minute - dg.issued)} old`);
  } else {
    parts.push(f.thrustG > 0.02 ? `BURN ${fmtG(f.thrustG)}` : 'DRIVE COLD');
    if (rel) parts.push(`${esc(rel.name)} ${fmtMeters(rel.dist)} · ${fmtSpeed(rel.speed)}`);
  }
  setHTML($('#nav-info'), parts.map(p => `<span>${p}</span>`).join('<span class="tac-info-sep">·</span>'));
}

const PHASE_LABEL = { prepare: 'SECURING', held: 'FLIP HELD', burn: 'BURN', brake: 'BRAKE', coast: 'COAST', approach: 'RCS APPROACH', flip: 'FLIP', orient: 'ORIENT', 'transfer-burn': 'TRANSFER BURN' };

function renderRouteStatus(state, eta, box, full) {
  const ap = state.autopilot;
  const visible = !!ap && (full || ap.phase !== 'prepare');    // the prepare prompt covers that phase
  show(box, visible, 'flex');
  if (!visible) return;
  if (ap.plan.kind === 'stance') { renderStanceStatus(state, eta, box, full); return; }
  const name = targetName(state, ap.plan.target);
  const dist = ap.d != null ? Math.max(0, ap.d - ap.plan.standoff) : null;
  const tp = targetStateAt(state, ap.plan.target, state.clock.minute)?.pos;
  const total = tp ? Math.hypot(ap.startPos.x - tp.x, ap.startPos.y - tp.y) * AU_M : 0;
  const frac = dist != null && total > 0 ? Math.max(0, Math.min(1, 1 - dist / total)) : 0;
  const etaTxt = eta?.minutes != null ? formatDuration(eta.minutes) : '—';
  const phase = ap.helm === 'unmanned' ? 'HELM UNMANNED — COASTING' : (PHASE_LABEL[ap.display] || ap.display.toUpperCase()) + (ap.helm === 'manual' ? ` · HAND-FLOWN (${ap.helmBy})` : ap.helm === 'degraded' ? ' · GUIDANCE DEGRADED' : '');
  const flip = ap.flipIn !== Infinity && ap.flipIn < 120 && (ap.display === 'burn' || ap.display === 'coast') ? ` · flip in ${formatDuration(ap.flipIn)}` : '';
  const html = `<div class="route-status-summary">
      <span class="route-status-dest">→ ${esc(name)}</span>
      <span class="route-status-phase phase-${ap.helm === 'unmanned' ? 'unmanned' : ap.display}">${esc(phase)}${flip}</span>
      <div class="route-status-progress"><div class="route-status-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>
      <span class="route-status-eta">${dist != null ? fmtMeters(dist) + ' · ' : ''}${fmtSpeed(ap.relSpeed)} · ETA ${etaTxt}</span>
      ${full ? '' : '<button class="route-zoom-btn" data-act="open-nav">MAP</button>'}
      <button class="route-abort-btn" data-act="abort">ABORT</button>
    </div>`;
  setHTML(box, html);
}

/** A stance in the status bar: the order, where it stands, the range now. */
function renderStanceStatus(state, eta, box, full) {
  const ap = state.autopilot, plan = ap.plan;
  const name = targetName(state, plan.target);
  const rel = relativeTo(state, plan.target);
  const phase = ap.helm === 'unmanned' ? 'HELM UNMANNED — COASTING' : (STANCE_PHASE[ap.display] || ap.display.toUpperCase()) + (ap.helm === 'manual' ? ` · HAND-FLOWN (${ap.helmBy})` : ap.helm === 'degraded' ? ' · GUIDANCE DEGRADED' : '');
  const moving = !ap.settled && ap.phase === 'active' && ap.display !== 'evade';
  const etaTxt = moving && eta?.minutes != null && eta.minutes > 0 ? ` · in place in ${formatDuration(eta.minutes)}` : '';
  setHTML(box, `<div class="route-status-summary">
      <span class="route-status-dest">◎ ${esc(STANCE_MODES[plan.mode].label)} ${fmtMeters(plan.standoff)} · ${esc(name)}</span>
      <span class="route-status-phase phase-${ap.helm === 'unmanned' ? 'unmanned' : ap.display}">${esc(phase)}</span>
      <span class="route-status-eta">${rel ? `range ${fmtMeters(rel.dist)} · rel ${fmtSpeed(rel.speed)}` : ''}${etaTxt}</span>
      <button class="route-zoom-btn" data-act="stance-edit">STANCE</button>
      <button class="route-abort-btn" data-act="release">RELEASE</button>
    </div>`);
}

function renderPrompt(state) {
  const box = $('#nav-prompt');
  const ap = state.autopilot;
  const held = ap?.turnHeld != null;
  const on = ap?.phase === 'prepare' || held;
  show(box, on, 'flex');
  if (!on) return;
  const st = crewSecureStatus(state);
  if (held) { renderHeldPrompt(state, box, st); return; }
  const dots = state.ship.crew.filter(isConscious).map(m => {
    const ok = isSecured(m);
    const p = st.pilot === m;
    return `<span class="mp-dot ${ok ? 'mp-dot-ok' : 'mp-dot-wait'} ${p ? 'mp-dot-pilot' : ''}" title="${esc(m.name)} — ${ok ? 'secured' : m.activity}">${p ? 'P' : '·'}</span>`;
  }).join('');
  const unsecured = st.total - st.secured;
  const fcDown = flightComputerState(state) === 'failed';
  const status = !st.pilot ? `<span class="mp-status mp-caution">${fcDown ? 'NO PILOT — AND NO FLIGHT COMPUTER' : 'NO PILOT — computer flight'}</span>`
    : !st.pilotReady ? `<span class="mp-status mp-waiting">${fcDown ? 'FLIGHT COMPUTER DOWN — ' : ''}${esc(st.pilot.name.toUpperCase())} EN ROUTE TO HELM</span>`
    : unsecured > 0 ? `<span class="mp-status mp-caution">${unsecured} CREW UNSECURED</span>`
    : '<span class="mp-status mp-ready">ALL HANDS SECURED</span>';
  const helpless = st.helpless.length ? `<span class="mp-status mp-caution">${st.helpless.length} INCAPACITATED — WILL RIDE UNSECURED</span>` : '';
  const canEngage = st.pilotReady || (!st.pilot && !fcDown);
  setHTML(box, `<div class="mp-header">SECURE FOR BURN → ${esc(targetName(state, ap.plan.target))}</div>
    <div class="mp-crew-row">${dots}</div>${status}${helpless}
    <div class="mp-actions">
      <button class="mp-engage-btn" data-act="engage" ${canEngage && !ap.override ? '' : 'disabled'}>${ap.override ? 'ENGAGING…' : canEngage ? 'EXECUTE NOW' : 'WAITING FOR PILOT'}</button>
      <button class="route-abort-btn" data-act="abort">ABORT</button>
    </div>`);
}

function renderHold(state) {
  const box = $('#hold-indicator');
  const h = state.flight.hold;
  const show_ = !!h && !state.autopilot && h.kind === 'entity';
  show(box, show_, 'flex');
  if (!show_) return;
  const e = getWorld(state).get(h.id);
  if (!e) return;
  const docked = dockedStation(state);
  const d = Math.hypot(h.ox, h.oy);
  const label = docked ? 'DOCKED' : e.type === 'station' ? 'HOLDING' : 'FORMATION';
  const mission = missionForEntity(state, e.id);
  const contract = state.contracts.active.find(c => c.targetId === e.id && c.phase === 'active');
  const hailable = inRadio(state, e.id) || d < RANGE.FORMATION_M * 5;
  setHTML(box, `<span class="formation-icon">◈</span>
    <span class="formation-label">${label}</span>
    <span class="formation-target">${esc(e.transponder || e.type === 'station' ? e.name : 'unidentified hull')} · ${fmtMeters(d)}</span>
    ${docked ? '<button class="formation-hail-btn" data-act="station">STATION</button>' : ''}
    ${!docked && hailable ? `<button class="formation-hail-btn" data-act="hail-hold">${mission ? 'COMPLETE RESCUE' : contract ? 'HAIL' : 'HAIL'}</button>` : ''}`);
  const b = box.querySelector('[data-act="hail-hold"]');
  if (b) b.onclick = (ev) => { ev.stopPropagation(); hooks.hail(e.id); };
}

export function resetNavForGame() {
  ui.nav.target = null;
  ui.nav.modalZoomSet = false;
  routeUI = null;
  closeStance();
  etaCache = { at: 0, key: '' };
  if (map) { map._init = false; map.selected = null; map.preview = null; map.routePath = null; }
  setTacZoom(0);
  closeNav();
}
