// Fire aboard: it burns the air of its deck, the crew fight it, venting
// starves it; the SUITS order puts everyone in a suit so a deck can be
// vented with its people on it.
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { ignite, FIRE } from '../js/sim/fire.js';
import { setVented, orderSuits, suitedCount } from '../js/sim/life-support.js';
import { shipGeometry } from '../js/sim/ship-layout.js';

function game(seed = 4) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 6, traffic: 0 });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

const deckOf = (s, id) => s.ship.decks.findIndex(d => d.id === id);

export default [
  {
    name: 'a fire grows on its deck\'s air, and the crew suit up and put it out',
    fn: () => {
      const s = game();
      const mess = deckOf(s, 'mess');
      const ev = {}; bus.on('*', (t, p) => { (ev[t] ||= []).push(p); });
      assert(ignite(s, mess, 0.2, 'hit', (t, p) => bus.emit(t, p)), 'it caught');
      let peak = 0, minO2 = 100, t = 0;
      for (; t < 180 && s.ship.decks[mess].atmosphere.fire; t++) { advance(s, 1); const a = s.ship.decks[mess].atmosphere; peak = Math.max(peak, a.fire?.intensity || 0); minO2 = Math.min(minO2, a.o2Pct); }
      const fighters = (ev['crew-suited'] || []).length;
      console.log(`      out after ${t} min · peak ${fmt(peak * 100, 0)}% · O₂ down to ${fmt(minO2)}% · ${fighters} suited to fight it`);
      assert(!s.ship.decks[mess].atmosphere.fire, 'the fire is out');
      assert(fighters >= 1, 'someone suited up to fight it');
      assert(minO2 < 20.5, 'it burned the deck\'s oxygen');
    },
  },
  {
    name: 'venting a burning deck starves the fire; SUITS puts everyone in a suit first',
    fn: () => {
      const s = game(5);
      const geo = shipGeometry(s.ship);
      orderSuits(s, true);
      let t = 0;
      const aboard = s.ship.crew.filter(m => !m.dead).length;
      for (; t < 60 && suitedCount(s) < aboard; t++) advance(s, 1);
      console.log(`      SUITS: ${suitedCount(s)}/${aboard} suited in ${t} min`);
      assert(suitedCount(s) === aboard, 'all hands suited');
      const q = deckOf(s, 'quarters');
      const ok = ignite(s, q, 0.5);
      assert(ok, 'it caught');
      setVented(s, q, true);
      let m = 0;
      for (; m < 60 && s.ship.decks[q].atmosphere.fire; m++) advance(s, 1);
      const onDeck = s.ship.crew.filter(c => geo.deckOfRow(c.pos.sy) === q);
      console.log(`      vented: out in ${m} min at ${fmt(s.ship.decks[q].atmosphere.pressure)} kPa · ${onDeck.length} on the deck, ${onDeck.filter(c => c.conditions.includes('decompression')).length} decompressed`);
      assert(!s.ship.decks[q].atmosphere.fire && m < 25, 'starved by the vacuum');
      assert(onDeck.every(c => !c.conditions.includes('decompression')), 'suited crew on the deck are fine');
      // the order lifted, suits come off where the air is good
      setVented(s, q, false);
      orderSuits(s, false);
      advance(s, 240);
      assert(suitedCount(s) < aboard, 'suits off again');
    },
  },
];
