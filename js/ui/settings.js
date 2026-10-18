// ============================================================
// LONGHAUL — Settings
// ============================================================

import { ui } from './context.js';
import { saveSetting, loadSettings } from '../storage.js';
import { scheduleAutosave } from './persistence.js';

const DEFS = [
  { key: 'autosaveMinutes', label: 'Autosave', type: 'select', options: [[0, 'Off'], [1, 'Every minute'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes']] },
  { key: 'reduceMotion', label: 'Reduce motion', type: 'toggle', hint: 'Fewer particles, no screen flicker' },
  { key: 'showPerf', label: 'Performance overlay', type: 'toggle' },
  { key: 'devMode', label: 'Developer mode', type: 'toggle', hint: 'Manual helm, debug tools', dev: true },
];

export async function initSettings() {
  try {
    const saved = await loadSettings();
    for (const d of DEFS) if (saved[d.key] !== undefined) ui.settings[d.key] = saved[d.key];
  } catch (e) { console.warn('[settings] using defaults', e); }
  apply();
}

export function apply() {
  document.body.classList.toggle('dev-mode', !!ui.settings.devMode);
  document.body.classList.toggle('reduce-motion', !!ui.settings.reduceMotion);
  scheduleAutosave();
}

/** Render controls into a container; all containers stay in sync. */
export function renderSettings(container) {
  container.innerHTML = DEFS.map(d => {
    const v = ui.settings[d.key];
    const ctl = d.type === 'toggle'
      ? `<button class="setting-toggle ${v ? 'active' : ''}" data-key="${d.key}">${v ? 'ON' : 'OFF'}</button>`
      : `<select class="setting-select" data-key="${d.key}">${d.options.map(([val, l]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    return `<div class="setting-row ${d.dev ? 'setting-row-dev' : ''}"><span class="setting-label">${d.label}${d.hint ? `<small class="setting-hint">${d.hint}</small>` : ''}</span>${ctl}</div>`;
  }).join('');
  container.onclick = (e) => {
    const b = e.target.closest('.setting-toggle');
    if (!b) return;
    set(b.dataset.key, !ui.settings[b.dataset.key]);
    renderSettings(container);
  };
  container.onchange = (e) => {
    const sel = e.target.closest('.setting-select');
    if (sel) set(sel.dataset.key, Number(sel.value));
  };
}

function set(key, value) {
  ui.settings[key] = value;
  saveSetting(key, value).catch(() => {});
  apply();
}
