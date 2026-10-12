// Packs handoff pay into one self-contained page, dist/index.html, for publishing as a handoff miniapp.
// The store inlines a <script src> as a classic script, so ES module imports would not run there. Each module
// becomes a function scope that returns its exports; nothing is renamed or minified. No dependencies.
//   node scripts/build-miniapp.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['lib.js', 'api.js', 'app.js']; // dependency order: each module imports only from earlier ones

function packModule(file) {
  let src = readFileSync(join(root, file), 'utf8');
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+)';?/gm, (m, names, dep) => {
    if (!ORDER.includes(dep) || ORDER.indexOf(dep) >= ORDER.indexOf(file)) throw new Error(`${file}: unexpected import of ${dep}`);
    if (/\bas\b/.test(names)) throw new Error(`${file}: renamed imports are not supported`);
    return `const {${names}} = __mods[${JSON.stringify(dep)}];`;
  });
  if (/^\s*import\b/m.test(src)) throw new Error(`${file}: an import this script does not handle`);
  const exported = [];
  src = src.replace(/^export\s+(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*export\b/m.test(src)) throw new Error(`${file}: an export this script does not handle`);
  return `__mods[${JSON.stringify(file)}] = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

const js = `'use strict';\nconst __mods = {};\n${ORDER.map(packModule).join('\n')}`;
if (/<\/script/i.test(js)) throw new Error('bundle contains </script');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const tag = '<script type="module" src="app.js"></script>';
if (!html.includes(tag)) throw new Error('index.html: module script tag not found');
const out = html.replace(tag, () => `<script>\n${js}</script>`);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), out);
console.log(`dist/index.html ${out.length} bytes sha256 ${createHash('sha256').update(out).digest('hex').slice(0, 16)}`);
