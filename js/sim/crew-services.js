// ============================================================
// LONGHAUL — Crew ashore: the hiring hall and shore leave
//
// A port is where crews change. Docked at a station with a hiring hall,
// we can sign people on (up to the berths our hull has for crew:
// ship-classes.js maxCrew) for a signing fee, or pay someone off. The
// hall's people change daily; who is there is drawn once a day and kept
// with the station.
//
// Shore leave sends the crew ashore through the lock for a run: eight
// hours off the ship (they are away, as a boarding party is: off our
// decks and stations), back rested, fed, washed and in better spirits.
// The ship can't undock with anyone ashore, and the berth must be ours
// until they are back (a long lease: leases.js), bought with the leave if
// asked.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { pick } from '../core/rng.js';
import { maxCrew, PLAYER_CLASS } from './ship-classes.js';
import { createMember, ROLES, SURNAME_POOL, homeDeckFor } from './crew.js';
import { dockedStationEntity } from './docking.js';
import { STATIONS } from './stations.js';
import { shipGeometry, airlockFor } from './ship-layout.js';
import { abandonTask } from './crew-ai.js';
import { closeJob } from './jobs.js';
import { leaseShortfall, extendLease } from './leases.js';

export const LEAVE_MIN = 8 * 60;
export const LEAVE_COST = 60;               // MCR a head, ashore
const HALL_SIZE = 4;
const ROLE_FEE = { Pilot: 900, Engineer: 900, Medic: 800, Gunner: 700, Mechanic: 600, Scientist: 600, Cook: 400, Security: 700, Deckhand: 300, Captain: 1200 };

/** The people in a station's hiring hall today (drawn once a day). */
export function hiringHall(state, st) {
  if (!STATIONS[st.id]?.services.includes('hiring')) return [];
  const day = Math.floor(state.clock.minute / DAY_MIN);
  if (st.hall?.day !== day) {
    const used = new Set(state.ship.crew.map(m => m.name));
    const names = SURNAME_POOL.filter(n => !used.has(n));
    const people = [];
    for (let i = 0; i < HALL_SIZE; i++) {
      const role = pick(ROLES.slice(1));
      const m = createMember(-1, role, names);
      const best = Math.max(...Object.values(m.skills));
      people.push({ name: m.name, role, skills: m.skills, fee: Math.round((ROLE_FEE[role] || 500) * (0.6 + best / 100) / 10) * 10, morale: m.morale });
    }
    st.hall = { day, people };
  }
  return st.hall.people;
}

/** Sign someone on from the hall. Returns { ok, text }. */
export function hire(state, index) {
  const st = dockedStationEntity(state);
  if (!st) return { ok: false, text: 'Dock first.' };
  const hall = hiringHall(state, st);
  const p = hall[index];
  if (!p) return { ok: false, text: 'They have gone.' };
  const crew = state.ship.crew;
  if (crew.filter(m => !m.dead).length >= maxCrew(state.ship.classId || PLAYER_CLASS)) return { ok: false, text: 'No berth aboard for another hand.' };
  if (state.resources.credits.current < p.fee) return { ok: false, text: `${p.name} wants ${p.fee.toLocaleString()} MCR to sign.` };
  state.resources.credits.current -= p.fee;
  // (ids are never reused: a job or a record about someone paid off must not land on a new hand)
  const id = Math.max(state.ship.nextCrewId ?? 0, ...crew.map(m => m.id + 1));
  state.ship.nextCrewId = id + 1;
  const m = createMember(id, p.role, [p.name], state.ship);
  m.skills = { ...p.skills };
  m.morale = p.morale;
  const lock = airlockFor(state.ship);
  const node = lock?.access != null ? shipGeometry(state.ship).nodes[lock.access] : null;
  if (node) { m.pos = { sx: node.sx, sy: node.sy }; m.$px = node.sx; m.$py = node.sy; }
  crew.push(m);
  hall.splice(index, 1);
  return { ok: true, member: m, text: `${m.name} (${m.role}) signs on for ${p.fee.toLocaleString()} MCR and comes aboard.` };
}

/** Pay someone off at a station (never the captain). */
export function dismiss(state, crewId) {
  if (!dockedStationEntity(state)) return { ok: false, text: 'Dock first.' };
  const crew = state.ship.crew;
  const m = crew.find(x => x.id === crewId);
  if (!m || m.id === crew[0].id) return { ok: false, text: 'The captain stays.' };
  if (m.away) return { ok: false, text: `${m.name} isn't aboard.` };
  abandonTask(state, m);
  // anyone busy with them (carrying them to the autodoc) puts it down
  for (const o of crew) if (o !== m && o.task?.patient === m.id) abandonTask(state, o);
  state.ship.crew = crew.filter(x => x !== m);
  if (!(state.ship.nextCrewId > m.id)) state.ship.nextCrewId = Math.max(...crew.map(x => x.id)) + 1;
  for (const j of state.jobs.list) if (j.assignee === m.id) { j.assignee = null; j.status = 'open'; }
  // and jobs about them go: a rescue of someone ashore, work set aside for them
  for (const j of state.jobs.list.filter(j => j.data.patient === m.id || j.data.engineer === m.id)) closeJob(state, j);
  return { ok: true, text: `${m.name} is paid off and goes ashore.` };
}

/** Send crew ashore. ids: who goes (default: everyone off watch and able). */
export function shoreLeave(state, ids = null, { extend = false } = {}) {
  const st = dockedStationEntity(state);
  if (!st || !STATIONS[st.id]?.services.includes('leave')) return { ok: false, text: 'No leave here.' };
  const going = state.ship.crew.filter(m => !m.dead && !m.away && (ids ? ids.includes(m.id) : true) && m.consciousness > 50);
  if (!going.length) return { ok: false, text: 'Nobody to send.' };
  const cost = going.length * LEAVE_COST;
  const short = leaseShortfall(state, LEAVE_MIN);
  if (short.hours && !extend) return { ok: false, lease: short, text: `Your berth lease runs out before they would be back: ${short.hours} more hours of berth (${short.cost.toLocaleString()} MCR) first.` };
  if (state.resources.credits.current < cost + short.cost) return { ok: false, text: `A run ashore costs ${(cost + short.cost).toLocaleString()} MCR${short.cost ? ' with the berth' : ''}.` };
  if (short.hours) extendLease(state, short.hours);
  state.resources.credits.current -= cost;
  const until = state.clock.minute + LEAVE_MIN;
  for (const m of going) { abandonTask(state, m); m.away = { ashore: st.id, until }; m.activity = 'ashore'; m.seat = null; m.path = []; }
  return { ok: true, text: `${going.length} ashore at ${st.name} for eight hours (${cost.toLocaleString()} MCR).` };
}

/** What a run ashore does for someone: back rested, fed, washed and in better spirits (a station's, or a world's by shuttle). */
export function restedAshore(m) {
  m.needs.rest = Math.max(m.needs.rest, 90); m.needs.food = Math.max(m.needs.food, 90);
  m.needs.hygiene = 100; m.needs.fun = 100;
  m.moraleMod = (m.moraleMod || 0) + 8;
}

/** Per minute: crew whose leave is over come back aboard through the lock. */
export function leaveTick(state, emit = () => {}) {
  const now = state.clock.minute;
  let back = 0;
  for (const m of state.ship.crew) {
    if (!m.away?.ashore || now < m.away.until) continue;
    const lock = airlockFor(state.ship, state.dock?.port);
    const node = lock?.access != null ? shipGeometry(state.ship).nodes[lock.access] : shipGeometry(state.ship).nodes[0];
    m.away = null;
    m.pos = { sx: node.sx, sy: node.sy }; m.$px = node.sx; m.$py = node.sy;
    restedAshore(m);
    m.homeDeck = homeDeckFor(state.ship, m.role);
    back++;
  }
  if (back) emit('crew-back', { count: back, text: `${back} back aboard from shore leave.` });
}

/** Recall everyone ashore now (their leave is cut short). */
export function recallLeave(state) {
  for (const m of state.ship.crew) if (m.away?.ashore) m.away.until = state.clock.minute;
}

export const crewAshore = (state) => state.ship.crew.filter(m => m.away?.ashore).length;

