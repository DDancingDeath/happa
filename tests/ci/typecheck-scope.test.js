const fs = require('fs');
const path = require('path');

// `npm run typecheck` checks only files that start with `// @ts-check` (#71). Every
// www/js/utils file is checked except these; take a file off the list when it is.
const NOT_YET = [
    'anomalies.js', 'bill-checks.js', 'month-snapshots.js', 'number-checks.js', 'product-traffic.js', 'qr-code.js',
    'rate-trends.js', 'statements.js'
];
const UTILS = 'www/js/utils';

test('every www/js/utils file not listed as not yet is type-checked, and the list holds no checked file', () => {
    const root = path.join(__dirname, '..', '..');
    const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
    const files = walk(UTILS);
    const checked = (f) => fs.readFileSync(path.join(root, f), 'utf8').startsWith('// @ts-check');
    const pending = new Set(NOT_YET.map((f) => `${UTILS}/${f}`));
    expect(files.length).toBeGreaterThan(80);
    expect(files.filter((f) => !pending.has(f) && !checked(f))).toEqual([]);
    expect([...pending].filter((f) => !files.includes(f) || checked(f))).toEqual([]);
});