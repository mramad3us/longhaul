// ============================================================
// LONGHAUL — The market: what each port makes and wants, and what it pays
//
// FIFTEEN MARKETS: the eight stations, and the seven settled worlds
// (worlds.js SETTLEMENTS), traded with by shuttle from a high orbit
// (shuttles.js). Phobos' naval yard is one of them but trades with nobody
// passing (OPEN: no). Each MAKES some goods (tonnes a day) and WANTS others
// (MARKETS), and keeps a STOCK of every good (goods.js) against a TARGET:
// a fortnight of what it makes and uses (DAYS_STOCK), and a few tonnes of
// everything besides, all times its DEPTH (Earth's market is deep, Vesta's
// shallow).
//
// THE PRICE is the good's base price over the market's fullness (stock /
// target) to the power ELASTIC, held between PRICE_MIN and PRICE_MAX of
// base: plenty is cheap, scarcity dear. We pay a little over it and are
// paid a little under (SPREAD), and as we buy, the stock falls and the
// price climbs (a quote integrates it, tonne by tonne): a shallow market
// takes little before it is dear. What we sell or buy stays in its stock.
//
// THE LOOP, every MARKET_STEP_MIN (in the minute's wider-world step):
//   made and used  each market makes and uses its goods, a little less
//                  when it is glutted, and uses less when it is short;
//                  across the system each good is made as fast as it is
//                  used (WANT_SCALE), so the loop is closed: no good piles
//                  up or runs out for good;
//   shipped        goods flow between every pair of markets from the
//                  fuller to the emptier, faster between near ones
//                  (conductance 0.4 / (0.4 + distance in AU), the worlds
//                  where they are that day), conserved: what leaves one
//                  arrives at the other. Not tied to the ships flying: the
//                  traffic is the world's, the flows its outcome;
//   shocks         now and then a market's output of something it makes
//                  fails for days (a strike, a blight, an accident), or
//                  its need of something jumps (a boom, an epidemic): the
//                  price runs, and the news says so ('market-news');
//   the fighting   a market within 0.6 AU of a hot zone (conflict.js)
//                  wants munitions, medical supplies and food more, and
//                  trades less with everyone else.
// The market draws its shocks from a generator of its own (rng.js nextOf),
// so the main stream, and every test seeded on it, is left alone; it is
// seeded from what the game's own dice made (its first traffic's names, our
// ship's), so every game has its own shocks and a seeded test the same.
// Goods change hands across a berth's collar (docked at its station), or
// on a world's pad by shuttle (shuttleTrade); elsewhere a board is read.
//
// WHAT WE KNOW of a market far off is its prices as they were a light-time
// ago (knownPrices: the snapshot every step keeps, the last few).
//
// A SHIP'S HOLD. Every hull carries what its trade carries (holdOf): an ice
// hauler ice, a tanker volatiles, a miner ore, a freighter what its last
// port makes, a pirate loot; worked from its id (and its last port, so it
// changes as the ship trades), and kept on it once anything is taken
// (holdToTake: e.tags.hold), what is taken gone from it. A shuttle carries
// its run's load, nothing of its own. A lawful
// ship with its transponder on has filed its manifest (declaredHold:
// never the contraband); a boarding party's search reads the real one.
// ============================================================

import { AU_M, DAY_MIN } from '../core/constants.js';

const C_MS = 299_792_458;
import { nextOf, seedOf, hashString } from '../core/rng.js';
import { GOODS, GOOD_IDS, lawOf, tonnes } from './goods.js';
import { getWorld } from './world.js';
import { bodyPos } from './ephemeris.js';
import { worldOf } from './worlds.js';
import { zonePos } from './conflict.js';
import { licenseOf } from './service.js';
import { relay } from './intel.js';
import { CLASSES } from './ship-classes.js';

export const MARKET_STEP_MIN = 360;
const SUBSTEPS = 6;                  // the flows, stepped this often a market step (stable for the nearest pairs)
const DAYS_STOCK = 12;
const THIN = 6;                      // tonnes of anything, before depth
const ELASTIC = 1.1;
export const PRICE_MIN = 0.35, PRICE_MAX = 3.2;
export const SPREAD = 0.04;          // over the price we pay, under it we are paid
export const FENCE = 0.7;            // stolen goods fetch this share of the price
const FLOW = 0.02;                  // a substep's share of the gap between two markets, at conductance 1 (≤ 1/(2·neighbours): stable)
const SHOCK_P = 0.03;                // a market's chance of a shock, each day
const ZONE_AU = 0.6;
const HISTORY = 12;                  // snapshots kept (three days)
const WARMUP_DAYS = 90;

/**
 * The markets. make / want: tonnes a day. depth: how deep its market runs.
 * open: whether a passing trader may buy and sell (Phobos: a naval yard).
 * world: a settled world's ground, traded with by shuttle.
 */
export const MARKETS = {
  'ceres-station': { faction: 'OPA', depth: 1.2, make: { water: 120, volatiles: 30, ore: 60 }, want: { food: 60, delicacies: 2, medical: 1, pharma: 0.2, parts: 8, electronics: 2, consumer: 15, munitions: 1, narcotics: 0.2 } },
  'pallas-station': { faction: 'OPA', depth: 1, make: { metals: 120, pgm: 1.2 }, want: { ore: 190, volatiles: 20, food: 15, parts: 6, medical: 0.3 } },
  'vesta-depot': { faction: 'independent', depth: 0.6, make: { ore: 200, pgm: 1 }, want: { food: 10, water: 20, parts: 6, medical: 0.3, consumer: 5, narcotics: 0.3 } },
  'hygiea-ring': { faction: 'OPA', depth: 0.6, make: { food: 60, delicacies: 1.5, narcotics: 0.4 }, want: { water: 40, volatiles: 25, parts: 3, electronics: 1, consumer: 5 } },
  'tycho-station': { faction: 'OPA', depth: 1, make: { parts: 20, munitions: 1.5, consumer: 10 }, want: { ore: 70, metals: 100, electronics: 5, volatiles: 15, food: 20, water: 30, medical: 0.5, pgm: 0.5 } },
  'luna-yards': { faction: 'UN', depth: 1.2, make: { munitions: 3, parts: 8 }, want: { metals: 80, pgm: 0.8, electronics: 3, volatiles: 20, water: 30, food: 25 } },
  'phobos-yard': { faction: 'MCR', depth: 0.8, open: false, make: { munitions: 2.5 }, want: { metals: 40, parts: 5, electronics: 3, food: 10, water: 15 } },
  'ganymede-station': { faction: 'independent', depth: 1, make: { food: 150, delicacies: 4 }, want: { water: 60, parts: 6, electronics: 2, medical: 0.6, consumer: 8, volatiles: 20, narcotics: 0.2 } },
  'world:Earth': { world: 'Earth', faction: 'UN', depth: 6, make: { electronics: 6, pharma: 1.2, medical: 4, consumer: 30, delicacies: 4 }, want: { pgm: 1.5, volatiles: 20, metals: 20, narcotics: 0.3 } },
  'world:Luna': { world: 'Luna', faction: 'UN', depth: 2, make: { metals: 30, volatiles: 10 }, want: { food: 30, water: 60, consumer: 5, medical: 0.5 } },
  'world:Mars': { world: 'Mars', faction: 'MCR', depth: 4, make: { electronics: 3, parts: 6, munitions: 2, pharma: 0.3 }, want: { water: 200, volatiles: 80, food: 40, pgm: 0.5, delicacies: 2, consumer: 10 } },
  'world:Ganymede': { world: 'Ganymede', faction: 'independent', depth: 1.5, make: { food: 120, delicacies: 2 }, want: { parts: 4, electronics: 1, medical: 0.4, consumer: 6 } },
  'world:Callisto': { world: 'Callisto', faction: 'MCR', depth: 1.2, make: { water: 50, volatiles: 10 }, want: { food: 15, parts: 4, electronics: 1, munitions: 1 } },
  'world:Europa': { world: 'Europa', faction: 'OPA', depth: 1.2, make: { water: 150, volatiles: 5 }, want: { food: 20, parts: 3, medical: 0.3, consumer: 4 } },
  'world:Titan': { world: 'Titan', faction: 'OPA', depth: 1.2, make: { volatiles: 120, narcotics: 0.4 }, want: { food: 15, water: 10, parts: 3, electronics: 1, consumer: 3 } },
};
export const MARKET_IDS = Object.keys(MARKETS);
export const marketOfWorld = (name) => MARKETS[`world:${name}`] ? `world:${name}` : null;
export const marketName = (state, id) => MARKETS[id]?.world ? `${MARKETS[id].world}` : getWorld(state).get(id)?.name || id;
export const isOpen = (id) => MARKETS[id] && MARKETS[id].open !== false;

/** Across the system, each good is used as fast as it is made: what each market's want is scaled by. */
const WANT_SCALE = Object.fromEntries(GOOD_IDS.map(g => {
  let made = 0, used = 0;
  for (const m of Object.values(MARKETS)) { made += m.make[g] || 0; used += m.want[g] || 0; }
  return [g, used > 0 ? made / used : 0];
}));
/** A market's target stock of a good (t). */
export const targetOf = (id, g) => { const m = MARKETS[id]; return m.depth * (THIN + DAYS_STOCK * ((m.make[g] || 0) + (m.want[g] || 0) * WANT_SCALE[g])); };

// ---- STATE ----

const _warm = new Map();

/**
 * A new market, run on till it has found its level: WARMUP_DAYS of steps
 * before the game begins, with no shocks and no fighting (so it depends on
 * the start minute alone, and is worked out once for each: a new game is
 * cheap).
 */
export function createMarket(state) {
  const t0 = state.clock.minute;
  // (seeded from what the game's own dice made of it: its first traffic's names, different every game, the same under a test's seed)
  const names = state.entities.filter(e => e.tags?.traffic).slice(0, 12).map(e => e.name).join('|');
  const M = { rng: seedOf(`market:${state.ship?.name || ''}:${names}:${t0}`), at: t0, nodes: {}, history: {}, news: [] };
  state.market = M;
  let warm = _warm.get(t0);
  if (!warm) {
    for (const id of MARKET_IDS) M.nodes[id] = { stock: Object.fromEntries(GOOD_IDS.map(g => [g, targetOf(id, g)])), shocks: [] };
    for (let k = 0; k < WARMUP_DAYS * DAY_MIN / MARKET_STEP_MIN; k++) step(state, t0 - WARMUP_DAYS * DAY_MIN + k * MARKET_STEP_MIN, { shocks: false, war: false });
    warm = JSON.stringify(M.nodes);
    if (_warm.size > 8) _warm.clear();
    _warm.set(t0, warm);
  }
  M.nodes = JSON.parse(warm);
  for (const id of MARKET_IDS) M.history[id] = [];
  snapshot(state, t0);
  return M;
}

/** Where a market is at `minute` (AU). */
function placeOf(state, id, minute) {
  const m = MARKETS[id];
  if (m.world) return bodyPos(worldOf(m.world).body, minute / DAY_MIN);
  return getWorld(state).get(id)?.pos || { x: 0, y: 0 };
}

/** How hard the fighting presses on a market at `pos` (0–1: the nearest hot zone's intensity, less with distance). */
function warOf(state, pos, minute) {
  let k = 0;
  for (const z of state.politics?.zones || []) {
    const p = zonePos(z, minute);
    const d = Math.hypot(p.x - pos.x, p.y - pos.y);
    if (d < ZONE_AU) k = Math.max(k, (z.intensity ?? 0.5) * (1 - d / ZONE_AU));
  }
  return k;
}

/**
 * One market step at `minute`: made and used, shipped, shocks. Pure over
 * state.market (and the positions of things).
 */
function step(state, minute, { shocks = true, war: fighting = true } = {}) {
  const M = state.market, dt = MARKET_STEP_MIN / DAY_MIN;
  const ids = MARKET_IDS, n = ids.length;
  const pos = ids.map(id => placeOf(state, id, minute));
  const war = ids.map((id, i) => fighting ? warOf(state, pos[i], minute) : 0);
  // ---- made and used
  for (let i = 0; i < n; i++) {
    const id = ids[i], m = MARKETS[id], node = M.nodes[id];
    node.shocks = node.shocks.filter(s => s.until > minute);
    for (const g of GOOD_IDS) {
      const T = targetOf(id, g), f = node.stock[g] / T;
      let made = (m.make[g] || 0) * Math.min(1.3, Math.max(0.1, 1.6 - 0.6 * f));
      let used = (m.want[g] || 0) * WANT_SCALE[g] * Math.min(1.5, Math.max(0.1, 0.15 + 0.85 * f));
      for (const s of node.shocks) if (s.g === g) { if (s.kind === 'make') made *= s.k; else used *= s.k; }
      // (the fighting near it: munitions, medical supplies and food wanted more)
      if (war[i] > 0) {
        if (g === 'munitions') used += 2.5 * war[i] * m.depth;
        else if (g === 'medical') used *= 1 + war[i];
        else if (g === 'food') used *= 1 + 0.3 * war[i];
      }
      node.stock[g] = Math.max(0, node.stock[g] + (made - used) * dt);
    }
  }
  // ---- shipped: pairwise, conserved, faster between near markets (the fighting chokes it)
  const w = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
    w.push([i, j, FLOW * 0.4 / (0.4 + d) * (1 - 0.4 * Math.max(war[i], war[j]))]);
  }
  for (const g of GOOD_IDS) {
    const T = ids.map(id => targetOf(id, g));
    const st = ids.map(id => M.nodes[id].stock[g]);
    for (let k = 0; k < SUBSTEPS; k++) {
      const dS = new Float64Array(n);
      for (const [i, j, r] of w) {
        // (the amount that would even their fullness, a share of it)
        const flow = r * (st[i] / T[i] - st[j] / T[j]) * T[i] * T[j] / (T[i] + T[j]);
        dS[i] -= flow; dS[j] += flow;
      }
      for (let i = 0; i < n; i++) st[i] = Math.max(0, st[i] + dS[i]);
    }
    ids.forEach((id, i) => { M.nodes[id].stock[g] = st[i]; });
  }
  // ---- shocks (daily, from the market's own generator)
  if (shocks && minute % DAY_MIN < MARKET_STEP_MIN) {
    for (const id of ids) {
      if (nextOf(M) > SHOCK_P) continue;
      const m = MARKETS[id], made = Object.keys(m.make), wanted = Object.keys(m.want);
      const supply = made.length && (nextOf(M) < 0.6 || !wanted.length);
      const pool = supply ? made : wanted;
      if (!pool.length) continue;
      const g = pool[Math.floor(nextOf(M) * pool.length)];
      const days = 3 + Math.floor(nextOf(M) * (supply ? 10 : 8));
      const k = supply ? 0.15 + 0.35 * nextOf(M) : 1.6 + 1.4 * nextOf(M);
      M.nodes[id].shocks.push({ g, kind: supply ? 'make' : 'want', k, until: minute + days * DAY_MIN });
      const text = shockNews(state, id, g, supply, days);
      M.news.push({ at: minute, id, g, text });
      if (M.news.length > 30) M.news.shift();
      // (the news comes to us at light speed from where it happened: intel.js)
      relay(state, placeOf(state, id, minute), 'market-news', { id, good: g, text });
    }
  }
}

const SUPPLY_WORDS = {
  water: ['an ice-processing plant is down', 'the ice crews are on strike'], volatiles: ['a cracking plant has failed', 'a volatiles tank farm vented'],
  ore: ['a mine collapsed', 'the miners walked out'], metals: ['a smelter is down for repairs', 'the refinery lost a furnace'], pgm: ['a rich seam played out', 'the assay office is on strike'],
  food: ['a blight is in the grow decks', 'a hydroponics loop crashed'], delicacies: ['the domes lost a harvest', 'a frost got into the orchards'],
  medical: ['a sterile plant failed inspection', 'the medical fab is retooling'], pharma: ['a lab is shut by the regulators', 'a batch failed purity'],
  parts: ['a machine shop burned', 'the fab lines are retooling'], electronics: ['a fab is down: contamination', 'a chip line is retooling'],
  consumer: ['the print shops are on strike', 'a warehouse fire'], munitions: ['a munitions plant blew a line', 'the arms works are under inspection'],
  narcotics: ['a lab was raided', 'a cook went missing'],
};
const DEMAND_WORDS = {
  water: 'the terraforming draws more', volatiles: 'a new dome is filling', ore: 'the furnaces are all lit', metals: 'a new hull is on the slips', pgm: 'the fabs are buying', food: 'refugees came in',
  delicacies: 'a festival', medical: 'an outbreak', pharma: 'an outbreak', parts: 'the life support is failing everywhere at once', electronics: 'a refit boom', consumer: 'a boom: wages are up',
  munitions: 'the militias are arming', narcotics: 'the docks are thirsty',
};
function shockNews(state, id, g, supply, days) {
  const where = marketName(state, id), what = GOODS[g].name.toLowerCase();
  if (supply) { const w = SUPPLY_WORDS[g]; return `${where}: ${w[hashString(`${id}${g}${days}`) % w.length]}. ${GOODS[g].name} short there for a week or more; prices up.`; }
  return `${where}: ${DEMAND_WORDS[g]}. ${what[0].toUpperCase()}${what.slice(1)} wanted there; prices up.`;
}

/** Keep a snapshot of every market's prices (for what we know far off). */
function snapshot(state, minute) {
  const M = state.market;
  for (const id of MARKET_IDS) {
    const h = M.history[id];
    h.push({ at: minute, p: Object.fromEntries(GOOD_IDS.map(g => [g, Math.round(priceAt(state, id, g))])) });
    if (h.length > HISTORY) h.shift();
  }
}

/** Per minute: a market step every MARKET_STEP_MIN. */
export function marketTick(state) {
  if (!state.market) createMarket(state);
  const now = state.clock.minute;
  if (now % MARKET_STEP_MIN !== 7) return;
  step(state, now);
  snapshot(state, now);
  state.market.at = now;
}

// ---- PRICES ----

/** A good's price at a market now (MCR/t, mid: before the spread). */
export function priceAt(state, id, g, stock = state.market.nodes[id].stock[g]) {
  const f = Math.max(1e-6, stock / targetOf(id, g));
  return GOODS[g].base * Math.min(PRICE_MAX, Math.max(PRICE_MIN, f ** -ELASTIC));
}

/** Its price against the good's base (1: neither cheap nor dear). */
export const priceIndex = (state, id, g) => priceAt(state, id, g) / GOODS[g].base;

/**
 * What `t` tonnes would cost us (side 'buy') or fetch (side 'sell') at a
 * market now: the price walked tonne by tonne as the stock moves, the
 * spread on it. Buying stops at what is in stock. { t, total, avg }.
 */
export function quote(state, id, g, t, side) {
  const s0 = state.market.nodes[id].stock[g];
  const q = side === 'buy' ? Math.min(t, Math.max(0, s0 - 0.01)) : t;
  if (q <= 0) return { t: 0, total: 0, avg: 0 };
  const N = 16;
  let total = 0;
  for (let k = 0; k < N; k++) {
    const x = (k + 0.5) / N * q;
    total += priceAt(state, id, g, side === 'buy' ? s0 - x : s0 + x) * q / N;
  }
  total *= side === 'buy' ? 1 + SPREAD : 1 - SPREAD;
  return { t: q, total, avg: total / q };
}

/** What a market far off charges, as we know it: its prices a light-time ago. { at, p } or null. */
export function knownPrices(state, id) {
  const h = state.market?.history[id];
  if (!h?.length) return null;
  // (where we are, the board is live: docked at its station, or in its world's space)
  if (marketHere(state) === id || (MARKETS[id].world && state.flight.world?.name === MARKETS[id].world)) return { at: state.clock.minute, p: Object.fromEntries(GOOD_IDS.map(g => [g, Math.round(priceAt(state, id, g))])), live: true };
  const p = placeOf(state, id, state.clock.minute), f = state.flight.pos;
  const lagMin = Math.hypot(p.x - f.x, p.y - f.y) * AU_M / C_MS / 60;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].at <= state.clock.minute - lagMin) return h[i];
  return h[0];
}

/** A ship's store's price there against base (contracts.js priceOf): the good it is priced by, softened (a store sells from its own tanks). */
export function storeFactor(state, id, g) {
  if (!state.market || !MARKETS[id]) return 1;
  return Math.min(2, Math.max(0.6, 1 + 0.6 * (priceIndex(state, id, g) - 1)));
}

// ---- WHERE WE TRADE, AND WHAT ----

/** The market we can trade at now: the station we are docked at (with a market). */
export function marketHere(state) {
  const d = state.dock;
  if (d?.phase !== 'docked' || d.target.kind !== 'station') return null;
  return isOpen(d.target.id) ? d.target.id : null;
}

/** Our hold: what is aboard, and the room. */
export const holdLoad = (state) => state.cargo.reduce((s, x) => s + x.mass, 0);
export const holdRoom = (state) => Math.max(0, state.cargoCapacity - holdLoad(state) - heldForShuttles(state));
/**
 * Room held in our hold for what our shuttles out may bring back: the
 * freight not yet landed, the goods not yet sold, what they bought, and the
 * purchase still to be made (shuttles.js).
 */
export function heldForShuttles(state) {
  let kg = 0;
  for (const r of state.shuttles?.runs || []) {
    if (r.phase === 'done' || r.phase === 'lost') continue;
    for (const x of [...(r.cargo || []), ...(r.sell || []), ...(r.up || [])]) kg += x.mass;
    if (r.buy && !r.bought) kg += r.buy.t * 1000;
  }
  return kg;
}
/** Tonnes aboard of a good (what we may sell: not a contract's). */
export const heldOf = (state, g, filter = () => true) => state.cargo.filter(x => x.good === g && !x.contract && filter(x)).reduce((s, x) => s + x.mass, 0) / 1000;

/** Why a market won't deal with us in a good (null: it will). */
export function tradeRefusal(state, id, g, side) {
  const m = MARKETS[id], G = GOODS[g];
  if (!isOpen(id)) return `${marketName(state, id)} doesn't trade with passing ships.`;
  if (G.illegalIn?.includes(m.faction)) return `${G.name} are contraband in ${m.faction} space: not on this market.`;
  if (G.restricted && (m.faction === 'UN' || m.faction === 'MCR') && licenseOf(state) !== m.faction) return side === 'buy' ? `${G.name} are sold here only to the ${m.faction === 'UN' ? 'UNN' : 'MCRN'}'s contractors.` : `${G.name} are contraband here without the ${m.faction === 'UN' ? 'UNN' : 'MCRN'}'s license: no buyer would touch them.`;
  return null;
}

/** Buy `t` tonnes of a good at a market (as much as we can, short of it). { ok, text, t, total }. */
export function buyGood(state, id, g, t) {
  if (marketHere(state) !== id) return { ok: false, text: `Dock at ${marketName(state, id)} to trade: goods cross a berth's collar.` };
  const no = tradeRefusal(state, id, g, 'buy');
  if (no) return { ok: false, text: no };
  const room = holdRoom(state) / 1000;
  let want = Math.min(t, room);
  if (want <= 0.001) return { ok: false, text: 'No room in the hold.' };
  let q = quote(state, id, g, want, 'buy');
  if (q.t <= 0.001) return { ok: false, text: `None of it on the market at ${marketName(state, id)}.` };
  const credits = state.resources.credits.current;
  if (q.total > credits) {
    // (as much as we can pay for: the price climbs as we buy, so search it)
    let lo = 0, hi = q.t;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (quote(state, id, g, mid, 'buy').total <= credits) lo = mid; else hi = mid; }
    want = Math.floor(lo * 100) / 100;
    if (want <= 0.009) return { ok: false, text: 'Not enough credits.' };
    q = quote(state, id, g, want, 'buy');
  }
  state.market.nodes[id].stock[g] -= q.t;
  state.resources.credits.current -= q.total;
  stow(state, { good: g, mass: q.t * 1000, cost: q.total, from: id });
  return { ok: true, t: q.t, total: q.total, text: `Bought ${tonnes(q.t)} of ${GOODS[g].name.toLowerCase()} at ${marketName(state, id)} for ${Math.round(q.total).toLocaleString()} MCR (${Math.round(q.avg).toLocaleString()} a tonne).` };
}

/**
 * Sell `t` tonnes of a good at a market (as much as we hold of it). Stolen
 * goods: refused at their owner's ports, a fence's price elsewhere.
 */
export function sellGood(state, id, g, t) {
  if (marketHere(state) !== id) return { ok: false, text: `Dock at ${marketName(state, id)} to trade: goods cross a berth's collar.` };
  const no = tradeRefusal(state, id, g, 'sell');
  if (no) return { ok: false, text: no };
  const m = MARKETS[id];
  const ok = (x) => !x.stolen || x.stolen !== m.faction;
  const held = heldOf(state, g, ok);
  if (held <= 0.001) return { ok: false, text: heldOf(state, g) > 0 ? `${marketName(state, id)} won't take it: the registry has it as stolen from ${m.faction} hulls.` : `We hold no ${GOODS[g].name.toLowerCase()}.` };
  const q = quote(state, id, g, Math.min(t, held), 'sell');
  // what of it is stolen fetches a fence's price
  let left = q.t * 1000, paid = 0, fenced = 0;
  for (const x of state.cargo.filter(x => x.good === g && !x.contract && ok(x)).sort((a, b) => (a.stolen ? 1 : 0) - (b.stolen ? 1 : 0))) {
    if (left <= 0) break;
    const kg = Math.min(x.mass, left);
    const share = kg / (q.t * 1000);
    const value = q.total * share * (x.stolen ? FENCE : 1);
    if (x.stolen) fenced += value;
    paid += value;
    x.cost = x.mass > 0 ? (x.cost || 0) * (1 - kg / x.mass) : 0;
    x.mass -= kg;
    left -= kg;
  }
  state.cargo = state.cargo.filter(x => x.mass > 0.5);
  state.market.nodes[id].stock[g] += q.t;
  state.resources.credits.current += paid;
  return { ok: true, t: q.t, total: paid, text: `Sold ${tonnes(q.t)} of ${GOODS[g].name.toLowerCase()} at ${marketName(state, id)} for ${Math.round(paid).toLocaleString()} MCR${fenced ? ` (some of it stolen: a fence's price)` : ''}.` };
}

/**
 * A shuttle's trade on a world's ground (shuttles.js): sell the lots it
 * carried down (cargo items out of our hold; stolen goods as in port), and
 * buy `t` tonnes of a good to bring up (as much as we can pay for). Returns
 * { sold: MCR, soldT, up: [items] | [], text }.
 */
export function shuttleTrade(state, id, lots, buy) {
  const m = MARKETS[id];
  let sold = 0, soldT = 0;
  const back = [];
  for (const x of lots) {
    const no = tradeRefusal(state, id, x.good, 'sell') || (x.stolen === m.faction ? 'stolen from its own' : null);
    if (no) { back.push(x); continue; }
    const q = quote(state, id, x.good, x.mass / 1000, 'sell');
    const pay = q.total * (x.stolen ? FENCE : 1);
    state.market.nodes[id].stock[x.good] += q.t;
    sold += pay; soldT += q.t;
  }
  state.resources.credits.current += sold;
  const up = [];
  if (buy?.good && buy.t > 0 && !tradeRefusal(state, id, buy.good, 'buy')) {
    let t = buy.t, q = quote(state, id, buy.good, t, 'buy');
    if (q.total > state.resources.credits.current) {
      let lo = 0, hi = q.t;
      for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (quote(state, id, buy.good, mid, 'buy').total <= state.resources.credits.current) lo = mid; else hi = mid; }
      t = Math.floor(lo * 100) / 100;
      q = quote(state, id, buy.good, t, 'buy');
    }
    if (q.t > 0.009) {
      state.market.nodes[id].stock[buy.good] -= q.t;
      state.resources.credits.current -= q.total;
      up.push({ good: buy.good, mass: q.t * 1000, cost: q.total, from: id });
    }
  }
  const words = [soldT ? `sold ${tonnes(soldT)} for ${Math.round(sold).toLocaleString()} MCR` : '', up.length ? `bought ${tonnes(up[0].mass / 1000)} of ${GOODS[up[0].good].name.toLowerCase()} for ${Math.round(up[0].cost).toLocaleString()} MCR` : ''].filter(Boolean);
  return { sold, soldT, up, back, text: words.join(', ') };
}

/** Put goods in our hold: with what is already there of the same good and standing (bought, salvaged, stolen). */
export function stow(state, item) {
  const law = lawOf(item.good);
  const like = state.cargo.find(x => x.good === item.good && !x.contract && (x.stolen || null) === (item.stolen || null) && !!x.seized === !!item.seized);
  if (like) { like.mass += item.mass; like.cost = (like.cost || 0) + (item.cost || 0); return like; }
  const it = { good: item.good, name: GOODS[item.good].name, mass: item.mass, cost: item.cost || 0, ...law, ...(item.stolen ? { stolen: item.stolen, contraband: true, illegalIn: [...new Set([...(law.illegalIn || []), item.stolen])] } : {}), ...(item.seized ? { seized: true, from: item.from } : { from: item.from }) };
  state.cargo.push(it);
  return it;
}

// ---- A SHIP'S HOLD ----

/** A stable number in [0, 1) from a hull's id and an index (its hold: not the dice). */
const h01 = (id, k) => (hashString(`${id}#${k}`) % 100000) / 100000;

/** What a hull of a kind typically carries: [good, weight]. */
const CARRIES = {
  hauler: [['water', 1]], tanker: [['volatiles', 0.7], ['water', 0.3]], miner: [['ore', 0.9], ['pgm', 0.1]], prospector: [['ore', 0.8], ['pgm', 0.2]],
  liner: [['consumer', 0.4], ['food', 0.4], ['delicacies', 0.2]], courier: [['electronics', 0.3], ['pharma', 0.2], ['medical', 0.3], ['delicacies', 0.2]],
  cutter: [['munitions', 0.4], ['parts', 0.3], ['food', 0.3]], corvette: [['munitions', 0.5], ['parts', 0.3], ['food', 0.2]], frigate: [['munitions', 0.6], ['parts', 0.4]],
  destroyer: [['munitions', 0.6], ['parts', 0.4]], battleship: [['munitions', 0.5], ['parts', 0.3], ['food', 0.2]],
  gunship: [['consumer', 0.3], ['electronics', 0.2], ['narcotics', 0.2], ['munitions', 0.3]], raider: [['consumer', 0.3], ['medical', 0.2], ['narcotics', 0.3], ['munitions', 0.2]],
};

/** …and a few classes, whatever their kind, what they were built to carry. */
const CARRIES_CLASS = {
  'ore-scow': [['ore', 1]], 'water-carrier': [['water', 1]], 'pallas-refiner': [['metals', 0.8], ['pgm', 0.2]],
  'colony-ship': [['food', 0.3], ['parts', 0.3], ['consumer', 0.2], ['medical', 0.2]],
};

/**
 * A hull's hold: [{ good, t }]. Worked from its id once and kept on it (what
 * is taken is gone): a freighter carries what its last port makes, others
 * what their trade does; full to between a fifth and nine-tenths.
 */
export function holdOf(state, e) {
  if (e.tags?.hold) return e.tags.hold;
  const c = CLASSES[e.cls];
  // (a shuttle's load is its run's: shuttles.js)
  const cap = e.tags?.shuttle ? 0 : c?.cargoT || 0;
  let hold = [];
  if (cap > 0) {
    const fill = 0.2 + 0.7 * h01(e.id, 1);
    let mix = CARRIES_CLASS[e.cls] || CARRIES[c.kind];
    if (!mix) {
      // a freighter: what its port makes (or a general cargo)
      const port = e.tags?.from || e.tags?.at || e.tags?.to;
      const made = MARKETS[port] ? Object.entries(MARKETS[port].make) : null;
      mix = made?.length ? made.map(([g, r]) => [g, Math.sqrt(r)]) : [['parts', 0.3], ['consumer', 0.3], ['food', 0.3], ['metals', 0.3], ['electronics', 0.1]];
    }
    if (e.faction === 'pirate' && !mix.some(([g]) => g === 'narcotics')) mix = [...mix, ['narcotics', 0.15]];
    // two or three of them, by weight; the dear ones in small lots
    const picks = new Map();
    const n = 1 + Math.floor(h01(e.id, 2) * Math.min(3, mix.length));
    const total = mix.reduce((s, [, w]) => s + w, 0);
    for (let k = 0; k < n; k++) {
      let r = h01(e.id, 10 + k) * total;
      const [g] = mix.find(([, w]) => (r -= w) <= 0) || mix[0];
      picks.set(g, (picks.get(g) || 0) + 1);
    }
    let left = cap * fill;
    const goods = [...picks.keys()];
    goods.forEach((g, i) => {
      // (a dear good is carried by the tonne, a cheap one by the hundred)
      const share = i === goods.length - 1 ? 1 : 0.3 + 0.4 * h01(e.id, 20 + i);
      const lot = Math.min(left * share, GOODS[g].base > 10_000 ? Math.max(0.5, cap * 0.05) : Infinity);
      if (lot > 0.05) hold.push({ good: g, t: Math.round(lot * 100) / 100 });
      left -= lot;
    });
  }
  return hold;
}

/** Its hold, to take from: worked out once and kept on it from now on (what is taken is gone). */
export function holdToTake(state, e) {
  if (!e.tags?.hold) (e.tags ||= {}).hold = holdOf(state, e);
  return e.tags.hold;
}

/** The manifest a lawful ship has filed (with its transponder on): its hold, less the contraband. Null if none is filed. */
export function declaredHold(state, e) {
  if (!e.transponder || e.faction === 'pirate' || e.tags?.wreck || e.tags?.shuttle) return null;
  return holdOf(state, e).filter(x => !GOODS[x.good].illegalIn);
}

/**
 * What we know of a hull's hold: what a search found (the dossier), or the
 * manifest a lawful ship has filed, once we know who it is. { items, src } or null.
 */
export function knownHold(state, e, identified) {
  const r = state.dossier?.ships?.[e.id];
  if (r?.hold) return { items: r.hold.items, src: r.hold.src === 'boarded' ? 'searched' : r.hold.src };
  const filed = identified ? declaredHold(state, e) : null;
  return filed ? { items: filed, src: 'filed manifest' } : null;
}

/** A hold in words. */
export const holdWords = (hold) => hold?.length ? hold.map(x => `${tonnes(x.t)} ${GOODS[x.good].name.toLowerCase()}`).join(', ') : 'empty';

/** What a hold is worth at a market (at its prices, before the spread). */
export const holdValue = (state, id, hold) => (hold || []).reduce((s, x) => s + x.t * priceAt(state, id, x.good), 0);
