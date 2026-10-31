/**
 * Minimal static file server for www/ (E2E only).
 *   node static-server.js <port> [--project demo-<name> --auth-port <n> --firestore-port <n>]
 * Unknown paths fall back to index.html like Firebase Hosting's rewrite.
 * With --project, www/firebaseConfig.js and www/r/rent-history.js are served
 * rewritten to that demo project and those emulator ports (support/emulator-target.js),
 * so the committed files keep their defaults.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { target, servedText, REWRITTEN } = require('./support/emulator-target');

const ROOT = path.resolve(__dirname, '..', '..', 'www');
const args = process.argv.slice(2);
const opt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
};
const PORT = Number(args[0] || process.env.E2E_PORT || 8099);
const EMU = opt('--project') ? target({ project: opt('--project'), authPort: Number(opt('--auth-port') || 9099), firestorePort: Number(opt('--firestore-port') || 8181) }) : null;

// The app site's '**' security headers from firebase.json (#89), so every E2E page runs
// under the same report-only CSP as Hosting; the fixture fails on any CSP report.
// The auth emulator stands in for the API hosts and the authDomain iframe only here.
function securityHeaders() {
    const hosting = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', 'firebase.json'), 'utf8')).hosting;
    const app = (Array.isArray(hosting) ? hosting : [hosting]).find((h) => h.public === 'www');
    const all = (app.headers || []).filter((e) => e.source === '**').flatMap((e) => e.headers);
    const out = {};
    for (const { key, value } of all) {
        if (key === 'Strict-Transport-Security') continue;
        out[key] = (key === 'Content-Security-Policy-Report-Only' && EMU)
            ? value
                .replace(/connect-src ([^;]*)/, `connect-src $1 http://127.0.0.1:${EMU.authPort} http://127.0.0.1:${EMU.firestorePort}`)
                .replace(/frame-src ([^;]*)/, `frame-src $1 http://127.0.0.1:${EMU.authPort}`)
            : value;
    }
    return out;
}
const SECURITY = securityHeaders();
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    // Firebase Hosting rewrites: /r/<token> -> r.html (tenant rent-history link), /download -> download.html.
    if (/^\/r\/[^/]+\/?$/.test(urlPath) && !fs.existsSync(file)) file = path.join(ROOT, 'r.html');
    if (urlPath === '/download') file = path.join(ROOT, 'download.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const index = path.join(file, 'index.html');
        file = fs.existsSync(index) ? index : path.join(ROOT, 'index.html');
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (EMU && REWRITTEN.includes(rel)) {
        let text;
        try {
            text = servedText(rel, fs.readFileSync(file, 'utf8'), EMU);
        } catch (e) {
            console.error(String(e.message || e));
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(String(e.message || e));
            return;
        }
        res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(text);
        return;
    }
    res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`static www/ on http://127.0.0.1:${PORT}${EMU ? ` (emulators: ${EMU.project}, auth ${EMU.authPort}, firestore ${EMU.firestorePort})` : ''}`));