// ============================================================
// LONGHAUL — Tests: careers (sim/careers.js)
//
// A crew's lives beyond the watch bill: ages by role, homes, ranks their
// skill and years have earned, experience and promotion, a month's pay by
// rank (back pay owed when the credits run short), cabin fever and a run
// ashore worth more on a world's ground and most at home, retirement
// asked for and granted or refused, a hand who has had enough signing
// off, natural causes, a captain succeeded, the memorial; morale setting
// how well people work; an old crew given careers on load.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { seedRandom, random } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { DAY_MIN } from '../js/core/constants.js';
import { createGame, advance, upgradeState } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import {
  YEAR_MIN, RANK_XP, RANK_SKILL, WAGE, PAY_DAYS, CABIN_FEVER_DAYS, QUIT_MORALE, ageOf, rankTitle, wageOf, promotionDue, promote,
  grantRetirement, askToStay, payDay, payroll, naturalHazard, careerDraw, startCareer,
} from '../js/sim/careers.js';
import { restedAshore, shoreLeave } from '../js/sim/crew-services.js';
import { efficiency, moraleFactor } from '../js/sim/needs.js';
import { extendLease } from '../js/sim/leases.js';

/** A game docked at its home port, quiet, its events collected. */
function game(seed = 3, crewCount = 6) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount, traffic: 0, forces: false, shipName: 'Careers', captainName: 'Ahn' });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  s.resources.credits.current = 1e7;
  extendLease(s, 24);
  if (s.dock?.lease) s.dock.lease.until = 1e12;   // (in port for the length of a test: the berth ours, however long)
  const events = [];
  const emit = (t, p) => events.push({ t, p });
  return { s, events, emit };
}
/** Run to `minute` (whole days are seen to at the day's CAREER minute). */
const runDays = (s, days) => advance(s, Math.round(days * DAY_MIN));

export default [
  {
    name: 'a crew signs on with lives: ages by role, homes and given names, ranks their skill and years have earned, the age they mean to stop at; the main random stream left alone',
    fn: () => {
      const { s } = game();
      const rows = s.ship.crew.map(m => {
        const age = ageOf(m, 0);
        assert(age >= 18 && age < 56, `${m.name}: age ${fmt(age, 1)}`);
        assert(m.home && (m.given || m.role === 'Captain') && m.retireAt >= 58 && m.retireAt <= 70, `${m.name}: home ${m.home}, ${m.given}, retires at ${m.retireAt}`);
        assert(m.role === 'Captain' ? m.rank === 4 : m.rank >= 0 && m.rank <= 4, `${m.name}: rank ${m.rank}`);
        if (m.role !== 'Captain') assert(m.rank === 0 || (m.xp >= RANK_XP[m.rank]), `${m.name}: the experience for ${rankTitle(m)}`);
        return `${m.given ? `${m.given} ` : ''}${m.name} (${m.role}, ${rankTitle(m)}, ${Math.floor(age)}, ${m.home}, ${wageOf(m)} MCR)`;
      });
      // the careers draw on their own: a game made with them leaves the main stream where it would be
      seedRandom(3); bus.clear();
      createGame({ crewCount: 6, traffic: 0, forces: false, shipName: 'Careers', captainName: 'Ahn' });
      const a = random();
      seedRandom(3); bus.clear();
      createGame({ crewCount: 6, traffic: 0, forces: false, shipName: 'Other name', captainName: 'Ahn' });
      assert(random() === a, 'the main stream untouched by the careers (another ship, other ages, the same world)');
      console.log(`      ${rows.join('\n      ')}\n      payroll ${payroll(s)} MCR a month`);
    },
  },
  {
    name: 'experience and promotion: an hour of work is a point; due when the experience and the skill are there; the captain promotes (morale, pay); one left due sours',
    fn: () => {
      const { s, events, emit } = game();
      const m = s.ship.crew.find(x => x.role === 'Engineer');
      m.rank = 1; m.xp = RANK_XP[2] - 0.5; m.skills.engineering = RANK_SKILL[2] + 5; m.due = null;
      // (half an hour of practice tips it over)
      for (let i = 0; i < 31; i++) m.xp += 1 / 60;
      assert(promotionDue(m)?.rank === 2, `due for ${promotionDue(m)?.title}`);
      const wage0 = wageOf(m), mood0 = m.moraleMod || 0;
      const r = promote(s, m.id, emit);
      assert(r.ok && m.rank === 2 && wageOf(m) > wage0 && m.moraleMod >= mood0 + 12 && m.record.at(-1).text.includes('Promoted'), r.text);
      assert(events.some(e => e.t === 'crew-promoted'), 'the promotion is news');
      // due and left: after a month passed over, it weighs on them
      m.xp = RANK_XP[3]; m.skills.engineering = RANK_SKILL[3] + 1;
      m.due = null;
      runDays(s, 50);
      assert(m.due != null && m.careerMood < 0, `passed over for ${fmt((s.clock.minute - m.due) / DAY_MIN, 0)} days: careerMood ${m.careerMood}`);
      console.log(`      ${m.name}: ${r.text} Passed over since: careerMood ${m.careerMood}`);
    },
  },
  {
    name: 'pay day: a month\'s wages by rank out of the credits; short, what there is and the rest owed (back pay first next time), and owing weighs on them',
    fn: () => {
      const { s, events, emit } = game();
      const bill = payroll(s);
      s.resources.credits.current = bill * 3;
      const r = payDay(s, emit);
      assert(r.paid === bill && r.short === 0 && s.resources.credits.current === bill * 2, `paid ${r.paid} of ${bill}`);
      s.resources.credits.current = Math.round(bill / 2);
      const r2 = payDay(s, emit);
      assert(r2.short > 0 && s.resources.credits.current === 0 && events.some(e => e.t === 'crew-unpaid'), `short: ${r2.short} owed`);
      const owedNow = s.ship.crew.reduce((a, m) => a + (m.owed || 0), 0);
      runDays(s, 1);
      assert(s.ship.crew.some(m => m.owed > 0 && m.careerMood < 0), 'owed money weighs on them');
      s.resources.credits.current = bill * 4;
      payDay(s, emit);
      assert(s.ship.crew.every(m => !(m.owed > 0)) && s.resources.credits.current === bill * 4 - owedNow - bill, 'back pay settled first, with the month');
      // pay comes round every PAY_DAYS
      const { s: s2, events: ev2 } = game(5);
      s2.resources.credits.current = 1e6;
      bus.on('crew-payday', (p) => ev2.push({ t: 'crew-payday', p }));
      runDays(s2, PAY_DAYS + 1);
      assert(s2.resources.credits.current < 1e6, 'a month in, the crew are paid');
      console.log(`      payroll ${bill} MCR a month; half paid: ${r2.short} owed, then settled`);
    },
  },
  {
    name: 'cabin fever: weeks without a run ashore grind them down; leave lifts them, a world\'s ground more than a station, home most',
    fn: () => {
      const { s } = game();
      const m = s.ship.crew[1];
      m.lastLeave = s.clock.minute - 40 * DAY_MIN;
      runDays(s, 1);
      assert(m.careerMood <= -(40 - CABIN_FEVER_DAYS) * 0.4 + 0.5, `40 days out: careerMood ${m.careerMood}`);
      const lift = (where, home) => { const x = { ...m, needs: { ...m.needs }, moraleMod: 0, home }; restedAshore(x, s.clock.minute, where); return x.moraleMod; };
      const station = lift({ station: 'Ceres' }, 'Earth'), world = lift({ world: 'Mars' }, 'Earth'), home = lift({ world: 'Mars' }, 'Mars'), belt = lift({ station: 'Ceres' }, 'Belt');
      assert(station < world && world < home && belt === home, `a run ashore: station ${station}, a world ${world}, home ${home} (a Belter at Ceres ${belt})`);
      // a real run ashore at the port resets the clock
      const r = shoreLeave(s, [m.id], { extend: true });
      assert(r.ok, r.text);
      runDays(s, 0.5);
      assert(!m.away && s.clock.minute - m.lastLeave < DAY_MIN, 'back from leave, the clock reset');
      console.log(`      40 days out: ${m.careerMood}; ashore: station +${station}, a world's ground +${world}, home +${home}`);
    },
  },
  {
    name: 'retirement: past the age they meant to stop at they ask; granted, they sign off in port with a send-off; asked to stay, they do, put out, and ask again; five years on they go regardless',
    fn: () => {
      const { s, events } = game();
      bus.on('crew-retire-request', (p) => events.push({ t: 'ask', p }));
      bus.on('crew-signed-off', (p) => events.push({ t: 'off', p }));
      const m = s.ship.crew[2], n = s.ship.crew[3];
      m.born = s.clock.minute - (m.retireAt + 0.1) * YEAR_MIN;
      n.born = s.clock.minute - (n.retireAt + 0.1) * YEAR_MIN;
      runDays(s, 1);
      assert(m.retire && n.retire && events.filter(e => e.t === 'ask').length >= 2, 'both ask to retire');
      grantRetirement(s, m.id);
      const stay = askToStay(s, n.id);
      assert(stay.ok && n.retire.refused != null, stay.text);
      advance(s, 2);
      assert(!s.ship.crew.includes(m) && s.ship.alumni.some(a => a.name === m.name && a.why === 'retired') && events.some(e => e.t === 'off'), `${m.name} retired in port`);
      assert(s.ship.crew.includes(n), `${n.name} stays`);
      runDays(s, 95);
      assert(events.filter(e => e.t === 'ask' && e.p.member === n).length >= 2, 'and asks again three months on');
      n.born = s.clock.minute - (n.retireAt + 5.05) * YEAR_MIN;
      runDays(s, 1.2);
      assert(!s.ship.crew.includes(n), `${n.name} goes regardless, five years past`);
      console.log(`      ${events.filter(e => e.t === 'off').map(e => e.p.text).join(' · ')}`);
    },
  },
  {
    name: 'a hand miserable for a week means to go, and signs off at the next port unless things look up',
    fn: () => {
      const { s } = game();
      const m = s.ship.crew[4];
      const pin = () => { m.morale = QUIT_MORALE - 5; m.moraleMod = -100; };
      for (let d = 0; d < 9; d++) { pin(); runDays(s, 1); }
      assert(!s.ship.crew.includes(m) || m.quit, `${m.name} means to sign off`);
      assert(!s.ship.crew.includes(m), 'docked: they have gone ashore for good');
      assert(s.ship.alumni.some(a => a.name === m.name && a.why === 'quit'), 'on the list of those who left');
    },
  },
  {
    name: 'natural causes take the old; the crew mourn; the memorial keeps them; a captain who dies is succeeded by the senior officer aboard',
    fn: () => {
      assert(naturalHazard(30) < 0.001 && naturalHazard(60) > 0.01 && naturalHazard(70) > 0.03, `hazard a year: 30 ${fmt(naturalHazard(30), 4)}, 60 ${fmt(naturalHazard(60), 3)}, 70 ${fmt(naturalHazard(70), 3)}`);
      const { s, events } = game();
      bus.on('crew-command', (p) => events.push({ t: 'command', p }));
      const cap = s.ship.crew.find(m => m.role === 'Captain');
      cap.born = s.clock.minute - 220 * YEAR_MIN;          // (certain, the first night)
      runDays(s, 1.1);
      assert(cap.dead && s.ship.memorial.some(x => x.name === cap.name && /natural causes/.test(x.cause)), 'the captain dies of natural causes and is remembered');
      const next = s.ship.crew.find(m => m.role === 'Captain' && !m.dead);
      advance(s, 3);
      assert(next && events.filter(e => e.t === 'command').length === 1 && s.ship.crew.filter(m => m.role === 'Captain' && !m.dead).length === 1, `${next?.name} takes command, and only they`);
      assert(s.ship.crew.filter(m => !m.dead && m !== next).every(m => m.moraleMod < 0), 'the crew mourn');
      // a death another way is remembered too (once)
      const lost = s.ship.crew.find(m => !m.dead && m.role !== 'Captain');
      lost.dead = true; lost.deathCause = 'killed when the hull was hit';
      advance(s, 2);
      assert(s.ship.memorial.filter(x => x.name === lost.name).length === 1, 'any death is remembered, once');
      console.log(`      ${s.ship.memorial.map(x => `${x.name} (${x.rank}): ${x.cause}`).join(' · ')}; ${next.name} in command`);
    },
  },
  {
    name: 'morale sets how well they work: a bonus when it is high, a heavy cost when it is low',
    fn: () => {
      assert(moraleFactor(100) > 1.07 && moraleFactor(60) === 1 && moraleFactor(30) < 0.85 && moraleFactor(0) <= 0.56, `factors: 100 ${fmt(moraleFactor(100), 2)}, 60 ${moraleFactor(60)}, 30 ${fmt(moraleFactor(30), 2)}, 0 ${fmt(moraleFactor(0), 2)}`);
      const { s } = game();
      const m = s.ship.crew[1];
      m.needs = { rest: 90, food: 90, hygiene: 90, fun: 90 };
      m.morale = 95; const hi = efficiency(m);
      m.morale = 20; const lo = efficiency(m);
      assert(hi > 1 && lo < 0.75, `efficiency: in good heart ${fmt(hi, 2)}, sour ${fmt(lo, 2)}`);
      console.log(`      efficiency: morale 95 → ${fmt(hi, 2)}, 20 → ${fmt(lo, 2)}`);
    },
  },
  {
    name: 'careers are saved and loaded; an old crew without them gets them on load',
    fn: () => {
      const { s } = game();
      const m = s.ship.crew[1];
      m.xp = 321; m.owed = 50; m.record.push({ at: 1, text: 'x' });
      const back = deserialize(serialize(s)).state.ship.crew[1];
      assert(back.xp === 321 && back.owed === 50 && back.born === m.born && back.home === m.home && back.record.length === m.record.length, 'kept through a save');
      for (const x of s.ship.crew) { delete x.born; delete x.rank; delete x.xp; delete x.home; delete x.retireAt; }
      delete s.ship.memorial;
      upgradeState(s);
      assert(s.ship.crew.every(x => x.born != null && x.rank != null && x.home) && Array.isArray(s.ship.memorial), 'an old crew given careers');
    },
  },
];
