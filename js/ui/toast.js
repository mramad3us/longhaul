// ============================================================
// LONGHAUL — Messages: what just happened, for a few seconds
// The flight band's free end holds the latest two (css/console.css), so
// a message never covers the display or a panel; older ones are pushed
// out, and everything worth keeping is also in the log.
// ============================================================

const MAX_VISIBLE = 2, LIFE_MS = 4500;
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
  el.title = text;     // (the band may cut a long one short)
  setTimeout(() => el.remove(), LIFE_MS);
}
