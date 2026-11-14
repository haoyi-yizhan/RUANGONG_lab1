import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2] || 'final';
if (!['baseline', 'final'].includes(stage)) {
  throw new Error('Stage must be baseline or final');
}
const eslint = new ESLint({ cwd: root });
const targets = ['src/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'public/**/*.js', '*.mjs'];
const results = await eslint.lintFiles(targets);
const formatter = await eslint.loadFormatter('json');
const files = [];
for (const directory of ['src', 'scripts', 'tests', 'public']) {
  for (const entry of await readdir(join(root, directory), { recursive: true })) {
    if (/\.(?:mjs|js|html|css)$/u.test(entry)) {
      files.push(join(root, directory, entry));
    }
  }
}
files.push(
  join(root, 'eslint.config.mjs'),
  join(root, '.prettierrc.json'),
  join(root, 'package.json'),
);
const formatting = [];
for (const filename of files.sort()) {
  const source = await readFile(filename, 'utf8');
  const options = await prettier.resolveConfig(filename);
  formatting.push({
    file: relative(root, filename).replaceAll('\\', '/'),
    passed: await prettier.check(source, { ...options, filepath: filename }),
    sha256: createHash('sha256').update(source).digest('hex'),
  });
}
const summary = {
  stage,
  completedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform },
  tools: { eslint: ESLint.version, prettier: prettier.version },
  eslint: {
    files: results.length,
    errors: results.reduce((sum, result) => sum + result.errorCount, 0),
    warnings: results.reduce((sum, result) => sum + result.warningCount, 0),
    fixableErrors: results.reduce((sum, result) => sum + result.fixableErrorCount, 0),
    fixableWarnings: results.reduce((sum, result) => sum + result.fixableWarningCount, 0),
  },
  prettier: {
    files: formatting.length,
    failures: formatting.filter((result) => !result.passed).length,
  },
  formatting,
};
summary.passed =
  summary.eslint.errors === 0 && summary.eslint.warnings === 0 && summary.prettier.failures === 0;
const destination = join(root, 'evidence', 'style');
await mkdir(destination, { recursive: true });
await writeFile(join(destination, `${stage}-eslint.json`), formatter.format(results));
await writeFile(
  join(destination, `${stage}-summary.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
const output = [
  `Stage: ${stage}`,
  `Time: ${summary.completedAt}`,
  `Node.js: ${process.version}; ESLint: ${ESLint.version}; Prettier: ${prettier.version}`,
  `ESLint: ${summary.eslint.files} files, ${summary.eslint.errors} errors, ${summary.eslint.warnings} warnings`,
  `Prettier: ${summary.prettier.files} files, ${summary.prettier.failures} formatting failures`,
  `Passed: ${summary.passed}`,
].join('\n');
await writeFile(join(destination, `${stage}-summary.txt`), `${output}\n`);
console.log(output);
if (stage === 'final' && !summary.passed) {
  process.exitCode = 1;
}
