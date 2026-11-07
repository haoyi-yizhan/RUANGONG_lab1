import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensions = new Set(['.js', '.mjs', '.cjs', '.html', '.css']);
async function files(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : extensions.has(extname(entry.name)) ? [join(dir, entry.name)] : []));
  return nested.flat();
}
function count(source) {
  let block = false, html = false, total = 0;
  for (const line of source.split(/\r?\n/)) {
    let text = line.trim();
    while (text) {
      if (block || html) {
        const marker = html ? '-->' : '*/';
        const end = text.indexOf(marker);
        if (end < 0) { text = ''; break; }
        text = text.slice(end + marker.length).trim(); block = html = false;
      } else if (text.startsWith('//')) { text = ''; break; }
      else if (text.startsWith('/*')) { block = true; text = text.slice(2); }
      else if (text.startsWith('<!--')) { html = true; text = text.slice(4); }
      else { total++; break; }
    }
  }
  return total;
}
let total = 0, applicationJavaScript = 0;
const counts = [];
for (const file of (await Promise.all(['src', 'public'].map(dir => files(join(root, dir))))).flat().sort()) {
  const lines = count(await readFile(file, 'utf8')); total += lines;
  if (['.js', '.mjs', '.cjs'].includes(extname(file))) applicationJavaScript += lines;
  counts.push({ file: relative(root, file).replaceAll('\\', '/'), lines });
  console.log(`${String(lines).padStart(6)}  ${relative(root, file)}`);
}
console.log(`${String(total).padStart(6)}  total`);
console.log(`${String(applicationJavaScript).padStart(6)}  application JavaScript`);
await mkdir(join(root, 'evidence'), { recursive: true });
await writeFile(join(root, 'evidence', 'code-lines.json'), `${JSON.stringify({ timestamp: new Date().toISOString(), method: 'Approximate nonblank, non-comment-only lines in handwritten src and public files; JavaScript total excludes HTML and CSS. Comment detection is heuristic.', applicationJavaScript, total, files: counts }, null, 2)}\n`);
