// ============================================================
// LONGHAUL — Tests: shuttles and planetary flight
//
// No hull is rated for an atmosphere: every one carries what lands for it
// (ship-classes.js BAYS: a gig, a pinnace, a cargo lander), its way
// to a world's ground: an entry flown as physics (planetary.js: the heat
// inside its shield, the G inside its crew's, at rest on the pad at the
// end), a run planned whole from a high orbit (shuttles.js: each stretch
// meeting the next, the way back ending at us; every stretch on the drive
// a burn, a coast, a burn, flown as physics at the drive's cruise, never
// through the air, by a low orbit or after a wait for a window where that
// is quicker), flown with its pilot away
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
import { CLASSES, CLASS_IDS, bayOf, landsBy } from '../js/sim/ship-classes.js';
import { worldOf, airspacesOf, airspaceById } from '../js/sim/worlds.js';
import { entryProfile, ascentProfile, craftOf, flightPathAt, placeOnLeg, xferAt, xferBurns, airState, HEAT_LIMIT } from '../js/sim/planetary.js';
import { shuttleAttitude } from '../js/ui/shuttlecam.js';
import { estimate, liveKnowledge } from '../js/sim/intel.js';
import { planRun, planLegs, launchRun, activeRuns, runReadout, landingClearance, runRefusal, abortRun, shuttleCrew, seatsOf, runMinutes } from '../js/sim/shuttles.js';
import { WORLDS } from '../js/sim/worlds.js';
import { LEAVE_MIN, LEAVE_COST } from '../js/sim/crew-services.js';
import { upgradeState } from '../js/sim/game.js';
import { holdLoad as MK_holdLoad } from '../js/sim/market.js';
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
    name: 'no hull is rated for an air, and every one carries a craft that is: a gig, a pinnace, a lander; each makes every settled world',
    fn: () => {
      const crafts = new Set();
      for (const id of CLASS_IDS) {
        const c = CLASSES[id];
        assert(!c.atmo, `${id}: not rated for an atmosphere itself`);
        const bay = bayOf(id);
        assert(bay.length > 0, `${id}: carries something that lands (${landsBy(id)})`);
        for (const b of bay) { crafts.add(b.cls); assert(CLASSES[b.cls]?.carried && CLASSES[b.cls].atmo, `${id}: its ${b.cls} is a carried craft, rated`); }
        assert(/^not rated: lands by /.test(landsBy(id)), `${id}: ${landsBy(id)}`);
      }
      const settled = WORLDS.filter(w => airspacesOf(w).length);
      const rows = [];
      for (const cls of crafts) {
        for (const w of settled) {
          const p = entryProfile(w.name, cls), up = ascentProfile(w.name, cls);
          assert(p && up, `a ${cls} makes ${w.name} and back`);
          assert(p.peakHeat < HEAT_LIMIT[CLASSES[cls].atmo.shield] && p.peakG <= CLASSES[cls].drive.maxG + 0.05, `${cls} at ${w.name}: heat ${fmt(p.peakHeat / 1e6, 2)} MW/m², ${fmt(p.peakG, 1)} G`);
        }
        rows.push(`${cls}: ${CLASSES[cls].berths} seats, ${CLASSES[cls].cargoT} t, every settled world (${settled.map(w => w.name).join(', ')})`);
      }
      console.log(`      ${rows.join('\n      ')}\n      sheets: ${['mcrn-corvette', 'dart', 'freighter', 'liner'].map(id => `${CLASSES[id].name}: ${landsBy(id)}`).join(' · ')}`);
      // an old game of a hull that had no craft: its bay filled on load
      const s = createGame({ crewCount: 3, traffic: 0, forces: false, docked: false, classId: 'mcrn-corvette' });
      s.shuttles.bay = [];
      upgradeState(s);
      assert(s.shuttles.bay.length === 1 && s.shuttles.bay[0].cls === 'pinnace', `an old corvette's bay: ${s.shuttles.bay.map(x => x.cls).join(', ')}`);
    },
  },
  {
    name: 'who goes: the pilot chosen, riders in the seats, none unfit; ashore at the spaceport for a run of leave, paid there, back rested (not if called in)',
    fn: () => {
      const s = inOrbit('Mars');
      const a = airspacesOf(worldOf('Mars'))[2];
      const able = shuttleCrew(s);
      const p = planRun(s, s.shuttles.bay[0].id, a.id, { leave: true });
      assert(p.ok && p.plan.groundMin === LEAVE_MIN, `a run for leave: the pad ${p.plan?.groundMin} min`);
      // (more riders than seats, or someone unfit, refused; ids as a form gives them)
      const seats = seatsOf(s.shuttles.bay[0].cls);
      assert(seats === CLASSES.pinnace.berths, 'a pinnace seats its berths');
      const hurt = able[2];
      hurt.consciousness = 10;
      const no = launchRun(s, p.plan, () => {}, { crew: { pilot: String(able[1].id), riders: [String(hurt.id)] } });
      assert(!no.ok, `someone unfit riding down is refused: ${no.text}`);
      hurt.consciousness = 100;
      const credits = s.resources.credits.current;
      const r = launchRun(s, p.plan, () => {}, { crew: { pilot: String(able[1].id), riders: [String(able[2].id), String(able[3].id)] } });
      assert(r.ok && r.run.crew.length === 3 && r.run.pilot === able[1].id && r.run.leave, `launched with its pilot and two riders: ${r.text}`);
      assert(s.ship.crew.filter(m => m.away?.op === r.run.id).length === 3 && s.ship.crew.find(m => m.id === able[1].id).away.pilot, 'the three away, the pilot marked');
      for (const m of s.ship.crew) m.moraleMod = 0;
      let charged = null;
      flyRun(s, r.run, 2 * DAY_MIN, () => { if (charged == null && r.run.ashore) charged = credits - s.resources.credits.current; });
      assert(r.run.phase === 'done' && r.run.ashore && charged === 3 * LEAVE_COST, `home, the three ashore for ${charged} MCR`);
      const back = s.ship.crew.filter(m => [able[1].id, able[2].id, able[3].id].includes(m.id));
      assert(back.every(m => !m.away && m.moraleMod >= 8 && m.needs.fun === 100), 'back aboard, rested and in better spirits');
      assert(s.ship.crew.filter(m => !back.includes(m)).every(m => !(m.moraleMod > 0)), 'those who stayed aboard, as they were');
      // called in off the pad: no better for it
      const p2 = planRun(s, s.shuttles.bay[0].id, a.id, { leave: true });
      const r2 = launchRun(s, p2.plan, () => {}, { crew: [able[1].id, able[2].id] });
      assert(r2.ok, r2.text);
      for (const m of s.ship.crew) m.moraleMod = 0;
      let t = 0;
      while (r2.run.phase !== 'ground' && t++ < DAY_MIN) advance(s, 1);
      advance(s, 30);
      const ab = abortRun(s, r2.run.id);
      assert(ab.ok && r2.run.leaveCut, `called in from leave: ${ab.text}`);
      flyRun(s, r2.run);
      assert(s.ship.crew.filter(m => [able[1].id, able[2].id].includes(m.id)).every(m => !(m.moraleMod > 0)), 'leave cut short: no better for it');
      console.log(`      a pinnace's ${seats} seats; three ashore at ${a.port.name} for ${LEAVE_MIN / 60} h, ${3 * LEAVE_COST} MCR, back rested; a leave called in, none`);
    },
  },
  {
    name: 'shuttles are carried craft: in the hulls\' bays, rated for an air, never a hull to command',
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
    name: 'the way down and back is flown as a real craft flies it: burns at its drive\'s cruise, coasts between, never through the air, arriving at the entry as it must; the quickest way within twice the cheapest, by a low orbit or a window where that is quicker',
    fn: () => {
      const rows = [];
      for (const [name, cls] of [['Earth', 'lander'], ['Mars', 'pinnace'], ['Luna', 'gig'], ['Titan', 'lander'], ['Ganymede', 'pinnace']]) {
        const w = worldOf(name), n = Math.sqrt(w.GM / w.parkM ** 3), as = airspacesOf(w), cruise = craftOf(cls).aCruise, air = w.atmo ? w.atmo.interfaceM : 10_000;
        let peak = 0, lowest = Infinity, miss = 0;
        const totals = [], downs = [], ways = { direct: 0, phased: 0, window: 0 };
        for (let k = 0; k < 6; k++) {
          const ph = k * 1.05, t0 = 1000 + 41 * k;
          const at = (m) => { const c = bodyPos(w.body, m / DAY_MIN), u = bodyVel(w.body, m / DAY_MIN), th = ph + n * m * 60, v = n * w.parkM;
            return { pos: { x: c.x + w.parkM * Math.cos(th) / AU_M, y: c.y + w.parkM * Math.sin(th) / AU_M }, vel: { vx: u.vx - v * Math.sin(th), vy: u.vy + v * Math.cos(th) } }; };
          const a = as[k % as.length], p = planLegs(name, cls, a.id, t0, at);
          assert(p.ok, `${name} ${cls}: ${p.why}`);
          for (const l of p.legs.filter(l => l.kind === 'xfer')) for (let s = 0; s <= (l.t1 - l.t0) * 60; s += 3) {
            const q = xferAt(w.GM, l.x, s);
            peak = Math.max(peak, Math.hypot(q.ax, q.ay)); lowest = Math.min(lowest, Math.hypot(q.x, q.y) - w.R);
          }
          // into the air exactly as the entry begins (where, and how fast and steep)
          const i = p.legs.findIndex(l => l.kind === 'down'), last = p.legs[i - 1], down = entryProfile(name, cls);
          const end = xferAt(w.GM, last.x, (last.t1 - last.t0) * 60), want = airState(w, down, p.legs[i].phi0, p.legs[i].t0);
          miss = Math.max(miss, Math.hypot(end.x - want.x, end.y - want.y) + 100 * Math.hypot(end.vx - want.vx, end.vy - want.vy));
          totals.push(p.summary.totalMin); downs.push(p.summary.windowMin + 6 + p.summary.dropMin);
          if (p.summary.phasedDown || p.summary.phasedUp) ways.phased++; else ways.direct++;
          if (p.summary.windowMin || p.summary.padWaitMin) ways.window++;
        }
        assert(peak <= 1.1 * cruise, `${name}: the push ${fmt(peak / G0, 2)} G, its cruise ${fmt(cruise / G0, 2)}`);
        assert(lowest >= 0.85 * air, `${name}: never into the air on the drive (${fmt(lowest / 1000, 0)} km, the air's top ${fmt(air / 1000, 0)})`);
        assert(miss < 1, `${name}: into the air where and as the entry begins (${fmt(miss, 3)} m, and m per 0.01 m/s)`);
        const h = (m) => `${fmt(m / 60, 1)} h`;
        rows.push(`${name} ${cls}: down ${h(Math.min(...downs))}–${h(Math.max(...downs))}, the whole run ${h(Math.min(...totals))}–${h(Math.max(...totals))} (${ways.direct} straight, ${ways.phased} by a low orbit, ${ways.window} waiting for a window); the push at most ${fmt(peak / G0, 2)} G of its ${fmt(cruise / G0, 1)}, never under ${fmt(lowest / 1000, 0)} km`);
      }
      console.log(`      ${rows.join('\n      ')}`);
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
    name: 'a run called back: back up to us from its way down while it can, or landing and lifting at once; and one that comes home to find us gone waits, then chases us',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), a = airspacesOf(w)[2];
      const go = () => launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      const rows = [];
      // early on its drop
      let run = go();
      flyRun(s, run, 0);
      while (run.phase !== 'drop' || s.clock.minute < run.legs.find(l => l.phase === 'drop').t0 + 5) advance(s, 1);
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
    name: 'the review\'s cases: a run called back on its drop pays for what it flew; a contract failed with its freight in a shuttle leaves nothing aboard; a trade never fills our hold past its room; a shuttle in its bay is part of us; it leaves us, and comes alongside, going round as we do',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), a = airspacesOf(w)[1], world = getWorld(s);
      // (1) called back 3 min into its drop
      let run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      while (run.phase !== 'drop' || s.clock.minute < run.legs.find(l => l.phase === 'drop').t0 + 3) advance(s, 1);
      const whole = run.summary.fuelKg;
      abortRun(s, run.id);
      assert(run.summary.fuelKg < whole * 0.8, `called back: ${fmt(run.summary.fuelKg, 2)} kg, not the whole run's ${fmt(whole, 2)}`);
      // (in its bay, it isn't a contact of ours)
      flyRun(s, run);
      // (2) a contract failed with its freight aboard the shuttle
      const c = { id: 'test-f', type: 'PLANETSIDE', title: 'f', world: 'Mars', airspace: a.id, destName: 'x', cargo: { name: 'seed stock', mass: 2000 }, reward: { credits: 1 }, phase: 'active', dueAt: s.clock.minute + 20, log: [] };
      s.contracts.active.push(c); s.cargo.push({ contract: c.id, name: 'seed stock', mass: 2000 });
      run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      advance(s, 2);
      const inBay = world.get(run.entity);
      assert(inBay?.$inBay && !s.sensors.contacts.some(x => x.id === run.entity), 'in its bay: no contact of ours');
      flyRun(s, run);
      assert(c.phase === 'failed' && !s.cargo.some(x => x.contract === c.id), `its contract failed: the freight is gone, nothing left in our hold (${fmt(MK_holdLoad(s) / 1000, 1)} t)`);
      // (3) a full hold: goods it can't sell come back, and what it buys fits the room there was
      s.cargo = [{ good: 'ore', name: 'Nickel-iron ore', mass: s.cargoCapacity - 4000, cost: 0 }, { good: 'electronics', name: 'Electronics', mass: 4000, cost: 0, seized: true, stolen: 'MCR', contraband: true, illegalIn: ['MCR'] }];
      run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan, () => {}, { trade: { sell: ['electronics'], buy: { good: 'water', t: Infinity } } }).run;
      flyRun(s, run);
      assert(MK_holdLoad(s) <= s.cargoCapacity + 1, `our hold ${fmt(MK_holdLoad(s) / 1000, 1)} t of ${fmt(s.cargoCapacity / 1000, 1)}`);
      // (4) going round as we do, as it leaves the bay and as it comes alongside
      run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
      const path = { world: 'Mars', cls: run.cls, carrier: 'player', legs: run.legs };
      const jump = (t) => { const A = flightPathAt(world, path, t - 0.02), B = flightPathAt(world, path, t + 0.02); return Math.hypot(A.vel.vx - B.vel.vx, A.vel.vy - B.vel.vy); };
      const out = jump(run.legs.find(l => l.kind === 'xfer').t0), home = jump(run.legs.at(-1).t0);
      assert(out < 80 && home < 80, `leaving the bay ${fmt(out, 0)} m/s, alongside ${fmt(home, 0)} m/s from our own speed`);
      console.log(`      called back on its drop: ${fmt(run.summary ? whole : 0, 2)} → charged what it flew; failed freight gone; a full hold kept full, not over; out of the bay ${fmt(out, 0)} m/s off our speed, alongside ${fmt(home, 0)}`);
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
    name: 'its drive is lit for every view as it burns (its entity\'s thrust and heading: the drone, the hull cameras, the telescope, the sensors, its sheet), cold as it coasts',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), run = launchRun(s, planRun(s, s.shuttles.bay[0].id, airspacesOf(w)[0].id).plan).run, e = getWorld(s).get(run.entity);
      const seen = {}, rows = [];
      let off = 0;
      flyRun(s, run, 2 * DAY_MIN, () => {
        const now = s.clock.minute, leg = [...run.legs].reverse().find(l => now >= l.t0);
        if (!leg || !activeRuns(s).includes(run)) return;
        const k = `${leg.phase}:${e.thrust > 0 ? 'lit' : 'cold'}`;
        seen[k] = (seen[k] || 0) + 1;
        if (leg.kind === 'xfer') {
          const q = xferAt(w.GM, leg.x, (now - leg.t0) * 60), a = Math.hypot(q.ax, q.ay);
          assert((a > 0.05) === (e.thrust > 0), `${leg.phase}: lit as it burns (${fmt(a, 2)} m/s², thrust ${fmt(e.thrust, 2)} G)`);
          if (a > 0.05) off = Math.max(off, Math.abs(Math.atan2(Math.sin(Math.atan2(q.ay, q.ax) - e.heading), Math.cos(Math.atan2(q.ay, q.ax) - e.heading))));
        }
        if (leg.kind === 'ground' || leg.kind === 'dock') assert(!(e.thrust > 0), `${leg.phase}: cold`);
      });
      assert(seen['up:lit'] > 0 && Object.keys(seen).some(k => /^(drop|deorbit|return|orbit):lit$/.test(k)) && Object.keys(seen).some(k => /:cold$/.test(k) && !/ground|launch|recover/.test(k)), `lit on its burns and its climb, cold coasting (${JSON.stringify(seen)})`);
      assert(off < 0.01, `its nose along its push (${fmt(off * 180 / Math.PI, 2)}° off)`);
      console.log(`      minutes lit/cold by stretch: ${Object.entries(seen).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    },
  },
  {
    name: 'a save from before 1.12.8: a run on the old spiral legs is planned again on load from where the craft is (on its way down, or coming back up), and flies home',
    fn: () => {
      const s = inOrbit('Mars');
      const w = worldOf('Mars'), a = airspacesOf(w)[1], rows = [];
      for (const when of ['drop', 'return']) {
        const run = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan).run;
        // (the leg it is on made over as an old one: a spiral from where it began to where it ends, flown at 1 G)
        const i = run.legs.findIndex(l => l.phase === when || (when === 'return' && l.phase === 'orbit')), leg = run.legs[i];
        const end = run.legs[i + (run.legs[i + 1]?.phase === 'phasing' ? 2 : 0)];
        const P = (l, m) => { const q = placeOnLeg({ world: 'Mars', cls: run.cls }, l, m).pos, c = bodyPos(w.body, m / DAY_MIN); const x = (q.x - c.x) * AU_M, y = (q.y - c.y) * AU_M; return { r: Math.hypot(x, y), th: Math.atan2(y, x) }; };
        const A = P(leg, leg.t0), B = P(end, end.t1), T = (end.t1 - leg.t0) * 60, span = ((B.th - A.th) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        const old = { phase: when, kind: 'path', t0: leg.t0, t1: end.t1, g: { rA: A.r, thA: A.th, rB: B.r, span, flat: 'both', vA: 0, vB: 0, a: 4 * (A.r * span) / T / T * 4, vm: 2 * (A.r * span) / T, T } };
        old.g.a = 2 * old.g.vm / T;
        run.legs.splice(i, run.legs.indexOf(end) - i + 1, old);
        getWorld(s).get(run.entity).flightPath.legs = run.legs;
        while (s.clock.minute < old.t0 + (old.t1 - old.t0) / 3) advance(s, 1);
        const { state: t } = deserialize(serialize(s));
        const r2 = t.shuttles.runs.find(x => x.id === run.id);
        assert(!r2.legs.some(l => l.kind === 'path' && l.t1 > t.clock.minute + 1e-6), `${when}: no old leg ahead after loading (${r2.legs.map(l => l.phase).join(' ')})`);
        const before = runReadout(s, run), after = runReadout(t, r2), loaded = t.clock.minute;
        flyRun(t, r2);
        assert(r2.phase === 'done' && !t.ship.crew.some(m => m.away), `${when}: home (${r2.phase})`);
        rows.push(`caught on its ${when}: planned again from ${fmt(before.h / 1000, 0)} km up (${fmt(after.h / 1000, 0)} after loading), home ${fmt(r2.doneAt - loaded, 0)} min later`);
        // (and the next run, on the game going on)
        flyRun(s, run);
      }
      console.log(`      ${rows.join(' · ')}`);
    },
  },
  {
    name: 'NPC carriers call at settled worlds; near one, their shuttles fly real runs where we can see them, and the carrier waits for its own; none leaves a shadow on the plot (seen going aboard or down, never in a station\'s digest, a lost one let go in hours), ours on telemetry',
    fn: () => {
      const s = inOrbit('Mars', { traffic: 3000, seed: 7 });
      advance(s, 2 * DAY_MIN);
      const calling = s.entities.filter(e => e.tags?.traffic && e.tags.call?.phase === 'planet');
      const worlds = new Set(calling.map(e => e.tags.planet));
      assert(calling.length > 20 && worlds.size >= 3 && calling.every(e => bayOf(e.cls).length), `${calling.length} on planetary calls, at ${[...worlds].join(', ')}`);
      let peak = 0, seen = new Set(), waited = 0, shadows = 0, ours = 0, oursOut = 0;
      const world = getWorld(s);
      const run = launchRun(s, planRun(s, s.shuttles.bay[0].id, airspacesOf(worldOf('Mars'))[0].id, {}).plan, () => {}, { crew: { pilot: shuttleCrew(s)[0].id } }).run;
      const craftFix = (id, r) => r.kind === 'fix' && (id.startsWith('npcsh-') || id === run.entity) && estimate(s, r, s.clock.minute);
      for (let i = 0; i < 6 * 60; i++) {
        advance(s, 1);
        peak = Math.max(peak, s.shuttles.npc.length);
        shadows = Math.max(shadows, Object.entries(s.intel.tracks).filter(([id, r]) => craftFix(id, r)).length);
        const e = world.get(run.entity);
        if (e && !e.$inBay) { oursOut++; if (liveKnowledge(s, e) === 'live') ours++; }
        for (const id of s.shuttles.npc) {
          seen.add(id);
          const e = world.get(id), c = e && world.get(e.tags.carrier);
          if (c && c.tags.shuttleOut === id && c.tags.call?.phase === 'planet' && c.tags.until > s.clock.minute) waited++;
        }
      }
      assert(seen.size >= 5 && peak <= 10 && waited > 0, `${seen.size} NPC shuttles seen, ${peak} out at once at most`);
      assert(shadows <= 2, `${shadows} shuttles' fixes coasting on the plot at once`);
      assert(oursOut > 60 && ours === oursOut, `ours on telemetry the whole way (${ours} of ${oursOut} minutes)`);
      // (an old save's: a pinnace's fix from a digest, seven hours old, is let go)
      const old = { id: 'npcsh-x', kind: 'fix', shipClass: 'Pinnace', at: s.clock.minute - 7 * 60, x: 1, y: 0, vx: 0, vy: 0 };
      assert(!estimate(s, old, s.clock.minute) && estimate(s, { ...old, shipClass: 'Corvette' }, s.clock.minute), 'an old shuttle fix let go, a ship\'s kept');
      const t = runMinutes('Mars', 'lander', 200, 2);
      assert(t > 0 && t < 3 * DAY_MIN, `200 t to Mars' ground by two landers: ${fmt(t / 60, 1)} h`);
      console.log(`      ${calling.length} carriers on planetary calls after two days (${[...worlds].join(', ')}); ${seen.size} NPC shuttles flown off Mars in six hours, ${peak} at once, ${shadows} left coasting on the plot at once; 200 t by two landers ${fmt(t / 60, 1)} h`);
    },
  },
  {
    name: 'the shuttle\'s cameras ride a craft that turns, never one that jumps: on the drive its nose along its push (its motion\'s own), its back through the push passing straight up or down, end for end between burns, belly first before the air; falling or climbing straight, its heading kept',
    fn: () => {
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const rows = [];
      for (const [world, classId] of [['Mars', 'ares'], ['Earth', 'ares'], ['Titan', 'ares'], ['Luna', 'freighter']]) {
        const s = inOrbit(world, { classId });
        const w = worldOf(world);
        const p = planRun(s, s.shuttles.bay[0].id, airspacesOf(w)[0].id, {});
        const r = launchRun(s, p.plan, () => {}, { crew: { pilot: shuttleCrew(s)[0].id } });
        assert(r.ok, `${world}: ${r.text}`);
        const run = r.run, path = { world, cls: run.cls };
        // the push against the motion's own second difference (less the pull), away from a burn's ends
        let off = 0;
        for (const leg of run.legs.filter(l => l.kind === 'xfer')) {
          const h = 2, T = (leg.t1 - leg.t0) * 60, B = xferBurns(w.GM, leg.x), ends = [B.t0, B.t1, B.t2, B.t3];
          const rel = (sec) => { const m = leg.t0 + sec / 60, q = placeOnLeg(path, leg, m).pos, c = bodyPos(w.body, m / DAY_MIN); return [(q.x - c.x) * AU_M, (q.y - c.y) * AU_M]; };
          for (let t = h; t < T - h; t += 17) {
            if (ends.some(e => Math.abs(t - e) < h + 5)) continue;
            const A = rel(t - h), P = rel(t), C = rel(t + h), rr = Math.hypot(...P), q = xferAt(w.GM, leg.x, t);
            const ax = (A[0] - 2 * P[0] + C[0]) / h / h + w.GM / rr ** 3 * P[0], ay = (A[1] - 2 * P[1] + C[1]) / h / h + w.GM / rr ** 3 * P[1];
            off = Math.max(off, Math.hypot(ax - q.ax, ay - q.ay));
          }
        }
        assert(off < 0.05, `${world}: the push is the motion's (${fmt(off, 3)} m/s² off at worst)`);
        // a frame every game second, the whole way: the nose and the back never far from the last frame's
        let worst = 1, at = '';
        for (const leg of run.legs) {
          if (leg.kind === 'dock') continue;
          let prev = null;
          for (let tm = leg.t0 + 1 / 60; tm < leg.t1 - 1 / 60; tm += 1 / 60) {
            const A = shuttleAttitude(s, run, tm);
            if (prev) { const d = Math.min(dot(prev.X, A.X), dot(prev.Z, A.Z)); if (d < worst) { worst = d; at = leg.phase; } }
            prev = A;
          }
        }
        assert(worst > 0.9, `${world}: the craft turns ${fmt(Math.acos(Math.min(1, worst)) * 180 / Math.PI, 0)}° in a second on its ${at}`);
        rows.push(`${world} ${run.cls}: the push ${fmt(off, 3)} m/s² from the motion, at most ${fmt(Math.acos(Math.min(1, worst)) * 180 / Math.PI, 1)}° a second (${at})`);
      }
      console.log(`      ${rows.join('\n      ')}`);
    },
  },
];
