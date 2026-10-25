// ============================================================
// LONGHAUL — Multispectrum sensors
//
// One detection model for everybody — the player's ops board, NPC
// ships, torpedo seekers. A target has a *signature range*: how far
// away a standard sensor suite can hold it.
//
//   broadcasting (transponder, distress beacon) — heard at long range
//   drive lit — the plume is the brightest thing for millions of km
//   cold and silent — radar/thermal only, by hull size, cut by stealth
//   ordnance — a coasting torpedo is a few meters of cold metal, unless it
//              is talking to its ship (a FAST torpedo in datalink): then
//              the short-range suite holds it (ordnance.js). Our own are
//              on our board by their telemetry, wherever the band reaches.
//
// Whether a contact squawks is known as soon as it is held (a ship
// running dark is marked so on every display: flags.js).
//
// An observer sees a target when it is inside the signature range
// times the observer's sensor quality (tech level, damage, a watch
// stander at ops). The player's display band caps how far the board
// looks. Tracking a contact over time reveals more about it; a
// ranging-laser lock is 3× faster.
//
// Who a contact is: its transponder says so; a long look (REVEAL.PROFILE)
// matches its profile against the registries. A ship we are hunting (a
// bounty, a strike) is on no registry: only its transponder names it, or
// its drive signature, when the brief has it on file (c.sigKnown) and we
// see it in the plume (a drive signature is read only while the drive is
// lit). Until then the contacts it might be are possibles: hunts.js.
//
// Everything on the board is under a light-minute away (long range is
// 50 light-seconds), so the picture is live to within one sim step;
// each contact carries its light time. Beyond the board, what we know
// is reported and aged: intel.js.
// ============================================================

import { RANGE, AU_M } from '../core/constants.js';
import { getWorld } from './world.js';
import { sensorRangeFactor } from './systems.js';
import { CLASSES, SIZES, TECH, classOf, classLabel, PLAYER_CLASS } from './ship-classes.js';

export const SENSOR_RANGES = [
  { name: 'SHORT', au: RANGE.SHORT, label: '~150k km', description: 'All sensors — thermal, EM, lidar' },
  { name: 'MED', au: RANGE.MEDIUM, label: '~1.5M km', description: 'Multi-band radar' },
  { name: 'LONG', au: RANGE.LONG, label: '~15M km', description: 'Telescopes — drive plumes & beacons' },
];

export const REVEAL = { VELOCITY: 5, HEADING: 10, THRUST: 15, MASS: 30, PROFILE: 60 };

export const TORPEDO_RADAR_AU = 0.0002;    // a coasting torpedo: ~30,000 km
export const SLUG_RADAR_AU = 0.00003;      // a railgun slug: ~4,500 km
export const SEEKER_QUALITY = 0.3;         // a torpedo's own seeker vs a ship's sensor suite

export function createSensors() {
  return { range: 0, selected: null, locked: null, scan: {}, contacts: [] };
}

/** Size class of a hull with no catalog class (old saves, contract hulks). */
export function sizeForMass(massT = 0) {
  return massT < 1500 ? 'S' : massT < 20_000 ? 'M' : massT < 100_000 ? 'L' : 'XL';
}

/** How far (AU) a quality-1 sensor holds this entity. */
export function signatureRange(e) {
  if (e.type === 'nav') return 0;
  if (e.type === 'station') return RANGE.LONG * 2;
  if (e.type === 'ordnance') {
    if (e.thrust > 0) return RANGE.LONG * 0.5;
    if (e.ord?.kind === 'slug') return SLUG_RADAR_AU;
    // (talking to its ship, it shows to the short-range suite; better kit talks more quietly)
    return e.ord?.talks ? RANGE.SHORT * TECH[e.tl || 2].stealth : TORPEDO_RADAR_AU;
  }
  if (e.sos || e.transponder || e.thrust > 0) return RANGE.LONG;
  return hullSignature(e);
}

/**
 * How far (AU) a quality-1 sensor holds a ship cold and silent: radar on
 * its hull, by size, cut by stealth. All that running dark comes down to.
 */
export function hullSignature(e) {
  const size = SIZES[classOf(e)?.size || sizeForMass(e.mass)];
  return size.radarAU * TECH[e.tl || 2].stealth;
}

/** The player's own signature range (what NPCs and seekers can see of us). */
export function playerSignatureRange(state) {
  const f = state.flight;
  if (state.comms.transponder || state.comms.sos) return RANGE.LONG;
  if (f.thrustG > 0.01 || state.$jinkG > 0) return RANGE.LONG;
  const c = CLASSES[state.ship.classId || PLAYER_CLASS];
  return SIZES[c.size].radarAU * TECH[state.ship.tl || 2].stealth;
}

/** The player's sensor quality right now (condition, an ops watch, tech level). */
export function playerSensorQuality(state) {
  const ops = state.$watch?.ops != null;
  return sensorRangeFactor(state) * (ops ? 1.25 : 1) * TECH[state.ship.tl || 2].sensors;
}

/** Can an observer of `quality` see something with signature `sigAU` at `distAU`? */
export const canSee = (distAU, sigAU, quality) => distAU <= sigAU * quality;

const _q = [];
const SCAN_CAP = 120;

export function sensorsTick(state) {
  const s = state.sensors;
  const world = getWorld(state);
  const pos = state.flight.pos;
  const quality = playerSensorQuality(state);
  const rate = state.$watch?.ops != null ? 2 : 1;
  const hunts = huntsOf(state);
  _q.length = 0;
  world.query(pos, SENSOR_RANGES[s.range].au, _q);

  const contacts = [];
  const seen = new Set();
  for (const e of _q) {
    // (a shuttle in its carrier's bay is part of its carrier: planetary.js)
    if (e.$inBay) continue;
    const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (!canSee(dist, signatureRange(e), quality) && !(e.type === 'ordnance' && e.ord?.owner === 'player')) continue;
    seen.add(e.id);
    // (a track long enough for every look there is (manifest.js counts at 90) stops growing: a crowded port's board isn't rewritten each minute)
    const cur = s.scan[e.id] || 0;
    const sc = cur >= SCAN_CAP ? cur : (s.scan[e.id] = Math.min(SCAN_CAP, cur + (s.locked === e.id ? 3 : 1) * rate));
    contacts.push(describe(e, dist, Math.atan2(dy, dx), sc, isIdentified(state, e, sc, hunts)));
  }
  // what we no longer see fades: those just off the board, and those fading already (not every key, every minute: a
  // crowded port has tens of thousands on the board; after a load, the first minute walks them once)
  const fade = s.$fade || (s.$fade = new Set(Object.keys(s.scan)));
  for (const c of s.contacts) if (!seen.has(c.id)) fade.add(c.id);
  for (const id of fade) {
    if (seen.has(id) || s.scan[id] == null) { fade.delete(id); continue; }
    s.scan[id] -= 2;
    if (s.scan[id] <= 0) { delete s.scan[id]; fade.delete(id); }
  }
  // Contacts that just dropped off the board (intel.js keeps their last fix)
  const lost = [];
  for (const c of s.contacts) if (!seen.has(c.id)) lost.push(c);
  s.$lost = lost;
  s.contacts = contacts;
  s.$seen = seen;
  if (s.locked && !seen.has(s.locked)) s.locked = null;
  if (s.selected && !seen.has(s.selected)) s.selected = null;
}

/** Is this entity on our sensors right now? */
export const isTracked = (state, id) => !!state.sensors.$seen?.has(id) || state.sensors.contacts.some(c => c.id === id);

/**
 * A ship with no transponder (pirates, smugglers, warships on business,
 * wrecks): the board knows it the moment it holds the contact, since the
 * radio hears an ident or it doesn't. A distress beacon says who it is.
 */
export const isDark = (e) => e.type === 'ship' && !e.transponder && !e.sos;

/** Contracts whose target we must find and name ourselves. */
const HUNTS = new Set(['BOUNTY', 'STRIKE']);

/** The ships we are hunting: target id → its contract. */
export function huntsOf(state) {
  const m = new Map();
  for (const c of state.contracts?.active || []) if (HUNTS.has(c.type) && c.phase === 'active' && c.targetId) m.set(c.targetId, c);
  return m;
}

/**
 * Do we know who this is (on the board, or as last seen)? Its transponder;
 * a long look; for a ship we hunt, only its transponder or its signature
 * matched (identifyHunt). `hunts`: huntsOf(state), when asking about many.
 */
export function isIdentified(state, e, scan = state.sensors.scan[e.id] || 0, hunts = null) {
  if (e.type === 'ordnance') return false;
  if (e.transponder || e.type !== 'ship') return true;
  const hunt = (hunts || huntsOf(state)).get(e.id);
  return hunt ? !!hunt.identified : scan >= REVEAL.PROFILE;
}

/**
 * A hunted ship on the board is named by its transponder, or by its drive
 * signature on file seen in its plume; once named it stays named. Returns
 * true the minute it is (contracts.js and military.js say so).
 */
export function identifyHunt(state, c) {
  if (c.identified || !state.sensors.$seen?.has(c.targetId)) return false;
  const e = getWorld(state).get(c.targetId);
  if (!e) return false;
  if (e.transponder) c.identified = 'transponder';
  else if ((c.sigKnown ?? !!c.signature) && e.thrust > 0 && e.signature === c.signature) c.identified = 'signature';
  return !!c.identified;
}

/** What the board says when a hunted ship is named. */
export const huntNamed = (c) => c.identified === 'signature'
  ? `Drive signature ${c.signature} matched: that contact is the ${c.targetName}`
  : `The ${c.targetName} is squawking its transponder: that is our target`;

/** What the crew knows about an entity after `scan` minutes of observation (`known`: isIdentified). */
export function describe(e, dist, bearing, scan, known = e.type !== 'ordnance' && (e.transponder || scan >= REVEAL.PROFILE)) {
  const ordnance = e.type === 'ordnance';
  return {
    id: e.id,
    dist,                      // AU
    lagS: dist * AU_M / 299_792_458,   // light time: how old the picture of it is, seconds
    bearing,                   // rad, solar frame
    name: ordnance ? (e.ord?.kind === 'slug' ? 'SLUG' : 'TORPEDO') : known ? e.name : null,
    type: ordnance ? 'ordnance' : known ? e.type : null,
    ordnance,
    faction: known ? e.faction : null,
    shipClass: known ? classLabel(e) : null,
    tl: known && e.tl ? e.tl : null,
    signature: e.thrust > 0 ? e.signature : null,
    plume: e.thrust > 0,
    sos: e.sos,
    dark: isDark(e),
    station: e.type === 'station',
    wreck: !!e.tags?.wreck,
    scan,
    velocityKnown: scan >= REVEAL.VELOCITY,
    headingKnown: scan >= REVEAL.HEADING,
    thrust: scan >= REVEAL.THRUST ? (e.thrust > 0 ? `${e.thrust.toFixed(1)}G` : 'COASTING') : null,
    mass: scan >= REVEAL.MASS ? e.mass : null,
  };
}

export function setSensorRange(state, level) {
  state.sensors.range = Math.max(0, Math.min(SENSOR_RANGES.length - 1, level));
  sensorsTick(state);
}

export function selectContact(state, id) {
  state.sensors.selected = id;
}

export function toggleLock(state, id) {
  const s = state.sensors;
  if (s.locked === id) { s.locked = null; return false; }
  s.locked = id;
  s.selected = id;
  return true;
}

/**
 * A contact on the board by id: through an index of the board, made again
 * when the board is (once a minute; a crowded port's holds thousands, and
 * the displays ask for many every frame).
 */
const _byId = new WeakMap();
export function contactById(state, id) {
  const list = state.sensors.contacts;
  let m = _byId.get(list);
  if (!m) { m = new Map(); for (const c of list) m.set(c.id, c); _byId.set(list, m); }
  return m.get(id) || null;
}
