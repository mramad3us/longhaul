// ============================================================
// LONGHAUL — Entity definitions
// Factory, default stations/ships, NPC ship templates.
// ============================================================

import { random, pick, randInt } from '../core/rng.js';

export const EntityType = {
  STATION: 'station',
  SHIP: 'ship',
  NAV: 'nav',          // navigation marker (survey zone, rendezvous point) — not a sensor contact
};

export const FACTIONS = ['UNN', 'MCRN', 'OPA', 'Belter', 'independent'];

export const FACTION_COLORS = {
  MCRN: '#C1553B',
  UNN: '#4A90D9',
  OPA: '#E2A355',
  Belter: '#7EC8D9',
  independent: '#8A8A6A',
};

function signature() {
  return 'SIG-' + Math.floor(random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Build an entity object. Motion: pass `orbit` for rails, or pos/vel for free flight.
 * The World fills pos/vel for orbiting entities when indexed.
 */
export function createEntity(opts) {
  const e = {
    id: opts.id,
    name: opts.name,
    type: opts.type || EntityType.SHIP,
    faction: opts.faction || 'independent',
    shipClass: opts.shipClass || null,
    mass: opts.mass || 0,                        // metric tons
    pos: opts.pos ? { x: opts.pos.x, y: opts.pos.y } : { x: 0, y: 0 },
    vel: opts.vel ? { vx: opts.vel.vx, vy: opts.vel.vy } : { vx: 0, vy: 0 },
    orbit: opts.orbit ? { body: opts.orbit.body, r: opts.orbit.r, phase: opts.orbit.phase || 0, period: opts.orbit.period || 0 } : null,
    thrust: opts.thrust || 0,                     // G along heading (free flight only)
    heading: opts.heading || 0,                   // radians, solar frame
    transponder: opts.transponder !== false,
    sos: !!opts.sos,
    signature: opts.signature || signature(),
    t: opts.t,                                    // minute pos/vel are valid for
    tags: opts.tags || {},                        // gameplay links (missionId, contractId, …)
  };
  if (e.type === EntityType.STATION) {
    e.board = { missions: [], lastRefresh: -Infinity, refreshInterval: 720, maxMissions: 5 };
  }
  return e;
}

// r in AU, period in days around the anchor body
const DEFAULTS = [
  { id: 'ceres-station', name: 'Ceres Station', type: 'station', faction: 'Belter', shipClass: 'Ceres-class station', mass: 1_200_000,
    orbit: { body: 'Ceres', r: 0.0001, phase: 0.6, period: 17 } },
  { id: 'pallas-station', name: 'Pallas Station', type: 'station', faction: 'OPA', shipClass: 'Tycho-class station', mass: 850_000,
    orbit: { body: 'Pallas', r: 0.0002, phase: 0.4, period: 30 } },
  { id: 'vesta-depot', name: 'Vesta Depot', type: 'station', faction: 'independent', shipClass: 'Mining depot', mass: 450_000,
    orbit: { body: 'Vesta', r: 0.0002, phase: 2.6, period: 25 } },
  { id: 'hygiea-ring', name: 'Hygiea Ring', type: 'station', faction: 'OPA', shipClass: 'Ring station', mass: 320_000,
    orbit: { body: 'Hygiea', r: 0.00018, phase: 5.7, period: 28 } },
  { id: 'tycho-station', name: 'Tycho Station', type: 'station', faction: 'OPA', shipClass: 'Construction platform', mass: 2_400_000,
    orbit: { body: 'Juno', r: 0.0004, phase: 1.1, period: 40 } },
  { id: 'luna-yards', name: 'Luna Shipyards', type: 'station', faction: 'UNN', shipClass: 'Orbital shipyard', mass: 3_100_000,
    orbit: { body: 'Luna', r: 0.00002, phase: 0.2, period: 0.2 } },
  { id: 'phobos-yard', name: 'Phobos Naval Yard', type: 'station', faction: 'MCRN', shipClass: 'Naval yard', mass: 1_900_000,
    orbit: { body: 'Phobos', r: 0.000005, phase: 3.0, period: 0.1 } },
  { id: 'ganymede-station', name: 'Ganymede Station', type: 'station', faction: 'independent', shipClass: 'Agricultural hub', mass: 2_700_000,
    orbit: { body: 'Ganymede', r: 0.00002, phase: 4.2, period: 0.15 } },

  { id: 'mcrn-scirocco', name: 'MCRN Scirocco', type: 'ship', faction: 'MCRN', shipClass: 'Donnager-class', mass: 250_000,
    orbit: { body: 'Mars', r: 0.001, phase: 5.2, period: 6 } },
  { id: 'ice-hauler-pk', name: "Pur'n'Kleen Weeping Somnambulist", type: 'ship', faction: 'Belter', shipClass: 'Canterbury-class hauler', mass: 120_000,
    orbit: { body: 'Ceres', r: 0.00025, phase: 2.0, period: 40 } },
  { id: 'unn-agatha-king', name: 'UNN Agatha King', type: 'ship', faction: 'UNN', shipClass: 'Truman-class', mass: 300_000,
    orbit: { body: 'Earth', r: 0.0008, phase: 0.4, period: 4 } },
  { id: 'opa-molinari', name: 'Guy Molinari', type: 'ship', faction: 'OPA', shipClass: 'Converted freighter', mass: 90_000,
    orbit: { body: 'Vesta', r: 0.0004, phase: 5.5, period: 35 } },
];

export function createDefaultEntities() {
  return DEFAULTS.map(d => createEntity(d));
}

// ---- NPC SHIP TEMPLATES ----

export const SHIP_TEMPLATES = [
  { className: 'Belter ice hauler', massRange: [40_000, 80_000], factions: ['Belter', 'OPA'], prefixes: ['Ice', 'Frost', 'Cryo', 'Cold'], suffixes: ['Hauler', 'Runner', 'Mule', 'Ox', 'Dray'] },
  { className: 'Indie freighter', massRange: [50_000, 120_000], factions: ['independent', 'Belter'], prefixes: ['Star', 'Deep', 'Far', 'Void'], suffixes: ['Venture', 'Prospect', 'Horizon', 'Trader'] },
  { className: 'Prospector skiff', massRange: [8_000, 25_000], factions: ['Belter', 'independent'], prefixes: ['Lucky', 'Iron', 'Red', 'Dust'], suffixes: ['Strike', 'Vein', 'Claim', 'Pick', 'Digger'] },
  { className: 'Passenger liner', massRange: [150_000, 300_000], factions: ['UNN', 'independent'], prefixes: ['Tycho', 'Ceres', 'Eros', 'Luna'], suffixes: ['Star', 'Express', 'Transit', 'Grace'] },
  { className: 'Cargo shuttle', massRange: [15_000, 40_000], factions: ['independent', 'OPA', 'Belter'], prefixes: ['Box', 'Load', 'Haul', 'Bulk'], suffixes: ['Runner', 'Lifter', 'Cart', 'Sled'] },
  { className: 'Mining barge', massRange: [80_000, 200_000], factions: ['Belter', 'OPA'], prefixes: ['Rock', 'Ore', 'Gravel', 'Stone'], suffixes: ['Breaker', 'Crusher', 'Chewer', 'Grinder'] },
  { className: 'Courier', massRange: [5_000, 15_000], factions: ['MCRN', 'UNN', 'independent'], prefixes: ['Swift', 'Flash', 'Quick', 'Razor'], suffixes: ['Arrow', 'Dart', 'Wing', 'Bolt'] },
  { className: 'Tanker', massRange: [100_000, 250_000], factions: ['independent', 'Belter'], prefixes: ['Full', 'Heavy', 'Wet', 'Deep'], suffixes: ['Tank', 'Belly', 'Drum', 'Well'] },
];

/** Random identity for an NPC ship: { name, shipClass, faction, mass }. */
export function rollShipIdentity(template = pick(SHIP_TEMPLATES)) {
  return {
    name: `${pick(template.prefixes)} ${pick(template.suffixes)}`,
    shipClass: template.className,
    faction: pick(template.factions),
    mass: randInt(template.massRange[0], template.massRange[1]),
  };
}

