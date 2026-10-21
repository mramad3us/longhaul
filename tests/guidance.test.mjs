// Guidance quality: fly many approaches and hold the closing law to how they
// look from the bridge. A clean approach turns the ship only for the moves
// that mean something (lining up, the flip, the turn to hold on the target),
// never backs off, and doesn't wobble. Covers stations, moons and bodies at
// every route G, economy cruise, a failing drive, slow RCS, a pilot flying
// by hand, and intercepts of ships coasting and under thrust.
import { setGravityEpoch, nearestSurface } from '../js/sim/gravity.js';
import { assert, fmt } from './helpers.mjs';
import { AU_M, G0, MIN_S, DAY_MIN, GM_SUN } from '../js/core/constants.js';
import { seedRandom, gaussian } from '../js/core/rng.js';
import { createClock } from '../js/core/clock.js';
import { getWorld, stepFree } from '../js/sim/world.js';
import { createDefaultEntities } from '../js/sim/entities.js';
import { createFlight, flightStep, SLEW_RATE } from '../js/sim/flight.js';
import { createPlan, guidanceStep, targetStateAt, planRoutes, defaultStandoff } from '../js/sim/nav.js';

function miniState() {
  seedRandom(42);
  const state = { clock: createClock(), entities: createDefaultEntities(), resources: { fuel: { current: 1e9, max: 1e9 } }, nextEntityId: 1 };
  const home = getWorld(state).get('ceres-station');
  state.flight = createFlight({ x: home.pos.x + 3000 / AU_M, y: home.pos.y }, home.vel, 0);
  state.flight.maxG = 12;
  return state;
}

/**
 * Fly a plan and count what makes an approach look wrong:
 * - turns: reorientations (minutes turning faster than a drive-lit lean,
 *   8.6°/min, adding up to more than 35°)
 * - wobbles: the nose turning back the other way (by > 10°) within 3 minutes
 * - back: the fastest the ship ever opened the range again after closing (m/s)
 * opts: { synth: {pos, vel, thrustG, heading}, capAt: {minute, g}, slew, noise, maxMin }
 */
function fly(state, plan, opts = {}) {
  const f = state.flight;
  const world = getWorld(state);
  const synth = opts.synth;
  let turns = 0, inTurn = false, sweep = 0, wobbles = 0, lastSign = 0, lastAt = -99, closing = false, back = 0, err = 0, g = null, i = 0, flyby = Infinity, via = false;
  for (; i < (opts.maxMin ?? 30 * DAY_MIN); i++) {
    const t = state.clock.minute;
    setGravityEpoch(t);              // (as the minute tick does: gravity.js)
    if (opts.capAt && i === opts.capAt.minute) f.maxG = opts.capAt.g;
    if (opts.slew) f.$slew = opts.slew;
    let tgt;
    if (synth) tgt = { pos: synth.pos, vel: synth.vel, ax: synth.thrustG * G0 * Math.cos(synth.heading), ay: synth.thrustG * G0 * Math.sin(synth.heading) };
    else { world.tick(t, f.pos); tgt = targetStateAt(state, plan.target, t, true); }
    g = guidanceStep(plan, f, t, tgt, null);
    if (g.arrived) break;
    if (g.via) via = true;
    let cmd = g.cmd;
    if (opts.noise) {
      err = 0.95 * err + Math.sqrt(1 - 0.95 * 0.95) * opts.noise * gaussian();
      const c = Math.cos(err), s = Math.sin(err), k = 1 + gaussian() * opts.noise * 0.3;
      cmd = { ...cmd, ax: (cmd.ax * c - cmd.ay * s) * k, ay: (cmd.ax * s + cmd.ay * c) * k };
    }
    const out = flightStep(f, cmd, 1);
    const surf = nearestSurface(f.pos.x, f.pos.y, t);
    if (surf && surf.body.type === 'planet') flyby = Math.min(flyby, surf.alt / 1000);
    if (synth) stepFree(synth.pos, synth.vel, MIN_S, synth.thrustG, synth.heading);
    if (Math.abs(out.turned) > 0.15) { sweep += Math.abs(out.turned); if (!inTurn && sweep > 0.6) { turns++; inTurn = true; } } else { sweep = 0; inTurn = false; }
    if (Math.abs(out.turned) > 0.175) { const sg = Math.sign(out.turned); if (lastSign && sg !== lastSign && i - lastAt <= 3) wobbles++; lastSign = sg; lastAt = i; }
    if (g.vClose > 5) closing = true;
    if (closing) back = Math.max(back, -g.vClose);
    state.clock.minute++;
  }
  return { arrived: !!g?.arrived, minutes: i, turns, wobbles, back, flyby, via };
}

/** A ship ahead of us at 2.7 AU, our relative velocity at `angleDeg` from the line to it, our nose at `facing`. */
function synthetic({ rangeKm, vRel = 0, angleDeg = 0, G, thrust = 0, heading = 0, facing = 0, maxMin = 20000 }) {
  const state = miniState();
  const f = state.flight;
  const vOrb = Math.sqrt(GM_SUN / (2.7 * AU_M));
  f.pos.x = 2.7; f.pos.y = 0; f.vel.vx = 0; f.vel.vy = vOrb; f.facing = facing * Math.PI / 180;
  const a = angleDeg * Math.PI / 180;
  const synth = {
    pos: { x: 2.7 + rangeKm * 1000 / AU_M, y: 0 },
    vel: { vx: -vRel * Math.cos(a), vy: vOrb - vRel * Math.sin(a) },
    thrustG: thrust, heading: heading * Math.PI / 180,
  };
  return fly(state, createPlan('closing', { kind: 'entity', id: 'synthetic' }, { accelG: G, standoff: 2000 }), { synth, maxMin });
}

// A route to a station ends at its approach gate (stations.js); the rest is docking
const station = (id, accelG, opts) => {
  const state = miniState();
  const gate = getWorld(state).get(`${id}-gate`);
  return fly(state, createPlan('closing', { kind: 'entity', id: gate ? gate.id : id }, { accelG, standoff: gate ? 1000 : 3000 }), opts);
};
const line = (label, r) => console.log(`      ${label.padEnd(36)} ${String(r.minutes).padStart(6)} min · ${r.turns} turns · ${r.wobbles} wobbles · backed off ${fmt(r.back, 0)} m/s`);

export default [
  {
    name: 'stations and moons at every route G: line up, flip, turn to hold, arrive',
    fn: () => {
      const bad = [];
      for (const id of ['vesta-depot', 'pallas-station', 'mcrn-scirocco', 'unn-agatha-king', 'tycho-station', 'luna-yards', 'ganymede-station', 'phobos-yard']) {
        for (const G of [0.3, 1, 3, 5, 10]) {
          const r = station(id, G);
          // (routes don't steer round bodies yet: one that grazes a planet is
          // thrown about by it, and the guidance takes a turn or two more)
          // (nor does a target behind a rock come straight: the route goes
          // by points round it, each a leg and its turns more, and the line
          // of sight swings round when it turns for the target. A slow ship
          // round Vesta, or a fast one round Ganymede past Jupiter, takes up
          // to a dozen turns: the old single waypoint was tidier, but waited
          // at it for hours while the rock turned the gate away)
          const turnsOK = r.via ? 12 : r.flyby < 2000 ? 5 : 3;
          if (!r.arrived || r.turns > turnsOK || r.wobbles > (r.via ? 4 : 1) || (!r.via && r.back > 30)) bad.push(`${id} ${G}G: ${JSON.stringify(r)}`);
          if (G === 0.3 || G === 10) line(`${id} ${G}G`, r);
        }
      }
      for (const id of ['Mars', 'Io', 'Mimas', 'Ganymede']) {
        for (const G of [1, 5]) {
          const s = miniState();
          const r = fly(s, createPlan('closing', { kind: 'body', id }, { accelG: G, standoff: defaultStandoff(s, { kind: 'body', id }) }));
          if (!r.arrived || r.turns > 3 || r.wobbles > 0 || r.back > 5) bad.push(`${id} ${G}G: ${JSON.stringify(r)}`);
        }
      }
      for (const id of ['vesta-depot', 'luna-yards']) {
        const plan = planRoutes(miniState(), { kind: 'entity', id }, { includeBallistic: false }).find(o => o.name === 'ECONOMY').plan;
        const r = fly(miniState(), plan);
        line(`${id} economy`, r);
        // (round a rock, or a station's keep-out, by waypoints: a wobble or two as the line of sight swings, as above)
        if (!r.arrived || r.turns > (r.via ? 8 : 3) || r.wobbles > (r.via ? 2 : 0) || (!r.via && r.back > 5)) bad.push(`${id} economy: ${JSON.stringify(r)}`);
      }
      assert(bad.length === 0, `untidy approaches:\n        ${bad.join('\n        ')}`);
    },
  },
  {
    name: 'a failing drive, slow RCS and a pilot flying by hand still arrive cleanly',
    fn: () => {
      // the drive capped at 2G at top speed on a 5G run: the ship can no longer stop in time, so one overshoot and back
      const capped = station('vesta-depot', 5, { capAt: { minute: 2000, g: 2 } });
      const slow = station('vesta-depot', 3, { slew: SLEW_RATE * 0.4 });
      const luna = station('luna-yards', 3, { noise: 0.05 });
      const vesta = station('vesta-depot', 1, { noise: 0.08 });
      line('Vesta 5G, drive capped to 2G', capped);
      line('Vesta 3G, RCS at 40%', slow);
      line('Luna Yards 3G, hand-flown', luna);
      line('Vesta 1G, hand-flown', vesta);
      assert(capped.arrived && capped.turns <= 3, 'capped drive');
      assert(slow.arrived && slow.turns <= (slow.via ? 3 : 2) && (slow.via || slow.back < 5), `slow slew: ${JSON.stringify(slow)}`);
      // (round a rock or a station's keep-out by waypoints, a leg and its turns more)
      for (const r of [luna, vesta]) assert(r.arrived && r.turns <= (r.via ? 5 : 3) && r.back < 30, `hand-flown: ${JSON.stringify(r)}`);
    },
  },
  {
    name: 'intercepts: coasting and crossing ships, and ships under thrust in any direction',
    fn: () => {
      const bad = [];
      for (const G of [1, 3, 10]) {
        for (const [rangeKm, vRel, angleDeg] of [[3, 0, 0], [50_000, 0, 0], [500_000, 0, 0], [5_000_000, 0, 0], [500_000, 20_000, 90],
          [500_000, 50_000, 0], [500_000, 50_000, 180], [2_000_000, 80_000, 135], [30_000, 2_000, 90], [200, 300, 0]]) {
          const r = synthetic({ G, rangeKm, vRel, angleDeg });
          if (!r.arrived || r.turns > 2 || r.wobbles > 0 || r.back > 5) bad.push(`${G}G ${rangeKm} km ${vRel} m/s @${angleDeg}°: ${JSON.stringify(r)}`);
        }
      }
      for (const G of [3, 10]) {
        for (const thrust of [0.3, 1, 2.5]) {
          for (const heading of [0, 45, 90, 135, 180]) {
            const r = synthetic({ G, rangeKm: 1_000_000, thrust, heading });
            // a target with five-sixths of our thrust, sideways, can still make us back off a little at the end
            const backMax = thrust / G > 0.8 ? 150 : 5;
            if (!r.arrived || r.turns > 3 || r.wobbles > 0 || r.back > backMax) bad.push(`${G}G vs ${thrust}G at ${heading}°: ${JSON.stringify(r)}`);
            if (thrust === 2.5 && (heading === 90 || heading === 0)) line(`${G}G after a ${thrust}G ship at ${heading}°`, r);
          }
        }
      }
      const dash = synthetic({ G: 10, rangeKm: 50_000 });
      line('10G dash, 50,000 km', dash);
      assert(dash.minutes <= 40, `a 50,000 km dash at 10G took ${dash.minutes} min`);
      assert(bad.length === 0, `untidy intercepts:\n        ${bad.join('\n        ')}`);
    },
  },
  {
    name: 'routes that start close: any nose, a target pulling any way, onto the stop point without circling',
    fn: () => {
      // Close in the closing law has no room to plan its hold turn, and a
      // ship off its plan there has nothing to fall back on: the keep law
      // flies it (nav.js). A target thrusting away still makes us chase it.
      // (a pull barely more than RCS can hold, met with the nose the wrong
      // way, can cost a wobble or two while the nose finds it)
      const bad = [];
      let total = 0, turns = 0, wobbles = 0;
      for (const rangeKm of [3, 10, 30, 100]) {
        for (const thrust of [0, 0.03, 0.1, 0.3, 1]) {
          for (const heading of thrust ? [0, 90, 180] : [0]) {
            for (const facing of [0, 90, 180]) {
              const r = synthetic({ G: 3, rangeKm, thrust, heading, facing, maxMin: 600 });
              total += r.minutes; turns += r.turns; wobbles += r.wobbles;
              if (!r.arrived || r.turns > 4 || r.wobbles > 2 || r.minutes > 45) bad.push(`${rangeKm} km, ${thrust}G at ${heading}°, nose ${facing}°: ${JSON.stringify(r)}`);
            }
          }
        }
      }
      console.log(`      156 close starts: ${total} min, ${turns} turns, ${wobbles} wobbles`);
      assert(bad.length === 0, `untidy close starts:\n        ${bad.join('\n        ')}`);
      assert(total < 3200 && turns < 150 && wobbles < 40, 'close starts got worse overall');
      // a coasting target 100 km ahead, nose on: burn, flip, brake
      const plain = synthetic({ G: 3, rangeKm: 100 });
      line('3G, coasting target 100 km ahead', plain);
      assert(plain.arrived && plain.turns <= 1 && plain.minutes <= 20, `${JSON.stringify(plain)}`);
    },
  },
];
