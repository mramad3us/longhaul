// ============================================================
// LONGHAUL — A contract's brief, as the board posts it and the log keeps it
//
// Every contract carries the facts it was posted with (sim/contracts.js,
// sim/military.js) and a timeline of what happened to it (c.log). This
// lays them out the same way wherever a contract is read: on a station's
// board before signing, in the mission log while the work is in hand, and
// after it is done or failed (the log keeps the last 40). The sections,
// each only when it has something to say:
//
//   CONTRACT     its number, its kind, who posted it, when; signed (where),
//                due; before signing, the time it gives and how long the
//                offer stands; where it is turned in
//   PAY          the fee, the bonuses it offers, the reputation; what was paid
//   TASK         what is to be done, in the board's words
//   TARGET       the ship: name, class, grade (a bounty), owner and
//                registry, hull, crew, guns, drive, whether it squawks, who
//                runs with it, what it is wanted for; its DRIVE SIGNATURE,
//                on file or not (and the authorities' reason), and so what
//                can name it
//   LAST FIX     where it was seen, when, by whom, the search area round it
//   LOAD         cargo, passengers, fuel, and where to
//   STATUS       where the work stands: named or not (and how), the
//                possibles on the board, the outcome, done or failed when
//   TIMELINE     what the nav computer called out about it, stamped
//
// briefOf() gives the sections as plain rows (tests read them); briefHTML()
// renders them. Nothing here changes the contract.
// ============================================================

import { esc, fmtNum, fmtRewards } from './dom.js';
import { formatStamp, formatDuration } from '../core/clock.js';
import { CONTRACT_LABEL, bountyHeads } from '../sim/contracts.js';
import { FACTIONS, SUBFACTIONS } from '../sim/factions.js';
import { CLASSES } from '../sim/ship-classes.js';
import { sigOnFile, namedBy, SEARCH_KM_DEFAULT } from '../sim/hunts.js';

const HUNT = new Set(['BOUNTY', 'STRIKE']);
const HOW_NAMED = { transponder: 'its transponder', signature: 'its drive signature, read in its plume', logs: 'the sensor logs, after the fact' };

/** Where a contract is turned in. */
function turnIn(state, c) {
  if (c.mil) return `any ${FACTIONS[c.faction]?.short || ''} port (a station or a command ship)`;
  if (c.type === 'ESCORT') return `${c.destName}, with the convoy berthed`;
  if (c.dest && c.type !== 'ESCORT') return `delivered at ${c.destName}, across a berth's collar`;
  if (c.perHead) return bountyHeads(state, c).heads ? `${c.stationName}, docked: its crew cross at a berth's collar` : `${c.stationName}, from its port space (docked, with any of its crew)`;
  return `${c.stationName}, from its port space`;
}

/** What the work is, now (the mission log's line). */
export function progressLine(state, c) {
  if (c.phase === 'offered') return 'On the board';
  if (c.phase === 'complete') return `Complete${c.completedAt != null ? ` · ${formatStamp(state.clock, c.completedAt)}` : ''}`;
  if (c.phase === 'failed') return `Failed: ${c.failReason}`;
  if (c.phase === 'return') {
    if (c.mil) return `Report to ${c.stationName} (or any ${FACTIONS[c.faction].short} port)`;
    const h = c.perHead ? bountyHeads(state, c) : null;
    return `Return to ${c.stationName}${h ? ` · ${h.heads ? `${h.heads} of its crew in our brig (${fmtNum(h.pay)} MCR)` : 'none of its crew aboard yet: board it to take them'}` : ''}`;
  }
  const hunt = HUNT.has(c.type) ? (c.identified ? ' · target named' : c.suspects?.length ? ` · ${c.suspects.length} possible${c.suspects.length > 1 ? 's' : ''} on the board` : ' · not found yet') : '';
  switch (c.type) {
    case 'INTEL': return `Lock ${c.count} enemy ships for ${c.lockMin} min each — ${Object.values(c.tracked).filter(m => m >= c.lockMin).length} of ${c.count} logged`;
    case 'HOLD': return c.arrived ? `Holding point ${c.point}: ${formatDuration(c.held)} of ${formatDuration(c.holdMin)}${c.away ? ` · OFF THE POINT ${c.away} min` : ''}` : `Get within 75,000 km of point ${c.point}`;
    case 'STRIKE': return `Find and destroy the ${c.targetName}${hunt}`;
    case 'COVERT': return `Lock the ${c.targetName} unseen — ${Math.round(c.scanned / c.scanMin * 100)}%`;
    case 'ESCORT': return c.phase === 'active' ? `Join the ${c.targetName} (within 10 km)` : c.phase === 'underway' ? `Escorting to ${c.destName}` : `Dock at ${c.destName}`;
    case 'RECON': return `Lock the picket inside 300,000 km — ${Math.round(c.scanned / c.scanMin * 100)}%`;
    case 'BOUNTY': return `Find the ${c.targetName}: destroy it, or disable it and accept its surrender${hunt}`;
    case 'SURVEY': return `Survey ${Math.round(c.scanned / c.scanMin * 100)}%`;
    case 'SALVAGE': return c.worked ? `Salvage ${Math.round(c.worked / c.workMin * 100)}%` : 'Proceed to the derelict';
  }
  return c.dest ? `Deliver at ${c.destName}` : 'Proceed to target';
}

/** The ship a contract is about, as the brief describes it. */
function targetRows(c) {
  const sh = c.ship, k = CLASSES[sh.cls];
  const rows = [['NAME', sh.name], ['CLASS', sh.shipClass || k?.name || '—']];
  if (c.gradeLabel) rows.push(['GRADE', c.gradeLabel]);
  const pirate = sh.faction === 'pirate';
  const owner = pirate ? 'pirate · on no registry' : `${FACTIONS[sh.faction]?.name || sh.faction}${sh.sub && SUBFACTIONS[sh.sub] ? ` · ${SUBFACTIONS[sh.sub].name}` : ''}`;
  rows.push(['OWNER', HUNT.has(c.type) && !pirate && c.enemy?.startsWith?.('$') ? `${owner} · on no registry` : owner]);
  if (k) {
    rows.push(['HULL', `${fmtNum(sh.mass || k.massT)} t · ${k.lengthM ? `${fmtNum(k.lengthM)} m · ` : ''}TL${k.tl}`]);
    rows.push(['CREW', `${k.crew[0]}–${k.crew[1]}`]);
    const guns = [k.pdc ? `${k.pdc} PDC` : null, k.tubes ? `${k.tubes} torpedo tube${k.tubes > 1 ? 's' : ''}` : null, k.railgun ? `${k.railgun} railgun${k.railgun > 1 ? 's' : ''}` : null].filter(Boolean);
    rows.push(['ARMED', guns.length ? guns.join(' · ') : 'unarmed']);
    rows.push(['DRIVE', `to ${fmtNum(k.drive.maxG, 1)} G`]);
  }
  if (HUNT.has(c.type)) {
    const dark = c.type === 'BOUNTY' || (c.enemy || '').startsWith('$');
    rows.push(['TRANSPONDER', dark ? 'runs dark' : 'squawks']);
    if (c.escorts) rows.push(['RUNS WITH', `${c.escorts} ${c.type === 'STRIKE' ? 'escort' : 'raider'}${c.escorts > 1 ? 's' : ''}, dark`]);
    if (c.wanted?.length) rows.push(['WANTED FOR', c.wanted.join('; ')]);
    rows.push(['DRIVE SIGNATURE', sigOnFile(c) ? `ON FILE · ${c.signature}` : 'NOT ON FILE', sigOnFile(c) ? 'ok' : 'warn']);
    if (!sigOnFile(c)) rows.push(['WHY NOT', c.sigWhy || 'Not given.']);
    rows.push(['NAMED', namedBy(c)]);
  }
  return rows;
}

/** The brief's sections: [{ head, rows: [[label, value, tone?]] }] (tone: 'ok' | 'warn' | 'dim'). */
export function briefOf(state, c, { task = true } = {}) {
  const at = (m) => (m == null ? '—' : formatStamp(state.clock, m));
  const S = [];
  // ---- the contract
  const con = [['NUMBER', String(c.id).toUpperCase()], ['TYPE', CONTRACT_LABEL[c.type] || c.type]];
  con.push(['POSTED BY', c.mil ? `${FACTIONS[c.faction]?.navy || ''}${c.issuer && SUBFACTIONS[c.issuer] ? ` · ${SUBFACTIONS[c.issuer].name}` : ''}, at ${c.stationName}` : c.stationName]);
  con.push(['POSTED', at(c.offeredAt)]);
  if (c.phase === 'offered') {
    con.push(['TIME GIVEN', `${formatDuration(c.deadline)} from signing`]);
    con.push(['OFFER STANDS TO', at(c.expires)]);
  } else {
    con.push(['SIGNED', `${at(c.acceptedAt)}${c.signedAt ? ` · ${c.signedAt}` : ''}`]);
    con.push(['DUE', at(c.dueAt)]);
  }
  if (c.rankMin && c.mil) con.push(['RANK', `rank ${c.rankMin} and up`]);
  con.push(['TURN IN', turnIn(state, c)]);
  S.push({ head: 'CONTRACT', rows: con });
  // ---- the pay
  const pay = [['FEE', fmtRewards(c.reward) || '—']];
  if (c.perHead) {
    pay.push(['PER HEAD', `${fmtNum(c.perHead)} MCR for each of its crew brought back alive, ${fmtNum(c.captainHead || c.perHead * 4)} for its captain: board it, take them prisoner, hand them over with the contract`]);
    const h = c.phase === 'return' || c.phase === 'active' ? bountyHeads(state, c) : null;
    if (h?.heads) pay.push(['IN OUR BRIG', `${h.heads} of its crew${h.captains ? ', its captain among them' : ''}: ${fmtNum(h.pay)} MCR at turn-in`, 'ok']);
  } else if (c.aliveBonus) pay.push(['ALIVE', c.outcome === 'captured' ? `the fee includes +${Math.round(c.aliveBonus * 100)}% for the crew's surrender` : `+${Math.round(c.aliveBonus * 100)}% if it is disabled and its crew surrenders`]);
  if (c.vip) pay.push(['VIP', '+25% for a transit in half the time given']);
  if (c.mil && c.rep) pay.push(['REPUTATION', `+${c.rep} with ${FACTIONS[c.faction]?.navy || 'command'}`]);
  if (c.paid) pay.push(['PAID', fmtRewards(c.paid), 'ok']);
  S.push({ head: 'PAY', rows: pay });
  // ---- the task, in the board's words
  if (task) S.push({ head: 'TASK', rows: [['ORDERS', c.description || c.title]] });
  // ---- the ship it is about
  if (c.ship) S.push({ head: 'TARGET', rows: targetRows(c) });
  // ---- where it was last seen
  if (c.fix || (HUNT.has(c.type) && c.phase !== 'offered')) {
    const f = c.fix || {};
    const rows = [];
    if (f.distKm) rows.push(['WHERE', `${fmtNum(f.distKm)} km off ${f.body}`]);
    else if (f.body || c.body) rows.push(['WHERE', `near ${f.body || c.body}`]);
    if (f.at != null) rows.push(['WHEN', `${at(f.at)} · ${formatDuration(c.offeredAt - f.at)} before posting`]);
    if (f.by) rows.push(['SEEN BY', f.by]);
    rows.push(['SEARCH AREA', `within ${fmtNum(f.rKm || SEARCH_KM_DEFAULT)} km of the fix${c.phase !== 'offered' ? ' (the last-seen mark on the displays)' : ''}`]);
    S.push({ head: 'LAST FIX', rows });
  }
  // ---- what it carries
  const load = [];
  if (c.cargo) load.push(['CARGO', `${fmtNum(c.cargo.mass)} kg of ${c.cargo.name}${c.cargo.contraband ? ` · CONTRABAND in ${(c.cargo.illegalIn || []).map(f => FACTIONS[f]?.short || f).join(', ')} space` : ''}`, c.cargo.contraband ? 'warn' : null]);
  if (c.passengers) load.push(['PASSENGERS', `${c.passengers}${c.vip ? ' · VIP' : ''}`]);
  if (c.fuelKg) load.push(['FUEL', `${fmtNum(c.fuelKg)} kg from our tanks`]);
  if (c.destName) load.push(['TO', c.destName]);
  if (load.length) S.push({ head: 'LOAD', rows: load });
  // ---- where it stands
  if (c.phase !== 'offered') {
    const st = [['STATE', progressLine(state, c), c.phase === 'failed' ? 'warn' : c.phase === 'complete' ? 'ok' : null]];
    if (HUNT.has(c.type)) {
      st.push(['IDENTIFIED', c.identified ? `by ${HOW_NAMED[c.identified] || c.identified}${c.identifiedAt != null ? ` · ${at(c.identifiedAt)}` : ''}` : 'not yet', c.identified ? 'ok' : 'dim']);
      if (!c.identified && c.phase === 'active') st.push(['POSSIBLES', c.suspects?.length ? `${c.suspects.length} dark contact${c.suspects.length > 1 ? 's' : ''} on the board, marked ${c.type}?` : 'none on the board']);
      const out = Object.keys(c.ruledOut || {}).length;
      if (out) st.push(['RULED OUT', `${out} contact${out > 1 ? 's' : ''}`]);
    }
    if (c.outcome) st.push(['OUTCOME', c.outcome === 'captured' ? 'struck its colours' : c.outcome]);
    if (c.brought) st.push(['BROUGHT BACK', `${c.brought.heads} of its crew${c.brought.captains ? ', its captain among them' : ''}: ${fmtNum(c.brought.pay)} MCR`, 'ok']);
    if (c.completedAt != null) st.push(['TURNED IN', at(c.completedAt), 'ok']);
    if (c.failedAt != null) st.push(['FAILED', `${at(c.failedAt)} · ${c.failReason}`, 'warn']);
    S.push({ head: 'STATUS', rows: st });
  }
  // ---- what happened
  if (c.log?.length) S.push({ head: 'TIMELINE', rows: c.log.map(l => [formatStamp(state.clock, l.m), l.text]), log: true });
  return S;
}

/** The brief as HTML (task: false where the board's own words are printed above it). */
export function briefHTML(state, c, opts) {
  return `<div class="brief">${briefOf(state, c, opts).map(sec => `<div class="brief-head">${esc(sec.head)}</div>
    <div class="brief-rows${sec.log ? ' brief-log' : ''}">${sec.rows.map(([k, v, tone]) => `<div class="brief-k">${esc(k)}</div><div class="brief-v${tone ? ` brief-${tone}` : ''}">${esc(v)}</div>`).join('')}</div>`).join('')}</div>`;
}
