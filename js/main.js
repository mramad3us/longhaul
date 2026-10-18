// LONGHAUL — entry point
import { boot } from './ui/app.js';

boot().catch((e) => {
  console.error('[LONGHAUL] boot failed', e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#E25555;padding:20px;font:12px monospace">LONGHAUL failed to start:\n${String(e.stack || e)}</pre>`);
});
