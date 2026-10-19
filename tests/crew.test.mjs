// Crew behaviour: medicine, rescue chain, inertial events, life support.
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { triggerManeuver, updateInertia, isInertiaActive, Maneuver } from '../js/sim/inertia.js';
import { shipGeometry, isRestraint } from '../js/sim/ship-layout.js';
import { setBreach } from '../js/sim/life-support.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute } from '../js/sim/autopilot.js';
import { orderShutdown, orderStartup, ReactorState } from '../js/sim/reactor.js';
import { forceDistress } from '../js/sim/missions.js';
import { protectedG, physiologyTick } from '../js/sim/crew.js';
import { fuelUsed } from '../js/sim/flight.js';
import { createPlan, STANDOFF } from '../js/sim/nav.js';

function game(seed = 1, crewCount = 6) {
  seedRandom(seed);
  bus.clear();
  return createGame({ crewCount });
}

export default [
  {
    name: 'unconscious crew: medic stabilizes, carries to autodoc, patient heals',
    fn: () => {
      const s = game(2);
      advance(s, 30);
      const patient = s.ship.crew.find(m => m.role === 'Gunner');
      patient.consciousness = 10;
      patient.heart.health = 0;          // cardiac arrest → critical
      patient.body.torso = 40;
      const seen = [];
      bus.on('*', (t) => seen.push(t));
      advance(s, 1);
      assert(patient.conditions.includes('critical'), 'should be critical');
      let t = 0;
      while (t < 600 && !(patient.seat || '').startsWith('medbay')) { advance(s, 1); t++; }
      assert(!patient.dead, `patient died after ${t} min (deathTimer ran out before the medic arrived?)`);
      assert(patient.seat?.startsWith('medbay'), `not in autodoc after ${t} min`);
      assert(seen.includes('crew-stabilized') && seen.includes('crew-delivered'), 'rescue chain events');
      advance(s, 600);
      console.log(`      in autodoc after ${t} min; after 10h: torso ${fmt(patient.body.torso)} heart ${fmt(patient.heart.health)} conscious ${fmt(patient.consciousness)}`);
      assert(patient.body.torso > 90 && patient.consciousness > 50, 'should be recovering');
    },
  },
  {
    name: 'surprise burn throws unsecured crew; strapped-in crew are safe',
    fn: () => {
      const s = game(3);
      advance(s, 20);
      const geo = shipGeometry(s.ship);
      const strapped = s.ship.crew[1];
      strapped.seat = geo.fixtures.couch[0].id;
      const before = s.ship.crew.map(m => m.body.torso);
      const loose = s.ship.crew.filter(m => !isRestraint(m.seat)).length;   // sleepers in bunks are strapped in too
      const n = triggerManeuver(s, Maneuver.BURN_START, { deltaG: 3, surprise: true, gForce: 3 });
      assert(loose > 0 && n === loose, `expected ${loose} bodies in motion, got ${n}`);
      let hits = [];
      for (let i = 0; i < 1000 && isInertiaActive(s); i++) hits = hits.concat(updateInertia(s, 1 / 60));
      assert(!isInertiaActive(s), 'slide never resolved');
      assert(hits.length > 0, 'nobody hit anything');
      assert(strapped.body.torso === before[1], 'strapped crew must be unharmed');
      console.log(`      ${hits.map(h => `${h.member.name}: ${h.severity} @${fmt(h.speed)}m/s`).join('; ')}`);
      // positions are back on walkable tiles and the sim continues
      advance(s, 30);
      for (const m of s.ship.crew) assert(Number.isFinite(m.pos.sx) && Number.isFinite(m.pos.sy), 'bad position');
    },
  },
  {
    name: 'hull breach: crew suit up and survive',
    fn: () => {
      const s = game(4);
      advance(s, 10);
      const deck = 2;   // mess
      for (const m of s.ship.crew) { m.homeDeck = deck; }
      advance(s, 120);  // everyone wanders to the mess
      setBreach(s, deck, true);
      advance(s, 60);
      const onDeck = s.ship.crew.filter(m => shipGeometry(s.ship).deckOfRow(m.pos.sy) === deck);
      console.log(`      ${s.ship.crew.filter(m => m.suit.wearing).length} suited, pressure ${fmt(s.ship.decks[deck].atmosphere.pressure)} kPa, ${onDeck.length} on deck`);
      assert(s.ship.crew.every(m => !m.dead), 'someone died');
      assert(s.ship.crew.some(m => m.suit.wearing), 'nobody suited up');
    },
  },
  {
    name: 'reactor shutdown and restart need an engineer at the reactor',
    fn: () => {
      const s = game(5);
      advance(s, 5);
      assert(orderShutdown(s).success, 'order shutdown');
      advance(s, 60);
      const eng = s.ship.crew.find(m => m.task?.type === 'reactor');
      assert(eng && eng.task.phase === 'work', 'engineer should be working at the reactor');
      advance(s, 720 + 60 + 5);
      assert(s.reactor.status === ReactorState.OFFLINE, `reactor should be offline, is ${s.reactor.status}`);
      assert(orderStartup(s).success, 'order startup');
      advance(s, 400);
      assert(s.reactor.status === ReactorState.ONLINE, `reactor should be back online, is ${s.reactor.status}`);
    },
  },
  {
    name: 'express 3G trip with juice: crew survive, hangover applied',
    fn: () => {
      const s = game(6);
      const r = planRoutes(s, { kind: 'entity', id: 'pallas-station' }).find(o => o.name === 'EXPRESS');
      engageRoute(s, r.plan);
      let t = 0;
      while (s.autopilot && t < r.estimate.minutes + 3000) { advance(s, 1); t++; }
      const alive = s.ship.crew.filter(m => !m.dead).length;
      const hung = s.ship.crew.filter(m => m.conditions.includes('juice-hangover')).length;
      console.log(`      ${fmt(t / 1440, 2)}d, alive ${alive}/${s.ship.crew.length}, hangovers ${hung}, med supplies ${fmt(s.resources.medSupplies.current)}`);
      assert(!s.autopilot, 'did not arrive');
      assert(alive === s.ship.crew.length, 'crew died on an express run');
      assert(hung > 0, 'juice should leave a hangover');
    },
  },
  {
    name: 'autopilot never throws its own crew around (flips happen strapped in)',
    fn: () => {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const s = game(seed, 5);
        let offer = null;
        bus.on('sos-offered', p => { offer = p; });
        let thrown = 0;
        bus.on('inertia-start', p => { thrown += p.count; });
        forceDistress(s, (t, p) => bus.emit(t, p));
        offer.mission.status = 'accepted';
        engageRoute(s, createPlan('closing', { kind: 'entity', id: offer.mission.entityId }, { accelG: offer.feasibility.g, standoff: STANDOFF.TACTICAL }));
        for (let t = 0; t < 4000 && s.autopilot; t++) {
          minuteTick(s);
          while (isInertiaActive(s)) updateInertia(s, 0.05);
        }
        assert(!s.autopilot, `seed ${seed}: did not arrive`);
        assert(thrown === 0, `seed ${seed}: ${thrown} crew thrown during an autopilot intercept`);
      }
    },
  },
  {
    name: 'juice shows in the vitals; high dose costs more and protects more',
    fn: () => {
      const s = game(9, 2);
      const [a, b] = s.ship.crew;
      const res = s.resources;
      const effA = protectedG(a, 3, true, res); physiologyTick(a, effA, 3);
      const used1 = 50 - res.medSupplies.current;
      const effB = protectedG(b, 10, true, res); physiologyTick(b, effB, 10);
      const used2 = 50 - res.medSupplies.current - used1;
      console.log(`      3G juiced: eff ${fmt(effA, 2)}G bpm ${a.heart.bpm} BP ${a.heart.bpSystolic}/${a.heart.bpDiastolic} · 10G high dose: eff ${fmt(effB, 2)}G bpm ${b.heart.bpm} · doses ${used1}/${used2}`);
      assert(a.heart.bpm > 110 && a.heart.bpSystolic > 140, 'juiced crew should show elevated vitals');
      assert(b.juiceDose === 'high' && used2 === 2 && effB < 2.5, 'high dose: 2 supplies, effective G below dangerous');
      assert(fuelUsed(10, 0) > 10 * fuelUsed(1, 0), 'overdrive should cost extra reaction mass');
    },
  },
  {
    name: 'FLANK 10G is offered only at battle stations, and short dashes are survivable',
    fn: () => {
      const s = game(10, 4);
      assert(!planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).some(o => o.name === 'FLANK 10G'), 'flank must need battle stations');
      s.combatStations = true;
      let offer = null;
      bus.on('sos-offered', p => { offer = p; });
      forceDistress(s, (t, p) => bus.emit(t, p));
      const flank = planRoutes(s, { kind: 'entity', id: offer.entity.id }, { combat: true, standoff: STANDOFF.TACTICAL }).find(o => o.name === 'FLANK 10G');
      assert(flank && flank.estimate.arrived, 'flank option should plan');
      engageRoute(s, flank.plan);
      let t = 0;
      while (s.autopilot && t < 3000) { minuteTick(s); while (isInertiaActive(s)) updateInertia(s, 0.05); t++; }
      const hung = s.ship.crew.filter(m => m.juiceHangover > 4320).length;
      console.log(`      ${fmt(t / 60)}h dash, dead ${s.ship.crew.filter(m => m.dead).length}, long hangovers ${hung}, med left ${fmt(s.resources.medSupplies.current)}, reactor ${s.reactor.status}`);
      assert(!s.autopilot, 'flank dash did not arrive');
      assert(s.ship.crew.every(m => !m.dead), 'a short flank dash should not kill strapped-in crew');
      assert(hung > 0, 'high dose should leave a long hangover');
    },
  },
  {
    name: 'arrives at moon-orbiting stations (Luna, Ganymede)',
    fn: () => {
      for (const id of ['luna-yards', 'ganymede-station']) {
        const s = game(8);
        const r = planRoutes(s, { kind: 'entity', id }, { includeBallistic: false }).find(o => o.name === 'EXPRESS');
        assert(r.estimate.arrived, `${id}: planner found no arrival`);
        s.combatStations = false;
        engageRoute(s, r.plan);
        let t = 0;
        while (s.autopilot && t < r.estimate.minutes + 3000) { minuteTick(s); t++; }
        assert(!s.autopilot && s.flight.hold?.id === id, `${id}: not holding after ${t} min`);
        console.log(`      ${id}: ${fmt(t / 1440, 2)} days`);
      }
    },
  },
];
