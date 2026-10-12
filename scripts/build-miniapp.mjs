// Packs each page into one self-contained file for publishing as a handoff miniapp: handoff pay as dist/index.html,
// handoff capital as dist/capital/ (index.html and the components.json that names impecc/lol-kit-style, whose
// stylesheet the store links by hash at load; lol-kit-style.css here is a development copy and is not published).
// The store inlines a <script src> as a classic script, so ES module imports would not run there. Each module
// becomes a function scope that returns its exports; nothing is renamed or minified. No dependencies.
//   node scripts/build-miniapp.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function packModule(file, ORDER) {
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

// Each page: its module script tag, and its modules in dependency order (each imports only from earlier ones).
const PAGES = [
  { html: 'index.html', script: 'app.js', order: ['lib.js', 'api.js', 'app.js'], out: 'dist/index.html' },
  {
    html: 'capital.html', script: 'capital-app.js', order: ['lib.js', 'api.js', 'capital-lib.js', 'capital-app.js'], out: 'dist/capital/index.html',
    extra: { 'components.json': `${JSON.stringify({ components: ['impecc/lol-kit-style'] })}\n` },
  },
];

for (const page of PAGES) {
  const js = `'use strict';\nconst __mods = {};\n${page.order.map((f) => packModule(f, page.order)).join('\n')}`;
  if (/<\/script/i.test(js)) throw new Error(`${page.html}: bundle contains </script`);
  const html = readFileSync(join(root, page.html), 'utf8');
  const tag = `<script type="module" src="${page.script}"></script>`;
  if (!html.includes(tag)) throw new Error(`${page.html}: module script tag not found`);
  const out = html.replace(tag, () => `<script>\n${js}</script>`);
  const dir = dirname(join(root, page.out));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, page.out), out);
  for (const [name, body] of Object.entries(page.extra || {})) writeFileSync(join(dir, name), body);
  console.log(`${page.out} ${out.length} bytes sha256 ${createHash('sha256').update(out).digest('hex').slice(0, 16)}`);
}
