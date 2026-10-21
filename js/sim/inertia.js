// ============================================================
// LONGHAUL — Inertial events
// When the drive lights, cuts, or the ship flips, anyone not strapped
// in keeps their old motion: they slide or fly across the deck and hit
// whatever is in the way. This plays out in real time (a couple of
// seconds) while game time is frozen — "bullet time".
// Runtime-only state lives in state.$inertia (not saved).
// ============================================================

import { G0 } from '../core/constants.js';
import { random } from '../core/rng.js';
import { BLOCKING } from './tiles.js';
import { shipGeometry, isRestraint } from './ship-layout.js';
import { isConscious, applyImpact } from './crew.js';
import { abandonTask } from './crew-ai.js';

const TILE_M = 0.9;                 // meters per tile
const STEP = 1 / 120;               // fixed physics substep, seconds
const FRICTION_G = 4.0;             // 1/s velocity decay on the deck under gravity
const FRICTION_0G = 0.4;            // 1/s in micro-G (air drag, grabbing handholds)
const STOP_SPEED = 0.05;            // tiles/s
const BRACE_G = 1.5;                // announced burns up to this: crew brace in time
const SURPRISE_G = 0.5;             // unannounced changes above this throw people
const FLIP_G = 0.4;

export const Maneuver = { BURN_START: 'burn-start', BURN_STOP: 'burn-stop', THRUST_CHANGE: 'thrust-change', FLIP: 'flip' };

export function isInertiaActive(state) {
  return !!state.$inertia?.active;
}

/**
 * Start an inertial event. opts: { deltaG, surprise, gForce (after the event) }
 * Returns the number of bodies set in motion.
 */
export function triggerManeuver(state, type, opts) {
  let dir, accel, duration;
  const dG = Math.abs(opts.deltaG || 0);
  switch (type) {
    case Maneuver.BURN_START: dir = { x: 0, y: 1 }; accel = dG * G0; duration = 0.8; break;
    case Maneuver.BURN_STOP: dir = { x: 0, y: -1 }; accel = dG * G0 * 0.3; duration = 0.8; break;
    case Maneuver.THRUST_CHANGE: dir = { x: 0, y: opts.deltaG >= 0 ? 1 : -1 }; accel = dG * G0; duration = 0.8; break;
    case Maneuver.FLIP: {
      const a = random() * Math.PI * 2;
      dir = { x: Math.cos(a), y: Math.sin(a) }; accel = FLIP_G * G0; duration = 3; break;
    }
    default: return 0;
  }
  if (accel < 1) return 0;

  const isBurn = type !== Maneuver.FLIP;
  const bodies = [];
  for (const m of state.ship.crew) {
    if (m.away || isRestraint(m.seat) || m.task?.type === 'carried') continue;     // (not aboard: not thrown about)
    if (!m.dead && isConscious(m) && isBurn) {
      if (!opts.surprise && dG <= BRACE_G) continue;   // braced for an announced burn
      if (opts.surprise && dG <= SURPRISE_G) continue;
    }
    bodies.push({ id: m.id, vx: 0, vy: 0, moving: true });
  }
  if (!bodies.length) return 0;
  state.$inertia = { active: true, type, dir, accel, duration, elapsed: 0, acc: 0, bodies, grounded: (opts.gForce || 0) >= 0.01, impacts: [] };
  return bodies.length;
}

/**
 * Advance the slide by `dtReal` seconds of real time. Returns impact
 * events produced this call; the event ends when everyone has stopped.
 */
export function updateInertia(state, dtReal) {
  const I = state.$inertia;
  if (!I?.active) return [];
  const geo = shipGeometry(state.ship);
  const out = [];
  I.acc += Math.min(dtReal, 0.1);
  while (I.acc >= STEP) {
    I.acc -= STEP;
    I.elapsed += STEP;
    const push = I.elapsed <= I.duration ? I.accel / TILE_M : 0;
    const decay = Math.exp(-(I.grounded ? FRICTION_G : FRICTION_0G) * STEP);
    for (const b of I.bodies) {
      if (!b.moving) continue;
      const m = state.ship.crew.find(c => c.id === b.id);
      b.vx = (b.vx + I.dir.x * push * STEP) * decay;
      b.vy = (b.vy + I.dir.y * push * STEP) * decay;
      const nx = m.pos.sx + b.vx * STEP;
      const ny = m.pos.sy + b.vy * STEP;
      if (blocked(state, geo, m.pos.sy, nx, ny)) {
        const speed = Math.hypot(b.vx, b.vy) * TILE_M;
        b.moving = false;
        const hit = applyImpact(m, speed);
        if (hit) { hit.member = m; hit.speed = speed; out.push(hit); }
      } else {
        m.pos.sx = nx; m.pos.sy = ny;
        if (I.elapsed > I.duration && Math.hypot(b.vx, b.vy) < STOP_SPEED) b.moving = false;
      }
    }
    if (I.elapsed > I.duration && I.bodies.every(b => !b.moving)) {
      finish(state, geo);
      break;
    }
    if (I.elapsed > 12) { finish(state, geo); break; }   // safety valve
  }
  for (const m of state.ship.crew) { m.$px = m.pos.sx; m.$py = m.pos.sy; }
  return out;
}

function blocked(state, geo, fromSy, x, y) {
  const deckIdx = geo.deckOfRow(fromSy);
  const deck = state.ship.decks[deckIdx];
  const lx = Math.round(x);
  const ly = Math.round(y - geo.deckStart[deckIdx]);
  if (ly < 0 || ly >= deck.tiles.length || lx < 0 || lx >= deck.tiles[0].length) return true;
  return BLOCKING.has(deck.tiles[ly][lx]);
}

function finish(state, geo) {
  const I = state.$inertia;
  I.active = false;
  for (const b of I.bodies) {
    const m = state.ship.crew.find(c => c.id === b.id);
    // settle onto the tile grid and re-plan from there
    m.pos.sx = Math.round(m.pos.sx);
    m.pos.sy = Math.round(m.pos.sy);
    const deckIdx = geo.deckOfRow(m.pos.sy);
    const key = geo.key(deckIdx, m.pos.sx, m.pos.sy - geo.deckStart[deckIdx]);
    if (!geo.index.has(key)) {
      // landed on furniture: step off to the closest walkable tile
      let best = null, bd = Infinity;
      for (const n of geo.nodes) {
        if (n.deck !== deckIdx) continue;
        const d = (n.sx - m.pos.sx) ** 2 + (n.sy - m.pos.sy) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
      if (best) { m.pos.sx = best.sx; m.pos.sy = best.sy; }
    }
    if (m.task?.type !== 'carried') abandonTask(state, m);
    m.pause = 1;
  }
}
