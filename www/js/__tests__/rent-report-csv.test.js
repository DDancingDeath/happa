/**
 * RENT-19 CSV (#157): headers in the CSV language like the other CSVs: Hindi
 * when the app is in Hindi, English when "CSV in English" is on.
 */
import { showYearReport, action } from '../rentals/rent-report.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { CSV_ENGLISH_KEY } from '../utils/statements.js';

jest.mock('../rentals/rent-report-store.js', () => ({
    REPORT_LIMIT: 3000,
    yearData: jest.fn().mockResolvedValue({ charges: [{ propertyId: 'p1', month: '2026-04', amount: 10000, paid: 10000 }], expenses: [], cut: false }),
    propertyNames: jest.fn().mockResolvedValue([])
}));
jest.mock('../rentals/rent-store.js', () => ({ snapshot: () => ({ properties: [{ id: 'p1', name: 'Shop row' }], leases: [], tenants: [] }) }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn().mockResolvedValue() } }));

const ctx = { isManager: true, isOwner: true, month: '2026-11', esc: (s) => String(s), dialog: jest.fn().mockResolvedValue(true) };

async function csvHeader() {
    let blob = null;
    URL.createObjectURL = jest.fn((b) => { blob = b; return 'blob:x'; });
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await action(ctx, 'csv');
    const text = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
    return text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
}

describe('RENT-19 CSV language', () => {
    beforeAll(async () => {
        await showYearReport(ctx);
    });
    afterEach(() => {
        localStorage.removeItem(CSV_ENGLISH_KEY);
        resetLangForTests();
    });

    test('app in Hindi: Hindi headers', async () => {
        setLang('hi');
        const head = await csvHeader();
        expect(head).toContain('संपत्ति');
        expect(head).toContain('महीना');
    });

    test('app in Hindi with "CSV in English" on: English headers and total', async () => {
        setLang('hi');
        localStorage.setItem(CSV_ENGLISH_KEY, '1');
        const head = await csvHeader();
        expect(head).toMatch(/^"?Property"?,"?Month"?,"?Rent"?/);
        expect(head).not.toMatch(/[\u0900-\u097F]/);
    });
});
