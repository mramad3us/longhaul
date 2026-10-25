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
import { RANKS as CREW_RANKS, RANK_XP, RANK_SKILL, WAGE, PAY_DAYS, CABIN_FEVER_DAYS, QUIT_MORALE, naturalHazard } from '../sim/careers.js';
import { GROUND, COURSE_COST, COURSE_DAYS, COURSE_GAIN, NEURAL_COST } from '../sim/ground.js';
import { $, esc, setHTML, show, fmtKm, fmtNum } from './dom.js';
import { AU_KM } from '../core/constants.js';
import { CLASSES, CLASS_IDS, KINDS, BUILDERS, TECH, SIZES, PLAYABLE, hullPoints, ratedG } from '../sim/ship-classes.js';
import { classStrength } from '../sim/combatants.js';
import { SYSTEMS, SYSTEM_IDS } from '../sim/systems.js';
import { TileType, TILE_NAMES, TILE_DESCRIPTIONS } from '../sim/tiles.js';
import { PDC, TORPEDO_MOTOR, WARHEADS, PROFILES, FAST_VC, SEEKER_SLACK, RAILGUN, RAIL_RANGE_M, MINING_GEAR, EVADE_G, COUNTER_BURN_S, UNDER_FIRE_CLOSE_MS } from '../sim/weapons.js';
import { SUSTAIN_G, SPRINT_LOSS } from '../sim/agents.js';
import { INSPECTED_MIN } from '../sim/law.js';
import { PIRATE_BOUNTY, RANSOM, RANSOM_SHARE } from '../sim/prisoners.js';
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
import { FLAG_LETTERS } from '../sim/flags.js';
import { DRONE_RACK, DRONE_FOLLOW_G, DRONE_LAUNCH_MIN, DRONE_RECOVER_MIN, DRONE_ENDURANCE_MIN, DRONE_PRICE } from '../sim/drones.js';
import { SCOPES, WAVELENGTH_M, MAG_LIMIT, reflectMag, HULL_ALBEDO, FILTERS } from '../sim/telescope.js';
import { HULL_CAMS } from './hullcam.js';
import { SHUTTLE_CAMS } from './shuttlecam.js';
import { WORLDS, airspacesOf, controlWords, WELL_G, SETTLEMENTS, UNSETTLED } from '../sim/worlds.js';
import { entryProfile, ascentProfile, HEAT_LIMIT } from '../sim/planetary.js';
import { BAYS, landsBy } from '../sim/ship-classes.js';
import { GOODS, GOOD_IDS } from '../sim/goods.js';
import { MARKETS, MARKET_IDS, SPREAD, FENCE, PRICE_MIN, PRICE_MAX } from '../sim/market.js';
import { OWN_ARRIVAL_S } from '../sim/combat.js';

const CATEGORIES = [
  { id: 'ships', label: 'SHIP CLASSES' },
  { id: 'yards', label: 'YARDS & TECH' },
  { id: 'systems', label: 'SHIP SYSTEMS' },
  { id: 'fittings', label: 'FITTINGS' },
  { id: 'weapons', label: 'WEAPONS' },
  { id: 'nav', label: 'NAVIGATION' },
  { id: 'crew', label: 'CREW & MEDICINE' },
  { id: 'factions', label: 'FACTIONS' },
  { id: 'trade', label: 'TRADE' },
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
      ['Atmosphere', landsBy(id)],
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
    text: ['A small fusion missile with a fixed Δv. It builds up a closing speed and holds it, burning again whenever the target pulls away, and corrects its aim every minute. A torpedo that loses its target flies on the last track it had, and destroys itself if it finds nothing there.',
      `Against a ship running, it burns at its motor's full G early, building as much closing speed as the runner's own burn will bleed off by arrival, and coasts in. Its seeker holds the lock up to ${Math.round((SEEKER_SLACK - 1) * 100)}% past the FAST speed; arriving faster it seldom does, so a torpedo too fast brakes on the way in. Its reach is still finite: fire control's REACH says before launch whether a shot gets there.`,
      'It talks to its ship both ways: the ship feeds it the track, it reports where it is. Talking is emitting, so a FAST torpedo in link shows to the target\'s short-range sensors with its drive cold (better kit more quietly); a COLD COAST one only listens.'],
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
  add({ id: 'nav:running', cat: 'nav', group: 'Stances', title: 'Ships that run',
    text: [`A ship that can't win a fight runs, as a captain with people aboard would: a sprint at the drive's best while the crew can take it, then ${SUSTAIN_G} G, what a juiced crew takes for days. Past that every minute is strokes, for their crew as for ours, and a captain spends no more than ${Math.round(SPRINT_LOSS * 100)}% of the crew on the sprint: nobody holds 8 G for hours.`,
      'A ship running without a transponder cuts its drive and coasts dark once it is out past what our sensors hold of its cold hull, and stays dark until we find it again: its last fix points down the line it coasts on. It keeps burning while torpedoes it has seen are still coming. Run down all the same, it strikes, or turns and fights.'],
    links: [['Juice', 'crew:juice'], ['Torpedo', 'wpn:torpedo']] });
  add({ id: 'nav:prisoners', cat: 'nav', group: 'Stations', title: 'Prisoners',
    text: ['A beaten crew taken aboard rides in the brig (a warship has one), then in any free berth. In port they are turned over to the local authority, or their officers ransomed.',
      `Turned over: pirates and a wanted ship\'s crew earn the bounty (${PIRATE_BOUNTY.toLocaleString()} MCR a head) and standing with the station\'s power; its enemies earn standing with it, and with our command if it is ours; anyone else is let go, and their power remembers we held them.`,
      'Ransomed: a captain and officers are worth paying for to their own side, through the station\'s brokers. The local power doesn\'t like to see its criminals or its enemies bought free. A criminal\'s friends never pay what the law does: a pirate captain fetches three quarters of their turn-over bounty, and the captain of a ship we hold a bounty on three quarters of what the contract pays to bring them in.',
      'A bounty\'s own crew are held for its contract: handed over with it, paid by the head (its captain worth four of them), not turned over.'],
    specs: [...Object.entries({ military: 'Navy officer', authority: 'Police officer', irregular: 'Pirate captain', commander: 'A strike target\'s commander' }).map(([k, label]) => [label, `${RANSOM[k].toLocaleString()} MCR`]),
      ['A bounty\'s captain', `${Math.round(RANSOM_SHARE * 100)}% of the contract\'s price for them`]] });
  add({ id: 'nav:police', cat: 'nav', group: 'Stations', title: 'Police stops',
    text: ['A patrol stops ships only inside its jurisdiction: the space its power holds or contests, or the zone it was sent to enforce. It won\'t order a stop to a ship whose course takes it out before the cutter could be alongside, and it withdraws the order if we leave.',
      `One stop at a time: no order while another is open or another cutter is coming alongside or searching us, none in port or in the middle of a fight. After a search the power\'s patrols wave us through for ${INSPECTED_MIN / 1440} days, unless we give them new cause. A licensed captain in one of its own navy\'s hulls, under its banner, is never stopped by that power\'s security, short of a warrant.`],
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
      'A contact that drops off the board leaves its last fix: the plot coasts it on its last velocity inside a circle that grows with the hours, since it may have burned since. PLOT ROUTE flies to where the fix has coasted to, and our sensors take the route over when they hold the contact again.',
      `Every station's traffic control publishes a digest every ${DIGEST_MIN / 60} hours: the transponder ships within ${fmtKm(TC_REACH_AU * AU_KM)} of it, berthed or with a filed flight plan. It reaches us after the light time from that station. A filed plan is flown forward on the plot, and the nav computer can plot a route to it. Ships without a transponder are never in a digest.`,
      'News of hot zones and losses travels at light speed too. A zone is on the plot once its news has arrived, and stays there until news of its end does.'],
    specs: [['One light-second', '299,792 km'], ['One light-minute', `${fmtNum(LIGHT_MINUTE_AU * AU_KM / 1e6, 1)} M km`], ['Earth to Ceres', '≈ 10–30 light-minutes'], ['Ceres to Jupiter', '≈ 15–50 light-minutes']],
    links: [['Who is out there', 'nav:population']] });
  add({ id: 'nav:drones', cat: 'nav', group: 'The cameras', title: 'Camera drones',
    text: ['Nothing aboard sees the whole of our hull from outside: the hull cameras see out, a piece of the ship in each frame. To look at the ship in its surroundings, alongside another hull, in a berth, over a rock, a camera drone goes out (DEPLOY on the EXTERIOR display\'s bar), climbs to a standoff off the plane and looks down: that is the exterior picture. Without one out, the drone\'s picture is blank.',
      `A drone goes out only with the drive cold. It keeps up with the RCS and a docking's final approach (up to ${DRONE_FOLLOW_G} G), not with a burn: a burn leaves it behind, and it is lost. A route waits for it as for the crew to strap in, calling it home as it is engaged; EXECUTE NOW goes without it. Coasting on a route, it is called home ahead of the flip. When its cells run low it comes home by itself.`],
    specs: [['Rack', Object.entries(DRONE_RACK).map(([k, n]) => `${SIZES[k].label} ${n}`).join(' · ')], ['Out to its standoff', `${DRONE_LAUNCH_MIN} min`], ['Home and in its bay', `${DRONE_RECOVER_MIN} min`],
      ['Endurance', `${DRONE_ENDURANCE_MIN / 60} h`], ['Keeps up with', `${DRONE_FOLLOW_G} G`], ['Price', `${fmtNum(DRONE_PRICE)} MCR, any port`]],
    links: [['The hull cameras', 'nav:hullcams'], ['The telescope', 'nav:telescope']] });
  add({ id: 'nav:worlds', cat: 'nav', group: 'Worlds', title: 'Planetary space',
    text: [`Out in the system a planet is a dot. Close in it is the biggest thing there is. A world (a planet, or a moon a thousand kilometres across or more) holds a space of its own: out to where its pull falls to ${WELL_G} G, half what an RCS pushes, inside half its Hill sphere. Inside it no ship can hold a place on its thrusters: it orbits, or it holds on the drive. There the nav computer flies planetary flight, and the world's ground control, where it has one, answers for it.`,
      'Inside: high orbit, from the edge down; the stationary orbit, where an orbit keeps pace with the ground (Earth\'s at 42,164 km), if the world turns fast enough for one inside its space (Venus doesn\'t, nor any moon that keeps one face to its planet); low orbit, from just over the air to a third of a radius up, ground control\'s to clear; and the air, an exponential column from the ground to the entry interface.',
      'A route to a world ends in a high orbit: ORBIT, its parking orbit at the edge of planetary space, a free orbit that costs nothing to keep; or, from a world\'s airspace on its sheet (ORBIT OVER), its stationary orbit over that airspace. No hull we command is rated for an air: the nav computer keeps out of it as it keeps off a rock, the planner refuses a route that goes into it, and a ship that falls in anyway is dragged by it, and told of the heat of it. A big hull reaches the ground by its shuttles, from a high orbit.',
      'Picked on the map, a world shows its space: its pull as a faint wash with contours, the edge, the Hill sphere, the high and stationary orbits, the low band, the air, and its airspaces round its limb. FOCUS frames it.'],
    specs: WORLDS.map(w => [w.name, `space ${Math.round(w.wellM / 1000).toLocaleString()} km · high orbit ${Math.round(w.parkM / 1000).toLocaleString()} km${w.sync ? ` · stationary ${Math.round(w.sync / 1000).toLocaleString()} km` : ''}${w.atmo ? ` · air to ${Math.round(w.atmo.interfaceM / 1000)} km` : ''} · ${controlWords(w)}`]),
    links: [['Airspaces', 'nav:airspaces']] });
  add({ id: 'nav:airspaces', cat: 'nav', group: 'Worlds', title: 'Airspaces and the ground',
    text: ['A world people live on shares its ground out: its airspaces run round its equator, one for every 3,500 km of it, each with its authority and its controller, from the ground up through low orbit. A landing in one is that controller\'s to clear (and a low orbit over it, in time). They turn with the world. The giants have no ground; Mercury, Venus and Io have nobody on theirs, and no airspaces.',
      'Each airspace has its spaceport, where a shuttle lands. More places will come: fixed ports and settlements, and the bare sites missions send a ship to (camps, mines, wrecks), each made from a seed, hundreds to a world.'],
    specs: WORLDS.filter(w => airspacesOf(w).length).map(w => [w.name, `${airspacesOf(w).length}: ${airspacesOf(w).map(a => a.name).join(', ')}`]),
    links: [['Planetary space', 'nav:worlds'], ['Who lives where', 'nav:settled'], ['Shuttles', 'nav:shuttles']] });
  add({ id: 'nav:settled', cat: 'nav', group: 'Worlds', title: 'Who lives where',
    text: ['People live on seven worlds: Earth, the Moon, Mars, and the three outer Galileans and Titan. Everywhere else in the system they live in stations, in the Belt and round the giants. Mars was terraformed, a little: its air is thin, but breathable on the low ground, and it has a young sea in the north.',
      'Mercury, Venus and Io are nobody\'s ground. Venus is the one that is talked about: 92 bar of carbon dioxide at 464 °C on its surface, but at the cloud tops, 50–55 km up, the air is an Earth\'s pressure and temperature, and a floating station could stay up there. Nobody has built one.'],
    specs: [...Object.entries(SETTLEMENTS).map(([n, x]) => [n, `${x.people}: ${x.note}`]), ...Object.entries(UNSETTLED).map(([n, x]) => [n, x])],
    links: [['Airspaces and the ground', 'nav:airspaces']] });
  add({ id: 'nav:shuttles', cat: 'nav', group: 'Worlds', title: 'Shuttles',
    text: ['No hull is rated for an atmosphere: built for space, its fusion drive would burn the spaceport it came down on, and its RCS can\'t hold it up in a world\'s pull. Every hull carries what lands for it in its bays: a gig under a small hull\'s keel (a pilot, three more and their kit), a pinnace for a dozen people and four tonnes, a cargo lander for sixty. Belly-first, under ceramic tiles, they fly an entry and land on skids, then climb back out on their own drives.',
      'A run goes from a high orbit round a world (its parking orbit, or a stationary one: ORBIT or ORBIT OVER), to a spaceport in one of its airspaces (G, or SEND SHUTTLE on the world\'s sheet), and the plan is the whole of it before anything moves: the drop to the top of the air, aimed for where the entry must begin for the pad to be under the glide\'s end as the world turns; the entry and the landing; the turnaround on the pad; the climb; the way back up to where we will be. The controller must clear the landing: it won\'t, to a ship its power wants, or one flying an enemy\'s flag.',
      'Who goes is the captain\'s choice: the pilot (the best able hand unless another is picked), and who rides down in the seats (a gig three, a pinnace twelve, a lander two). With ASHORE they go on leave at the spaceport, the shuttle on the pad eight hours instead of a turnaround, paid there (60 MCR a head): back rested, fed and in better spirits, as from a station\'s shore leave. Whoever goes is away until it is home: their stations unmanned, our routes waiting for them. CAMERA rides along on its cameras; MAP follows it on the system display. The freight of a PLANETSIDE contract bound for that pad goes down with it and is paid by radio when it is on the ground. What it burns comes out of our tanks when it is home. CALL BACK brings it back: braking short of the air while it still can, or else landing and lifting again at once. If we move while it is out it comes after us; out of its world\'s space, it orbits where it is and waits for us.',
      'Other hulls do the same: a ship with shuttles sometimes calls at a settled world near its port instead of the next port, holds its parking orbit while its shuttles work, and goes on. Near one, we see their shuttles come and go.'],
    specs: Object.entries(BAYS).filter(([k]) => CLASSES[k]).map(([k, v]) => [CLASSES[k].name, Object.entries(v).map(([c, n]) => `${n} ${CLASSES[c].name.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ')]),
    links: [['Atmospheric entry', 'nav:entry'], ['The shuttle\'s cameras', 'nav:shuttlecams'], ['Airspaces and the ground', 'nav:airspaces']] });
  add({ id: 'nav:entry', cat: 'nav', group: 'Worlds', title: 'Atmospheric entry',
    text: ['A shuttle hits the top of the air at nearly orbital speed (7 km/s at Earth, 3 at Mars, 1.6 at Titan) and the air does the braking: the drag, and the heat of the shock in front of it (Sutton–Graves: it goes with the square root of the density and the cube of the speed). It flies belly-first at a high angle, banking its lift to hold its sink, so it slows high up where the air is thin, glides thousands of kilometres downrange, and comes down the last few kilometres on its drive.',
      `What the shield takes is the limit: ceramic tiles ${(HEAT_LIMIT['ceramic tiles'] / 1e6).toFixed(1)} MW/m², an ablative ring ${(HEAT_LIMIT['ablative ring'] / 1e6).toFixed(1)}; and the crew\'s G. An airless moon is a landing on the drive from 10 km over the pad, a few minutes. Every entry is flown once, as physics, in the world\'s turning frame (gravity, the turn, drag, lift, the drive), and then ridden on rails.`],
    specs: [['Earth', 'Earth', 'pinnace'], ['Earth (lander)', 'Earth', 'lander'], ['Mars', 'Mars', 'pinnace'], ['Titan', 'Titan', 'pinnace'], ['Luna', 'Luna', 'lander']].map(([k, w, c]) => { const p = entryProfile(w, c), u = ascentProfile(w, c); return [k, p ? `${p.entryV ? `in at ${(p.entryV / 1000).toFixed(1)} km/s, heat ${(p.peakHeat / 1e6).toFixed(2)} MW/m² at its peak, ` : 'powered, '}${p.peakG.toFixed(1)} G, down in ${Math.round(p.t / 60)} min; up in ${Math.round(u.t / 60)}` : 'no way down']; }),
    links: [['Shuttles', 'nav:shuttles']] });
  add({ id: 'nav:shuttlecams', cat: 'nav', group: 'The cameras', title: 'The shuttle\'s cameras',
    text: ['Three fixed lenses on a shuttle of ours that is out (SHUTTLE on the EXTERIOR display\'s bar, or CAMERA on its run in the shuttle window), riding it the whole way down to the pad and back up: NOSE, just past the nose, looking ahead and down; DOWN, under the belly between the skids, looking down and a little ahead, the ground going by and the pad coming up; TAIL, on a short mast at the stern, looking back down the hull and its plume. With more than one out, the bar picks which.',
      'The craft turns as it flies: on the drive its nose is along its thrust, flipped to brake; in the entry it comes belly first into the air flowing past it, its nose pitched up steeply high and fast and easing as it slows, level for the powered landing; on the pad it stands on its skids; climbing out it pitches over downrange.',
      'What they see is the world under them at its true size, from the telescope\'s own map, turning, its ground in relief at every scale the picture shows (Mars\'s craters and ridges, Titan\'s dunes, Earth\'s mountains and its sea glinting); its air the limb\'s glow from orbit and the sky inside, bright enough by day to hide the stars, the distance hazed; Earth\'s clouds a deck of their own some kilometres up, to come down through; by night the lights of the towns round every spaceport; the pad ringed and lit. Through the entry the shock in front of the belly glows round the frame, as hot as the heat on the tiles at that moment, in the air\'s own colour: pink over Earth, orange over Mars, violet over Titan. The caption carries the run: its stretch, height, speed through the air, the heat and the G, and when it is home.'],
    specs: SHUTTLE_CAMS.map((c, i) => [`CAM ${i + 1} · ${c.label}`, c.name.toLowerCase()]),
    links: [['Shuttles', 'nav:shuttles'], ['Atmospheric entry', 'nav:entry'], ['The hull cameras', 'nav:hullcams']] });
  add({ id: 'nav:hullcams', cat: 'nav', group: 'The cameras', title: 'The hull cameras',
    text: ['Four fixed wide-angle cameras on our own plating, looking out, as an airliner\'s do (HULL on the EXTERIOR display\'s bar, or K; K again steps to the next). Nothing to send out or call home: they are always there, burning or not, and a piece of the ship is in every frame.',
      'FWD sits on a mast over the dorsal plating near the stern and looks forward along the spine; AFT on a mast near the bow, looking back down the hull to the drive. PORT and STBD are on short booms off the flanks aft, looking forward and out, the flank along one edge of the frame. Each is placed on the hull\'s own plating, whatever the class, and moves with it, flying or mated at a collar.',
      'What they see is what is there: the hulls and stations round us as lit solids, out to 80 km (a 100 m hull is a pixel or two out there), the ground of the rock a port stands on, the worlds at their true size and phase (from a station round a moon the moon fills the frame), the Sun white-hot and unfiltered, the brighter stars, and further out only a lit drive, a point of light. Names and ranges go beside what is in the frame; a click picks it. They are lit as the drone\'s picture is, the Sun\'s light raised out of the plane so the plating they look along takes it, and the Sun is drawn where that light comes from.'],
    specs: HULL_CAMS.map((c, i) => [`CAM ${i + 1} · ${c.label}`, c.name.toLowerCase()]),
    links: [['Camera drones', 'nav:drones'], ['The telescope', 'nav:telescope']] });
  add({ id: 'nav:telescope', cat: 'nav', group: 'The cameras', title: 'The telescope',
    text: ['Every ship carries a telescope on a stabilized mount, part of its sensor suite. LOOK on a contact or a world (or Z) puts it on the screen: one thing, from where we are. The mount slews to it, then holds it. Space is big, and it shows that.',
      `A mirror D across resolves 1.22 λ/D (λ ${WAVELENGTH_M * 1e9} nm); the ship's machinery shakes the mount a little, a lit drive a lot. A hull many resolution elements long is a shape, blurred to what the optics resolve, and the camera zooms out (to 34°) to take in the whole of a ship close by; a few elements, a smudge; less than one, a point. A hull shines by the sunlight it throws back: its size across the line of sight, its paint (stealthy hulls are darker), the Sun's distance, and the phase: with the Sun behind us we see its lit side, with the Sun behind it its night side. A video frame reaches magnitude ${MAG_LIMIT} with half a metre of mirror; fainter is black sky. A lit drive is a star you can see across the system, and outshines the hull; a nuclear or fusion flash outshines everything.`,
      'The camera zooms in steps, each halving the field, from its widest (34°) past the optics\' narrowest, digitally, to a few arcseconds. The computer picks the step that takes in the whole of what it holds (AUTO); − and + on the bar (the keys, or the wheel over the picture) pick another, which holds until AUTO or a new target. The readout gives the field and the zoom, and the computer\'s pick beside the captain\'s.',
      'The mount holds a ship in a field a few arcseconds across only on a fine track, the board\'s fix and the ranging laser together, and only to a range (cut by damage to the sensors). Past it, or for something the board doesn\'t hold, it holds nothing. Worlds and the Sun it holds anywhere, by the ephemeris: a world at its phase, turning, its air glowing at the limb; the Sun through the solar filter, which goes in by itself. A world between us and a ship hides it.',
      `A drive's light is a few emission lines; a hull's is sunlight. FILTER on the camera's bar puts in a line filter: PLUME takes a drive down ${FILTERS.plume.plume} magnitudes and a hull ${FILTERS.plume.hull}; DEEP ${FILTERS.deep.plume} against ${FILTERS.deep.hull}, the frame darker and noisier. It brings a hull out of its own drive's glare. Looking aft through our own lit drive the camera is blind without one, and sees, degraded (washed, blurred, shimmering), with one.`,
      `When our torpedoes are in their last ${OWN_ARRIVAL_S / 60} minutes to a target the telescope can hold, it comes up on the target by itself, through whatever happens to them, shot down, hit or missed, and time runs at 1× for it. A nuclear or reactor burst whites out the sensor, then a fireball kilometres across cools from white to red, the camera pulling back to take it in; a hit throws fire, fragments and venting air; point defense shows as tracer streams. A target blown apart is held on where it was going.`],
    specs: [...Object.entries(SCOPES).map(([tl, S]) => [`TL${tl}`, `${S.apertureM} m mirror · resolves ${(1.22 * WAVELENGTH_M / S.apertureM * 1e6).toFixed(1)} µrad · mag ${(MAG_LIMIT + 5 * Math.log10(S.apertureM / 0.5)).toFixed(1)} · holds to ${fmtNum(S.lockKm)} km`]),
      ...[1_000, 30_000, 300_000, 1_000_000].map(km => [`100 m hull at ${fmtNum(km)} km (Belt)`, `mag ${reflectMag(100 * 20, HULL_ALBEDO, 2.7, km * 1000, 0.6).toFixed(1)}, ${(100 / km / 1000 / (1.22 * WAVELENGTH_M / 0.5)).toFixed(km < 10_000 ? 0 : 2)} resolution elements (TL2)`])],
    links: [['Camera drones', 'nav:drones'], ['The hull cameras', 'nav:hullcams']] });
  add({ id: 'nav:marks', cat: 'nav', group: 'The plot', title: 'The nav computer\'s marks',
    text: ['Every display, and every list that names a ship, marks the same three things, so a contact that matters is never lost in a crowd.',
      'DARK: a ship with no transponder. Whether a contact squawks is known as soon as the board holds it; one running dark (pirates, smugglers, warships on business, wrecks) is drawn hollow where a squawking ship is solid, and called DARK until we know its name. Its last fix on the plot is a broken ring.',
      'Our work: what a signed contract or an answered distress call points at sits in a magenta diamond, the route\'s colour, with the job\'s name: the derelict, the convoy, the survey mark, the port to deliver to or report at. A ship we hunt is on no registry, so a long look will not name it: only its transponder, or its drive signature when the brief has it on file, seen in its plume (a signature is read only while the drive is lit). Every bounty\'s brief says whether the signature is on file; only the most wanted are posted without one, and then the brief gives the reason. Until the ship is named, every dark contact seen in the search area round its last fix is a possible: a dashed diamond and BOUNTY? (or STRIKE?), never its name, until something shows who it is (its plume carries another signature, a long look finds it on a registry, it squawks another name, or its mass is no hull of the target\'s class) and it is ruled out. Destroy a possible that was the target and the sensor logs settle it: the bounty stands.',
      `Flags: F, or FLAG on the card and the contact panel, puts a lettered yellow pennant on what is picked, A to ${FLAG_LETTERS.at(-1)}, on any ship or station we have a track of. A flagged contact is called out when it comes back on the board; the flag goes when the plot forgets the ship. The CONTEXT panel lists the flags.`],
    links: [['Light lag and the plot', 'nav:light']] });
  add({ id: 'nav:population', cat: 'nav', group: 'The plot', title: 'Who is out there',
    text: [`About ${fmtNum(DEFAULT_TRAFFIC)} traffic ships work the lanes between the stations, choosing nearer and friendlier ports. Each power keeps hulls in space as well: ${POLICE_PER_STATION} police cutters on a beat around each of its stations; ${Object.entries(NAVY_STRENGTH).map(([f, n]) => `${n} ${FACTIONS[f].navy} warships`).join(', ')} berthed at their yards until a hot zone calls for them; and about ${PIRATES_AT_LARGE} raiders lying up cold where nobody's writ runs.`,
      `Each power also keeps command ships (${Object.entries(COMMAND_SHIPS).map(([f, n]) => `${n} ${FACTIONS[f].navy}`).join(', ')}): one goes to the rear of every fight its power is in.`,
      'Far from us these ships fly on rails, and what happens to them is settled by outcomes: warships on station at a skirmish lose ships (the few good against the many poor about even in what is lost), pirates take haulers in the lanes through their zone and now and then lose one to their prey\'s guns, a navy on station hunts a proxy\'s raiders, an insurgency\'s cells mine the navy\'s hulls. The wrecks are real and stay where they fell. What is lost is replaced in time: the yards lay down new hulls (days for a cutter, weeks for a battleship, faster in a war) and launch them, and a fight short of its squadron is sent what is in port once enough are in to go together; lost traffic is replaced by new ships out of their power\'s yards.',
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
  const dept = (k, label) => [label, CREW_RANKS[k].join(' → ')];
  add({ id: 'crew:careers', cat: 'crew', title: 'Careers', sub: 'Rank, pay, age and the end of a service',
    text: ['Every hand aboard has a life longer than a watch: an age, a home, a rank in their department and a record of what they have done. Their panel shows it under SERVICE; the roster shows rank and age, the month\'s payroll, and those the ship has lost or seen off.',
      `EXPERIENCE. An hour of real work (a watch at a station, a repair, the helm) is a point; a repair done, a life saved, a hull taken by boarding, a run flown and a fight come through with an enemy on us bring more. A step up wants the experience (${RANK_XP.slice(1).join(', ')} points) and the skill in their department (${RANK_SKILL.slice(1).join(', ')}). When both are there they are due, and the captain PROMOTES them: the promoted are the happier for it and draw more pay. One left due for a month sours.`,
      `PAY. A month\'s wage by rank (${WAGE.join(', ')} MCR, more for pilots, engineers and medics, less for cooks and deckhands) comes out of the ship\'s credits every ${PAY_DAYS} days. Short, they are paid what there is and owed the rest; owed money weighs on them until it is paid, first out of the next pay day. The hiring hall\'s fee is once, to sign them on. The captain takes the ship\'s profit, not a wage.`,
      `MORALE. Their needs set most of it; on top, back pay owed, a step up overdue and cabin fever (from ${CABIN_FEVER_DAYS} days without a run ashore) drag it down. Morale in turn sets how well they work: in good heart (75 and up) a little better than they must, to 8%; sour, much worse, to barely half at the bottom. A hand under ${QUIT_MORALE} for a week means to sign off at the next port, unless things look up.`,
      'LEAVE. A run ashore at a station lifts them; one on a world\'s ground, under a sky, by shuttle, more; one at home (Earth, Mars, Luna, the Belt\'s stations, the Jovian moons, Titan) most.',
      `AGE. Past fifty the body\'s quickness goes, a little a year: piloting and security drift down, engineering and medicine (which are knowing) hold. Natural causes take a few each year from sixty on (about 1 in ${Math.round(1 / naturalHazard(60))} a year at 60, 1 in ${Math.round(1 / naturalHazard(70))} at 70). Each has an age they mean to stop at, 58 to 70: past it they ask to retire. Granted, they sign off at the next port with their back pay, and the crew see them off; asked to stay, they stay, put out, and ask again in three months. Five years past it they go regardless.`,
      'COMMAND. A captain who dies is succeeded by the senior officer aboard: the helm\'s first, then by rank and experience.'],
    specs: [dept('helm', 'Helm'), dept('engine', 'Engine room'), dept('medical', 'Medical'), dept('arms', 'Guns & security'), dept('science', 'Science'), dept('galley', 'Galley'), dept('deck', 'Deck')],
    links: [['A world\'s ground', 'crew:ground'], ['Acceleration', 'crew:g'], ['Juice', 'crew:juice']] });
  add({ id: 'crew:ground', cat: 'crew', title: 'A world\'s ground', sub: 'What a settled world has for a crew',
    text: ['A station is corridors and a concourse; a settled world is millions or billions of people under a sky, and it has what they have built. On a run ashore by shuttle (ASHORE in the shuttle window: the pad held eight hours) each who goes does one thing there, paid on landing and done when they are home; called in off the pad, what was paid for and not done is refunded.',
      'LEAVE. A run ashore under a sky lifts them more than a station\'s (+15 against +8), and at home most (+20): Earth for the Earthers, Mars for the Martians, Luna, the Jovian moons, Titan.',
      `COURSE. A day at an academy in a skill the world teaches: the skill raised, the more the less they know (+${COURSE_GAIN} at nothing, half that at fifty), and experience for it. ${COURSE_COST} MCR; one every ${COURSE_DAYS} days a head. The way for a hand with the years for a step up and not yet the skill.`,
      `HOSPITAL. What the ship can't mend, or not as fast: body and heart made whole, the juice\'s hangover cleared. Brain damage, which the autodoc never mends, only the big worlds\' hospitals can (Earth, Mars, Luna: about ${NEURAL_COST.toLocaleString()} MCR more); a moon\'s clinic heals the rest. The hurt may ride down as patients, though not the critical (stabilize them first), and never at the controls.`,
      'RETIRE. A hand who has asked to retire can sign off on the pad, at home best: the crew\'s send-off the warmer, their seat free for the way up.',
      'THE HALL. Every settled world\'s spaceports have people looking for a berth, most of them from there, the big worlds\' academy-trained. Signed on at the pad (the fee paid on landing), they ride up in the seats left free and come aboard with the shuttle.'],
    specs: Object.entries(GROUND).map(([w, g]) => [w, `${g.hospital === 'full' ? 'hospital' : 'clinic'} · courses: ${g.courses.join(', ')} · hall ${g.hall}`]),
    links: [['Careers', 'crew:careers'], ['Shuttles', 'nav:shuttles']] });
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
      `When its power fights within ${CALLUP_AU} AU, command orders it to the command ship, its forward command (FOB): alongside, supplies cost a tenth while the fight lasts, and the board is all military work: intelligence, holding a control point at a front, strikes on high-value targets, now and then a covert job for a sub-faction against a rival inside the power.`],
    specs: [['Rank needed', `hold a point ${RANK_FOR.hold}+ · strike ${RANK_FOR.strike}+ · warheads ${RANK_FOR.nukes}+`], ['Reputation for each rank', RANK_REP.join(' · ')]],
    links: [['How the powers stand', 'fac:politics'], ['Contraband and the law', 'trade:law']] });
  add({ id: 'fac:fob', cat: 'factions', group: 'The system', title: 'Forward commands (FOBs)',
    text: ['Every power in a fight sends a command ship to the rear of it, a battleship for Earth and Mars, a converted gunship for the OPA, and it holds there for as long as the fight lasts: a forward operating base, a station of circumstance. Its own navy\'s contractors come alongside it to report, to sign for its military work (all of its board), and for supplies, field repairs and torpedoes at a tenth of the price.',
      'On its post it publishes where it is, as a station\'s orbit is charted: the map draws it as a base (a diamond round a dot, in its navy\'s colour, labelled FOB), named, for anyone. On its way out, only its own contractors are told. SERVICE (V) lists each hot zone\'s FOBs under it: on its post and how far, on its way, or none in port yet (one goes out as soon as a yard has one), with MAP and, for our own navy\'s, ALONGSIDE.',
      'It doesn\'t wake by our coming near: only when attacked. Another navy\'s FOB posts no work for us.'],
    links: [['Military licenses', 'fac:service'], ['How the powers stand', 'fac:politics']] });

  // ---- TRADE ----
  const mname = (id) => MARKETS[id].world ? `${MARKETS[id].world} (by shuttle)` : (ui.state ? getWorld(ui.state).get(id)?.name : null) || id.replace(/-/g, ' ');
  add({ id: 'trade:market', cat: 'trade', group: 'The market', title: 'The market',
    text: ['Fifteen markets trade fourteen goods: the stations (but Phobos\' naval yard, which trades with nobody passing) and the ground of the seven settled worlds, traded with by shuttle from a high orbit. Each makes some goods and wants others, and keeps a stock of everything.',
      `A good\'s price is its base price over how full its stock is: plenty is cheap, scarcity dear, between ${PRICE_MIN} and ${PRICE_MAX} times base. We pay ${SPREAD * 100}% over the price and are paid ${SPREAD * 100}% under it, and as we buy the stock falls and the price climbs with it: a deep market (Earth\'s, Mars\') takes a lot before it moves, a shallow one (Vesta\'s electronics) little.`,
      'The whole of it runs on its own, four times a day: every market makes and uses its goods, the goods move between them from the fuller to the emptier, faster between near ones, and now and then a strike, a blight or a boom moves a price for a week or two, and the news says so. Near a hot zone, munitions, medical supplies and food are wanted more, and less is shipped. It is a closed loop: across the system each good is made as fast as it is used.',
      'So a good is cheap where it is made and dear where it is wanted, and a trader\'s margin is the gap less the spread and the walk of the price. Bulk goods (ice, ore) pay little a tonne; the dear ones (machine parts, electronics, pharmaceuticals) pay well, and want capital. What we know of a market far off is its prices a light-time old: the MARKETS window (P). A ship\'s stores in port follow its market too.'],
    specs: MARKET_IDS.map(id => [mname(id), `makes ${Object.keys(MARKETS[id].make).map(g => GOODS[g].name.toLowerCase()).join(', ') || 'nothing'} · wants ${Object.keys(MARKETS[id].want).map(g => GOODS[g].name.toLowerCase()).join(', ')}${MARKETS[id].open === false ? ' · closed to traders' : ''}`]),
    links: [['Goods', 'trade:goods'], ['Holds and cargo', 'trade:holds'], ['Shuttles', 'nav:shuttles']] });
  add({ id: 'trade:goods', cat: 'trade', group: 'The market', title: 'Goods',
    text: ['What is bought and sold, each at its base price: what it fetches where it is neither short nor plentiful. Cargo is labelled by its good, bought or taken.'],
    specs: GOOD_IDS.map(g => [GOODS[g].name, `${GOODS[g].base.toLocaleString()} MCR a tonne · ${GOODS[g].illegalIn ? 'contraband in every power\'s space' : GOODS[g].restricted ? 'restricted' : GOODS[g].cat} · ${GOODS[g].desc}`]),
    links: [['The market', 'trade:market'], ['Contraband and the law', 'trade:law']] });
  add({ id: 'trade:holds', cat: 'trade', group: 'The market', title: 'Holds and cargo',
    text: ['Every hull carries what its trade carries: an ice hauler ice, a tanker volatiles, a miner or an ore scow ore, a freighter what its last port makes, a warship munitions and parts, a pirate loot. A lawful ship with its transponder on has filed its manifest with traffic control, shown on its contact sheet once we know who it is: never the contraband.',
      'A boarding party\'s SEARCH reads the real hold, good by good, and the dossier keeps it. Mated at the collar, TAKE CARGO moves it into ours at thirty tonnes an hour: one good, or all that fits, the dearest first.'],
    links: [['Contraband and the law', 'trade:law'], ['The market', 'trade:market']] });
  add({ id: 'trade:law', cat: 'trade', group: 'The law', title: 'Contraband and the law',
    text: ['Narcotics are contraband wherever a power\'s law runs: only the independent ports (Vesta Depot, Ganymede) trade them, and any power\'s patrol that finds them seizes them and fines us. Munitions are restricted: legal aboard outside Earth\'s and Mars\'s space, and there only with that power\'s license; a UN or MCR port sells them only to its own navy\'s contractors.',
      `Cargo taken from a lawful ship we had no right to board is stolen: its owners\' ports won\'t buy it, other ports pay a fence\'s price for it (${Math.round(FENCE * 100)}%), and its owners\' inspectors seize it. A wreck\'s cargo is salvage, a pirate\'s a prize, and the cargo of a ship that fought us and struck a capture.`,
      'A licensed captain who takes contraband off a hull (narcotics found in a hold) turns it over at its own power\'s port, docked (or alongside its navy\'s command ship): reputation toward the next rank and standing, in proportion to what it is worth, and nothing for a token amount. Its own power\'s inspectors take it as evidence coming in; anyone else\'s seize it as ever. Contraband we bought is no seizure, goods we stole are evidence of our own crime, and a smuggling contract\'s cargo is the client\'s: none of it is for turning over.'],
    links: [['Goods', 'trade:goods'], ['Military licenses', 'fac:service'], ['Police stops', 'nav:police']] });
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
