// Stances (stance.js): keeping a place relative to a target until released.
// Held to the approach tests' standard: onto the stance point from near or
// far, then kept there without circling, wobbling or burning for nothing;
// the guards never let the range through; and the doctrine under fire.
import { assert, fmt } from './helpers.mjs';
import { AU_M, G0, MIN_S, GM_SUN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createClock } from '../js/core/clock.js';
import { getWorld, stepFree } from '../js/sim/world.js';
import { createDefaultEntities } from '../js/sim/entities.js';
import { createFlight, flightStep, fuelUsed } from '../js/sim/flight.js';
import { guidanceStep, targetStateAt } from '../js/sim/nav.js';
import { createStance, stanceBand, stanceRanges } from '../js/sim/stance.js';
import { createGame, advance } from '../js/sim/game.js';
import { engageStance, overrideSecure, releaseHold } from '../js/sim/autopilot.js';
import { spawnAgent } from '../js/sim/agents.js';
import { launchTorpedo } from '../js/sim/ordnance.js';
import { PLAYER } from '../js/sim/combatants.js';
import { sensorsTick } from '../js/sim/sensors.js';
import { serialize, deserialize } from '../js/sim/save.js';

function miniState() {
  seedRandom(42);
  const state = { clock: createClock(), entities: createDefaultEntities(), resources: { fuel: { current: 1e9, max: 1e9 } }, nextEntityId: 1 };
  const home = getWorld(state).get('ceres-station');
  state.flight = createFlight({ x: home.pos.x + 3000 / AU_M, y: home.pos.y }, home.vel, 0);
  state.flight.maxG = 12;
  return state;
}

/**
 * Fly a stance for `minutes` against a target `startKm` ahead of us (a ship
 * coasting or under thrust, or a station) and measure it once settled:
 * minR/maxR (km), maxErr (m off the stance point), holdBurn (minutes the drive
 * was lit while settled), cuts (times the drive cut out while settled),
 * unsettle (times it fell out of place), turns, wobbles (as in
 * guidance.test.mjs) and fuel.
 */
function fly({ mode = 'hold', rangeKm, startKm, vRel = 0, angleDeg = 0, G = 3, thrust = 0, heading = 0, facing = 0, tight = true, minutes = 3000, stationId = null }) {
  const state = miniState();
  const f = state.flight;
  let synth = null, target;
  if (stationId) {
    target = { kind: 'entity', id: stationId };
    const st = getWorld(state).get(stationId);
    f.pos.x = st.pos.x + startKm * 1000 / AU_M; f.pos.y = st.pos.y; f.vel.vx = st.vel.vx; f.vel.vy = st.vel.vy;
  } else {
    const vOrb = Math.sqrt(GM_SUN / (2.7 * AU_M));
    f.pos.x = 2.7; f.pos.y = 0; f.vel.vx = 0; f.vel.vy = vOrb; f.facing = facing * Math.PI / 180;
    const a = angleDeg * Math.PI / 180;
    synth = { pos: { x: 2.7 + startKm * 1000 / AU_M, y: 0 }, vel: { vx: -vRel * Math.cos(a), vy: vOrb - vRel * Math.sin(a) }, g: thrust, h: heading * Math.PI / 180 };
    target = { kind: 'entity', id: 'synthetic' };
  }
  const plan = createStance(target, { mode, rangeM: rangeKm * 1000, accelG: G, tight });
  const band = stanceBand(plan.standoff, tight);
  let fuel = 0, settledAt = null, minR = Infinity, maxR = 0, maxErr = 0, holdBurn = 0, unsettle = 0, was = false, cuts = 0, lastG = 0;
  let turns = 0, sweep = 0, inTurn = false, wobbles = 0, lastSign = 0, lastAt = -99;
  for (let i = 0; i < minutes; i++) {
    const t = state.clock.minute;
    let tgt;
    if (synth) tgt = { pos: synth.pos, vel: synth.vel, ax: synth.g * G0 * Math.cos(synth.h), ay: synth.g * G0 * Math.sin(synth.h) };
    else { getWorld(state).tick(t, f.pos); tgt = targetStateAt(state, target, t, true); }
    const g = guidanceStep(plan, f, t, tgt, null);
    if (g.settled && settledAt == null) settledAt = i;
    if (was && !g.settled) unsettle++;
    was = g.settled;
    if (settledAt != null) {
      minR = Math.min(minR, g.range); maxR = Math.max(maxR, g.range);
      if (mode === 'hold' && g.settled) maxErr = Math.max(maxErr, g.d);
    }
    const out = flightStep(f, g.cmd, 1);
    if (g.settled && out.mainG > 0.001) holdBurn++;
    if (g.settled && lastG > 0.05 && out.mainG < 0.05) cuts++;
    lastG = out.mainG;
    fuel += fuelUsed(out.mainG, out.rcsG);
    if (synth) stepFree(synth.pos, synth.vel, MIN_S, synth.g, synth.h);
    if (Math.abs(out.turned) > 0.15) { sweep += Math.abs(out.turned); if (!inTurn && sweep > 0.6) { turns++; inTurn = true; } } else { sweep = 0; inTurn = false; }
    if (Math.abs(out.turned) > 0.175) { const sg = Math.sign(out.turned); if (lastSign && sg !== lastSign && i - lastAt <= 3) wobbles++; lastSign = sg; lastAt = i; }
    state.clock.minute++;
  }
  return { settledAt, band, minR: minR / 1000, maxR: maxR / 1000, maxErr, holdBurn, cuts, unsettle, turns, wobbles, fuel };
}

const line = (label, r) => console.log(`      ${label.padEnd(38)} ${r.settledAt == null ? '  never' : String(r.settledAt).padStart(4) + ' min'} · range ${fmt(r.minR, 1)}–${fmt(r.maxR, 1)} km · ${r.turns} turns · ${r.wobbles} wobbles · ${fmt(r.fuel, 0)} kg`);

/** A game with a ship to keep a stance on, co-orbiting `distAU` away. */
function game(seed = 5) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 4, traffic: 0 });
  s.missions.cooldown = 1e9;
  s.politics.quietUntil = Infinity;
  s.politics.zones = [];
  releaseHold(s);
  return s;
}

export default [
  {
    name: 'HOLD gets onto the stance point from near or far, closing or opening, and stays there',
    fn: () => {
      const cases = [
        ['guns 3.6 km, from 2 km', { rangeKm: 3.6, startKm: 2 }, 15],
        ['guns 3.6 km, from 500,000 km', { rangeKm: 3.6, startKm: 500_000 }, 200],
        ['torpedo 50,000 km, from 2 km (opening)', { rangeKm: 50_000, startKm: 2 }, 90],
        ['torpedo 50,000 km, crossing at 3 km/s', { rangeKm: 50_000, startKm: 400_000, vRel: 3000, angleDeg: 90 }, 180],
        ['10G, 50,000 km from 2M km', { rangeKm: 50_000, startKm: 2_000_000, G: 10 }, 180],
      ];
      for (const [label, c, by] of cases) {
        const r = fly(c);
        line(label, r);
        assert(r.settledAt != null && r.settledAt <= by, `${label}: settled at ${r.settledAt}`);
        assert(r.turns <= 2 && r.wobbles === 0, `${label}: ${r.turns} turns, ${r.wobbles} wobbles`);
        assert(r.unsettle === 0 && r.maxErr <= r.band, `${label}: fell out of place (${r.unsettle}×, ${fmt(r.maxErr)} m off)`);
      }
      // LOOSE holds a coasting target on RCS: no plume
      const loose = fly({ rangeKm: 300_000, startKm: 100_000, tight: false });
      line('LOOSE 300,000 km', loose);
      assert(loose.settledAt != null && loose.holdBurn === 0, `loose hold lit the drive for ${loose.holdBurn} min`);
    },
  },
  {
    name: 'HOLD off a ship under thrust burns with it; off stations circling moons it keeps the point',
    fn: () => {
      for (const [label, c] of [
        ['1G ship, thrusting away', { rangeKm: 50_000, startKm: 50_000, thrust: 1, heading: 0, facing: 0 }],
        ['1G ship, thrusting sideways', { rangeKm: 50_000, startKm: 50_000, thrust: 1, heading: 90, facing: 90 }],
        ['0.3G ship, guns range', { rangeKm: 3.6, startKm: 3.6, thrust: 0.3, heading: 135, facing: 135 }],
      ]) {
        const r = fly(c);
        line(label, r);
        assert(r.settledAt === 0 && r.unsettle === 0 && r.maxErr <= r.band && r.turns === 0, `${label}: ${JSON.stringify(r)}`);
      }
      // Taking up the stance with the nose the wrong way: the ship falls
      // behind while it turns, then comes back onto the point and stays
      const late = fly({ rangeKm: 3.6, startKm: 3.6, thrust: 0.3, heading: 135, facing: 0 });
      line('0.3G ship, guns range, nose 135° off', late);
      assert(late.unsettle === 1 && late.turns <= 3 && late.maxR < 250, `${JSON.stringify(late)}`);
      for (const [label, c] of [
        ['Ganymede Station, 100,000 km', { rangeKm: 100_000, startKm: 150_000, stationId: 'ganymede-station' }],
        ['Phobos Yard, 50 km', { rangeKm: 50, startKm: 10, stationId: 'phobos-yard' }],
      ]) {
        const r = fly(c);
        line(label, r);
        // (the pull of a station circling a moon comes and goes and swings
        // round: the nose follows it, RCS covering while it turns)
        assert(r.settledAt != null && r.unsettle === 0 && r.maxErr <= r.band, `${label}: ${JSON.stringify(r)}`);
      }
    },
  },
  {
    name: 'KEEP OUT never lets a charging ship through the range; KEEP WITHIN keeps a runner on the leash and follows a ship under way',
    fn: () => {
      const out = fly({ mode: 'out', rangeKm: 50_000, startKm: 200_000, thrust: 2, heading: 180, minutes: 600 });   // (ten hours at 2G: 700 km/s)
      line('KEEP OUT 50,000 km vs a 2G charge', out);
      assert(out.minR >= 50_000 - out.band / 1000, `the charger got to ${fmt(out.minR)} km`);
      assert(out.turns <= 1 && out.unsettle === 0, `${JSON.stringify(out)}`);
      const inside = fly({ mode: 'out', rangeKm: 50_000, startKm: 10_000 });
      line('KEEP OUT 50,000 km from 10,000 km', inside);
      assert(inside.settledAt != null && inside.minR >= 50_000 - inside.band / 1000 && inside.turns <= 2, `${JSON.stringify(inside)}`);
      const leash = fly({ mode: 'within', rangeKm: 100_000, startKm: 50_000, thrust: 1, heading: 0 });
      line('KEEP WITHIN 100,000 km of a 1G runner', leash);
      assert(leash.maxR <= 100_000 + leash.band / 1000, `the runner got to ${fmt(leash.maxR)} km`);
      assert(leash.unsettle === 0 && leash.turns <= 1, `${JSON.stringify(leash)}`);
      // following a ship under way: a steady share of its thrust, not bursts
      for (const heading of [0, 60, 90]) {
        const tail = fly({ mode: 'within', rangeKm: 20, startKm: 20, thrust: 0.3, heading, facing: heading });
        line(`KEEP WITHIN 20 km of a 0.3G ship at ${heading}°`, tail);
        assert(tail.cuts === 0 && tail.unsettle === 0 && tail.maxR <= 20 + tail.band / 1000 && tail.minR >= 10, `${JSON.stringify(tail)}`);
      }
      const fetch = fly({ mode: 'within', rangeKm: 100_000, startKm: 1_000_000 });
      line('KEEP WITHIN 100,000 km from 1M km', fetch);
      assert(fetch.settledAt != null && fetch.maxR <= 100_000 + fetch.band / 1000, `${JSON.stringify(fetch)}`);
    },
  },
  {
    name: 'ranges follow our weapons and theirs',
    fn: () => {
      const s = game();
      const { x, y } = s.flight.pos;
      const e = spawnAgent(s, { role: 'pirate', cls: 'pirate-corvette', faction: 'pirate', pos: { x: x + 0.0005, y }, vel: { ...s.flight.vel }, transponder: true });
      sensorsTick(s);
      const r = stanceRanges(s, { kind: 'entity', id: e.id }, 75_000_000);
      const by = Object.fromEntries(r.map(o => [o.key, o]));
      console.log(`      ${r.map(o => `${o.label} ${fmt(o.m / 1000)} km`).join(' · ')}`);
      assert(by.guns && by.guns.m === 3_600, 'guns: 60% of our TL2 PDC reach');
      assert(by.torpedo && by.torpedo.m === 50_000_000, 'torpedo standoff');
      assert(by.board.warn && by.guns.warn, 'their guns reach us at formation and guns range');
      assert(by.long && by.here && r.every((o, i) => i === 0 || o.m >= r[i - 1].m), 'nearest first');
    },
  },
  {
    name: 'under fire a stance turns away from close torpedoes, then takes up its place again',
    fn: () => {
      const s = game(7);
      const ev = {};
      bus.on('*', (type, p) => { (ev[type] ||= []).push(p); });
      const { x, y } = s.flight.pos;
      const v = { ...s.flight.vel };
      // a hauler to keep station on, and an enemy further out
      const mark = spawnAgent(s, { role: 'civilian', cls: 'mule', pos: { x: x + 0.0002, y }, vel: v, transponder: true });
      const foe = spawnAgent(s, { role: 'civilian', cls: 'mule', pos: { x: x - 0.0006, y }, vel: v, transponder: true });
      s.combatStations = true;
      engageStance(s, createStance({ kind: 'entity', id: mark.id }, { mode: 'hold', rangeM: 5_000_000, accelG: 3 }));
      overrideSecure(s);
      advance(s, 240);
      assert(s.autopilot?.settled, `not on station after 4 h (${s.autopilot?.display})`);
      const before = Math.hypot(s.flight.pos.x - mark.pos.x, s.flight.pos.y - mark.pos.y) * AU_M / 1000;
      // a fast torpedo from 90,000 km
      launchTorpedo(s, foe.id, PLAYER, { warhead: 'he', profile: 'fast' });
      let evaded = 0, minRange = Infinity;
      for (let i = 0; i < 300 && s.autopilot; i++) {
        advance(s, 1);
        if (s.autopilot.display === 'evade') evaded++;
      }
      const after = s.autopilot;
      console.log(`      held at ${fmt(before)} km · turned away for ${evaded} min · ${ev['stance-evading']?.length || 0} evasions · back on station: ${after?.settled}`);
      assert(evaded > 0 && ev['stance-evading']?.length >= 1, 'never turned away from the torpedo');
      // once it is gone, back on station
      advance(s, 600);
      assert(s.autopilot && s.autopilot.plan.kind === 'stance', 'the stance was dropped');
      assert(s.autopilot.settled, `not back on station (${s.autopilot.display})`);
      // a stance survives a save
      const back = deserialize(serialize(s)).state;
      advance(back, 30);
      assert(back.autopilot?.plan.kind === 'stance' && back.autopilot.settled, 'stance lost across a save');
    },
  },
];
