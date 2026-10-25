// ============================================================
// LONGHAUL — Navigation UI: the console's main view
// The ship's displays (the system, local space, the scanner, weapons,
// and the exterior cameras' tab: stage.js), what is selected on them
// (an overlay card on the display, the full picture in the CONTEXT
// panel), route planning (the ROUTE panel), route and stance status
// (the ROUTE panel in full; the flight band, beside its nav chip: the
// progress, the "secure for burn" prompt, the hold's buttons). The
// stance panel (stance.js) shares the route panel's slot. A ship that
// isn't on our board is shown as what the plot reports of it (intel.js),
// never as it is. The nav computer's marks (DARK, a mission's job, the
// captain's lettered flags: sim/flags.js, marks.js) go with a ship's name
// wherever it is listed; F (or FLAG on the card and the panel) flags what
// is picked, and the CONTEXT panel lists the flags. LOOK on a contact's
// card or panel, or a world's (or Z), puts the telescope on it (stage.js).
// A contact on the board has one sheet in the CONTEXT panel on every
// display (contactSheet): who it is, how it moves against us, its drive
// (the G it pulls, its thrust, its plume, its signature), what it is.
// Range and relative speed there, in the route's status, on the ship
// panel and on the telescope are all hud.js relativeTo's, at the sim's
// minute: one figure everywhere.
// ============================================================

import { bodySheet } from './bodysheet.js';
import { worldOf } from '../sim/worlds.js';
import { ui } from './context.js';
import { $, $$, esc, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtKm, fmtG, fmtNum, fmtAngle } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M, AU_KM, RANGE, DAY_MIN, G0 } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getBody, BODIES } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { planRoutes, simulatePlan, targetStateAt, targetName, defaultStandoff, STANDOFF, PREP_MINUTES } from '../sim/nav.js';
import { engageRoute, abortRoute, overrideSecure, forceTurn, TURN_HOLD_MAX_MIN } from '../sim/autopilot.js';
import { crewSecureStatus, isSecured } from '../sim/crew-ai.js';
import { driveLimitG, systemPerf, flightComputerState } from '../sim/systems.js';
import { isConscious } from '../sim/crew.js';
import { SENSOR_RANGES, REVEAL, setSensorRange, selectContact, toggleLock, contactById, isDark, signatureRange, hullSignature } from '../sim/sensors.js';
import { huntsFor, unconfirmed } from '../sim/hunts.js';
import { pointMag, PLUME_W_PER_N } from '../sim/telescope.js';
import { facingOf } from '../sim/docking.js';
import { toggleFlag, flagOf, flagList, clearFlags, missionTargets, knownName, FLAG_LETTERS } from '../sim/flags.js';
import { missionForEntity } from '../sim/missions.js';
import { dockedStation } from '../sim/contracts.js';
import { beginDocking, shipDockable, isDocked, dockedTo } from '../sim/docking.js';
import { boardable } from '../sim/boarding.js';
import { droneStatus } from '../sim/drones.js';
import { clearanceFor, requestDeparture } from '../sim/traffic-control.js';
import { knownCrew } from '../sim/manifest.js';
import { knownHold, holdWords } from '../sim/market.js';
import { flagOf as flagOfService } from '../sim/service.js';
import { commandOnStation } from '../sim/forces.js';
import { ZONE_KINDS } from '../sim/conflict.js';
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
import { frameMarks, marksOf, markChips, markWords } from './marks.js';

let tacModal = null, map = null, scanner = null, threat = null;
let routeUI = null;          // { target, standoffKey, options, selected, computing }
let etaCache = { at: 0, key: '', minutes: null, path: null };
let hooks = {};

export function initNav(h) {
  hooks = h;   // { hail(entityId), openStation(), board(id), dock(target), showPanel(id), look(target), shuttle(airspaceId) }
  tacModal = new TacView($('[data-nav-screen="tactical"]'), { onSelect: (id) => selectOnBoard(id) });
  map = new SolarMap($('[data-nav-screen="solar"]'), {
    onSelect: (sel) => { ui.nav.target = sel; ui.nav.card = !!sel; hidePickList(); renderSelection(); },
    onPickList: (cands, sx, sy) => showPickList(cands, sx, sy),
  });
  // The display bar's folded groups (a narrow bar): open on their button, shut on a pick (a view) or a click elsewhere
  $$('.mv-group-btn').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const g = b.parentElement, open = !g.classList.contains('open');
    $$('.mv-group.open').forEach(o => o.classList.remove('open'));
    g.classList.toggle('open', open);
  }));
  document.addEventListener('click', (e) => {
    for (const g of $$('.mv-group.open')) if (!g.contains(e.target) || (!g.classList.contains('mv-group-stay') && e.target.closest('.mv-group-items'))) g.classList.remove('open');
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
  for (const id of ['#map-selection', '#scanner-detail', '#route-panel', '#route-status', '#route-mini', '#nav-prompt', '#hold-indicator', '#map-card', '#ctx-flags']) {
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
// name what we know of (bodies, stations, contacts, the plot's reports),
// and only where we know it is: a ship we have neither on the board nor
// on the plot is not found, whatever its name (nor is a contact we have
// not identified, by the name it hides).

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

function labelOf(state, t, fm) {
  const d = describeTarget(state, t);
  return d ? { name: d.name, kind: `${d.kind}${d.report ? ' · reported' : ''}`, chips: markChips(marksFor(state, t, fm) || {}) } : { name: t.id, kind: '', chips: '' };
}

function showPickList(cands, sx, sy) {
  const s = ui.state;
  const box = $('#map-picklist');
  const fm = frameMarks(s);
  const rows = cands.slice(0, 14).map(t => { const l = labelOf(s, t, fm); return `<div class="ss-row" data-pick='${esc(JSON.stringify({ kind: t.kind, id: t.id }))}'><span>${esc(l.name)}${l.chips}</span><small>${esc(l.kind)}</small></div>`; }).join('');
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

/** What we know of by name, and where: bodies and stations always, ships on our board, reports on the plot, charted marks. */
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
  // what our work points at, where we know it is (a hunted ship once named and held; its last-seen mark)
  for (const [id, tag] of missionTargets(s)) {
    const e = world.get(id);
    const name = e && (liveKnowledge(s, e) || trackOf(s, id)) && knownName(s, id);
    if (name) add({ kind: 'entity', id }, name, `${tag.toLowerCase()} · mission`, 1);
  }
  const seen = new Set();
  searchHits = hits.sort((a, b) => a.score - b.score).filter(h => { const k = h.t.kind + h.t.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
  renderSearch();
}

function renderSearch() {
  const box = $('#solar-search-results');
  if (!searchHits.length) { box.innerHTML = '<div class="ss-head">nothing by that name</div>'; show(box, true); return; }
  const s = ui.state, fm = frameMarks(s);
  box.innerHTML = searchHits.map((h, i) => `<div class="ss-row ${i === searchSel ? 'active' : ''}" data-i="${i}"><span>${esc(h.name)}${h.t.kind === 'entity' ? markChips(marksFor(s, h.t, fm) || {}) : ''}</span><small>${esc(h.kind)}</small></div>`).join('');
  show(box, true);
}

function hideSearch() { show($('#solar-search-results'), false); }

// ---- TARGET HELPERS ----

/** Where the display puts what is picked: what we know of where it is (never where a ship we can't see really is). */
function navTargetPos() {
  const t = ui.nav.target;
  if (!t || !ui.state) return null;
  const r = reportFor(ui.state, t);
  if (r) {
    const est = estimate(ui.state, r, ui.state.clock.minute);
    return est ? { x: est.x, y: est.y } : null;
  }
  if (t.kind === 'entity') { const e = getWorld(ui.state).get(t.id); if (!e || !liveKnowledge(ui.state, e)) return null; }
  return targetStateAt(ui.state, t, ui.state.clock.minute)?.pos || null;
}

/** The display's tooltip for what the pointer is on: its name, and what it is. */
function hoverLabel(h) {
  const s = ui.state;
  const d = s && describeTarget(s, h);
  return d ? `${d.name} · ${d.kind}${d.report ? ' (reported)' : ''}${markWords(marksFor(s, h) || {})}` : null;
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
  if (key !== cardKey || now - cardAt > 300) {
    cardKey = key; cardAt = now;
    const html = cardHTML(state, t);
    setHTML(box, html);
    box.dataset.empty = html ? '' : '1';
  }
  // (nothing to say about it, e.g. a ship our sensors have lost: no card at all, not an empty frame)
  if (box.dataset.empty) { show(box, false); return; }
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
  else if (t.id !== 'Sol') acts.push('<button class="btn-mini primary" data-act="plot">PLOT</button>');
  if (e && t.kind === 'entity' && (e.type === 'station' || e.type === 'ship') && !d.report) {
    const dockable = e.type === 'station' || shipDockable(s, e).ok;
    if (dockable && !(isDocked(s) && dockedTo(s)?.id === e.id)) acts.push('<button class="btn-mini" data-act="dock">DOCK</button>');
  }
  if (t.kind === 'entity' && inRadio(s, t.id)) acts.push('<button class="btn-mini" data-act="hail">HAIL</button>');
  if ((t.kind === 'entity' && !d.report && contactById(s, t.id)) || t.kind === 'body') acts.push(lookButton('btn-mini'));
  if (flaggable(e)) acts.push(flagButton(s, t.id, 'btn-mini'));
  acts.push('<button class="btn-mini" data-act="details" title="The full picture, in the CONTEXT panel">DETAILS</button>');
  const dot = d.faction ? `<i class="card-dot" style="background:${factionColor(d.faction)}"></i>` : '';
  const chips = markChips(marksFor(s, t) || {});
  return `<div class="card-head">${dot}<span class="card-name">${esc(d.name)}</span><button class="card-x" data-act="card-close" title="Close">✕</button></div>
    <div class="card-kind">${esc(d.kind)}${d.faction && d.faction !== 'independent' ? ` · ${esc(FACTIONS[d.faction]?.short || d.faction)}` : ''}${d.report ? ' · <span class="card-report">ON THE PLOT</span>' : ''}</div>
    ${chips ? `<div class="card-marks">${chips}</div>` : ''}
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
  // (a route to a lost contact's last fix: the contact, as the plot has it)
  if (t.kind === 'fix') { const d = describeTarget(state, { kind: 'entity', id: t.id }); return d && { ...d, name: targetName(state, t) }; }
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
  // (on the board, by what the board knows; off it, charted: a contract's target on its published orbit)
  const known = c ? !!c.name : e.type === 'station' || e.type === 'nav' || liveKnowledge(state, e) === 'charted';
  return {
    name: known ? e.name : (c?.signature || 'Unidentified contact'),
    kind: e.type === 'station' ? (e.shipClass || 'Station') : e.type === 'nav' ? 'Navigation mark' : (known ? e.shipClass || 'Ship' : 'Unknown'),
    faction: known ? e.faction : null,
    entity: e,
  };
}

/** The nav computer's marks on what is picked, from what we know of it: the board, a chart, the plot (marks.js). */
function marksFor(state, t, fm = frameMarks(state)) {
  if (t?.kind !== 'entity') return null;
  const r = reportFor(state, t);
  if (r) return marksOf(fm, t.id, r.dark, r.wreck);
  const e = getWorld(state).get(t.id);
  return e ? marksOf(fm, t.id, isDark(e), e.tags?.wreck) : null;
}

/** Ships and stations take a flag (sim/flags.js). */
const flaggable = (e) => e?.type === 'ship' || e?.type === 'station';

function flagButton(state, id, cls) {
  const f = flagOf(state, id);
  return `<button class="${cls} ${f ? 'flagged' : ''}" data-act="flag" title="${f ? `Clear flag ${f}` : 'Flag it on every display'} (F)">${f ? `FLAG ${f} ✕` : 'FLAG'}</button>`;
}

/** LOOK: the telescope on the contact, or the world (stage.js). */
const lookButton = (cls) => `<button class="${cls}" data-act="look" title="The telescope on it, from here (Z)">LOOK</button>`;

/** Flag what is picked, or take its flag off (F). */
export function toggleFlagOnPick() {
  const s = ui.state, t = ui.nav.target;
  if (!s) return;
  if (t?.kind !== 'entity' || !flaggable(getWorld(s).get(t.id))) { toast('Pick a ship or a station to flag', 'warn'); return; }
  const r = toggleFlag(s, t.id);
  toast(r.text, r.ok ? 'ok' : 'warn');
  if (r.ok) logEntry(`Nav: ${r.text}`, 'nav');
  ui.nav._selAt = 0;
  cardKey = '';
  renderSelection();
}

/** The flags, A to Z, in the CONTEXT panel: what each is, where it was last, a click picks it. */
function renderFlags(state) {
  const box = $('#ctx-flags');
  if (!box) return;
  const list = flagList(state);
  if (!list.length) { setHTML(box, ''); show(box, false); return; }
  const now = state.clock.minute;
  const rows = list.map(f => {
    const t = { kind: 'entity', id: f.id };
    const d = describeTarget(state, t);
    const r = d?.report;
    const where = r ? `plot · ${ageLabel(now - r.at)} old` : d ? (() => { const rel = relativeTo(state, t); return rel ? fmtMeters(rel.dist) : 'charted'; })() : 'no track';
    const m = marksFor(state, t) || {};
    return `<div class="flag-row ${ui.nav.target?.id === f.id ? 'active' : ''}" data-act="flag-pick" data-id="${esc(f.id)}">
      <span class="mk mk-flag">${f.letter}</span><span class="flag-name">${esc(d?.name || f.name || 'Unidentified contact')}</span>${markChips({ ...m, flag: null })}
      <span class="flag-where">${esc(where)}</span><button class="flag-x" data-act="flag-clear" data-id="${esc(f.id)}" title="Clear flag ${f.letter}">✕</button></div>`;
  }).join('');
  setHTML(box, `<div class="sub-head">FLAGS <span class="flag-count">${list.length}/${FLAG_LETTERS.length}</span>${list.length > 1 ? '<button class="flag-clear-all" data-act="flag-clear-all" title="Clear every flag">CLEAR ALL</button>' : ''}</div>${rows}`);
  show(box, true);
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
  if (s) renderFlags(s);
  show(mapPanel, false); show(scanPanel, false);
  if (!s || !t || routeUI || stanceOpen()) return;
  const d = describeTarget(s, t);
  if (!d) return;
  const rel = relativeTo(s, t);
  const ap = s.autopilot;
  const routing = ap && ap.plan.target.id === t.id;
  const canHail = t.kind === 'entity' && inRadio(s, t.id);

  // A contact on the board: the whole sheet, on every display (the same numbers the ship panel, the
  // route and the telescope give: one moment, the sim's minute)
  const c = t.kind === 'entity' ? contactById(s, t.id) : null;
  if (c) {
    const lock = s.sensors.locked === t.id;
    const board = ui.nav.tab === 'scanner' || ui.nav.tab === 'tactical';
    const html = `<div class="scanner-detail-header">${c.sos ? '<span class="scanner-sos-tag">⚠ SOS</span> ' : ''}${esc(c.name || c.signature || 'CONTACT')}${markChips(marksFor(s, t) || {})}</div>
      ${contactSheet(s, d.entity, c, rel)}
      <div class="panel-actions">
        <button class="scanner-track-btn ${lock ? 'tracking' : ''}" data-act="lock">${lock ? 'UNLOCK' : 'LOCK'}</button>
        ${routing ? '<button class="scanner-intercept-btn intercepting" data-act="abort">ABORT INTERCEPT</button>' : '<button class="scanner-intercept-btn" data-act="plot">INTERCEPT</button>'}
        ${canHail ? '<button class="scanner-track-btn" data-act="hail">HAIL</button>' : ''}
        ${!c.ordnance ? '<button class="scanner-track-btn" data-act="stance">STANCE</button>' : ''}
        ${!c.ordnance ? `<button class="scanner-track-btn ${s.combat.target === t.id ? 'tracking' : ''}" data-act="target">${s.combat.target === t.id ? 'TARGETED' : 'TARGET'}</button>` : ''}
        ${dockButton(s, d.entity)}
        ${!c.ordnance && !c.station && boardable(s, d.entity).ok ? `<button class="scanner-track-btn" data-act="board">BOARD</button>` : ''}
        ${board ? '' : '<button class="scanner-track-btn" data-act="focus">FOCUS</button>'}
        ${lookButton('scanner-track-btn')}
        ${flaggable(d.entity) ? flagButton(s, t.id, 'scanner-track-btn') : ''}
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
      <span class="ms-name">${esc(d.name)}${markChips(marksFor(s, t) || {})}</span>
      <span class="ms-kind">${esc(d.kind)}${d.faction && d.faction !== 'independent' ? ` · ${esc(d.faction)}` : ''}</span>
    </div>
    <div class="ms-stats">
      <span>DIST <b>${rel ? fmtMeters(rel.dist) : '—'}</b></span>
      <span>REL V <b>${rel ? fmtSpeed(rel.speed) : '—'}</b></span>
    </div>
    ${t.kind === 'body' ? `<div class="ms-sheet">${bodySheet(s, t.id)}</div>` : ''}
    ${d.entity?.tags?.command ? `<div class="ms-sheet"><div class="scanner-detail-row"><span class="scanner-detail-key">ROLE</span><span class="scanner-detail-val scanner-val-wrap">${fobWords(s, d.entity)}</span></div></div>` : ''}
    <div class="panel-actions">
      ${routing ? '<button class="route-abort-btn" data-act="abort">ABORT ROUTE</button>' : t.id === 'Sol' ? '' : '<button class="route-plot-btn" data-act="plot">PLOT ROUTE</button>'}
      ${d.entity?.tags?.command && shipDockable(s, d.entity).ok && !(isDocked(s) && dockedTo(s)?.id === d.entity.id) ? '<button class="route-zoom-btn" data-act="dock" title="Alongside its collar: its missions, supplies at a tenth">DOCK</button>' : ''}
      ${t.id === 'Sol' ? '' : '<button class="route-zoom-btn" data-act="stance">STANCE</button>'}
      <button class="route-zoom-btn" data-act="focus">FOCUS</button>
      ${canHail ? '<button class="route-zoom-btn" data-act="hail">HAIL</button>' : ''}
      ${t.kind === 'body' || (t.kind === 'entity' && contactById(s, t.id)) ? lookButton('route-zoom-btn') : ''}
      ${flaggable(d.entity) ? flagButton(s, t.id, 'route-zoom-btn') : ''}
    </div>`;
  setHTML(mapPanel, html);
  show(mapPanel, true);
}

/**
 * A ship known only from the plot: what was reported, by whom, how old it
 * is, and how far off it could be by now. A filed plan or a berth is flown
 * to on the same public data the nav computer has; a lost contact's last
 * fix, to where it has coasted (sim/nav.js 'fix'), and our sensors take
 * over the route when they hold the contact again.
 */
function renderReport(s, t, d, routing) {
  const r = d.report;
  const info = describeRecord(s, r);
  const est = estimate(s, r, s.clock.minute);
  const f = s.flight.pos;
  const dist = est ? Math.hypot(est.x - f.x, est.y - f.y) * AU_KM : null;
  const plotable = !!d.entity;
  const plotWhy = r.kind === 'fix' ? 'Fly to where its last fix has coasted to; our sensors take over when they hold it again' : 'Fly to its filed plan; sensors take over on approach';
  const html = `<div class="ms-header">
      <span class="ms-name">${esc(d.name)}${markChips(marksFor(s, t) || {})}</span>
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
      ${routing ? '<button class="route-abort-btn" data-act="abort">ABORT ROUTE</button>' : plotable ? `<button class="route-plot-btn" data-act="plot" title="${plotWhy}">PLOT ROUTE</button>` : '<span class="ms-hint">No live track: close in until our sensors hold it</span>'}
      <button class="route-zoom-btn" data-act="focus">FOCUS</button>
      ${flaggable(d.entity) ? flagButton(s, t.id, 'route-zoom-btn') : ''}
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
    case 'plot': if (t) openRoutePanel(reportFor(s, t)?.kind === 'fix' ? { kind: 'fix', id: t.id } : t); break;
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
    case 'focus': if (t) {
      const p = navTargetPos();
      // (a world: framed on its planetary space, its zones drawn: solar-map.js)
      const w = t.kind === 'body' && worldOf(t.id);
      if (p) map.focusOn(p, t.kind === 'entity' ? 2e6 : w ? 0.42 * Math.min(map.fc.w, map.fc.h) / (2 * w.wellM / AU_M) : Math.max(map.scale, 300));
    } break;
    case 'orbit-over': if (t && btn.dataset.air) openRoutePanel({ kind: 'body', id: t.id }, { over: btn.dataset.air }); break;
    case 'send-shuttle': if (btn.dataset.air) hooks.shuttle?.(btn.dataset.air); break;
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
    case 'flag': toggleFlagOnPick(); break;
    case 'look': if (t?.kind === 'entity' || t?.kind === 'body') hooks.look?.(t); break;
    case 'flag-pick': selectTarget({ kind: 'entity', id: btn.dataset.id }); break;
    case 'flag-clear': {
      const r = toggleFlag(s, btn.dataset.id);
      if (r.ok) logEntry(`Nav: ${r.text}`, 'nav');
      cardKey = ''; renderSelection();
      break;
    }
    case 'flag-clear-all': clearFlags(s); logEntry('Nav: every flag cleared', 'nav'); cardKey = ''; renderSelection(); break;
  }
}

/** What we know of a ship's hull and people, for the contact panel. */
const sheetRow = (k, v, cls = '', tip = '') => `<div class="scanner-detail-row"${tip ? ` title="${esc(tip)}"` : ''}><span class="scanner-detail-key">${k}</span><span class="scanner-detail-val ${cls}">${v}</span></div>`;
const sheetHead = (k) => `<div class="scanner-detail-sub">${k}</div>`;

/**
 * What the board holds on a contact, as precisely as our sensors have it:
 * who it is; how it moves against us (range, range rate, relative speed,
 * where it passes closest, which way its nose points); its drive (lit or
 * cold, the G it pulls, the thrust that takes at its mass, how bright the
 * plume is from here, its signature when lit) and what it is. Range and
 * speeds are relativeTo's (hud.js): the same figures as the ship panel,
 * the route and the telescope. What a longer look has not yet given is
 * marked with the minutes still to scan.
 */
function contactSheet(s, e, c, rel) {
  const row = sheetRow;
  const wait = (need) => `scanning… ${Math.max(1, need - c.scan)}m`;
  const out = [];
  out.push(row('TRANSPONDER', c.name ? esc(c.name) : c.dark ? 'SILENT · running dark' : 'SILENT', c.name ? 'scanner-val-accent' : 'scanner-val-dim'));
  if (!c.ordnance) {
    out.push(row('CLASS', c.shipClass ? libRef(e, esc(c.shipClass)) : '—'));
    out.push(row('FACTION', c.faction || '—', c.faction ? '' : 'scanner-val-dim'));
  }
  // ---- a ship we hunt: what the nav computer makes of this contact (hunts.js)
  if (e) for (const { c: h, status } of huntsFor(s, e.id)) {
    out.push(sheetHead(h.type === 'STRIKE' ? 'STRIKE TARGET' : 'BOUNTY'));
    if (status === 'confirmed') out.push(row('TARGET', `the ${esc(h.targetName)} · confirmed by its ${h.identified === 'signature' ? 'drive signature' : 'transponder'}`, 'scanner-val-accent scanner-val-wrap'));
    else if (status === 'possible') {
      out.push(row('POSSIBLE', `the ${esc(h.targetName)}? Dark, seen in the search area of its last fix`, 'scanner-val-warn scanner-val-wrap', 'Not confirmed: it might be the ship we hunt, or anyone else running dark'));
      out.push(row('WHY NOT SURE', esc(unconfirmed(s, h, e)), 'scanner-val-dim scanner-val-wrap'));
    } else out.push(row('RULED OUT', `not the ${esc(h.targetName)}: ${esc(h.ruledOut[e.id].why)}`, 'scanner-val-dim scanner-val-wrap'));
  }
  // ---- how it moves against us
  out.push(sheetHead('MOTION'));
  if (rel) {
    out.push(row('RANGE', fmtMeters(rel.dist)));
    if (c.velocityKnown) {
      const rate = rel.closing > 0.5 ? `▼ ${fmtSpeed(rel.closing)} closing` : rel.closing < -0.5 ? `▲ ${fmtSpeed(-rel.closing)} opening` : 'holding';
      out.push(row('RANGE RATE', rate, rel.closing > 0.5 ? 'scanner-val-warn' : ''));
      out.push(row('REL V', fmtSpeed(rel.speed)));
      const cpa = closestApproach(rel);
      if (cpa) out.push(row('CLOSEST', cpa.tS > 0 ? `${fmtMeters(cpa.dM)} in ${formatDuration(cpa.tS / 60)}` : 'passed: opening', '', 'Where it passes closest to us if neither of us changes course'));
    } else out.push(row('REL V', wait(REVEAL.VELOCITY), 'scanner-val-dim'));
  }
  out.push(row('BEARING', `${fmtAngle(c.bearing - s.flight.facing)} off our nose`));
  if (e && e.type !== 'station') {
    if (c.headingKnown) {
      const toUs = Math.atan2(-Math.sin(c.bearing), -Math.cos(c.bearing));
      const off = Math.abs(Math.atan2(Math.sin(facingOf(e) - toUs), Math.cos(facingOf(e) - toUs))) * 180 / Math.PI;
      const asp = off < 25 ? 'nose on to us' : off > 155 ? 'tail to us' : off > 65 && off < 115 ? 'broadside' : off < 90 ? 'nose toward us' : 'nose away';
      out.push(row('ASPECT', `${asp} · ${Math.round(off)}°`));
    } else out.push(row('ASPECT', wait(REVEAL.HEADING), 'scanner-val-dim'));
  }
  out.push(row('LIGHT LAG', c.lagS < 0.1 ? '< 0.1 s' : `${c.lagS.toFixed(1)} s`, 'scanner-val-dim'));
  // ---- its drive
  if (e && e.type !== 'station') {
    out.push(sheetHead('DRIVE'));
    if (c.thrust != null) {
      const g = e.thrust || 0;
      out.push(row('G-LOAD', g > 0 ? `${g.toFixed(2)} G · drive lit` : '0 G · drive cold, coasting', g > 0 ? 'scanner-val-warn' : ''));
      if (g > 0) {
        if (c.mass) out.push(row('THRUST', `${fmtNum(g * G0 * c.mass / 1e3, 1)} MN at ${fmtNum(c.mass / 1000, 1)} kt`, ''));
        out.push(row('PLUME', `mag ${pointMag((c.mass ? g * G0 * c.mass * 1000 : 0) * PLUME_W_PER_N, rel?.dist || c.dist * AU_M).toFixed(1)} from here · seen to ${fmtKm(signatureRange(e) * AU_KM)}`, 'scanner-val-dim'));
      }
    } else out.push(row('G-LOAD', c.plume ? `drive lit · ${wait(REVEAL.THRUST)}` : wait(REVEAL.THRUST), c.plume ? 'scanner-val-warn' : 'scanner-val-dim'));
    out.push(row('SIGNATURE', c.signature ? esc(c.signature) : c.plume ? '…' : 'unread: the drive is cold', c.signature ? '' : 'scanner-val-dim', 'A drive signature is read from the plume, while the drive is lit'));
    if (!c.plume && !c.ordnance) out.push(row('COLD SIG', `radar holds it to ${fmtKm(hullSignature(e) * AU_KM)}`, 'scanner-val-dim'));
  }
  out.push(row('MASS', c.mass ? `${fmtNum(c.mass / 1000, 1)} kt` : wait(REVEAL.MASS), c.mass ? '' : 'scanner-val-dim'));
  out.push(shipRows(s, e, c, row));
  return out.join('');
}

/** Where two straight courses pass closest: distance (m) and in how long (s), or null without relative motion. */
function closestApproach(rel) {
  const vx = -rel.dvx, vy = -rel.dvy, v2 = vx * vx + vy * vy;
  if (v2 < 1e-6) return null;
  const tS = -(rel.dx * vx + rel.dy * vy) / v2;
  if (tS <= 0) return { tS, dM: rel.dist };
  return { tS, dM: Math.hypot(rel.dx + vx * tS, rel.dy + vy * tS) };
}

function shipRows(s, e, c, row) {
  if (!e || e.type !== 'ship' || c.ordnance) return '';
  const known = !!c.name;
  const crew = knownCrew(s, e, { identified: known });
  const hull = known ? `<canvas class="scanner-detail-hull" width="260" height="60" data-hull="${e.id}"></canvas>` : '';
  // (a command ship says what it is: the forward command of its navy's fight)
  const cmd = known && e.tags?.command ? row('ROLE', fobWords(s, e), 'scanner-val-wrap') : '';
  const hold = CLASSES[e.cls]?.cargoT > 0 ? knownHold(s, e, known) : null;
  return `${hull}${cmd}${row('ABOARD', crew ? `${esc(crew.text)} <span class="scanner-val-dim">${esc(crew.src)}</span>` : 'unknown', crew ? '' : 'scanner-val-dim')}
    ${CLASSES[e.cls]?.cargoT > 0 ? row('HOLD', hold ? `${esc(holdWords(hold.items))} <span class="scanner-val-dim">${esc(hold.src)}</span>` : known ? 'no manifest filed' : 'unknown', hold ? 'scanner-val-wrap' : 'scanner-val-dim') : ''}
    ${row('COLLARS', known ? esc(portSummary(e.cls)) : '—')}
    ${known && CLASSES[e.cls]?.atmo ? row('ATMOSPHERE', 'rated for entry') : ''}`;
}

/** A forward command (FOB) in words: whose, which fight, where it stands, what it is to us. */
function fobWords(s, e) {
  const z = s.politics.zones.find(x => x.id === e.tags.command.zone);
  const fight = z ? `the ${(ZONE_KINDS[z.kind]?.label || z.kind).toLowerCase()} at ${z.body}` : e.tags.command.body;
  const post = commandOnStation(e) ? 'on its post at the rear' : 'on its way out';
  const ours = flagOfService(s) === e.faction ? ': takes us alongside, military work, supplies at a tenth' : '';
  return `${esc(FACTIONS[e.faction]?.navy || '')} forward command (FOB) for ${esc(fight)} · ${post}${ours}`;
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
  formation: { label: 'FORMATION', m: STANDOFF.TACTICAL, desc: `${(STANDOFF.TACTICAL / 1000).toFixed(1)} km — boarding, tow, EVA` },
  close: { label: 'CLOSE', m: STANDOFF.CLOSE, desc: '100,000 km — full sensor lock' },
  scanner: { label: 'SCANNER', m: STANDOFF.SCANNER, desc: '15M km — inside long-range sensors' },
  orbit: { label: 'ORBIT', m: null, desc: 'A world: its high parking orbit at the edge of planetary space, a free orbit, no fuel to keep it. A rock: a standoff held on the drive' },
  stationary: { label: 'STATIONARY', m: null, desc: 'The stationary orbit over the chosen airspace: round in a sidereal day, the ground below keeping still' },
  slot: { label: 'HOLD', m: STANDOFF.SLOT, desc: 'Into our slot in the holding pattern: a free orbit, in port, no fuel to keep it' },
};

function standoffChoices(state, t) {
  if (t.kind === 'body') return ['orbit', 'close'];
  if (t.kind === 'fix') return ['formation', 'close', 'scanner'];
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
  ui.nav.target = target.kind === 'fix' ? { kind: 'entity', id: target.id } : target;
  if (ui.nav.tab === 'exterior' || ui.nav.tab === 'combat') openNav(target.kind === 'entity' && contactById(s, target.id) ? 'scanner' : 'solar');
  // (from a world's airspace: its stationary orbit over it, first)
  const choices = opts.over ? ['stationary', ...standoffChoices(s, target)] : standoffChoices(s, target);
  const key = opts.over ? 'stationary' : opts.dock && choices.includes('dock') ? 'dock' : opts.dock && choices.includes('rendezvous') ? 'rendezvous' : choices[0];
  routeUI = { target, choices, standoffKey: key, over: opts.over || null, options: [], selected: -1, computing: true };
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
    routeUI.options = planRoutes(s, t, { standoff, combat: s.combatStations, minG, orbit: routeUI.standoffKey === 'orbit', over: routeUI.standoffKey === 'stationary' ? routeUI.over : null });
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
  logEntry('All hands — secure for acceleration', 'nav');     // (the flight band asks for it: renderPrompt)
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
  setHTML(box, `<div class="mp-header mp-danger">FLIP HELD</div>
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

// The ROUTE panel has the whole status (`full`). The flight band has the
// rest of what its nav chip doesn't say (hud.js navStatus: the phase and
// where to): how far along, how long, and the buttons.
function renderRouteStatus(state, eta, box, full) {
  const ap = state.autopilot;
  const visible = !!ap && (full || ap.phase !== 'prepare');    // the prepare prompt covers that phase
  show(box, visible, 'flex');
  if (!visible) return;
  if (ap.plan.kind === 'stance') { renderStanceStatus(state, eta, box, full); return; }
  const name = targetName(state, ap.plan.target);
  // (the range and relative speed every panel gives, and the sense of it: hud.js relativeTo)
  const rel = relativeTo(state, ap.plan.target);
  const dist = ap.d != null ? Math.max(0, ap.d - ap.plan.standoff) : null;
  const motion = rel ? `${fmtMeters(rel.dist)} · ${fmtSpeed(rel.speed)}${rel.closing > 0.5 ? ' ▼' : rel.closing < -0.5 ? ' ▲' : ''}` : dist != null ? fmtMeters(dist) : '';
  const tp = targetStateAt(state, ap.plan.target, state.clock.minute)?.pos;
  const total = tp ? Math.hypot(ap.startPos.x - tp.x, ap.startPos.y - tp.y) * AU_M : 0;
  const frac = dist != null && total > 0 ? Math.max(0, Math.min(1, 1 - dist / total)) : 0;
  const etaTxt = eta?.minutes != null ? formatDuration(eta.minutes) : '—';
  const phase = ap.helm === 'unmanned' ? 'HELM UNMANNED — COASTING' : (PHASE_LABEL[ap.display] || ap.display.toUpperCase()) + (ap.helm === 'manual' ? ` · HAND-FLOWN (${ap.helmBy})` : ap.helm === 'degraded' ? ' · GUIDANCE DEGRADED' : '');
  const flip = ap.flipIn !== Infinity && ap.flipIn < 120 && (ap.display === 'burn' || ap.display === 'coast') ? ` · flip in ${formatDuration(ap.flipIn)}` : '';
  if (!full) {
    setHTML(box, `<div class="route-status-summary">
      <div class="route-status-progress"><div class="route-status-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>
      <span class="route-status-eta">${motion} · ETA ${etaTxt}${flip}</span>
      <button class="route-abort-btn" data-act="abort">ABORT</button>
    </div>`);
    return;
  }
  const html = `<div class="route-status-summary">
      <span class="route-status-dest">→ ${esc(name)}</span>
      <span class="route-status-phase phase-${ap.helm === 'unmanned' ? 'unmanned' : ap.display}">${esc(phase)}${flip}</span>
      <div class="route-status-progress"><div class="route-status-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>
      <span class="route-status-eta">${motion} · ETA ${etaTxt}</span>
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
      <span class="route-status-dest">◎ ${esc(STANCE_MODES[plan.mode].label)} ${fmtMeters(plan.standoff)}${full ? ` · ${esc(name)}` : ''}</span>
      ${full ? `<span class="route-status-phase phase-${ap.helm === 'unmanned' ? 'unmanned' : ap.display}">${esc(phase)}</span>` : ''}
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
  // (the route waits for a drone out too: EXECUTE NOW leaves it behind, sim/drones.js)
  const ds = droneStatus(state);
  const drone = ds ? `<span class="mp-status mp-waiting">DRONE ${ds.phase === 'recover' ? `COMING HOME · ${formatDuration(ds.left)}` : 'OUT'} — EXECUTE NOW LEAVES IT</span>` : '';
  const canEngage = st.pilotReady || (!st.pilot && !fcDown);
  setHTML(box, `<div class="mp-header">SECURE FOR BURN</div>
    <div class="mp-crew-row">${dots}</div>${status}${helpless}${drone}
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
  const mission = missionForEntity(state, e.id);
  const hailable = inRadio(state, e.id) || d < RANGE.FORMATION_M * 5;
  // (the band's nav chip says where we hold and how far: hud.js navStatus; this is what can be done about it)
  if (!docked && !hailable) { show(box, false); return; }
  const key = `${e.id}|${!!docked}|${!!mission}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    setHTML(box, docked ? '<button class="formation-hail-btn" data-act="station">STATION</button>'
      : `<button class="formation-hail-btn" data-act="hail-hold">${mission ? 'COMPLETE RESCUE' : 'HAIL'}</button>`);
  }
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
