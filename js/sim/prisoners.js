// ============================================================
// LONGHAUL — Prisoners: who we hold, and what becomes of them
//
// A beaten ship's crew taken aboard (boarding.js TAKE PRISONERS) ride in
// the brig, then any free berths (manifest.js). Each group remembers the
// ship it came off and whose it was, and its high-profile people: the
// captain and the officers of a navy's or a police force's ship, a
// pirate captain, a strike target's commander. In port, at a station:
//
//   TURNED OVER to the local authority. Criminals (pirates, a proxy's
//     raiders, a wanted ship's crew) earn the bounty on them
//     and standing with that power; its enemies (a power it is at war or
//     in a crisis with) earn standing with it, and with our own power's
//     command if they are our flag's enemies too, and cost standing with
//     their own side. Anyone else is let go, and their power remembers we
//     held them.
//   RANSOMED, the high-profile ones: their own side pays to have them
//     back, through the station's brokers. The local power doesn't like
//     seeing its criminals or its enemies bought free (standing), and the
//     rank and file stay aboard to be turned over or let go. A criminal's
//     friends never pay what the law does (RANSOM_SHARE of it): a bounty's
//     captain fetches that share of what its contract pays to bring them
//     in, any other pirate captain that share of their turn-over bounty.
//   BROUGHT IN on a bounty: the crew of a bounty's own ship are held for
//     its contract while it is open (contracts.js bountyHeads): handed over
//     when it is turned in, paid by the head there, not turned over here.
// ============================================================

import { classOf } from './ship-classes.js';
import { FACTIONS, POWERS } from './factions.js';
import { phaseBetween } from './politics.js';
import { adjustStanding } from './law.js';
import { licenseOf, addRep } from './service.js';
import { crewAboard } from './manifest.js';

export const PIRATE_BOUNTY = 800;          // MCR a head, from any power, for a pirate turned over
export const NOTABLE_BOUNTY = 3;           // …times that for its captain
export const RANSOM_SHARE = 0.75;          // a criminal's friends pay this share of what the law pays for them
const STANDING_PER_HEAD = 0.5;             // what turning over a criminal or an enemy earns (an officer counts 3)
const STANDING_CAP = 15;                   // most a single handover moves it
const RELEASED_COST = 2;                   // standing a power loses with us for each of its people we held

/**
 * What one high-profile prisoner is worth to its own side (MCR), by the kind
 * of ship it came off; a pirate's (irregular) is held under what turning
 * them over pays (RANSOM_SHARE of it), a bounty's captain under what its
 * contract pays (ransomOffer).
 */
export const RANSOM = { military: 6000, authority: 3000, irregular: Math.round(RANSOM_SHARE * PIRATE_BOUNTY * NOTABLE_BOUNTY), commander: 25000 };

/** The high-profile people aboard a ship: its captain and its officers (none on a civilian's: kidnapping is piracy). */
export function officersOf(e) {
  const c = classOf(e);
  const cat = c?.category;
  if (cat !== 'military' && cat !== 'authority' && cat !== 'irregular' && !e.tags?.wanted) return 0;
  const std = c?.crewStd ?? Math.round(((c?.crew?.[0] || 2) + (c?.crew?.[1] || 4)) / 2);
  const n = cat === 'military' ? 1 + Math.floor(std / 8) : cat === 'authority' ? 1 + Math.floor(std / 10) : 1;
  return Math.max(0, Math.min(n - (e.tags?.officersTaken || 0), crewAboard(e)));
}

/**
 * The prisoner record for `n` people taken off `e` (its officers first):
 * kept in state.passengers as { kind: 'prisoners', … }.
 */
export function prisonerGroup(state, e, n) {
  const c = classOf(e);
  const notables = Math.min(n, officersOf(e));
  e.tags.officersTaken = (e.tags.officersTaken || 0) + notables;
  // (a wanted ship's people are criminals: the pirate's price, or, a bounty's, its contract's: ransomOffer)
  const each = e.tags?.hvt ? RANSOM.commander : e.tags?.wanted ? RANSOM.irregular : RANSOM[c?.category] || 0;
  return {
    kind: 'prisoners', count: n, faction: e.faction, from: e.id, name: e.name,
    pirate: e.faction === 'pirate' || c?.category === 'irregular' || !!e.tags?.wanted,
    notables, ransomEach: notables ? each : 0, at: state.clock.minute,
  };
}

export const heldGroups = (state) => state.passengers.filter(p => p.kind === 'prisoners');

/** The open bounty a group is held for (its crew go in with the contract), or null: a failed one's are ordinary prisoners. */
export const heldFor = (state, g) => (state.contracts?.active || []).find(c => c.type === 'BOUNTY' && c.perHead && c.targetId === g.from && (c.phase === 'active' || c.phase === 'return')) || null;

/** How the station's power sees a group: 'criminal' | 'enemy' | 'other'. */
function standingOf(state, g, power) {
  if (g.pirate) return 'criminal';
  if (POWERS.includes(power) && POWERS.includes(g.faction) && g.faction !== power) {
    const ph = phaseBetween(state, power, g.faction);
    if (ph === 'war' || ph === 'crisis') return 'enemy';
  }
  return 'other';
}

/**
 * Turn every group over to the authority at `station`. Returns { n, pay,
 * standing, released, text } and settles it all.
 */
export function turnOver(state, station, emit = () => {}) {
  const power = station.faction;
  // (a bounty's own crew wait for its contract: handed over, and paid by the head, when it is turned in)
  const kept = heldGroups(state).filter(g => heldFor(state, g));
  const held = heldGroups(state).filter(g => !kept.includes(g));
  let n = 0, pay = 0, gain = 0, released = 0, ours = 0;
  for (const g of held) {
    n += g.count;
    const weight = g.count + 2 * (g.notables || 0);
    const kind = standingOf(state, g, power);
    if (kind === 'criminal') {
      pay += PIRATE_BOUNTY * (g.count + (NOTABLE_BOUNTY - 1) * (g.notables || 0));
      gain += STANDING_PER_HEAD * weight;
    } else if (kind === 'enemy') {
      gain += STANDING_PER_HEAD * weight;
      if (g.faction in state.law.standing) adjustStanding(state, g.faction, -RELEASED_COST / 2 * g.count);
      // (our own power's enemies, turned over to it: its command hears of it)
      if (licenseOf(state) === power) ours += weight;
    } else {
      released += g.count;
      if (g.faction in state.law.standing) adjustStanding(state, g.faction, -RELEASED_COST * g.count);
    }
  }
  state.passengers = state.passengers.filter(p => p.kind !== 'prisoners' || kept.includes(p));
  state.resources.credits.current += pay;
  const standing = Math.min(STANDING_CAP, gain);
  if (standing > 0 && power in state.law.standing) adjustStanding(state, power, standing);
  if (ours) addRep(state, ours, `${ours} enemy prisoners turned over`, emit);
  const k = kept.reduce((a, g) => a + g.count, 0);
  const keptText = k ? ` ${k} of the ${kept.map(g => g.name).join(', ')}'s crew stay${k > 1 ? '' : 's'} aboard for the bounty: hand them in with the contract at ${heldFor(state, kept[0]).stationName}.` : '';
  const text = n ? `Security will take them at the lock. ${n} prisoner${n > 1 ? 's' : ''} logged${released ? `; ${released === n ? 'all' : released} released, we have no charges against them` : ''}.${pay ? ` Bounty: ${pay.toLocaleString()} MCR.` : ''}${keptText}` : keptText.trim() || 'Nobody to turn over.';
  emit('prisoners-turned-over', { station: station.id, n, pay, standing, released });
  return { n, pay, standing, released, text };
}

/** What ransoming group `i` would bring here: { ok, amount, who, cost (standing with the local power), why }. */
export function ransomOffer(state, station, i) {
  const g = heldGroups(state)[i];
  if (!g?.notables) return { ok: false, why: 'nobody worth a ransom' };
  const who = POWERS.includes(g.faction) ? FACTIONS[g.faction].short : g.pirate ? 'their clan' : 'their people';
  const kind = standingOf(state, g, station.faction);
  const cost = kind === 'other' ? 0 : 3 * g.notables;
  // (their friends pay less than the law would: a bounty's captain, against its contract's price for them)
  const bounty = heldFor(state, g);
  const each = bounty ? Math.round(RANSOM_SHARE * (bounty.captainHead || bounty.perHead * 4) / 10) * 10
    : g.pirate ? Math.min(g.ransomEach, RANSOM.irregular) : g.ransomEach;
  return { ok: true, amount: g.notables * each, who, cost, notables: g.notables, name: g.name, forBounty: !!bounty };
}

/** Ransom group `i`'s high-profile prisoners to their own side, through the brokers at `station`. */
export function ransom(state, station, i, emit = () => {}) {
  const o = ransomOffer(state, station, i);
  if (!o.ok) return { ok: false, text: o.why };
  const g = heldGroups(state)[i];
  g.count -= g.notables;
  g.notables = 0;
  if (g.count <= 0) state.passengers = state.passengers.filter(p => p !== g);
  state.resources.credits.current += o.amount;
  if (o.cost && station.faction in state.law.standing) adjustStanding(state, station.faction, -o.cost);
  emit('prisoners-ransomed', { station: station.id, amount: o.amount, n: o.notables, name: o.name });
  const payer = o.who === 'their clan' ? 'Their clan pays' : o.who === 'their people' ? 'Their people pay' : `The ${o.who} pays`;
  const whom = o.notables === 1 ? `the captain of the ${o.name} goes` : `the ${o.notables} officers of the ${o.name} go`;
  return { ok: true, text: `${payer} ${o.amount.toLocaleString()} MCR through the brokers here, and ${whom} across at the lock.${o.cost ? ' Station security watched them go.' : ''}`, amount: o.amount };
}

