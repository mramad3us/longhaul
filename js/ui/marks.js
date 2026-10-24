// ============================================================
// LONGHAUL — The nav computer's marks, drawn the same everywhere
//
// sim/flags.js decides what is marked; this is how it looks, on every
// display (the solar map, local space, the scanner, the threat board,
// the exterior) and in every list that names a ship:
//
//   DARK     the ship's mark is drawn hollow (one squawking its
//            transponder is solid), and DARK follows its name in amber;
//            a wreck, silent too, is hollow and reads WRECK
//   MISSION  a magenta diamond round the mark (magenta is the route's
//            colour: the nav computer's "where we are going"), and the
//            job after the name; a contact that might be the ship we hunt
//            (a possible) a dashed diamond and the job with a question
//            mark (BOUNTY?), and no name
//   FLAG     a yellow pennant with its letter at the mark's shoulder. A
//            crowded display leaves names off; it never leaves a flag off.
// ============================================================

import { esc } from './dom.js';
import { missionTargets, missionSuspects } from '../sim/flags.js';

export const MARK_COL = { flag: '#FFE15C', mission: '#D46BE0', dark: '#F0A93A', wreck: '#7A8794' };
const LETTER_FONT = '600 10px "IBM Plex Mono", ui-monospace, monospace';

/** What is marked this frame (built once per render, then asked per contact). */
export function frameMarks(state) {
  return { missions: missionTargets(state), suspects: missionSuspects(state), flags: state.navFlags || {} };
}

/**
 * One entity's marks: { dark, wreck, mission (the job's tag), maybe (the
 * job's tag, for a possible), flag (its letter) }. Whether it is dark or a wreck is what the board (or the
 * plot's record) says, so the caller passes it.
 */
export function marksOf(fm, id, dark = false, wreck = false) {
  const mission = fm.missions.get(id) || null;
  return { dark: !!dark && !wreck, wreck: !!wreck, mission, maybe: mission ? null : fm.suspects?.get(id) || null, flag: fm.flags[id]?.letter || null };
}

/** How much a mark's name matters on a crowded display (labels.js priority), on top of its own. */
export const markPri = (m) => (m.flag ? 3 : 0) + (m.mission ? 2.5 : m.maybe ? 2 : 0);

/** The tags after a name on a display (labels.js). */
export function labelTags(m) {
  const t = [];
  if (m.mission) t.push({ text: m.mission, color: MARK_COL.mission });
  else if (m.maybe) t.push({ text: `${m.maybe}?`, color: MARK_COL.mission });
  if (m.dark) t.push({ text: 'DARK', color: MARK_COL.dark });
  else if (m.wreck) t.push({ text: 'WRECK', color: MARK_COL.wreck });
  return t.length ? t : null;
}

/** The same, for a line of text (a display's tooltip): " · BOUNTY · DARK · FLAG A". */
export function markWords(m) {
  return [m.mission || (m.maybe ? `${m.maybe}?` : null), m.dark ? 'DARK' : m.wreck ? 'WRECK' : null, m.flag ? `FLAG ${m.flag}` : null].filter(Boolean).map(w => ` · ${w}`).join('');
}

/** The same, as chips in a list or a panel. */
export function markChips(m) {
  let h = '';
  if (m.flag) h += `<span class="mk mk-flag" title="Flagged: F on the selection clears it">${m.flag}</span>`;
  if (m.mission) h += `<span class="mk mk-mission" title="What our work points at">${esc(m.mission)}</span>`;
  else if (m.maybe) h += `<span class="mk mk-mission mk-maybe" title="Possibly the ship we hunt: dark, seen in the search area of its last fix, not confirmed">${esc(m.maybe)}?</span>`;
  if (m.dark) h += '<span class="mk mk-dark" title="No transponder: it isn\'t saying who it is">DARK</span>';
  else if (m.wreck) h += '<span class="mk mk-wreck" title="A wreck: dead and silent">WRECK</span>';
  return h;
}

/** A magenta diamond round a mark of radius `r` (dashed: a possible). */
export function drawMissionMark(ctx, x, y, r, maybe = false) {
  ctx.strokeStyle = MARK_COL.mission;
  ctx.lineWidth = 1.5;
  if (maybe) ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.stroke();
  if (maybe) ctx.setLineDash([]);
  ctx.lineWidth = 1;
}

/**
 * A pennant and its letter at the shoulder of a mark of radius `r` (its
 * top right), kept clear of names when a Labels pass is given.
 */
export function drawFlagMark(ctx, x, y, r, letter, labels = null) {
  const px = Math.round(x + r * 0.7) + 0.5, foot = y - r * 0.7, top = Math.round(foot - 12);
  ctx.strokeStyle = MARK_COL.flag; ctx.fillStyle = MARK_COL.flag; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px, foot); ctx.lineTo(px, top); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px + 8, top + 3.5); ctx.lineTo(px, top + 7); ctx.closePath(); ctx.fill();
  ctx.font = LETTER_FONT;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(letter).width;
  ctx.fillStyle = 'rgba(5,7,10,0.75)'; ctx.fillRect(px + 9, top - 2, w + 3, 11);
  ctx.fillStyle = MARK_COL.flag; ctx.fillText(letter, px + 10.5, top + 3.5);
  ctx.textBaseline = 'alphabetic';
  // (the foot of its pole left free: the mark's own name goes beside the mark, under the pennant)
  labels?.block(px - 1, top - 2, px + 12 + w, foot - 1.5);
}

/** A ship's mark drawn hollow (dark) or solid, along whatever path the caller has just traced. */
export function paintMark(ctx, color, hollow, bg = '#05070A') {
  if (!hollow) { ctx.fillStyle = color; ctx.fill(); return; }
  ctx.fillStyle = bg; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
}
