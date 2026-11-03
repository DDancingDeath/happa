const fs = require('fs');
const path = require('path');

// `npm run typecheck` checks only files that start with `// @ts-check` (#71). Every
// www/js/utils file is checked except these; take a file off the list when it is.
const NOT_YET = [
    'aging.js', 'anomalies.js', 'ask.js', 'audit-changes.js', 'backup-verify.js', 'bill-checks.js', 'bill-edits.js',
    'bill-share.js', 'business-metrics.js', 'cash-session.js', 'dead-stock.js', 'due-payments.js', 'error-report.js',
    'finance-breakdown.js', 'finance-calc.js', 'history-filters.js', 'history-window.js', 'insights-config.js',
    'item-catalog.js', 'item-name-autofill.js', 'item-rate-series.js', 'keyboard-shortcuts.js', 'manual-reminders.js',
    'month-snapshots.js', 'notification-format.js', 'number-checks.js', 'perf-probe.js', 'personal-expenses.js',
    'printer-settings.js', 'product-traffic.js', 'qr-code.js', 'quota-guard.js', 'rate-history.js', 'rate-trends.js',
    'release-info.js', 'reminders.js', 'role-access.js', 'saved-ranges.js', 'security-flags.js', 'startup-timings.js',
    'statements.js', 'stock-adjust.js', 'stock-check.js', 'stock-replay.js', 'takeaways.js', 'user-activity.js',
    'validator.js', 'voice-parse.js'
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