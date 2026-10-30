/**
 * Read budget for the every-page smoke: Firestore document reads each page
 * costs the first time it opens, from the app's own read meter
 * (www/js/firebase/firestore-meter.js, via window.FirebaseService.getReadStats()).
 * Baselines and limits: tests/e2e/read-baselines.json. A page fails when it reads
 * more than its baseline + `tolerance` (25%, at least `minSlack` reads) or more
 * than `hardCap` documents.
 *
 * Record mode (E2E_RECORD_READS=1) raises each baseline to the count seen (never
 * lowers one) and adds missing pages; the hard cap still applies.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'read-baselines.json');
const RECORD = /^(1|true|yes)$/i.test(process.env.E2E_RECORD_READS || '');

const loadBaselines = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

/** Billed document reads since the page loaded (null before the app module ran). */
const readCount = (page) => page.evaluate(() => window.FirebaseService?.getReadStats?.().reads ?? null);

/** Waits until the count has not moved for `quiet` ms (at most `timeout`) and returns it. */
async function settledReads(page, { quiet = 1000, timeout = 10000 } = {}) {
    const t0 = Date.now();
    let last = await readCount(page);
    let since = Date.now();
    while (Date.now() - t0 < timeout) {
        await page.waitForTimeout(250);
        const now = await readCount(page);
        if (now !== last) {
            last = now;
            since = Date.now();
        } else if (Date.now() - since >= quiet) break;
    }
    return last;
}

/**
 * Most reads a page with `baseline` may cost: baseline + 25%, but at least
 * baseline + minSlack (a late listener update can land on the next page, so a
 * page that reads 0-4 documents would otherwise fail on one document), never
 * more than hardCap.
 */
const limitFor = (baseline, { tolerance, minSlack = 0, hardCap }) =>
    Math.min(hardCap, baseline + Math.max(Math.floor(baseline * tolerance), minSlack));

/** Pages of `role` over their budget, as readable lines ([] when all are inside it). */
function overBudget(role, counts, base = loadBaselines()) {
    const known = (base.reads || {})[role] || {};
    const out = [];
    for (const [pg, n] of Object.entries(counts)) {
        const b = known[pg];
        if (n > base.hardCap) out.push(`${pg}: ${n} reads, over the hard cap of ${base.hardCap}`);
        else if (b === undefined) {
            if (!RECORD) out.push(`${pg}: ${n} reads and no baseline (record one: see tests/e2e/read-baselines.json)`);
        } else if (!RECORD && n > limitFor(b, base)) {
            out.push(`${pg}: ${n} reads, baseline ${b}, limit ${limitFor(b, base)}`);
        }
    }
    return out;
}

/** Record mode: raise `role`'s baselines to `counts` (workers: 1, so no concurrent writers). */
function recordBaselines(role, counts) {
    if (!RECORD) return;
    const base = loadBaselines();
    base.reads = base.reads || {};
    const r = base.reads[role] || {};
    for (const [pg, n] of Object.entries(counts)) {
        if (n <= base.hardCap) r[pg] = Math.max(r[pg] ?? 0, n);
    }
    base.reads[role] = r;
    // Keep the file's line endings (a Windows checkout has CRLF).
    const eol = fs.readFileSync(FILE, 'utf8').includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(FILE, JSON.stringify(base, null, 2).replace(/\n/g, eol) + eol);
}

module.exports = { RECORD, readCount, settledReads, limitFor, overBudget, recordBaselines, loadBaselines };
