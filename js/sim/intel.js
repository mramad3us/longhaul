// ============================================================
// LONGHAUL — What we know: light lag, the plot, the fog
//
// Light crosses an AU in 8.3 minutes, and nothing we learn about the
// system travels faster. Our own sensors hold what they hold out to
// 15 million km at most: under a light-minute, less than one sim step,
// so the sensor picture is live. Everything else on the plot is a
// REPORT, and every report has an age:
//
//   OUR OWN TRACKS. A contact that drops off the board leaves its last
//     fix. The plot coasts it on its last velocity, and the circle it
//     could be in grows with the hours (it may have burned since). While
//     a contact is on the board, the board is the plot.
//   TRAFFIC DIGESTS. Every station's traffic control publishes, every
//     six hours, the transponder ships in its control space: who is
//     berthed there, and the flight plans of ships coming and going.
//     Relayed system-wide, a digest reaches us after the light time
//     from that station: Ganymede's is forty minutes old when it lands
//     at Ceres, and six hours older again by the next one. A filed plan
//     is flown forward on the plot to its arrival. Ships running without
//     a transponder (pirates, smugglers, warships on business) are never
//     in a digest.
//   THE NEWSFEED. News of hot zones and losses leaves from where it
//     happened and reaches us at light speed. A zone is on our plot once
//     its news has arrived, and off it once news of its end has.
//
// Stations, nav marks and contract targets sit on published orbits:
// their positions are charted, not observed.
//
// Nothing here is per-entity per-minute: the plot is bounded
// (INTEL_MAX records, the stalest dropped first), each digest is capped,
// and the inbox holds a few dozen items in flight.
// ============================================================

import { AU_M, MIN_S, DAY_MIN, G0 } from '../core/constants.js';
import { hashString } from '../core/rng.js';
import { getWorld, transitStateAt } from './world.js';
import { radioRangeFactor } from './systems.js';
import { declaredSouls } from './manifest.js';

export const C_MS = 299_792_458;                        // speed of light, m/s
export const LIGHT_SECOND_AU = C_MS / AU_M;             // ≈ 0.002 AU (300,000 km)
export const LIGHT_MINUTE_AU = LIGHT_SECOND_AU * 60;    // ≈ 0.12 AU (18M km)

export const DIGEST_MIN = 6 * 60;      // each station's traffic control publishes this often
export const TC_REACH_AU = 0.03;       // its control space: berths, departures and arrivals (4.5M km)
export const DIGEST_MAX = 400;         // ships listed in one digest at most
export const INTEL_MAX = 6000;         // records on the plot at most (the stalest go first)

// How fast a report goes stale (for the uncertainty circle drawn on the plot)
const DRIFT_MS = 30;                   // velocity error of a fix, m/s
const MANEUVER_G = 0.05;               // what an unseen ship might have burned since, on average
const PLAN_DRIFT_AU_PER_DAY = 0.0005;  // filed plans are flown, but not to the kilometre
const FORGET_FIX_MIN = 5 * DAY_MIN;    // a coasting fix is worthless after this
const FORGET_BERTH_MIN = 4 * DAY_MIN;  // ships don't stay berthed forever
const FORGET_PLAN_AFTER_MIN = 2 * DAY_MIN;   // …past a plan's arrival

export function createIntel() {
  // tracks: id → record (below) · inbox: reports in flight, sorted by arrival
  // zones: hot zones whose news has reached us · digests: station id → last digest received
  return { tracks: {}, inbox: [], zones: {}, digests: {} };
}

/** Old saves have no plot: start one (zones already under way are common knowledge). */
export function ensureIntel(state) {
  if (state.intel) return state.intel;
  state.intel = createIntel();
  for (const z of state.politics?.zones || []) state.intel.zones[z.id] = zoneNote(z, state.clock.minute);
  return state.intel;
}

/** What the plot keeps of a zone: where it is and what it is (its news may be old). */
const zoneNote = (z, heard) => ({ kind: z.kind, body: z.body, factions: z.factions, r: z.r, phase: z.phase, radius: z.radius, heard });

/** Light time over a distance, in game-minutes (fractional). */
export const lightMinutes = (distAU) => distAU * AU_M / C_MS / MIN_S;

// ---- THE INBOX ----

function queue(state, item) {
  const box = ensureIntel(state).inbox;
  let i = box.length;
  while (i > 0 && box[i - 1].at > item.at) i--;
  box.splice(i, 0, item);
}

/**
 * Send news from `fromPos` to us at light speed: `type`/`payload` are
 * emitted when it arrives (with `lagMin`, how old it is by then). `zone`
 * (optional: { id, kind, body, factions, r, phase, radius, ended }) updates the zones we
 * know of on arrival. Payloads are kept in the save: ids, not objects.
 */
export function relay(state, fromPos, type, payload, zone = null) {
  const f = state.flight.pos;
  const lag = lightMinutes(Math.hypot(fromPos.x - f.x, fromPos.y - f.y));
  queue(state, { at: state.clock.minute + Math.round(lag), sent: state.clock.minute, type, payload, zone });
}

// ---- PER MINUTE ----

/**
 * Deliver what has arrived; publish traffic digests that are due. Cheap
 * every minute: the inbox is sorted, and digests are due a few times an hour
 * across all stations.
 */
export function intelTick(state, emit = () => {}) {
  const I = ensureIntel(state);
  const now = state.clock.minute;
  const world = getWorld(state);

  for (const st of world.stations) {
    if ((now + (hashString(st.id) % DIGEST_MIN)) % DIGEST_MIN === 0) publishDigest(state, st);
  }

  while (I.inbox.length && I.inbox[0].at <= now) {
    const item = I.inbox.shift();
    if (item.type === 'digest') receiveDigest(state, item, emit);
    else deliverNews(state, item, emit);
  }

  if (now % DAY_MIN === 500) forget(state);
}

function deliverNews(state, item, emit) {
  const I = state.intel;
  const z = item.zone;
  if (z) {
    if (z.ended) delete I.zones[z.id];
    else I.zones[z.id] = zoneNote(z, state.clock.minute);
  }
  if (item.payload?.chart) chart(state, item.payload.chart, item.sent, item.payload.source || 'NEWSFEED');
  // (market news, kept as heard: the markets window lists it)
  if (item.type === 'market-news' && state.market) { const H = (state.market.heard ||= []); H.push({ at: item.sent, id: item.payload.id, good: item.payload.good, text: item.payload.text }); if (H.length > 12) H.shift(); }
  emit(item.type, { ...item.payload, lagMin: state.clock.minute - item.sent });
}

/**
 * Contacts that just dropped off our board leave their last fix on the plot
 * (while a contact is on the board, the board is the plot). Called after
 * sensorsTick; costs nothing while contacts stay put.
 */
export function recordContacts(state) {
  const lost = state.sensors.$lost;
  if (!lost?.length) return;
  const I = ensureIntel(state);
  const now = state.clock.minute;
  const world = getWorld(state);
  for (const c of lost) {
    if (c.ordnance || c.station) continue;
    const e = world.get(c.id);
    if (!e || e.type === 'nav') continue;
    const old = I.tracks[c.id];
    // Identity is learned, and kept once learned
    const known = c.name ? c : old?.name ? old : null;
    I.tracks[c.id] = {
      id: c.id, name: known?.name || null, faction: known?.faction || null, shipClass: known?.shipClass || null,
      kind: 'fix', src: 'SENSORS', at: now, rx: now, wreck: !!c.wreck, dark: !!c.dark,
      x: e.pos.x, y: e.pos.y, vx: e.vel.vx, vy: e.vel.vy,
    };
  }
}

// ---- TRAFFIC DIGESTS ----

const _q = [];

/** A station's traffic control publishes: berths, filed plans, fixes, in its control space. */
function publishDigest(state, st) {
  const world = getWorld(state);
  const now = state.clock.minute;
  _q.length = 0;
  world.query(st.pos, TC_REACH_AU, _q);
  const list = [];
  for (const e of _q) {
    if (list.length >= DIGEST_MAX) break;
    if (e.type !== 'ship' || !e.transponder || e.tags?.wreck) continue;
    const rec = { id: e.id, name: e.name, faction: e.faction, shipClass: e.shipClass };
    const tr = e.transit;
    if (tr && !tr.fix) {
      rec.plan = { from: tr.from, to: tr.to, fromOrbit: tr.fromOrbit, toOrbit: tr.toOrbit, port: tr.port, t0: tr.t0, t1: tr.t1, g: tr.g };
      rec.pob = declaredSouls(e);
    } else if (e.orbit && (e.tags?.at === st.id || Math.hypot(e.pos.x - st.pos.x, e.pos.y - st.pos.y) < 0.0005)) {
      rec.berth = st.id;
      rec.pob = declaredSouls(e);
    } else {
      world.refresh(e, now);
      rec.fix = { x: e.pos.x, y: e.pos.y, vx: e.vel.vx, vy: e.vel.vy };
    }
    list.push(rec);
  }
  const f = state.flight.pos;
  const lag = lightMinutes(Math.hypot(st.pos.x - f.x, st.pos.y - f.y));
  queue(state, { at: now + Math.round(lag), sent: now, type: 'digest', station: st.id, name: st.name, ships: list });
}

function receiveDigest(state, item, emit) {
  const I = state.intel;
  const now = state.clock.minute;
  // No array, no news: a digest that lands while we can't listen is lost
  if (state.reactor?.blackout || radioRangeFactor(state) <= 0) return;
  const src = `${item.name} TC`;
  for (const s of item.ships) {
    const old = I.tracks[s.id];
    if (old && old.at >= item.sent) continue;          // we know better already (our own eyes, a newer digest)
    const r = { id: s.id, name: s.name, faction: s.faction, shipClass: s.shipClass, src, at: item.sent, rx: now };
    if (s.pob) r.pob = s.pob;
    if (s.plan) { r.kind = 'plan'; r.plan = s.plan; }
    else if (s.berth) { r.kind = 'berth'; r.berth = s.berth; }
    else { r.kind = 'fix'; Object.assign(r, s.fix); }
    I.tracks[s.id] = r;
  }
  I.digests[item.station] = { name: item.name, issued: item.sent, rx: now, count: item.ships.length };
  trim(I);
  emit('intel-digest', { station: item.station, name: item.name, lagMin: now - item.sent, count: item.ships.length });
}

/** Something on a published orbit (a wreck in the news, a contract's target): charted from now on. */
export function chart(state, id, at = state.clock.minute, src = 'CHARTED') {
  const e = getWorld(state).get(id);
  if (!e) return;
  const I = ensureIntel(state);
  I.tracks[id] = { id, name: e.name, faction: e.faction, shipClass: e.shipClass, kind: 'chart', src, at, rx: state.clock.minute, wreck: !!e.tags?.wreck };
}

function trim(I) {
  const ids = Object.keys(I.tracks);
  if (ids.length <= INTEL_MAX) return;
  ids.sort((a, b) => I.tracks[a].at - I.tracks[b].at);
  for (let i = 0; i < ids.length - INTEL_MAX; i++) delete I.tracks[ids[i]];
}

/** Daily: drop what is too old to mean anything. */
function forget(state) {
  const I = state.intel;
  const now = state.clock.minute;
  const world = getWorld(state);
  for (const id of Object.keys(I.tracks)) {
    const r = I.tracks[id];
    const age = now - r.at;
    const stale = r.kind === 'fix' ? age > FORGET_FIX_MIN
      : r.kind === 'berth' ? age > FORGET_BERTH_MIN
      : r.kind === 'plan' ? now > r.plan.t1 + FORGET_PLAN_AFTER_MIN
      : !world.get(id);
    if (stale) delete I.tracks[id];
  }
}

// ---- READING THE PLOT ----

const _fake = { transit: null, thrust: 0, heading: 0 };
const _p = { x: 0, y: 0 }, _v = { vx: 0, vy: 0 };
const _anchor = { pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 } };

/**
 * Where the plot puts a record at `minute`: { x, y, sigmaAU, moving } or
 * null. `sigmaAU` is the radius it could be anywhere inside.
 */
export function estimate(state, r, minute, out = {}) {
  const world = getWorld(state);
  const ageMin = Math.max(0, minute - r.at);
  const ageS = ageMin * MIN_S;
  if (r.kind === 'fix') {
    out.x = r.x + r.vx * ageS / AU_M;
    out.y = r.y + r.vy * ageS / AU_M;
    out.sigmaAU = (DRIFT_MS * ageS + 0.5 * MANEUVER_G * G0 * ageS * ageS) / AU_M;
    out.moving = true;
    return out;
  }
  if (r.kind === 'plan' && minute < r.plan.t1) {
    _fake.transit = r.plan;
    if (!transitStateAt(world, _fake, minute, _p, _v)) return null;
    out.x = _p.x; out.y = _p.y;
    out.sigmaAU = PLAN_DRIFT_AU_PER_DAY * ageMin / DAY_MIN;
    out.moving = true;
    return out;
  }
  // Berthed, due, or charted: where that rails entity is at `minute` (never
  // its stored position, which may be an hour stale out here)
  const id = r.kind === 'plan' ? (r.plan.to || r.plan.port) : r.kind === 'berth' ? r.berth : r.id;
  const at = world.get(id);
  if (!at) return null;
  if (at.orbit && world.anchorState(id, minute, _anchor)) { out.x = _anchor.pos.x; out.y = _anchor.pos.y; }
  else { out.x = at.pos.x; out.y = at.pos.y; }
  out.sigmaAU = r.kind === 'chart' ? 0 : 0.0002;
  out.moving = false;
  return out;
}

/** What the plot says about a record, in words (for the selection panel). */
export function describeRecord(state, r) {
  const now = state.clock.minute;
  const world = getWorld(state);
  const what = r.kind === 'plan'
    ? (now < r.plan.t1 ? `filed plan to ${world.get(r.plan.to || r.plan.port)?.name || 'unknown'}` : `due at ${world.get(r.plan.to || r.plan.port)?.name || 'unknown'}`)
    : r.kind === 'berth' ? `berthed at ${world.get(r.berth)?.name || 'unknown'}`
    : r.kind === 'chart' ? 'charted orbit'
    : 'last fix, coasting';
  return { what, src: r.src, ageMin: now - r.at, lagMin: r.rx - r.at };
}

/** The record for an entity, when it isn't on our sensors right now. */
export const trackOf = (state, id) => state.intel?.tracks[id] || null;

/**
 * Do we see this entity live (sensors), or know it from a chart? Stations,
 * nav marks and contract targets on published orbits are charted; our own
 * ordnance reports by telemetry.
 */
export function liveKnowledge(state, e) {
  if (state.sensors.$seen?.has(e.id)) return 'live';
  if (e.type === 'station') return 'charted';
  if (e.type === 'ordnance' && e.ord?.owner === 'player') return 'live';
  if (e.type === 'nav') return 'charted';
  // (a navy's forward command on its post publishes where it is, as a station's orbit is: forces.js)
  if (e.tags?.command && e.tags.force?.state === 'post' && !e.agent) return 'charted';
  if (e.orbit && e.tags?.contract && !e.agent) return 'charted';
  return null;
}
