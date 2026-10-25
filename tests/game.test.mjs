// Whole-game integration: every system ticking together, minute by minute.
import { extendLease } from '../js/sim/leases.js';
import { assert, fmt, dockHere } from './helpers.mjs';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, minuteTick, advance } from '../js/sim/game.js';
import { getWorld, backgroundBudget } from '../js/sim/world.js';
import { planRoutes, STANDOFF } from '../js/sim/nav.js';
import { engageRoute, overrideSecure } from '../js/sim/autopilot.js';
import { crewSecureStatus } from '../js/sim/crew-ai.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { forceDistress, acceptMission, completeRescue } from '../js/sim/missions.js';
import { createPlan } from '../js/sim/nav.js';
import { acceptContract, completeContract, dockedStation, hailContractTarget, deliverable } from '../js/sim/contracts.js';
import { spawnTrafficShip } from '../js/sim/traffic.js';
import { requestApproach } from '../js/sim/traffic-control.js';
import { shipGeometry, findPath, nearestNode } from '../js/sim/ship-layout.js';

function newGame(seed = 7) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ shipName: 'Test', captainName: 'Cap', crewCount: 6 });
  s.politics.quietUntil = Infinity;     // these tests fly and trade; encounters have their own suite
  return s;
}

function run(state, minutes, stop = null) {
  for (let i = 0; i < minutes; i++) {
    advance(state, 1);
    if (stop && stop(state)) return i + 1;
  }
  return minutes;
}

/** Fly a route into a port as a captain does: hailing for approach clearance on entering its control space. */
function flyIn(state, stationId, minutes) {
  let asked = false;
  return run(state, minutes, st => {
    if (!asked && st.tc?.zone === 'control' && st.tc.station === stationId) asked = requestApproach(st, stationId).ok;
    return !st.autopilot;
  });
}

function checkFinite(state) {
  const f = state.flight;
  for (const v of [f.pos.x, f.pos.y, f.vel.vx, f.vel.vy, f.facing]) assert(Number.isFinite(v), 'non-finite flight state');
  for (const e of state.entities) assert(Number.isFinite(e.pos.x) && Number.isFinite(e.vel.vx), `non-finite entity ${e.id}`);
  for (const [k, r] of Object.entries(state.resources)) assert(Number.isFinite(r.current), `non-finite resource ${k}`);
}

export default [
  {
    name: 'ladder shaft connects every deck',
    fn: () => {
      const s = newGame();
      const geo = shipGeometry(s.ship);
      const bridge = nearestNode(geo, 3, 1);
      const reactor = nearestNode(geo, 3, geo.deckStart[s.ship.decks.length - 1]);
      const p = findPath(geo, bridge, reactor);
      assert(p && p.length > 10, 'no path bridge → reactor');
      assert(geo.shafts.length === s.ship.decks.length - 1, `expected ${s.ship.decks.length - 1} shaft links, got ${geo.shafts.length}`);
      // every fixture someone has to stand at is reachable
      for (const [kind, list] of Object.entries(geo.fixtures)) {
        if (kind === 'storage') continue;
        for (const f of list) {
          assert(f.access != null, `${f.id} has no access tile`);
          assert(findPath(geo, bridge, f.access), `${f.id} unreachable`);
        }
      }
    },
  },
  {
    name: 'three idle days: stable, parked at Ceres, crew healthy, traffic moving',
    fn: () => {
      const s = newGame();
      const world = getWorld(s);
      const home = world.get('ceres-station');
      const d0 = Math.hypot(home.pos.x - s.flight.pos.x, home.pos.y - s.flight.pos.y) * AU_M;
      assert(extendLease(s, 72).ok, 'three days in the berth, paid for');
      run(s, 3 * DAY_MIN);
      checkFinite(s);
      const d = Math.hypot(home.pos.x - s.flight.pos.x, home.pos.y - s.flight.pos.y) * AU_M;
      assert(s.dock?.phase === 'docked' && dockedStation(s)?.id === 'ceres-station', 'should still be in our berth');
      assert(Math.abs(d - d0) < 1, `drifted off the berth: ${d0} → ${d} m from the station's centre`);
      assert(s.ship.crew.every(m => !m.dead && m.consciousness > 90), 'crew should be fine');
      assert(s.resources.water.current < 4200, 'water should be consumed');
      const moving = s.entities.filter(e => e.tags?.traffic && e.transit).length;
      console.log(`      traffic in transit: ${moving}/${s.entities.filter(e => e.tags?.traffic).length}, crew activities: ${s.ship.crew.map(m => m.activity).join(',')}`);
      assert(moving > 0, 'some traffic should be in transit');
    },
  },
  {
    name: 'autopilot trip: crew secure, engage, fly, arrive at Vesta Depot\'s gate, dock',
    fn: async () => {
      const s = newGame();
      s.traffic.forces = false;         // (a trip, not a fight: no pirate lying up on the way wakes)
      const opts = planRoutes(s, { kind: 'entity', id: 'vesta-depot' });
      const std = opts.find(o => o.name === 'STANDARD');
      engageRoute(s, std.plan, { estimate: std.estimate });
      const events = [];
      bus.on('*', (t) => events.push(t));
      const engagedAfter = run(s, 120, st => st.autopilot?.phase === 'active');
      const sec = crewSecureStatus(s);
      console.log(`      engaged after ${engagedAfter} min with ${sec.secured}/${sec.total} secured`);
      assert(s.autopilot?.phase === 'active', 'should engage once crew secured');
      const flew = run(s, std.estimate.minutes + 2000, st => !st.autopilot);
      checkFinite(s);
      assert(!s.autopilot, `did not arrive (${fmt(flew / 60)}h flown)`);
      assert(s.flight.hold?.id === 'vesta-depot-gate', `should hold at the gate, holds ${s.flight.hold?.id}`);
      assert(events.includes('route-arrived'), 'arrival event');
      const dockMin = await dockHere(s, 'vesta-depot', advance);
      assert(dockedStation(s)?.id === 'vesta-depot', 'should be docked');
      console.log(`      docked ${dockMin} min after reaching the gate (${s.dock.bumps} bumps, ${fmt(s.dock.fuel, 2)} kg of RCS)`);
      const dead = s.ship.crew.filter(m => m.dead).length;
      console.log(`      flew ${fmt(flew / 60)}h (est ${fmt(std.estimate.minutes / 60)}h), fuel left ${fmt(s.resources.fuel.current)}kg, dead ${dead}, inertia events ${events.filter(e => e === 'inertia-start').length}`);
      assert(dead === 0, 'nobody should die on a 1G trip');
    },
  },
  {
    name: 'override launches with unsecured crew',
    fn: () => {
      const s = newGame();
      const opts = planRoutes(s, { kind: 'entity', id: 'pallas-station' });
      engageRoute(s, opts.find(o => o.name === 'EXPRESS').plan);
      overrideSecure(s);
      // the override skips waiting for the crew — but never for the pilot
      const t = run(s, 60, st => st.autopilot?.phase === 'active');
      const sec = crewSecureStatus(s);
      console.log(`      engaged after ${t} min, ${sec.secured}/${sec.total} secured`);
      assert(s.autopilot?.phase === 'active', 'override should engage once the pilot is at the helm');
      assert(sec.pilotReady, 'pilot must be seated');
    },
  },
  {
    name: 'save → load round trip continues identically',
    fn: () => {
      const s = newGame(11);
      run(s, 600);
      const opts = planRoutes(s, { kind: 'body', id: 'Mars' });
      engageRoute(s, opts.find(o => o.name === 'STANDARD').plan);
      run(s, 300);
      const json = serialize(s);
      assert(!json.includes('"$'), 'runtime keys leaked into save');
      const { state: s2 } = deserialize(json);
      seedRandom(99); run(s, 400);
      seedRandom(99); run(s2, 400);
      const d = Math.hypot(s.flight.pos.x - s2.flight.pos.x, s.flight.pos.y - s2.flight.pos.y) * AU_M;
      console.log(`      save size ${fmt(json.length / 1024)} KB, divergence after 400 min: ${fmt(d, 3)} m`);
      assert(d < 1, 'loaded game diverged');
      assert(s2.resources.credits.max === Infinity, 'Infinity must survive');
    },
  },
  {
    name: 'SOS: offered, accepted, intercepted, rescued',
    fn: () => {
      const s = newGame(5);
      let offer = null;
      bus.on('sos-offered', (p) => { offer = p; });
      for (let i = 0; i < 20 && !(offer && offer.mission.type !== 'RUNAWAY' && offer.feasibility.feasible); i++) {
        offer = null; forceDistress(s, (t, p) => bus.emit(t, p));
      }
      assert(offer && offer.feasibility.feasible, 'no feasible distress call generated');
      const m = offer.mission;
      acceptMission(s, m.id);
      const plan = createPlan('closing', { kind: 'entity', id: m.entityId }, { accelG: offer.feasibility.g, standoff: STANDOFF.TACTICAL });
      engageRoute(s, plan, { missionId: m.id, intercept: 'tactical' });
      run(s, 20, st => st.autopilot?.phase === 'active');
      overrideSecure(s);
      const t = run(s, m.timer, st => !st.autopilot);
      assert(!s.autopilot && s.flight.hold?.id === m.entityId, `no formation after ${t} min`);
      const r = completeRescue(s, m.id);
      console.log(`      ${m.type} rescued after ${fmt(t / 60)}h: ${r.success}`);
      assert(r.success, r.text);
      assert(s.missions.list.find(x => x.id === m.id).status === 'completed', 'mission status');
    },
  },
  {
    name: 'contracts: cargo delivery and field investigation complete end to end',
    fn: async () => {
      const s = newGame(21);
      run(s, 20);   // boards populate
      const home = getWorld(s).get('ceres-station');
      let cargo = home.board.missions.find(c => c.type === 'CARGO');
      for (let i = 0; i < 30 && !cargo; i++) { home.board.lastRefresh = -Infinity; home.board.missions = []; run(s, 10); cargo = home.board.missions.find(c => c.type === 'CARGO'); }
      assert(cargo, 'no cargo contract generated');
      const acc = acceptContract(s, home.id, cargo.id);
      assert(acc.ok, acc.text);
      assert(s.cargo.length === 1, 'cargo loaded');
      const route = planRoutes(s, { kind: 'entity', id: cargo.dest }).find(o => o.name === 'EXPRESS');
      engageRoute(s, route.plan);
      run(s, 30, st => st.autopilot?.phase === 'active'); overrideSecure(s);
      flyIn(s, cargo.dest, route.estimate.minutes + 3000);
      await dockHere(s, cargo.dest, advance);
      const docked = dockedStation(s);
      assert(docked?.id === cargo.dest, `not docked at destination: ap=${s.autopilot?.phase}/${s.autopilot?.display} hold=${JSON.stringify(s.flight.hold)} dest=${cargo.dest} d=${s.autopilot?.d}`);
      assert(deliverable(s, docked).length >= 1, `nothing deliverable: ${JSON.stringify(s.contracts.active.map(c => [c.type, c.phase, c.dest, c.dueAt - s.clock.minute]))} ${JSON.stringify(s.contracts.history?.slice?.(-2) ?? s.contracts.archive?.slice?.(-2))}`);
      const credits = s.resources.credits.current;
      const done = completeContract(s, cargo.id);
      assert(done.ok, done.text);
      assert(s.resources.credits.current > credits && s.cargo.length === 0, 'payment and unload');

      // Field contract from wherever we are now
      let field;
      for (let i = 0; i < 40 && !field; i++) { docked.board.lastRefresh = -Infinity; docked.board.missions = []; run(s, 10); field = docked.board.missions.find(c => c.type === 'INVESTIGATE'); }
      assert(field, 'no investigate contract');
      assert(acceptContract(s, docked.id, field.id).ok, 'accept field');
      const toTarget = planRoutes(s, { kind: 'entity', id: field.targetId }).find(o => o.name === 'STANDARD');
      engageRoute(s, toTarget.plan); run(s, 30, st => st.autopilot?.phase === 'active'); overrideSecure(s);
      run(s, toTarget.estimate.minutes + 2000, st => !st.autopilot);
      const h = hailContractTarget(s, field.targetId);
      assert(h?.ok, h?.text || 'hail failed');
      const back = planRoutes(s, { kind: 'entity', id: docked.id }).find(o => o.name === 'STANDARD');
      engageRoute(s, back.plan); run(s, 30, st => st.autopilot?.phase === 'active'); overrideSecure(s);
      flyIn(s, docked.id, back.estimate.minutes + 2000);
      await dockHere(s, docked.id, advance);
      const fin = completeContract(s, field.id);
      console.log(`      ${cargo.title} → ok; ${field.title} → ${fin.ok}`);
      assert(fin.ok, fin.text);
    },
  },
  {
    name: 'scale: 200k NPC ships — per-minute tick budget',
    fn: () => {
      const s = newGame(3);
      // Spread like a real system: most ships in transit across the belt, not parked at 8 stations
      const world = getWorld(s);
      const t0 = performance.now();
      for (let i = 0; i < 200_000; i++) {
        const e = spawnTrafficShip(s);
        e.tags.until = s.clock.minute + (i % 997);     // staggered departures
        world.plan(e);                                  // (its timing changed outside a visit: the calendar is told)
      }
      const tSpawn = performance.now() - t0;
      run(s, 24 * 60);                                 // one day: most of the fleet departs
      const inTransit = s.entities.filter(e => e.transit).length;
      // Per-minute sim cost (what 1x/2x pays), and a 3x frame: 24 minutes + one capped background pass
      let t1 = performance.now();
      for (let i = 0; i < 120; i++) minuteTick(s);
      const perMinute = (performance.now() - t1) / 120;
      t1 = performance.now();
      for (let f = 0; f < 10; f++) { for (let i = 0; i < 24; i++) minuteTick(s, { lite: i < 23 }); world.background(s.clock.minute, backgroundBudget(world.count, 24)); }
      const per3xFrame = (performance.now() - t1) / 10;
      console.log(`      ${s.entities.length.toLocaleString()} entities (${inTransit.toLocaleString()} in transit): spawn ${fmt(tSpawn)} ms · ${fmt(perMinute, 2)} ms/game-minute · ${fmt(per3xFrame, 1)} ms per 1-day/s frame`);
      checkFinite(s);
      assert(tSpawn < 5000, 'spawning is too slow');
      // Pathological density: ~19k ships within sensor range of Ceres. Still well inside a frame.
      assert(perMinute < 8, `per-minute tick too slow: ${perMinute} ms`);
      assert(per3xFrame < 33, `1-day/s frame too slow: ${per3xFrame} ms`);
    },
  },
];
