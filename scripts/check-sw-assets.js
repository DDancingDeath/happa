#!/usr/bin/env node
/**
 * Verifies the service worker's STATIC_ASSETS precache list against www/.
 *
 *   node scripts/check-sw-assets.js          # check (exit 1 on problems)
 *   node scripts/check-sw-assets.js --print  # print the expected list
 *
 * Fails if any entry does not exist on disk (a 404 during precache used to make
 * cache.addAll reject, silently disabling offline caching) or if an app file
 * (js/css/templates/img/icons/vendor, download.html, changelog.json, manifest) is missing from the list.
 * Files in LAZY_ASSETS (loaded with import() on use, cached at runtime) must exist
 * and must not be precached.
 */
const fs = require('fs');
const path = require('path');
const { cssSources } = require('./build-css.js');

const WWW = path.join(__dirname, '..', 'www');
const SW_PATH = path.join(WWW, 'service-worker.js');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return [full];
    });
}

function toUrl(file) {
    return '/' + path.relative(WWW, file).split(path.sep).join('/');
}

function expectedAssets() {
    // The stylesheets joined into css/app.css (scripts/build-css.js) are not loaded on their own.
    const joined = new Set(cssSources().map((rel) => '/' + rel));
    const files = [
        ...walk(path.join(WWW, 'js')).filter((f) => f.endsWith('.js')),
        ...walk(path.join(WWW, 'css')).filter((f) => f.endsWith('.css')),
        ...walk(path.join(WWW, 'templates')).filter((f) => f.endsWith('.html')),
        ...(fs.existsSync(path.join(WWW, 'img')) ? walk(path.join(WWW, 'img')) : []),
        ...walk(path.join(WWW, 'icons')).filter((f) => f.endsWith('.png')),
        ...(fs.existsSync(path.join(WWW, 'vendor')) ? walk(path.join(WWW, 'vendor')).filter((f) => f.endsWith('.js')) : []),
    ].map(toUrl).filter((u) => !joined.has(u)).sort();
    return [
        '/', '/index.html', '/firebaseConfig.js', '/download.html', '/changelog.json', '/manifest.webmanifest',
        ...files,
    ];
}

function readList(name, source = fs.readFileSync(SW_PATH, 'utf8')) {
    const match = source.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!match) throw new Error(`${name} array not found in service-worker.js`);
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const readStaticAssets = (source) => readList('STATIC_ASSETS', source);
const readLazyAssets = (source) => readList('LAZY_ASSETS', source);

function existsOnDisk(url) {
    if (url === '/') return fs.existsSync(path.join(WWW, 'index.html'));
    const rel = url.split('?')[0].replace(/^\//, '');
    const full = path.join(WWW, rel);
    return fs.existsSync(full) && fs.statSync(full).isFile();
}

function check() {
    const listed = readStaticAssets();
    const lazy = readLazyAssets();
    const all = [...listed, ...lazy];
    const missingOnDisk = all.filter((u) => !existsOnDisk(u));
    const notListed = expectedAssets().filter((u) => !all.includes(u));
    const duplicates = all.filter((u, i) => all.indexOf(u) !== i);
    return { listed, lazy, missingOnDisk, notListed, duplicates };
}

module.exports = { expectedAssets, readStaticAssets, readLazyAssets, existsOnDisk, check };

if (require.main === module) {
    if (process.argv.includes('--print')) {
        const lazy = readLazyAssets();
        console.log(expectedAssets().filter((u) => !lazy.includes(u)).map((u) => `    '${u}',`).join('\n'));
        process.exit(0);
    }
    const { listed, lazy, missingOnDisk, notListed, duplicates } = check();
    let ok = true;
    if (missingOnDisk.length) {
        ok = false;
        console.error('STATIC_ASSETS entries missing on disk (would 404):\n  ' + missingOnDisk.join('\n  '));
    }
    if (notListed.length) {
        ok = false;
        console.error('App files in neither STATIC_ASSETS nor LAZY_ASSETS:\n  ' + notListed.join('\n  '));
    }
    if (duplicates.length) {
        ok = false;
        console.error('Duplicate (or both precached and lazy) entries:\n  ' + duplicates.join('\n  '));
    }
    if (ok) console.log(`OK: ${listed.length} STATIC_ASSETS + ${lazy.length} LAZY_ASSETS entries, all present on disk.`);
    process.exit(ok ? 0 : 1);
}
