/**
 * Minimal static server for previewing the widget locally.
 *
 *   node scripts/serve.mjs   ->   http://localhost:4173
 *
 * Opening index.html straight from disk does not work: the widget fetches
 * data.json, and file:// requests are blocked by CORS.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const target = path.join(ROOT, url === '/' ? 'index.html' : url);

    if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
    }

    res.writeHead(200, {
        'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
