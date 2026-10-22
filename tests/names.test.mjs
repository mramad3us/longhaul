// Ship names (names.js): enough variety that a world of thousands of hulls
// almost never repeats one, and a registry that makes sure it never does.
// Prints the duplicate rate over 200,000 raw names, each pool's size, and
// a sample of every culture, trade, navy, police service and pirate clan.
import { assert, fmt } from './helpers.mjs';
import { seedRandom, pick, weightedPick } from '../js/core/rng.js';
import { CLASSES, CLASS_IDS } from '../js/sim/ship-classes.js';
import { shipName, reserveName, rollShipName, nameEntropy } from '../js/sim/names.js';

/** Sub-factions a ship of this category and faction may belong to (null: none). */
const SUBS = {
  civilian: {
    UN: [null, null, 'un-corp'], MCR: [null, null, 'mcr-corp'], OPA: [null, 'opa-tycho', 'opa-ceres', 'opa-unions'],
    independent: [null, 'ind-ganymede', 'ind-vesta', 'ind-traders', 'ind-water', 'ind-merc'],
  },
  authority: { UN: ['un-security'], MCR: ['mcr-security'], OPA: ['opa-starhelix'], independent: [null] },
  military: { UN: ['unn-fleet', 'unn-fleet', 'unn-fleet', 'un-intel'], MCR: ['mcrn-fleet', 'mcrn-fleet', 'mcrn-fleet', 'mcr-intel'], OPA: ['opa-tycho', 'opa-ceres', 'opa-unions'] },
  irregular: { pirate: [null, 'clan-rust', 'clan-dark', 'clan-knives', 'clan-ghost'] },
};
/** About what the world flies: mostly trade, some police and navy, a few pirates. */
const MIX = { civilian: 0.74, authority: 0.08, military: 0.12, irregular: 0.06 };
const BY_CAT = Object.fromEntries(Object.keys(MIX).map(c => [c, CLASS_IDS.filter(id => CLASSES[id].category === c)]));
const total = (f) => Object.values(f).reduce((a, b) => a + b, 0);

/** The fields shipName is called with, for one class flown by one faction. */
function optsFor(cls, faction, sub = null) {
  const c = CLASSES[cls];
  return { cls, kind: c.kind, category: c.category, names: c.names, faction, sub };
}

/** A ship of a realistic class mix: category, then class by who flies it, then faction and sub-faction. */
function rollOpts() {
  const category = weightedPick(Object.keys(MIX), c => MIX[c]);
  const cls = weightedPick(BY_CAT[category], id => total(CLASSES[id].factions));
  const f = CLASSES[cls].factions;
  const faction = weightedPick(Object.keys(f), k => f[k]);
  return optsFor(cls, faction, pick(SUBS[category][faction] || [null]));
}

export default [
  {
    name: 'variety: duplicate rate over 200,000 raw names',
    fn: () => {
      seedRandom(1);
      const N = 200_000;
      const cats = {}, pools = {};
      for (let i = 0; i < N; i++) {
        const o = rollOpts();
        const name = rollShipName(o);
        const c = cats[o.category] ||= { n: 0, seen: new Set() };
        c.n++; c.seen.add(name);
        if (o.category === 'civilian') {
          const p = pools[`${o.faction} ${o.names}`] ||= { n: 0, seen: new Set() };
          p.n++; p.seen.add(name);
        }
      }
      const rate = (c) => 1 - c.seen.size / c.n;
      console.log('      category      names   distinct  duplicates');
      for (const [k, c] of Object.entries(cats)) console.log(`      ${k.padEnd(12)} ${String(c.n).padStart(7)} ${String(c.seen.size).padStart(9)}   ${fmt(rate(c) * 100, 2)}%`);
      const worst = Object.entries(pools).sort((a, b) => rate(b[1]) - rate(a[1])).slice(0, 6);
      console.log(`      worst civilian pools: ${worst.map(([k, p]) => `${k} ${fmt(rate(p) * 100, 2)}% of ${p.n}`).join(' · ')}`);
      const e = nameEntropy();
      const rows = Object.entries(e).map(([k, v]) => `${k} ${(v.effective / 1000).toFixed(0)}k`);
      for (let i = 0; i < rows.length; i += 6) console.log(`      ${i ? '' : 'effective pool sizes: '}${rows.slice(i, i + 6).join(' · ')}`);
      // At the scale of a real game, raw names (before the registry) almost never meet.
      const game = {};
      for (let i = 0; i < 3000; i++) {
        const o = rollOpts();
        const c = game[o.category] ||= { n: 0, seen: new Set() };
        c.n++; c.seen.add(rollShipName(o));
      }
      console.log(`      at game scale (3,000 ships): ${Object.entries(game).map(([k, c]) => `${k} ${c.n - c.seen.size} repeats in ${c.n}`).join(' · ')}`);
      assert(rate(cats.civilian) < 0.02, `civilian duplicate rate ${fmt(rate(cats.civilian) * 100, 2)}% (want < 2%)`);
    },
  },
  {
    name: 'registry: 50,000 names in one game are all different',
    fn: () => {
      seedRandom(2);
      const state = { entities: [], ship: { name: 'Longhaul' } };
      const seen = new Set();
      for (let i = 0; i < 50_000; i++) seen.add(shipName(state, rollOpts()));
      assert(seen.size === 50_000, `only ${seen.size} distinct names out of 50,000`);
      assert(![...seen].some(n => n.toLowerCase() === 'longhaul'), 'our own ship\'s name was handed out');

      const sample = [
        ['UN', 'freighter'], ['UN', 'liner'], ['UN', 'hermes'], ['UN', 'tanker', 'un-corp'],
        ['MCR', 'tharsis-bulk', 'mcr-corp'], ['MCR', 'arsia'], ['MCR', 'valles-liner'], ['MCR', 'deimos'],
        ['OPA', 'ice-hauler'], ['OPA', 'rockhopper'], ['OPA', 'mule', 'opa-unions'], ['OPA', 'mining-barge', 'opa-tycho'],
        ['independent', 'water-carrier', 'ind-water'], ['independent', 'freighter', 'ind-traders'], ['independent', 'mining-tender', 'ind-vesta'],
        ['UN', 'unn-frigate', 'unn-fleet'], ['UN', 'unn-battleship', 'unn-fleet'], ['MCR', 'mcrn-destroyer', 'mcrn-fleet'], ['MCR', 'mcrn-corvette', 'mcrn-fleet'],
        ['OPA', 'opa-frigate', 'opa-ceres'], ['UN', 'cutter', 'un-security'], ['MCR', 'mcr-cutter', 'mcr-security'], ['OPA', 'belt-cutter', 'opa-starhelix'],
        ['independent', 'light-freighter', 'ind-merc'],
        ['pirate', 'pirate-gunship', 'clan-rust'], ['pirate', 'pirate-raider', 'clan-dark'], ['pirate', 'pirate-runner', 'clan-knives'], ['pirate', 'pirate-corvette', 'clan-ghost'],
      ];
      console.log('      samples:');
      for (const [faction, cls, sub = null] of sample) {
        console.log(`        ${`${faction} ${cls}${sub ? ` (${sub})` : ''}`.padEnd(42)} ${shipName(state, optsFor(cls, faction, sub))}`);
      }
    },
  },
  {
    name: 'determinism: the same seed gives the same names',
    fn: () => {
      const run = () => {
        seedRandom(99);
        const state = { entities: [], ship: { name: 'Longhaul' } };
        return Array.from({ length: 100 }, () => shipName(state, rollOpts()));
      };
      const a = run(), b = run();
      assert(a.every((n, i) => n === b[i]), 'two runs from the same seed named ships differently');
    },
  },
  {
    name: 'registry: names on entities, wrecks and reservations are never handed out again',
    fn: () => {
      const civ = optsFor('ice-hauler', 'OPA');
      const navy = optsFor('unn-frigate', 'UN', 'unn-fleet');
      // What the generator would say first from seed 7 (each call starts from the seed).
      seedRandom(7); const civFirst = rollShipName(civ);
      seedRandom(7); const navyFirst = rollShipName(navy);
      const state = { entities: [{ name: `${civFirst} (wreck)` }, { name: 'Ceres Station' }], ship: { name: 'Longhaul' } };
      assert(!reserveName(state, civFirst), 'a wreck\'s name was not taken');
      assert(!reserveName(state, 'longhaul'), 'our ship\'s name was not taken');
      assert(reserveName(state, navyFirst), 'a fresh name could not be reserved');
      assert(!reserveName(state, navyFirst), 'a name was reserved twice');

      // Restarting from the seed every call, the generator's first choice is
      // always taken, then its retries, until it has to number the name.
      const out = [];
      for (let i = 0; i < 30; i++) { seedRandom(7); out.push(shipName(state, civ)); }
      for (let i = 0; i < 30; i++) { seedRandom(7); out.push(shipName(state, navy)); }
      assert(new Set(out.map(n => n.toLowerCase())).size === out.length, 'a name was handed out twice');
      assert(!out.includes(civFirst) && !out.includes(navyFirst), 'a taken name was handed out');
      const civNumbered = out.slice(0, 30).filter(n => / (II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX|\d+)$/.test(n));
      const hullNumbered = out.slice(30).filter(n => /\(FFG-\d+\)$/.test(n));
      assert(civNumbered.length >= 10, `expected numbered civilian fallbacks, got ${civNumbered.length}`);
      assert(hullNumbered.length >= 10, `expected hull-numbered navy fallbacks, got ${hullNumbered.length}`);
      console.log(`      first choice taken: "${civFirst}", "${navyFirst}" → e.g. "${civNumbered[0]}", "${hullNumbered[0]}"`);
    },
  },
];
