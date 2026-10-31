// ============================================================
// LONGHAUL — A world's ground: what it has for a crew that a station hasn't
//
// A station is corridors and a concourse; a settled world is billions of
// people under a sky, and it has what they have built. A run ashore by
// shuttle (shuttles.js: ASHORE, the pad held eight hours) is a chance for
// each who goes to do one thing there (an ERRAND, chosen per head):
//
//   LEAVE      a run ashore: rested, and the better for a world's ground than
//              a station's (careers.js backFromLeave: +15, +20 at home)
//   COURSE     a day at an academy in a skill the world teaches (GROUND:
//              Earth teaches all four; Mars the helm, the engine room and the
//              guns; Luna the yards' engineering and the flight schools;
//              the moons what they live by): the skill raised, the more the
//              less they know (COURSE_GAIN at nothing, a third of it at 66),
//              experience for it, COURSE_COST; one every COURSE_DAYS a head
//   HOSPITAL   treatment of what the ship can't, or not as fast: a big
//              world's hospitals (Earth, Mars, Luna) mend brain damage, which
//              the autodoc never does, and everything else in a day; a moon's
//              clinic heals the body and the heart, not the brain. Paid by
//              the damage. The hurt may ride down for it (not the critical:
//              stabilize them first), as patients, not pilots
//   RETIRE     a hand who has asked to retire signs off there (any settled
//              world; at home, a better send-off), leaving their seat free
//              for the way up
//
// The SPACEPORT HALL (groundHall): every settled world's spaceports have
// people looking for a berth, more on the big worlds, and the big worlds'
// better trained (academy graduates: GROUND quality, skill in their trade).
// Signed on at the pad (the fee paid on landing), they ride up in the seats
// left free on the way back, and come aboard with the shuttle.
//
// Everything here is plain data on the run (run.errands, run.hires) and
// worked at landing and recovery (shuttles.js); nothing is simulated on the
// ground itself.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { overallHealth, hasCondition, hospitalCure } from './crew.js';
import { treatment, harmOf } from './hospital.js';
import { note, fullName, homeOfWorld, ageOf } from './careers.js';
import { drawHall, signOffAway } from './crew-services.js';

/** What each settled world's ground has: its hospital, the skills its academies teach, its spaceport hall. */
export const GROUND = {
  Earth: { hospital: 'full', courses: ['piloting', 'engineering', 'medical', 'security'], hall: 6, quality: 10, academy: 'the UN academies' },
  Mars: { hospital: 'full', courses: ['piloting', 'engineering', 'security'], hall: 5, quality: 9, academy: 'the Mariner Valley institutes' },
  Luna: { hospital: 'full', courses: ['engineering', 'piloting'], hall: 4, quality: 6, academy: 'the yards\' schools' },
  Ganymede: { hospital: 'clinic', courses: ['medical', 'engineering'], hall: 3, quality: 2, academy: 'the domes\' college' },
  Callisto: { hospital: 'clinic', courses: ['security'], hall: 2, quality: 3, academy: 'the MCRN base\'s range' },
  Europa: { hospital: 'clinic', courses: ['engineering'], hall: 2, quality: 1, academy: 'the ice miners\' school' },
  Titan: { hospital: 'clinic', courses: ['medical'], hall: 2, quality: 2, academy: 'the research stations' },
};
export const COURSE_COST = 400;             // MCR a head
export const COURSE_DAYS = 60;              // between one course and the next, a head
export const COURSE_GAIN = 6;               // skill points at nothing known (6 × (1 − skill/100))
const COURSE_XP = 30;
const HOSPITAL_BASE = 150;                  // MCR, a clinic's or a hospital's door
const HOSPITAL_PER_POINT = 6;               // MCR a point of harm (body and heart below 100)
export const NEURAL_COST = 2500;            // MCR: brain damage mended, at a big world's hospital

export const groundOf = (world) => GROUND[world] || null;

/** What the hospital here would do for someone, and its bill: null if nothing it can mend. */
export function treatmentFor(m, world) {
  const g = groundOf(world);
  if (!g || m.dead) return null;
  const level = g.hospital === 'full' ? 'full' : 'clinic';
  const t = treatment(m, level), hangover = m.juiceHangover > 0, harm = harmOf(m);
  const brain = hasCondition(m, 'brain-damage');
  if (t?.cost == null && harm < 2 && !hangover) return t?.refused ? { cost: 0, untreatable: true, text: 'brain damage wants a big world\'s hospital' } : null;
  const what = [...(t?.what || (harm >= 2 ? ['injuries'] : [])), hangover && 'the juice'].filter(Boolean);
  return { cost: Math.round((t?.cost ?? HOSPITAL_BASE + harm * HOSPITAL_PER_POINT) / 10) * 10, brain: brain && level === 'full', untreatable: brain && level !== 'full', text: `${level === 'full' ? 'hospital' : 'clinic'}: ${what.join(', ')}` };
}

/** When someone may next take a course (minute), and the gain one would bring in a skill. */
export const nextCourse = (m) => (m.lastCourse ?? -Infinity) + COURSE_DAYS * DAY_MIN;
export const courseGain = (m, skill) => Math.round(COURSE_GAIN * (1 - (m.skills?.[skill] || 0) / 100) * 10) / 10;

/**
 * What someone could do ashore on a world: [{ id, label, cost, why? }]
 * ('leave' always; a course in each skill the world teaches, when one is
 * due; the hospital if there is harm it can mend; retirement if asked).
 */
export function errandsFor(state, m, world) {
  const g = groundOf(world), now = state.clock.minute;
  const out = [{ id: 'leave', label: homeOfWorld(world) === m.home ? 'leave, at home' : 'leave', cost: 0 }];
  if (!g) return out;
  for (const k of g.courses) {
    const wait = nextCourse(m) - now;
    out.push({ id: `course:${k}`, label: `course · ${k} +${courseGain(m, k)}`, cost: COURSE_COST, why: wait > 0 ? `a course every ${COURSE_DAYS} days: the next in ${Math.ceil(wait / DAY_MIN)}` : null });
  }
  const t = treatmentFor(m, world);
  if (t) out.push({ id: 'hospital', label: t.text, cost: t.cost, why: t.untreatable && !t.cost ? 'brain damage wants a big world\'s hospital' : null });
  if (m.retire && m.role !== 'Captain') out.push({ id: 'retire', label: homeOfWorld(world) === m.home ? 'retire, at home' : 'retire here', cost: 0 });
  return out;
}

/** An errand's cost on landing (MCR), or 0. */
export function errandCost(state, m, errand, world) {
  return errandsFor(state, m, world).find(e => e.id === errand && !e.why)?.cost || 0;
}

/**
 * Someone's errand done, back aboard with the shuttle (shuttles.js recover):
 * the course's skill and experience, the hospital's mending. Leave is
 * crew-services.js restedAshore (called for every errand but these, as
 * a run ashore's rest comes with any day on a world's ground).
 */
export function finishErrand(state, m, errand, world) {
  const now = state.clock.minute, g = groundOf(world);
  if (!g || !errand || errand === 'leave') return;
  if (errand.startsWith('course:')) {
    const skill = errand.slice(7);
    const gain = courseGain(m, skill);
    m.skills[skill] = Math.min(100, m.skills[skill] + gain);
    m.xp = (m.xp || 0) + COURSE_XP;
    m.lastCourse = now;
    note(m, now, `A course in ${skill} at ${g.academy}, ${world} (+${gain})`);
    return;
  }
  if (errand === 'hospital') {
    const t = treatmentFor(m, world);
    if (!t) return;
    hospitalCure(m, g.hospital === 'full' ? 'full' : 'clinic');
    note(m, now, t.brain ? `Brain damage mended at a ${world} hospital` : `Treated at ${world}'s ${g.hospital === 'full' ? 'hospital' : 'clinic'}`);
  }
}

/** Retiring on a world's ground (the errand): off the ship there, from the pad. */
export function retireOnWorld(state, m, world, emit = () => {}) {
  const home = homeOfWorld(world) === m.home;
  return signOffAway(state, m, home ? `retired home to ${world}` : `retired on ${world}`, { cheer: home ? 5 : 3, emit,
    text: `${fullName(m)} signs off on ${world} and retires at ${Math.floor(ageOf(m, state.clock.minute))}${home ? ', home at last' : ''}.` });
}

/**
 * A spaceport's hall today, for the world (drawn once a game day, kept on
 * the state: state.ground.halls). The big worlds' hands come better trained.
 */
export function groundHall(state, world) {
  const g = groundOf(world);
  if (!g) return [];
  const halls = ((state.ground ||= { halls: {} }).halls ||= {});
  const day = Math.floor(state.clock.minute / DAY_MIN);
  if (halls[world]?.day !== day) halls[world] = { day, people: drawHall(state, g.hall, { quality: g.quality, home: homeOfWorld(world), at: `${world} spaceport` }) };
  return halls[world].people;
}
