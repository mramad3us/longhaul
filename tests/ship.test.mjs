// Life aboard: watches, needs, machinery wear and repair, flying by hand.
import { assert, fmt } from './helpers.mjs';
import { DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute, crewPolicy, flipInterlock } from '../js/sim/autopilot.js';
import { damageSystem, systemPerf, meteoroidStrike, partsFor, shipSystems } from '../js/sim/systems.js';
import { CLASSES, TECH } from '../js/sim/ship-classes.js';
import { overhaulQuote, priceOf } from '../js/sim/contracts.js';
import { setBreach } from '../js/sim/life-support.js';
import { isInertiaActive, updateInertia } from '../js/sim/inertia.js';
import { minuteTick } from '../js/sim/game.js';
import { minuteOfDay } from '../js/sim/duty.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { seatKind } from '../js/sim/ship-layout.js';
import { nearestSurface } from '../js/sim/gravity.js';
import { getWorld } from '../js/sim/world.js';
import { releaseHold } from '../js/sim/autopilot.js';

function game(seed = 1, crewCount = 6, classId) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount, classId });
  s.missions.cooldown = 1e9;            // no distress calls interrupting the routine
  s.politics.quietUntil = Infinity;     // nor patrols and pirates
  return s;
}

const runUntil = (s, pred, max) => { let t = 0; while (t < max && !pred(s)) { advance(s, 1); t++; } return t; };
const atHour = (s, h) => runUntil(s, st => minuteOfDay(st) === h * 60, DAY_MIN);
const noRepairs = (s) => { for (const m of s.ship.crew) m.skills.engineering = 5; };

export default [
  {
    name: 'a day aboard: everyone sleeps in a bunk, eats, washes and keeps their spirits up',
    fn: () => {
      const s = game(3, 6);
      const sleptBunk = new Map(), meals = new Map();
      bus.on('*', () => {});
      const food0 = s.resources.food.current, water0 = s.resources.water.current;
      const was = new Map();
      for (let t = 0; t < 3 * DAY_MIN; t++) {
        advance(s, 1);
        for (const m of s.ship.crew) {
          if (m.activity === 'sleeping') sleptBunk.set(m.id, (sleptBunk.get(m.id) || 0) + 1);
          if (was.get(m.id) === 'eating' && m.activity !== 'eating') meals.set(m.id, (meals.get(m.id) || 0) + 1);
          was.set(m.id, m.activity);
        }
      }
      const perDay = (map, m) => (map.get(m.id) || 0) / 3;
      for (const m of s.ship.crew) {
        assert(perDay(sleptBunk, m) > 6 * 60, `${m.role} slept only ${fmt(perDay(sleptBunk, m) / 60)}h/day in a bunk`);
        assert(perDay(meals, m) >= 2, `${m.role} ate ${fmt(perDay(meals, m))} meals/day`);
        assert(m.morale > 50, `${m.role} morale ${fmt(m.morale)}`);
        for (const [k, v] of Object.entries(m.needs)) assert(v > 10, `${m.role} ${k} at ${fmt(v)}`);
      }
      const food = (food0 - s.resources.food.current) / 3 / 6;
      const water = (water0 - s.resources.water.current) / 3;
      console.log(`      per person/day: ${fmt(food, 2)} rations, ${s.ship.crew.map(m => `${m.role} ${fmt(perDay(sleptBunk, m) / 60)}h/${fmt(perDay(meals, m))}m`).join(', ')}; ship water ${fmt(water)} L/day net`);
      assert(food > 1 && food < 2, `food use ${food}/day per person`);
      assert(water > 0 && water < 15, `net water ${water} L/day`);
    },
  },
  {
    name: 'watches follow the roster',
    fn: () => {
      const s = game(4, 6);
      atHour(s, 10);
      advance(s, 30);
      const w = s.$watch;
      const who = (id) => s.ship.crew.find(m => m.id === id)?.role;
      console.log(`      10:30 — helm ${who(w.helm)}, engineering ${who(w.engineering)}, sick bay ${who(w.medbay)}`);
      assert(who(w.helm) === 'Pilot' && who(w.engineering) === 'Engineer' && who(w.medbay) === 'Medic', 'day watch');
      atHour(s, 2);
      advance(s, 30);
      assert(who(s.$watch.ops) === 'Gunner', `night ops watch: ${who(s.$watch.ops)}`);
      assert(s.ship.crew.filter(m => m.activity === 'sleeping').length >= 3, 'the day watch sleeps at night');
    },
  },
  {
    name: 'machinery wears; engineers keep it serviced from spares',
    fn: () => {
      const s = game(5, 6);
      const done = [];
      bus.on('crew-work-done', p => done.push(p));
      const parts0 = s.resources.parts.current;
      advance(s, 40 * DAY_MIN);
      const units = Object.values(s.systems.units);
      const worst = Math.min(...units.map(u => u.integrity));
      const kinds = done.reduce((a, d) => (a[d.kind] = (a[d.kind] || 0) + 1, a), {});
      console.log(`      40 days: work ${JSON.stringify(kinds)}, lowest integrity ${fmt(worst)}, parts ${fmt(parts0)} → ${fmt(s.resources.parts.current, 2)}, scrap ${fmt(s.resources.scrap.current, 2)}`);
      assert((kinds.maintain || 0) >= 5, 'maintenance should be routine');
      assert(worst > 50, 'serviced machinery should stay in shape');
      assert(units.every(u => u.status !== 'failed'), 'nothing should be left broken');
      assert(s.resources.parts.current < parts0, 'servicing uses spares');
    },
  },
  {
    name: 'the yard decides upkeep: Belt kit breaks often and mends cheap; Martian kit rarely breaks and costs dearly',
    fn: () => {
      const days = 45, seeds = [11, 12, 13, 14];          // (fault counts are a few per hull: averaged over four runs)
      const rows = {};
      for (const cls of ['tramp', 'meridian', 'ares', 'mcrn-corvette']) {
        let faults = 0, parts = 0;
        for (const seed of seeds) {
          const s = game(seed, 6, cls);
          s.resources.parts.max = s.resources.parts.current = 1000;      // count what is used, never run dry
          bus.on('system-fault', p => { if (p.cause === 'wear') faults++; });
          advance(s, days * DAY_MIN);
          parts += 1000 - s.resources.parts.current;
        }
        // The same damage at the yard: every system half worn, the hull at 70%
        const s = game(1, 6, cls);
        for (const id of shipSystems(s)) s.systems.units[id].integrity = 50;
        s.hull.integrity = 70;
        const T = TECH[CLASSES[cls].tl];
        const spare = priceOf(s, 'parts');
        rows[cls] = { faults: faults / seeds.length, parts: parts / seeds.length, spend: parts / seeds.length * spare, major: partsFor(s, 'major'), yard: overhaulQuote(s), spare, patch: T.patchHours };
        const r = rows[cls];
        console.log(`      ${CLASSES[cls].name} (${T.label}): ${fmt(r.faults, 1)} faults in ${days} days, ${fmt(r.parts, 1)} parts (${fmt(r.spend, 0)} MCR) used; a major repair ${r.major} parts at ${r.spare} MCR, jury-rig holds ${r.patch[0]}–${r.patch[1]}h; yard bill ${r.yard.toLocaleString()} MCR`);
      }
      const { tramp, meridian, ares } = rows, mars = rows['mcrn-corvette'];
      assert(tramp.faults > meridian.faults && tramp.faults > 2 * mars.faults, 'better kit breaks less');
      // (TL3 and TL4 kit both use a handful of parts in 45 days: which of the two spends more is down to a fault or two)
      assert(tramp.spend < meridian.spend && meridian.spend < ares.spend && meridian.spend < mars.spend, 'and costs more in spares to keep running');
      assert(tramp.major < meridian.major && meridian.major < ares.major && ares.major < mars.major, 'better kit eats more spares per repair');
      assert(tramp.yard < meridian.yard && meridian.yard < ares.yard && ares.yard < mars.yard, 'and costs more at the yard');
    },
  },
  {
    name: 'no spares: jury-rig, then a proper fix once parts are aboard',
    fn: () => {
      const s = game(6, 4);
      s.resources.parts.current = 0;
      damageSystem(s, 'lifeSupport', { severity: 'major', cause: 'test' });
      runUntil(s, st => st.systems.units.lifeSupport.status === 'patched', DAY_MIN);
      assert(s.systems.units.lifeSupport.status === 'patched', 'should be jury-rigged');
      assert(systemPerf(s, 'lifeSupport') === 0.5, 'a patch runs at half rate');
      s.resources.parts.current = 10;
      const t = runUntil(s, st => st.systems.units.lifeSupport.status === 'nominal', DAY_MIN);
      console.log(`      proper repair ${fmt(t / 60)}h after spares came aboard`);
      assert(s.systems.units.lifeSupport.status === 'nominal', 'should be properly repaired');
      assert(s.resources.parts.current === 7, 'a major repair takes three parts');
    },
  },
  {
    name: 'the machine shop turns scrap into spares',
    fn: () => {
      const s = game(7, 6);
      s.resources.parts.current = 0;
      s.resources.scrap.current = 3;
      advance(s, 2 * DAY_MIN);
      console.log(`      parts ${fmt(s.resources.parts.current, 2)}, scrap ${fmt(s.resources.scrap.current, 2)}`);
      assert(s.resources.parts.current >= 1, 'no parts refurbished');
    },
  },
  {
    name: 'flight computer dies mid-burn: the helm watch takes over and flies it in by hand',
    fn: () => {
      const s = game(8, 6);
      atHour(s, 9);                     // the Pilot has the helm watch
      // (hours on Ceres' approach uncleared got us reported to station security: settled, this is about the helm)
      s.law.wanted.OPA = 0; s.law.fines = [];
      const std = planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).find(o => o.name === 'STANDARD');
      engageRoute(s, std.plan, { estimate: std.estimate });
      runUntil(s, st => st.autopilot?.phase === 'active' && st.flight.thrustG > 0.5, 600);
      damageSystem(s, 'flightComputer', { severity: 'major', cause: 'test' });
      let unmanned = 0, manual = 0, fuel0 = s.resources.fuel.current;
      const flown = runUntil(s, st => {
        // (the flight computer stays down all the way in; the rest of the ship is kept up as usual: a drive
        // left broken by a test that stopped all repairs would end the trip, not the helm)
        if (systemPerf(st, 'flightComputer') > 0) damageSystem(st, 'flightComputer', { severity: 'major', cause: 'test' });
        if (st.autopilot?.helm === 'unmanned') unmanned++;
        if (st.autopilot?.helm === 'manual') manual++;
        return !st.autopilot;
      }, std.estimate.minutes * 2);
      const used = fuel0 - s.resources.fuel.current;
      console.log(`      unmanned ${unmanned} min, hand-flown ${fmt(manual / 60)}h, arrived after ${fmt(flown / 60)}h (est ${fmt(std.estimate.minutes / 60)}h), fuel ${fmt(used)} kg vs ${fmt(std.estimate.fuel)} planned`);
      assert(!s.autopilot && s.flight.hold?.id === 'vesta-depot-gate', 'should arrive by hand (at the gate: the route\'s end)');
      assert(unmanned <= 6, 'the helm is never left unmanned for long (watch changes are handed over)');
      assert(manual > 60, 'should have been flown by hand');
    },
  },
  {
    name: 'flown by hand into a gate beside a rock (Vesta Depot, 50 km up): every ship arrives, none hits the ground',
    fn: () => {
      const out = [];
      for (const seed of [1, 4, 5, 11, 15, 21]) {
        seedRandom(seed);
        bus.clear();
        const s = createGame({ docked: false, crewCount: 6, forces: false });
        s.missions.cooldown = 1e9; s.politics.quietUntil = Infinity;
        atHour(s, 9);
        s.law.wanted.OPA = 0; s.law.fines = [];
        let impacts = 0, held = 0, longest = 0;
        bus.on('ground-impact', () => impacts++);
        const std = planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).find(o => o.name === 'STANDARD');
        engageRoute(s, std.plan, { estimate: std.estimate });
        runUntil(s, st => st.autopilot?.phase === 'active' && st.flight.thrustG > 0.5, 600);
        const flown = runUntil(s, st => {
          // (the flight computer down all the way in: the rest of the ship repaired as usual)
          if (systemPerf(st, 'flightComputer') > 0) damageSystem(st, 'flightComputer', { severity: 'major', cause: 'test' });
          if (st.autopilot?.turnHeld != null) { held++; longest = Math.max(longest, held); } else held = 0;
          return !st.autopilot || st.lost;
        }, std.estimate.minutes * 2);
        out.push(`seed ${seed}: ${s.lost ? 'LOST' : s.autopilot ? 'not in' : `in ${fmt(flown / 60, 1)}h`} (est ${fmt(std.estimate.minutes / 60, 1)}h), longest held turn ${longest} min`);
        assert(!s.lost && impacts === 0, `seed ${seed}: the ship hit the ground`);
        assert(!s.autopilot && s.flight.hold?.id === 'vesta-depot-gate', `seed ${seed}: arrives at the gate by hand`);
      }
      console.log(`      ${out.join('\n      ')}`);
    },
  },
  {
    name: 'the end of an approach is flown strapped in, past the mark too; a turn is never held with the ground coming up',
    fn: () => {
      const s = game(12, 6);
      const std = planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).find(o => o.name === 'STANDARD');
      engageRoute(s, std.plan, { estimate: std.estimate });
      runUntil(s, st => st.autopilot?.phase === 'active', 600);
      const ap = s.autopilot;
      Object.assign(ap, { display: 'burn', flipIn: Infinity, ignitedAt: null, d: ap.plan.standoff + 2_000_000, vClose: -1200, relSpeed: 1200 });
      assert(crewPolicy(s) === 'secure', 'overshot, moving away 1.2 km/s, 2,000 km out: strapped in to turn and come back');
      Object.assign(ap, { d: ap.plan.standoff + 20e9, vClose: -1200, relSpeed: 1200 });
      assert(crewPolicy(s) === 'free', 'far out, the crew go about the ship');
      // A turn wanted beside Vesta, someone on their feet: held while the ship is safe, never while it falls
      const g = getWorld(s).get('vesta-depot-gate');
      getWorld(s).refresh(g, s.clock.minute);          // (far from us the world brings things up to date lazily)
      releaseHold(s);
      s.flight.pos = { ...g.pos };
      const sf = nearestSurface(g.pos.x, g.pos.y, s.clock.minute);
      const ship = s.ship.crew.find(m => m.role !== 'Pilot');
      ship.seat = null; ship.task = null;
      s.flight.facing = Math.atan2(sf.uy, sf.ux);
      s.flight.turning = 0;
      const cmd = { ax: -sf.ux * 5, ay: -sf.uy * 5, maxG: 1 };          // (the nose round: a flip)
      const forced = [];
      s.flight.vel = { vx: sf.vel.vx + sf.ux * 30, vy: sf.vel.vy + sf.uy * 30 };     // climbing away from it
      ap.turnHeld = null;
      const safe = flipInterlock(s, { ...cmd }, (t, p) => t === 'turn-forced' && forced.push(p));
      assert(safe.ax === 0 && safe.ay === 0 && ap.turnHeld != null, 'safe: the turn waits for them');
      s.flight.vel = { vx: sf.vel.vx - sf.ux * 150, vy: sf.vel.vy - sf.uy * 150 };   // falling at 150 m/s, 50 km up
      ap.turnHeld = null;
      const falling = flipInterlock(s, { ...cmd }, (t, p) => t === 'turn-forced' && forced.push(p));
      assert(falling.ax !== 0 && forced.some(p => p.ground), 'falling: the turn goes, and says why');
    },
  },
  {
    name: 'flight computer dies at night: the ship coasts until a pilot reaches the helm',
    fn: () => {
      const s = game(9, 6);
      noRepairs(s);
      atHour(s, 3);                     // nobody on the helm watch; the Pilot is asleep
      const std = planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).find(o => o.name === 'STANDARD');
      engageRoute(s, std.plan, { estimate: std.estimate });
      runUntil(s, st => st.autopilot?.phase === 'active' && st.flight.thrustG > 0.5, 600);
      runUntil(s, st => st.crewPolicy === 'free' && !st.ship.crew.some(m => seatKind(m.seat) === 'helm'), 120);
      damageSystem(s, 'flightComputer', { severity: 'major', cause: 'test' });
      let unmanned = 0;
      runUntil(s, st => { if (st.autopilot?.helm === 'unmanned') unmanned++; return st.autopilot?.helm === 'manual'; }, 240);
      const flier = s.ship.crew.find(m => seatKind(m.seat) === 'helm');
      console.log(`      coasted ${unmanned} min before ${flier?.role} took the helm`);
      assert(flier && s.autopilot.helm === 'manual', 'someone should be flying');
      assert(unmanned >= 1, 'with nobody on watch, the ship coasts for a while');
    },
  },
  {
    name: 'a worn drive limits the burn; a dead coolant loop all but stops it',
    fn: () => {
      const s = game(10, 4);
      damageSystem(s, 'drive', { severity: 'minor', cause: 'test' });
      advance(s, 1);
      assert(s.flight.maxG === 3, `drive degraded → 3G, got ${s.flight.maxG}`);
      s.combatStations = true;
      const opts = planRoutes(s, { kind: 'entity', id: 'vesta-depot' }, { combat: true });
      assert(opts.every(o => o.accelG <= 3), 'planner must not offer burns the drive cannot make');
      damageSystem(s, 'coolant', { severity: 'major', cause: 'test' });
      advance(s, 1);
      assert(s.flight.maxG === 0.3, `coolant failed → 0.3G, got ${s.flight.maxG}`);
    },
  },
  {
    name: 'water reclamation down: the tanks drain fast',
    fn: () => {
      const s = game(11, 6);
      noRepairs(s);
      const w0 = s.resources.water.current;
      advance(s, DAY_MIN);
      const normal = w0 - s.resources.water.current;
      damageSystem(s, 'waterRecycler', { severity: 'major', cause: 'test' });
      const w1 = s.resources.water.current;
      advance(s, DAY_MIN);
      const broken = w1 - s.resources.water.current;
      console.log(`      water per day: ${fmt(normal)} L reclaimed, ${fmt(broken)} L without reclamation`);
      assert(broken > normal * 8, 'without reclamation water should go many times faster');
    },
  },
  {
    name: 'a dead galley means cold rations and sinking morale',
    fn: () => {
      const run = (broken) => {
        const s = game(12, 6);
        noRepairs(s);
        if (broken) damageSystem(s, 'galley', { severity: 'major', cause: 'test' });
        advance(s, 4 * DAY_MIN);
        return s.ship.crew.reduce((a, m) => a + m.morale, 0) / s.ship.crew.length;
      };
      const ok = run(false), cold = run(true);
      console.log(`      mean morale after 4 days: galley ${fmt(ok)}, cold rations ${fmt(cold)}`);
      assert(cold < ok - 3, 'cold rations should hurt morale');
    },
  },
  {
    name: 'hull breach mid-burn: pressure doors hold, crew suit up, an engineer seals it',
    fn: () => {
      for (const seed of [21, 22, 23]) {
        const s = game(seed, 4);
        const r = planRoutes(s, { kind: 'entity', id: 'hygiea-ring' }).find(o => o.name === 'EXPRESS');
        engageRoute(s, r.plan);
        runUntil(s, st => st.autopilot?.phase === 'active' && st.flight.thrustG > 2.5, 300);
        advance(s, 120);
        const deck = 1;                          // quarters: couches and a bunk room
        setBreach(s, deck, true);
        const n2 = s.resources.n2Tank.current;
        let sealedAt = null;
        for (let t = 0; t < 600; t++) {
          minuteTick(s);
          while (isInertiaActive(s)) updateInertia(s, 0.05);
          if (sealedAt == null && !s.ship.decks[deck].atmosphere.breached) sealedAt = t;
        }
        const lost = n2 - s.resources.n2Tank.current;
        const dead = s.ship.crew.filter(m => m.dead).length;
        console.log(`      seed ${seed}: sealed after ${sealedAt} min, N₂ used ${fmt(lost)} kg, dead ${dead}, suited ${s.ship.crew.filter(m => m.suit.wearing).length}`);
        assert(sealedAt != null, 'the breach should be sealed');
        assert(dead === 0, 'nobody should die of one breach');
        assert(lost < 200, 'pressure doors should limit the loss to one deck');
      }
    },
  },
  {
    name: 'saves carry systems and needs; saves from older schemas are refused',
    fn: () => {
      const s = game(13, 5);
      advance(s, 600);
      damageSystem(s, 'sensors', { severity: 'minor', cause: 'test' });
      const { state: s2 } = deserialize(serialize(s));
      assert(s2.systems.units.sensors.status === 'degraded', 'system state lost');
      assert(s2.ship.crew.every(m => m.needs && m.duty), 'crew needs lost');
      // A save from an older schema is refused, not half-loaded
      const old = JSON.parse(serialize(s));
      old.schema -= 1;
      let refused = false;
      try { deserialize(old); } catch { refused = true; }
      assert(refused, 'an old save should be refused');
    },
  },
];
