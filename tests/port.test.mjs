// Port space: gravity near the rocks and what holding a place costs, the
// ground and the nav computer's guard over it, the holding patterns, the
// traffic's port calls, and what can be done from port without a berth.
import { assert, fmt } from './helpers.mjs';
import { AU_M, G0, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { getBody } from '../js/sim/ephemeris.js';
import { gravityAt, nearestSurface, setGravityEpoch } from '../js/sim/gravity.js';
import { STATIONS, gateId, berthSizesFor } from '../js/sim/stations.js';
import { holdingPattern, slotOrbit, slotCounts, PORT_M } from '../js/sim/holding.js';
import { CALLS } from '../js/sim/traffic.js';
import { CLASSES } from '../js/sim/ship-classes.js';
import * as TC from '../js/sim/traffic-control.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute, overrideSecure, holdStation, releaseHold, holdStep } from '../js/sim/autopilot.js';
import { acceptContract } from '../js/sim/contracts.js';

function game(seed = 3, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 6, traffic: 0, docked: false, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

function events() {
  const ev = {};
  bus.on('*', (t, p) => { (ev[t] ||= []).push(p); });
  return ev;
}

const run = (s, pred, max) => { let t = 0; while (t < max && !pred(s)) { advance(s, 1); t++; } return t; };

export default [
  {
    name: 'gravity: the rocks pull; hovering at a gate costs thrust, a holding slot none',
    fn: () => {
      const s = game();
      const w = getWorld(s);
      setGravityEpoch(s.clock.minute);
      const ceres = getBody('Ceres');
      const st = w.get('ceres-station');
      const surf = nearestSurface(st.pos.x, st.pos.y, s.clock.minute);
      assert(surf?.body === ceres && Math.abs(surf.alt) < 1000, `the port stands on Ceres (${fmt(surf?.alt)} m)`);
      // the pull at the port: Ceres' surface gravity (0.28 m/s²) on top of the Sun's
      const g = gravityAt(st.pos.x, st.pos.y, s.clock.minute);
      const sun = gravityAt(st.pos.x + 0.01, st.pos.y, s.clock.minute);
      const rock = Math.hypot(g.ax - sun.ax, g.ay - sun.ay);
      assert(rock > 0.25 && rock < 0.31, `Ceres pulls ${fmt(rock, 3)} m/s² at its surface`);
      // holding at the gate (a route's end): the nav computer hovers
      holdStation(s, { kind: 'entity', id: gateId('ceres-station') });
      advance(s, 1);
      const atGate = holdStep(s);
      // in a slot of the holding pattern: free fall, nothing to pay
      releaseHold(s);
      const p = holdingPattern('ceres-station');
      // (in the slot: its place and motion now)
      const slotNow = { orbit: slotOrbit('ceres-station', p.slots[0].id), pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 }, t: -1 };
      w.refresh(slotNow, s.clock.minute);
      s.flight.pos = { ...slotNow.pos }; s.flight.vel = { ...slotNow.vel };
      holdStation(s, { kind: 'slot', id: 'ceres-station', slot: p.slots[0].id });
      advance(s, 1);
      const inSlot = holdStep(s);
      console.log(`      hover at Ceres' gate ${fmt(atGate, 4)} G · in holding slot ${p.slots[0].id} ${fmt(inSlot, 6)} G`);
      assert(atGate > 0.014 && atGate < 0.02, 'hovering at the gate takes most of Ceres\' pull');
      assert(inSlot < 1e-4, 'a slot is a free orbit');
    },
  },
  {
    name: 'the ground: a ship that stops thrusting by a rock falls, is warned, and hits it',
    fn: () => {
      const s = game();
      const ev = events();
      releaseHold(s);                                // at Ceres' gate, 100 km up, and nothing holding us
      const t = run(s, st => st.lost || st.flight.hold?.kind === 'surface', 60);
      const calls = (ev['nav-callout'] || []).filter(c => c.key === 'terrain');
      const hit = ev['ground-impact']?.[0];
      console.log(`      from the gate: ${calls.length} terrain call-outs, impact after ${t} min at ${fmt(hit?.speed ?? 0, 0)} m/s · ${s.lost ? 'ship lost' : 'down'}`);
      assert(calls.length >= 3, 'the nav computer called the ground out');
      assert(hit && hit.speed > 100 && t > 10 && t < 25, 'a fall of about seventeen minutes, at near 200 m/s');
      assert(s.lost?.cause === 'structure', 'which no hull survives');
    },
  },
  {
    name: 'the terrain guard: routes that start or end behind a rock climb out round it',
    fn: () => {
      for (const dest of ['vesta-depot', 'pallas-station', 'hygiea-ring']) {
        const s = game(5);
        const ev = events();
        const opt = planRoutes(s, { kind: 'entity', id: dest }).find(o => o.name === 'STANDARD');
        engageRoute(s, opt.plan);
        run(s, st => st.autopilot?.phase === 'active', 60); overrideSecure(s);
        run(s, st => !st.autopilot || st.lost, opt.estimate.minutes + 2000);
        const climbs = (ev['nav-callout'] || []).filter(c => /in the way/.test(c.text)).length;
        console.log(`      Ceres → ${dest}: ${s.lost ? 'LOST' : 'arrived'} · ${climbs} climb${climbs === 1 ? '' : 's'}`);
        assert(!s.lost, `${dest}: lost (${JSON.stringify(s.lost)})`);
        assert(s.flight.hold?.id === gateId(dest), `${dest}: holding at the gate`);
      }
    },
  },
  {
    name: 'holding patterns: hundreds of slots at every port, all in port space, kept by free fall',
    fn: () => {
      const s = game();
      const w = getWorld(s);
      for (const id of Object.keys(STATIONS)) {
        const p = holdingPattern(id);
        assert(p && p.slots.length >= 150, `${id}: ${p?.slots.length} slots`);
        const st = w.get(id);
        // the farthest slot, measured: inside port space
        const last = p.slots.reduce((a, b) => (Math.abs(b.sKm) > Math.abs(a.sKm) ? b : a));
        const e = { orbit: slotOrbit(id, last.id), pos: { x: 0, y: 0 }, vel: { vx: 0, vy: 0 }, t: -1 };
        w.refresh(e, s.clock.minute);
        const dM = Math.hypot(e.pos.x - st.pos.x, e.pos.y - st.pos.y) * AU_M;
        assert(dM < PORT_M, `${id}: slot ${last.id} is ${fmt(dM / 1000, 0)} km out`);
        console.log(`      ${id.padEnd(18)} ${p.kind.padEnd(11)} ${p.slots.length} slots, farthest ${fmt(dM / 1000, 0)} km from the station`);
      }
    },
  },
  {
    name: 'traffic: a berth only for the work, then out to the pattern or away; nothing too big berths',
    fn: () => {
      seedRandom(4);
      bus.clear();
      const s = createGame({ docked: false });
      s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
      const w = getWorld(s);
      const worst = {};
      let berthed = 0, inSlot = 0, xlBerthed = 0, overstay = 0;
      for (let h = 0; h < 72; h++) {
        advance(s, 60);
        for (const e of s.entities) {
          if (!e.tags?.traffic || !e.tags.call) continue;
          const kind = CLASSES[e.cls].kind;
          if (e.tags.berth && !e.transit) {
            berthed++;
            if (!berthSizesFor(e.cls).length) xlBerthed++;
            const max = (CALLS[kind] || CALLS.default).work?.[1] ?? 0;
            const left = e.tags.until - s.clock.minute;
            if (left > max + 120) overstay++;
            worst[kind] = Math.max(worst[kind] || 0, left);
          }
          if (e.tags.slot && !e.transit) inSlot++;
        }
      }
      const held = w.stations.reduce((n, st) => n + slotCounts(s, st).used, 0);
      console.log(`      over 3 days (hourly census): ${berthed} ship-hours in berths, ${inSlot} in holding slots · ${held} holding now`);
      console.log(`      longest berth work left, by kind (h): ${Object.entries(worst).map(([k, v]) => `${k} ${fmt(v / 60)}`).join(' · ')}`);
      assert(berthed > 0 && inSlot > berthed, 'most of the time in port is spent in the pattern, not a berth');
      assert(xlBerthed === 0, 'no ice hauler in a berth');
      assert(overstay === 0, `${overstay} ships held a berth past their work`);
    },
  },
  {
    name: 'port space: the board is signed from port; a holding slot puts us there lawfully',
    fn: () => {
      const s = game(8);
      const w = getWorld(s);
      const st = w.get('ceres-station');
      advance(s, 20);
      // far out: the board reads, but signing waits for port
      s.flight.pos.x += 0.05;
      releaseHold(s);
      let c = null;
      for (let i = 0; i < 40 && !c; i++) { st.board.lastRefresh = -Infinity; st.board.missions = []; advance(s, 10); c = st.board.missions.find(m => !m.cargo && !m.passengers); }
      assert(c, 'a contract that needs no loading');
      const r1 = acceptContract(s, st.id, c.id);
      assert(!r1.ok && /port space/.test(r1.text), r1.text);
      // into port, at the gate (where it is now): ask for a slot, fly to it, sign
      const g = w.get(gateId(st.id));
      w.refresh(g, s.clock.minute);
      s.flight.pos = { ...g.pos }; s.flight.vel = { ...g.vel };
      const h = TC.requestHolding(s, st.id);
      assert(h.ok && h.slot, h.text);
      const opt = planRoutes(s, { kind: 'slot', id: st.id, slot: h.slot }).find(o => o.feasible);
      engageRoute(s, opt.plan);
      run(s, st2 => st2.autopilot?.phase === 'active', 60); overrideSecure(s);
      const t = run(s, st2 => !st2.autopilot, 600);
      assert(s.flight.hold?.kind === 'slot', `holding in the slot (after ${t} min)`);
      const ev = events();
      advance(s, 120);
      assert(!(ev.citation || []).length, 'no citation for holding in our slot');
      const r2 = acceptContract(s, st.id, c.id);
      console.log(`      ${h.text.slice(0, 90)}… · into the slot in ${t} min · signed: ${r2.ok}`);
      assert(r2.ok, r2.text);
    },
  },
];
