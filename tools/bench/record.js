#!/usr/bin/env node
/**
 * Records a multi-year benchmark result (#59; tests/bench/multi-year.spec.js) in the
 * trend file (CSV, one row per night, kept on the `bench-trend` branch by
 * .github/workflows/bench.yml) and warns, never fails, when a figure is over its
 * budget (tools/bench/budgets.json): a GitHub `::warning::` line and the job summary.
 *
 *   node tools/bench/record.js --result <bench-result.json> --trend <trend.csv> --budgets <budgets.json> [--sha <commit>]
 */
const fs = require('fs');

const COLUMNS = ['at', 'sha', 'docs', 'firstSignInMs', 'appShownMs', 'todayOpenMs', 'firstTodayMs', 'startupReads', 'historyLoadMs', 'historyReads', 'bills'];

/** One CSV row (no commas inside values). */
function trendRow(result, sha = '') {
    const v = { ...result, sha: String(sha).slice(0, 12), docs: result.dataset?.docs ?? '' };
    return COLUMNS.map(c => (v[c] === undefined || v[c] === null ? '' : String(v[c]).replace(/[,\n]/g, ' '))).join(',');
}

/** The trend text with `row` appended (header first when the file is new). */
function appendRow(existing, row) {
    const head = COLUMNS.join(',');
    const body = existing && existing.trim() ? existing.replace(/\n*$/, '\n') : `${head}\n`;
    return `${body}${row}\n`;
}

/** Unit of a figure in messages: ms for timings, none for counts (startupReads). */
const unit = (name) => (/Ms$/.test(name) ? ' ms' : '');

/** Figures over budget: [{name, value, budget}]. */
function overBudget(result, budgets) {
    return Object.entries(budgets || {})
        .filter(([k, b]) => !k.startsWith('_') && Number.isFinite(b) && Number.isFinite(result[k]) && result[k] > b)
        .map(([name, budget]) => ({ name, value: result[name], budget }));
}

/** Job summary: the last rows of the trend and any figure over budget. */
function summary(trend, over, last = 10) {
    const lines = trend.trim().split('\n');
    const [head, ...rows] = lines;
    const table = [head, ...rows.slice(-last)].map(l => `| ${l.split(',').join(' | ')} |`);
    table.splice(1, 0, `|${head.split(',').map(() => '---').join('|')}|`);
    const notes = over.length
        ? over.map(o => `- ⚠ ${o.name} ${o.value}${unit(o.name)} is over its budget of ${o.budget}${unit(o.name)}`)
        : ['- All figures within budget.'];
    return ['## Multi-year load benchmark (#59)', '', ...notes, '', ...table, ''].join('\n');
}

function arg(name, argv) {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
}

function main(argv = process.argv.slice(2), env = process.env) {
    const result = JSON.parse(fs.readFileSync(arg('result', argv), 'utf8'));
    const budgets = JSON.parse(fs.readFileSync(arg('budgets', argv), 'utf8'));
    const trendPath = arg('trend', argv);
    const existing = fs.existsSync(trendPath) ? fs.readFileSync(trendPath, 'utf8') : '';
    const trend = appendRow(existing, trendRow(result, arg('sha', argv) || env.GITHUB_SHA || ''));
    fs.writeFileSync(trendPath, trend);
    const over = overBudget(result, budgets);
    over.forEach(o => console.log(`::warning title=Benchmark over budget::${o.name} ${o.value}${unit(o.name)} > ${o.budget}${unit(o.name)} (#59)`));
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary(trend, over));
    console.log(`[bench] recorded in ${trendPath}${over.length ? `; over budget: ${over.map(o => o.name).join(', ')}` : ''}`);
}

module.exports = { COLUMNS, trendRow, appendRow, overBudget, summary, main };

if (require.main === module) main();
