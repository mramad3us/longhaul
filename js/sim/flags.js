// ============================================================
// LONGHAUL — What the nav computer flags
//
// Three marks go on every display and every list that names a ship, so
// a contact that matters is never lost in a crowd (ui/marks.js draws them):
//
//   DARK     a ship with no transponder (sensors.js isDark): whoever it
//            is, it isn't saying. Known as soon as the board holds it; a
//            lost contact's last fix on the plot keeps it.
//   MISSION  what our signed work points at: the ship to find or strike
//            (once we know which contact it is: sensors.js identifyHunt;
//            until then its last-seen mark), the derelict, the convoy, the
//            survey mark, the port to deliver to, the port to report at
//            once the work is done, a distress call we answered, a navy
//            call-up. A dark contact that might be the ship we hunt (a
//            possible: hunts.js) is marked as a maybe, never named.
//   FLAG     the captain's own, on any ship or station we have a track
//            of: lettered A to Z, so one unidentified contact can be told
//            from the next on every display. A flag lasts as long as the
//            track does (on the board, charted, or a report on the plot):
//            when the plot forgets the ship, the flag goes with it. The
//            nav computer calls out a flagged contact coming back on the
//            board.
//
// Cost: the flags are at most 26, checked once a minute against the
// board's set and the plot (O(1) each); the mission targets are a pass
// over the few contracts we hold, made once per frame by the displays.
// ============================================================

import { getWorld } from './world.js';
import { isIdentified } from './sensors.js';
import { trackOf, liveKnowledge } from './intel.js';

export const FLAG_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** id → { letter, at (minute flagged), live (on the board last minute), name (what we last knew to call it) } */
export function createNavFlags() {
  return {};
}

/** What a job calls its target on the displays: its type (a leg back to port: TURN IN). */
const tagOf = (c) => c.type === 'PASSENGERS' ? 'PAX' : c.type;

/**
 * Everything our work points at: id → tag ('BOUNTY', 'CARGO', 'TURN IN',
 * 'DISTRESS', 'CALL-UP'; two jobs at one place: 'CARGO · PAX').
 */
export function missionTargets(state) {
  const out = new Map();
  const put = (id, tag) => {
    if (!id) return;
    const was = out.get(id);
    out.set(id, !was ? tag : was.split(' · ').includes(tag) ? was : `${was} · ${tag}`);
  };
  for (const c of state.contracts?.active || []) {
    if (c.phase === 'offered' || c.phase === 'complete' || c.phase === 'failed') continue;
    if (c.phase === 'return') { put(c.station, 'TURN IN'); continue; }
    const tag = tagOf(c);
    if (!(c.type === 'BOUNTY' || c.type === 'STRIKE') || c.identified) put(c.targetId, tag);   // (a hunted ship: only once named)
    put(c.markId, tag);
    put(c.dest, tag);
  }
  for (const m of state.missions?.list || []) if (m.status === 'accepted') put(m.entityId, 'DISTRESS');
  for (const cu of state.service?.callups || []) if (cu.heard && !cu.reported && !cu.over) put(cu.ship, 'CALL-UP');
  return out;
}

/**
 * The contacts that might be a ship we hunt (hunts.js possibles): id → the
 * job's tag. Kept apart from missionTargets: nothing names them.
 */
export function missionSuspects(state) {
  const out = new Map();
  for (const c of state.contracts?.active || []) {
    if (c.phase !== 'active' || c.identified || !c.suspects?.length) continue;
    for (const id of c.suspects) if (!out.has(id)) out.set(id, tagOf(c));
  }
  return out;
}

/** The letter flagged on this entity, or null. */
export const flagOf = (state, id) => state.navFlags?.[id]?.letter || null;

/**
 * What we can call a flagged thing (null: an unidentified contact). Only
 * what we know: a ship on the board by its transponder or a long enough
 * look, one off the board by the plot's record of it.
 */
export function knownName(state, id) {
  const e = getWorld(state).get(id);
  if (!e) return null;
  if (e.type !== 'ship') return e.name;
  if (state.sensors.$seen?.has(id)) return isIdentified(state, e) ? e.name : null;
  if (liveKnowledge(state, e) === 'charted') return e.name;
  return trackOf(state, id)?.name || null;
}

/** Do we have a track of it (board, chart, plot)? A flag needs one. */
function held(state, e) {
  return !!liveKnowledge(state, e) || !!trackOf(state, e.id);
}

/** Flag it, or take its flag off. Returns { ok, on, letter, text }. */
export function toggleFlag(state, id) {
  const F = (state.navFlags ??= createNavFlags());
  const had = F[id];
  if (had) {
    delete F[id];
    return { ok: true, on: false, letter: had.letter, text: `Flag ${had.letter} cleared` };
  }
  const e = getWorld(state).get(id);
  if (!e || (e.type !== 'ship' && e.type !== 'station')) return { ok: false, text: 'Only a ship or a station can be flagged' };
  if (!held(state, e)) return { ok: false, text: 'No track to flag' };
  const used = new Set(Object.values(F).map(f => f.letter));
  const letter = [...FLAG_LETTERS].find(l => !used.has(l));
  if (!letter) return { ok: false, text: `All ${FLAG_LETTERS.length} flags are in use` };
  const name = knownName(state, id);
  F[id] = { letter, at: state.clock.minute, live: !!state.sensors.$seen?.has(id), name };
  return { ok: true, on: true, letter, text: `Flag ${letter}: ${name || 'unidentified contact'}` };
}

/** Clear every flag. */
export function clearFlags(state) {
  state.navFlags = createNavFlags();
}

/** The flags, A to Z: [{ id, letter, at, live, name }]. */
export function flagList(state) {
  const F = state.navFlags || {};
  return Object.keys(F).map(id => ({ id, ...F[id] })).sort((a, b) => a.letter.localeCompare(b.letter));
}

/**
 * Once a minute, after the board and the plot: a flag whose track is gone
 * goes (`flag-lost`); a flagged contact back on the board is called out
 * (`flag-back`).
 */
export function flagsTick(state, emit = () => {}) {
  const F = state.navFlags;
  if (!F) return;
  const world = getWorld(state);
  for (const id of Object.keys(F)) {
    const f = F[id];
    const e = world.get(id);
    if (!e || !held(state, e)) {
      delete F[id];
      emit('flag-lost', { id, letter: f.letter, name: f.name });
      continue;
    }
    const live = !!state.sensors.$seen?.has(id);
    if (live || !f.name) f.name = knownName(state, id) || f.name;
    if (live && !f.live) emit('flag-back', { id, letter: f.letter, name: f.name });
    f.live = live;
  }
}
