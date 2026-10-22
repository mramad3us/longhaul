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
//
// Lesser offenses are citations: fines owed to a power (loitering on a
// station's approach, running dark in its control space, speeding inside
// the gate). They are paid at a station of that power, or settled by an
// inspection; a week unpaid makes us SUSPECT there. Offenses that are
// not attacks (trespass in a keep-out zone, undocking without leave,
// boarding a lawful ship) are recorded like crimes, with a severity.
//
// Military service changes some of it (service.js). A contractor firing
// on an enemy power's warships is at war, not committing a crime; firing
// on its own side's people costs its reputation and, past a shot or two,
// its license. Military-grade kit is contraband without a license: a navy
// hull flown without its navy's license (a stolen one, always), and
// nuclear torpedoes, legal only to a licensed captain, and only in its
// own power's space where Earth and Mars are concerned.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { POWERS, controlAt } from './factions.js';
import { classOf } from './ship-classes.js';
import { licenseOf, hullLegal, navyOf, enemyCombatant, ownSideCrime } from './service.js';

export const WANTED_LABEL = ['CLEAN', 'SUSPECT', 'WANTED', 'HOSTILE'];
const SEVERITY = { fired: 1, hit: 1, disabled: 2, destroyed: 3 };
const WANTED_FADE_DAYS = 10;
const FINE_GRACE_DAYS = 7;          // unpaid this long, a citation makes us SUSPECT
const FINES_MAX = 30;
/** Where nuclear torpedoes are contraband. */
export const NUKES_ILLEGAL_IN = ['UN', 'MCR'];
const LICENSED_STANDING = 20;       // a captain starting under a license starts in its power's good books
/** What an inspection levies for an unlicensed navy hull (and the wanted level it leaves). */
export const UNLICENSED_HULL_FINE = 10_000;

export function createLaw(license = null) {
  const standing = { UN: 0, MCR: 0, OPA: 10 };
  if (license) standing[license] = Math.max(standing[license], LICENSED_STANDING);
  return {
    standing,
    wanted: { UN: 0, MCR: 0, OPA: 0 },
    lastCrime: { UN: -Infinity, MCR: -Infinity, OPA: -Infinity },
    record: [],                 // recent crimes (for the log)
    fines: [],                  // citations owed: { id, faction, station, kind, amount, at }
    nextFine: 1,
  };
}

// ---- CITATIONS ----

/** A citation: a fine owed to `faction`. Independent stations fine too, but nobody chases it. */
export function cite(state, faction, { station = null, kind, amount }, emit = () => {}) {
  const L = state.law;
  L.fines ??= [];
  const f = { id: `fine-${L.nextFine = (L.nextFine || 1) + 1}`, faction, station, kind, amount, at: state.clock.minute };
  L.fines.push(f);
  if (L.fines.length > FINES_MAX) L.fines.shift();
  if (faction in L.standing) adjustStanding(state, faction, -2);
  emit('citation', f);
  return f;
}

/** Fines owed to a power (all of them, or one station's). */
export const finesOwed = (state, faction) => (state.law.fines || []).filter(f => f.faction === faction);

/** Pay what we owe a power. Returns { paid, owed, text }. */
export function payFines(state, faction) {
  const owed = finesOwed(state, faction);
  const total = owed.reduce((s, f) => s + f.amount, 0);
  const cr = state.resources.credits;
  if (!total) return { paid: 0, owed: 0, text: 'You owe nothing here.' };
  if (cr.current < total) return { paid: 0, owed: total, text: `You owe ${total.toLocaleString()} MCR and can't cover it.` };
  cr.current -= total;
  state.law.fines = state.law.fines.filter(f => !owed.includes(f));
  const L = state.law;
  if (faction in L.wanted && L.wanted[faction] === 1) L.wanted[faction] = 0;
  return { paid: total, owed: 0, text: `${total.toLocaleString()} MCR paid. Your record with ${faction} is clear of citations.` };
}

/**
 * An offense that isn't an attack on a ship: trespass, undocking without
 * leave, boarding a lawful hull. Severity 1–3, recorded like a crime.
 */
export function recordOffense(state, faction, kind, severity, emit = () => {}, where = '') {
  const L = state.law;
  ownSideCrime(state, faction, severity, emit);
  if (faction in L.standing) {
    adjustStanding(state, faction, -8 * severity);
    L.wanted[faction] = Math.max(L.wanted[faction], Math.min(3, severity));
    L.lastCrime[faction] = state.clock.minute;
  }
  const crime = { kind, victim: where, factions: faction in L.standing ? [faction] : [], at: state.clock.minute };
  L.record.push(crime);
  if (L.record.length > 20) L.record.shift();
  emit('crime', crime);
  return crime;
}

/** Is shooting at this ship a crime? (With `state`: not for a contractor at war with its power.) */
export function lawfulTarget(e, state = null) {
  if (e?.type === 'station') return e.faction !== 'pirate' && e.combat?.status !== 'wreck';
  if (!e || e.type !== 'ship') return false;
  if (state && enemyCombatant(state, e)) return false;
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
  if (enemyCombatant(state, e)) {
    // War: no crime, but they won't forget whose flag it was
    if (POWERS.includes(e.faction) && kind !== 'fired') adjustStanding(state, e.faction, -SEVERITY[kind]);
    return null;
  }
  if (!lawfulTarget(e)) {
    if (kind === 'destroyed' && e.faction === 'pirate') {
      const ctl = controlAt(e.pos.x, e.pos.y, state.clock.minute).faction;
      if (ctl) adjustStanding(state, ctl, 3);
    }
    return null;
  }
  const cat = classOf(e)?.category;
  const sev = Math.min(3, SEVERITY[kind] + (cat === 'military' || cat === 'authority' || e.type === 'station' ? 1 : 0));
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
  if (licenseOf(state) && powers.has(licenseOf(state)) && e.faction === licenseOf(state)) ownSideCrime(state, e.faction, sev, emit);
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

/** Are nuclear warheads legal for us under `faction`'s law? (Only with a license; in Earth's and Mars's space only with theirs.) */
export function nukesLegal(state, faction) {
  const lic = licenseOf(state);
  return !!lic && (faction === lic || !NUKES_ILLEGAL_IN.includes(faction));
}

/**
 * What an inspector of `faction` would seize or levy: { cargo: [items],
 * nukes: n, hull: 'unlicensed' | 'stolen' | null }.
 */
export function contrabandFor(state, faction) {
  const cargo = state.cargo.filter(c => c.contraband && (c.illegalIn || POWERS).includes(faction));
  const nukes = nukesLegal(state, faction) ? 0 : state.magazine.nuke;
  const navy = navyOf(state.ship.classId);
  const hull = hullLegal(state) ? null : navy === 'stolen' || navy === faction ? 'stolen' : 'unlicensed';
  return { cargo, nukes, hull };
}

/**
 * A completed inspection by `faction`: contraband seized, fines levied,
 * the ledger settled. Returns { found, fine, paid, text }.
 */
export function settleInspection(state, faction) {
  const L = state.law;
  const { cargo, nukes, hull } = contrabandFor(state, faction);
  const found = cargo.length + (nukes > 0 ? 1 : 0) + (hull ? 1 : 0);
  const owed = finesOwed(state, faction);
  const fine = (found ? 1000 + 1500 * cargo.length + 1000 * nukes : 0) + (hull ? UNLICENSED_HULL_FINE : 0) + 1500 * L.wanted[faction] + owed.reduce((s, f) => s + f.amount, 0);
  const credits = state.resources.credits;
  const paid = Math.min(credits.current, fine);
  credits.current -= paid;
  state.cargo = state.cargo.filter(c => !cargo.includes(c));
  if (nukes) state.magazine.nuke = 0;
  const settled = paid >= fine;
  if (settled) L.fines = (L.fines || []).filter(f => !owed.includes(f));
  // (a hull can't be seized at sea: the record stays open on it, as long as we fly it)
  L.wanted[faction] = hull === 'stolen' ? Math.max(2, L.wanted[faction]) : hull ? Math.max(1, L.wanted[faction]) : settled ? 0 : Math.max(1, L.wanted[faction]);
  adjustStanding(state, faction, found ? -10 : 2);
  const what = [cargo.length ? `${cargo.length} contraband consignment${cargo.length > 1 ? 's' : ''}` : '', nukes ? `${nukes} nuclear torpedo${nukes > 1 ? 'es' : ''}` : ''].filter(Boolean).join(' and ');
  const hullText = hull === 'stolen' ? 'This is a stolen navy hull: the record stays open as long as you fly it.' : hull ? 'You are flying a military hull without its license: the record stays open as long as you fly it.' : '';
  const text = found
    ? `${what ? `Inspectors seize ${what}. ` : ''}${hullText ? `${hullText} ` : ''}Fine ${fine.toLocaleString()} MCR${settled ? ' — paid.' : ` — you could only pay ${paid.toLocaleString()}. Your record stays open.`}`
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
    if (finesOwed(state, f).some(x => state.clock.minute - x.at > FINE_GRACE_DAYS * DAY_MIN) && L.wanted[f] < 1) L.wanted[f] = 1;
  }
}
