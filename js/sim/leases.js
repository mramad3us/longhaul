// ============================================================
// LONGHAUL — Berth leases: a berth is for a ship that is working
//
// A port has a few dozen berths and a queue at its anchorage, so a berth
// is let for a time, not given. Docking at a station comes with a short
// working lease, free (it is in the clearance): six hours to load and
// unload, fuel and water, see to the ship. Staying longer (a crew run
// ashore, waiting on a contract, repairs) takes a long lease, paid by the
// hour of berth time in advance, by hailing the station or from the
// station window. Rates go by the size of the collar we hold (a big berth
// is a scarce one), double at a naval yard, half again at a port that is
// nearly full.
//
// Overstaying a lease: an hour before it runs out traffic control says
// so; when it is up, they tell us to extend or go; after half an hour's
// grace, a citation, and another every two hours; at six hours over, the
// dock lets go of us (crew ashore are called back first, and the clamps
// release once they are aboard). A berth's lease ends when we undock.
//
// The lease lives with the dock (state.dock.lease: { from, until, paid })
// and is made the first minute we are docked, so a dock from any path
// (docking, a new game in a berth, an old save) gets one.
// ============================================================

import { getWorld } from './world.js';
import { STATIONS, berthCounts } from './stations.js';
import { hullOf } from './hulls.js';
import { PLAYER_CLASS } from './ship-classes.js';
import { cite } from './law.js';
import { voice, requestDeparture } from './traffic-control.js';
import { undock } from './docking.js';

export const FREE_LEASE_MIN = 6 * 60;
export const LEASE_RATE = { S: 6, M: 12, L: 25 };   // MCR an hour of berth, by the collar we hold
export const LEASE_OPTIONS_H = [6, 12, 24, 72];
export const MAX_LEASE_MIN = 7 * 24 * 60;          // a lease runs a week ahead at most
const GRACE_MIN = 30, CITE_EVERY_MIN = 120, EVICT_MIN = 6 * 60;

/** The station we are docked at, with its dock, or null. */
function berthed(state) {
  const d = state.dock;
  if (d?.phase !== 'docked' || d.target.kind !== 'station') return null;
  const st = getWorld(state).get(d.target.id);
  return st ? { d, st } : null;
}

/** Our lease where we are docked: { from, until, paid, left (min) }, or null. */
export function leaseFor(state) {
  const b = berthed(state);
  if (!b) return null;
  ensureLease(state);
  return { ...b.d.lease, left: b.d.lease.until - state.clock.minute };
}

/** What an hour of our berth costs here. */
export function leaseRate(state) {
  const b = berthed(state);
  if (!b) return 0;
  const port = hullOf(state.ship.classId || PLAYER_CLASS)?.ports.find(p => p.id === b.d.port);
  let rate = LEASE_RATE[port?.size || 'M'] || LEASE_RATE.M;
  if (STATIONS[b.st.id]?.military) rate *= 2;
  const c = berthCounts(state, b.st);
  if (c.total && (c.total - c.used) / c.total < 0.25) rate *= 1.5;
  return Math.round(rate);
}

/** The price and the new end of the lease for `hours` more. */
export function leaseQuote(state, hours) {
  const b = berthed(state);
  if (!b?.d.lease) return null;
  const now = state.clock.minute;
  const from = Math.max(b.d.lease.until, now);
  const until = Math.min(now + MAX_LEASE_MIN, from + hours * 60);
  const paidH = Math.max(0, (until - from) / 60);
  return { hours: paidH, cost: Math.round(paidH * leaseRate(state)), until };
}

/** Take the berth for `hours` more. Returns { ok, text }. */
export function extendLease(state, hours) {
  const b = berthed(state);
  if (!b) return { ok: false, text: 'Not in a berth.' };
  ensureLease(state);
  const q = leaseQuote(state, hours);
  if (!q.hours) return { ok: false, text: 'Your lease already runs as far ahead as the port lets a berth.' };
  const cr = state.resources.credits;
  if (cr.current < q.cost) return { ok: false, text: `${q.hours} more hours in this berth is ${q.cost.toLocaleString()} MCR.` };
  cr.current -= q.cost;
  b.d.lease.until = q.until;
  b.d.lease.paid += q.cost;
  b.d.lease.warned = 0;
  return { ok: true, cost: q.cost, text: `Berth ${b.d.berth} is yours for ${fmtHours(q.until - state.clock.minute)} (${q.cost.toLocaleString()} MCR).` };
}

/**
 * Hours of lease needed to cover `minutes` from now (0 if it already does),
 * and what they cost.
 */
export function leaseShortfall(state, minutes) {
  const L = leaseFor(state);
  if (!L) return { hours: 0, cost: 0 };
  const short = state.clock.minute + minutes - L.until;
  if (short <= 0) return { hours: 0, cost: 0 };
  const hours = Math.ceil(short / 60);
  return { hours, cost: Math.round(hours * leaseRate(state)) };
}

function ensureLease(state) {
  const b = berthed(state);
  if (b && !b.d.lease) {
    const from = b.d.at ?? state.clock.minute;
    b.d.lease = { from, until: from + FREE_LEASE_MIN, paid: 0, warned: 0, cited: 0 };
  }
}

const fmtHours = (min) => min >= 48 * 60 ? `${Math.round(min / 60 / 24 * 10) / 10} days` : `${Math.round(min / 60 * 10) / 10} hours`;

/** Per minute, docked at a station: the lease, its warnings, and in the end the dock letting go. */
export function leaseTick(state, emit = () => {}) {
  const b = berthed(state);
  if (!b) return;
  ensureLease(state);
  const L = b.d.lease, st = b.st, now = state.clock.minute;
  const left = L.until - now;
  const say = (key, level, text) => emit('tc-warning', { station: st.id, name: st.name, voice: voice(st), key, level, text });
  const dock = `${st.name.split(' ')[0]} Dock`;
  if (left === 60 && L.warned < 1) { L.warned = 1; say('lease-60', 'info', `${dock}: your lease on ${b.d.berth} is up in an hour. Extend it or file for departure.`); }
  if (left === 0 && L.warned < 2) { L.warned = 2; say('lease-up', 'warn', `${dock}: your lease on ${b.d.berth} is up. There are ships waiting on that berth: extend or depart.`); }
  const over = -left;
  if (over < GRACE_MIN) return;
  // Overstaying: a citation now and every two hours
  if (now - (L.cited || 0) >= CITE_EVERY_MIN) {
    L.cited = now;
    cite(state, st.faction, { station: st.id, kind: 'overstaying a berth lease', amount: Math.max(100, leaseRate(state) * 8) }, emit);
  }
  if (over < EVICT_MIN) return;
  // Six hours over: the dock lets go of us, once our people are aboard
  const ashore = state.ship.crew.filter(m => m.away?.ashore);
  if (ashore.length) {
    if (L.warned < 3) {
      L.warned = 3;
      for (const m of ashore) m.away.until = Math.min(m.away.until, now);
      say('lease-evict', 'danger', `${dock}: you are six hours over your lease. Security is sending your crew back aboard. The clamps release when they are.`);
    }
    return;
  }
  if (state.ship.crew.some(m => m.away)) return;          // a party aboard another hull: not while they are out
  requestDeparture(state, st.id);
  const r = undock(state, emit);
  if (r.ok) say('lease-evicted', 'danger', `${dock}: releasing your clamps. Clear the berth and the gate.`);
}

/** For the station window and the comms card. */
export function leaseSummary(state) {
  const L = leaseFor(state);
  if (!L) return null;
  const rate = leaseRate(state);
  return {
    left: L.left, over: Math.max(0, -L.left), until: L.until, paid: L.paid, rate,
    label: L.left >= 0 ? `${fmtHours(L.left)} left` : `${fmtHours(-L.left)} OVER`,
    options: LEASE_OPTIONS_H.map(h => ({ hours: h, ...leaseQuote(state, h) })).filter(o => o.hours > 0),
  };
}
