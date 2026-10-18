// ============================================================
// LONGHAUL — Navigation UI
// Nav modal (tactical / solar / scanner), target selection, route
// planning, route status, the "secure for burn" prompt, and the
// station-keeping indicator.
// ============================================================

import { ui } from './context.js';
import { $, $$, esc, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtKm, fmtG, fmtNum, fmtAngle } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M, AU_KM, RANGE } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getBody } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { planRoutes, simulatePlan, targetStateAt, targetName, defaultStandoff, STANDOFF, PREP_MINUTES } from '../sim/nav.js';
import { engageRoute, abortRoute, overrideSecure } from '../sim/autopilot.js';
import { crewSecureStatus } from '../sim/crew-ai.js';
import { isConscious } from '../sim/crew.js';
import { SENSOR_RANGES, REVEAL, setSensorRange, selectContact, toggleLock, contactById } from '../sim/sensors.js';
import { missionForEntity } from '../sim/missions.js';
import { dockedStation } from '../sim/contracts.js';
import { bus } from '../core/events.js';
import { TacView, TAC_LABELS } from './tac.js';
import { SolarMap } from './solar-map.js';
import { ScannerView } from './scanner.js';
import { relativeTo, velocityReference } from './hud.js';

let tacModal = null, map = null, scanner = null, tacSmall = null;
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
}

export function toggleNav(tab) {
  if (ui.nav.open && ui.nav.tab === tab) closeNav(); else openNav(tab);
}

function setTab(tab) {
  ui.nav.tab = tab;
  $$('[data-nav-tab]').forEach(b => toggleClass(b, 'active', b.dataset.navTab === tab));
  $$('[data-nav-screen]').forEach(s => show(s, s.dataset.navScreen === tab));
  $$('[data-tab-controls]').forEach(c => show(c, c.dataset.tabControls === tab, 'flex'));
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
  return targetStateAt(ui.state, t, ui.state.clock.minute)?.pos || null;
}

function describeTarget(state, t) {
  if (t.kind === 'body') {
    const b = getBody(t.id);
    return { name: t.id, kind: b?.type === 'star' ? 'Star' : (b?.type || 'body').replace(/^\w/, c => c.toUpperCase()), faction: null };
  }
  const e = getWorld(state).get(t.id);
  if (!e) return null;
  const c = contactById(state, e.id);
  const known = e.transponder || (c && c.name) || e.type === 'station' || e.type === 'nav';
  return {
    name: known ? e.name : (c?.signature || 'Unidentified contact'),
    kind: e.type === 'station' ? (e.shipClass || 'Station') : e.type === 'nav' ? 'Navigation mark' : (known ? e.shipClass || 'Ship' : 'Unknown'),
    faction: known ? e.faction : null,
    entity: e,
  };
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
  if (!s || !t || routeUI) return;
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
      ${row('CLASS', esc(c.shipClass || '—'))}
      ${row('RANGE', fmtKm(c.dist * AU_KM))}
      ${row('REL SPEED', c.velocityKnown && rel ? fmtSpeed(rel.speed) : `scanning… ${Math.max(0, REVEAL.VELOCITY - c.scan)}m`)}
      ${row('BEARING', fmtAngle(c.bearing - s.flight.facing))}
      ${row('DRIVE', c.thrust || (c.scan < REVEAL.THRUST ? '…' : '—'), c.thrust && c.thrust !== 'COASTING' ? 'scanner-val-warn' : '')}
      ${row('MASS', c.mass ? fmtNum(c.mass / 1000, 1) + ' kt' : '…')}
      <div class="panel-actions">
        <button class="scanner-track-btn ${lock ? 'tracking' : ''}" data-act="lock">${lock ? 'UNLOCK' : 'LOCK'}</button>
        ${routing ? '<button class="scanner-intercept-btn intercepting" data-act="abort">ABORT INTERCEPT</button>' : '<button class="scanner-intercept-btn" data-act="plot">INTERCEPT</button>'}
        ${canHail ? '<button class="scanner-track-btn" data-act="hail">HAIL</button>' : ''}
      </div>`;
    setHTML(scanPanel, html);
    show(scanPanel, true);
    return;
  }

  if (ui.nav.tab !== 'solar') return;
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
      <button class="route-zoom-btn" data-act="focus">FOCUS</button>
      ${canHail ? '<button class="route-zoom-btn" data-act="hail">HAIL</button>' : ''}
    </div>`;
  setHTML(mapPanel, html);
  show(mapPanel, true);
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
    case 'station': hooks.openStation(); break;
    case 'open-nav': openNav('solar'); break;
  }
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
  if (s.autopilot && s.autopilot.plan.target.id === target.id) { toast('Already en route', 'info'); return; }
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
        ? `<div class="route-juice-note">☢ OVERDRIVE: high-dose juice ≈ ${crew * 2}+ med (${s.resources.medSupplies.current.toFixed(0)} aboard) · stroke risk · containment failure risk</div>`
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
    <div class="route-options">${cards}</div>
    <div class="route-panel-actions">
      <button class="btn btn-secondary route-btn" data-act="cancel">CANCEL</button>
      <button class="btn btn-primary route-btn" data-act="confirm" ${routeUI.selected < 0 ? 'disabled' : ''}>ENGAGE</button>
    </div>`);
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

function refreshEta(s) {
  const ap = s.autopilot;
  if (!ap) { etaCache.key = ''; return null; }
  const key = `${ap.plan.target.id}:${ap.createdAt}`;
  const now = performance.now();
  if (etaCache.key !== key || now - etaCache.at > 2500) {
    const est = simulatePlan(s, ap.plan, { pathPoints: 120 });
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
    if (!routeUI && (performance.now() - (ui.nav._selAt || 0) > 400)) { ui.nav._selAt = performance.now(); renderSelection(); }
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
  } else if (ui.nav.tab === 'solar') {
    parts.push(`SUN ${Math.hypot(f.pos.x, f.pos.y).toFixed(3)} AU`, `HELIO V ${fmtSpeed(Math.hypot(f.vel.vx, f.vel.vy))}`);
    parts.push('drag to pan · wheel to zoom · click to select');
  } else {
    parts.push(f.thrustG > 0.02 ? `BURN ${fmtG(f.thrustG)}` : 'DRIVE COLD');
    if (rel) parts.push(`${esc(rel.name)} ${fmtMeters(rel.dist)} · ${fmtSpeed(rel.speed)}`);
  }
  setHTML($('#nav-info'), parts.map(p => `<span>${p}</span>`).join('<span class="tac-info-sep">·</span>'));
}

const PHASE_LABEL = { prepare: 'SECURING', burn: 'BURN', brake: 'BRAKE', coast: 'COAST', approach: 'RCS APPROACH', flip: 'FLIP', orient: 'ORIENT', 'transfer-burn': 'TRANSFER BURN' };

function renderRouteStatus(state, eta, box, full) {
  const ap = state.autopilot;
  const visible = !!ap && (full || ap.phase !== 'prepare');    // the prepare prompt covers that phase
  show(box, visible, 'flex');
  if (!visible) return;
  const name = targetName(state, ap.plan.target);
  const dist = ap.d != null ? Math.max(0, ap.d - ap.plan.standoff) : null;
  const tp = targetStateAt(state, ap.plan.target, state.clock.minute)?.pos;
  const total = tp ? Math.hypot(ap.startPos.x - tp.x, ap.startPos.y - tp.y) * AU_M : 0;
  const frac = dist != null && total > 0 ? Math.max(0, Math.min(1, 1 - dist / total)) : 0;
  const etaTxt = eta?.minutes != null ? formatDuration(eta.minutes) : '—';
  const phase = PHASE_LABEL[ap.display] || ap.display.toUpperCase();
  const flip = ap.flipIn !== Infinity && ap.flipIn < 120 && (ap.display === 'burn' || ap.display === 'coast') ? ` · flip in ${formatDuration(ap.flipIn)}` : '';
  const html = `<div class="route-status-summary">
      <span class="route-status-dest">→ ${esc(name)}</span>
      <span class="route-status-phase phase-${ap.display}">${phase}${flip}</span>
      <div class="route-status-progress"><div class="route-status-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>
      <span class="route-status-eta">${dist != null ? fmtMeters(dist) + ' · ' : ''}${fmtSpeed(ap.relSpeed)} · ETA ${etaTxt}</span>
      ${full ? '' : '<button class="route-zoom-btn" data-act="open-nav">MAP</button>'}
      <button class="route-abort-btn" data-act="abort">ABORT</button>
    </div>`;
  setHTML(box, html);
}

function renderPrompt(state) {
  const box = $('#nav-prompt');
  const ap = state.autopilot;
  const on = ap?.phase === 'prepare';
  show(box, on, 'flex');
  if (!on) return;
  const st = crewSecureStatus(state);
  const dots = state.ship.crew.filter(isConscious).map(m => {
    const ok = !!m.seat;
    const p = st.pilot === m;
    return `<span class="mp-dot ${ok ? 'mp-dot-ok' : 'mp-dot-wait'} ${p ? 'mp-dot-pilot' : ''}" title="${esc(m.name)} — ${ok ? 'secured' : m.activity}">${p ? 'P' : '·'}</span>`;
  }).join('');
  const unsecured = st.total - st.secured;
  const status = !st.pilot ? '<span class="mp-status mp-caution">NO PILOT — computer flight</span>'
    : !st.pilotReady ? `<span class="mp-status mp-waiting">${esc(st.pilot.name.toUpperCase())} EN ROUTE TO HELM</span>`
    : unsecured > 0 ? `<span class="mp-status mp-caution">${unsecured} CREW UNSECURED</span>`
    : '<span class="mp-status mp-ready">ALL HANDS SECURED</span>';
  const helpless = st.helpless.length ? `<span class="mp-status mp-caution">${st.helpless.length} INCAPACITATED — WILL RIDE UNSECURED</span>` : '';
  const canEngage = st.pilotReady || !st.pilot;
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
  etaCache = { at: 0, key: '' };
  if (map) { map._init = false; map.selected = null; map.preview = null; map.routePath = null; }
  setTacZoom(0);
  closeNav();
}
