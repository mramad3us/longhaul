// ============================================================
// LONGHAUL — Entity definitions
// Factory and the default stations and ships. Ship identities (class,
// tech level, name) come from the catalog in ship-classes.js.
// ============================================================

import { random } from '../core/rng.js';
import { CLASSES } from './ship-classes.js';
import { STATIONS, stationOrbit, gateOrbit, gateId, stationModel } from './stations.js';

export const EntityType = {
  STATION: 'station',
  SHIP: 'ship',
  ORDNANCE: 'ordnance',  // torpedo or railgun slug in flight
  NAV: 'nav',            // navigation marker (survey zone, rendezvous point, approach gate) — not a sensor contact
};

function signature() {
  return 'SIG-' + Math.floor(random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Build an entity object. Motion: pass `orbit` for rails, or pos/vel for free flight
 * (`driven: true` when a controller — NPC pilot, torpedo guidance — steps it).
 * The World fills pos/vel for orbiting entities when indexed.
 */
export function createEntity(opts) {
  const cls = opts.cls && CLASSES[opts.cls] ? opts.cls : null;
  const e = {
    id: opts.id,
    name: opts.name,
    type: opts.type || EntityType.SHIP,
    faction: opts.faction || 'independent',
    cls,                                          // catalog class id (ships)
    tl: cls ? CLASSES[cls].tl : (opts.tl || 2),        // a class's tech level is its yard's
    shipClass: opts.shipClass || (cls ? CLASSES[cls].name : null),
    mass: opts.mass || (cls ? CLASSES[cls].massT : 0),   // metric tons
    pos: opts.pos ? { x: opts.pos.x, y: opts.pos.y } : { x: 0, y: 0 },
    vel: opts.vel ? { vx: opts.vel.vx, vy: opts.vel.vy } : { vx: 0, vy: 0 },
    orbit: opts.orbit ? { body: opts.orbit.body, r: opts.orbit.r, phase: opts.orbit.phase || 0, period: opts.orbit.period || 0 } : null,
    driven: !!opts.driven,
    thrust: opts.thrust || 0,                     // G along heading (free/driven flight)
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

/** What the ship's library says about each charted station (kept out of the save). */
export const STATION_NOTES = {
  'ceres-station': "The Belt's biggest port: a spun-up rock at the heart of the asteroid belt, with docks, ice markets and the OPA's loudest voice.",
  'pallas-station': 'Refinery station on Pallas, smelting metals from Belt ore. Steady work for haulers.',
  'vesta-depot': 'Mining depot serving the prospectors and ore haulers round Vesta. Rough, cheap and independent.',
  'hygiea-ring': 'A ring station on Hygiea, far out in the Belt: a quiet place to resupply.',
  'tycho-station': "Tycho Manufacturing's construction platform, where the Belt builds its biggest ships.",
  'luna-yards': "Earth's orbital yards above the Moon: home port of the UNN, and Earth-quality refits for anyone who can pay.",
  'phobos-yard': "The MCRN's naval yard on Phobos, under Mars. Martian warships are built and overhauled here, and strangers are watched.",
  'ganymede-station': "Ganymede's agricultural hub, the breadbasket of the outer planets, growing under mirrors and domes.",
};

// r in AU, period in days around the anchor body
// Stations: where and what they are lives in stations.js
const STATION_DEFAULTS = [
  { id: 'ceres-station', name: 'Ceres Station', faction: 'OPA', mass: 1_200_000 },
  { id: 'pallas-station', name: 'Pallas Station', faction: 'OPA', mass: 850_000 },
  { id: 'vesta-depot', name: 'Vesta Depot', faction: 'independent', mass: 450_000 },
  { id: 'hygiea-ring', name: 'Hygiea Ring', faction: 'OPA', mass: 320_000 },
  { id: 'tycho-station', name: 'Tycho Station', faction: 'OPA', mass: 2_400_000 },
  { id: 'luna-yards', name: 'Luna Shipyards', faction: 'UN', mass: 3_100_000 },
  { id: 'phobos-yard', name: 'Phobos Naval Yard', faction: 'MCR', mass: 1_900_000 },
  { id: 'ganymede-station', name: 'Ganymede Station', faction: 'independent', mass: 2_700_000 },
];

const DEFAULTS = [

  { id: 'mcrn-scirocco', name: 'MCRN Scirocco', type: 'ship', faction: 'MCR', cls: 'mcrn-battleship', tl: 4, shipClass: 'Olympus-class battleship', mass: 250_000,
    orbit: { body: 'Mars', r: 0.001, phase: 5.2, period: 6 } },
  { id: 'ice-hauler-pk', name: "Pur'n'Kleen Weeping Somnambulist", type: 'ship', faction: 'OPA', cls: 'ice-hauler', tl: 1, shipClass: 'Canterbury-class ice hauler', mass: 120_000,
    orbit: { body: 'Ceres', r: 0.00025, phase: 2.0, period: 40 } },
  { id: 'unn-agatha-king', name: 'UNN Agatha King', type: 'ship', faction: 'UN', cls: 'unn-battleship', tl: 3, shipClass: 'Leviathan-class battleship', mass: 300_000,
    orbit: { body: 'Earth', r: 0.0008, phase: 0.4, period: 4 } },
  { id: 'opa-molinari', name: 'Guy Molinari', type: 'ship', faction: 'OPA', cls: 'opa-gunship', tl: 1, shipClass: 'Converted-freighter gunship', mass: 9_000,
    orbit: { body: 'Vesta', r: 0.0004, phase: 5.5, period: 35 } },
];

export function createDefaultEntities() {
  const out = [];
  for (const d of STATION_DEFAULTS) {
    out.push(createStation(d));
    out.push(createEntity({ id: gateId(d.id), name: `${d.name} approach gate`, type: EntityType.NAV, faction: d.faction, orbit: gateOrbit(d.id), signature: 'GATE', tags: { gate: d.id } }));
  }
  for (const d of DEFAULTS) out.push(createEntity(d));
  return out;
}

/** A station entity on the orbit its model puts it on (stations.js). */
export function createStation(d) {
  const spec = STATIONS[d.id];
  return createEntity({ ...d, type: EntityType.STATION, shipClass: spec.kind, orbit: stationOrbit(d.id), transponder: true });
}

/** The station a ship-sized size label is quoted for (library, scanner). */
export const stationSizeM = (id) => stationModel(id)?.sizeM || 0;
