/**
 * RENT-19 CSV (#157): headers, the year-total label and the removed-property
 * name in the CSV language like the other CSVs: Hindi when the app is in Hindi,
 * English when "CSV in English" is on.
 */
import { showYearReport, action } from '../rentals/rent-report.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { CSV_ENGLISH_KEY } from '../utils/statements.js';

jest.mock('../rentals/rent-report-store.js', () => ({
    REPORT_LIMIT: 3000,
    yearData: jest.fn().mockResolvedValue({
        charges: [{ propertyId: 'p1', month: '2026-04', amount: 10000, paid: 10000 }, { propertyId: 'p2gone', month: '2026-05', amount: 500, paid: 0 }],
        expenses: [],
        cut: false
    }),
    propertyNames: jest.fn().mockResolvedValue([{ id: 'p2gone', name: '' }])
}));
jest.mock('../rentals/rent-store.js', () => ({ snapshot: () => ({ properties: [{ id: 'p1', name: 'Shop row' }], leases: [], tenants: [] }) }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn().mockResolvedValue() } }));

const ctx = { isManager: true, isOwner: true, month: '2026-11', esc: (s) => String(s), dialog: jest.fn().mockResolvedValue(true) };

async function csvLines() {
    let blob = null;
    if (!URL.createObjectURL) URL.createObjectURL = () => '';
    if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
    jest.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b; return 'blob:x'; });
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await action(ctx, 'csv');
    const text = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
    return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
}

describe('RENT-19 CSV language', () => {
    beforeAll(async () => {
        await showYearReport(ctx);
    });
    afterEach(() => {
        localStorage.clear();
        resetLangForTests();
    });

    test('app in Hindi: Hindi headers, total and removed-property name', async () => {
        setLang('hi');
        const lines = await csvLines();
        expect(lines[0]).toMatch(/^"?संपत्ति"?,"?महीना"?/);
        expect(lines.some(l => l.includes('साल का कुल'))).toBe(true);
        expect(lines.some(l => l.includes('(संपत्ति हटाई गई) · p2gone'))).toBe(true);
    });

    test('app in Hindi with "CSV in English" on: everything in English', async () => {
        setLang('hi');
        localStorage.setItem(CSV_ENGLISH_KEY, '1');
        const lines = await csvLines();
        expect(lines[0]).toMatch(/^"?Property"?,"?Month"?,"?Rent"?/);
        expect(lines.some(l => /^"?Shop row"?,"?Year total"?,/.test(l))).toBe(true);
        expect(lines.some(l => l.includes('(property removed) · p2gone'))).toBe(true);
        expect(lines.join('\n')).not.toMatch(/[\u0900-\u097F]/);
    });
});
