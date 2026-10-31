/**
 * @fileoverview Labour on purchases (docs/calculations.md T-LAB-1, T-LAB-2):
 * utils/labour.js, the package-weight setting, the Today Labour card in English
 * and Hindi, its bill-wise breakdown and the day report lines.
 */
import fs from 'fs';
import path from 'path';
import {
    labourDeducted, labourGap, periodLabourGap, labourToPay, labourPackages, labourSummary, labourToPayByDay, billKg, billPackets,
    normalizePackageKg, DEFAULT_LABOUR_PACKAGE_KG
} from '../utils/labour.js';
import { buildDayReportText } from '../utils/anomalies.js';
import { DayManager } from '../modules/day.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { SettingsManager, packageKgInRange } from '../modules/settings.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { todayLocalISO } from '../utils/dates.js';
import { applyTranslations, setLang, resetLangForTests } from '../i18n/index.js';

const DEVANAGARI = /[\u0900-\u097F]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const RATE = { laborRate: 6, labourPackageKg: 35 };

const line = (qty, packets = 0) => ({ name: 'Wheat', qty, rate: 25, total: qty * 25, weights: Array(packets).fill(packets ? qty / packets : 0) });
const purchase = (id, items, laborCharges, extra = {}) => ({ id, date: `${todayLocalISO()}T10:00:00`, items, laborCharges, ...extra });
const opening = (id) => ({ id, date: `${todayLocalISO()}T09:00:00`, items: [line(500, 10)], laborCharges: 60, openingBalance: { amount: 900 } });

describe('utils/labour.js', () => {
    test('0 kg: nothing to pay, nothing deducted', () => {
        expect(labourToPay([], RATE)).toEqual({ kg: 0, packageKg: 35, packages: 0, rate: 6, amount: 0 });
        expect(labourToPay([purchase('p', [], 0)], RATE).packages).toBe(0);
        expect(labourDeducted([])).toEqual({ amount: 0, bills: 0 });
        expect(labourSummary(undefined, RATE)).toMatchObject({ difference: 0, rows: [] });
    });

    test.each([[35, 1], [70, 2], [350, 10], [3500, 100]])('exact multiple: %p kg = %p packages', (kg, packages) => {
        expect(labourToPay([purchase('p', [line(kg)], 0)], RATE)).toMatchObject({ kg, packages, amount: packages * 6 });
    });

    test.each([[1, 1], [34.99, 1], [35.01, 2], [1000, 29], [69.5, 2]])('a part package is rounded up: %p kg = %p packages', (kg, packages) => {
        expect(labourPackages(kg, 35)).toBe(packages);
    });

    test('kg summed from several lines is not pushed over a package by float error', () => {
        expect(labourToPay([purchase('p', [line(23.1), line(11.9)], 0)], RATE)).toMatchObject({ kg: 35, packages: 1 });
    });

    test('1,000 kg ÷ 35 kg = 29 packages × ₹6 = ₹174', () => {
        expect(labourToPay([purchase('p1', [line(600, 12)], 72), purchase('p2', [line(400, 8)], 0)], RATE))
            .toEqual({ kg: 1000, packageKg: 35, packages: 29, rate: 6, amount: 174 });
    });

    test('a package weight change changes the packages; out-of-range values use 35 kg', () => {
        const bills = [purchase('p', [line(1000)], 0)];
        expect(labourToPay(bills, { laborRate: 6, labourPackageKg: 40 })).toMatchObject({ packages: 25, amount: 150 });
        expect(labourToPay(bills, { laborRate: 6, labourPackageKg: 50 })).toMatchObject({ packages: 20, amount: 120 });
        expect(labourToPay(bills, { laborRate: 8, labourPackageKg: 1 })).toMatchObject({ packages: 1000, amount: 8000 });
        [0, -5, 200.5, 500, 'x', '', null, undefined].forEach(bad => {
            expect(labourToPay(bills, { laborRate: 6, labourPackageKg: bad })).toMatchObject({ packageKg: DEFAULT_LABOUR_PACKAGE_KG, packages: 29 });
        });
        expect(labourToPay(bills, {})).toMatchObject({ packageKg: 35, rate: 6, amount: 174 });
        // Billing (purchase.js) treats a 0 rate as unset and uses ₹6; so does To pay.
        expect(labourToPay(bills, { laborRate: 0 })).toMatchObject({ rate: 6, packages: 29, amount: 174 });
    });

    test('old-app opening records are left out of both figures', () => {
        const s = labourSummary([opening('o1'), purchase('p', [line(70, 2)], 12)], RATE);
        expect(s.deducted).toEqual({ amount: 12, bills: 1 });
        expect(s.toPay).toMatchObject({ kg: 70, packages: 2, amount: 12 });
        expect(s.rows.map(r => r.bill.id)).toEqual(['p']);
    });

    test('mixed bills: deducted counts ticked labour only, to pay counts every kg', () => {
        const bills = [
            purchase('ticked', [line(600, 12)], 72),
            purchase('unticked', [line(400, 8)], 0),
            purchase('legacy', [{ item: 'Rice', quantity: 35, amount: 700 }], undefined, { labour: 6, totalPackets: 1 })
        ];
        const s = labourSummary(bills, RATE);
        expect(s.deducted).toEqual({ amount: 78, bills: 2 });
        expect(s.toPay).toMatchObject({ kg: 1035, packages: 30, amount: 180 });
        expect(s.difference).toBe(102);
        expect(s.rows.map(r => [r.bill.id, r.kg, r.packets, r.labour])).toEqual([
            ['ticked', 600, 12, 72], ['unticked', 400, 8, 0], ['legacy', 35, 1, 6]
        ]);
        expect(billKg({})).toBe(0);
        expect(billPackets({ totalPackets: 'x' })).toBe(0);
    });

    test('a period is rounded up day by day', () => {
        const bills = [{ ...purchase('a', [line(10)], 0), day: 'd1' }, { ...purchase('b', [line(10)], 0), day: 'd2' }, opening('o')];
        expect(labourToPayByDay(bills, RATE, b => b.day || 'd1')).toEqual({ kg: 20, packages: 2, amount: 12, days: 2 });
        expect(labourToPay(bills, RATE).packages).toBe(1);
    });

    test('normalizePackageKg keeps 1–200 kg', () => {
        expect([1, 35, 42.5, 200, '40'].map(normalizePackageKg)).toEqual([1, 35, 42.5, 200, 40]);
        expect([0.99, 201, NaN].map(normalizePackageKg)).toEqual([35, 35, 35]);
    });
});

describe('Settings › Aadhat: package weight for labour', () => {
    let shared;
    beforeEach(() => {
        document.body.innerHTML = '<input id="settingHeavyWeight"><input id="settingLaborRate"><input id="settingLabourPackageKg">';
        window.app = {};
        AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
        AppState.userRole = 'owner';
        AppState.printerSettings = { enabled: false };
        jest.spyOn(SettingsManager, 'updatePrinterStatus').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        shared = jest.spyOn(FirebaseService, 'saveSharedLabourSettings').mockResolvedValue(undefined);
        localStorage.clear();
    });
    afterEach(() => { delete window.app; jest.restoreAllMocks(); localStorage.clear(); });

    test('defaults to 35 kg and is shared with the labour rate', async () => {
        SettingsManager.loadSettings();
        const input = document.getElementById('settingLabourPackageKg');
        expect(input.value).toBe('35');
        expect(input.disabled).toBe(false);
        input.value = '40';
        expect(await SettingsManager.saveSettings()).toBe(true);
        expect(shared).toHaveBeenCalledWith({ laborRate: 6, heavyWeightThreshold: 30, labourPackageKg: 40 });
        expect(AppState.settings.labourPackageKg).toBe(40);
    });

    test.each(['0', '0.5', '201', '1000', '-35'])('%p kg is refused: the field goes back and nothing is saved', async (typed) => {
        AppState.settings.labourPackageKg = 40;
        SettingsManager.loadSettings();
        document.getElementById('settingLabourPackageKg').value = typed;
        expect(await SettingsManager.saveSettings()).toBe(false);
        expect(shared).not.toHaveBeenCalled();
        expect(document.getElementById('settingLabourPackageKg').value).toBe('40');
        expect(UIManager.showToast).toHaveBeenCalledWith('Package weight must be between 1 and 200 kg. Not changed.');
    });

    test('1 and 200 kg are allowed; blank goes back to 35', () => {
        expect(['1', '200', '35.5', ''].map(packageKgInRange)).toEqual([true, true, true, true]);
        expect(['0.99', '200.01', 'abc'].map(packageKgInRange)).toEqual([false, false, false]);
    });

    test('a member cannot change it; shared value from settings/app is used on every device', async () => {
        AppState.userRole = 'staff';
        SettingsManager.loadSettings();
        expect(document.getElementById('settingLabourPackageKg').disabled).toBe(true);
        await SettingsManager.applySharedSettings({ laborRate: 7, labourPackageKg: 50 });
        expect(AppState.settings).toMatchObject({ laborRate: 7, labourPackageKg: 50 });
        expect(document.getElementById('settingLabourPackageKg').value).toBe('50');
        await SettingsManager.applySharedSettings({ laborRate: 7, labourPackageKg: 999 });
        expect(AppState.settings.labourPackageKg).toBe(35);
    });
});

describe('Today Labour card (single language)', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'day.html'), 'utf8');
    let modal;
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        modal = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
        AppState.purchaseHistory = [
            purchase('p1', [line(600, 12)], 72, { billNumber: 'P1', customerName: 'Ram <b>Lal</b>' }),
            purchase('p2', [line(400, 8)], 0, { billNumber: 'P2', customerName: 'Shyam' }),
            opening('o1')
        ];
        AppState.salesHistory = [];
        AppState.retailSalesHistory = [];
        AppState.expensesHistory = [];
        AppState.settings = { laborRate: 6, labourPackageKg: 35 };
        CashManagementManager.todaySession = null;
        document.body.innerHTML = template;
    });
    afterEach(() => {
        jest.restoreAllMocks();
        resetLangForTests();
        AppState.purchaseHistory = [];
    });
    const render = (lang) => {
        setLang(lang, { store: null });
        applyTranslations(document);
        DayManager.loadTodayData();
        return document.getElementById('todayLabourCard').textContent.replace(/\s+/g, ' ').trim();
    };

    test('English: deducted, to pay with its working, and the difference', () => {
        const card = render('en');
        expect(card).toContain('Deducted from farmers: ₹72 (1 bill)');
        expect(card).toContain('To pay labour: ₹174 (1,000 kg ÷ 35 kg = 29 packages × ₹6)');
        expect(card).toContain('To pay is ₹102 more than deducted');
        expect(card).toContain('A part package counts as a full one.');
        expect(card).not.toMatch(DEVANAGARI);
    });

    test('Hindi: the same numbers with no English words', () => {
        const card = render('hi');
        expect(card).toContain('किसानों से काटी गई: ₹72 (1 बिल)');
        expect(card).toContain('मज़दूरों को देनी है: ₹174 (1,000 किलो ÷ 35 किलो = 29 बोरी × ₹6)');
        expect(card).toContain('₹102 ज़्यादा');
        expect(card).not.toMatch(LATIN_WORD);
    });

    test('less than deducted, and equal, are worded neutrally', () => {
        AppState.purchaseHistory = [purchase('p', [line(35, 2)], 12)];
        render('en');
        expect(document.getElementById('todayLabourDiff').textContent).toBe('To pay is ₹6 less than deducted');
        AppState.purchaseHistory = [purchase('p', [line(35, 1)], 6)];
        DayManager.loadTodayData();
        expect(document.getElementById('todayLabourDiff').textContent).toBe('To pay matches what was deducted');
    });

    test('tap: bill-wise breakdown with kg, packets and labour deducted, names escaped', async () => {
        render('en');
        DayManager.showLabourBreakdown();
        expect(modal).toHaveBeenCalledTimes(1);
        const [html, title] = modal.mock.calls[0];
        expect(title).toBe('Labour today');
        const box = document.createElement('div');
        box.innerHTML = html;
        const rows = [...box.querySelectorAll('tbody tr, tfoot tr')].map(tr => [...tr.children].map(td => td.textContent));
        expect(rows).toEqual([
            ['#P1 Ram <b>Lal</b>', '600', '12', '₹72'],
            ['#P2 Shyam', '400', '8', '₹0'],
            ['Total', '1,000', '20', '₹72']
        ]);
        expect(box.querySelector('b')).toBeNull();
        expect(box.textContent).toContain('₹174 (1,000 kg ÷ 35 kg = 29 packages × ₹6)');
    });

    test('day report (WhatsApp / image) has both lines, in one language', () => {
        render('en');
        const totals = AnomaliesManager.renderDayReport.mock.calls.at(-1)[0];
        const en = buildDayReportText({ dayKey: todayLocalISO(), totals });
        expect(en).toContain('Labour deducted from farmers: ₹72 (1 bill)');
        expect(en).toContain('Labour to pay: ₹174 (1,000 kg ÷ 35 kg = 29 packages × ₹6)');
        setLang('hi', { store: null });
        const hi = buildDayReportText({ dayKey: todayLocalISO(), totals });
        expect(hi).toContain('किसानों से काटी गई मज़दूरी: ₹72 (1 बिल)');
        expect(hi).toContain('मज़दूरों को देनी है: ₹174 (1,000 किलो ÷ 35 किलो = 29 बोरी × ₹6)');
        expect(hi.split('\n').filter(l => /मज़दूरी|मज़दूरों/.test(l)).join(' ')).not.toMatch(LATIN_WORD);
    });
});

test('T-LAB-3: to pay and deducted match within 50 paise, else more / less', () => {
    expect(labourGap(0.49)).toEqual({ amount: 0.49, kind: 'same' });
    expect(labourGap(-0.49)).toEqual({ amount: 0.49, kind: 'same' });
    expect(labourGap(0.5)).toEqual({ amount: 0.5, kind: 'more' });
    expect(labourGap(-0.5)).toEqual({ amount: 0.5, kind: 'less' });
});

test('T-LAB-3 for a period: to pay − deducted to the paise, then labourGap', () => {
    expect(periodLabourGap(150, 102)).toEqual({ amount: 48, kind: 'more' });
    expect(periodLabourGap(100.1, 100.6)).toEqual({ amount: 0.5, kind: 'less' });
    expect(periodLabourGap(0.3, 0.1)).toEqual({ amount: 0.2, kind: 'same' });
});
