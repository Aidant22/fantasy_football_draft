/**
 * Minimal zero-dependency static server for the draft tracker.
 *
 * Security posture:
 *  - Binds to 127.0.0.1 only (never exposed to the local network).
 *  - Serves only files inside this directory, with an extension allowlist.
 *  - Rejects any path that escapes the root after resolution.
 *  - Sends a strict Content-Security-Policy so the page can only talk to
 *    the Sleeper API and load images from Sleeper's CDN.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '8123', 10);

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://sleepercdn.com",
  "connect-src 'self' https://api.sleeper.app",
  "font-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, securityHeaders(headers));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.includes('\0')) {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const filePath = path.resolve(ROOT, '.' + pathname);
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const type = TYPES.get(path.extname(filePath).toLowerCase());
  if (!type) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  try {
    // Resolve symlinks too, so a link inside the directory can't serve a file
    // outside it.
    const realPath = await fsp.realpath(filePath);
    const realRel = path.relative(await fsp.realpath(ROOT), realPath);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const stat = await fsp.stat(realPath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Content-Length': String(stat.size) }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(realPath).pipe(res);
  } catch {
    send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Draft tracker running at http://${HOST}:${PORT}\n`);
});
