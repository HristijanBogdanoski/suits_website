#!/usr/bin/env node
// Inlines the bundled viewer and the compressed model into one self-contained
// HTML file. Nothing is fetched at runtime — that is what lets the page work
// inside a sandboxed embed. See CLAUDE.md, "The CSP trap".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => resolve(root, ...s);
const OUT = 'build/vestra-3d.html';

const html = readFileSync(p('viewer/index.html'), 'utf8');
const js = readFileSync(p('viewer/viewer.js'), 'utf8');
const b64 = readFileSync(p('viewer/model/BlackSuit.web.glb')).toString('base64');

const tag = '<script src="viewer.js"></script>';
if (!html.includes(tag)) throw new Error(`viewer/index.html is missing ${tag}`);

// A function replacer is required, not a string: minified JS contains "$&"
// sequences, which String.replace would expand back into the matched tag.
const payload = `<script>window.__MODEL_B64="${b64}";</script>\n<script>\n${js}\n</script>`;
const out = html.replace(tag, () => payload);

if (!out.includes('__MODEL_B64')) throw new Error('model failed to inline');
if (out.includes('src="viewer.js"')) throw new Error('external script reference survived');

mkdirSync(p('build'), { recursive: true });
writeFileSync(p(OUT), out);

const mb = Buffer.byteLength(out) / 1024 / 1024;
console.log(`${OUT} — ${mb.toFixed(2)} MB`);
if (mb > 15) throw new Error(`${mb.toFixed(2)} MB exceeds the 16 MB artifact limit`);
