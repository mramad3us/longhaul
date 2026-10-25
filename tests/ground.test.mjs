// ============================================================
// LONGHAUL — Tests: a world's ground (sim/ground.js)
//
// What a settled world has for a crew that a station hasn't, by shuttle:
// a run ashore where each who goes does one thing (leave, a course at an
// academy, the hospital, retiring), paid on landing and done when they
// are home; the hurt riding down as patients; the spaceport's hall,
// hands signed on at the pad who ride up in the seats left free.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { DAY_MIN } from '../js/core/constants.js';
import { createGame, advance } from '../js/sim/game.js';
import { releaseHold, holdStation } from '../js/sim/autopilot.js';
import { parkingTarget, targetStateAt } from '../js/sim/nav.js';
import { worldOf, airspacesOf } from '../js/sim/worlds.js';
import { planRun, launchRun, activeRuns, abortRun, shuttleCrew, shuttlePatients, seatsOf } from '../js/sim/shuttles.js';
import { GROUND, COURSE_COST, COURSE_DAYS, NEURAL_COST, errandsFor, treatmentFor, groundHall, courseGain } from '../js/sim/ground.js';
import { LEAVE_COST } from '../js/sim/crew-services.js';
import { YEAR_MIN } from '../js/sim/careers.js';
import { addCondition, hasCondition, isAble } from '../js/sim/crew.js';

/** A game with our ship held on a world's parking orbit (no traffic), a pinnace in its bay. */
function inOrbit(name, { seed = 5, crewCount = 6 } = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount, traffic: 0, forces: false, docked: false, classId: 'ares' });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  s.resources.credits.current = 50_000;
  releaseHold(s); s.dock = null;
  const tgt = parkingTarget(s, name, s.clock.minute);
  const st = targetStateAt(s, tgt, s.clock.minute);
  s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel };
  holdStation(s, tgt);
  advance(s, 2);
  return s;
}
function flyRun(s, run, limit = 2 * DAY_MIN) {
  let t = 0;
  while (activeRuns(s).includes(run) && t < limit) { advance(s, 1); t++; }
  return t;
}
const pad = (world) => airspacesOf(worldOf(world))[0];

export default [
  {
    name: 'what the ground has: courses by world (Earth all four, the moons what they live by), hospitals that mend brain damage on the big worlds, clinics on the moons, a hall at every settled world',
    fn: () => {
      const s = inOrbit('Mars');
      const m = shuttleCrew(s)[1];
      const courses = (w) => errandsFor(s, m, w).filter(e => e.id.startsWith('course:')).map(e => e.id.slice(7));
      assert(courses('Earth').length === 4 && courses('Europa').length === 1, `Earth ${courses('Earth')}, Europa ${courses('Europa')}`);
      assert(!errandsFor(s, m, 'Earth').some(e => e.id === 'hospital'), 'nothing to mend, no hospital offered');
      addCondition(m, 'brain-damage'); m.body.head = 60;
      const big = treatmentFor(m, 'Mars'), small = treatmentFor(m, 'Titan');
      assert(big.brain && big.cost >= NEURAL_COST, `Mars mends brain damage: ${big.cost} MCR`);
      assert(!small.brain && small.untreatable, `Titan's clinic can't: ${small.text}`);
      for (const w of Object.keys(GROUND)) assert(groundHall(s, w).length === GROUND[w].hall, `${w}'s hall`);
      const best = (w) => groundHall(s, w).reduce((a, p) => a + Math.max(...Object.values(p.skills)), 0) / GROUND[w].hall;
      console.log(`      courses: Earth ${courses('Earth').join(', ')} · Mars ${courses('Mars').join(', ')} · Europa ${courses('Europa')}; brain damage at Mars ${big.cost} MCR, Titan can't; halls' best skill: Earth ${fmt(best('Earth'), 0)}, Europa ${fmt(best('Europa'), 0)}`);
    },
  },
  {
    name: 'a run ashore with errands: a course raises the skill, the hospital mends brain damage, leave rests the rest; paid on landing; a course every sixty days',
    fn: () => {
      const s = inOrbit('Mars');
      const a = pad('Mars');
      const [pilot, student, patient] = shuttleCrew(s);
      addCondition(patient, 'brain-damage'); patient.body.head = 55; patient.consciousness = 50;
      const skill0 = student.skills.engineering, gain = courseGain(student, 'engineering');
      const bill = treatmentFor(patient, 'Mars').cost;
      const p = planRun(s, s.shuttles.bay[0].id, a.id, { leave: true });
      const credits = s.resources.credits.current;
      const r = launchRun(s, p.plan, () => {}, { crew: { pilot: pilot.id, riders: [student.id, patient.id] }, errands: { [student.id]: 'course:engineering', [patient.id]: 'hospital' } });
      assert(r.ok, r.text);
      flyRun(s, r.run);
      const spent = credits - s.resources.credits.current;
      assert(r.run.phase === 'done' && spent === 3 * LEAVE_COST + COURSE_COST + bill, `paid ${spent}: leave ×3, a course, the hospital (${bill})`);
      assert(Math.abs(student.skills.engineering - skill0 - gain) < 0.01 && student.lastCourse != null, `the course: engineering ${fmt(skill0, 1)} → ${fmt(student.skills.engineering, 1)}`);
      assert(!hasCondition(patient, 'brain-damage') && patient.body.head === 100 && patient.consciousness >= 90, 'the brain damage mended');
      assert(pilot.lastLeave === s.clock.minute || s.clock.minute - pilot.lastLeave < DAY_MIN, 'the pilot on leave');
      const again = errandsFor(s, student, 'Mars').find(e => e.id === 'course:engineering');
      assert(again.why, `another course waits: ${again.why}`);
      console.log(`      ${spent} MCR: three ashore, ${student.name} +${gain} engineering, ${patient.name}'s brain damage mended (${bill}); the next course in ${COURSE_DAYS} days`);
    },
  },
  {
    name: 'the hurt ride down as patients (for the hospital, never to fly; not the critical); a treatment called in off the pad is refunded',
    fn: () => {
      const s = inOrbit('Mars');
      const a = pad('Mars');
      const [pilot, , , hurt] = shuttleCrew(s);
      hurt.body.torso = 20; hurt.body.leftLeg = 10; hurt.consciousness = 8;          // (past working: not able)
      assert(!isAble(hurt) && shuttlePatients(s, 'Mars').includes(hurt), 'a patient');
      const p = planRun(s, s.shuttles.bay[0].id, a.id, { leave: true });
      const fly = launchRun(s, p.plan, () => {}, { crew: { pilot: hurt.id, riders: [] } });
      assert(!fly.ok, `not to fly: ${fly.text}`);
      const credits = s.resources.credits.current;
      const r = launchRun(s, p.plan, () => {}, { crew: { pilot: pilot.id, riders: [hurt.id] } });
      assert(r.ok && r.run.errands[hurt.id] === 'hospital', `rides down for the hospital: ${r.text}`);
      let t = 0;
      while (r.run.phase !== 'ground' && t++ < DAY_MIN) advance(s, 1);
      advance(s, 30);
      assert(r.run.paid[hurt.id] > 0, 'paid on landing');
      abortRun(s, r.run.id);
      flyRun(s, r.run);
      assert(s.resources.credits.current === credits - 2 * LEAVE_COST, `called in: the treatment refunded, the leave not (${credits - s.resources.credits.current} spent)`);
      assert(hurt.body.torso < 100, 'and not treated');
      const crit = shuttleCrew(s)[2];
      crit.conditions.push('critical');
      assert(!shuttlePatients(s, 'Mars').includes(crit), 'the critical are stabilized aboard first');
    },
  },
  {
    name: 'the spaceport\'s hall: hands signed on at the pad (the fee paid on landing) ride up in the seats left free and come aboard with the shuttle',
    fn: () => {
      const s = inOrbit('Earth', { crewCount: 4 });
      const a = pad('Earth');
      const hall = groundHall(s, 'Earth');
      const want = [hall[0], hall[1]];
      const p = planRun(s, s.shuttles.bay[0].id, a.id, {});
      const n0 = s.ship.crew.length, credits = s.resources.credits.current;
      const r = launchRun(s, p.plan, () => {}, { crew: { pilot: shuttleCrew(s)[0].id }, hires: [0, 1] });
      assert(r.ok && groundHall(s, 'Earth').length === hall.length, `launched, two to sign on: ${r.text}`);
      flyRun(s, r.run);
      const added = s.ship.crew.slice(n0);
      assert(added.length === 2 && added.every(m => !m.away && want.some(p => p.name === m.name)), `aboard: ${added.map(m => m.name)}`);
      assert(credits - s.resources.credits.current === want[0].fee + want[1].fee, 'their fees paid');
      assert(added.every(m => m.record.at(-1).text.includes('Earth')), 'signed on at Earth, on their records');
      // more than the seats left free: refused
      const seats = seatsOf(s.shuttles.bay[0].cls);
      const riders = shuttleCrew(s).slice(1, 1 + seats).map(m => m.id);
      const p2 = planRun(s, s.shuttles.bay[0].id, a.id, {});
      const no = launchRun(s, p2.plan, () => {}, { crew: { pilot: shuttleCrew(s)[0].id, riders }, hires: [0] });
      assert(!no.ok || riders.length < seats, `no seat for the way up: ${no.text}`);
      console.log(`      ${added.map(m => `${m.given} ${m.name} (${m.role}, ${Math.round(Math.max(...Object.values(m.skills)))})`).join(', ')} up from ${a.port.name}`);
    },
  },
  {
    name: 'retiring on a world: a hand who asked signs off on the pad (at home, the better send-off), their seat free for the way up',
    fn: () => {
      const s = inOrbit('Mars');
      const a = pad('Mars');
      const [pilot, old] = shuttleCrew(s);
      old.home = 'Mars';
      old.born = s.clock.minute - (old.retireAt + 1) * YEAR_MIN;
      old.retire = { at: s.clock.minute };
      const opt = errandsFor(s, old, 'Mars').find(e => e.id === 'retire');
      assert(opt && /home/.test(opt.label), `offered: ${opt?.label}`);
      for (const m of s.ship.crew) m.moraleMod = 0;
      const p = planRun(s, s.shuttles.bay[0].id, a.id, { leave: true });
      const r = launchRun(s, p.plan, () => {}, { crew: { pilot: pilot.id, riders: [old.id] }, errands: { [old.id]: 'retire' } });
      assert(r.ok, r.text);
      let t = 0;
      while (r.run.phase !== 'ground' && t++ < DAY_MIN) advance(s, 1);
      advance(s, 2);
      assert(!s.ship.crew.includes(old) && s.ship.alumni.some(x => x.name === old.name && /home to Mars/.test(x.why)), 'retired home to Mars, from the pad');
      assert(s.ship.crew.filter(m => m !== pilot && !m.dead).every(m => m.moraleMod >= 4.5), 'the crew aboard cheered for them');
      flyRun(s, r.run);
      assert(r.run.phase === 'done' && !r.run.crew.includes(old.id), 'the shuttle home without them');
      console.log(`      ${old.name} (${Math.floor((s.clock.minute - old.born) / YEAR_MIN)}) retired home to Mars from ${a.port.name}`);
    },
  },
];
