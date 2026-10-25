// ============================================================
// LONGHAUL — Manifests: who is aboard other ships, and what we know
//
// Every ship out there has people aboard. A class has a complement
// (ship-classes.js: the rated range, and the usual number), and each
// hull carries its own number in that range, fixed by its identity, so
// two hundred thousand ships cost nothing until something happens to
// them: casualties (the hull's combat state counts the crew still
// standing), a boarding (an exact count), a rescue. Liners and colony
// ships carry passengers too.
//
// We never see inside another hull. What we know comes from somewhere,
// and has an age:
//   REGISTRY   once a ship is identified, its class, so the rated complement
//   MANIFEST   traffic control's declarations: ships berthed at a station
//              or flying a plan filed there declared their souls aboard
//              (a station's digest carries them: intel.js; asking traffic
//              control for its board gives them now)
//   HAIL       what the ship says when asked (a ship that dislikes us may
//              lie; pirates won't say)
//   SCAN       a long look at close range: a thermal estimate of the
//              living, ± a third (± a sixth with ops on watch)
//   BOARDED    a count taken aboard: exact
// The dossier keeps what we learned, the best source winning, bounded
// (DOSSIER_MAX: the oldest go first). A scan never replaces what a ship
// declared: it checks it, and a declared number the heat inside doesn't
// bear out is marked doubtful (and logged). Notable learning goes in the log.
// ============================================================

import { hashString } from '../core/rng.js';
import { classOf } from './ship-classes.js';
import { AU_M } from '../core/constants.js';
import { getWorld } from './world.js';

export const DOSSIER_MAX = 1500;
const SCAN_RANGE_M = 100_000;           // thermal estimate of the living inside this
const SCAN_MIN = 90;                    // …after this long a track (REVEAL.PROFILE is 60)
const SCAN_AT_ONCE = 4;                 // contacts given a long look per sweep
const RESCAN_MIN = 1440;                // a ship counted (by us, or better: hailed, a manifest, aboard) isn't looked at again for a day
const RANK = { registry: 0, scan: 1, manifest: 2, hail: 2, boarded: 3 };
export const SOURCE_LABEL = { registry: 'REGISTRY', manifest: 'MANIFEST', hail: 'HAIL', scan: 'SCAN', boarded: 'BOARDED' };

export function createDossier() {
  return { ships: {} };
}

// ---- WHO IS ABOARD ----

const unit = (id, salt) => (hashString(`${id}:${salt}`) % 10007) / 10007;

/** A hull's own complement: in the class's range, around its usual number. */
export function complementOf(e) {
  const c = classOf(e);
  if (!c) return 4;
  const [lo, hi] = c.crew;
  const std = c.crewStd ?? Math.round((lo + hi) / 2);
  // two draws: most ships carry about the usual crew, a few run short or full
  const t = (unit(e.id, 'c1') + unit(e.id, 'c2')) / 2;
  const n = t < 0.5 ? lo + (std - lo) * (t / 0.5) : std + (hi - std) * ((t - 0.5) / 0.5);
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Crew alive aboard now (fewer after a fight; none on a burst hulk). */
export function crewAboard(e) {
  if (!e || e.type !== 'ship') return 0;
  if (e.crewAboard != null) return e.crewAboard;
  if (e.tags?.blown) return 0;
  const n = complementOf(e);
  return e.combat ? Math.round(n * e.combat.crew) : n;
}

/** Passengers aboard (liners run 50–95% full; other hulls with berths sometimes carry a few). */
export function passengersAboard(e) {
  const c = classOf(e);
  if (!c?.berths || e.tags?.blown) return 0;
  if (e.paxAboard != null) return e.paxAboard;
  const share = c.kind === 'liner' ? 0.5 + 0.45 * unit(e.id, 'p') : unit(e.id, 'p') < 0.3 ? unit(e.id, 'q') : 0;
  return Math.round(c.berths * share * (e.combat ? e.combat.crew : 1));
}

/** Fix the count aboard (casualties of a boarding, survivors taken off). */
export function setCrewAboard(e, n) {
  e.crewAboard = Math.max(0, Math.round(n));
}

/** What a ship files with traffic control: its souls aboard (pirates file nothing). */
export function declaredSouls(e) {
  if (!e?.transponder || e.faction === 'pirate' || classOf(e)?.category === 'irregular') return null;
  return { crew: crewAboard(e), pax: passengersAboard(e) };
}

// ---- WHAT WE KNOW ----

/**
 * Learn something about a ship. facts: { crew?: number | [lo, hi], pax?, from?, to?, note? }
 * src: registry | manifest | hail | scan | boarded. A worse source never
 * overwrites a better one that is fresher than a day. Returns the record.
 */
export function learn(state, e, facts, src, { by = '', at = state.clock.minute } = {}) {
  const D = (state.dossier ??= createDossier());
  const r = (D.ships[e.id] ||= { id: e.id, name: e.name, cls: e.cls, faction: e.faction, first: at });
  r.name = e.name; r.cls = e.cls; r.faction = e.faction; r.at = at;
  if (facts.crew != null) {
    const old = r.crew;
    const better = !old || RANK[src] >= RANK[old.src];
    if (better) {
      const [lo, hi] = Array.isArray(facts.crew) ? facts.crew : [facts.crew, facts.crew];
      r.crew = { lo, hi, src, at, by };
    }
  }
  if (facts.pax != null) r.pax = { n: facts.pax, src, at, by };
  if (facts.hold) r.hold = { items: facts.hold.map(x => ({ good: x.good, t: x.t })), src, at, by };
  if (facts.from) r.from = facts.from;
  if (facts.to) r.to = facts.to;
  if (facts.note) { (r.notes ||= []).push({ at, text: facts.note }); if (r.notes.length > 6) r.notes.shift(); }
  trim(D);
  return r;
}

function trim(D) {
  D.n = (D.n || 0) + 1;
  if (D.n % 50) return;                       // checked now and then: the cap is a ceiling, not exact
  const ids = Object.keys(D.ships);
  if (ids.length <= DOSSIER_MAX) return;
  ids.sort((a, b) => D.ships[a].at - D.ships[b].at);
  for (let i = 0; i < ids.length - DOSSIER_MAX; i++) delete D.ships[ids[i]];
}

/** The dossier record for a ship (or null). */
export const dossierOf = (state, id) => state.dossier?.ships[id] || null;

/**
 * What we can say about a ship's crew right now: the dossier, a manifest on
 * the plot, or the class's rated complement once it is identified.
 * Returns { lo, hi, src, ageMin, by, text } or null.
 */
export function knownCrew(state, e, { identified = false } = {}) {
  const now = state.clock.minute;
  const r = dossierOf(state, e.id);
  if (r?.crew) return describe(r.crew, now);
  const t = state.intel?.tracks[e.id];
  if (t?.pob) return describe({ lo: t.pob.crew, hi: t.pob.crew, src: 'manifest', at: t.at, by: t.src }, now);
  const c = classOf(e);
  if (identified && c) return describe({ lo: c.crew[0], hi: c.crew[1], src: 'registry', at: now, by: c.name }, now);
  return null;
}

function describe(k, now) {
  const n = k.lo === k.hi ? `${k.lo}` : `${k.lo}–${k.hi}`;
  const what = k.src === 'registry' ? `rated ${n}` : k.src === 'scan' ? `about ${n} (thermal)` : k.src === 'boarded' ? `${n} (counted)`
    : k.doubt ? `${n} declared · thermal says ${k.doubt.lo === k.doubt.hi ? k.doubt.lo : `${k.doubt.lo}–${k.doubt.hi}`}` : `${n} declared`;
  return { ...k, ageMin: now - k.at, text: `${what}` };
}

// ---- PER MINUTE ----

/**
 * A ship held under a long, close look gives up a thermal count of the
 * living. Only the contact we're locked on or the nearest few are looked
 * at, so this is bounded by the board, not the world. A ship is looked at
 * once a day: an estimate of our own is logged when it changes; a count the
 * ship declared (hailed, a manifest) is checked, quietly when the heat
 * bears it out, aloud and marked doubtful when it doesn't. A count taken
 * aboard is exact: nothing to look at.
 */
export function dossierTick(state, emit = () => {}) {
  const s = state.sensors;
  if (!s?.contacts?.length || state.clock.minute % 5 !== 0) return;
  const world = getWorld(state);
  const ops = state.$watch?.ops != null;
  // the locked contact and the nearest few: a long look is a sensor operator's attention
  const looked = s.contacts.filter(c => !c.ordnance && !c.station && c.dist * AU_M <= SCAN_RANGE_M && c.scan >= SCAN_MIN)
    .sort((a, b) => (b.id === s.locked) - (a.id === s.locked) || a.dist - b.dist).slice(0, SCAN_AT_ONCE);
  for (const c of looked) {
    const e = world.get(c.id);
    if (!e || e.type !== 'ship') continue;
    const r = dossierOf(state, e.id);
    const now = state.clock.minute;
    // counted aboard, or looked at within the day: nothing new to learn, and nothing to say
    if (r?.crew?.src === 'boarded' || now - (r?.scanAt ?? -Infinity) < RESCAN_MIN) continue;
    const n = crewAboard(e) + passengersAboard(e);
    // the estimate's own noise comes from the contact and the hour, not the game's dice
    const err = ops ? 1 / 6 : 1 / 3;
    const jit = unit(e.id, Math.floor(state.clock.minute / 60)) - 0.5;
    const lo = Math.max(0, Math.round(n * (1 - err * (1 + jit))));
    const hi = Math.max(lo, Math.round(n * (1 + err * (1 - jit))));
    const name = c.name || 'the contact';
    if (r?.crew && RANK[r.crew.src] > RANK.scan) {
      // what they declared, checked against the heat inside (crew and passengers alike are warm)
      r.scanAt = now;
      const pax = r.pax?.n || 0;
      const dLo = r.crew.lo + pax, dHi = r.crew.hi + pax;
      if (dHi < lo || dLo > hi) {
        r.crew.doubt = { lo, hi, at: now };
        emit('dossier', { id: e.id, name, src: 'scan', text: `Thermal count on ${name}: ${lo === hi ? lo : `${lo}–${hi}`} aboard. They declared ${dLo === dHi ? dLo : `${dLo}–${dHi}`}.` });
      } else if (r.crew.doubt) delete r.crew.doubt;
      continue;
    }
    const was = r?.crew ? `${r.crew.lo}–${r.crew.hi}` : null;
    const rec = learn(state, e, { crew: [lo, hi] }, 'scan', { by: 'thermal' });
    rec.scanAt = now;
    // (said once per new count: the same estimate again is not news)
    if (`${lo}–${hi}` !== was) emit('dossier', { id: e.id, name, src: 'scan', text: `Thermal count on ${name}: ${lo === hi ? lo : `${lo}–${hi}`} aboard.` });
  }
}

// ---- OUR OWN BERTHS ----
// Passengers (and survivors, casualties) ride in the berths the class is
// licensed for. Prisoners go to the brig first (a warship's cells:
// ship-classes.js `brig`; a police cutter's brig is its passenger deck),
// then into whatever berths are free.

const prisonersAboard = (state) => state.passengers.reduce((s, p) => s + (p.kind === 'prisoners' ? p.count : 0), 0);

/** Passenger berths free (prisoners past what the brig holds take berths too). */
export function freeBerths(state) {
  const held = prisonersAboard(state), others = state.passengers.reduce((s, p) => s + p.count, 0) - held;
  return (state.berths || 0) - others - Math.max(0, held - (state.brig || 0));
}

/** Room for prisoners: the brig's cells, then free berths. */
export const freeCells = (state) => Math.max(0, (state.brig || 0) - prisonersAboard(state)) + Math.max(0, freeBerths(state));
