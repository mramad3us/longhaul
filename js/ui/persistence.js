// ============================================================
// LONGHAUL — Saving & loading (UI side)
// ============================================================

import { ui } from './context.js';
import { esc } from './dom.js';
import { toast } from './toast.js';
import { putSave, getSave, listSaves, deleteSave } from '../storage.js';
import { serialize, deserialize } from '../sim/save.js';
import { formatStamp } from '../core/clock.js';
import { navStatus } from './hud.js';
import { iconDelete } from '../svg-icons.js';
import { VERSION } from '../version.js';

let autosaveTimer = null;
let saving = false;

export async function saveCurrent(name = 'Quicksave', id = null) {
  const s = ui.state;
  if (!s || saving) return null;
  saving = true;
  try {
    const record = await putSave({
      id: id || `save_${Date.now()}`,
      name,
      version: VERSION,
      meta: { ship: s.ship.name, date: formatStamp(s.clock), where: navStatus(s).chip, credits: Math.round(s.resources.credits.current) },
      data: serialize(s),
    });
    return record;
  } finally {
    saving = false;
  }
}

/** Real-time autosave, per the settings interval (minutes; 0 = off). */
export function scheduleAutosave() {
  clearInterval(autosaveTimer);
  const mins = ui.settings.autosaveMinutes;
  if (!mins) return;
  autosaveTimer = setInterval(async () => {
    if (!ui.state || ui.screen !== 'game') return;
    try { await saveCurrent('Autosave', 'autosave'); }
    catch (e) { console.error('[autosave]', e); toast('Autosave failed', 'warn'); }
  }, mins * 60_000);
}

export function stopAutosave() {
  clearInterval(autosaveTimer);
}

export async function loadSave(id) {
  const rec = await getSave(id);
  if (!rec) throw new Error('Save not found');
  return deserialize(rec.data ?? rec.state);
}

export async function latestSave() {
  const saves = await listSaves();
  return saves[0] || null;
}

/** Fill the load-game list. onLoad(id) is called when a save is picked. */
export async function renderSaveList(container, onLoad) {
  const saves = await listSaves();
  if (!saves.length) { container.innerHTML = '<p class="save-empty">No saved missions found.</p>'; return; }
  container.innerHTML = '';
  for (const s of saves) {
    const item = document.createElement('div');
    item.className = 'save-item';
    const real = new Date(s.timestamp);
    const meta = s.meta || {};
    item.innerHTML = `<div class="save-item-info">
        <span class="save-item-name">${esc(s.name)}${meta.legacy ? ' <span class="save-legacy">v0.7</span>' : ''}</span>
        <span class="save-item-meta">${esc(meta.ship || '—')} · ${esc(meta.date || '')} · ${esc(meta.where || '')}</span>
        <span class="save-item-meta">${real.toLocaleDateString()} ${real.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="save-item-actions"><button class="save-item-delete" title="Delete save" aria-label="Delete save"></button></div>`;
    item.addEventListener('click', (e) => { if (!e.target.closest('.save-item-delete')) onLoad(s.id); });
    const del = item.querySelector('.save-item-delete');
    del.appendChild(iconDelete());
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.classList.add('armed'); del.title = 'Click again to delete'; setTimeout(() => { del.dataset.armed = ''; del.classList.remove('armed'); }, 2500); return; }
      await deleteSave(s.id);
      toast('Save deleted');
      renderSaveList(container, onLoad);
    });
    container.appendChild(item);
  }
}
