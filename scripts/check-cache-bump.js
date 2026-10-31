#!/usr/bin/env node
/**
 * Cache-bump guard (#59): the service worker serves cached files without asking
 * the network, so a PR that changes a shipped www/ file must change CACHE_NAME,
 * BUILD_ID and the index.html ?v= token, or phones keep the old files.
 *
 *   node scripts/check-cache-bump.js <base-ref>    # e.g. origin/main (CI, pull requests)
 */
const { execFileSync } = require('child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** Shipped files: everything under www/ except the Jest tests. */
const isShipped = (file) => file.startsWith('www/') && !file.includes('/__tests__/') && !file.endsWith('.md');

function stamps({ sw, main, html }) {
    return {
        cacheName: (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1] || null,
        buildId: (main.match(/const BUILD_ID = '([^']+)'/) || [])[1] || null,
        tokens: [...new Set([...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]))]
    };
}

/**
 * @param {string[]} changed changed paths
 * @param {{cacheName, buildId, tokens}} before
 * @param {{cacheName, buildId, tokens}} after
 * @returns {string[]} problems
 */
function bumpProblems(changed, before, after) {
    if (!changed.some(isShipped)) return [];
    const problems = [];
    if (after.cacheName === before.cacheName) problems.push(`CACHE_NAME is still '${after.cacheName}' in www/service-worker.js`);
    if (after.buildId === before.buildId) problems.push(`BUILD_ID is still '${after.buildId}' in www/js/main.js`);
    if (after.tokens.length !== 1) problems.push(`www/index.html must use one ?v= token, found ${after.tokens.join(', ') || 'none'}`);
    else if (before.tokens.includes(after.tokens[0])) problems.push(`the ?v= token is still '${after.tokens[0]}' in www/index.html`);
    return problems;
}

function read(ref, file) {
    return ref ? git('show', `${ref}:${file}`) : require('fs').readFileSync(file, 'utf8');
}

const FILES = { sw: 'www/service-worker.js', main: 'www/js/main.js', html: 'www/index.html' };
const load = (ref) => stamps(Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(ref, f)])));

module.exports = { bumpProblems, stamps, isShipped };

if (require.main === module) {
    const base = process.argv[2];
    if (!base) {
        console.error('Usage: node scripts/check-cache-bump.js <base-ref>');
        process.exit(2);
    }
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const problems = bumpProblems(changed, load(base), load(null));
    if (problems.length) {
        console.error('This PR changes shipped files under www/ but does not bump the cache (AGENTS.md section 4):\n  ' + problems.join('\n  '));
        process.exit(1);
    }
    console.log(changed.some(isShipped) ? 'OK: cache bumped.' : 'OK: no shipped www/ file changed.');
}
