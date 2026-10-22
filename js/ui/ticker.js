// ============================================================
// LONGHAUL — The radio, in the console's bottom bar
// The last couple of transmissions near a hub (traffic control, our nav
// computer's callouts, warnings), in the console's bottom bar for a few
// seconds each. Everything also goes in the ship's log.
// ============================================================

import { $, esc } from './dom.js';

const MAX = 2, LIFE_MS = 14_000;

export function pushTicker(text, kind = 'comms', from = '') {
  const box = $('#comms-ticker');
  if (!box) return;
  const line = document.createElement('div');
  line.className = `ct-line ct-${kind}`;
  line.innerHTML = `${from ? `<span class="ct-from">${esc(from)}</span>` : ''}${esc(text)}`;
  box.appendChild(line);
  while (box.children.length > MAX) box.firstChild.remove();
  setTimeout(() => line.remove(), LIFE_MS);
}

export function clearTicker() {
  const box = $('#comms-ticker');
  if (box) box.innerHTML = '';
}
