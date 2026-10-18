// ============================================================
// LONGHAUL — Keyboard shortcuts
// ============================================================

import { ui } from './context.js';

/**
 * actions: { speed(n), togglePause(), nav(tab), missions(), jobs(), station(),
 *            combat(), escape(), save(), devFlip(), devCut() }
 */
export function initKeyboard(actions) {
  document.addEventListener('keydown', (e) => {
    if (ui.screen !== 'game' || !ui.state) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); actions.save(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = {
      ' ': actions.togglePause,
      '1': () => actions.speed(1), '2': () => actions.speed(2), '3': () => actions.speed(3),
      m: () => actions.nav('solar'), r: () => actions.nav('scanner'), t: () => ui.settings.devMode ? actions.devCut() : actions.nav('tactical'),
      l: actions.missions, j: actions.jobs, b: actions.station, c: actions.combat,
      f: () => ui.settings.devMode && actions.devFlip(),
      Escape: actions.escape,
    };
    const fn = map[k];
    if (fn) { e.preventDefault(); fn(); }
  });
}
