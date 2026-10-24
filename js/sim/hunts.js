// ============================================================
// LONGHAUL — The ships we hunt: which contact is it?
//
// A bounty's pirate, a strike's high-value target: on no registry, and
// (but for a navy's warship) running dark. What the brief knows about it
// is fixed when the job is posted (contracts.js, military.js). Above all
// whether its drive signature is on file: c.sigKnown, always set. When it
// isn't, the brief says why (c.sigWhy). Only the most wanted are posted
// without one, and only for a reason the authorities can give: a drive
// swapped at a yard that keeps no books, a hull stolen and refitted off the
// record, a captain who has never burned where a sensor that lived could
// see.
//
// What the nav computer can say about a ship on the board:
//
//   CONFIRMED  its transponder names it (a crew striking its colours
//              squawks); or the signature on file, read in its plume while
//              the drive is lit (sensors.js identifyHunt). Once named, it
//              stays named. With no signature on file only the
//              transponder can do it: a plume proves nothing.
//   POSSIBLE   a dark ship nobody has named, seen inside the search area
//              of the last fix (the brief's radius round the last-seen
//              mark), and anything followed from there on the board: it
//              might be the target. The displays mark it as a possible
//              (marks.js), never by the target's name.
//   RULED OUT  a possible that turned out to be someone else: it squawks
//              another name, a long look matched it on a registry (the
//              target is on none), its plume carries another signature
//              than the one on file, or its mass is no hull of the
//              target's class.
//
// Destroying a possible that was the target still earns the bounty (the
// station checks the sensor logs); destroying one that wasn't is whatever
// it was: piracy, if it was a lawful ship running dark.
//
// Possibles are kept on the contract (c.suspects, at most SUSPECTS_MAX),
// ruled-out contacts with their reason (c.ruledOut, at most RULED_MAX).
// Cost: once a minute, per hunt, a pass over the board (a few hundred
// contacts at most).
// ============================================================

import { AU_KM } from '../core/constants.js';
import { getWorld } from './world.js';
import { REVEAL, isIdentified, identifyHunt, huntNamed, huntsOf } from './sensors.js';

export const SUSPECTS_MAX = 12;
const RULED_MAX = 30;
export const SEARCH_KM_DEFAULT = 450_000;  // a fix's search area when the brief gives none (saves from before 1.1)
const MASS_TOLERANCE = 0.35;               // a hull this far off the class's mass is not the target's

/** Is the target's drive signature on file? (A contract from before 1.1 had it if it carried one.) */
export const sigOnFile = (c) => c.sigKnown ?? !!c.signature;

/** The search area round the last fix, AU. */
export const searchAU = (c) => (c.fix?.rKm || SEARCH_KM_DEFAULT) / AU_KM;

/** How the target can be named, in a line for the brief and the contact sheet. */
export const namedBy = (c) => sigOnFile(c)
  ? `by its transponder, or by its drive signature ${c.signature} read in its plume (only while its drive is lit)`
  : 'by its transponder only: no signature on file to match its plume against';

/**
 * Why a contact in the search area is not the target, or null. The target
 * itself never meets any of these (it squawks: it is named; it is on no
 * registry; its plume carries the signature on file; its mass is its class's).
 */
function ruleOut(state, c, e, hunts) {
  // (the target meets none of these by construction; said outright, so no rounding ever rules it out)
  if (e.id === c.targetId) return null;
  if (e.transponder) return `squawking as the ${e.name}`;
  if (isIdentified(state, e, undefined, hunts)) return `a long look matched it on a registry: the ${e.name}`;
  if (sigOnFile(c) && e.thrust > 0 && e.signature !== c.signature) return `its plume reads ${e.signature}, not ${c.signature}`;
  const scan = state.sensors.scan[e.id] || 0;
  if (scan >= REVEAL.MASS && c.ship?.mass && Math.abs(e.mass - c.ship.mass) / c.ship.mass > MASS_TOLERANCE)
    return `${Math.round(e.mass).toLocaleString()} t is no ${c.ship.shipClass || 'hull of its class'}`;
  return null;
}

/** Why a possible can't be confirmed yet (the nav computer's words). */
export function unconfirmed(state, c, e) {
  if (!sigOnFile(c)) return e?.thrust > 0 ? `its plume reads ${e.signature}, but there is no signature on file to match` : 'no signature on file: only its transponder can name it';
  return 'drive cold: its signature can\'t be read until it burns';
}

/**
 * Once a minute, for a hunt in progress: name the target if it shows
 * itself, else keep the list of possibles (new ones in the search area,
 * followed ones while the board holds them, ruled-out ones dropped). The
 * nav computer calls each change out (contract-progress).
 */
export function huntTick(state, c, emit = () => {}) {
  if (c.phase !== 'active' || !c.targetId) return;
  const seen = state.sensors.$seen;
  if (!seen) return;
  const now = state.clock.minute;
  if (!c.identified && identifyHunt(state, c)) {
    c.identifiedAt = now;
    c.suspects = [];
    emit('contract-progress', { contract: c, text: huntNamed(c) });
    return;
  }
  if (c.identified) return;
  const world = getWorld(state);
  const hunts = huntsOf(state);
  const S = c.suspects ||= [], R = c.ruledOut ||= {};
  // the ones we follow: still on the board, not shown to be someone else
  for (let i = S.length - 1; i >= 0; i--) {
    const e = world.get(S[i]);
    if (!e || !seen.has(e.id) || e.tags?.wreck) { S.splice(i, 1); continue; }
    const why = ruleOut(state, c, e, hunts);
    if (!why) continue;
    S.splice(i, 1);
    R[e.id] = { at: now, why };
    const ids = Object.keys(R);
    if (ids.length > RULED_MAX) delete R[ids[0]];
    emit('contract-progress', { contract: c, text: `Ruled out for the ${c.targetName}: ${why}` });
  }
  // new ones: dark, unnamed, inside the search area of the last fix
  const mark = c.markId && world.get(c.markId);
  if (!mark || S.length >= SUSPECTS_MAX) return;
  const rAU = searchAU(c);
  for (const id of seen) {
    if (S.length >= SUSPECTS_MAX) break;
    if (S.includes(id) || R[id]) continue;
    const e = world.get(id);
    if (!e || e.type !== 'ship' || e.transponder || e.tags?.wreck) continue;
    if (Math.hypot(e.pos.x - mark.pos.x, e.pos.y - mark.pos.y) > rAU) continue;
    if (ruleOut(state, c, e, hunts)) continue;
    S.push(id);
    emit('contract-progress', { contract: c, text: `Dark contact inside the search area of the ${c.targetName}'s last fix: possibly our target (${unconfirmed(state, c, e)})` });
  }
}

/** What the nav computer makes of a contact for a hunt: 'confirmed', 'possible', 'ruled-out' or null. */
export function huntStatus(c, id) {
  if (!c || c.phase !== 'active') return null;
  if (id === c.targetId && c.identified) return 'confirmed';
  if (c.suspects?.includes(id)) return 'possible';
  if (c.ruledOut?.[id]) return 'ruled-out';
  return null;
}

/** The hunts a contact matters to, with what we make of it: [{ c, status }]. */
export function huntsFor(state, id) {
  const out = [];
  for (const c of state.contracts?.active || []) {
    if (c.type !== 'BOUNTY' && c.type !== 'STRIKE') continue;
    const status = huntStatus(c, id);
    if (status) out.push({ c, status });
  }
  return out;
}
