// ============================================================
// LONGHAUL — Careers: a crew's lives beyond the watch bill
//
// Every hand aboard has a life that runs longer than a watch, and the
// game is long enough for it to show:
//
//   AGE        a birthday (born: a game minute, years before the game
//              began), older as the game runs. Past fifty the body's
//              quickness goes, a little a year (piloting and security
//              drift down; engineering and medicine, which are knowing,
//              hold); natural causes take a few each year from sixty on
//              (a Gompertz hazard: 1 in 1,700 a year at 30, 1 in 75 at 60,
//              1 in 26 at 70). A birthday aboard is a small lift.
//   HOME       where they are from (Earth, Mars, Luna, the Belt, the
//              Jovian or Saturnian moons): a run ashore there is worth more.
//   RANK       five steps in their department (RANKS: the helm's Cadet to
//              Master Pilot, the engine room's Wiper to Chief Engineer, the
//              medical bay's, the guns', the science, the galley's, the
//              deck's), earned by EXPERIENCE (an hour of real work is a
//              point, practice() in needs.js; a repair done, a life saved,
//              a boarding, a fight come through, a run flown, more) and the
//              skill for the next step (RANK_XP, RANK_SKILL). The captain
//              promotes (PROMOTE): the promoted are the happier for it, and
//              draw more pay; one left due for a month sours.
//   PAY        a month's wage by rank and role (WAGE, ROLE_PAY), out of the
//              ship's credits every thirty days. Short, they are paid what
//              there is and owed the rest (back pay, first out of the next
//              pay day); owed money weighs on them until it is paid. The
//              captain takes the ship's profit, not a wage.
//   LEAVE      weeks without a run ashore grind them down (cabin fever,
//              from CABIN_FEVER_DAYS out); a run ashore at a station lifts
//              them, one on a world's ground under a sky lifts them more,
//              one at home most (crew-services.js restedAshore).
//   RECORD     what each has done (signed on, promoted, wounded, took
//              command…), the last dozen kept; the ship keeps a memorial of
//              those it lost and a list of those who left it.
//   THE END    each has an age they mean to stop at (58–70): past it they
//              ask to sign off at the next port. Granted, they go ashore
//              there with their pay, a send-off the crew enjoys; asked to
//              stay, they stay, put out, and ask again in three months, and
//              five years past it they go regardless. One miserable for a
//              week (morale under QUIT_MORALE) means to sign off at the next
//              port, unless things look up first. A captain who dies is
//              succeeded by the senior officer aboard.
//
// Morale beyond the needs (needs.js moraleTarget) is the sum of what is
// owed them, cabin fever and a promotion overdue (careerMood, worked out
// daily); morale in turn sets how well they work (needs.js efficiency:
// a bonus when it is high, a heavy cost when it is low).
//
// Daily work only (CAREER_MIN into each day), and pay days; nothing here
// is per-entity in the world. Its chances (ages, homes, names, the years
// they mean to serve, natural causes) come from a generator of its own,
// kept with the ship (careerRng: rng.js nextOf), so the main stream and
// every test seeded on it are left alone.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { nextOf, seedOf } from '../core/rng.js';

export const YEAR_MIN = 365 * DAY_MIN;
const CAREER_MIN = 300;                       // the minute of each day the careers are seen to
export const PAY_DAYS = 30;
export const CABIN_FEVER_DAYS = 21;
const PASSED_OVER_DAYS = 30;
export const QUIT_MORALE = 15;
const QUIT_DAYS = 7;
const RETIRE_ASK_AGAIN_DAYS = 90;
const RETIRE_INSIST_YEARS = 5;
const RECORD_MAX = 12;
const MEMORIAL_MAX = 40;

/** Ranks by department, five steps each. */
export const RANKS = {
  helm: ['Cadet Pilot', 'Third Mate', 'Second Mate', 'First Mate', 'Master Pilot'],
  engine: ['Wiper', 'Engine Hand', 'Third Engineer', 'Second Engineer', 'Chief Engineer'],
  medical: ['Orderly', 'Medic', 'Senior Medic', 'Ship\'s Doctor', 'Chief Surgeon'],
  arms: ['Rating', 'Able Rating', 'Leading Hand', 'Petty Officer', 'Chief Petty Officer'],
  science: ['Technician', 'Analyst', 'Senior Analyst', 'Science Officer', 'Chief Scientist'],
  galley: ['Mess Hand', 'Cook', 'Senior Cook', 'Steward', 'Chief Steward'],
  deck: ['Deckhand', 'Able Spacer', 'Leading Spacer', 'Bosun\'s Mate', 'Bosun'],
};
const DEPT = { Pilot: 'helm', Engineer: 'engine', Mechanic: 'engine', Medic: 'medical', Gunner: 'arms', Security: 'arms', Scientist: 'science', Cook: 'galley', Deckhand: 'deck' };
const DEPT_SKILL = { helm: 'piloting', engine: 'engineering', medical: 'medical', arms: 'security', science: 'medical', galley: 'medical', deck: 'engineering' };
/** Experience (hours of real work, and more for what it brought) and skill each step takes. */
export const RANK_XP = [0, 150, 450, 1100, 2400];
export const RANK_SKILL = [0, 40, 55, 70, 82];
/** A month's wage (MCR) by rank, and by role against it. */
export const WAGE = [150, 210, 290, 400, 560];
const ROLE_PAY = { Pilot: 1.2, Engineer: 1.2, Medic: 1.15, Scientist: 1.1, Gunner: 1, Security: 1, Mechanic: 1, Cook: 0.85, Deckhand: 0.8 };

/** Where people come from, how often, and the names they carry. */
const HOMES = [['Earth', 30], ['Mars', 24], ['Belt', 30], ['Luna', 7], ['Jovian', 6], ['Saturnian', 3]];
const GIVEN = {
  Earth: ['Amara', 'Wei', 'Priya', 'Mateo', 'Sofia', 'Kwame', 'Hana', 'Omar', 'Elena', 'Jonas', 'Aiko', 'Diego', 'Leila', 'Tomas', 'Nia', 'Ravi', 'Ines', 'Kofi', 'Mei', 'Arjun'],
  Mars: ['Bobbie', 'Ares', 'Solveig', 'Tariq', 'Ilse', 'Cyrus', 'Noor', 'Anders', 'Dara', 'Lucan', 'Vesna', 'Kai', 'Mira', 'Orin', 'Thea', 'Rook'],
  Belt: ['Naomi', 'Diogo', 'Camina', 'Anton', 'Kima', 'Bez', 'Oksana', 'Fen', 'Sadavir', 'Pash', 'Lio', 'Marco', 'Yanz', 'Ochi', 'Tilly', 'Ren'],
  Luna: ['Selene', 'Yuri', 'Imani', 'Hal', 'Rhea', 'Ezra', 'Lin', 'Cass'],
  Jovian: ['Io', 'Callum', 'Europa', 'Gan', 'Ama', 'Bram', 'Sela', 'Dov'],
  Saturnian: ['Titania', 'Enzo', 'Rhea', 'Mimo', 'Hyperion', 'Lark'],
};
/** The stations' bodies as homes (a station of the Belt is home to a Belter). */
const STATION_HOME = { Ceres: 'Belt', Pallas: 'Belt', Vesta: 'Belt', Hygiea: 'Belt', Juno: 'Belt', Luna: 'Luna', Phobos: 'Mars', Ganymede: 'Jovian' };
/** A world's ground as a home. */
const WORLD_HOME = { Earth: 'Earth', Mars: 'Mars', Luna: 'Luna', Europa: 'Jovian', Ganymede: 'Jovian', Callisto: 'Jovian', Titan: 'Saturnian' };

const AGE_BY_ROLE = { Captain: [32, 52], Pilot: [23, 50], Engineer: [24, 52], Medic: [26, 54], Scientist: [25, 52], Gunner: [21, 45], Security: [21, 46], Mechanic: [21, 48], Cook: [19, 50], Deckhand: [18, 38] };

/** The careers' own draw, kept with the ship (seeded once from its name and its people's). */
export function careerDraw(ship) {
  if (ship.careerRng == null) ship.careerRng = seedOf(`careers:${ship.name || ''}:${(ship.crew || []).map(m => m.name).join(',')}`);
  return () => nextOf(ship, 'careerRng');
}

export const deptOf = (m) => DEPT[m.role] || 'deck';
export const fullName = (m) => m.given ? `${m.given} ${m.name}` : m.name;
export const rankTitle = (m) => m.role === 'Captain' ? 'Captain' : RANKS[deptOf(m)][Math.max(0, Math.min(4, m.rank || 0))];
export const ageOf = (m, minute) => Math.max(0, (minute - (m.born ?? minute - 30 * YEAR_MIN)) / YEAR_MIN);
export const wageOf = (m) => m.role === 'Captain' ? 0 : Math.round(WAGE[Math.max(0, Math.min(4, m.rank || 0))] * (ROLE_PAY[m.role] || 1) / 10) * 10;
const deptSkill = (m) => m.skills?.[DEPT_SKILL[deptOf(m)]] || 0;
/** Gompertz: natural causes, per year of life, at an age. */
export const naturalHazard = (age) => 0.00005 * Math.exp(0.095 * age);

/**
 * A career for a new hand (or the crew a game starts with): an age by
 * role, a home, a rank their skill and years have earned, the experience
 * behind it, an age they mean to stop at, a full name.
 */
export function startCareer(m, minute, { draw, home = null }) {
  const [a0, a1] = AGE_BY_ROLE[m.role] || [20, 45];
  const age = a0 + draw() * (a1 - a0);
  m.born = Math.round(minute - age * YEAR_MIN);
  if (!home) { let r = draw() * HOMES.reduce((s, h) => s + h[1], 0); for (const h of HOMES) { r -= h[1]; if (r <= 0) { home = h[0]; break; } } }
  m.home = home || 'Earth';
  const given = GIVEN[m.home] || GIVEN.Earth;
  // (the captain's name is the player's own, given as they typed it)
  m.given = m.role === 'Captain' ? null : given[Math.floor(draw() * given.length)];
  const sk = deptSkill(m);
  let r = 0;
  for (let k = 1; k <= 4; k++) if (sk >= RANK_SKILL[k] && age >= 21 + 5 * k) r = k;
  m.rank = m.role === 'Captain' ? 4 : r;
  m.xp = RANK_XP[m.rank] + draw() * ((RANK_XP[Math.min(4, m.rank + 1)] - RANK_XP[m.rank]) || 400) * 0.6;
  m.retireAt = 58 + Math.floor(draw() * 13);
  m.joined = minute;
  m.lastLeave = minute;
  m.owed = 0;
  m.careerMood = 0;
  m.record = [];
  return m;
}

/** A line on someone's record (the last RECORD_MAX kept). */
export function note(m, minute, text) {
  (m.record ||= []).push({ at: minute, text });
  if (m.record.length > RECORD_MAX) m.record.shift();
}

/** Experience for something done: what it brought, beyond the hours. */
export function award(m, xp) {
  if (!m || m.dead) return;
  m.xp = (m.xp || 0) + xp;
}

/** The next step up, if their experience and skill are there for it (null: none, or the top). */
export function promotionDue(m) {
  if (m.dead || m.role === 'Captain' || (m.rank ?? 0) >= 4) return null;
  const next = (m.rank ?? 0) + 1;
  if ((m.xp || 0) < RANK_XP[next] || deptSkill(m) < RANK_SKILL[next]) return null;
  return { rank: next, title: RANKS[deptOf(m)][next], wage: Math.round(WAGE[next] * (ROLE_PAY[m.role] || 1) / 10) * 10 };
}

/** Promote someone who is due: { ok, text }. */
export function promote(state, id, emit = () => {}) {
  const m = state.ship.crew.find(x => x.id === id);
  const due = m && promotionDue(m);
  if (!due) return { ok: false, text: m ? `${m.name} isn't due a step up yet.` : 'No such hand.' };
  const now = state.clock.minute;
  m.rank = due.rank;
  m.due = null;
  m.moraleMod = (m.moraleMod || 0) + 12;
  note(m, now, `Promoted ${due.title}`);
  const text = `${fullName(m)} is made ${due.title} (${due.wage} MCR a month).`;
  emit('crew-promoted', { member: m, title: due.title, text });
  return { ok: true, text };
}

/** Grant someone's wish to retire: they sign off at the next port (now, if docked there). */
export function grantRetirement(state, id) {
  const m = state.ship.crew.find(x => x.id === id);
  if (!m?.retire) return { ok: false, text: 'Nobody has asked.' };
  m.retire.granted = true;
  return { ok: true, text: `${m.name} will sign off at the next port, with our thanks.` };
}

/** Ask them to stay on a while: they do, put out, and ask again in three months. */
export function askToStay(state, id) {
  const m = state.ship.crew.find(x => x.id === id);
  if (!m?.retire || m.retire.insist) return { ok: false, text: m?.retire?.insist ? `${m.name} has stayed long enough: they go at the next port.` : 'Nobody has asked.' };
  m.retire.refused = state.clock.minute;
  m.retire.granted = false;
  m.moraleMod = (m.moraleMod || 0) - 8;
  return { ok: true, text: `${m.name} stays on, for now.` };
}

/** Someone back from a run ashore: rested, and how much better for it by where (crew-services.js calls this). */
export function backFromLeave(m, minute, { world = null, station = null } = {}) {
  const home = (world && WORLD_HOME[world] === m.home) || (station && STATION_HOME[station] === m.home);
  m.lastLeave = minute;
  m.moraleMod = (m.moraleMod || 0) + (home ? 20 : world ? 15 : 8);
  return home;
}

// ---- DAILY ----

/**
 * Per minute: the day's careers (once a day, CAREER_MIN in), pay day, and
 * those signing off when we are in port. `port`: the station we are docked
 * at (or null); `signOff(state, m, why)` takes someone off the ship
 * (crew-services.js, which knows the lock and the jobs).
 */
export function careersTick(state, emit, { port = null, signOff = null } = {}) {
  const now = state.clock.minute;
  if (now % DAY_MIN === CAREER_MIN) daily(state, emit);
  if (port && signOff) {
    for (const m of [...state.ship.crew]) {
      if (m.dead || m.away || m.role === 'Captain') continue;
      if (m.retire && (m.retire.granted || m.retire.insist)) signOff(state, m, 'retired', emit);
      else if (m.quit) signOff(state, m, 'quit', emit);
    }
  }
}

function daily(state, emit) {
  const now = state.clock.minute, day = Math.floor(now / DAY_MIN);
  const crew = state.ship.crew;
  const draw = careerDraw(state.ship);
  for (const m of crew) {
    if (m.dead) continue;
    if (m.born == null) startCareer(m, now, { draw });          // (a hand from before careers)
    const age = ageOf(m, now);
    // a year older: the body's quickness goes from fifty, faster past sixty-five
    if (age > 50) {
      const k = (age > 65 ? 2 : 1) * 0.3 / 365;
      m.skills.piloting = Math.max(5, m.skills.piloting - k);
      m.skills.security = Math.max(5, m.skills.security - k);
    }
    // a birthday aboard
    if (Math.floor(age) > Math.floor(ageOf(m, now - DAY_MIN))) {
      m.moraleMod = (m.moraleMod || 0) + 4;
      emit('crew-birthday', { member: m, age: Math.floor(age), text: `${m.name} is ${Math.floor(age)} today.` });
    }
    // natural causes
    if (draw() < naturalHazard(age) / 365) { naturalDeath(state, m, age, emit); continue; }
    if (m.role === 'Captain') continue;
    // a step up due, and how long it has waited
    const due = promotionDue(m);
    if (due && m.due == null) { m.due = now; emit('crew-promotion-due', { member: m, title: due.title, text: `${m.name} has earned a step up: ${due.title}.` }); }
    else if (!due) m.due = null;
    // retirement
    if (age >= m.retireAt) {
      if (!m.retire) { m.retire = { at: now }; emit('crew-retire-request', { member: m, age: Math.floor(age), text: `${m.name} (${Math.floor(age)}) asks to sign off and retire at the next port.` }); }
      else if (m.retire.refused != null && now - m.retire.refused >= RETIRE_ASK_AGAIN_DAYS * DAY_MIN && !m.retire.granted) { m.retire.refused = null; emit('crew-retire-request', { member: m, age: Math.floor(age), text: `${m.name} asks again to retire at the next port.` }); }
      if (age >= m.retireAt + RETIRE_INSIST_YEARS && !m.retire.insist) { m.retire.insist = true; emit('crew-retire-request', { member: m, age: Math.floor(age), insist: true, text: `${m.name} has given the ship enough years: they sign off at the next port.` }); }
    }
    // what weighs on them beyond their needs: money owed, cabin fever, a step up overdue
    const wage = wageOf(m) || 1;
    const sinceLeave = (now - (m.lastLeave ?? now)) / DAY_MIN;
    const fever = sinceLeave > CABIN_FEVER_DAYS ? -Math.min(15, (sinceLeave - CABIN_FEVER_DAYS) * 0.4) : 0;
    const owed = m.owed > 0 ? -Math.min(20, m.owed / wage * 8) : 0;
    const passed = m.due != null && now - m.due > PASSED_OVER_DAYS * DAY_MIN ? -Math.min(10, ((now - m.due) / DAY_MIN - PASSED_OVER_DAYS) / 6) : 0;
    m.careerMood = Math.round((fever + owed + passed) * 10) / 10;
    // a week miserable: they mean to go
    m.lowDays = m.morale < QUIT_MORALE ? (m.lowDays || 0) + 1 : 0;
    if (m.lowDays >= QUIT_DAYS && !m.quit) { m.quit = { at: now }; emit('crew-quit-warning', { member: m, text: `${m.name} has had enough: they mean to sign off at the next port.` }); }
    else if (m.quit && m.morale >= 35) { m.quit = null; emit('crew-quit-relented', { member: m, text: `${m.name} has thought better of signing off.` }); }
  }
  if (day > 0 && day % PAY_DAYS === 0) payDay(state, emit);
}

/** Pay day: back pay first, then the month's, as far as the credits go. */
export function payDay(state, emit = () => {}) {
  const res = state.resources.credits;
  let paid = 0, short = 0;
  const hands = state.ship.crew.filter(m => !m.dead && m.role !== 'Captain').sort((a, b) => (b.owed || 0) - (a.owed || 0));
  for (const m of hands) {
    const due = (m.owed || 0) + wageOf(m);
    const pay = Math.max(0, Math.min(due, res.current));
    res.current -= pay;
    paid += pay;
    m.owed = Math.round(due - pay);
    if (m.owed > 0) { short += m.owed; m.moraleMod = (m.moraleMod || 0) - 6; }
  }
  if (!hands.length) return { paid: 0, short: 0 };
  const text = short > 0 ? `Pay day: ${Math.round(paid).toLocaleString()} MCR paid, ${Math.round(short).toLocaleString()} MCR owed to the crew.` : `Pay day: ${Math.round(paid).toLocaleString()} MCR to the crew.`;
  emit(short > 0 ? 'crew-unpaid' : 'crew-payday', { paid, short, text });
  return { paid, short };
}

/** The month's wages for the crew aboard. */
export const payroll = (state) => state.ship.crew.filter(m => !m.dead && m.role !== 'Captain').reduce((s, m) => s + wageOf(m), 0);

// ---- THE END OF A SERVICE ----

/** Natural causes: a death in the night, the crew in mourning, the memorial, a new captain if it was the captain. */
function naturalDeath(state, m, age, emit) {
  m.dead = true;
  m.diedAt = state.clock.minute;          // (remembered here: game.js's sweep of the dead passes them by)
  m.consciousness = 0; m.heart.bpm = 0; m.conditions = ['dead']; m.task = null; m.path = []; m.activity = 'dead';
  for (const o of state.ship.crew) if (o !== m && !o.dead) o.moraleMod = (o.moraleMod || 0) - 20;
  remember(state, m, `natural causes, at ${Math.floor(age)}`);
  emit('crew-died', { member: m, cause: 'natural causes' });
  if (m.role === 'Captain') succession(state, emit);
}

/** Someone lost to the ship: its memorial keeps them. */
export function remember(state, m, cause) {
  const now = state.clock.minute;
  const list = (state.ship.memorial ||= []);
  if (list.some(x => x.id === m.id && x.name === m.name)) return;
  list.push({ id: m.id, name: m.name, given: m.given || null, role: m.role, rank: rankTitle(m), born: m.born ?? null, died: now, cause, joined: m.joined ?? null });
  if (list.length > MEMORIAL_MAX) list.shift();
}

/** Someone leaving the ship alive: the list of those who served keeps them. */
export function farewell(state, m, why) {
  const list = (state.ship.alumni ||= []);
  list.push({ id: m.id, name: m.name, given: m.given || null, role: m.role, rank: rankTitle(m), left: state.clock.minute, why, joined: m.joined ?? null });
  if (list.length > MEMORIAL_MAX) list.shift();
}

/** The captain gone: the senior officer aboard takes command (the helm's first, then by rank and years). */
export function succession(state, emit = () => {}) {
  const now = state.clock.minute;
  if (state.ship.crew.some(m => !m.dead && m.role === 'Captain')) return null;      // (there is one)
  const able = state.ship.crew.filter(m => !m.dead && m.role !== 'Captain' && m.consciousness > 10);
  if (!able.length) return null;
  able.sort((a, b) => (deptOf(b) === 'helm') - (deptOf(a) === 'helm') || (b.rank || 0) - (a.rank || 0) || (b.xp || 0) - (a.xp || 0));
  const c = able[0];
  const was = rankTitle(c);
  c.role = 'Captain';
  c.rank = 4;
  c.retire = null; c.quit = null; c.due = null;
  note(c, now, `Took command (was ${was})`);
  c.moraleMod = (c.moraleMod || 0) + 5;
  emit('crew-command', { member: c, text: `${fullName(c)}, ${was}, takes command of the ship.` });
  return c;
}

/** How long someone has served aboard (min). */
export const serviceOf = (m, minute) => minute - (m.joined ?? minute);
