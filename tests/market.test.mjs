// ============================================================
// LONGHAUL — Tests: the market
//
// Fifteen markets, stations and settled worlds, each making and wanting
// goods, shipping them to each other: the loop is closed (no good piles up
// or runs out for good) and bounded, prices answer stock, cheap where a
// good is made and dear where it is wanted; we buy and sell against the
// stock (the price walks as we do); the law on what we carry (narcotics,
// munitions, stolen goods) and a licensed captain turning contraband over;
// ships' stores priced by the market; holds labelled, read by a search,
// taken good by good; a shuttle's trade on a world's ground; the news at
// light speed; saves; the cost.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { createGame, advance, upgradeState } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { releaseHold, holdStation } from '../js/sim/autopilot.js';
import { parkingTarget, targetStateAt } from '../js/sim/nav.js';
import { GOODS, GOOD_IDS } from '../js/sim/goods.js';
import * as MK from '../js/sim/market.js';
import { contrabandFor, turnOverHere, turnOverContraband } from '../js/sim/law.js';
import { priceOf, PRICES } from '../js/sim/contracts.js';
import { spawnAgent } from '../js/sim/agents.js';
import { wreckNpc } from '../js/sim/damage.js';
import { startBoarding, orderAboard } from '../js/sim/boarding.js';
import { airspacesOf, worldOf } from '../js/sim/worlds.js';
import { planRun, launchRun, activeRuns } from '../js/sim/shuttles.js';
import { createService } from '../js/sim/service.js';

function game(seed = 4, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 4, ...opts });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  return s;
}
/** Run the market alone `days` days (its steps, nothing else). */
function marketDays(s, days, each = null) {
  s.clock.minute = s.clock.minute - (s.clock.minute % MK.MARKET_STEP_MIN) + 7;
  for (let d = 0; d < days; d++) { for (let k = 0; k < 4; k++) { s.clock.minute += MK.MARKET_STEP_MIN; MK.marketTick(s); } each?.(d); }
}
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const OPEN = MK.MARKET_IDS.filter(MK.isOpen);

export default [
  {
    name: 'the loop is closed and bounded: a year on, no good has piled up or run out, every price inside its bounds, and the news of shocks',
    fn: () => {
      const s = game(4);
      const total = (g) => MK.MARKET_IDS.reduce((a, id) => a + s.market.nodes[id].stock[g], 0);
      const t0 = Object.fromEntries(GOOD_IDS.map(g => [g, total(g)]));
      let lo = Infinity, hi = 0, shocks = 0;
      marketDays(s, 365, () => {
        for (const id of MK.MARKET_IDS) for (const g of GOOD_IDS) { const ix = MK.priceIndex(s, id, g); lo = Math.min(lo, ix); hi = Math.max(hi, ix); }
      });
      shocks = s.market.news.length;
      const drift = GOOD_IDS.map(g => total(g) / t0[g]);
      assert(drift.every(d => d > 0.8 && d < 1.2), `stocks within a fifth of where they began: ${GOOD_IDS.map((g, i) => `${g} ${fmt(drift[i], 2)}`).join(' ')}`);
      assert(lo >= MK.PRICE_MIN - 1e-9 && hi <= MK.PRICE_MAX + 1e-9, `prices ${fmt(lo, 2)}–${fmt(hi, 2)} of base`);
      assert(shocks > 10, `shocks in the news (${shocks} kept)`);
      console.log(`      a year: stocks ${fmt(Math.min(...drift), 2)}–${fmt(Math.max(...drift), 2)} of where they began, prices ${fmt(lo, 2)}–${fmt(hi, 2)} of base; e.g. "${s.market.news.at(-1).text}"`);
      // another game (another seed: other traffic) has its own: its market's dice seeded from what its own made
      const s2 = game(5), s3 = game(4);
      assert(s2.market.rng !== s3.market.rng && s3.market.rng === game(4).market.rng, 'each game its own shocks; the same seed, the same');
    },
  },
  {
    name: 'geography: a good is cheap where it is made and dear where it is wanted; the routes a trader runs, against what a cargo contract pays',
    fn: () => {
      const s = game(4);
      marketDays(s, 30);
      const rows = [];
      for (const g of ['water', 'food', 'ore', 'metals', 'parts', 'electronics', 'consumer']) {
        const makers = OPEN.filter(id => MK.MARKETS[id].make[g]), wanters = OPEN.filter(id => MK.MARKETS[id].want[g] && !MK.MARKETS[id].make[g]);
        const pm = median(makers.map(id => MK.priceIndex(s, id, g))), pw = median(wanters.map(id => MK.priceIndex(s, id, g)));
        assert(pm < pw, `${g}: made ${fmt(pm, 2)} < wanted ${fmt(pw, 2)} (of base)`);
      }
      // routes between stations: buy 10 t, sell it there (the spread and the slippage paid), MCR a tonne
      for (const [from, to, g] of [['ceres-station', 'hygiea-ring', 'water'], ['ganymede-station', 'ceres-station', 'food'], ['tycho-station', 'pallas-station', 'parts'], ['vesta-depot', 'pallas-station', 'ore'], ['pallas-station', 'tycho-station', 'metals']]) {
        const buy = MK.quote(s, from, g, 10, 'buy'), sell = MK.quote(s, to, g, 10, 'sell');
        const d = Math.hypot(getWorld(s).get(from).pos.x - getWorld(s).get(to).pos.x, getWorld(s).get(from).pos.y - getWorld(s).get(to).pos.y);
        rows.push(`${GOODS[g].name.toLowerCase()} ${getWorld(s).get(from).name} → ${getWorld(s).get(to).name} (${fmt(d, 2)} AU): ${fmt((sell.total - buy.total) / 10, 0)} a tonne`);
      }
      console.log(`      10 t lots, after the spread and the slippage (a cargo contract pays 300 a tonne and 900 an AU):\n      ${rows.join('\n      ')}`);
    },
  },
  {
    name: 'we trade against the stock: the price walks as we buy and sell, a shallow market faster; credits, the hold and its room counted',
    fn: () => {
      const s = game(4);
      const id = MK.marketHere(s);
      assert(id === 'ceres-station', `docked at Ceres: its market (${id})`);
      const p0 = MK.priceAt(s, id, 'water');
      const one = MK.quote(s, id, 'water', 1, 'buy'), ten = MK.quote(s, id, 'water', 10, 'buy');
      assert(ten.avg >= one.avg && one.avg > p0, `buying walks the price up: ${fmt(one.avg, 1)} for one, ${fmt(ten.avg, 1)} a tonne for ten (mid ${fmt(p0, 1)})`);
      // a shallow market: Vesta's electronics, a few tonnes deep
      const v1 = MK.quote(s, 'vesta-depot', 'electronics', 1, 'sell'), v5 = MK.quote(s, 'vesta-depot', 'electronics', 5, 'sell');
      assert(v5.avg < v1.avg * 0.95, `a shallow market takes little: selling five tonnes of electronics at Vesta ${fmt(v5.avg, 0)} a tonne against ${fmt(v1.avg, 0)} for one`);
      const c0 = s.resources.credits.current;
      const r = MK.buyGood(s, id, 'water', 10);
      assert(r.ok && Math.abs(MK.heldOf(s, 'water') - 10) < 1e-6 && Math.abs(c0 - s.resources.credits.current - r.total) < 1e-6, r.text);
      assert(MK.priceAt(s, id, 'water') > p0, 'and the price stays up a little');
      const big = MK.buyGood(s, id, 'water', 1e6);
      assert(big.ok && MK.holdRoom(s) < 1, `MAX fills the hold (${fmt(big.t, 1)} t)`);
      const sold = MK.sellGood(s, id, 'water', Infinity);
      assert(sold.ok && MK.heldOf(s, 'water') === 0 && sold.total < r.total + big.total, `sold it all back for less than we paid: ${sold.text}`);
      s.resources.credits.current = 100;
      const poor = MK.buyGood(s, id, 'pgm', 1);
      assert(!poor.ok || poor.total <= 100, `no more than we can pay for (${poor.text})`);
      s.resources.credits.current = 10_000;
      const d = s.dock; s.dock = null;
      assert(!MK.buyGood(s, id, 'water', 1).ok && !MK.sellGood(s, id, 'water', 1).ok, 'undocked: no trade, the goods cross a berth\'s collar');
      s.dock = d;
    },
  },
  {
    name: 'the law on goods: narcotics only at independent ports and seized by any power; munitions restricted; stolen goods refused by their owners and fenced elsewhere; a licensed captain turns over contraband taken off a hull for reputation (not what it bought, not what it stole, not a token amount)',
    fn: () => {
      const s = game(4);
      assert(MK.tradeRefusal(s, 'ceres-station', 'narcotics', 'buy') && !MK.tradeRefusal(s, 'vesta-depot', 'narcotics', 'buy'), 'narcotics at Vesta, not at Ceres');
      assert(MK.tradeRefusal(s, 'luna-yards', 'munitions', 'buy') && !MK.tradeRefusal(s, 'tycho-station', 'munitions', 'buy'), 'munitions sold at Luna only to the UNN\'s contractors; at Tycho to anyone');
      MK.stow(s, { good: 'narcotics', mass: 500, from: 'vesta-depot' });
      MK.stow(s, { good: 'munitions', mass: 800, from: 'tycho-station' });
      MK.stow(s, { good: 'electronics', mass: 1000, seized: true, stolen: 'UN', from: 'x' });
      const un = contrabandFor(s, 'UN').cargo.map(c => c.good), opa = contrabandFor(s, 'OPA').cargo.map(c => c.good);
      assert(un.includes('narcotics') && un.includes('munitions') && un.includes('electronics') && opa.includes('narcotics') && !opa.includes('munitions'), `a UN inspector takes ${un.join(', ')}; an OPA one ${opa.join(', ')}`);
      assert(!MK.sellGood(s, 'luna-yards', 'electronics', 1).ok, 'a UN port won\'t buy goods stolen from UN hulls');
      const fence = MK.quote(s, 'ceres-station', 'electronics', 1, 'sell').total * MK.FENCE;
      const sold = MK.sellGood(s, 'ceres-station', 'electronics', 1);
      assert(sold.ok && Math.abs(sold.total - fence) < 1, `fenced at Ceres: ${fmt(sold.total, 0)} MCR (a ${MK.FENCE} share)`);
      // licensed with the OPA, docked at Ceres (an OPA port): narcotics we bought are no seizure, and a token amount no case
      s.service = createService('OPA', s.clock.minute);
      assert(!turnOverHere(s), 'bought narcotics: nothing to turn over');
      assert(contrabandFor(s, 'OPA').cargo.some(c => c.good === 'narcotics'), 'and our own power\'s inspectors seize what we bought');
      MK.stow(s, { good: 'narcotics', mass: 20, seized: true, from: 'some-wreck' });
      assert(!turnOverHere(s), 'twenty kilos taken off a hull: not worth the paperwork');
      // taken off a hull: evidence to our own power's inspectors, seized by another's; turned over for reputation
      MK.stow(s, { good: 'narcotics', mass: 400, seized: true, from: 'some-wreck' });
      const taken = (f) => contrabandFor(s, f).cargo.filter(c => c.good === 'narcotics' && c.seized);
      assert(!taken('OPA').length && taken('UN').length, 'carried for our own power, still seized by another');
      s.cargo.push({ contract: 'c-smuggle', name: 'crates', mass: 300, contraband: true, illegalIn: ['OPA'] });
      MK.stow(s, { good: 'pharma', mass: 500, seized: true, stolen: 'UN', from: 'x' });
      const here = turnOverHere(s);
      assert(here && here.items.every(c => c.good === 'narcotics' && c.seized) && !here.items.some(c => c.contract || c.stolen), `turnable here: ${here?.items.map(c => `${c.mass / 1000} t ${c.good}`).join(', ')} (not bought, not stolen, not a contract's)`);
      const rep0 = s.service.rep.OPA || 0, st0 = s.law.standing.OPA;
      const r = turnOverContraband(s, (t, p) => {});
      assert(r.ok && r.rep > 0 && s.law.standing.OPA >= st0 && (s.service.rep.OPA || 0) > rep0 && !s.cargo.some(c => c.good === 'narcotics' && c.seized), r.text);
      assert(s.cargo.some(c => c.contract === 'c-smuggle'), 'the contract\'s crates stay');
      console.log(`      ${r.text}`);
    },
  },
  {
    name: 'a ship\'s stores are priced by the market where it docks: reaction mass cheap where ice is plentiful, rations dear where food is short',
    fn: () => {
      const s = game(4);
      const ice = MK.priceIndex(s, 'ceres-station', 'water'), food = MK.priceIndex(s, 'ceres-station', 'food');
      const fuel = priceOf(s, 'fuel') / PRICES.fuel, rations = priceOf(s, 'food') / PRICES.food;
      assert((ice < 1) === (fuel < 1) && (food > 1) === (rations > 1) && fuel > 0.55 && rations < 2.05, `at Ceres: ice ${fmt(ice, 2)} → fuel ${fmt(fuel, 2)} of list; food ${fmt(food, 2)} → rations ${fmt(rations, 2)}`);
    },
  },
  {
    name: 'holds are labelled: a hauler carries ice, a miner ore, a freighter what its port makes; a lawful ship\'s filed manifest hides its contraband; a search reads the real one; taken good by good, stolen from a lawful ship, salvage from a wreck',
    fn: () => {
      const s = game(4, { classId: 'cutter', crewCount: 8, docked: false });
      releaseHold(s); s.dock = null;
      s.flight.pos.y += 0.02;
      const f = s.flight;
      const mk = (cls, faction = 'UN', tags = {}) => { const e = spawnAgent(s, { role: 'civilian', cls, faction, pos: { x: f.pos.x + 900 / AU_M, y: f.pos.y }, vel: { ...f.vel } }); Object.assign(e.tags, tags); return e; };
      const hauler = mk('ice-hauler'), miner = mk('mining-barge');
      assert(MK.holdOf(s, hauler).every(x => x.good === 'water') && MK.holdOf(s, miner).some(x => x.good === 'ore'), `hauler: ${MK.holdWords(MK.holdOf(s, hauler))}; miner: ${MK.holdWords(MK.holdOf(s, miner))}`);
      const fr = mk('freighter', 'UN', { from: 'pallas-station' });
      assert(MK.holdOf(s, fr).every(x => MK.MARKETS['pallas-station'].make[x.good]), `a freighter out of Pallas: ${MK.holdWords(MK.holdOf(s, fr))}`);
      assert(!fr.tags.hold && JSON.stringify(MK.holdOf(s, fr)) === JSON.stringify(MK.holdOf(s, fr)), 'worked out the same each look, kept only once something is taken');
      // a wreck: salvage, its hold read by a search, taken good by good
      const w = mk('freighter', 'UN', { from: 'ganymede-station' });
      w.tags.hold = [{ good: 'food', t: 30 }, { good: 'delicacies', t: 2 }, { good: 'narcotics', t: 0.5 }];
      assert(!MK.declaredHold(s, w).some(x => x.good === 'narcotics'), 'its filed manifest leaves out the narcotics');
      wreckNpc(s, w, null);
      const party = s.ship.crew.filter(m => m.role !== 'Captain' && m.role !== 'Pilot').slice(0, 3).map(m => m.id);
      startBoarding(s, w.id, { party, via: 'eva' });
      let t = 0; while (s.boarding?.phase !== 'secured' && t++ < 200) advance(s, 1);
      orderAboard(s, 'search');
      t = 0; while (s.boarding.action && t++ < 60) advance(s, 1);
      const known = MK.knownHold(s, w, true);
      assert(known?.src === 'searched' && known.items.some(x => x.good === 'narcotics'), `searched: ${MK.holdWords(known?.items)}`);
      // (taking cargo wants a mated collar: dock with it, then take the delicacies alone, then the rest)
      s.boarding.via = 'dock';
      s.dock = { target: { kind: 'ship', id: w.id }, phase: 'docked', berth: 'x', port: 'y', rel: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, wy: 0, wp: 0, wr: 0 }, t: 0, since: s.clock.minute };
      const o = orderAboard(s, 'cargo', () => {}, { good: 'delicacies' });
      assert(o.ok, o.text);
      t = 0; while (s.boarding.action && t++ < 60) advance(s, 1);
      assert(Math.abs(MK.heldOf(s, 'delicacies') - 2) < 1e-6 && !s.cargo.find(c => c.good === 'delicacies').stolen, `${o.text}: two tonnes of delicacies aboard, salvage (not stolen)`);
      const room = MK.holdRoom(s) / 1000;
      orderAboard(s, 'cargo');
      t = 0; while (s.boarding.action && t++ < 200) advance(s, 1);
      assert(MK.heldOf(s, 'food') > 0 && MK.holdRoom(s) < Math.max(1000, room * 1000 - 29_000), `the rest, as much as fits: ${MK.holdWords(s.cargo.filter(c => c.good).map(c => ({ good: c.good, t: c.mass / 1000 })))} (room was ${fmt(room, 1)} t)`);
    },
  },
  {
    name: 'a shuttle trades on a world\'s ground: goods carried down and sold there, a purchase brought up and stowed, paid by radio',
    fn: () => {
      const s = game(5, { classId: 'ares', crewCount: 5, traffic: 0, forces: false, docked: false });
      releaseHold(s); s.dock = null;
      const tgt = parkingTarget(s, 'Mars', s.clock.minute), st = targetStateAt(s, tgt, s.clock.minute);
      s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel }; holdStation(s, tgt); advance(s, 2);
      MK.stow(s, { good: 'water', mass: 3000, cost: 600, from: 'ceres-station' });
      s.resources.credits.current = 50_000;
      const c0 = s.resources.credits.current;
      const a = airspacesOf(worldOf('Mars'))[1];
      const r = launchRun(s, planRun(s, s.shuttles.bay[0].id, a.id).plan, () => {}, { trade: { sell: ['water'], buy: { good: 'electronics', t: 1 } } });
      assert(r.ok && MK.heldOf(s, 'water') === 0, 'the ice goes down with it');
      let t = 0; while (activeRuns(s).length && t++ < 2000) advance(s, 1);
      const got = s.cargo.find(c => c.good === 'electronics');
      assert(got && Math.abs(got.mass - 1000) < 1 && got.from === 'world:Mars', `a tonne of electronics up from Mars (${got && fmt(got.cost, 0)} MCR)`);
      const net = s.resources.credits.current - c0;
      assert(net < 0 && net > -got.cost, `the ice paid part of it: net ${fmt(net, 0)} MCR`);
      console.log(`      3 t of ice sold on Mars' ground, a tonne of electronics bought: net ${fmt(net, 0)} MCR, ${r.run.log.find(l => /Market/.test(l.text))?.text}`);
    },
  },
  {
    name: 'market news comes at light speed; a save keeps the market; an old save is given one; a market step is cheap, a new game\'s warm-up worked out once',
    fn: () => {
      const s = game(4);
      marketDays(s, 60);
      const queued = s.intel.inbox.filter(i => i.type === 'market-news');
      assert(queued.length || (s.market.heard || []).length === 0, 'news queued in the inbox, not heard at once');
      const heard = [];
      bus.on('market-news', (p) => heard.push(p));
      advance(s, 120);
      assert((s.market.heard || []).every(n => n.text), `heard ${heard.length} in two hours, ${(s.market.heard || []).length} kept`);
      const { state: t } = deserialize(serialize(s));
      assert(Math.abs(MK.priceAt(t, 'ceres-station', 'water') - MK.priceAt(s, 'ceres-station', 'water')) < 1e-6, 'the same prices after a save');
      delete t.market;
      upgradeState(t);
      assert(t.market && MK.priceAt(t, 'ceres-station', 'water') > 0, 'an old save gets a market');
      s.clock.minute = s.clock.minute - (s.clock.minute % MK.MARKET_STEP_MIN) + 7;
      const t0 = performance.now();
      for (let k = 0; k < 40; k++) { s.clock.minute += MK.MARKET_STEP_MIN; MK.marketTick(s); }
      const per = (performance.now() - t0) / 40;
      const g0 = performance.now(); game(9); const once = performance.now() - g0;
      assert(per < 5, `a market step ${fmt(per, 2)} ms`);
      console.log(`      a market step ${fmt(per, 2)} ms (every six hours); a new game ${fmt(once, 0)} ms with its market worked out already`);
    },
  },
];
