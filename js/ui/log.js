// ============================================================
// LONGHAUL — Ship's log
// Entries live in the game state (they're part of the save). The same line
// again within a couple of hours isn't a new entry: the one there moves up
// to the latest time and counts the repeats (×N), so a message the sim
// repeats can't bury the rest of the log. On the console the log is a
// drawer under the main view (console.js): drawn only while it is open,
// in full, by date.
// ============================================================

import { ui } from './context.js';
import { esc, setText } from './dom.js';
import { formatTime, formatDate } from '../core/clock.js';

const MAX = 300;
const REPEAT_WITHIN = 120;      // minutes: the same line again within this is counted, not added
const REPEAT_LOOK = 8;          // …looking this far back (a radio call in between doesn't break the run)
const ICON = {
  thrust: '▲', danger: '✖', warn: '⚠', ok: '✔',
  crew: '☺', system: '◈', nav: '◆', debug: '○', comms: '✉', chatter: '·',
};

let expanded = false;
let dirty = true;

export function logEntry(text, cat = 'system') {
  const s = ui.state;
  if (!s) return;
  const i = s.log.slice(0, REPEAT_LOOK).findIndex(e => e.text === text && e.cat === cat && s.clock.minute - e.m <= REPEAT_WITHIN);
  if (i >= 0) {
    const [e] = s.log.splice(i, 1);
    s.log.unshift({ ...e, m: s.clock.minute, n: (e.n || 1) + 1 });
  } else s.log.unshift({ m: s.clock.minute, text, cat });
  if (s.log.length > MAX) s.log.length = MAX;
  dirty = true;
}

export function initLog() {}

/** The drawer opened or closed (console.js). */
export function setLogExpanded(on) {
  expanded = on;
  dirty = true;
  renderLog();
}

export function resetLogView() {
  dirty = true;
}

export function renderLog() {
  if (!ui.state) return;
  setText(document.getElementById('log-count'), ui.state.log.length);
  if (!dirty || !expanded) return;
  dirty = false;
  const s = ui.state;
  const list = s.log.slice(0, MAX);
  let lastDate = null;
  const html = list.map(e => {
    const date = formatDate(s.clock, e.m);
    const stamp = expanded && date !== lastDate ? `<div class="log-date">${date}</div>` : '';
    lastDate = date;
    return `${stamp}<div class="log-entry log-${e.cat}">
      <span class="log-entry-time">${formatTime(s.clock, e.m)}</span>
      <span class="log-entry-icon">${ICON[e.cat] || ICON.system}</span>
      <span class="log-entry-msg">${esc(e.text)}${e.n > 1 ? ` <span class="log-entry-count">×${e.n}</span>` : ''}</span>
    </div>`;
  }).join('');
  document.getElementById('log-entries').innerHTML = html;
}
