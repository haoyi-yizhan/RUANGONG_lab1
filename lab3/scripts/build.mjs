import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = spawnSync(process.execPath, [join(root, 'scripts/check.mjs')], { stdio: 'inherit' });
if (check.status !== 0) {
  process.exit(check.status || 1);
}
// Versioned destinations preserve previous builds and avoid recursive deletion.
const output = join(root, 'dist', `ticketing-${Date.now()}`);
mkdirSync(output, { recursive: true });
for (const name of [
  'src',
  'public',
  'scripts',
  'tests',
  'package.json',
  'package-lock.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  'README.md',
]) {
  const source = join(root, name);
  if (existsSync(source)) {
    cpSync(source, join(output, name), { recursive: true });
  }
}
writeFileSync(
  join(output, 'BUILD.json'),
  JSON.stringify(
    {
      node: process.version,
      builtAt: new Date().toISOString(),
      sourceFiles: readdirSync(join(root, 'src')).length,
      package: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    },
    null,
    2,
  ),
);
console.log(`Build ready: ${output}`);
