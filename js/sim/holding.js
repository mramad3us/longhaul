// ============================================================
// LONGHAUL — Holding patterns: where ships wait near a port
//
// A berth is for working (leases.js); a ship with nothing to load, a crew
// on a layover, a hauler waiting its turn, waits in the port's holding
// pattern: a string of slots five kilometres apart on an orbit chosen so
// that a ship in a slot falls freely and keeps its place with no thrust at
// all (gravity.js). Traffic control assigns the slots, as it does berths.
//
// Two kinds, as the port's site allows:
//   STATIONARY — over a surface port on a turning rock: the synchronous
//     orbit, where an orbit takes exactly one turn of the rock (Ceres:
//     1,190 km from its centre, 720 km up; Vesta 545 km; Pallas 648 km).
//     The slots string out east and west of the port's meridian and stay
//     over the same ground. Only slots whose line down to the approach
//     gate clears the rock are used: a ship leaving its slot goes to the
//     gate, then down to its berth.
//   CO-ORBITAL — an orbital station's own orbit, ahead of it and behind
//     (from 200 km out): the same orbit, the same period, so the slots ride
//     with the station. Phobos is too small to orbit (its synchronous
//     orbit is outside its sphere of influence): its yard's slots ride
//     Phobos' own orbit round Mars, ahead and behind the moon.
//
// Every slot lies inside port space (PORT_M, the approach zone): a ship in
// one is in port, can work the radio side of the station (the contract
// board, citations, news), and loiters lawfully. Cargo, passengers and
// crew still go through a berth.
//
// The pattern is rails (an orbit), not entities: a slot's place at any
// minute is orbitStateAt(slotOrbit). Who holds a slot is kept with the
// station (st.holding), like its berths; NPC traffic in a slot rides that
// orbit on rails, and we hold ours with the nav computer.
// ============================================================

import { AU_KM, AU_M } from '../core/constants.js';
import { getBody } from './ephemeris.js';
import { getWorld, orbitStateAt } from './world.js';
import { STATIONS, stationOrbit } from './stations.js';
import { syncRadiusM } from './gravity.js';

export const SLOT_KM = 5;
export const SLOTS_PER_SIDE = 150;
export const PORT_M = 2_000_000;           // port space: the approach zone (traffic-control.js APPROACH_M)
const COORBIT_START_KM = 200;              // co-orbital slots start this far from the station
const CLEAR = 1.05;                        // a slot's line to the gate must clear the rock by this (radii)

const _patterns = new Map();

/**
 * A station's holding pattern (cached): { kind, body, rKm, period (days),
 * phase0, slots: [{ id, label, sKm (along track, signed), dPhase }] }.
 */
export function holdingPattern(stationId) {
  let p = _patterns.get(stationId);
  if (p) return p;
  const spec = STATIONS[stationId];
  if (!spec) return null;
  const o = stationOrbit(stationId);
  const b = getBody(spec.body);
  let kind, body, rKm, period, phase0, start;
  if (spec.site === 'surface') {
    const T = b.rotH * 3600;
    const rs = syncRadiusM(b, T) / 1000;
    const parentGM = b.parent ? b.parent.gm : getBody('Sol').gm;
    const soiKm = b.a * AU_KM * Math.pow(b.gm / parentGM, 0.4);
    if (rs > b.radius * 1.2 && rs < soiKm * 0.5) {
      kind = 'stationary'; body = b.name; rKm = rs; period = b.rotH / 24; phase0 = o.phase; start = SLOT_KM / 2;
    } else if (b.parent) {
      // the moon's own orbit round its planet
      kind = 'co-orbital'; body = b.parent.name; rKm = b.a * AU_KM; period = b.period; phase0 = b.initAngle; start = COORBIT_START_KM;
    }
  } else {
    kind = 'co-orbital'; body = o.body; rKm = o.r * AU_KM; period = o.period; phase0 = o.phase; start = COORBIT_START_KM;
  }
  if (!kind) { _patterns.set(stationId, null); return null; }
  const slots = [];
  const gateKm = (spec.site === 'surface' ? b.radius : 0) + spec.gateKm;
  const R = b.radius;
  for (const side of [1, -1]) {
    for (let k = 0; k < SLOTS_PER_SIDE; k++) {
      const sKm = side * (start + k * SLOT_KM);
      const dPhase = sKm / rKm;
      if (Math.abs(dPhase) >= Math.PI) break;
      if (kind === 'stationary') {
        // the line from the slot down to the gate (both over the port's meridian) clears the rock
        const ax = rKm * Math.cos(dPhase), ay = rKm * Math.sin(dPhase), gx = gateKm, gy = 0;
        if (segDist(ax, ay, gx, gy) < CLEAR * R) break;
        if (Math.hypot(ax - R, ay) * 1000 > PORT_M * 0.9) break;
      } else if (2 * rKm * Math.sin(Math.abs(dPhase) / 2) * 1000 > PORT_M * 0.9) break;
      const tag = kind === 'stationary' ? (side > 0 ? 'E' : 'W') : (side > 0 ? 'A' : 'T');
      slots.push({ id: `${tag}${k + 1}`, label: `${tag}${k + 1}`, sKm, dPhase, side });
    }
  }
  // (inner slots first, alternating sides: the pattern fills from the middle out)
  const order = [...slots].sort((a, b) => Math.abs(a.sKm) - Math.abs(b.sKm));
  p = { kind, body, rKm, period, phase0, slots, order, byId: new Map(slots.map(s => [s.id, s])), rank: new Map(order.map((s, i) => [s.id, i])) };
  _patterns.set(stationId, p);
  return p;
}

/** Distance from the origin (the body's centre) to the segment a–g (km). */
function segDist(ax, ay, gx, gy) {
  const dx = gx - ax, dy = gy - ay, L2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** A slot's orbit (rails: world.js orbitStateAt). */
export function slotOrbit(stationId, slotId) {
  const p = holdingPattern(stationId);
  const s = p?.byId.get(slotId);
  if (!s) return null;
  return { body: p.body, r: p.rKm / AU_KM, phase: p.phase0 + s.dPhase, period: p.period };
}

/** Words for a slot: "E12, 58 km east of the port's meridian, 720 km up". */
export function slotDescription(stationId, slotId) {
  const p = holdingPattern(stationId);
  const s = p?.byId.get(slotId);
  if (!s) return slotId;
  const b = getBody(p.body);
  const off = Math.round(Math.abs(s.sKm));
  if (p.kind === 'stationary') return `${s.id}, ${off} km ${s.side > 0 ? 'east' : 'west'} of the port's meridian, ${Math.round(p.rKm - b.radius).toLocaleString()} km up`;
  return `${s.id}, ${off.toLocaleString()} km ${s.side > 0 ? 'ahead of' : 'behind'} the station on its orbit`;
}

// ---- WHO HOLDS WHICH ----
//
// A busy port is asked for a free slot hundreds of times a game hour (every
// ship that comes in, comes off its berth, or waits its turn), and with a
// crowd its pattern is full more often than not. So the claims carry a
// runtime index (st.$hold): the first slot, in the pattern's order, that may
// be free (past the last when full), lowered when a slot is let go. A claim
// gone stale (its ship gone, or elsewhere) isn't seen by it: the pattern is
// walked for those once a game hour (HOLD_CHECK_MIN).

const HOLD_CHECK_MIN = 60;
const table = (st) => (st.holding ||= {});

/** A slot let go: the index looks from it again. */
function freed(st, slotId) {
  const h = st.$hold, r = h && holdingPattern(st.id)?.rank.get(slotId);
  if (r != null && r < h.lo) h.lo = r;
}

/** Who is in a slot (null if free; a stale claim is cleared). */
export function slotOccupant(world, st, slotId) {
  const t = table(st);
  const id = t[slotId];
  if (!id) return null;
  if (id === 'player') return id;
  const o = world.get(id);
  if (o && o.tags?.slot === slotId && o.tags?.at === st.id) return id;
  delete t[slotId];
  freed(st, slotId);
  return null;
}

/** The station's index of its claims, its stale claims cleared if an hour has passed. */
function holdIndex(world, st, p, now) {
  let h = st.$hold;
  if (!h || now - h.at >= HOLD_CHECK_MIN || now < h.at) {
    h = st.$hold = { lo: 0, at: now };
    for (const s of p.slots) slotOccupant(world, st, s.id);
  }
  return h;
}

/**
 * A free slot: the nearest the station (or, given `near`, the nearest that
 * point, AU), or null when the pattern is full.
 */
export function freeSlot(state, st, near = null) {
  const p = holdingPattern(st.id);
  if (!p) return null;
  const t = table(st), h = holdIndex(getWorld(state), st, p, state.clock.minute);
  if (!near) {
    for (let i = h.lo; i < p.order.length; i++) if (!t[p.order[i].id]) { h.lo = i; return p.order[i]; }
    h.lo = p.order.length;
    return null;
  }
  if (h.lo >= p.order.length) return null;
  const minute = state.clock.minute;
  let best = null, bd = Infinity;
  const pos = { x: 0, y: 0 }, vel = { vx: 0, vy: 0 };
  for (const s of p.slots) {
    if (t[s.id]) continue;
    orbitStateAt(slotOrbit(st.id, s.id), minute, pos, vel);
    const d = Math.hypot(pos.x - near.x, pos.y - near.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function claimSlot(st, slotId, who) { table(st)[slotId] = who; }
export function releaseSlot(st, slotId, who = null) {
  const t = table(st);
  if (t[slotId] && (who == null || t[slotId] === who)) { delete t[slotId]; freed(st, slotId); }
}

/** How full a station's pattern is. */
export function slotCounts(state, st) {
  const p = holdingPattern(st.id);
  if (!p) return { used: 0, total: 0 };
  const world = getWorld(state);
  let used = 0;
  for (const s of p.slots) if (slotOccupant(world, st, s.id)) used++;
  return { used, total: p.slots.length };
}

/** Is a point inside a station's port space? */
export const inPortSpace = (st, pos) => Math.hypot(st.pos.x - pos.x, st.pos.y - pos.y) * AU_M <= PORT_M;
