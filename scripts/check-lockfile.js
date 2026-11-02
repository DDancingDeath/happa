#!/usr/bin/env node
/**
 * Every package in the committed lockfiles must come from the public npm registry: a mirror or
 * private feed URL (left by an `npm install` behind a corporate .npmrc) leaks the feed's address
 * into this public repo and can break `npm ci` for anyone without access to it.
 *   node scripts/check-lockfile.js          fail on a "resolved" URL not on registry.npmjs.org
 *   node scripts/check-lockfile.js --fix    rewrite npm-registry mirror URLs to registry.npmjs.org
 * --fix only touches URLs whose path is the npm registry layout (<name>/-/<file>.tgz); the
 * integrity hashes stay as they are, so `npm ci` still verifies the same tarballs.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = 'https://registry.npmjs.org/';

function lockfiles(root = ROOT) {
    return execFileSync('git', ['ls-files', '*package-lock.json', '*npm-shrinkwrap.json'], { cwd: root, encoding: 'utf8' })
        .split('\n').filter(Boolean);
}

/** @returns {{pkg: string, url: string}[]} resolved URLs not on the public registry */
function badUrls(lock) {
    return Object.entries(lock.packages || {}).flatMap(([pkg, info]) =>
        info && typeof info.resolved === 'string' && !info.resolved.startsWith(REGISTRY) && !info.link
            ? [{ pkg, url: info.resolved }] : []);
}

/**
 * A mirror URL of a registry tarball -> the same tarball on registry.npmjs.org, or null.
 * @param {string} url
 * @param {string} [name] the package's name: the tarball path must be that package's
 */
function toRegistry(url, name) {
    const m = /\/((@[^/]+\/)?([^/@]+))\/-\/([^/]+\.tgz)$/.exec(url);
    if (!m || !/^https?:\/\//.test(url)) return null;
    if (name && m[1] !== name) return null;
    if (!m[4].startsWith(`${m[3]}-`)) return null;
    return `${REGISTRY}${m[1]}/-/${m[4]}`;
}

/** node_modules/a/node_modules/@s/b -> @s/b (an aliased entry says its own name) */
const nameOf = (pkg, info) => info.name || pkg.slice(pkg.lastIndexOf('node_modules/') + 'node_modules/'.length);

function main(argv) {
    const fix = argv.includes('--fix');
    let problems = 0;
    for (const rel of lockfiles()) {
        const file = path.join(ROOT, rel);
        let text = fs.readFileSync(file, 'utf8');
        const bad = badUrls(JSON.parse(text));
        if (fix && bad.length) {
            const lock = JSON.parse(text);
            for (const { pkg, url } of bad) {
                const to = toRegistry(url, nameOf(pkg, lock.packages[pkg]));
                if (to) text = text.split(JSON.stringify(url)).join(JSON.stringify(to));
            }
            fs.writeFileSync(file, text);
            console.log(`${rel}: rewrote ${bad.length - badUrls(JSON.parse(text)).length} URL(s)`);
        }
        const left = badUrls(JSON.parse(text));
        left.slice(0, 10).forEach(({ pkg, url }) => console.error(`${rel}: ${pkg} resolved from ${url}`));
        if (left.length > 10) console.error(`${rel}: … and ${left.length - 10} more`);
        problems += left.length;
    }
    if (problems) {
        console.error(`${problems} package(s) not resolved from ${REGISTRY}. Run: node scripts/check-lockfile.js --fix`);
        return 1;
    }
    console.log(`OK: every lockfile resolves from ${REGISTRY}`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { badUrls, toRegistry, nameOf };
