#!/usr/bin/env node
/**
 * Records a multi-year benchmark result (#59; tests/bench/multi-year.spec.js) in the
 * trend file (CSV, one row per night, kept on the `bench-trend` branch by
 * .github/workflows/bench.yml). Over its budget (tools/bench/budgets.json) a figure only
 * warns. Over its hard limit (budgets.json `_gate`, #120: a multiple of the budget or of
 * the median of the previous rows) on this run AND the previous one, it is a regression:
 * `regressed=true` in $GITHUB_OUTPUT (bench.yml fails the job after pushing the trend),
 * or exit code 1 outside GitHub Actions.
 *
 *   node tools/bench/record.js --result <bench-result.json> --trend <trend.csv> --budgets <budgets.json> [--sha <commit>] [--simulate-slowdown <x>]
 *
 * --simulate-slowdown (gate self-test, never on the live trend): multiplies the timings
 * of this result and of the trend's last row by x.
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

const DEFAULT_GATE = { budgetRatio: 1.5, trendRatio: 1.5, trendWindow: 7, trendMinRows: 5, consecutive: 2 };

/** Trend text → [{column: value}] (numbers where they parse, else null). */
function parseTrend(text) {
    const [head, ...rows] = (text || '').trim().split(/\r?\n/).filter(Boolean);
    if (!head) return [];
    const cols = head.split(',');
    return rows.map((line) => {
        const cells = line.split(',');
        return Object.fromEntries(cols.map((c, i) => {
            const v = cells[i];
            return [c, v === undefined || v.trim() === '' || !Number.isFinite(Number(v)) ? (v || null) : Number(v)];
        }));
    });
}

function median(values) {
    const v = [...values].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Hard-limit breaches of row `i` of `rows`: [{name, value, limit, why}]. The limit is the
 * lower of budget × budgetRatio and, with at least trendMinRows earlier values in the
 * last trendWindow rows, their median × trendRatio.
 */
function breaches(rows, i, budgets, gate = DEFAULT_GATE) {
    const g = { ...DEFAULT_GATE, ...gate };
    const row = rows[i] || {};
    const out = [];
    for (const [name, budget] of Object.entries(budgets || {})) {
        if (name.startsWith('_') || !Number.isFinite(budget) || !Number.isFinite(row[name])) continue;
        const limits = [{ limit: budget * g.budgetRatio, why: `${g.budgetRatio}× its budget of ${budget}${unit(name)}` }];
        const earlier = rows.slice(Math.max(0, i - g.trendWindow), i).map((r) => r[name]).filter(Number.isFinite);
        if (earlier.length >= g.trendMinRows) {
            const m = median(earlier);
            limits.push({ limit: m * g.trendRatio, why: `${g.trendRatio}× the median ${m}${unit(name)} of the ${earlier.length} runs before` });
        }
        const lowest = limits.reduce((a, b) => (b.limit < a.limit ? b : a));
        if (row[name] > lowest.limit) out.push({ name, value: row[name], limit: Math.round(lowest.limit), why: lowest.why });
    }
    return out;
}

/**
 * Regressions: figures over their hard limit in each of the last `consecutive` rows of the
 * trend (the last row is this run). One slow run alone only warns (`slow`).
 */
function regressions(trend, budgets, gate = DEFAULT_GATE) {
    const g = { ...DEFAULT_GATE, ...gate };
    const rows = parseTrend(trend);
    const slow = breaches(rows, rows.length - 1, budgets, g);
    if (rows.length < g.consecutive) return { slow, failed: [] };
    const failed = slow.filter((b) => {
        for (let k = 2; k <= g.consecutive; k++) {
            if (!breaches(rows, rows.length - k, budgets, g).some((p) => p.name === b.name)) return false;
        }
        return true;
    });
    return { slow, failed };
}

/** The trend with its last row's timings (…Ms) multiplied by `factor` (gate self-test). */
function slowLastRow(trend, factor) {
    const lines = (trend || '').trim().split(/\r?\n/);
    if (lines.length < 2) return trend;
    const cols = lines[0].split(',');
    const cells = lines[lines.length - 1].split(',');
    lines[lines.length - 1] = cells.map((v, i) => (/Ms$/.test(cols[i]) && v.trim() !== '' && Number.isFinite(Number(v)) ? String(Math.round(Number(v) * factor)) : v)).join(',');
    return `${lines.join('\n')}\n`;
}

/** Job summary: the last rows of the trend, any figure over budget and any hard-limit breach. */
function summary(trend, over, last = 10, gate = { slow: [], failed: [] }) {
    const lines = trend.trim().split('\n');
    const [head, ...rows] = lines;
    const table = [head, ...rows.slice(-last)].map(l => `| ${l.split(',').join(' | ')} |`);
    table.splice(1, 0, `|${head.split(',').map(() => '---').join('|')}|`);
    const notes = over.length
        ? over.map(o => `- ⚠ ${o.name} ${o.value}${unit(o.name)} is over its budget of ${o.budget}${unit(o.name)}`)
        : ['- All figures within budget.'];
    const failed = new Set(gate.failed.map((b) => b.name));
    const hard = gate.slow.map((b) => (failed.has(b.name)
        ? `- ❌ ${b.name} ${b.value}${unit(b.name)} is over its hard limit of ${b.limit}${unit(b.name)} (${b.why}) for the second run in a row: failed (#120)`
        : `- ⚠ ${b.name} ${b.value}${unit(b.name)} is over its hard limit of ${b.limit}${unit(b.name)} (${b.why}); fails if the next run is too (#120)`));
    return ['## Multi-year load benchmark (#59)', '', ...notes, ...hard, '', ...table, ''].join('\n');
}

function arg(name, argv) {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
}

function main(argv = process.argv.slice(2), env = process.env) {
    let result = JSON.parse(fs.readFileSync(arg('result', argv), 'utf8'));
    const budgets = JSON.parse(fs.readFileSync(arg('budgets', argv), 'utf8'));
    const trendPath = arg('trend', argv);
    let existing = fs.existsSync(trendPath) ? fs.readFileSync(trendPath, 'utf8') : '';
    const factor = Number(arg('simulate-slowdown', argv) || 1);
    if (!(factor > 0)) throw new Error('--simulate-slowdown needs a number above 0');
    if (factor !== 1) {
        console.log(`::notice title=Simulated slowdown::timings of this run and the trend's last row × ${factor} (gate self-test)`);
        result = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, /Ms$/.test(k) && Number.isFinite(v) ? Math.round(v * factor) : v]));
        existing = slowLastRow(existing, factor);
    }
    const trend = appendRow(existing, trendRow(result, arg('sha', argv) || env.GITHUB_SHA || ''));
    fs.writeFileSync(trendPath, trend);
    const over = overBudget(result, budgets);
    over.forEach(o => console.log(`::warning title=Benchmark over budget::${o.name} ${o.value}${unit(o.name)} > ${o.budget}${unit(o.name)} (#59)`));
    const gate = regressions(trend, budgets, budgets._gate);
    const failed = new Set(gate.failed.map((b) => b.name));
    gate.slow.forEach((b) => console.log(failed.has(b.name)
        ? `::error title=Benchmark regression::${b.name} ${b.value}${unit(b.name)} > ${b.limit}${unit(b.name)} (${b.why}) for the second run in a row (#120)`
        : `::warning title=Benchmark slow run::${b.name} ${b.value}${unit(b.name)} > ${b.limit}${unit(b.name)} (${b.why}); fails if the next run is too (#120)`));
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary(trend, over, 10, gate));
    console.log(`[bench] recorded in ${trendPath}${over.length ? `; over budget: ${over.map(o => o.name).join(', ')}` : ''}${gate.failed.length ? `; regressed: ${[...failed].join(', ')}` : ''}`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `regressed=${gate.failed.length ? 'true' : 'false'}\n`);
    else if (gate.failed.length) process.exitCode = 1;
}

module.exports = { COLUMNS, DEFAULT_GATE, trendRow, appendRow, overBudget, parseTrend, breaches, regressions, slowLastRow, summary, main };

if (require.main === module) main();
