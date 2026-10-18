// Crew behaviour: medicine, rescue chain, inertial events, life support.
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { triggerManeuver, updateInertia, isInertiaActive, Maneuver } from '../js/sim/inertia.js';
import { shipGeometry } from '../js/sim/ship-layout.js';
import { setBreach } from '../js/sim/life-support.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute } from '../js/sim/autopilot.js';
import { orderShutdown, orderStartup, ReactorState } from '../js/sim/reactor.js';

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
      const n = triggerManeuver(s, Maneuver.BURN_START, { deltaG: 3, surprise: true, gForce: 3 });
      assert(n === s.ship.crew.length - 1, `expected ${s.ship.crew.length - 1} bodies in motion, got ${n}`);
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
