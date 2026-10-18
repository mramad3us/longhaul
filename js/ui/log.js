// ============================================================
// LONGHAUL — Ship's log
// Entries live in the game state (they're part of the save).
// ============================================================

import { ui } from './context.js';
import { esc, setText } from './dom.js';
import { formatTime, formatDate } from '../core/clock.js';

const MAX = 300;
const COLLAPSED = 3;
const ICON = {
  thrust: '▲', danger: '✖', warn: '⚠', ok: '✔',
  crew: '☺', system: '◈', nav: '◆', debug: '○', comms: '✉',
};

let expanded = false;
let dirty = true;

export function logEntry(text, cat = 'system') {
  const s = ui.state;
  if (!s) return;
  s.log.unshift({ m: s.clock.minute, text, cat });
  if (s.log.length > MAX) s.log.length = MAX;
  dirty = true;
}

export function initLog() {
  const btn = document.getElementById('log-expand-btn');
  btn.addEventListener('click', () => {
    expanded = !expanded;
    document.getElementById('log-container').classList.toggle('expanded', expanded);
    setText(document.getElementById('log-expand-text'), expanded ? 'COLLAPSE' : 'SHOW FULL LOG');
    dirty = true;
    renderLog();
  });
}

export function resetLogView() {
  expanded = false;
  document.getElementById('log-container')?.classList.remove('expanded');
  setText(document.getElementById('log-expand-text'), 'SHOW FULL LOG');
  dirty = true;
}

export function renderLog() {
  if (!dirty || !ui.state) return;
  dirty = false;
  const s = ui.state;
  const list = s.log.slice(0, expanded ? MAX : COLLAPSED);
  let lastDate = null;
  const html = list.map(e => {
    const date = formatDate(s.clock, e.m);
    const stamp = expanded && date !== lastDate ? `<div class="log-date">${date}</div>` : '';
    lastDate = date;
    return `${stamp}<div class="log-entry log-${e.cat}">
      <span class="log-entry-time">${formatTime(s.clock, e.m)}</span>
      <span class="log-entry-icon">${ICON[e.cat] || ICON.system}</span>
      <span class="log-entry-msg">${esc(e.text)}</span>
    </div>`;
  }).join('');
  document.getElementById('log-entries').innerHTML = html;
  setText(document.getElementById('log-count'), s.log.length);
}
