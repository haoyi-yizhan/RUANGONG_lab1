import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
let failures = 0;
for (const directory of ['src', 'public', 'scripts', 'tests']) {
  for (const entry of readdirSync(join(root, directory), { recursive: true })) {
    if (!/\.(mjs|js)$/u.test(entry)) continue;
    const filename = join(root, directory, entry);
    const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(result.stderr);
      failures += 1;
    }
    const lines = readFileSync(filename, 'utf8').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (/\t| +$/u.test(line)) {
        console.error(`${directory}/${entry}:${index + 1}: tab or trailing whitespace`);
        failures += 1;
      }
    }
    checked += 1;
  }
}
console.log(`Checked ${checked} JavaScript files: syntax, no tabs, no trailing whitespace. Failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
