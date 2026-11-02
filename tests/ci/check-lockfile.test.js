/**
 * @jest-environment node
 */
const { badUrls, toRegistry, nameOf } = require('../../scripts/check-lockfile.js');

const FEED = 'https://feed.example.com/_packaging/npm-public/npm/registry/';

test('only registry.npmjs.org URLs pass; links and the root entry are ignored', () => {
    const lock = {
        packages: {
            '': { name: 'app' },
            'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
            'node_modules/@s/b': { resolved: `${FEED}@s/b/-/b-2.0.0.tgz` },
            'node_modules/c': { resolved: 'https://registry.npmjs.org.evil.com/c/-/c-1.0.0.tgz' },
            'node_modules/local': { resolved: 'tools/local', link: true }
        }
    };
    expect(badUrls(lock).map(b => b.pkg)).toEqual(['node_modules/@s/b', 'node_modules/c']);
});

test('a mirror URL maps to the same tarball on the registry, scope kept', () => {
    expect(toRegistry(`${FEED}@ampproject/remapping/-/remapping-2.3.0.tgz`, '@ampproject/remapping'))
        .toBe('https://registry.npmjs.org/@ampproject/remapping/-/remapping-2.3.0.tgz');
    expect(toRegistry(`${FEED}acorn/-/acorn-8.15.0.tgz`, 'acorn')).toBe('https://registry.npmjs.org/acorn/-/acorn-8.15.0.tgz');
});

test('a URL that is not that package\'s registry tarball is left for a person to fix', () => {
    expect(toRegistry(`${FEED}acorn/-/acorn-8.15.0.tgz`, 'acorn-walk')).toBeNull();
    expect(toRegistry('git+ssh://git@github.com/x/y.git', 'y')).toBeNull();
    expect(toRegistry(`${FEED}acorn/-/other-1.0.0.tgz`, 'acorn')).toBeNull();
    expect(toRegistry(`${FEED}acorn/-/acorn-walk-8.0.0.tgz`, 'acorn', '8.0.0')).toBeNull();
    expect(toRegistry(`${FEED}acorn/-/acorn-8.0.0.tgz`, 'acorn', '8.1.0')).toBeNull();
});

test('a lockfile without a "packages" section (lockfileVersion 1) fails', () => {
    expect(badUrls({ lockfileVersion: 1, dependencies: {} })).toHaveLength(1);
});

test('package names come from the node_modules path, or the entry for an alias', () => {
    expect(nameOf('node_modules/a/node_modules/@s/b', {})).toBe('@s/b');
    expect(nameOf('node_modules/string-width-cjs', { name: 'string-width' })).toBe('string-width');
});
