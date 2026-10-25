// The chase: torpedoes against a ship running, ships that run as crews
// with bodies would, patrols that keep to their jurisdiction, a route to a
// lost contact's last fix, where a bounty's mark lies, and a warship's brig.
import { assert, fmt } from './helpers.mjs';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { getBody, bodyPos } from '../js/sim/ephemeris.js';
import { spawnAgent, respondToRequest } from '../js/sim/agents.js';
import { launchTorpedo, torpedoForecast } from '../js/sim/ordnance.js';
import { PLAYER } from '../js/sim/combatants.js';
import { releaseHold, engageRoute, overrideSecure } from '../js/sim/autopilot.js';
import { createPlan, planRoutes, targetName } from '../js/sim/nav.js';
import { controlAt } from '../js/sim/factions.js';
import { hullSignature, playerSensorQuality } from '../js/sim/sensors.js';
import { freeBerths, freeCells } from '../js/sim/manifest.js';
import { acceptContract, ContractType } from '../js/sim/contracts.js';
import { HIGH_DOSE_G } from '../js/sim/crew.js';
import { prisonerGroup, turnOver, ransomOffer, ransom, PIRATE_BOUNTY, RANSOM } from '../js/sim/prisoners.js';
import { setPhase } from '../js/sim/politics.js';

/** Out in the black off our home port (Phobos for a Martian license, Ceres for none). */
function game(seed, classId = 'mcrn-corvette', license = 'MCR') {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 6, traffic: 0, classId, license });
  s.missions.cooldown = 1e9;                  // no distress calls
  s.politics.quietUntil = Infinity;           // no random encounters
  s.politics.zones = [];
  releaseHold(s);
  s.flight.pos.y += 0.02;                     // out in the black, away from Ceres and its guns
  s.sensors.range = 2;                        // the long-range board: plumes and beacons
  return s;
}

function recorder() {
  const ev = {};
  bus.on('*', (type, p) => { (ev[type] ||= []).push(p); });
  return ev;
}

/** A spot `distAU` from us, at rest in our frame. */
function near(s, distAU, ang = 1.0) {
  const f = s.flight.pos;
  return { pos: { x: f.x + Math.cos(ang) * distAU, y: f.y + Math.sin(ang) * distAU }, vel: { vx: s.flight.vel.vx, vy: s.flight.vel.vy } };
}

/** A pirate running from us (agents.js run). With its transponder on it can't go dark. */
function runner(s, cls, distAU, { silent = false } = {}) {
  const { pos, vel } = near(s, distAU);
  const e = spawnAgent(s, { role: 'pirate', cls, faction: 'pirate', pos, vel, transponder: !silent });
  e.agent.mode = 'leave';
  e.agent.threat = PLAYER;
  return e;
}

const distKm = (s, e) => Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y) * AU_M / 1000;

/** Fly a torpedo at `target` to the end; how it went. */
function shoot(s, target, ev, maxMin = DAY_MIN) {
  const t = launchTorpedo(s, PLAYER, target.id, { warhead: 'he', profile: 'fast' }, (x, p) => bus.emit(x, p));
  const world = getWorld(s);
  let peakG = 0, min = 0;
  while (world.get(t.id) && min < maxMin) { advance(s, 1); min++; peakG = Math.max(peakG, t.thrust || 0); }
  const out = ev['torpedo-hit'] ? 'hit' : ev['torpedo-intercepted'] ? 'shot down' : ev['torpedo-missed'] ? 'missed' : (ev['ordnance-gone'] || []).find(o => o.id === t.id)?.why || 'flying';
  return { out, peakG, min };
}

export default [
  {
    name: 'a torpedo runs down a ship running at 8G: its motor\'s best early, then the runner\'s own burn brings it in',
    fn: () => {
      const s = game(3);
      const ev = recorder();
      const p = runner(s, 'pirate-corvette', 0.0025);
      advance(s, 10);                              // (its nose comes round, then the drive)
      const f = torpedoForecast(s, PLAYER, p.id, 'fast');
      assert(p.thrust > 7.5, `the runner should be at its best, ${p.thrust}G`);
      assert(f.reach, `375,000 km from an 8G runner is in reach: ${JSON.stringify(f)}`);
      const r = shoot(s, p, ev);
      console.log(`      8G runner from ${fmt(distKm(s, p) / 1000, 0)}k km now: forecast ${fmt(f.etaS / 60, 0)} min, ${r.out} after ${r.min} min, peak ${fmt(r.peakG)}G`);
      assert(r.peakG > 25, `a TL4 motor rips at full G against a runner, not at the runner's 8G: ${fmt(r.peakG)}G`);
      assert(['hit', 'shot down', 'missed'].includes(r.out), `it reached the runner: ${r.out}`);
    },
  },
  {
    name: 'from far out a runner is out of reach: fire control says so, and the torpedo runs dry',
    fn: () => {
      const s = game(4);
      const ev = recorder();
      const p = runner(s, 'pirate-corvette', 0.02);
      advance(s, 10);
      const f = torpedoForecast(s, PLAYER, p.id, 'fast');
      assert(!f.reach, 'out of reach from 3M km');
      const r = shoot(s, p, ev);
      console.log(`      from 3M km: forecast short by ${fmt(f.shortM / 1e9, 2)}M km; the torpedo ${r.out} after ${r.min} min`);
      assert(r.out === 'spent' || r.out === 'target-lost', `it should run dry, not arrive: ${r.out}`);
    },
  },
  {
    name: 'a runner sprints while its crew can take it, eases to what juice covers, and run down, strikes',
    fn: () => {
      const s = game(5);
      const ev = recorder();
      const p = runner(s, 'pirate-corvette', 0.003);
      engageRoute(s, createPlan('closing', { kind: 'entity', id: p.id }, { accelG: 10, standoff: 2_000 }));
      overrideSecure(s);
      let easedAt = null, crewAtEase = null, struck = null;
      for (let t = 0; t < DAY_MIN && !struck; t++) {
        advance(s, 1);
        if (easedAt == null && ev['agent-eases']) { easedAt = t; crewAtEase = p.combat.crew; }
        const r = s.comms.requests.find(x => x.kind === 'surrender' && x.from === p.id);
        if (r) { struck = t; respondToRequest(s, r.id, 'accept', (x, q) => bus.emit(x, q)); }
      }
      console.log(`      sprint at 8G until ${easedAt} min (crew ${fmt((crewAtEase ?? 0) * 100, 0)}% standing), then ${HIGH_DOSE_G}G; run down and struck at ${struck} min, ${fmt(distKm(s, p), 0)} km off`);
      assert(easedAt != null && easedAt > 30 && easedAt < 180, `the sprint is bounded: ${easedAt} min`);
      assert(crewAtEase > 0.85, 'a captain spends a tenth of the crew to break contact, not all of it');
      assert(struck != null && p.combat.status === 'surrendered', 'cornered, it strikes');
    },
  },
  {
    name: 'a ship running silent coasts dark out past our reach on its hull, and bolts when found inside it',
    fn: () => {
      const s = game(6);
      const ev = recorder();
      const p = runner(s, 'pirate-corvette', 0.01, { silent: true });
      const reachKm = hullSignature(p) * playerSensorQuality(s) * AU_M / 1000;
      advance(s, 3);
      assert(p.thrust === 0 && p.agent.dark, `1.5M km out (our reach on it ${fmt(reachKm, 0)} km) it coasts dark`);
      assert(!s.sensors.$seen.has(p.id), 'and our board does not hold it');
      // found: we come out of nowhere inside its reach
      s.flight.pos.x = p.pos.x - 200_000_000 / AU_M; s.flight.pos.y = p.pos.y;
      advance(s, 10);
      assert(p.thrust > 7, `found, it runs: ${p.thrust}G`);
      let darkAgain = null;
      for (let t = 0; t < 6 * 60 && darkAgain == null; t++) { advance(s, 1); if (p.agent.dark) darkAgain = t; }
      advance(s, 3);                               // (its plume out, our board loses it)
      const fix = s.intel.tracks[p.id];
      console.log(`      dark at 1.5M km; found at 200k km, ran, dark again ${darkAgain} min later at ${fmt(distKm(s, p), 0)} km; plot: ${fix?.kind}`);
      assert(darkAgain != null, 'out past our reach again, it goes dark');
      assert(fix?.kind === 'fix', 'leaving a last fix on the plot');
    },
  },
  {
    name: 'a pirate lying dark, found by a warship it can\'t fight coming for it, runs before it is shot at',
    fn: () => {
      const s = game(7);
      const { pos, vel } = near(s, 0.0008);
      const p = spawnAgent(s, { role: 'pirate', cls: 'pirate-raider', faction: 'pirate', pos, vel, transponder: false });
      // we come on at 2 km/s
      const ux = Math.cos(1.0), uy = Math.sin(1.0);
      s.flight.vel.vx += ux * 2000; s.flight.vel.vy += uy * 2000;
      let ran = null;
      for (let t = 0; t < 120 && ran == null; t++) { advance(s, 1); if (p.agent.mode === 'leave') ran = t; }
      assert(ran != null && p.agent.threat === PLAYER, `it should run from us: ${p.agent.mode}`);
    },
  },
  {
    name: 'a torpedo\'s target that goes dark is aimed at where it coasted (the runner keeps burning while torpedoes it saw are due)',
    fn: () => {
      const s = game(8);
      const p = runner(s, 'pirate-corvette', 0.002, { silent: true });
      advance(s, 2);
      launchTorpedo(s, PLAYER, p.id, { warhead: 'he', profile: 'fast' }, (x, q) => bus.emit(x, q));
      advance(s, 3);
      assert(p.agent.waryUntil > s.clock.minute, 'it saw the torpedo and stays lit while it is due');
      assert(p.thrust > 0, 'burning, so the torpedo spends its Δv');
    },
  },
  {
    name: 'patrols stop us only inside their jurisdiction, and not on a course out of it before they could be alongside',
    fn: () => {
      // A UN cutter in OPA space never orders a stop, suspect or not
      let s = game(11, 'light-freighter', null);
      let ev = recorder();
      s.law.wanted.UN = 1;
      let { pos, vel } = near(s, 0.0015);
      spawnAgent(s, { role: 'patrol', cls: 'cutter', faction: 'UN', pos, vel });
      advance(s, 6 * 60);
      assert(controlAt(s.flight.pos.x, s.flight.pos.y, s.clock.minute).faction === 'OPA', 'we are in OPA space');
      assert(!ev['comm-request'], 'no order to heave to outside its power\'s space');
      // An OPA cutter, a suspect ship near the edge of OPA space flying out of it fast: no stop
      const edge = (from, ux, uy) => { for (let r = 0; r < 3; r += 0.002) if (controlAt(from.x + ux * r, from.y + uy * r, 0).faction !== 'OPA') return r; return null; };
      const ceres = bodyPos(getBody('Ceres'), 0);
      const n = Math.hypot(ceres.x, ceres.y), ux = ceres.x / n, uy = ceres.y / n;      // out from the Sun past Ceres
      const rEdge = edge(ceres, ux, uy);
      assert(rEdge != null, 'OPA space ends somewhere out past Ceres');
      const trial = (outMS) => {
        const t = game(12, 'light-freighter', null);
        const e2 = recorder();
        t.law.wanted.OPA = 1;
        t.flight.pos.x = ceres.x + ux * (rEdge - 0.004); t.flight.pos.y = ceres.y + uy * (rEdge - 0.004);
        const v0 = { vx: t.flight.vel.vx, vy: t.flight.vel.vy };
        const cp = { x: t.flight.pos.x - uy * 0.0015, y: t.flight.pos.y + ux * 0.0015 };
        spawnAgent(t, { role: 'patrol', cls: 'cutter', faction: 'OPA', pos: cp, vel: { ...v0 } });
        t.flight.vel.vx += ux * outMS; t.flight.vel.vy += uy * outMS;
        advance(t, 4 * 60);
        return !!e2['comm-request']?.some(x => x.request.kind === 'inspect');
      };
      const still = trial(0), leaving = trial(400_000);
      console.log(`      OPA space ends ${fmt(rEdge * 150, 0)}M km out past Ceres; 600,000 km inside it: stopped at rest ${still}, flying out at 400 km/s ${leaving}`);
      assert(still, 'at rest inside its space, the cutter stops us');
      assert(!leaving, 'on our way out of its space faster than it could come alongside, it lets us go');
    },
  },
  {
    name: 'one stop at a time, and papers stamped are good for a while',
    fn: () => {
      // A Martian navy hull flown without its license, in Martian space: a search leaves the record open (SUSPECT)
      const s = game(13, 'mcrn-corvette', null);
      const mars = bodyPos(getBody('Mars'), 0);
      s.flight.pos = { x: mars.x + 0.02, y: mars.y };
      const ev = recorder();
      for (const ang of [1.0, 2.5]) { const { pos, vel } = near(s, 0.0015, ang); spawnAgent(s, { role: 'patrol', cls: 'mcr-cutter', faction: 'MCR', pos, vel }); }
      let most = 0, done = null;
      for (let t = 0; t < 2 * DAY_MIN; t++) {
        advance(s, 1);
        const open = s.comms.requests.filter(r => r.kind === 'inspect');
        most = Math.max(most, open.length);
        for (const r of open) respondToRequest(s, r.id, 'comply', (x, q) => bus.emit(x, q));
        if (!done && ev['inspection-complete']) done = t;
        if (done != null && t > done + DAY_MIN) break;
      }
      const asked = (ev['comm-request'] || []).filter(x => x.request.kind === 'inspect').length;
      console.log(`      two cutters about: at most ${most} order open at once; searched at ${done} min; orders in all ${asked}; wanted by Mars after: ${s.law.wanted.MCR}`);
      assert(most <= 1, 'never two orders to heave to at once');
      assert(done != null, 'one of them searched us');
      assert(s.law.wanted.MCR >= 1, 'the record stays open on an unlicensed hull');
      assert(asked === 1, `after a search the other waves us through for a while, record open or not: ${asked} orders`);
    },
  },
  {
    name: 'a lost contact\'s last fix can be flown to, and the sensors take the route over when they hold it again',
    fn: () => {
      const s = game(14);
      const ev = recorder();
      const { pos, vel } = near(s, 0.005, 2.0);
      vel.vx += 1500;                                // it drifts across our bow at 1.5 km/s
      const p = spawnAgent(s, { role: 'pirate', cls: 'pirate-raider', faction: 'pirate', pos, vel, transponder: false });
      // our last fix of it, an hour old: where it was and how it moved
      const now = s.clock.minute;
      s.intel.tracks[p.id] = { id: p.id, name: null, kind: 'fix', src: 'SENSORS', at: now - 60, rx: now - 60, dark: true,
        x: p.pos.x - p.vel.vx * 3600 / AU_M, y: p.pos.y - p.vel.vy * 3600 / AU_M, vx: p.vel.vx, vy: p.vel.vy };
      const target = { kind: 'fix', id: p.id };
      assert(/last fix/.test(targetName(s, target)), targetName(s, target));
      const opts = planRoutes(s, target, { combat: true });
      const o = opts.find(x => x.feasible && x.name === 'STANDARD') || opts.find(x => x.feasible);
      assert(o, 'a route to the fix');
      engageRoute(s, o.plan, { estimate: o.estimate });
      overrideSecure(s);
      let took = null;
      for (let t = 0; t < DAY_MIN && took == null; t++) { advance(s, 1); if (ev['route-reacquired']) took = t; }
      console.log(`      route to an hour-old fix 750,000 km out (${o.name}): back on our sensors after ${took} min, the route then on ${s.autopilot?.plan.target.kind || 'nothing (arrived)'}`);
      assert(took != null, 'the sensors pick it up on the way');
      assert(!s.autopilot || s.autopilot.plan.target.kind === 'entity', 'and the route closes on the contact itself');
    },
  },
  {
    name: 'a bounty\'s mark off a moon lies off its planet, and the pirate stays near it',
    fn: () => {
      seedRandom(15);
      bus.clear();
      const s = createGame({ docked: false, crewCount: 4, traffic: 0, license: 'MCR' });
      s.missions.cooldown = 1e9; s.politics.quietUntil = Infinity;
      s.comms.transponder = false;                 // (squawking, we'd draw it out of hiding)
      const world = getWorld(s);
      const st = world.get('phobos-yard');
      const c = { id: 'c-m', type: ContractType.BOUNTY, station: st.id, stationName: st.name, phase: 'offered', zone: null,
        ship: { cls: 'pirate-corvette', name: 'Test Drift', faction: 'pirate', tl: 2, shipClass: 'Stolen corvette', mass: 3000 },
        body: 'Phobos', distAU: 0.026, reward: { credits: 5000 }, perHead: 1000, deadline: 10 * DAY_MIN, expires: s.clock.minute + DAY_MIN, title: 'Bounty: Test Drift' };
      st.board ??= { missions: [], lastRefresh: s.clock.minute };
      st.board.missions.push(c);
      st.board.lastRefresh = s.clock.minute;
      // (signing takes being in port: put us there)
      s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel };
      const r = acceptContract(s, st.id, c.id);
      assert(r.ok, r.text);
      const mark = world.get(c.markId), p = world.get(c.targetId);
      assert(mark.orbit.body === 'Mars', `off Phobos, the mark rests off Mars: ${mark.orbit.body}`);
      const gap = () => { world.refresh(mark, s.clock.minute); return Math.hypot(p.pos.x - mark.pos.x, p.pos.y - mark.pos.y) * AU_M / 1000; };
      const g0 = gap();
      advance(s, 2 * DAY_MIN);
      const g1 = gap();
      console.log(`      the pirate lies ${fmt(g0, 0)} km from its last-seen mark; two days on, ${fmt(g1, 0)} km`);
      assert(Math.abs(g1 - g0) < 30_000, 'it drifts from the mark by little, not 185,000 km a day');
    },
  },
  {
    name: 'a warship takes prisoners into its brig; passengers keep to their berths',
    fn: () => {
      const s = createGame({ docked: false, crewCount: 4, traffic: 0, classId: 'opa-corvette', license: 'OPA' });
      assert(s.brig === 6 && s.berths === 4, `a brig of 6 and 4 berths: ${s.brig}, ${s.berths}`);
      assert(s.ship.decks.some(d => d.id === 'brig'), 'a brig deck');
      assert(freeCells(s) === 10 && freeBerths(s) === 4, 'all free');
      s.passengers.push({ kind: 'prisoners', count: 7 });
      assert(freeCells(s) === 3 && freeBerths(s) === 3, `seven prisoners: six in the cells, one in a berth: ${freeCells(s)}, ${freeBerths(s)}`);
      s.passengers.push({ contract: 'c-p', count: 3 });
      assert(freeCells(s) === 0 && freeBerths(s) === 0, 'and the berths are full');
      const t = createGame({ docked: false, crewCount: 4, traffic: 0, classId: 'mcrn-corvette', license: 'MCR' });
      assert(freeCells(t) === 6 && freeBerths(t) === 0, 'a Tharsis has cells for six and no passenger berths');
    },
  },
  {
    name: 'prisoners turned over earn the bounty and standing; their officers ransomed bring cash, and the local power frowns',
    fn: () => {
      const s = game(16);
      const world = getWorld(s);
      const st = world.get('phobos-yard');
      setPhase(s, 'UN', 'MCR', 'crisis');
      const { pos, vel } = near(s, 0.003);
      const pirate = spawnAgent(s, { role: 'pirate', cls: 'pirate-corvette', faction: 'pirate', pos, vel, transponder: false });
      const harrier = spawnAgent(s, { role: 'navy', cls: 'unn-corvette', faction: 'UN', pos, vel });
      s.passengers.push(prisonerGroup(s, pirate, 5), prisonerGroup(s, harrier, 6));
      const [pg, ug] = s.passengers;
      assert(pg.notables === 1 && ug.notables === 2, `a pirate captain; a Harrier's captain and an officer: ${pg.notables}, ${ug.notables}`);
      // their officers ransomed, through the brokers at Phobos
      const o = ransomOffer(s, st, 1);
      const cr0 = s.resources.credits.current, mcr0 = s.law.standing.MCR;
      assert(o.ok && o.amount === 2 * RANSOM.military, `two UN officers: ${o.amount}`);
      ransom(s, st, 1);
      const got = s.resources.credits.current - cr0;
      assert(got === o.amount && s.law.standing.MCR < mcr0, 'paid, and Mars saw its enemies bought free');
      assert(s.passengers[1].count === 4 && !s.passengers[1].notables, 'the rank and file stay aboard');
      // the rest turned over: the pirates' bounty (their captain counts thrice), standing with Mars
      const mcr1 = s.law.standing.MCR, un1 = s.law.standing.UN, cr1 = s.resources.credits.current;
      const r = turnOver(s, st);
      console.log(`      ransom: ${got.toLocaleString()} MCR for 2 UN officers (Mars ${fmt(s.law.standing.MCR - mcr0 - (s.law.standing.MCR - mcr1), 0)}); turned over: ${r.text} Mars +${fmt(s.law.standing.MCR - mcr1)}, UN ${fmt(s.law.standing.UN - un1)}`);
      assert(s.resources.credits.current - cr1 === PIRATE_BOUNTY * (5 + 2), 'the pirates\' bounty');
      assert(s.law.standing.MCR > mcr1 && s.law.standing.UN < un1, 'standing with Mars, lost with Earth');
      assert(!s.passengers.some(p => p.kind === 'prisoners'), 'the brig is empty');
    },
  },
  {
    name: 'a licensed captain in its own navy\'s hull is never stopped by that power\'s security; in a freighter, it is',
    fn: () => {
      const trial = (classId) => {
        const s = game(17, classId);
        const ev = recorder();
        s.law.wanted.MCR = 1;                      // SUSPECT with Mars: its cutters would stop anyone else
        const { pos, vel } = near(s, 0.0015);
        spawnAgent(s, { role: 'patrol', cls: 'mcr-cutter', faction: 'MCR', pos, vel });
        advance(s, 6 * 60);
        return !!ev['comm-request']?.some(x => x.request.kind === 'inspect');
      };
      const tharsis = trial('mcrn-corvette'), freighter = trial('light-freighter');
      console.log(`      SUSPECT with Mars, a Martian Security cutter about: stopped in a Tharsis ${tharsis}, in a light freighter ${freighter}`);
      assert(!tharsis, 'under its own banner, no stop');
      assert(freighter, 'a suspect civilian hull is stopped');
    },
  },
];
