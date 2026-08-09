#!/usr/bin/env node
/**
 * Local preview server for the site.
 *
 * Serves web/public and answers /api/tailor by loading the same handler Vercel
 * runs in production, so the whole flow can be exercised before deploying.
 * Set GEMINI_API_KEY in your shell to test resume tailoring locally.
 *
 *   node web/serve.js          →  http://localhost:4321
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'public');
const PORT = Number(process.env.PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // The company logos in public/logos and the og: card are all .jpg. Without these
  // they fell through to application/octet-stream, which the browser will not paint.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

/** Minimal shim so the Vercel-style handler runs unchanged here. */
function shimResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/tailor') {
    try {
      const { default: handler } = await import('./api/tailor.js');
      req.body = await readBody(req);
      return handler(req, shimResponse(res));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: `Local handler failed: ${err.message}` }));
    }
  }

  // Static files, with a traversal guard.
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  // vercel.json sets cleanUrls, so production serves /jobs/foo from jobs/foo.html.
  // Without the same fallback here, every generated page 404s locally and the only
  // way to check them would be to deploy first.
  const candidates = extname(path) ? [path] : [path, `${path}.html`, join(path, 'index.html')];

  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      res.setHeader('content-type', TYPES[extname(candidate)] ?? 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      return res.end(body);
    } catch {
      // try the next shape
    }
  }

  res.statusCode = 404;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<h1>404</h1>');
});

server.listen(PORT, () => {
  console.log(`Internzo preview → http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY is not set — resume tailoring will return an error until it is.');
  }
});
