// ============================================================
// LONGHAUL — Tests: shuttles and planetary flight
//
// A big hull carries shuttles (ship-classes.js BAYS) and they are its way
// to a world's ground: an entry flown as physics (planetary.js: the heat
// inside its shield, the G inside its crew's, at rest on the pad at the
// end), a run planned whole from a high orbit (shuttles.js: each stretch
// meeting the next, the way back ending at us), flown with its pilot away
// and its fuel charged when it is home, the freight of a PLANETSIDE
// contract landed and paid; a landing refused by a controller; a run
// called back; a shuttle that comes home to find us gone; NPC carriers on
// planetary calls, and their shuttles flown where we can see them.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_M, DAY_MIN, G0 } from '../js/core/constants.js';
import { createGame, advance } from '../js/sim/game.js';
import { releaseHold, holdStation } from '../js/sim/autopilot.js';
import { parkingTarget, targetStateAt } from '../js/sim/nav.js';
import { bodyPos, bodyVel } from '../js/sim/ephemeris.js';
import { getWorld } from '../js/sim/world.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { CLASSES, CLASS_IDS, bayOf } from '../js/sim/ship-classes.js';
import { worldOf, airspacesOf, airspaceById } from '../js/sim/worlds.js';
import { entryProfile, ascentProfile, craftOf, flightPathAt, HEAT_LIMIT, runMinutes } from '../js/sim/planetary.js';
import { planRun, launchRun, activeRuns, runReadout, landingClearance, runRefusal, abortRun } from '../js/sim/shuttles.js';
import { ContractType, deliverPlanetside } from '../js/sim/contracts.js';

/** A game with our ship held on a world's parking orbit (no traffic unless asked). */
function inOrbit(name, { classId = 'ares', seed = 5, traffic = 0 } = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 5, traffic, forces: false, docked: false, classId });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  releaseHold(s); s.dock = null;
  const tgt = parkingTarget(s, name, s.clock.minute);
  const st = targetStateAt(s, tgt, s.clock.minute);
  s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel };
  holdStation(s, tgt);
  advance(s, 2);
  return s;
}
/** Fly a run to its end (or `limit` minutes), watching it. */
function flyRun(s, run, limit = 2 * DAY_MIN, each = null) {
  let t = 0;
  while (activeRuns(s).includes(run) && t < limit) { advance(s, 1); t++; each?.(t); }
  return t;
}
/** The distance between two places round world `w`, each at its own minute, in the world's frame (m). */
function apart(w, a, ma, b, mb) {
  const ca = bodyPos(w.body, ma / DAY_MIN), cb = bodyPos(w.body, mb / DAY_MIN);
  return Math.hypot((a.x - ca.x) - (b.x - cb.x), (a.y - ca.y) - (b.y - cb.y)) * AU_M;
}

export default [
  {
    name: 'shuttles are carried craft: in the big hulls\' bays, rated for an air, never a hull to command',
    fn: () => {
      for (const id of ['pinnace', 'lander']) {
        const c = CLASSES[id];
        assert(c.carried && c.atmo && !CLASS_IDS.includes(id), `${id}: carried, rated for an air, not a hull of its own`);
      }
      assert(bayOf('ares').some(b => b.cls === 'pinnace') && bayOf('freighter').some(b => b.cls === 'lander'), 'a light freighter carries a pinnace, a freighter a lander too');
      const s = inOrbit('Mars');
      assert(s.shuttles.bay.length === bayOf('ares').length && s.shuttles.bay.every(x => !x.run), `our bay: ${s.shuttles.bay.map(x => x.name).join(', ')}`);
      const small = createGame({ crewCount: 3, traffic: 0, forces: false, docked: false, classId: 'tramp' });
      console.log(`      bays: ${['tramp', 'ares', 'freighter', 'liner', 'frigate'].filter(k => CLASSES[k]).map(k => `${k} ${bayOf(k).map(b => b.cls).join('+') || 'none'}`).join(' · ')} · a ${small.ship.className || 'tramp'} starts with ${small.shuttles.bay.length}`);
    },
  },
  {
    name: 'an entry is flown as physics: the heat inside the shield, the G inside the crew\'s, at rest on the pad; the climb back to orbital speed',
    fn: () => {
      const rows = [];
      for (const [world, cls] of [['Earth', 'pinnace'], ['Earth', 'lander'], ['Mars', 'pinnace'], ['Titan', 'pinnace'], ['Luna', 'lander']]) {
        const w = worldOf(world), p = entryProfile(world, cls), up = ascentProfile(world, cls), c = CLASSES[cls];
        assert(p && up, `${world} ${cls}: a way down and up`);
        const last = p.samples.at(-1);
        assert(last.h < 5 && last.v < 5, `${world} ${cls}: down at rest (${fmt(last.h, 0)} m, ${fmt(last.v, 1)} m/s)`);
        assert(p.peakHeat < HEAT_LIMIT[c.atmo.shield] && p.peakG <= c.drive.maxG + 0.05, `${world} ${cls}: heat ${fmt(p.peakHeat / 1e6, 2)} MW/m², ${fmt(p.peakG, 1)} G`);
        if (w.atmo) assert(p.entryV > 1000 && p.th > 0, `${world}: an entry at ${fmt(p.entryV)} m/s, downrange`);
        // (out of the air on the drive: the leg back up to us carries on from there, still on it)
        const last2 = up.samples.at(-1);
        assert(last2.h >= up.topM - 1 && up.v > 300 && up.peakG <= c.drive.maxG + 0.05, `${world} ${cls}: clears ${fmt(up.topM / 1000, 0)} km at ${fmt(up.v)} m/s, ${fmt(up.peakG, 1)} G`);
        rows.push(`${world} ${cls}: ${w.atmo ? `in at ${fmt(p.entryV / 1000, 2)} km/s, ${fmt(p.peakHeat / 1e6, 2)} MW/m², ${fmt(p.peakG, 1)} G, ${fmt(p.th * w.R / 1000, 0)} km downrange, ` : 'powered, '}down in ${fmt(p.t / 60, 0)} min, up in ${fmt(up.t / 60, 0)}`);
      }
      assert(!entryProfile('Venus', 'pinnace') || !airspacesOf(worldOf('Venus')).length, 'Venus: nowhere to land');
      console.log(`      ${rows.join('\n      ')}`);
    },
  },
  {
    name: 'a run is planned whole: each stretch meets the next, and the way back ends where we will be, for every pad round a world',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), world = getWorld(s);
      const worst = { join: 0, home: 0 };
      for (const a of airspacesOf(w)) {
        const p = planRun(s, s.shuttles.bay[0].id, a.id);
        assert(p.ok, `${a.port.name}: ${p.why}`);
        const path = { world: 'Mars', cls: p.plan.cls, carrier: 'player', legs: p.plan.legs };
        for (let i = 1; i < p.plan.legs.length - 1; i++) {
          const t = p.plan.legs[i].t1, e = 1e-4;
          const A = flightPathAt(world, path, t - e), B = flightPathAt(world, path, t + e);
          worst.join = Math.max(worst.join, apart(w, A.pos, t - e, B.pos, t + e));
        }
        const back = p.plan.legs.find(l => l.phase === 'return');
        const end = flightPathAt(world, path, back.t1 - 1e-4), us = targetStateAt(s, s.flight.hold, back.t1);
        worst.home = Math.max(worst.home, apart(w, end.pos, back.t1, us.pos, back.t1));
      }
      assert(worst.join < 2000 && worst.home < 5000, `stretches meet within ${fmt(worst.join, 0)} m; home within ${fmt(worst.home, 0)} m of us`);
      console.log(`      ${airspacesOf(w).length} pads: the stretches meet within ${fmt(worst.join, 0)} m, the way back ends ${fmt(worst.home, 0)} m from us at worst`);
    },
  },
  {
    name: 'a run flown: the pilot away until it is home, its freight landed and the PLANETSIDE contract paid by radio, its fuel out of our tanks, the shuttle gone from the displays',
    fn: () => {
      const s = inOrbit('Mars');
      const a = airspacesOf(worldOf('Mars'))[1];
      // a PLANETSIDE contract for its pad, the freight aboard
      const c = { id: 'test-ps', type: ContractType.PLANETSIDE, title: 'Planetside test', world: 'Mars', airspace: a.id, destName: `${a.port.name}, Mars`, cargo: { name: 'seed stock', mass: 2500 }, reward: { credits: 6000 }, phase: 'active', dueAt: s.clock.minute + 9 * DAY_MIN, log: [] };
      s.contracts.active.push(c);
      s.cargo.push({ contract: c.id, name: 'seed stock', mass: 2500 });
      const credits0 = s.resources.credits.current;
      const p = planRun(s, s.shuttles.bay[0].id, a.id);
      const r = launchRun(s, p.plan);
      assert(r.ok, r.text);
      const run = r.run, pilot = s.ship.crew.find(m => m.away?.op === run.id);
      assert(pilot && !s.cargo.some(x => x.contract === c.id), `${pilot?.name} away flying it; the freight aboard it`);
      const fuel0 = s.resources.fuel.current;
      const seen = [];
      let landedPaid = null;
      flyRun(s, run, DAY_MIN, () => {
        if (run.phase !== 'done' && seen.at(-1) !== run.phase) seen.push(run.phase);
        if (run.phase === 'ground' && landedPaid == null) landedPaid = s.resources.credits.current - credits0;
      });
      assert(run.phase === 'done' && seen.join(' ') === 'launch drop down ground up return recover', `phases: ${seen.join(' ')}`);
      assert(landedPaid === 6000 && s.contracts.history.includes(c) && c.phase === 'complete', `paid when it landed (${landedPaid} MCR)`);
      const burned = fuel0 - s.resources.fuel.current;
      assert(Math.abs(burned - run.summary.fuelKg) < 0.2 && !s.ship.crew.some(m => m.away) && !getWorld(s).get(run.entity), `home: ${fmt(burned, 2)} kg burned (plan ${fmt(run.summary.fuelKg, 2)}), the crew aboard, the shuttle stowed`);
      console.log(`      Mars, ${a.port.name}: ${fmt(run.summary.totalMin / 60, 1)} h, ${fmt(run.summary.fuelKg, 2)} kg; ${c.cargo.mass} kg landed and paid on the pad`);
    },
  },
  {
    name: 'a controller refuses a landing to a ship its power wants, or an enemy\'s; nothing launches, and a run needs a held high orbit',
    fn: () => {
      const s = inOrbit('Mars');
      const a = airspacesOf(worldOf('Mars'))[0];
      assert(landingClearance(s, a.id).ok, 'cleared at first');
      s.law.wanted ||= {}; s.law.wanted.MCR = 3;
      const no = landingClearance(s, a.id);
      const r = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan);
      assert(!no.ok && !r.ok && !activeRuns(s).length && !s.ship.crew.some(m => m.away), `refused: ${no.text}`);
      s.law.wanted.MCR = 0;
      releaseHold(s);
      assert(runRefusal(s).why && !planRun(s, s.shuttles.bay[0].id, a.id).ok, `no orbit held: ${runRefusal(s).why}`);
    },
  },
  {
    name: 'a run called back: braking short of the air while it can, or landing and lifting at once; and one that comes home to find us gone waits, then chases us',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), a = airspacesOf(w)[2];
      const go = () => launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      const rows = [];
      // early on its drop
      let run = go();
      flyRun(s, run, 0);
      while (run.phase !== 'drop' || s.clock.minute < run.legs[1].t0 + 5) advance(s, 1);
      let r = abortRun(s, run.id);
      let phases = new Set();
      flyRun(s, run, DAY_MIN, () => phases.add(run.phase));
      assert(r.ok && !phases.has('down') && !phases.has('ground') && run.phase === 'done' && !s.ship.crew.some(m => m.away), `back without landing (${[...phases].join(' ')})`);
      rows.push(`called back on its drop: home in ${fmt(run.doneAt - run.startedAt, 0)} min`);
      // on the pad
      run = go();
      while (run.phase !== 'ground') advance(s, 1);
      advance(s, 5);
      const planned = run.legs.at(-1).t1;
      r = abortRun(s, run.id);
      flyRun(s, run);
      assert(r.ok && run.doneAt < planned - 60, `lifts at once: home ${fmt(planned - run.doneAt, 0)} min early`);
      rows.push(`called back on the pad: ${fmt(planned - run.doneAt, 0)} min early`);
      // we leave while it is down: out of Mars' space, then back in
      run = go();
      while (run.phase !== 'ground') advance(s, 1);
      releaseHold(s);
      const c = bodyPos(w.body, s.clock.minute / DAY_MIN), v = bodyVel(w.body, s.clock.minute / DAY_MIN);
      s.flight.pos = { x: c.x + 1.5 * w.wellM / AU_M, y: c.y }; s.flight.vel = { ...v };
      while (run.phase !== 'hold' && activeRuns(s).includes(run)) advance(s, 1);
      assert(run.phase === 'hold', `it waits for us in orbit (${run.phase})`);
      // back into its space, on its parking orbit
      const tgt = parkingTarget(s, 'Mars', s.clock.minute), st = targetStateAt(s, tgt, s.clock.minute);
      s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel }; holdStation(s, tgt);
      flyRun(s, run);
      assert(run.phase === 'done' && run.log.some(l => /Chasing/.test(l.text)) && !s.ship.crew.some(m => m.away), 'it chases us down and comes aboard');
      rows.push(`we left: it held its orbit, then came after us (${run.log.filter(l => /Chasing/.test(l.text)).length} chase)`);
      console.log(`      ${rows.join(' · ')}`);
    },
  },
  {
    name: 'a run in flight is saved and loaded, and flies on',
    fn: () => {
      const s = inOrbit('Mars');
      const a = airspacesOf(worldOf('Mars'))[3];
      const run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      while (run.phase !== 'down') advance(s, 1);
      advance(s, 5);
      const before = runReadout(s, run);
      const { state: t } = deserialize(serialize(s));
      const run2 = t.shuttles.runs.find(x => x.id === run.id);
      const after = runReadout(t, run2);
      assert(Math.abs(after.h - before.h) < 1 && getWorld(t).get(run2.entity)?.flightPath, `the same place after loading (${fmt(before.h / 1000, 1)} km up)`);
      flyRun(t, run2);
      assert(run2.phase === 'done' && !t.ship.crew.some(m => m.away), 'and home');
    },
  },
  {
    name: 'NPC carriers call at settled worlds; near one, their shuttles fly real runs where we can see them, and the carrier waits for its own',
    fn: () => {
      const s = inOrbit('Mars', { traffic: 3000, seed: 7 });
      advance(s, 2 * DAY_MIN);
      const calling = s.entities.filter(e => e.tags?.traffic && e.tags.call?.phase === 'planet');
      const worlds = new Set(calling.map(e => e.tags.planet));
      assert(calling.length > 20 && worlds.size >= 3 && calling.every(e => bayOf(e.cls).length), `${calling.length} on planetary calls, at ${[...worlds].join(', ')}`);
      let peak = 0, seen = new Set(), waited = 0;
      const world = getWorld(s);
      for (let i = 0; i < 6 * 60; i++) {
        advance(s, 1);
        peak = Math.max(peak, s.shuttles.npc.length);
        for (const id of s.shuttles.npc) {
          seen.add(id);
          const e = world.get(id), c = e && world.get(e.tags.carrier);
          if (c && c.tags.shuttleOut === id && c.tags.call?.phase === 'planet' && c.tags.until > s.clock.minute) waited++;
        }
      }
      assert(seen.size >= 5 && peak <= 10 && waited > 0, `${seen.size} NPC shuttles seen, ${peak} out at once at most`);
      const t = runMinutes('Mars', 'lander', 200, 2);
      assert(t > 0 && t < 3 * DAY_MIN, `200 t to Mars' ground by two landers: ${fmt(t / 60, 1)} h`);
      console.log(`      ${calling.length} carriers on planetary calls after two days (${[...worlds].join(', ')}); ${seen.size} NPC shuttles flown off Mars in six hours, ${peak} at once; 200 t by two landers ${fmt(t / 60, 1)} h`);
    },
  },
];
