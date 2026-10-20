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
      ['Crew', `${c.crew[0]}–${c.crew[1]}${c.berths ? ` · ${c.berths} berths` : ''}`],
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
    add({ id: `fac:${f.id}`, cat: 'factions', title: f.name, text: [f.desc || ''],
      specs: [['Navy', f.navy || '—'], ['Police', f.police || '—']],
      links: CLASS_IDS.filter(c => CLASSES[c].factions[f.id]).slice(0, 12).map(c => [CLASSES[c].name, `ship:${c}`]) });
  }
}

function stations(add) {
  const world = ui.state ? getWorld(ui.state) : null;
  for (const [id, note] of Object.entries(STATION_NOTES)) {
    const e = world?.get(id);
    add({ id: `stn:${id}`, cat: 'stations', title: e?.name || id, sub: e ? `${e.shipClass} · ${e.orbit?.body || ''}` : '', text: [note],
      specs: e ? [['Flag', FACTIONS[e.faction]?.name || e.faction], ['Mass', `${fmtNum(e.mass)} t`]] : [],
      links: e ? [[FACTIONS[e.faction]?.name || e.faction, `fac:${e.faction}`]] : [] });
  }
}
