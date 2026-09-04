#!/usr/bin/env node
// Serves build/ behind a CSP that mirrors the sandboxed-embed environment.
// The permissive local server will happily run a page that the real sandbox
// blocks, so test here before publishing. See CLAUDE.md, "The CSP trap".

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: blob:",
  "connect-src 'none'",
  "worker-src blob:",
].join('; ');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const PORT = 8790;

createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'vestra-3d.html';
  const file = resolve(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
    }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, () => console.log(`strict-CSP server → http://localhost:${PORT}/vestra-3d.html`));
