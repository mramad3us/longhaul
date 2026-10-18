// ============================================================
// LONGHAUL — Toast notifications
// ============================================================

const MAX_VISIBLE = 5;
let _last = { text: '', at: 0 };

/** type: '' | 'ok' | 'warn' | 'danger' | 'info' | 'nav' | 'thrust' */
export function toast(text, type = '') {
  const box = document.getElementById('toast-container');
  if (!box) return;
  const now = performance.now();
  if (text === _last.text && now - _last.at < 1500) return;   // de-duplicate bursts
  _last = { text, at: now };
  const el = document.createElement('div');
  el.className = `toast${type ? ` toast-${type}` : ''}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > MAX_VISIBLE) box.firstChild.remove();
  setTimeout(() => el.remove(), 3400);
}
