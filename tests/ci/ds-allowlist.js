/**
 * The design-system allowlist (tests/ds-allowlist.json, docs/design-system.md §7), shared by
 * ds-guard, colour-guard and type-guard. Every metric is strict: a file may hold drift only up to
 * the count of its allowlist entry, and each entry names a list and gives a reason. A count below
 * its entry fails too, until DS_ALLOWLIST=lower writes the lower count (or drops the entry at 0).
 * Against the PR base the allowlist may only shrink: see raisedVsBase().
 */
const fs = require('fs');
const path = require('path');

const REL = 'tests/ds-allowlist.json';
const FILE = path.join(__dirname, '..', '..', REL);
const MIN_REASON = 20;

const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

/** { file: count } allowed for one metric. */
const allowed = (doc, metric) => Object.fromEntries(doc.entries.filter((e) => e.metric === metric).map((e) => [e.file, e.count]));

/** Rows above their entry ("over") and entries above the current count ("under"). */
function compare(current, allow) {
    const over = [];
    const under = [];
    for (const f of new Set([...Object.keys(current), ...Object.keys(allow)])) {
        const n = current[f] || 0;
        const a = allow[f] || 0;
        if (n > a) over.push(`  ${f}: ${n}${a ? ` (allowlisted ${a})` : ' (not allowlisted)'}`);
        else if (n < a) under.push(`  ${f}: allowlisted ${a}, now ${n}`);
    }
    return { over: over.sort(), under: under.sort() };
}

/** Problems with the file itself: unknown metric or list, missing reason, duplicate or empty entry. */
function invalid(doc, metrics) {
    const bad = [];
    const seen = new Set();
    for (const [name, why] of Object.entries(doc.lists || {})) if (typeof why !== 'string' || why.length < MIN_REASON) bad.push(`list ${name}: describe it`);
    for (const e of doc.entries || []) {
        const id = `${e.metric} ${e.file}`;
        if (!metrics.includes(e.metric)) bad.push(`${id}: unknown metric`);
        if (!Object.hasOwn(doc.lists || {}, e.list)) bad.push(`${id}: unknown list "${e.list}"`);
        if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON) bad.push(`${id}: give a reason`);
        if (!Number.isInteger(e.count) || e.count < 1) bad.push(`${id}: count must be a positive integer`);
        if (seen.has(id)) bad.push(`${id}: listed twice`);
        if (e.added !== undefined && !ADDED.test(String(e.added))) bad.push(`${id}: "added" must be a PR number (#123) or a date (2026-11-14)`);
        seen.add(id);
    }
    return bad;
}

const ADDED = /^(#\d+|\d{4}-\d{2}-\d{2})$/;
const sourceFile = (row) => row.split('#')[0];

/**
 * Entries of `now` that the PR base `prior` doesn't allow: (a) a count above the base entry,
 * (b) a metric total above the base total, (c) a new entry, unless it says when it was "added"
 * (#PR or date) and its file is new in this PR (`existedAtBase(file)` false). Justified new
 * entries don't count towards (b); everything else does.
 */
function raisedVsBase(prior, now, existedAtBase) {
    const key = (e) => `${e.metric} ${e.file}`;
    const base = new Map(prior.entries.map((e) => [key(e), e]));
    const problems = [];
    const totals = new Map();
    const add = (m, side, n) => { const t = totals.get(m) || { base: 0, now: 0 }; t[side] += n; totals.set(m, t); };
    for (const e of prior.entries) add(e.metric, 'base', e.count);
    for (const e of now.entries) {
        const b = base.get(key(e));
        if (b) {
            if (e.count > b.count) problems.push(`${key(e)}: ${b.count} -> ${e.count} (above the base)`);
            add(e.metric, 'now', e.count);
        } else if (!ADDED.test(String(e.added ?? ''))) {
            problems.push(`${key(e)}: new entry without "added" (#PR or date)`);
            add(e.metric, 'now', e.count);
        } else if (existedAtBase(sourceFile(e.file))) {
            problems.push(`${key(e)}: new entry for a file that exists on the base (fix the drift instead)`);
            add(e.metric, 'now', e.count);
        }
    }
    for (const [m, t] of totals) if (t.now > t.base) problems.push(`${m} total: ${t.base} -> ${t.now}`);
    return problems.sort();
}

/** The allowlist on the PR base (ARCH_BASE_REF, else origin/<base>), or why it can't be read. */
function baseAllowlist() {
    const { execFileSync } = require('child_process');
    const root = path.join(__dirname, '..', '..');
    const ref = process.env.ARCH_BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
    const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    try { git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch (_) { return { ref, missing: 'ref' }; }
    let doc;
    try { doc = JSON.parse(git(['show', `${ref}:${REL}`])); } catch (_) { return { ref, missing: 'file' }; }
    const existedAtBase = (f) => { try { git(['cat-file', '-e', `${ref}:${f}`]); return true; } catch (_) { return false; } };
    return { ref, doc, existedAtBase };
}

function write(doc) {
    const line = (e) => `    ${JSON.stringify({ metric: e.metric, file: e.file, count: e.count, list: e.list, reason: e.reason, ...(e.added ? { added: e.added } : {}) })}`;
    const lists = Object.entries(doc.lists).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    const text = ['{', `  "_readme": ${JSON.stringify(doc._readme)},`, '  "lists": {', lists.join(',\n'), '  },', '  "entries": [',
        doc.entries.map(line).join(',\n'), '  ]', '}', ''].join('\n');
    fs.writeFileSync(FILE, text);
}

/** DS_ALLOWLIST=lower: lowers this metric's entries to the current counts; an entry at 0 is dropped. */
function lower(metric, current) {
    const doc = load();
    doc.entries = doc.entries
        .map((e) => (e.metric === metric ? { ...e, count: Math.min(e.count, current[e.file] || 0) } : e))
        .filter((e) => e.count > 0);
    write(doc);
}

/** Throws unless every row of `current` matches its entry (DS_ALLOWLIST=lower writes drops). */
function expectAllowed(metric, current, hint) {
    const { over, under } = compare(current, allowed(load(), metric));
    if (over.length) {
        throw new Error([`${metric} outside ${REL}: ${hint}. Only a legitimate exception gets an entry, with a list and a reason (docs/design-system.md §7).`, ...over].join('\n'));
    }
    if (under.length && process.env.DS_ALLOWLIST === 'lower' && !process.env.CI) { lower(metric, current); return; }
    if (under.length) throw new Error([`${metric} went down. Lower the allowlist: DS_ALLOWLIST=lower npx jest -i ds-guard colour-guard type-guard`, ...under].join('\n'));
}

module.exports = { REL, load, allowed, compare, invalid, write, lower, expectAllowed, raisedVsBase, baseAllowlist };
