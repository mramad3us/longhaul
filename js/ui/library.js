// ============================================================
// LONGHAUL — The ship's library
//
// A reference terminal: every ship class, yard and tech level, the
// machinery aboard, the fittings of the decks, weapons, navigation and
// doctrine, factions and stations. It reads the same tables the
// simulation runs on (ship-classes.js, systems.js, weapons.js, nav.js,
// stance.js…), so what it says is what the game does. Opening it
// doesn't pause the game.
//
// An entry is { id, cat, group, title, sub, specs: [[key, value]],
// text: [paragraphs], links: [[label, id]] }. Anything in the
// interface marked data-lib="<entry id>" opens that entry (a ship class
// on the scanner, the target's class on the fire-control panel…).
// ============================================================

import { ui } from './context.js';
import { $, esc, setHTML, show, fmtKm, fmtNum } from './dom.js';
import { AU_KM } from '../core/constants.js';
import { CLASSES, CLASS_IDS, KINDS, BUILDERS, TECH, SIZES, PLAYABLE, hullPoints, ratedG } from '../sim/ship-classes.js';
import { classStrength } from '../sim/combatants.js';
import { SYSTEMS, SYSTEM_IDS } from '../sim/systems.js';
import { TileType, TILE_NAMES, TILE_DESCRIPTIONS } from '../sim/tiles.js';
import { PDC, TORPEDO_MOTOR, WARHEADS, PROFILES, FAST_VC, RAILGUN, RAIL_RANGE_M, MINING_GEAR, EVADE_G, COUNTER_BURN_S, UNDER_FIRE_CLOSE_MS } from '../sim/weapons.js';
import { AIM } from '../sim/damage.js';
import { ROUTE_PROFILES } from '../sim/nav.js';
import { STANCE_MODES } from '../sim/stance.js';
import { TURN_HOLD_MAX_MIN } from '../sim/autopilot.js';
import { FACTIONS } from '../sim/factions.js';
import { STATION_NOTES } from '../sim/entities.js';
import { getWorld } from '../sim/world.js';
import { G_THRESHOLDS, HIGH_DOSE_G } from '../sim/crew.js';
import { FLIP_MINUTES, RCS_MAX_G, LEAN_MAX } from '../sim/flight.js';
import { DIGEST_MIN, TC_REACH_AU, LIGHT_MINUTE_AU } from '../sim/intel.js';
import { WAKE_AU, POLICE_PER_STATION, NAVY_STRENGTH, COMMAND_SHIPS, NAVY_YARDS, PIRATES_AT_LARGE } from '../sim/forces.js';
import { DEFAULT_TRAFFIC } from '../sim/traffic.js';
import { hullOf, portSummary, COLLARS } from '../sim/hulls.js';
import { DECK_PROGRAMS, createLayout } from '../sim/ship-layout.js';
import { STATIONS, stationModel, stationOrbit } from '../sim/stations.js';
import { getBody, surfaceGravity } from '../sim/ephemeris.js';
import { CONTROL_M, APPROACH_M, KEEPOUT_SPEED_MS, KEEPOUT_DRIVE_G, CORRIDOR_M, APPROACH_CLEARANCE_MIN, DOCK_CLEARANCE_MIN, DEPART_CLEARANCE_MIN } from '../sim/traffic-control.js';
import { PROX_RATES, CAPTURE_MIN, SEAL_MIN, UNDOCK_MIN, CLEAR_M } from '../sim/docking.js';
import { EVA_RANGE_M } from '../sim/boarding.js';
import { SUBFACTIONS, SUB_IDS, subsOf } from '../sim/factions.js';
import { ZONE_KINDS } from '../sim/conflict.js';
import { RANKS, RANK_REP, RANK_FOR, PAY_PER_RANK, CALLUP_AU } from '../sim/service.js';

const CATEGORIES = [
  { id: 'ships', label: 'SHIP CLASSES' },
  { id: 'yards', label: 'YARDS & TECH' },
  { id: 'systems', label: 'SHIP SYSTEMS' },
  { id: 'fittings', label: 'FITTINGS' },
  { id: 'weapons', label: 'WEAPONS' },
  { id: 'nav', label: 'NAVIGATION' },
  { id: 'crew', label: 'CREW & MEDICINE' },
  { id: 'factions', label: 'FACTIONS' },
  { id: 'stations', label: 'STATIONS' },
];

// Where each system's machinery is aboard (the fitting an engineer works at)
const SYSTEM_TILE = {
  flightComputer: TileType.NAV_CONSOLE, drive: TileType.ENGINE, coolant: TileType.REACTOR, rcs: TileType.ENG_CONSOLE,
  sensors: TileType.OPS_CONSOLE, comms: TileType.RADIO, lifeSupport: TileType.LIFE_SUPPORT, waterRecycler: TileType.WATER_RECYCLER,
  galley: TileType.GALLEY, autodoc: TileType.MEDBAY, pdc: TileType.PDC_MOUNT, launcher: TileType.TORPEDO_LAUNCHER,
};
const SYSTEM_TILES = new Set(Object.values(SYSTEM_TILE));

let entries = null;          // id → entry, built on first open
let lib = { open: false, cat: 'ships', id: null, query: '' };

export function initLibrary() {
  $('#library-close').addEventListener('click', closeLibrary);
  $('#library').addEventListener('pointerdown', (e) => { if (e.target.id === 'library') closeLibrary(); });
  $('#library-search').addEventListener('input', (e) => { lib.query = e.target.value.trim().toLowerCase(); renderIndex(); });
  $('#library-index').addEventListener('click', onIndexClick);
  // Anything marked data-lib anywhere opens its entry
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-lib]');
    if (!a || !ui.state) return;
    e.stopPropagation();
    openLibrary(a.dataset.lib);
  }, true);
}

export const libraryOpen = () => lib.open;

/** The library entry for a fitting on the deck plan: its machine's, or the fitting's own. */
export function tileEntry(tile) {
  const sys = Object.keys(SYSTEM_TILE).find(id => SYSTEM_TILE[id] === tile);
  return sys ? `sys:${sys}` : tile === TileType.REACTOR ? 'sys:reactor' : `fit:${tile}`;
}

export function toggleLibrary() {
  if (lib.open) closeLibrary(); else openLibrary();
}

/** Open the library, at an entry if given (`ship:mcrn-frigate`, `sys:drive`…). */
export function openLibrary(id = null) {
  entries ??= buildEntries();
  if (id && entries.has(id)) { lib.id = id; lib.cat = entries.get(id).cat; }
  lib.id ??= firstOf(lib.cat);
  lib.open = true;
  show($('#library'), true, 'flex');
  renderIndex();
  renderPage();
}

export function closeLibrary() {
  if (!lib.open) return false;
  lib.open = false;
  show($('#library'), false);
  return true;
}

function firstOf(cat) {
  for (const e of entries.values()) if (e.cat === cat) return e.id;
  return null;
}

function onIndexClick(e) {
  const c = e.target.closest('[data-lib-cat]');
  if (c) { lib.cat = c.dataset.libCat; lib.id = firstOf(lib.cat); renderIndex(); renderPage(); return; }
  const a = e.target.closest('[data-lib-entry]');
  if (a) { lib.id = a.dataset.libEntry; renderIndex(); renderPage(); }
}

// ---- RENDERING ----

function renderIndex() {
  const q = lib.query;
  let html = '';
  if (q) {
    const hits = [...entries.values()].filter(e => e.search.includes(q));
    html = hits.length ? hits.map(e => item(e, `<span class="lib-cat-tag">${esc(CATEGORIES.find(c => c.id === e.cat).label)}</span>`)).join('')
      : '<div class="lib-empty">Nothing on file.</div>';
  } else {
    for (const c of CATEGORIES) {
      const n = [...entries.values()].filter(e => e.cat === c.id).length;
      html += `<button class="lib-cat ${c.id === lib.cat ? 'open' : ''}" data-lib-cat="${c.id}">${c.label}<span>${n}</span></button>`;
      if (c.id !== lib.cat) continue;
      let group = null;
      for (const e of entries.values()) {
        if (e.cat !== c.id) continue;
        if (e.group && e.group !== group) { group = e.group; html += `<div class="lib-group">${esc(group)}</div>`; }
        html += item(e);
      }
    }
  }
  setHTML($('#library-index'), html);
}

const item = (e, tag = '') => `<button class="lib-item ${e.id === lib.id ? 'active' : ''}" data-lib-entry="${e.id}">${esc(e.title)}${tag}</button>`;

function renderPage() {
  const e = entries.get(lib.id);
  if (!e) { setHTML($('#library-page'), ''); return; }
  const specs = e.specs.length ? `<table class="lib-specs">${e.specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>` : '';
  const text = e.text.map(p => `<p>${esc(p)}</p>`).join('');
  const links = e.links.length ? `<div class="lib-links">SEE ALSO ${e.links.filter(([, id]) => entries.has(id)).map(([label, id]) => `<button class="lib-link" data-lib="${id}">${esc(label)}</button>`).join('')}</div>` : '';
  setHTML($('#library-page'), `<div class="lib-title">${esc(e.title)}</div>${e.sub ? `<div class="lib-sub">${esc(e.sub)}</div>` : ''}${text}${specs}${links}`);
  $('#library-page').scrollTop = 0;
}

// ---- ENTRIES ----

function buildEntries() {
  const out = new Map();
  const add = (e) => {
    e.specs ??= []; e.text ??= []; e.links ??= [];
    // (what an entry says, not the labels every entry of its kind shares)
    e.search = [e.title, e.sub, ...e.text, ...e.specs.map(s => s[1])].join(' ').toLowerCase().replace(/<[^>]+>/g, '');
    out.set(e.id, e);
  };
  ships(add); yards(add); systems(add); fittings(add); weapons(add); navigation(add); crew(add); factions(add); stations(add);
  return out;
}

const km = (m) => fmtKm(m / 1000);
const g = (x) => `${+x.toFixed(2)} G`;

function ships(add) {
  const ids = [...CLASS_IDS].sort((a, b) => Object.keys(KINDS).indexOf(CLASSES[a].kind) - Object.keys(KINDS).indexOf(CLASSES[b].kind));
  for (const id of ids) {
    const c = CLASSES[id], T = TECH[c.tl];
    const specs = [
      ['Hull', `${c.lengthM} m · ${fmtNum(c.massT)} t · ${SIZES[c.size].label.toLowerCase()}`],
      ['Crew', `${c.crew[0]}–${c.crew[1]}, usually ${c.crewStd}${c.berths ? ` · ${c.berths} passenger berths` : ''}`],
      ['Dimensions', `${fmtNum(hullOf(id).L)} × ${fmtNum(Math.round(hullOf(id).W))} × ${fmtNum(Math.round(hullOf(id).H))} m`],
      ['Collars', portSummary(id) || '—'],
      ['RCS', `${hullOf(id).rcs.accel.toFixed(2)} m/s² · ${hullOf(id).rcs.rotDeg.toFixed(1)}°/s`],
      ['Atmosphere', c.atmo ? `rated: ${c.atmo.entry === 'belly' ? 'a lifting body on a ceramic belly' : 'tail first behind an ablative shield ring'}, lands on ${c.atmo.landing}` : 'not rated for entry'],
      ...(DECK_PROGRAMS[id] ? [['Decks', createLayout(id).map(d => d.name).join(' · ')]] : []),
      ['Drive', `cruise ${g(c.drive.cruiseG)} · max ${g(c.drive.maxG)} · rated ${g(ratedG(c))}`],
      ['Structure', `${hullPoints(c)} DP · armor ${c.armor + T.armor}`],
      ['Point defense', c.pdc ? `${c.pdc} mounts · envelope ${km(PDC[c.tl].rangeM)} · guns ${km(PDC[c.tl].strafeM)}` : '—'],
      ['Torpedoes', c.tubes ? `${c.tubes} tubes · ${c.magazine.he} HE, ${c.magazine.nuke} nuclear${c.magazineCap ? ` (room for ${c.magazineCap})` : ''}` : '—'],
    ];
    if (c.railgun) specs.push(['Railgun', `${c.railgun} · ${km(RAILGUN[Math.max(2, c.tl)].speed)}/s slugs, ${km(RAIL_RANGE_M)} reach`]);
    if (c.gear) specs.push(['Mining gear', `${c.gear.mounts} × ${MINING_GEAR[c.gear.type].name}`]);
    specs.push(
      ['Hold', `${fmtNum(c.cargoT)} t`],
      ['Seen cold', `${fmtKm(SIZES[c.size].radarAU * T.stealth * AU_KM)} on radar (a lit drive: millions of km)`],
      ['Combat strength', fmtNum(classStrength(id))],
      ['Flown by', Object.keys(c.factions).map(f => FACTIONS[f]?.name || f).join(', ')],
    );
    add({
      id: `ship:${id}`, cat: 'ships', group: KINDS[c.kind], title: c.name + (PLAYABLE.includes(id) ? ' ★' : ''),
      sub: `${KINDS[c.kind]} · ${BUILDERS[c.builder].name} · ${T.label} ${T.name}`,
      text: [c.desc || '', PLAYABLE.includes(id) ? '★ Can be our ship.' : ''].filter(Boolean), specs,
      links: [[BUILDERS[c.builder].name, `yard:${c.builder}`], [T.label, `tl:${c.tl}`],
        ...(c.pdc ? [['Point defense', 'wpn:pdc']] : []), ...(c.tubes ? [['Torpedoes', 'wpn:torpedo']] : []),
        ...(c.railgun ? [['Railguns', 'wpn:railgun']] : []), ...(c.gear ? [['Mining gear', `wpn:gear-${c.gear.type}`]] : [])],
    });
  }
}

function yards(add) {
  const YARD_TEXT = {
    MCR: 'Mars builds few ships and builds them to naval standards: TL3 and TL4 hulls that hardly show on radar, rarely break, and cost a fortune to keep.',
    UN: 'Earth and Luna build sound, ordinary TL2 ships, and a few modern TL3 hulls. Most of the UN fleet is a generation old.',
    independent: 'Private yards on Ganymede, Ceres and Tycho build to commercial standards: TL2, for whoever pays.',
    Belt: 'The Belt flies refurbished hulls and jury-rigged systems (TL1). They break all the time, but a Belter fixes them with a wrench and whatever scrap is to hand, and the fix holds.',
  };
  for (const [id, b] of Object.entries(BUILDERS)) {
    const built = CLASS_IDS.filter(c => CLASSES[c].builder === id);
    add({ id: `yard:${id}`, cat: 'yards', group: 'Yards', title: b.name, sub: `${built.length} classes`,
      text: [YARD_TEXT[id] || ''], links: built.map(c => [CLASSES[c].name, `ship:${c}`]) });
  }
  const pct = (x) => `×${x}`;
  for (const [tl, T] of Object.entries(TECH)) {
    add({ id: `tl:${tl}`, cat: 'yards', group: 'Tech levels', title: `${T.label}: ${T.name}`,
      text: ['How a ship was built changes everything it does: how far it sees and how far it is seen, how its guns are laid, how hard it jinks, and how its machinery wears, breaks and is mended.'],
      specs: [
        ['Sensors', `${pct(T.sensors)} detection range`], ['Stealth', `${pct(T.stealth)} own signature`],
        ['Armor', `+${T.armor} over the class rating`], ['Fire control', `${pct(T.fireControl)} on every PDC`],
        ['Jinking', `${pct(T.evade)} evasive G`], ['Threat axis', T.counterBurn ? 'plotted: turns away from close torpedoes' : 'none: holds course and jinks'],
        ['Wear', pct(T.wear)], ['Time between faults', pct(T.mtbf)], ['Spares per repair', pct(T.parts)],
        ['Repair time', pct(T.repairTime)], ['A jury-rig holds', `${T.patchHours[0]}–${T.patchHours[1]} h`], ['Yard prices', pct(T.price)],
      ],
      links: CLASS_IDS.filter(c => CLASSES[c].tl === +tl).map(c => [CLASSES[c].name, `ship:${c}`]) });
  }
}

function systems(add) {
  for (const id of SYSTEM_IDS) {
    const s = SYSTEMS[id];
    add({ id: `sys:${id}`, cat: 'systems', title: s.name, sub: SYSTEM_TILE[id] != null ? `Worked on at the ${TILE_NAMES[SYSTEM_TILE[id]].toLowerCase()}` : '',
      text: [s.desc || ''],
      specs: [
        ['Degraded', esc(s.effects.degraded)], ['Failed', esc(s.effects.failed)],
        ['Wear', `${s.wear} integrity a day at idle (more under load)`], ['Between faults', `~${s.mtbf} days at half integrity`],
        ['Minor faults', esc(s.faults.minor.join(' · '))], ['Major faults', esc(s.faults.major.join(' · '))],
      ] });
  }
  add({ id: 'sys:reactor', cat: 'systems', title: 'Fusion reactor', sub: 'Worked on at the reactor core',
    text: ['The power plant behind every system, the drive included. Shutting it down cleanly takes an engineer twelve hours at the core, and starting it again five, on battery power and a minimum of fuel.',
      'A containment failure gives the crew about an hour and a half to patch it or scram the core before the bottle lets go.'],
    links: [['Reactor cooling', 'sys:coolant'], ['Epstein drive', 'sys:drive']] });
}

function fittings(add) {
  for (const [t, desc] of Object.entries(TILE_DESCRIPTIONS)) {
    if (SYSTEM_TILES.has(+t) || +t === TileType.REACTOR) continue;
    add({ id: `fit:${t}`, cat: 'fittings', title: TILE_NAMES[t] || 'Fitting', text: [desc] });
  }
}

function weapons(add) {
  const tls = [1, 2, 3, 4];
  add({ id: 'wpn:pdc', cat: 'weapons', group: 'Guns', title: 'Point-defense cannon',
    text: [SYSTEMS.pdc.desc, 'Torpedoes inside the envelope are shot at for as long as they take to cross it (20 s at most); salvos arriving together share the guns. Against a hull the stream must be laid inside gun range, and a jinking target spreads it.'],
    specs: tls.map(tl => [`TL${tl}`, `kill rate ${PDC[tl].lambda}/mount-s · envelope ${km(PDC[tl].rangeM)} · guns ${km(PDC[tl].strafeM)} · ${PDC[tl].sigmaRad * 1000} mrad`]) });
  add({ id: 'wpn:torpedo', cat: 'weapons', group: 'Torpedoes', title: 'Torpedo',
    text: ['A small fusion missile with a fixed Δv. It builds up a closing speed and holds it, burning again whenever the target pulls away, and corrects its aim every minute. A torpedo that loses its target flies on the last track it had, and destroys itself if it finds nothing there.'],
    specs: tls.map(tl => [`TL${tl}`, `${TORPEDO_MOTOR[tl].maxG} G · Δv ${km(TORPEDO_MOTOR[tl].dv)}/s · FAST closes at ${km(FAST_VC[tl])}/s`]),
    links: [['HE warhead', 'wpn:warhead-he'], ['Nuclear warhead', 'wpn:warhead-nuke'], ...Object.keys(PROFILES).map(k => [PROFILES[k].label, `wpn:profile-${k}`])] });
  const WH_TEXT = {
    he: 'A shaped charge: it must hit, and it lands on the section the gunner aimed for.',
    nuke: 'Fuzes at closest approach whether or not the homing connects, and the blast hurts everything nearby. Contraband to private ships.',
  };
  for (const w of Object.values(WARHEADS)) {
    add({ id: `wpn:warhead-${w.id}`, cat: 'weapons', group: 'Torpedoes', title: w.name, text: [WH_TEXT[w.id] || ''],
      specs: [['Damage', `${w.dp} DP${w.scaleM ? ` at the core, e-folding over ${w.scaleM} m` : ' on a hit'}`], ['Price', `${fmtNum(w.price)} MCR`], ...(w.contraband ? [['Law', 'contraband']] : [])] });
  }
  for (const [k, p] of Object.entries(PROFILES)) {
    add({ id: `wpn:profile-${k}`, cat: 'weapons', group: 'Torpedoes', title: `${p.label} profile`, text: [p.desc],
      specs: tls.map(tl => [`TL${tl}`, `closes at ${km(FAST_VC[tl] * p.vcFrac)}/s`]) });
  }
  add({ id: 'wpn:railgun', cat: 'weapons', group: 'Guns', title: 'Railgun',
    text: ['A naval mount throwing an unguided slug at tens of km/s. Fire control leads the target as if it will keep its thrust; a target that holds still is hit at long range, and a jinking one only up close.'],
    specs: [2, 3, 4].map(tl => [`TL${tl}`, `${km(RAILGUN[tl].speed)}/s · ${RAILGUN[tl].sigma * 1e6} µrad dispersion`]).concat([['Reach', km(RAIL_RANGE_M)]]) });
  for (const gear of Object.values(MINING_GEAR)) {
    add({ id: `wpn:gear-${gear.id}`, cat: 'weapons', group: 'Mining gear', title: gear.name[0].toUpperCase() + gear.name.slice(1),
      text: ['Mining tools turned on a hull that comes close. It throws rock, so it never runs dry, and it cannot touch a torpedo.'],
      specs: [['Reach', km(gear.rangeM)], ['Projectile', `${fmtNum(gear.speed)} m/s`], ['Dispersion', `${gear.sigmaRad * 1000} mrad`], ['Damage', `${gear.dp} DP per mount-minute`]] });
  }
  for (const a of Object.values(AIM)) {
    add({ id: `wpn:aim-${a.id}`, cat: 'weapons', group: 'Aim', title: `Aim: ${a.label}`, text: [a.desc] });
  }
  add({ id: 'wpn:evasive', cat: 'weapons', group: 'Aim', title: 'Evasive maneuvers',
    text: [`Random hard thrust changes every few seconds, ${EVADE_G} G before tech level. They throw off torpedo homing, railguns and PDC aim, at the cost of reaction mass, a lit plume and the crew's backs. Battle stations only.`] });
}

function navigation(add) {
  for (const r of ROUTE_PROFILES) {
    add({ id: `nav:route-${r.name.toLowerCase().replace(/\s+/g, '-')}`, cat: 'nav', group: 'Route profiles', title: r.name, sub: r.label, text: [r.desc] });
  }
  for (const [k, m] of Object.entries(STANCE_MODES)) {
    add({ id: `nav:stance-${k}`, cat: 'nav', group: 'Stances', title: `Stance: ${m.label}`, text: [m.desc,
      'A stance is kept, flown, until released: the nav computer moves into place on the closing law, then holds it. TIGHT holds within 0.5% of the range, LOOSE within 10% (cheaper, and with a coasting target the drive stays cold).'],
      links: [['Doctrine under fire', 'nav:doctrine']] });
  }
  add({ id: 'nav:traffic', cat: 'nav', group: 'Stations', title: 'Traffic control',
    text: ['A busy port manages the space round it, and strangers may not wander about it. Hail traffic control to ask for clearance; the nav computer will not do it for you.',
      `Control space reaches ${fmtNum(CONTROL_M / 1e6) * 1000} km: a transponder is required. The approach (${fmtNum(APPROACH_M / 1e6) * 1000} km) takes an approach clearance (good for ${APPROACH_CLEARANCE_MIN / 60} hours); loiter there uncleared and you are warned, cited, then reported. Inside the approach gate is the keep-out zone: only ships cleared to dock (a berth assigned, good for ${DOCK_CLEARANCE_MIN / 60} hours), or leaving on a departure clearance (${DEPART_CLEARANCE_MIN} minutes), come inside it, under ${KEEPOUT_SPEED_MS} m/s. A trespasser gets a final warning, then it is a crime, and a naval yard opens fire. Inside the gate the nav computer holds the drive to ${KEEPOUT_DRIVE_G} G: no torch near a station.`,
      'Citations are fines owed to the station\'s power, paid at its stations or settled by an inspection; a week unpaid makes you SUSPECT there.'],
    links: [['Docking', 'nav:docking']] });
  add({ id: 'nav:docking', cat: 'nav', group: 'Stations', title: 'Docking',
    text: [`A route to a station ends at its approach gate. From there the docking computer flies the final approach in the station's own frame, on the drive at 0.1 G, to the mouth of the berth's corridor ${CORRIDOR_M} m out along the collar's axis. Proximity operations follow, second by second on the RCS: the computer flies them, or the pilot does (MANUAL), lining up the collars by eye on the docking camera.`,
      `Collars of one size mate: ${Object.entries(COLLARS).map(([k, c]) => `${k} (${c.label}: capture under ${c.captureMS} m/s, ${c.missM} m off the axis, ${c.angleDeg}°, roll ${c.rollDeg}°)`).join('; ')}. Station berths take smaller collars through adaptors. Outside the envelope the collars bounce; hard enough, the hull is damaged.`,
      `Soft capture, then ${CAPTURE_MIN} minutes to hard dock and ${SEAL_MIN} to equalize. Undocking vents the lock (${UNDOCK_MIN} minutes) and backs out to ${CLEAR_M} m. Docking mode runs at ${PROX_RATES.map(r => `×${r}`).join(', ')} game seconds a second.`,
      `Ship to ship: the other ship has to hold still: one that agreed to it, one that struck, a dead hull. Boarding can go through a mated collar or by EVA, at up to ${fmtNum(EVA_RANGE_M / 1000)} km.`],
    links: [['Traffic control', 'nav:traffic']] });
  add({ id: 'nav:doctrine', cat: 'nav', group: 'Stances', title: 'Doctrine under fire',
    text: [`With a fire-control computer that plots the threat axis (TL2 and up), a ship turns away and burns from any torpedo less than ${COUNTER_BURN_S / 60} minutes out. The torpedo then arrives slowly, spends a long time under the PDCs, and has to spend its Δv catching up.`,
      `With a torpedo inbound, close on the enemy no faster than ${UNDER_FIRE_CLOSE_MS / 1000} km/s: every m/s of closing speed is a m/s on their torpedoes.`],
    links: [['Point defense', 'wpn:pdc'], ['TL2', 'tl:2']] });
  add({ id: 'nav:flight', cat: 'nav', group: 'Flight', title: 'Attitude and thrust',
    text: [`The drive pushes along the nose. A full flip takes ${FLIP_MINUTES} minutes with the drive cold; the nose can lean up to ${Math.round(LEAN_MAX * 180 / Math.PI)}° with the drive lit; RCS gives ${RCS_MAX_G} G in any direction without turning.`,
      'Guidance plans every burn with the turns it needs: burn, flip, brake, and the turn into the attitude that holding on the target takes.'] });
  add({ id: 'nav:safety', cat: 'nav', group: 'Flight', title: 'Crew safety',
    text: ['A flip throws anyone not strapped in, at any G. The nav computer calls the crew to the couches before every stretch where it may turn the ship: preparing, the half hour before a flip, the last hour of an approach, a stance moving into place.',
      `It won't start a flip with anyone able on their feet: it holds the turn, drive cold, until they are in, the captain orders FLIP NOW, or ${TURN_HOLD_MAX_MIN} minutes have gone. Amber lights show while the ship maneuvers with crew up.`],
    links: [['Acceleration', 'crew:g'], ['Crash couch', `fit:${TileType.CRASH_COUCH}`]] });
  add({ id: 'nav:light', cat: 'nav', group: 'The plot', title: 'Light lag and the plot',
    text: ['Light crosses an AU in 8.3 minutes, and nothing we learn travels faster. What our own sensors hold (out to 50 light-seconds) is live. Everything else on the plot is a report, and every report has an age.',
      'A contact that drops off the board leaves its last fix: the plot coasts it on its last velocity inside a circle that grows with the hours, since it may have burned since. A lost contact can be looked at but not flown to: close in until the sensors hold it again.',
      `Every station's traffic control publishes a digest every ${DIGEST_MIN / 60} hours: the transponder ships within ${fmtKm(TC_REACH_AU * AU_KM)} of it, berthed or with a filed flight plan. It reaches us after the light time from that station. A filed plan is flown forward on the plot, and the nav computer can plot a route to it. Ships without a transponder are never in a digest.`,
      'News of hot zones and losses travels at light speed too. A zone is on the plot once its news has arrived, and stays there until news of its end does.'],
    specs: [['One light-second', '299,792 km'], ['One light-minute', `${fmtNum(LIGHT_MINUTE_AU * AU_KM / 1e6, 1)} M km`], ['Earth to Ceres', '≈ 10–30 light-minutes'], ['Ceres to Jupiter', '≈ 15–50 light-minutes']],
    links: [['Who is out there', 'nav:population']] });
  add({ id: 'nav:population', cat: 'nav', group: 'The plot', title: 'Who is out there',
    text: [`About ${fmtNum(DEFAULT_TRAFFIC)} traffic ships work the lanes between the stations, choosing nearer and friendlier ports. Each power keeps hulls in space as well: ${POLICE_PER_STATION} police cutters on a beat around each of its stations; ${Object.entries(NAVY_STRENGTH).map(([f, n]) => `${n} ${FACTIONS[f].navy} warships`).join(', ')} berthed at their yards until a hot zone calls for them; and about ${PIRATES_AT_LARGE} raiders lying up cold where nobody's writ runs.`,
      `Each power also keeps command ships (${Object.entries(COMMAND_SHIPS).map(([f, n]) => `${n} ${FACTIONS[f].navy}`).join(', ')}): one goes to the rear of every fight its power is in.`,
      'Far from us these ships fly on rails, and what happens to them is settled by outcomes: warships on station at a skirmish lose ships, pirates take haulers in the lanes through their zone. The wrecks are real and stay where they fell. What is lost is replaced in time: the yards lay down new hulls (days for a cutter, weeks for a battleship, faster in a war) and launch them, and lost traffic is replaced by new ships out of their power\'s yards.',
      `Within ${fmtKm(WAKE_AU * AU_KM)} of us (about our long sensor reach) they come alive and act for themselves. The skirmish we fly into is the one the news reported, fought by the ships that were sent to it.`],
    specs: Object.entries(NAVY_YARDS).map(([f, ids]) => [`${FACTIONS[f].navy} yards`, ids.map(id => (ui.state && getWorld(ui.state).get(id)?.name) || id).join(', ')]),
    links: [['Light lag and the plot', 'nav:light']] });
}

function crew(add) {
  add({ id: 'crew:g', cat: 'crew', title: 'Acceleration', text: ['How much G a body takes, and for how long, decides who walks away from a burn.'],
    specs: [['Comfortable', `up to ${G_THRESHOLDS.COMFORTABLE} G`], ['Standard', `${G_THRESHOLDS.STANDARD} G`], ['Strain', `above ${G_THRESHOLDS.HIGH} G: juice for long burns`],
      ['Injury', `above ${G_THRESHOLDS.DANGEROUS} G without a couch`], ['Lethal', `${G_THRESHOLDS.LETHAL} G and up`]],
    links: [['Juice', 'crew:juice']] });
  add({ id: 'crew:juice', cat: 'crew', title: 'Juice', sub: 'Acceleration drug cocktail',
    text: ['Given by the couch injector for burns above 1.5 G: it keeps blood pressure up and vessels whole. A standard dose covers a burn, its flips and its lulls.',
      `Above ${HIGH_DOSE_G} G the high dose is needed, with a booster once a day. It protects more and costs more, and when it wears off the crew crash: days of weakness, low spirits and a strained heart.`],
    links: [['Autodoc', 'sys:autodoc'], ['Crash couch', `fit:${TileType.CRASH_COUCH}`]] });
}

function factions(add) {
  for (const f of Object.values(FACTIONS)) {
    const subs = subsOf(f.id);
    add({ id: `fac:${f.id}`, cat: 'factions', group: 'Powers', title: f.name, text: [f.desc || ''],
      specs: [['Navy', f.navy || '—'], ['Police', f.police || '—'], ...(subs.length ? [[f.id === 'independent' ? 'Independents' : f.id === 'pirate' ? 'Clans' : 'Within it', subs.map(id => SUBFACTIONS[id].name).join(' · ')]] : [])],
      links: [...subs.map(id => [SUBFACTIONS[id].name, `sub:${id}`]), ...CLASS_IDS.filter(c => CLASSES[c].factions[f.id]).slice(0, 8).map(c => [CLASSES[c].name, `ship:${c}`])] });
  }
  for (const id of SUB_IDS) {
    const x = SUBFACTIONS[id];
    add({ id: `sub:${id}`, cat: 'factions', group: 'Sub-factions', title: x.name, sub: x.short, text: [x.desc],
      specs: [['Part of', x.parent ? FACTIONS[x.parent].name : x.outlaw ? 'nobody: a pirate clan' : 'nobody: independent'], ['Agenda', x.agenda], ...(x.lairs ? [['Works', x.lairs.join(', ')]] : [])],
      links: [[x.parent ? FACTIONS[x.parent].name : x.outlaw ? 'Pirates' : 'Independent', `fac:${x.parent || (x.outlaw ? 'pirate' : 'independent')}`], ['How the powers stand', 'fac:politics']] });
  }
  add({ id: 'fac:politics', cat: 'factions', group: 'The system', title: 'How the powers stand',
    text: ['Each pair of powers has a relation, from open war to alliance, and a phase: allied, friendly, neutral, cold war, crisis, war. Earth and Mars are never friends: they live between a cold war and an open one. In a cold war, pressure builds (the arms race, incidents, the hawks); a crisis feeds itself until war is declared; a war wears both sides down until a ceasefire, and the long cooling starts again. The Belt\'s quarrels with the inner powers run the same way, from milder places.',
      'Inside each power, sub-factions share its influence and pull it their way: hawks toward war, doves away, the intelligence services into everything, the companies toward a profitable cold war. They fight each other in the dark (leaks, budget fights, arrests, sabotage at a yard), and some of it reaches the news.',
      'In a cold war or a crisis the powers fight through others: a mercenary company, a pirate clan or a Belter cell paid to raid a rival\'s shipping, deniably. When the money is traced, the crisis deepens.',
      'Every war has a front: the place both navies reach for, fought over a few control points. Each power in a fight sends a command ship to the rear of it.'],
    specs: [['Hot zones', Object.values(ZONE_KINDS).map(z => z.label.toLowerCase()).join(' · ')], ['See', 'SERVICE (V): the powers now, and the news']],
    links: [['Military licenses', 'fac:service']] });
  add({ id: 'fac:service', cat: 'factions', group: 'The system', title: 'Military licenses',
    text: ['A captain may hold one power\'s military license at a time: chosen at the start, applied for at that power\'s stations (standing 10 or better, a clean record), handed back at will, revoked for serious crimes against it. Navy hulls need their navy\'s license; nuclear torpedoes need a license, and are legal in the licensing power\'s space.',
      'A license and one of its navy\'s hulls make the captain that power\'s contractor, flying its flag: every other power sees it through its own (our relation with them is our power\'s, plus a tenth of our own standing). The enemy\'s warships engage it on sight, its stations refuse and fire on it; its civilians are never targets.',
      `A contractor earns reputation with its power (time in service, enemy hulls destroyed, military missions) and rank with it: ${RANKS.UN.join(', ')} in the UNN. Rank raises military pay by ${Math.round(PAY_PER_RANK * 100)}% a step, opens the harder missions, gets nuclear warheads issued by command ships, and waves it through its own side\'s patrols.`,
      `When its power fights within ${CALLUP_AU} AU, command orders it to the command ship: alongside, supplies cost a tenth while the fight lasts, and the board is all military work: intelligence, holding a control point at a front, strikes on high-value targets, now and then a covert job for a sub-faction against a rival inside the power.`],
    specs: [['Rank needed', `hold a point ${RANK_FOR.hold}+ · strike ${RANK_FOR.strike}+ · warheads ${RANK_FOR.nukes}+`], ['Reputation for each rank', RANK_REP.join(' · ')]],
    links: [['How the powers stand', 'fac:politics']] });
}

function stations(add) {
  const world = ui.state ? getWorld(ui.state) : null;
  for (const [id, note] of Object.entries(STATION_NOTES)) {
    const e = world?.get(id);
    const spec = STATIONS[id], m = stationModel(id), o = stationOrbit(id), b = getBody(spec.body);
    const d = spec.defense;
    const where = spec.site === 'surface'
      ? `on ${spec.body}'s surface (radius ${fmtNum(b.radius)} km, ${fmtNum(surfaceGravity(b), 2)} m/s²), turning with it once in ${fmtNum(b.rotH, 1)} h`
      : `orbiting ${spec.body} at ${fmtNum(spec.rKm)} km, once in ${fmtNum(o.period * 24, 1)} h`;
    add({ id: `stn:${id}`, cat: 'stations', title: e?.name || id, sub: `${spec.kind} · ${spec.body}`, text: [note, `Built ${where}.`],
      specs: [
        ['Flag', FACTIONS[e?.faction]?.name || e?.faction || '—'], ['Size', `${fmtNum(Math.round(m.sizeM / 100) / 10)} km across`],
        ['Berths', `${m.berths.length} (${[...new Set(m.berths.flatMap(x => x.accepts))].join('/')} collars) · anchorage ${fmtNum(spec.anchorKm)} km up`],
        ['Approach gate', `${fmtNum(spec.gateKm)} km`], ['People', fmtNum(spec.population)],
        ['Defenses', `${d.pdc} PDC (TL${d.tl})${d.tubes ? ` · ${d.tubes} torpedo silos` : ''}${d.railgun ? ` · ${d.railgun} railguns` : ''} · ${fmtNum(d.hp)} DP, armor ${d.armor}`],
        ['Services', spec.services.join(', ')],
        ...(spec.military ? [['Berths for', 'its navy and its own contractors, and others with standing 30 or better']] : []),
      ],
      links: e ? [[FACTIONS[e.faction]?.name || e.faction, `fac:${e.faction}`], ['Traffic control', 'nav:traffic'], ['Docking', 'nav:docking']] : [] });
  }
}
