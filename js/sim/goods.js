// ============================================================
// LONGHAUL — Goods: what is bought and sold, and what the law says of it
//
// Fourteen trade goods, each a line on every market (market.js): a name,
// a BASE price (MCR a tonne: what it fetches where it is neither short nor
// plentiful), a category, and its law. Bulk goods are cheap by the tonne
// and move by the hundred (ice, volatiles, ore); the dear ones move by the
// tonne (electronics, pharmaceuticals, platinum-group metals), and need
// capital before they make it back. Cargo in a hold is labelled by its good
// (state.cargo items { good, name, mass (kg), cost, … }), whether bought,
// taken from a wreck, or found aboard a ship we boarded.
//
// THE LAW. Narcotics are contraband in every power's space (`illegalIn`):
// only an independent port trades them, and a patrol that finds them
// seizes them (law.js). Munitions are RESTRICTED: legal aboard with a navy
// license, else seized in Earth's and Mars's space as nuclear warheads are,
// and sold at a UN or MCR port only to that navy's contractors. Cargo
// taken from a lawful ship we had no right to board is STOLEN (its owner's
// power on the item; an independent's, the power whose space it was in):
// its ports won't buy it, and others pay a fence's price for it (market.js
// FENCE). Only contraband seized off a hull is turned over for credit
// (law.js turnOverContraband): not what we bought, nor what we stole.
//
// What a ship's stores cost in port follows the market too (contracts.js
// priceOf): reaction mass and water by ice, rations by foodstuffs, air by
// volatiles, med units by medical supplies, spares by machine parts, PDC
// rounds and torpedoes by munitions (STORE_GOOD).
// ============================================================

export const GOODS = {
  water: { name: 'Water ice', base: 260, cat: 'bulk', desc: 'Ice from the Belt and the moons: drinking water, air split out of it, and reaction mass.' },
  volatiles: { name: 'Volatiles', base: 650, cat: 'bulk', desc: 'Nitrogen, ammonia, methane, carbon dioxide: air to breathe, fertiliser, and a terraformed planet\'s sky.' },
  ore: { name: 'Nickel-iron ore', base: 160, cat: 'bulk', desc: 'Raw rock from the Belt\'s mines, for the refineries.' },
  metals: { name: 'Refined metals', base: 1300, cat: 'industrial', desc: 'Steel, titanium and aluminium stock from the refineries, for the yards.' },
  pgm: { name: 'Platinum-group metals', base: 19000, cat: 'precious', desc: 'Platinum, palladium, iridium: the Belt\'s riches, wanted for every catalyst and circuit in the inner system.' },
  food: { name: 'Foodstuffs', base: 950, cat: 'food', desc: 'Protein, yeast, grain and algae: what the Belt eats.' },
  delicacies: { name: 'Delicacies', base: 7500, cat: 'luxury', desc: 'Real coffee, fresh fruit, wine, meat that walked: grown under domes or on Earth.' },
  medical: { name: 'Medical supplies', base: 14000, cat: 'medical', desc: 'Dressings, surgical kit, blood products, autodoc cartridges.' },
  pharma: { name: 'Pharmaceuticals', base: 32000, cat: 'medical', desc: 'Drugs made in Earth\'s and Mars\'s labs: anti-radiation, bone-density, the expensive kind.' },
  parts: { name: 'Machine parts', base: 5200, cat: 'industrial', desc: 'Pumps, valves, bearings, motors, filters: what keeps a station alive.' },
  electronics: { name: 'Electronics', base: 17000, cat: 'industrial', desc: 'Processors, sensors, displays and control boards from the inner system\'s fabs.' },
  consumer: { name: 'Consumer goods', base: 3200, cat: 'consumer', desc: 'Clothes, tools, entertainment, the small comforts of a long life in a tin.' },
  munitions: { name: 'Munitions', base: 21000, cat: 'military', restricted: true, desc: 'Small arms, PDC rounds, warheads\' components. Restricted: legal aboard with a navy license.' },
  narcotics: { name: 'Narcotics', base: 42000, cat: 'illicit', illegalIn: ['UN', 'MCR', 'OPA'], desc: 'Contraband everywhere a power\'s law runs. Independent ports trade it, quietly.' },
};

export const GOOD_IDS = Object.keys(GOODS);

/** The good a ship's store is priced by (contracts.js priceOf). */
export const STORE_GOOD = { fuel: 'water', water: 'water', food: 'food', o2Tank: 'volatiles', n2Tank: 'volatiles', medSupplies: 'medical', parts: 'parts', pdcRounds: 'munitions' };

/** The flags a good gives an item of cargo (for the law: law.js contrabandFor). */
export const lawOf = (good) => {
  const g = GOODS[good];
  return g?.illegalIn ? { contraband: true, illegalIn: g.illegalIn } : g?.restricted ? { restricted: true } : {};
};

/** A tonnage, as the displays put it. */
export const tonnes = (t) => t >= 100 ? `${Math.round(t).toLocaleString()} t` : t >= 10 ? `${t.toFixed(1)} t` : `${t.toFixed(2)} t`;
