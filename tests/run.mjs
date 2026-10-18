// LONGHAUL test runner — `npm test` or `node tests/run.mjs [filter]`
// Each *.test.mjs default-exports an array of { name, fn } (fn may be async).
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();

let pass = 0, fail = 0;
for (const file of files) {
  const tests = (await import(pathToFileURL(path.join(dir, file)).href)).default;
  for (const t of tests) {
    const full = `${file.replace('.test.mjs', '')} › ${t.name}`;
    if (filter && !full.includes(filter)) continue;
    const t0 = performance.now();
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${full} (${(performance.now() - t0).toFixed(0)} ms)`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${full}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
