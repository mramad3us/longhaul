// ============================================================
// LONGHAUL — World: entity store, motion, spatial queries
//
// Entities live in state.entities (plain, serializable objects).
// A World is the runtime index over them (id map, spatial hash,
// station list) and is rebuilt from state on load.
//
// Motion models:
//   orbit — on rails around a body: exact analytic position at any
//           time, O(1), no drift (stations, parked ships, nav marks)
//   transit — NPC traffic between two rails entities, analytic (a ship
//           put back on rails out in space starts from a coasting fix)
//   free  — integrated under gravity (the Sun, bodies near: gravity.js) + own thrust
//   driven — stepped every minute by its controller (an NPC at the
//           helm, a torpedo's guidance): the world never moves it,
//           only indexes it. Driven entities are few and bounded.
//
// Level of detail (scales to 200k+ entities):
//   entities near the player (within HORIZON_AU, a little past the longest
//   sensor and radio range) update every full game-minute. The far world
//   keeps a CALENDAR: each entity is visited when something is next due to
//   it (WORLD_DUE: a leg's end, a call's next step, a force's arrival, its
//   retirement), and its position is brought up to date only before it
//   could come within HORIZON_AU of us (the gap between us, closed at its
//   speed and ours, ours growing at our drive's G, at most a day), so a
//   frame touches what is due in it and nothing else, at any time warp. A
//   slow round-robin pass (a sweep of the whole world a game day) is the
//   net under anything that changed an entity's timing without saying so.
//   Anything can be brought exactly up to date on demand (refresh).
// ============================================================

import { AU_M, AU_KM, G0, MIN_S, TWO_PI, DAY_MIN, GM_SUN } from '../core/constants.js';
import { getBody, bodyPos, bodyVel } from './ephemeris.js';
import { gravityAt, gravityEpoch, nearestSurface } from './gravity.js';
import { SpatialHash } from './spatial-hash.js';

export const HORIZON_AU = 0.105;     // nothing gets this close to us unseen (the calendar's bound): past the longest sensor and radio range (0.1)
const TICK_PAD_AU = 0.015;           // …and the near pass looks this much farther (we move between full minutes)
export const NEAR_RANGE_AU = HORIZON_AU + TICK_PAD_AU;   // the near pass's reach
const LONGEST_REFRESH_MIN = 1440;    // a far entity's position at most a day old
const SHORTEST_REFRESH_MIN = 5;
const STATION_REFRESH_MIN = 60;      // stations and marks: few, and their places are asked after
const SWEEP_MIN = 1440;              // the net: the whole world swept once a game day…
const SWEEP_CAP = 1000;              // …at most this many a frame
const STUCK_MIN = 10;                // something due that didn't move on is looked at again after this

/** Hooks run on every entity the background pass visits: fn(e, minute, world). */
export const WORLD_VISITORS = [
  // Retire entities whose story is over (rescued ships, spent contract targets)
  (e, minute, world) => {
    const at = e.tags?.despawnAt;
    // (not while we hold on it or are docking with it: it goes once we let go)
    if (at != null && minute >= at && world.state.flight?.hold?.id !== e.id && world.state.dock?.target.id !== e.id) world.remove(e);
  },
];

/** When each visitor next has business with an entity: fn(e) → minute (Infinity: none). Alongside WORLD_VISITORS. */
export const WORLD_DUE = [
  (e) => e.tags?.despawnAt ?? Infinity,
];


const _worlds = new WeakMap();

/** The World for a game state (created lazily, rebuilt after load). */
export function getWorld(state) {
  let w = _worlds.get(state);
  if (!w) { w = new World(state); _worlds.set(state, w); }
  return w;
}

export function resetWorld(state) {
  _worlds.delete(state);
  return getWorld(state);
}

// ---- MOTION (pure functions, shared by live sim and planner) ----

const _bp = { x: 0, y: 0 };
const _bv = { vx: 0, vy: 0 };
const _g = { ax: 0, ay: 0 };

/** Exact state of an orbit-anchored entity at `minute`. Writes into pos/vel. */
export function orbitStateAt(orbit, minute, pos, vel) {
  const body = getBody(orbit.body);
  const days = minute / DAY_MIN;
  bodyPos(body, days, _bp);
  bodyVel(body, days, _bv);
  let th = orbit.phase;
  let w = 0;
  if (orbit.period > 0) {
    w = TWO_PI / (orbit.period * 86400);            // rad/s
    th += TWO_PI * days / orbit.period;
  }
  const c = Math.cos(th), s = Math.sin(th);
  pos.x = _bp.x + orbit.r * c;
  pos.y = _bp.y + orbit.r * s;
  const v = w * orbit.r * AU_M;
  vel.vx = _bv.vx - v * s;
  vel.vy = _bv.vy + v * c;
}

/**
 * A place off a body that something can be left at: `r` AU from the centre
 * of `bodyName` at angle `phase`, at `minute`, as an orbit for orbitStateAt.
 * Out past a moon's own sphere of influence (its Hill sphere: Ganymede's
 * reaches 32,000 km, Phobos' 17) the moon is no frame to rest in: a point held
 * to it swings round the planet with it, at the moon's speed (off Phobos,
 * 2 km/s on a 7.7-hour circle), while anything left there in free fall
 * goes its own way. So the place is held off the planet instead. Where the
 * host's pull beats the Sun's tide there, the place goes round it on a
 * circular orbit, as a ship left there would; farther out it rests with
 * the host, which the tide barely moves it from in days.
 */
export function restingOrbit(bodyName, r, phase, minute) {
  const days = minute / DAY_MIN;
  let b = getBody(bodyName);
  let x = r * Math.cos(phase), y = r * Math.sin(phase);
  if (b.parent && r > b.a * Math.cbrt(b.gm / (3 * b.parent.gm))) {     // (out of the moon's Hill sphere)
    const m = bodyPos(b, days), p = bodyPos(b.parent, days);
    x += m.x - p.x; y += m.y - p.y;
    b = b.parent;
  }
  const R = Math.hypot(x, y), th = Math.atan2(y, x);
  const h = bodyPos(b.parent || b, days);
  const gm = b.gm * 1e9, rM = R * AU_M, sunM = Math.hypot(h.x, h.y) * AU_M;
  if (!b.gm || !sunM || gm / (rM * rM) <= 2 * GM_SUN * rM / sunM ** 3) return { body: b.name, r: R, phase: th, period: 0 };
  const period = TWO_PI * Math.sqrt(rM ** 3 / gm) / 86400;
  return { body: b.name, r: R, phase: th - TWO_PI * days / period, period };
}

const _o = { pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 } };
const _d = { pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 } };

/**
 * NPC transit between two rails entities: brachistochrone profile along the
 * chord between the moving endpoints. Exact at any time, O(1).
 * A transit can instead start from `fix` ({x, y, vx, vy, t}: where a ship
 * was when it went back on rails out in space), coasted on in a straight
 * line; its weight fades to nothing by arrival, so the error does too. An
 * end can also be a bare orbit (fromOrbit / toOrbit: a holding slot,
 * holding.js) instead of an entity.
 * Also sets e.thrust / e.heading so sensors see the drive plume.
 */
export function transitStateAt(world, e, minute, pos, vel) {
  const tr = e.transit;
  if (tr.fix) {
    const k = (minute - tr.fix.t) * MIN_S / AU_M;
    _o.pos.x = tr.fix.x + tr.fix.vx * k; _o.pos.y = tr.fix.y + tr.fix.vy * k;
    _o.vel.vx = tr.fix.vx; _o.vel.vy = tr.fix.vy;
  } else if (tr.fromOrbit) orbitStateAt(tr.fromOrbit, minute, _o.pos, _o.vel);
  else if (!world.anchorState(tr.from, minute, _o)) return false;
  if (tr.toOrbit) orbitStateAt(tr.toOrbit, minute, _d.pos, _d.vel);
  else if (!world.anchorState(tr.to, minute, _d)) return false;
  const span = Math.max(1, tr.t1 - tr.t0);
  const tau = Math.max(0, Math.min(1, (minute - tr.t0) / span));
  const frac = tau < 0.5 ? 2 * tau * tau : 1 - 2 * (1 - tau) * (1 - tau);
  const dfrac = (tau < 0.5 ? 4 * tau : 4 * (1 - tau)) / (span * MIN_S);   // per second
  const dx = _d.pos.x - _o.pos.x, dy = _d.pos.y - _o.pos.y;
  pos.x = _o.pos.x + dx * frac;
  pos.y = _o.pos.y + dy * frac;
  vel.vx = _o.vel.vx + (_d.vel.vx - _o.vel.vx) * frac + dx * AU_M * dfrac;
  vel.vy = _o.vel.vy + (_d.vel.vy - _o.vel.vy) * frac + dy * AU_M * dfrac;
  const burning = tau > 0 && tau < 1;
  e.thrust = burning ? tr.g : 0;
  const ang = Math.atan2(dy, dx);
  e.heading = tau < 0.5 ? ang : ang + Math.PI;
  return true;
}

/**
 * Advance a free body by dtSec from minute t0 under gravity (gravity.js:
 * the Sun and the bodies near) + constant thrust (thrustG along
 * `heading`). Velocity-Verlet: symplectic, 2nd order.
 */
export function stepFree(pos, vel, dtSec, thrustG = 0, heading = 0, t0 = gravityEpoch()) {
  const tax = thrustG > 0 ? thrustG * G0 * Math.cos(heading) : 0;
  const tay = thrustG > 0 ? thrustG * G0 * Math.sin(heading) : 0;
  gravityAt(pos.x, pos.y, t0, _g);
  const ax0 = _g.ax + tax, ay0 = _g.ay + tay;
  pos.x += (vel.vx * dtSec + 0.5 * ax0 * dtSec * dtSec) / AU_M;
  pos.y += (vel.vy * dtSec + 0.5 * ay0 * dtSec * dtSec) / AU_M;
  gravityAt(pos.x, pos.y, t0 + dtSec / MIN_S, _g);
  vel.vx += 0.5 * (ax0 + _g.ax + tax) * dtSec;
  vel.vy += 0.5 * (ay0 + _g.ay + tay) * dtSec;
}

/** Propagate a free entity's pos/vel from minute t0 to t1 with bounded substeps. */
export function propagateFree(pos, vel, t0, t1, thrustG, heading, maxStepMin) {
  let t = t0;
  while (t < t1) {
    const step = Math.min(maxStepMin, t1 - t);
    stepFree(pos, vel, step * MIN_S, thrustG, heading, t);
    t += step;
  }
}

/** Predicted {pos, vel} of any entity at a future minute, without mutating it. */
/**
 * A flight path's place (a craft between orbit and a world's ground, on
 * the rails planetary.js flew for it): set by planetary.js when it loads, so
 * this module needn't know how it is worked out.
 */
export const FLIGHT_PATH = { at: null };

export function predictEntity(e, minute, world = null) {
  const pos = { x: e.pos.x, y: e.pos.y };
  const vel = { vx: e.vel.vx, vy: e.vel.vy };
  if (e.flightPath && world && FLIGHT_PATH.at) FLIGHT_PATH.at(world, e, minute, pos, vel);
  else if (e.orbit) orbitStateAt(e.orbit, minute, pos, vel);
  else if (e.transit && world) {
    const thrust = e.thrust, heading = e.heading;
    transitStateAt(world, e, minute, pos, vel);
    e.thrust = thrust; e.heading = heading;          // prediction must not change the live entity
  }
  else if (minute > e.t) propagateFree(pos, vel, e.t, minute, e.thrust || 0, e.heading || 0, e.thrust > 0 ? 1 : 10);
  return { pos, vel };
}

// ---- WORLD ----

export class World {
  constructor(state) {
    this.state = state;
    this.byId = new Map();
    this.hash = new SpatialHash(0.05);
    this.stations = [];             // rails stations (destinations for traffic & contracts)
    this.beacons = new Set();       // entities broadcasting SOS — tiny, so no spatial search needed
    this.driven = new Set();        // NPC ships under a pilot, ordnance in flight — stepped every minute
    this.forces = new Set();        // police, navy and pirate hulls of the background population (forces.js)
    this._anchorMemo = new Map();   // id → { minute, pos, vel } for transit endpoints
    this.cursor = 0;                // background round-robin position (the net)
    this.cal = new Map();           // the calendar: minute → entities due then (e.$due: its live entry)
    this.calAt = state.clock.minute;   // the next minute of it to be served
    this._near = [];
    const list = state.entities;
    for (let i = 0; i < list.length; i++) this._index(list[i], i);
  }

  _index(e, i) {
    if (e.t === undefined) e.t = this.state.clock.minute;
    e.$i = i;
    this.byId.set(e.id, e);
    if (e.type === 'station' && e.orbit) this.stations.push(e);
    if (e.sos) this.beacons.add(e);
    if (e.driven) this.driven.add(e);
    if (e.tags?.force) this.forces.add(e);
    this.refresh(e, this.state.clock.minute);
    this.hash.insert(e);
    this.plan(e, this.state.clock.minute);
  }

  // ---- THE CALENDAR ----

  /** Put an entity on the calendar for `minute` (unless it is already due as soon). */
  _wake(e, minute) {
    const m = Math.max(minute, this.calAt);
    if (e.$due != null && e.$due >= this.calAt && e.$due <= m) return;
    e.$due = m;
    let b = this.cal.get(m);
    if (!b) this.cal.set(m, b = []);
    b.push(e);
  }

  /**
   * When an entity is next wanted: the soonest of its visitors' business
   * and, unless the near pass keeps it up to date, the last minute its
   * position can wait. Call after changing what an entity is doing outside
   * a visit (a force sent, a hull back on rails).
   */
  plan(e, minute = this.state.clock.minute) {
    let next = Infinity;
    for (let v = 0; v < WORLD_DUE.length; v++) { const d = WORLD_DUE[v](e); if (d < next) next = d; }
    if (next <= minute) next = minute + STUCK_MIN;           // (due, and not moved on: soon again, not every minute)
    const r = this._refreshDue(e, minute);
    if (r < next) next = r;
    if (next < Infinity) this._wake(e, next);
  }

  /** The last minute an entity's position can wait before it might be within HORIZON_AU of us. */
  _refreshDue(e, minute) {
    if (e.driven) return Infinity;                          // (its controller moves it)
    if (e.type === 'station' || e.type === 'nav') return minute + STATION_REFRESH_MIN;
    const f = this.state.flight;
    if (!f?.pos) return minute + LONGEST_REFRESH_MIN;
    const gap = Math.hypot(e.pos.x - f.pos.x, e.pos.y - f.pos.y) - HORIZON_AU;
    if (gap <= 0) return Infinity;                          // (inside: the near pass has it)
    // the gap closed at the speed between us (AU/min), that growing at its drive's G and ours (a G at
    // least, or what we burn at: AU/min²): the time it would take at worst
    const b = Math.hypot(e.vel.vx - f.vel.vx, e.vel.vy - f.vel.vy) * 60 / AU_M;
    const a = ((e.transit ? e.transit.g || 0 : e.thrust || 0) + Math.max(1, f.thrustG || 0)) * G0 * 3600 / AU_M;
    const t = (Math.sqrt(b * b + 2 * a * gap) - b) / a;
    return minute + Math.max(SHORTEST_REFRESH_MIN, Math.min(LONGEST_REFRESH_MIN, Math.floor(t)));
  }

  /** Serve the calendar up to `minute`: each entity due, brought up to date, its visitors, planned again. */
  _serve(minute) {
    let n = 0;
    const visitors = WORLD_VISITORS;
    for (let m = this.calAt; m <= minute; m++) {
      const b = this.cal.get(m);
      if (!b) continue;
      this.cal.delete(m);
      const list = this.state.entities;
      for (let i = 0; i < b.length; i++) {
        const e = b[i];
        if (e.$due !== m || list[e.$i] !== e) continue;   // (planned again sooner, or gone)
        e.$due = null;
        if (e.t !== minute) { this.refresh(e, minute); this.hash.update(e); }
        for (let v = 0; v < visitors.length && list[e.$i] === e; v++) visitors[v](e, minute, this);
        if (list[e.$i] === e) this.plan(e, minute);
        n++;
      }
    }
    this.calAt = minute + 1;
    return n;
  }

  get(id) {
    return id == null ? null : (this.byId.get(id) || null);
  }

  get count() {
    return this.state.entities.length;
  }

  add(e) {
    if (this.byId.has(e.id)) throw new Error(`Duplicate entity id ${e.id}`);
    this.state.entities.push(e);
    this._index(e, this.state.entities.length - 1);
    return e;
  }

  remove(idOrEntity) {
    const e = typeof idOrEntity === 'string' ? this.byId.get(idOrEntity) : idOrEntity;
    if (!e || this.byId.get(e.id) !== e) return false;
    this.hash.remove(e);
    this.byId.delete(e.id);
    const list = this.state.entities;
    const last = list.pop();
    if (last !== e) { list[e.$i] = last; last.$i = e.$i; }
    e.$i = -1;                                    // (gone: the calendar and the net pass it by)
    if (e.type === 'station') this.stations = this.stations.filter(s => s !== e);
    this.beacons.delete(e);
    this.driven.delete(e);
    this.forces.delete(e);
    this._anchorMemo.delete(e.id);
    return true;
  }

  /** Enlist an entity in (or strike it from) the background forces (keeps the index in sync). */
  setForce(e, force) {
    if (force) { e.tags.force = force; this.forces.add(e); } else { delete e.tags.force; this.forces.delete(e); }
  }

  /** Hand an entity to (or take it from) a controller (keeps the driven index in sync). */
  setDriven(e, on) {
    e.driven = !!on;
    if (on) { e.orbit = null; e.transit = null; this.driven.add(e); } else { this.driven.delete(e); this.plan(e); }
  }

  /** Turn an entity's distress beacon on/off (keeps the beacon index in sync). */
  setSos(e, on) {
    e.sos = !!on;
    if (on) this.beacons.add(e); else this.beacons.delete(e);
  }

  /** A rails entity's memo of its state (null if it has none: gone, or not on rails). */
  anchorMemo(id) {
    let m = this._anchorMemo.get(id);
    if (!m) {
      const e = this.byId.get(id);
      if (!e?.orbit) return null;
      m = { minute: NaN, orbit: e.orbit, pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 } };
      this._anchorMemo.set(id, m);
    }
    return m;
  }

  /** Exact state of a rails entity, memoized per minute (transit endpoints are shared by many ships). */
  anchorState(id, minute, out) {
    const m = this.anchorMemo(id);
    if (!m) return false;
    if (m.minute !== minute) { orbitStateAt(m.orbit, minute, m.pos, m.vel); m.minute = minute; }
    out.pos.x = m.pos.x; out.pos.y = m.pos.y; out.vel.vx = m.vel.vx; out.vel.vy = m.vel.vy;
    return true;
  }

  /** Bring one entity exactly up to `minute`. */
  refresh(e, minute) {
    if (e.driven) return;                         // its controller steps it (combat.js)
    if (e.flightPath && FLIGHT_PATH.at) {
      FLIGHT_PATH.at(this, e, minute, e.pos, e.vel);
    } else if (e.orbit) {
      orbitStateAt(e.orbit, minute, e.pos, e.vel);
    } else if (e.transit) {
      if (!transitStateAt(this, e, minute, e.pos, e.vel)) e.transit = null;   // endpoint vanished: drift
    } else if (minute > e.t) {
      propagateFree(e.pos, e.vel, e.t, minute, e.thrust || 0, e.heading || 0, e.thrust > 0 ? 1 : 15);
      // (a hull adrift, a wreck, that comes down on a rock rests there, turning with it: terrain.js
      // groundCheck does the same, with the blow, for what is flown)
      const s = nearestSurface(e.pos.x, e.pos.y, minute);
      if (s && s.alt < 0) {
        const spinDays = s.body.rotH / 24, days = minute / DAY_MIN;
        e.orbit = { body: s.body.name, r: s.body.radius / AU_KM, phase: Math.atan2(s.uy, s.ux) - (spinDays ? 2 * Math.PI * days / spinDays : 0), period: spinDays };
        e.thrust = 0;
        orbitStateAt(e.orbit, minute, e.pos, e.vel);
      }
    }
    e.t = minute;
  }

  /**
   * Per full minute: everything near the ship is brought exactly up to
   * date (out to HORIZON_AU, and a little past it: we have moved since it
   * was filed). One found beyond the horizon is handed to the calendar.
   */
  tick(minute, focus) {
    const hash = this.hash;
    const near = this._near;
    const h2 = HORIZON_AU * HORIZON_AU;
    near.length = 0;
    hash.query(focus.x, focus.y, NEAR_RANGE_AU, near);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.t === minute) continue;
      this.refresh(e, minute);
      hash.update(e);
      const dx = e.pos.x - focus.x, dy = e.pos.y - focus.y;
      if (dx * dx + dy * dy > h2) this.plan(e, minute);
    }
  }

  /**
   * Background upkeep for the far world, round-robin, at most `budget`
   * entities. The game loop calls this once per frame with a budget sized
   * to the frame's game time, capped — so time warp cost stays bounded no
   * matter how big the population is (far positions just get staler).
   */
  background(minute, budget) {
    const served = this._serve(minute);
    const list = this.state.entities;
    const n = list.length;
    if (!n) return served;
    // the net: round-robin, refreshed, visited, planned again
    const count = Math.min(budget, n);
    const visitors = WORLD_VISITORS;
    let c = this.cursor % n;
    for (let k = 0; k < count && list.length; k++) {
      if (c >= list.length) c = 0;               // a visitor removed entities
      const e = list[c];
      if (e.t !== minute) { this.refresh(e, minute); this.hash.update(e); }
      for (let v = 0; v < visitors.length && list[c] === e; v++) visitors[v](e, minute, this);
      if (list[c] === e) { this.plan(e, minute); if (++c >= list.length) c = 0; }
    }
    this.cursor = c;
    return served + count;
  }

  /** Entities within radius (AU) of a point. Far entities may be slightly stale. */
  query(pos, radiusAU, out = []) {
    return this.hash.query(pos.x, pos.y, radiusAU, out);
  }

  queryRect(minX, minY, maxX, maxY, out = []) {
    return this.hash.queryRect(minX, minY, maxX, maxY, out);
  }

  newId(prefix = 'ent') {
    const s = this.state;
    s.nextEntityId = (s.nextEntityId || 1);
    let id;
    do { id = `${prefix}-${s.nextEntityId++}`; } while (this.byId.has(id));
    return id;
  }
}

/** The net's budget for a stretch of game time: every entity at least daily, bounded per frame (the calendar does the rest). */
export function backgroundBudget(entityCount, minutes, cap = SWEEP_CAP) {
  return Math.min(cap, Math.ceil(entityCount * minutes / SWEEP_MIN) + 1);
}
