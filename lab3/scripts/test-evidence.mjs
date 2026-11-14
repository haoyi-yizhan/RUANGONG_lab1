import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', 'tests/acceptance.test.mjs'],
  {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  },
);
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'evidence', 'tests.tap'), result.stdout || '');
writeFileSync(
  join(root, 'evidence', 'tests-environment.json'),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      completedAt: new Date().toISOString(),
      exitCode: result.status,
      stderr: result.stderr,
    },
    null,
    2,
  ),
);
console.log(result.stdout);
if (result.stderr) {
  console.error(result.stderr);
}
process.exitCode = result.status || (result.error ? 1 : 0);
