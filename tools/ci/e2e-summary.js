#!/usr/bin/env node
/**
 * Markdown summary of a (merged) Playwright JSON report for the GitHub job summary:
 * totals, flaky tests (passed on retry) with their first error, failed tests, and
 * the Firestore reads per page from the every-page smoke against their baselines
 * (tests/e2e/read-baselines.json).
 *   node tools/ci/e2e-summary.js e2e-results.json >> "$GITHUB_STEP_SUMMARY"
 */
const fs = require('fs');
const path = require('path');
const { limitFor } = require('../../tests/e2e/support/read-budget.js');

const firstLine = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find(l => l.trim()) || '';
const fmtMs = (ms) => `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

/** Every test of the report: { name, project, status, results, annotations }. */
function collectTests(report) {
    const out = [];
    const walk = (suite, trail) => {
        const here = suite.title ? [...trail, suite.title] : trail;
        for (const spec of suite.specs || []) {
            for (const t of spec.tests || []) {
                const results = t.results || [];
                const annotations = [...(t.annotations || []), ...results.flatMap(r => r.annotations || [])];
                out.push({ name: [...here, spec.title].join(' › '), project: t.projectName, status: t.status, results, annotations });
            }
        }
        for (const s of suite.suites || []) walk(s, here);
    };
    for (const s of report.suites || []) walk(s, []);
    return out;
}

/** Highest reads seen per role and page, from the "reads" annotations. */
function readsByRole(tests) {
    const by = {};
    for (const t of tests) {
        for (const a of t.annotations) {
            if (a.type !== 'reads') continue;
            let v;
            try { v = JSON.parse(a.description); } catch { continue; }
            const r = by[v.role] = by[v.role] || {};
            for (const [pg, n] of Object.entries(v.reads || {})) r[pg] = Math.max(r[pg] ?? 0, n);
        }
    }
    return by;
}

function summarize(report, baselines) {
    const tests = collectTests(report);
    const count = (st) => tests.filter(t => t.status === st).length;
    const passed = count('expected');
    const flaky = tests.filter(t => t.status === 'flaky');
    const failed = tests.filter(t => t.status === 'unexpected');
    const skipped = count('skipped');
    const lines = ['## Playwright E2E', ''];
    const ms = report.stats?.duration;
    lines.push(`**${passed} passed** · ${flaky.length} flaky · ${failed.length} failed · ${skipped} skipped` +
        (ms ? ` · test time ${fmtMs(ms)}` : ''), '');
    const describe = (t) => {
        const bad = t.results.find(r => r.status !== 'passed' && r.status !== 'skipped');
        const err = firstLine(bad?.error?.message || bad?.errors?.[0]?.message);
        return `- \`[${t.project}]\` ${t.name}${err ? ` — ${err.slice(0, 200)}` : ''}`;
    };
    if (flaky.length) lines.push('### Flaky (failed, then passed on retry)', '', ...flaky.map(describe), '');
    if (failed.length) lines.push('### Failed', '', ...failed.map(describe), '');

    const reads = readsByRole(tests);
    const roles = Object.keys(reads);
    if (roles.length && baselines) {
        const pages = [...new Set(roles.flatMap(r => Object.keys(reads[r])))];
        lines.push('### Firestore reads per page (first open, highest seen)', '',
            `Cell: reads / baseline. Limit = baseline + ${Math.round(baselines.tolerance * 100)}% (at least +${baselines.minSlack || 0}), at most ${baselines.hardCap}.`, '',
            `| Page | ${roles.join(' | ')} |`, `|---|${roles.map(() => '---:').join('|')}|`);
        for (const pg of pages) {
            const cells = roles.map(r => {
                const n = reads[r][pg];
                if (n === undefined) return '';
                const b = baselines.reads?.[r]?.[pg];
                if (b === undefined) return `${n} / — ⚠️`;
                return `${n} / ${b}${n > limitFor(b, baselines) ? ' ⚠️' : ''}`;
            });
            lines.push(`| ${pg} | ${cells.join(' | ')} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

if (require.main === module) {
    const file = process.argv[2] || 'e2e-results.json';
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const baselines = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'e2e', 'read-baselines.json'), 'utf8'));
    process.stdout.write(summarize(report, baselines) + '\n');
}

module.exports = { collectTests, readsByRole, summarize };
