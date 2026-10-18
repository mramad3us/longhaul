// Flight & guidance: every route type must actually arrive, on the target,
// co-moving, under real gravity — and the live loop must match estimates.
import { assert, fmt } from './helpers.mjs';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { createClock } from '../js/core/clock.js';
import { getWorld } from '../js/sim/world.js';
import { createDefaultEntities, createEntity } from '../js/sim/entities.js';
import { createFlight, flightStep, fuelUsed } from '../js/sim/flight.js';
import { createPlan, guidanceStep, planRoutes, simulatePlan, targetStateAt, STANDOFF } from '../js/sim/nav.js';
import { solveLambert } from '../js/sim/lambert.js';
import { stepFree } from '../js/sim/world.js';

function miniState(startId = 'ceres-station') {
  seedRandom(42);
  const state = {
    clock: createClock(),
    entities: createDefaultEntities(),
    resources: { fuel: { current: 8500, max: 10000 } },
    nextEntityId: 1,
  };
  const world = getWorld(state);
  const home = world.get(startId);
  state.flight = createFlight({ x: home.pos.x + 3000 / AU_M, y: home.pos.y }, home.vel, 0);
  return state;
}

/** Fly a plan live, minute by minute, exactly as the game loop will. */
function flyLive(state, plan, maxMin) {
  const world = getWorld(state);
  let fuel = 0;
  for (let i = 0; i < maxMin; i++) {
    const t = state.clock.minute;
    world.tick(t, state.flight.pos);
    const tgt = targetStateAt(state, plan.target, t, true);
    const arrival = plan.kind === 'transfer' ? targetStateAt(state, plan.target, plan.arriveAt) : null;
    const g = guidanceStep(plan, state.flight, t, tgt, arrival);
    if (g.arrived) return { arrived: true, minutes: i, fuel, d: g.d, v: g.relSpeed };
    const out = flightStep(state.flight, g.cmd, 1);
    fuel += fuelUsed(out.mainG, out.rcsG);
    state.clock.minute++;
  }
  const tgt = targetStateAt(state, plan.target, state.clock.minute, true);
  return { arrived: false, minutes: maxMin, fuel, d: Math.hypot(tgt.pos.x - state.flight.pos.x, tgt.pos.y - state.flight.pos.y) * AU_M };
}

export default [
  {
    name: 'Lambert reproduces a propagated arc',
    fn: () => {
      const pos = { x: 2.77, y: 0.1 }, vel = { vx: -1500, vy: 17500 };
      const p0 = { ...pos };
      for (let i = 0; i < 40 * 1440 / 10; i++) stepFree(pos, vel, 600);
      const s = solveLambert(p0.x * AU_M, p0.y * AU_M, pos.x * AU_M, pos.y * AU_M, 40 * 86400);
      assert(s, 'no solution');
      assert(Math.abs(s.v1x - -1500) < 5 && Math.abs(s.v1y - 17500) < 5, `v1 mismatch ${s.v1x},${s.v1y}`);
    },
  },
  {
    name: '1G brachistochrone Ceres Station → Vesta Depot arrives co-moving',
    fn: () => {
      const state = miniState();
      const plan = createPlan('closing', { kind: 'entity', id: 'vesta-depot' }, { accelG: 1, standoff: STANDOFF.STATION });
      const est = simulatePlan(state, plan);
      const live = flyLive(state, { ...plan }, est.minutes + 600);
      console.log(`      est ${fmt(est.minutes / 60)}h fuel ${fmt(est.fuel)}kg · live ${fmt(live.minutes / 60)}h fuel ${fmt(live.fuel)}kg, d=${fmt(live.d)}m v=${fmt(live.v, 2)}m/s`);
      assert(live.arrived, 'did not arrive');
      assert(Math.abs(live.minutes - est.minutes) <= Math.max(5, est.minutes * 0.01), 'estimate mismatch');
      assert(live.d < STANDOFF.STATION + 200, 'too far from target');
    },
  },
  {
    name: '3G express to Mars arrives',
    fn: () => {
      const state = miniState();
      const plan = createPlan('closing', { kind: 'body', id: 'Mars' }, { accelG: 3, standoff: 10_000_000 });
      const live = flyLive(state, plan, 20 * DAY_MIN);
      console.log(`      ${fmt(live.minutes / 1440, 2)} days, fuel ${fmt(live.fuel)} kg`);
      assert(live.arrived, `did not arrive (d=${fmt(live.d / 1000)} km)`);
    },
  },
  {
    name: 'economy cruise caps speed and saves fuel vs brachistochrone',
    fn: () => {
      const state = miniState();
      const opts = planRoutes(state, { kind: 'entity', id: 'pallas-station' });
      const byName = Object.fromEntries(opts.map(o => [o.name, o]));
      for (const o of opts) console.log(`      ${o.name.padEnd(10)} ${fmt(o.minutes / 1440, 2)}d fuel ${fmt(o.fuel)}kg peak ${fmt(o.estimate.peakSpeed / 1000)}km/s ${o.feasible ? '' : '✗ ' + o.reason}`);
      assert(byName.ECONOMY.estimate.arrived && byName.BELTER.estimate.arrived, 'not arrived');
      assert(byName.ECONOMY.fuel < byName.BELTER.fuel * 0.8, 'economy should save fuel');
      assert(byName.EXPRESS.minutes < byName.STANDARD.minutes, 'express should be faster');
    },
  },
  {
    name: 'ballistic Lambert transfer reaches Vesta cheaply',
    fn: () => {
      const state = miniState();
      const opts = planRoutes(state, { kind: 'entity', id: 'vesta-depot' });
      const b = opts.find(o => o.name === 'BALLISTIC');
      const s = opts.find(o => o.name === 'STANDARD');
      assert(b, 'no ballistic option');
      console.log(`      ballistic ${fmt(b.minutes / 1440)}d fuel ${fmt(b.fuel)}kg Δv ${fmt(b.estimate.dv / 1000, 2)}km/s · standard fuel ${fmt(s.fuel)}kg`);
      assert(b.estimate.arrived, 'ballistic did not arrive');
      const live = flyLive(state, { ...b.plan }, b.estimate.minutes + DAY_MIN);
      assert(live.arrived, `live ballistic did not arrive d=${fmt(live.d / 1000)}km`);
    },
  },
  {
    name: 'intercepts a drifting ship with sideways relative velocity',
    fn: () => {
      const state = miniState();
      const world = getWorld(state);
      const sp = state.flight.pos;
      const e = createEntity({
        id: 'drifter', name: 'Drifter', type: 'ship',
        pos: { x: sp.x + 0.01, y: sp.y + 0.004 },
        vel: { vx: state.flight.vel.vx + 900, vy: state.flight.vel.vy - 2500 },
        t: state.clock.minute,
      });
      world.add(e);
      const plan = createPlan('closing', { kind: 'entity', id: 'drifter' }, { accelG: 1, standoff: STANDOFF.TACTICAL });
      const live = flyLive(state, plan, 3 * DAY_MIN);
      console.log(`      ${fmt(live.minutes / 60)}h, d=${fmt(live.d)}m v=${fmt(live.v, 2)}m/s`);
      assert(live.arrived, 'did not arrive');
    },
  },
  {
    name: 'catches a runaway ship burning at 2.5G',
    fn: () => {
      const state = miniState();
      const world = getWorld(state);
      const sp = state.flight.pos;
      world.add(createEntity({
        id: 'runaway', name: 'Runaway', type: 'ship',
        pos: { x: sp.x + 0.003, y: sp.y }, vel: { ...state.flight.vel },
        thrust: 2.5, heading: 1.2, t: state.clock.minute,
      }));
      const plan = createPlan('closing', { kind: 'entity', id: 'runaway' }, { accelG: 4, standoff: STANDOFF.TACTICAL });
      const live = flyLive(state, plan, 2 * DAY_MIN);
      console.log(`      ${fmt(live.minutes / 60)}h, d=${fmt(live.d)}m`);
      assert(live.arrived, 'did not catch runaway');
    },
  },
];
