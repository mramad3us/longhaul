// ============================================================
// LONGHAUL — Crew ashore: the hiring hall and shore leave
//
// A port is where crews change. Docked at a station with a hiring hall,
// we can sign people on (up to the berths our hull has for crew:
// ship-classes.js maxCrew) for a signing fee, or pay someone off. The
// hall's people change daily; who is there is drawn once a day and kept
// with the station.
//
// The hall's hands come with their lives (careers.js): an age, a home, a
// rank their years have earned, and the wage it draws, shown before they
// sign. Shore leave sends the crew ashore through the lock for a run: eight
// hours off the ship (they are away, as a boarding party is: off our
// decks and stations), back rested, fed, washed and in better spirits (the
// more for a world's ground, the most at home: careers.js backFromLeave).
// Those whose service is over (retired, or quitting) sign off when we are
// in port (signOff), their back pay settled as far as the credits go.
// The ship can't undock with anyone ashore, and the berth must be ours
// until they are back (a long lease: leases.js), bought with the leave if
// asked.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { pick } from '../core/rng.js';
import { maxCrew, PLAYER_CLASS } from './ship-classes.js';
import { createMember, ROLES, ROLE_SKILL, SURNAME_POOL, homeDeckFor } from './crew.js';
import { dockedStationEntity } from './docking.js';
import { STATIONS } from './stations.js';
import { shipGeometry, airlockFor } from './ship-layout.js';
import { abandonTask } from './crew-ai.js';
import { closeJob } from './jobs.js';
import { leaseShortfall, extendLease } from './leases.js';
import { startCareer, careerDraw, backFromLeave, farewell, note, rankTitle, fullName, wageOf, ageOf } from './careers.js';
import { getWorld } from './world.js';
import { backFromHospital } from './hospital.js';

export const LEAVE_MIN = 8 * 60;
export const LEAVE_COST = 60;               // MCR a head, ashore
const HALL_SIZE = 4;
const ROLE_FEE = { Pilot: 900, Engineer: 900, Medic: 800, Gunner: 700, Mechanic: 600, Scientist: 600, Cook: 400, Security: 700, Deckhand: 300, Captain: 1200 };

/** The people in a station's hiring hall today (drawn once a day). */
export function hiringHall(state, st) {
  if (!STATIONS[st.id]?.services.includes('hiring')) return [];
  const day = Math.floor(state.clock.minute / DAY_MIN);
  if (st.hall?.day !== day) st.hall = { day, people: drawHall(state, HALL_SIZE, { at: st.name }) };
  return st.hall.people;
}

/**
 * `n` people looking for a berth, with their lives (careers.js): a
 * hall's day. `quality`: skill points more in their trade (a big world's
 * academy graduates: ground.js), their rank as it earns; `home`: where most
 * of them are from (a world's hall: four in five).
 */
export function drawHall(state, n, { quality = 0, home = null, at = '' } = {}) {
  // (the captain's name as the player typed it, 'T. Yamada': its surname is taken too)
  const used = new Set(state.ship.crew.map(m => m.name.split(' ').at(-1)));
  const names = SURNAME_POOL.filter(x => !used.has(x));
  const draw = careerDraw(state.ship);
  const given = new Set(state.ship.crew.map(m => m.given).filter(Boolean));          // (nobody in a hall shares a given name with another, or with a hand aboard)
  const people = [];
  for (let i = 0; i < n; i++) {
    const role = pick(ROLES.slice(1));
    const m = createMember(-1, role, names);
    if (names.includes(m.name)) names.splice(names.indexOf(m.name), 1);   // (two in one hall never share a name)
    if (quality) { const k = ROLE_SKILL[role]; m.skills[k] = Math.min(100, m.skills[k] + quality); }
    startCareer(m, state.clock.minute, { draw, home: home && draw() < 0.8 ? home : null, avoid: given });
    given.add(m.given);
    const best = Math.max(...Object.values(m.skills));
    people.push({ name: m.name, given: m.given, role, skills: m.skills, fee: Math.round((ROLE_FEE[role] || 500) * (0.6 + best / 100) * (1 + 0.15 * m.rank) / 10) * 10, morale: m.morale,
      born: m.born, home: m.home, rank: m.rank, xp: m.xp, retireAt: m.retireAt, title: rankTitle(m), wage: wageOf(m), age: Math.floor(ageOf(m, state.clock.minute)), at });
  }
  return people;
}

/** A hall's candidate made one of the crew (`where`: for their record). Returns the member (not yet aboard: the caller places them). */
export function signOn(state, p, where) {
  const crew = state.ship.crew;
  // (ids are never reused: a job or a record about someone paid off must not land on a new hand)
  const id = Math.max(state.ship.nextCrewId ?? 0, ...crew.map(m => m.id + 1));
  state.ship.nextCrewId = id + 1;
  const m = createMember(id, p.role, [p.name], state.ship);
  m.skills = { ...p.skills };
  m.morale = p.morale;
  startCareer(m, state.clock.minute, { draw: careerDraw(state.ship) });
  Object.assign(m, { given: p.given, born: p.born, home: p.home, rank: p.rank, xp: p.xp, retireAt: p.retireAt });
  note(m, state.clock.minute, `Signed on at ${where}`);
  crew.push(m);
  return m;
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
  const m = signOn(state, p, st.name);
  const lock = airlockFor(state.ship);
  const node = lock?.access != null ? shipGeometry(state.ship).nodes[lock.access] : null;
  if (node) { m.pos = { sx: node.sx, sy: node.sy }; m.$px = node.sx; m.$py = node.sy; }
  hall.splice(index, 1);
  return { ok: true, member: m, text: `${m.name} (${m.role}) signs on for ${p.fee.toLocaleString()} MCR and comes aboard.` };
}

/** Pay someone off at a station (never the captain). */
export function dismiss(state, crewId) {
  if (!dockedStationEntity(state)) return { ok: false, text: 'Dock first.' };
  const crew = state.ship.crew;
  const m = crew.find(x => x.id === crewId);
  if (!m || m.role === 'Captain') return { ok: false, text: 'The captain stays.' };
  if (m.away) return { ok: false, text: `${m.name} isn't aboard.` };
  // (paid off is paid: what they are owed, first)
  const owed = Math.round(m.owed || 0), res = state.resources.credits;
  if (owed > res.current) return { ok: false, text: `Paying ${m.name} off takes the ${owed.toLocaleString()} MCR they are owed.` };
  res.current -= owed;
  m.owed = 0;
  leaveShip(state, m);
  farewell(state, m, 'paid off');
  return { ok: true, text: `${m.name} is paid off${owed ? ` (${owed.toLocaleString()} MCR back pay)` : ''} and goes ashore.` };
}

/** Someone off the ship for good: their work put down, anyone busy with them told, the jobs about them gone. */
function leaveShip(state, m) {
  const crew = state.ship.crew;
  abandonTask(state, m);
  // anyone busy with them (carrying them to the autodoc) puts it down
  for (const o of crew) if (o !== m && o.task?.patient === m.id) abandonTask(state, o);
  state.ship.crew = crew.filter(x => x !== m);
  if (!(state.ship.nextCrewId > m.id)) state.ship.nextCrewId = Math.max(...crew.map(x => x.id)) + 1;
  for (const j of state.jobs.list) if (j.assignee === m.id) { j.assignee = null; j.status = 'open'; }
  // and jobs about them go: a rescue of someone ashore, work set aside for them
  for (const j of state.jobs.list.filter(j => j.data.patient === m.id || j.data.engineer === m.id)) closeJob(state, j);
}

/**
 * Someone away from the ship leaving it for good where they are (a hand
 * retiring on a world's ground, from a shuttle's run: ground.js): their
 * back pay settled as far as the credits go, the crew's send-off (`cheer`).
 */
export function signOffAway(state, m, why, { cheer = 3, emit = () => {}, text = '' } = {}) {
  if (!state.ship.crew.includes(m)) return false;
  const res = state.resources.credits;
  const pay = Math.min(m.owed || 0, res.current);
  res.current -= pay;
  m.owed = Math.round((m.owed || 0) - pay);
  m.away = null;
  leaveShip(state, m);
  for (const o of state.ship.crew) if (!o.dead) o.moraleMod = (o.moraleMod || 0) + cheer;
  farewell(state, m, why);
  emit('crew-signed-off', { member: m, why: 'retired', text: text + (m.owed > 0 ? ` Still owed ${m.owed.toLocaleString()} MCR.` : '') });
  return true;
}

/**
 * Someone whose service is over leaves the ship in port: retired, or
 * quitting. Their back pay is settled as far as the credits go; the crew
 * give a retiring hand a send-off, and take a quitting one's going hard.
 */
export function signOff(state, m, why, emit = () => {}) {
  const crew = state.ship.crew;
  if (!crew.includes(m) || m.away) return false;
  const res = state.resources.credits;
  const pay = Math.min(m.owed || 0, res.current);
  res.current -= pay;
  leaveShip(state, m);
  for (const o of state.ship.crew) if (!o.dead) o.moraleMod = (o.moraleMod || 0) + (why === 'retired' ? 3 : -3);
  farewell(state, m, why);
  const left = (m.owed || 0) - pay;
  const years = Math.floor(ageOf(m, state.clock.minute));
  const text = why === 'retired' ? `${fullName(m)}, ${rankTitle(m)}, signs off and retires at ${years}${left > 0 ? `, still owed ${Math.round(left).toLocaleString()} MCR` : ''}. The crew see them off.`
    : `${m.name} signs off and goes ashore for good${left > 0 ? `, owed ${Math.round(left).toLocaleString()} MCR` : ''}.`;
  emit('crew-signed-off', { member: m, why, text });
  return true;
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

/**
 * What a run ashore does for someone: back rested, fed, washed and in
 * better spirits, the more for a world's ground under a sky than a
 * station's corridors, the most at home (careers.js backFromLeave). Returns
 * whether it was home.
 */
export function restedAshore(m, minute, where = {}) {   // where: { station | world, work: a day's errand, not leave }
  m.needs.rest = Math.max(m.needs.rest, 90); m.needs.food = Math.max(m.needs.food, 90);
  m.needs.hygiene = 100; m.needs.fun = 100;
  return backFromLeave(m, minute, where);
}

/** Per minute: crew whose leave is over come back aboard through the lock. */
export function leaveTick(state, emit = () => {}) {
  const now = state.clock.minute;
  let back = 0;
  for (const m of state.ship.crew) {
    if (!m.away?.ashore || now < m.away.until) continue;
    const lock = airlockFor(state.ship, state.dock?.port);
    const node = lock?.access != null ? shipGeometry(state.ship).nodes[lock.access] : shipGeometry(state.ship).nodes[0];
    const at = m.away.ashore, stay = m.away.hospital ? m.away : null;
    m.away = null;
    m.pos = { sx: node.sx, sy: node.sy }; m.$px = node.sx; m.$py = node.sy;
    m.homeDeck = homeDeckFor(state.ship, m.role);
    if (stay) {
      // (out of a hospital bed, not off a run ashore)
      m.needs.rest = Math.max(m.needs.rest, 90); m.needs.food = Math.max(m.needs.food, 90); m.needs.hygiene = 100;
      const mended = backFromHospital(m, stay.hospital, now, now >= stay.full);
      emit('crew-back', { count: 1, text: `${m.name} back aboard ${mended ? 'from hospital, mended' : 'from hospital, the treatment cut short'}.` });
      continue;
    }
    restedAshore(m, now, { station: STATIONS[at]?.body || getWorld(state).get(at)?.orbit?.body || null });
    back++;
  }
  if (back) emit('crew-back', { count: back, text: `${back} back aboard from shore leave.` });
}

/** Recall everyone ashore now (their leave is cut short). */
export function recallLeave(state) {
  for (const m of state.ship.crew) if (m.away?.ashore && !m.away.hospital) m.away.until = state.clock.minute;
}

export const crewAshore = (state) => state.ship.crew.filter(m => m.away?.ashore).length;

