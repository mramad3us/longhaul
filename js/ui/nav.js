// ============================================================
// LONGHAUL — Navigation UI: the console's main view
// The ship's displays (the system, local space, the scanner, weapons,
// and the exterior cameras' tab: stage.js), what is selected on them
// (an overlay card on the display, the full picture in the CONTEXT
// panel), route planning (the ROUTE panel), route and stance status,
// the "secure for burn" prompt, and the station-keeping indicator. The
// stance panel (stance.js) shares the route panel's slot. A ship that
// isn't on our board is shown as what the plot reports of it (intel.js),
// never as it is.
// ============================================================

import { ui } from './context.js';
import { $, $$, esc, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtKm, fmtG, fmtNum, fmtAngle } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M, AU_KM, RANGE, DAY_MIN } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getBody, BODIES } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { planRoutes, simulatePlan, targetStateAt, targetName, defaultStandoff, STANDOFF, PREP_MINUTES } from '../sim/nav.js';
import { engageRoute, abortRoute, overrideSecure, forceTurn, TURN_HOLD_MAX_MIN } from '../sim/autopilot.js';
import { crewSecureStatus, isSecured } from '../sim/crew-ai.js';
import { driveLimitG, systemPerf, flightComputerState } from '../sim/systems.js';
import { isConscious } from '../sim/crew.js';
import { SENSOR_RANGES, REVEAL, setSensorRange, selectContact, toggleLock, contactById } from '../sim/sensors.js';
import { missionForEntity } from '../sim/missions.js';
import { dockedStation } from '../sim/contracts.js';
import { beginDocking, shipDockable, isDocked, dockedTo } from '../sim/docking.js';
import { boardable } from '../sim/boarding.js';
import { clearanceFor, requestDeparture } from '../sim/traffic-control.js';
import { knownCrew } from '../sim/manifest.js';
import { hullOf, portSummary } from '../sim/hulls.js';
import { CLASSES } from '../sim/ship-classes.js';
import { drawHullPortrait } from './hull-art.js';
import { factionColor, FACTIONS } from '../sim/factions.js';
import { bus } from '../core/events.js';
import { TacView, TAC_LABELS } from './tac.js';
import { SolarMap, ageLabel } from './solar-map.js';
import { trackOf, estimate, describeRecord, liveKnowledge } from '../sim/intel.js';
import { ScannerView } from './scanner.js';
import { relativeTo, velocityReference, STANCE_PHASE } from './hud.js';
import { initStance, openStance, closeStance, stanceOpen, release as releaseStance } from './stance.js';
import { STANCE_MODES } from '../sim/stance.js';
import { ThreatView, renderFireControl, onFireControlClick, targetContact } from './combat.js';

let tacModal = null, map = null, scanner = null, threat = null;
let routeUI = null;          // { target, standoffKey, options, selected, computing }
let etaCache = { at: 0, key: '', minutes: null, path: null };
let hooks = {};

export function initNav(h) {
  hooks = h;   // { hail(entityId), openStation(), board(id), dock(target), showPanel(id) }
  tacModal = new TacView($('[data-nav-screen="tactical"]'), { onSelect: (id) => selectOnBoard(id) });
  map = new SolarMap($('[data-nav-screen="solar"]'), {
    onSelect: (sel) => { ui.nav.target = sel; ui.nav.card = !!sel; hidePickList(); renderSelection(); },
    onPickList: (cands, sx, sy) => showPickList(cands, sx, sy),
  });
  $$('[data-solar-filter]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.solarFilter; map.filter[k] = !map.filter[k]; toggleClass(b, 'active', map.filter[k]); }));
  initSearch();
  $('#map-picklist').addEventListener('click', (e) => {
    const r = e.target.closest('[data-pick]');
    if (r) choose(JSON.parse(r.dataset.pick));
  });
  scanner = new ScannerView($('[data-nav-screen="scanner"]'), { onSelect: (id) => selectOnBoard(id) });

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

  // Delegated actions inside panels
  for (const id of ['#map-selection', '#scanner-detail', '#route-panel', '#route-status', '#route-mini', '#nav-prompt', '#hold-indicator', '#map-card']) {
    $(id).addEventListener('click', onPanelClick);
  }
  bus.on('route-arrived', () => { etaCache.key = ''; });
  initStance({
    preview: (path) => { if (map) map.preview = path; },
    closed: () => renderSelection(),
  });
}

/** The main view shows one of the ship's displays: bring one up. */
export function openNav(tab = ui.nav.tab) {
  if (!ui.state) return;
  if (ui.state.reactor.blackout) toast('No power — displays dark', 'danger');
  ui.nav.open = true;
  if (!ui.nav.modalZoomSet) { tacModal.zoom = ui.nav.modalZoom || 0; ui.nav.modalZoomSet = true; }
  setTab(tab);
}

/** Put away what is laid over the displays: the route planner, a stance, the card. */
export function closeNav() {
  hideRoutePanel();
  closeStance();
  ui.nav.card = false;
  show($('#map-card'), false);
}

/** A display's key: bring it up, or (pressed again) go back to the system. */
export function toggleNav(tab) {
  openNav(ui.nav.tab === tab && tab !== 'solar' ? 'solar' : tab);
}

export const currentTab = () => ui.nav.tab;

export function setTab(tab) {
  ui.nav.tab = tab;
  const screens = $('#mv-screens');
  if (screens) screens.dataset.tab = tab;
  $$('[data-nav-tab]').forEach(b => toggleClass(b, 'active', b.dataset.navTab === tab));
  $$('[data-nav-screen]').forEach(s => show(s, s.dataset.navScreen === tab));
  $$('[data-tab-controls]').forEach(c => show(c, c.dataset.tabControls === tab, 'flex'));
  show($('#combat-panel'), tab === 'combat' && !stanceOpen(), 'flex');
  if (tab === 'solar' && !map._init) { map._init = true; requestAnimationFrame(() => map.setView('ship', ui.state)); }
  syncButtons();
  renderSelection();
  window.dispatchEvent(new Event('resize'));
}

function syncButtons() {
  $$('[data-tac-zoom-modal]').forEach(b => toggleClass(b, 'active', +b.dataset.tacZoomModal === ui.nav.modalZoom));
  if (ui.state) $$('[data-scanner-range]').forEach(b => toggleClass(b, 'active', +b.dataset.scannerRange === ui.state.sensors.range));
}

/** A contact picked on the scanner or the tactical view (null: clicked on nothing). */
function selectOnBoard(id) {
  if (!ui.state) return;
  selectContact(ui.state, id);
  ui.nav.target = id ? { kind: 'entity', id } : null;
  ui.nav.card = !!id;
  hideRoutePanel();
  renderSelection();
}

/** Show a contact selected (a hull clicked in the exterior view): its details, on whatever display is up. */
export function showOnBoard(id) {
  selectOnBoard(id);
  hooks.showPanel?.('context');
}

/** Select something from elsewhere (the AI line, a log entry): it shows on the system display. */
export function selectTarget(t) {
  if (!ui.state || !t) return;
  if (ui.nav.tab !== 'solar' && ui.nav.tab !== 'tactical' && ui.nav.tab !== 'scanner') openNav('solar');
  choose(t);
}

// ---- FINDING THINGS ON THE MAP ----
// A station under a crowd of traffic, a ship whose name we know: the pick
// list offers everything under the pointer, and the search box finds by
// name what we know of (bodies, stations, contacts, the plot's reports).

function choose(t) {
  hidePickList();
  hideSearch();
  if (!ui.state || !t) return;
  ui.nav.target = t;
  ui.nav.card = true;
  map.selected = t;
  if (t.kind === 'entity') selectContact(ui.state, t.id);
  const p = navTargetPos();
  if (p) map.focusOn(p, t.kind === 'entity' ? Math.max(map.scale, 2e6) : Math.max(map.scale, 300));
  renderSelection();
}

function labelOf(state, t) {
  const d = describeTarget(state, t);
  return d ? { name: d.name, kind: `${d.kind}${d.report ? ' · reported' : ''}` } : { name: t.id, kind: '' };
}

function showPickList(cands, sx, sy) {
  const s = ui.state;
  const box = $('#map-picklist');
  const rows = cands.slice(0, 14).map(t => { const l = labelOf(s, t); return `<div class="ss-row" data-pick='${esc(JSON.stringify({ kind: t.kind, id: t.id }))}'><span>${esc(l.name)}</span><small>${esc(l.kind)}</small></div>`; }).join('');
  box.innerHTML = `<div class="ss-head">${cands.length} HERE — PICK ONE</div>${rows}`;
  const host = box.parentElement.getBoundingClientRect(), screen = $('[data-nav-screen="solar"]').getBoundingClientRect();
  box.style.left = `${Math.min(screen.left - host.left + sx + 12, host.width - 280)}px`;
  box.style.top = `${Math.min(screen.top - host.top + sy + 12, host.height - 200)}px`;
  show(box, true);
}

function hidePickList() { show($('#map-picklist'), false); }

let searchHits = [], searchSel = 0;

function initSearch() {
  const input = $('#solar-search');
  input.addEventListener('input', () => { searchSel = 0; runSearch(input.value); });
  input.addEventListener('focus', () => { if (input.value) runSearch(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { searchSel = Math.min(searchHits.length - 1, searchSel + 1); renderSearch(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { searchSel = Math.max(0, searchSel - 1); renderSearch(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (searchHits[searchSel]) choose(searchHits[searchSel].t); e.preventDefault(); }
    else if (e.key === 'Escape') { input.value = ''; hideSearch(); input.blur(); e.stopPropagation(); }
  });
  $('#solar-search-results').addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) choose(searchHits[+r.dataset.i]?.t); });
}

/** What we know of by name: bodies and stations always, ships on our board, reports on the plot. */
function runSearch(q) {
  const s = ui.state;
  q = q.trim().toLowerCase();
  searchHits = [];
  if (!s || q.length < 2) { hideSearch(); return; }
  const world = getWorld(s);
  const hits = [];
  const add = (t, name, kind, rank) => {
    const n = name.toLowerCase();
    const i = n.indexOf(q);
    if (i < 0) return;
    hits.push({ t, name, kind, score: rank + (i === 0 ? 0 : 1) + n.length / 100 });
  };
  for (const b of BODIES) add({ kind: 'body', id: b.name }, b.name, b.type, 1);
  for (const st of world.stations) add({ kind: 'entity', id: st.id }, st.name, st.shipClass || 'station', 0);
  for (const c of s.sensors.contacts) if (c.name && !c.station) add({ kind: 'entity', id: c.id }, c.name, `${c.shipClass || 'ship'} · on sensors`, 2);
  const tracks = s.intel?.tracks || {};
  let n = 0;
  for (const id in tracks) { const r = tracks[id]; if (r.name && n < 4000) { n++; add({ kind: 'entity', id }, r.name, `${r.shipClass || 'ship'} · reported`, 3); } }
  for (const c of s.contracts.active) { const e = world.get(c.targetId); if (e) add({ kind: 'entity', id: e.id }, e.name, 'contract target', 1); }
  const seen = new Set();
  searchHits = hits.sort((a, b) => a.score - b.score).filter(h => { const k = h.t.kind + h.t.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
  renderSearch();
}

function renderSearch() {
  const box = $('#solar-search-results');
  if (!searchHits.length) { box.innerHTML = '<div class="ss-head">nothing by that name</div>'; show(box, true); return; }
  box.innerHTML = searchHits.map((h, i) => `<div class="ss-row ${i === searchSel ? 'active' : ''}" data-i="${i}"><span>${esc(h.name)}</span><small>${esc(h.kind)}</small></div>`).join('');
  show(box, true);
}

function hideSearch() { show($('#solar-search-results'), false); }

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

/** The display's tooltip for what the pointer is on: its name, and what it is. */
function hoverLabel(h) {
  const s = ui.state;
  const d = s && describeTarget(s, h);
  return d ? `${d.name} · ${d.kind}${d.report ? ' (reported)' : ''}` : null;
}

// ---- THE CARD ON THE DISPLAY ----
// What is selected on the system display gets a card beside it: what it
// is, how far, how old our picture of it is, and the two or three things
// to do about it. The full picture is in the CONTEXT panel.

let cardKey = '', cardAt = 0;

function renderMapCard(state) {
  const box = $('#map-card');
  const t = ui.nav.target;
  const p = ui.nav.tab === 'solar' && ui.nav.card && t && !routeUI && !stanceOpen() ? navTargetPos() : null;
  if (!p) { show(box, false); cardKey = ''; return; }
  // (beside the object as the display draws it: a far station's mark can be the background pass's last fix)
  const drawnAt = map._pickables.find(q => q.kind === t.kind && q.id === t.id);
  const sp = drawnAt ? { sx: drawnAt.sx, sy: drawnAt.sy } : map.toScreen(p.x, p.y);
  const W = map.fc.w, H = map.fc.h;
  if (sp.sx < 0 || sp.sy < 0 || sp.sx > W || sp.sy > H) { show(box, false); return; }
  // Content refreshes a few times a second; position every frame (the map pans and the world moves)
  const now = performance.now();
  const key = `${t.kind}:${t.id}`;
  if (key !== cardKey || now - cardAt > 300) { cardKey = key; cardAt = now; setHTML(box, cardHTML(state, t)); }
  show(box, true);
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const flipX = sp.sx + 22 + bw > W - 8, flipY = sp.sy + 14 + bh > H - 8;
  toggleClass(box, 'flip-x', flipX);
  toggleClass(box, 'flip-y', flipY);
  box.style.left = `${Math.round(flipX ? sp.sx - 22 - bw : sp.sx + 22)}px`;
  box.style.top = `${Math.round(flipY ? sp.sy - 14 - bh : sp.sy + 14)}px`;
}

function cardHTML(s, t) {
  const d = describeTarget(s, t);
  if (!d) return '';
  const rel = d.report ? null : relativeTo(s, t);
  const ap = s.autopilot;
  const routing = ap && ap.plan.target.id === t.id;
  const e = d.entity;
  const facts = [];
  if (d.report) {
    const info = describeRecord(s, d.report);
    facts.push(['REPORTED', `${ageLabel(info.ageMin)} ago · ${esc(info.src)}`]);
  } else if (rel) {
    facts.push(['RANGE', fmtMeters(rel.dist)], ['REL V', fmtSpeed(rel.speed)]);
    const lag = rel.dist / 299_792_458;
    if (lag > 1) facts.push(['LIGHT', lag < 60 ? `${lag.toFixed(0)} s` : `${(lag / 60).toFixed(1)} min`]);
  }
  if (routing && etaCache.minutes != null) facts.push(['ETA', formatDuration(etaCache.minutes)]);
  const acts = [];
  if (routing) acts.push('<button class="btn-mini warn" data-act="abort">ABORT</button>');
  else if (t.id !== 'Sol' && !(d.report && d.report.kind === 'fix')) acts.push('<button class="btn-mini primary" data-act="plot">PLOT</button>');
  if (e && t.kind === 'entity' && (e.type === 'station' || e.type === 'ship') && !d.report) {
    const dockable = e.type === 'station' || shipDockable(s, e).ok;
    if (dockable && !(isDocked(s) && dockedTo(s)?.id === e.id)) acts.push('<button class="btn-mini" data-act="dock">DOCK</button>');
  }
  if (t.kind === 'entity' && inRadio(s, t.id)) acts.push('<button class="btn-mini" data-act="hail">HAIL</button>');
  acts.push('<button class="btn-mini" data-act="details" title="The full picture, in the CONTEXT panel">DETAILS</button>');
  const dot = d.faction ? `<i class="card-dot" style="background:${factionColor(d.faction)}"></i>` : '';
  return `<div class="card-head">${dot}<span class="card-name">${esc(d.name)}</span><button class="card-x" data-act="card-close" title="Close">✕</button></div>
    <div class="card-kind">${esc(d.kind)}${d.faction && d.faction !== 'independent' ? ` · ${esc(FACTIONS[d.faction]?.short || d.faction)}` : ''}${d.report ? ' · <span class="card-report">ON THE PLOT</span>' : ''}</div>
    ${facts.length ? `<div class="card-facts">${facts.map(([k, v]) => `<span><em>${k}</em> ${v}</span>`).join('')}</div>` : ''}
    <div class="card-acts">${acts.join('')}</div>`;
}

/** The plot's record for a target we can't see or chart right now (null if we can). */
function reportFor(state, t) {
  if (t?.kind !== 'entity') return null;
  const e = getWorld(state).get(t.id);
  if (e && liveKnowledge(state, e)) return null;
  return trackOf(state, t.id);
}

function describeTarget(state, t) {
  if (t.kind === 'slot') return { name: targetName(state, t), kind: 'Holding slot', faction: getWorld(state).get(t.id)?.faction || null, entity: null };
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

  if ((ui.nav.tab === 'scanner' || ui.nav.tab === 'tactical') && t.kind === 'entity') {
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
      ${shipRows(s, d.entity, c, row)}
      <div class="panel-actions">
        <button class="scanner-track-btn ${lock ? 'tracking' : ''}" data-act="lock">${lock ? 'UNLOCK' : 'LOCK'}</button>
        ${routing ? '<button class="scanner-intercept-btn intercepting" data-act="abort">ABORT INTERCEPT</button>' : '<button class="scanner-intercept-btn" data-act="plot">INTERCEPT</button>'}
        ${canHail ? '<button class="scanner-track-btn" data-act="hail">HAIL</button>' : ''}
        ${!c.ordnance ? '<button class="scanner-track-btn" data-act="stance">STANCE</button>' : ''}
        ${!c.ordnance ? `<button class="scanner-track-btn ${s.combat.target === t.id ? 'tracking' : ''}" data-act="target">${s.combat.target === t.id ? 'TARGETED' : 'TARGET'}</button>` : ''}
        ${dockButton(s, d.entity)}
        ${!c.ordnance && !c.station && boardable(s, d.entity).ok ? `<button class="scanner-track-btn" data-act="board">${d.entity?.tags?.wreck ? 'SALVAGE' : 'BOARD'}</button>` : ''}
      </div>`;
    if (setHTML(scanPanel, html)) {
      const cv = scanPanel.querySelector('canvas[data-hull]');
      if (cv) drawHullPortrait(cv, hullOf(d.entity.cls), { tint: factionColor(d.entity.faction) });
    }
    show(scanPanel, true);
    return;
  }

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
    case 'details': hooks.showPanel?.('context'); ui.nav.card = false; show($('#map-card'), false); break;
    case 'card-close': ui.nav.card = false; show($('#map-card'), false); break;
    case 'stance': if (t) showStancePanel(t); break;
    case 'stance-edit': {
      const ap = s.autopilot;
      if (ap?.plan.kind !== 'stance') break;
      ui.nav.target = { ...ap.plan.target };
      showStancePanel(ap.plan.target);
      break;
    }
    case 'release': releaseStance(s); break;
    case 'target': if (t) { targetContact(s, t.id); setTab('combat'); } break;
    case 'hail': if (t) hooks.hail(t.id); break;
    case 'dock': if (t) { const e = getWorld(s).get(t.id); hooks.dock?.({ kind: e?.type === 'station' ? 'station' : 'ship', id: t.id }); } break;
    case 'board': if (t) hooks.board?.(t.id); break;
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
    case 'depart': { const r = requestDeparture(s, s.dock.target.id); toast(r.text, r.ok ? 'ok' : 'warn'); logEntry(r.text, 'comms'); renderRoutePanel(); break; }
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

/** What we know of a ship's hull and people, for the contact panel. */
function shipRows(s, e, c, row) {
  if (!e || e.type !== 'ship' || c.ordnance) return '';
  const known = !!c.name;
  const crew = knownCrew(s, e, { identified: known });
  const hull = known ? `<canvas class="scanner-detail-hull" width="260" height="60" data-hull="${e.id}"></canvas>` : '';
  // (a command ship says what it is: the forward command of its navy's fight)
  const cmd = known && e.tags?.command ? row('ROLE', `${esc(FACTIONS[e.faction]?.navy || '')} forward command · ${esc(e.tags.command.body)}`) : '';
  return `${hull}${cmd}${row('ABOARD', crew ? `${esc(crew.text)} <span class="scanner-val-dim">${esc(crew.src)}</span>` : 'unknown', crew ? '' : 'scanner-val-dim')}
    ${row('COLLARS', known ? esc(portSummary(e.cls)) : '—')}
    ${known && CLASSES[e.cls]?.atmo ? row('ATMOSPHERE', 'rated for entry') : ''}`;
}

/** DOCK on the contact panel: a station (traffic control must clear us), a ship that will hold for us. */
function dockButton(s, e) {
  if (!e || (e.type !== 'station' && e.type !== 'ship')) return '';
  if (isDocked(s) && dockedTo(s)?.id === e.id) return '';
  if (e.type === 'ship' && !shipDockable(s, e).ok) return '';
  return `<button class="scanner-track-btn" data-act="dock">DOCK</button>`;
}

/** The stance panel takes the slot of the route panel and the selection panels. */
function showStancePanel(target) {
  hideRoutePanel();
  show($('#map-selection'), false); show($('#scanner-detail'), false);
  openStance(target);
}

// ---- ROUTE PLANNING ----

const STANDOFFS = {
  dock: { label: 'DOCK', m: STANDOFF.GATE, desc: 'To the station\'s approach gate, then down to a berth (traffic control must clear us)' },
  gate: { label: 'GATE', m: STANDOFF.GATE, desc: 'Hold at the approach gate, outside the keep-out zone' },
  rendezvous: { label: 'DOCK', m: 20_000, desc: 'Rendezvous, then the docking computer takes us to a collar (they must agree, or be in no state to refuse)' },
  formation: { label: 'FORMATION', m: STANDOFF.TACTICAL, desc: '2 km — boarding, tow, EVA' },
  close: { label: 'CLOSE', m: STANDOFF.CLOSE, desc: '100,000 km — full sensor lock' },
  scanner: { label: 'SCANNER', m: STANDOFF.SCANNER, desc: '15M km — inside long-range sensors' },
  orbit: { label: 'ORBIT', m: null, desc: 'Parking orbit' },
  slot: { label: 'HOLD', m: STANDOFF.SLOT, desc: 'Into our slot in the holding pattern: a free orbit, in port, no fuel to keep it' },
};

function standoffChoices(state, t) {
  if (t.kind === 'body') return ['orbit', 'close'];
  if (t.kind === 'slot') return ['slot'];
  const e = getWorld(state).get(t.id);
  if (e?.type === 'station') return ['dock', 'gate', 'close', 'scanner'];
  if (e?.type === 'ship') return ['formation', 'rendezvous', 'close', 'scanner'];
  return ['formation', 'close', 'scanner'];
}

export function openRoutePanel(target, opts = {}) {
  const s = ui.state;
  if (!s) return;
  if (s.autopilot && s.autopilot.plan.kind !== 'stance' && s.autopilot.plan.target.id === target.id) { toast('Already en route', 'info'); return; }
  closeStance();
  ui.nav.target = target;
  if (ui.nav.tab === 'exterior' || ui.nav.tab === 'combat') openNav(target.kind === 'entity' && contactById(s, target.id) ? 'scanner' : 'solar');
  const choices = standoffChoices(s, target);
  const key = opts.dock && choices.includes('dock') ? 'dock' : opts.dock && choices.includes('rendezvous') ? 'rendezvous' : choices[0];
  routeUI = { target, choices, standoffKey: key, options: [], selected: -1, computing: true };
  show($('#map-selection'), false); show($('#scanner-detail'), false);
  show($('#route-panel'), true, 'flex');
  hooks.showPanel?.('route');
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
        <div class="route-card-desc">${esc(o.desc)}${o.departMin ? ` Includes about ${formatDuration(o.departMin)} leaving port on RCS.` : ''}</div>
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
    ${departureNote(s)}
    <div class="route-options">${cards}</div>
    <div class="route-panel-actions">
      <button class="btn btn-secondary route-btn" data-act="cancel">CANCEL</button>
      <button class="btn btn-primary route-btn" data-act="confirm" ${routeUI.selected < 0 ? 'disabled' : ''}>ENGAGE</button>
    </div>`);
}

/** Docked without a departure clearance: undocking for the route will be cited (traffic-control.js). One click to ask. */
function departureNote(s) {
  const d = s.dock;
  if (d?.phase !== 'docked' || d.target.kind !== 'station' || clearanceFor(s, d.target.id).depart) return '';
  return `<div class="route-machinery route-depart-note"><span>⚠ No departure clearance: undocking for this route is a 200 MCR citation.</span><button class="btn btn-secondary route-btn" data-act="depart">REQUEST DEPARTURE</button></div>`;
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
  const e = t.kind === 'entity' ? getWorld(s).get(t.id) : null;
  if (routeUI.standoffKey === 'dock' || routeUI.standoffKey === 'rendezvous') {
    // A docking flight: the route to the gate (or alongside), then the docking computer
    const r = beginDocking(s, { kind: e?.type === 'station' ? 'station' : 'ship', id: t.id }, { mode: 'auto', route: opt.plan }, (type, p) => bus.emit(type, p));
    if (!r.ok) { toast(r.text, 'warn'); return; }
    logEntry(r.text, 'nav');
  } else engageRoute(s, opt.plan, { estimate: opt.estimate, missionId: mission?.id, intercept: routeUI.standoffKey });
  logEntry(`Course plotted: ${targetName(s, t)} — ${opt.name} (${opt.label}), ETA ${formatDuration(opt.minutes)}, ${fmtNum(opt.fuel)} kg`, 'nav');
  logEntry('All hands — secure for acceleration', 'nav');
  toast('SECURE FOR BURN', 'warn');
  etaCache.key = '';
  hideRoutePanel();
  renderSelection();
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

  const ref = velocityReference(state);
  const rel = ref ? relativeTo(state, ref.target) : null;
  {
    if (ui.nav.tab === 'tactical') tacModal.render(state, alpha, { reference: rel, highlight: ref?.target.id, selected: ui.nav.target?.id });
    else if (ui.nav.tab === 'solar') map.render(state, { targetPos: navTargetPos(), targetId: ui.nav.target?.id, lockedId: state.sensors.locked, hoverLabel });
    else if (ui.nav.tab === 'scanner') scanner.render(state);
    else if (ui.nav.tab === 'combat') {
      threat.render(state);
      show($('#combat-panel'), !stanceOpen(), 'flex');
      if (performance.now() - (ui.nav._fcAt || 0) > 250) { ui.nav._fcAt = performance.now(); renderFireControl(state, $('#combat-panel')); }
    }
    if (!routeUI && !stanceOpen() && (performance.now() - (ui.nav._selAt || 0) > 400)) { ui.nav._selAt = performance.now(); renderSelection(); }
    renderNavInfo(state, rel);
    renderRouteStatus(state, eta, $('#route-status'), true);
    show($('#route-idle'), !state.autopilot && !routeUI && !stanceOpen());
    renderMapCard(state);
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

const PHASE_LABEL = { depart: 'DEPARTING · RCS', prepare: 'SECURING', held: 'FLIP HELD', burn: 'BURN', brake: 'BRAKE', coast: 'COAST', approach: 'RCS APPROACH', flip: 'FLIP', orient: 'ORIENT', 'transfer-burn': 'TRANSFER BURN' };

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
  closeNav();
  ui.nav.tab = 'solar';
  openNav('solar');
}
