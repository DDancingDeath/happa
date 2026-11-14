/**
 * @fileoverview F0 (one money formatter): every local wrapper and alias that was replaced by
 * formatRupees / moneyText / moneyHtml with a named preset gives the same text as before, for
 * generated amounts (0, missing, negatives, paise, ₹1,24,56,789 and huge values). The only
 * differences are the deliberate ones (MONEY-TEXT): a missing amount is "—" on screen.
 */
import fc from 'fast-check';
import { formatRupees, formatRate, moneyText, MONEY_PRESETS, UNKNOWN_AMOUNT } from '../../www/js/utils/money.js';
import { moneyHtml } from '../../www/js/ui/components.js';

const RUNS = Number(process.env.FC_RUNS) || 500;

// The formatter as it was before F0 (utils/money.js on main), kept here as the reference.
const oldRound2 = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0; };
function oldAmount(amount, { decimals = 0, small = false, exact = false } = {}) {
    const n = Number(amount);
    const v = Number.isFinite(n) ? n : 0;
    let digits = decimals;
    const paise = Math.abs(oldRound2(v) - Math.round(v)) >= 0.005;
    if (!decimals && paise && (exact || (small && Math.abs(v) < 100))) digits = 2;
    const shown = digits ? oldRound2(v) : Math.round(v);
    return (Object.is(shown, -0) ? 0 : shown).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function oldRupees(amount, opts) {
    const text = oldAmount(amount, opts);
    return text.startsWith('-') ? `${opts?.trueMinus ? '−' : '-'}₹${text.slice(1)}` : `₹${text}`;
}
const oldMissing = (n) => n === null || n === undefined || n === '' || !Number.isFinite(Number(n));
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

// Each replaced wrapper: [where it was, old body, new call]
const WRAPPERS = [
    ['due-reminder formatINR', (n) => oldRupees(n), (n) => formatRupees(n)],
    ['Helpers.formatCurrency', (n) => oldRupees(n), (n) => formatRupees(n)],
    ['day.js formatCurrency', (n) => oldRupees(n), (n) => formatRupees(n)],
    ['receipt-drawing rupees', (n) => oldRupees(n), (n) => formatRupees(n)],
    ['bill-share money', (n) => oldRupees(n), (n) => formatRupees(n)],
    ['rent-receipt inr', (n) => oldRupees(n, { exact: true }), (n) => formatRupees(n, 'exact')],
    ['formatRate on receipts and share text', (n) => oldRupees(n, { decimals: 2 }), (n) => formatRupees(n, 'ratePaise')],
    ['money.js money', (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : oldRupees(v, { trueMinus: true })), (v) => moneyText(v, 'signed')],
    ['period-compare rupees', (v) => (v === null ? '—' : oldRupees(v, { trueMinus: true })), (v) => moneyText(v, 'signed')],
    ['period-compare textRupees', (v) => (v === null ? '—' : oldRupees(v)), (v) => moneyText(v, 'plain')],
    ['rate-trends rupees', (n) => (n === null || n === undefined ? '—' : oldRupees(n, { decimals: 2 })), (n) => moneyText(n, 'ratePaise')],
    ['rate-trends wholeRupees', (n) => (n === null || n === undefined ? '—' : oldRupees(n)), (n) => moneyText(n)],
    ['finance-breakdown rupees', (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : oldRupees(n, { exact: false, trueMinus: true })), (n) => moneyText(n, 'signed')],
    ['finance-breakdown rupees (paise)', (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : oldRupees(n, { exact: true, trueMinus: true })), (n) => moneyText(n, { exact: true, trueMinus: true })],
    ['anomalies money / inr, bill-checks fmtRs', (n) => oldRupees(n, { exact: true }), (n) => moneyText(n, 'exact')],
    ['recurring-bills / workers money', (n) => oldRupees(n), (n) => moneyText(n)],
    ['history / wholesale / rentals money', (n) => (oldMissing(n) ? oldRupees(n) : textOf(moneyHtml(n))), (n) => textOf(moneyHtml(n))]
];

const FIXED = [0, -0, 0.4, 0.5, 1, 9.99, 99.5, 100, 987.5, 987.49, 1000, 1953, 1303.5, -1303.5, -500, -0.2, -18272, 12456789, -12456789,
    1245678.9, 628782, 1e12, -1e12, 9007199254740991, 24.5, 2400, 2400.004, 0.005, 1.005];
const amounts = fc.oneof(
    fc.constantFrom(...FIXED),
    fc.integer({ min: -2e9, max: 2e9 }),
    fc.integer({ min: -2e11, max: 2e11 }).map(p => p / 100),
    fc.double({ min: -1e13, max: 1e13, noNaN: true })
);
const missing = [null, undefined, '', NaN, 'x', Infinity];

describe('F0: replaced money wrappers keep their text', () => {
    test.each(WRAPPERS)('%s: same text for every finite amount', (_name, before, after) => {
        fc.assert(fc.property(amounts, (n) => after(n) === before(n)), { numRuns: RUNS });
    });

    test.each(WRAPPERS)('%s: a missing amount is "—" on screen, or as before', (_name, before, after) => {
        for (const n of missing) {
            const now = after(n);
            expect(now === before(n) || now === UNKNOWN_AMOUNT).toBe(true);
        }
    });

    test('the presets are the options they name', () => {
        fc.assert(fc.property(amounts, (n) => formatRupees(n, 'exact') === oldRupees(n, { exact: true })
            && formatRupees(n, 'paise') === oldRupees(n, { decimals: 2 })
            && formatRupees(n, 'small') === oldRupees(n, { small: true })
            && formatRupees(n, 'signed') === oldRupees(n, { trueMinus: true })
            && formatRupees(n, 'whole') === oldRupees(n)
            && formatRupees(n, 'plain') === oldRupees(n)), { numRuns: RUNS });
        expect(Object.isFrozen(MONEY_PRESETS)).toBe(true);
    });

    test('moneyHtml text is formatRupees text, ₹1,24,56,789 included', () => {
        fc.assert(fc.property(amounts, (n) => textOf(moneyHtml(n)) === formatRupees(n)), { numRuns: RUNS });
        expect(textOf(moneyHtml(12456789))).toBe('₹1,24,56,789');
        expect(moneyHtml(null)).toBe(UNKNOWN_AMOUNT);
    });

    test('formatRate keeps its paise for now', () => {
        fc.assert(fc.property(amounts, (n) => formatRate(n) === oldRupees(n, { decimals: 2 })), { numRuns: RUNS });
    });
});
