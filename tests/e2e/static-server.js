/**
 * Minimal static file server for www/ (E2E only). Usage: node static-server.js <port>
 * Unknown paths fall back to index.html like Firebase Hosting's rewrite.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'www');
const PORT = Number(process.argv[2] || process.env.E2E_PORT || 8099);
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    // Firebase Hosting rewrite: /r/<token> -> r.html (tenant rent-history link).
    if (/^\/r\/[^/]+\/?$/.test(urlPath) && !fs.existsSync(file)) file = path.join(ROOT, 'r.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const index = path.join(file, 'index.html');
        file = fs.existsSync(index) ? index : path.join(ROOT, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`static www/ on http://127.0.0.1:${PORT}`));
