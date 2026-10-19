// ============================================================
// LONGHAUL — Law: standing, wanted status, contraband
//
// Each power keeps a ledger on the ship: standing (−100 … 100, what
// they think of us) and a wanted level:
//
//   0 CLEAN    — routine traffic
//   1 SUSPECT  — patrols stop and search us; a fine settles it
//   2 WANTED   — heave to and be arrested, or be disabled
//   3 HOSTILE  — shot on sight
//
// Crimes are recorded against the victim's power and the power whose
// space it happened in. Firing on pirates, wanted criminals or anyone
// who shot first is not a crime. Contraband (smuggled cargo, nuclear
// warheads in UN or Martian space) is what inspections look for.
// Wanted levels fade after a quiet stretch; standing drifts home.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { POWERS, controlAt } from './factions.js';
import { classOf } from './ship-classes.js';

export const WANTED_LABEL = ['CLEAN', 'SUSPECT', 'WANTED', 'HOSTILE'];
const SEVERITY = { fired: 1, hit: 1, disabled: 2, destroyed: 3 };
const WANTED_FADE_DAYS = 10;
/** Where nuclear torpedoes are contraband. */
export const NUKES_ILLEGAL_IN = ['UN', 'MCR'];

export function createLaw() {
  return {
    standing: { UN: 0, MCR: 0, OPA: 10 },
    wanted: { UN: 0, MCR: 0, OPA: 0 },
    lastCrime: { UN: -Infinity, MCR: -Infinity, OPA: -Infinity },
    record: [],                 // recent crimes (for the log)
  };
}

/** Is shooting at this ship a crime? */
export function lawfulTarget(e) {
  if (!e || e.type !== 'ship') return false;
  if (e.faction === 'pirate' || e.tags?.wanted) return false;
  if (e.agent?.aggressor) return false;              // they fired on us first
  if (e.combat?.status === 'wreck') return false;
  return true;
}

/**
 * The player attacked `e` (fired on it, hit, disabled or destroyed it).
 * Records a crime if `e` was a lawful ship, each escalation once per victim.
 */
export function recordAttack(state, e, kind, emit = () => {}) {
  const L = state.law;
  if (!lawfulTarget(e)) {
    if (kind === 'destroyed' && e.faction === 'pirate') {
      const ctl = controlAt(e.pos.x, e.pos.y, state.clock.minute).faction;
      if (ctl) adjustStanding(state, ctl, 3);
    }
    return null;
  }
  const cat = classOf(e)?.category;
  const sev = Math.min(3, SEVERITY[kind] + (cat === 'military' || cat === 'authority' ? 1 : 0));
  e.tags.crime ??= 0;
  if (sev <= e.tags.crime) return null;
  e.tags.crime = sev;
  const powers = new Set();
  if (POWERS.includes(e.faction)) powers.add(e.faction);
  const where = controlAt(e.pos.x, e.pos.y, state.clock.minute).faction;
  if (where) powers.add(where);
  for (const f of powers) {
    adjustStanding(state, f, -10 * sev);
    L.wanted[f] = Math.max(L.wanted[f], Math.min(3, sev));
    L.lastCrime[f] = state.clock.minute;
  }
  const crime = { kind, victim: e.name, factions: [...powers], at: state.clock.minute };
  L.record.push(crime);
  if (L.record.length > 20) L.record.shift();
  emit('crime', crime);
  return crime;
}

export function adjustStanding(state, faction, delta) {
  const s = state.law.standing;
  if (!(faction in s)) return;
  s[faction] = Math.max(-100, Math.min(100, s[faction] + delta));
}

export const wantedBy = (state, faction) => state.law.wanted[faction] || 0;

// ---- CONTRABAND ----

/** What an inspector of `faction` would seize: { cargo: [items], nukes: n }. */
export function contrabandFor(state, faction) {
  const cargo = state.cargo.filter(c => c.contraband && (c.illegalIn || POWERS).includes(faction));
  const nukes = NUKES_ILLEGAL_IN.includes(faction) ? state.magazine.nuke : 0;
  return { cargo, nukes };
}

/**
 * A completed inspection by `faction`: contraband seized, fines levied,
 * the ledger settled. Returns { found, fine, paid, text }.
 */
export function settleInspection(state, faction) {
  const L = state.law;
  const { cargo, nukes } = contrabandFor(state, faction);
  const found = cargo.length + (nukes > 0 ? 1 : 0);
  const fine = (found ? 1000 + 1500 * cargo.length + 1000 * nukes : 0) + 1500 * L.wanted[faction];
  const credits = state.resources.credits;
  const paid = Math.min(credits.current, fine);
  credits.current -= paid;
  state.cargo = state.cargo.filter(c => !cargo.includes(c));
  if (nukes) state.magazine.nuke = 0;
  const settled = paid >= fine;
  L.wanted[faction] = settled ? 0 : Math.max(1, L.wanted[faction]);
  adjustStanding(state, faction, found ? -10 : 2);
  const what = [cargo.length ? `${cargo.length} contraband consignment${cargo.length > 1 ? 's' : ''}` : '', nukes ? `${nukes} nuclear torpedo${nukes > 1 ? 'es' : ''}` : ''].filter(Boolean).join(' and ');
  const text = found
    ? `Inspectors seize ${what}. Fine ${fine.toLocaleString()} MCR${settled ? ' — paid.' : ` — you could only pay ${paid.toLocaleString()}. Your record stays open.`}`
    : fine ? `The search finds nothing, but your record is settled: ${fine.toLocaleString()} MCR${settled ? ' paid.' : ' — unpaid.'}`
    : 'The search finds nothing. Papers stamped; you are cleared to proceed.';
  return { found, fine, paid, seized: cargo.map(c => c.contract), text };
}

/** Daily: wanted levels fade after a quiet stretch; standing drifts toward neutral. */
export function lawTick(state) {
  if (state.clock.minute % DAY_MIN !== 420) return;
  const L = state.law;
  for (const f of POWERS) {
    if (L.wanted[f] > 0 && state.clock.minute - L.lastCrime[f] > WANTED_FADE_DAYS * DAY_MIN) {
      L.wanted[f]--;
      L.lastCrime[f] = state.clock.minute;
    }
    L.standing[f] += L.standing[f] > 0 ? -0.2 : L.standing[f] < 0 ? 0.5 : 0;
  }
}
