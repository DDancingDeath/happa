/**
 * @fileoverview One language at a time (#143): the app shows English by default and
 * Hindi when chosen, never "English / हिंदी" together. Guards:
 *  1. no string literal / template / concatenation in www/js, and no text or attribute in
 *     www/templates/*.html or www/index.html, mixes Latin and Devanagari
 *     (scripts/mixed-language-scan.js; small allow-list there);
 *  2. catalogue values stay in their own language;
 *  3. the screens render in English with no Devanagari outside user data, and in Hindi
 *     with the Hindi text;
 *  4. old stored "English / Hindi" sentences show only the chosen language.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        loadCashSessionsBetween: jest.fn(async () => []),
        loadAuditLogsSince: jest.fn(async () => []),
        loadAnomalies: jest.fn(async () => ({ docs: [], last: null, more: false })),
        saveAnomalies: jest.fn(async () => {})
    }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: { showImagePreview: jest.fn(() => true) } }));
jest.mock('../modules/reports.js', () => ({ chartScaleMax: (v) => Math.max(1, ...v) }));

const fs = require('fs');
const path = require('path');
const scan = require('../../../scripts/mixed-language-scan.js');
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';
import { applyTranslations, setLang, resetLangForTests } from '../i18n/index.js';
import { pickLang, splitBilingual } from '../i18n/localize.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { buildDayReportText, istDayKey } from '../utils/anomalies.js';
import { buildBillShareText } from '../utils/bill-share.js';
import { buildReminderText, buildStatement } from '../utils/due-reminder.js';

const WWW = path.join(__dirname, '..', '..');
const DEVANAGARI = /[\u0900-\u097F]/;
const DEVANAGARI_ALL = /[\u0900-\u097F]+/g;
// Owned by feat/language-in-settings (the language picker's own label), see the scanner.
const LANGUAGE_PICKER_KEYS = new Set(['ui.settings.language']);

jest.useFakeTimers({
    now: new Date('2026-10-21T12:00:00+05:30'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout']
});
afterAll(() => jest.useRealTimers());

describe('source scan: no "English / हिंदी" strings', () => {
    test('www/js, www/templates and index.html have no mixed-language text', () => {
        const hits = scan.scanAll().map(h => `${h.file}:${h.line}  ${h.text}`);
        expect(hits).toEqual([]);
    });

    test('the scanner finds literals, concatenations, both-language templates and HTML text', () => {
        expect(scan.scanJsSource("const a = 'Open / खोलें';")).toHaveLength(1);
        expect(scan.scanJsSource("const a = 'Could not start. ' + 'शुरू नहीं हुआ';")).toHaveLength(1);
        expect(scan.scanJsSource('const a = `${x.en} / ${x.hi}`;')).toHaveLength(1);
        expect(scan.scanJsSource("const a = x.en + ' · ' + x.hi;")).toHaveLength(1);
        expect(scan.scanJsSource("const a = { en: 'Open', hi: 'खोलें' };")).toEqual([]);
        expect(scan.scanJsSource("const a = ['English', 'हिंदी'];")).toEqual([]);
        expect(scan.scanHtmlSource('<p>Fixed / सुधारा</p><input placeholder="Item / आइटम"><!-- Note / नोट -->')).toHaveLength(2);
        expect(scan.scanHtmlSource('<button>English / हिंदी</button>')).toEqual([]);
    });
});

describe('catalogues keep to their own language', () => {
    test('English values have no Devanagari; Hindi values do not repeat the English text', () => {
        const enMixed = Object.keys(en).filter(k => !LANGUAGE_PICKER_KEYS.has(k) && DEVANAGARI.test(en[k]));
        expect(enMixed).toEqual([]);
        const hiWithEn = Object.keys(hi).filter(k => !LANGUAGE_PICKER_KEYS.has(k) && /[A-Za-z]{3}/.test(en[k])
            && (hi[k].includes(`${en[k]} / `) || hi[k].includes(` / ${en[k]}`)));
        expect(hiWithEn).toEqual([]);
    });
});

describe('old stored sentences', () => {
    const old = 'Mahua Naya: selling 1.0 kg, only 0.5 kg in stock / Mahua Naya: 1.0 किलो बिक्री, स्टॉक में सिर्फ़ 0.5 किलो';

    test('splitBilingual keeps only the chosen half', () => {
        expect(splitBilingual(old, 'en')).toBe('Mahua Naya: selling 1.0 kg, only 0.5 kg in stock');
        expect(splitBilingual(old, 'hi')).toBe('Mahua Naya: 1.0 किलो बिक्री, स्टॉक में सिर्फ़ 0.5 किलो');
        expect(splitBilingual('High / गंभीर: 0', 'hi')).toBe('गंभीर: 0');
        expect(splitBilingual('Rice / चावल 5 kg', 'en')).toBe('Rice');
        expect(splitBilingual('महुआ 5 kg', 'en')).toBe('महुआ 5 kg');
        expect(splitBilingual('1 / 2', 'hi')).toBe('1 / 2');
    });

    test('pickLang prefers the language field, then the other one, then the old message', () => {
        expect(pickLang({ en: 'Open', hi: 'खोलें' }, 'hi')).toBe('खोलें');
        expect(pickLang({ en: 'Open' }, 'hi')).toBe('Open');
        expect(pickLang({ message: old }, 'en')).toBe('Mahua Naya: selling 1.0 kg, only 0.5 kg in stock');
        expect(pickLang(null)).toBe('');
    });
});

function textAndAttrs(root) {
    const attrs = [...root.querySelectorAll('[placeholder],[title],[aria-label]')]
        .flatMap(el => ['placeholder', 'title', 'aria-label'].map(a => el.getAttribute(a)).filter(Boolean));
    const options = [...root.querySelectorAll('option')].map(o => o.textContent);
    return [root.textContent, ...attrs, ...options].join('\n');
}

/** Devanagari words on screen that are not user data and not a language name. */
function strayHindi(text, userData = []) {
    let rest = text;
    userData.forEach(v => { rest = rest.split(v).join(' '); });
    const allowed = new Set(['हिंदी', 'भाषा']);
    return (rest.match(DEVANAGARI_ALL) || []).filter(w => !allowed.has(w));
}

describe('templates render in one language', () => {
    const templates = fs.readdirSync(path.join(WWW, 'templates')).filter(f => f.endsWith('.html'));
    const html = (f) => fs.readFileSync(path.join(WWW, 'templates', f), 'utf8');
    afterEach(() => { resetLangForTests(); localStorage.clear(); document.body.innerHTML = ''; });

    test('English: no Devanagari in any template or the app shell (outside the language picker)', () => {
        setLang('en');
        const shell = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
        const found = [];
        for (const f of [...templates, 'index.html']) {
            document.body.innerHTML = f === 'index.html' ? shell.replace(/<script[\s\S]*?<\/script>/gi, '') : html(f);
            applyTranslations(document);
            const stray = strayHindi(textAndAttrs(document.body));
            if (stray.length) found.push(`${f}: ${[...new Set(stray)].join(' ')}`);
        }
        expect(found).toEqual([]);
    });

    test('Hindi: every translated template text is the Hindi catalogue text', () => {
        setLang('hi');
        const notHindi = [];
        for (const f of templates) {
            document.body.innerHTML = html(f);
            applyTranslations(document);
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (el.textContent !== hi[key]) notHindi.push(`${f}: ${key}`);
            });
        }
        expect(notHindi).toEqual([]);
    });
});

describe('Anomalies page and Today day report render in one language', () => {
    const TEMPLATE = fs.readFileSync(path.join(WWW, 'templates', 'anomalies.html'), 'utf8');
    const today = istDayKey(Date.now());
    const userData = ['राम ट्रेडर्स', 'महुआ', 'सुरेश'];
    const bill = {
        id: 'b1', billNumber: 'R1', customerName: 'राम ट्रेडर्स', userId: 'u1', userName: 'सुरेश',
        items: [{ name: 'महुआ', rate: 40, qty: 10, total: 400 }], total: 400,
        payment: { cash: 100, online: 0, due: 0 }, date: new Date().toISOString(), timestamp: Date.now()
    };
    const oldDoc = {
        id: 'oversell~bill~old', type: 'oversell', severity: 'medium', status: 'open', dayKey: today, at: Date.now() - 60000,
        refKind: 'bill', refId: 'old', party: 'राम ट्रेडर्स', item: 'महुआ', detectedAt: Date.now(),
        message: 'Mahua Naya: selling 1.0 kg, only 0.5 kg in stock / Mahua Naya: 1.0 किलो बिक्री, स्टॉक में सिर्फ़ 0.5 किलो'
    };
    const fixedDoc = { ...oldDoc, id: 'rate-low~bill~f', type: 'rate-low', status: 'fixed', message: undefined, en: 'Rate far below', hi: 'रेट बहुत कम' };

    beforeAll(() => { HTMLCanvasElement.prototype.getContext = () => null; });
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.clear();
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'own1' };
        AppState.historyLoadedFrom = 0;
        AppState.retailSalesHistory = [bill];
        AppState.purchaseHistory = [];
        AppState.salesHistory = [];
        AppState.stockAdjustments = [];
        AppState.items = [];
        AnomaliesManager.stored = null;
        AnomaliesManager.reportList = [];
        AnomaliesManager.refreshing = null;
        AnomaliesManager.scanQueue = null;
        AnomaliesManager.page.filters = { preset: '7d', type: 'all', severity: 'all', status: 'all', user: 'all', item: '' };
        AnomaliesManager.page.view = 'list';
        FirebaseService.loadAnomalies.mockResolvedValue({ docs: [oldDoc, fixedDoc], last: null, more: false });
    });
    afterEach(() => { resetLangForTests(); });

    async function render(lang) {
        resetLangForTests();
        setLang(lang);
        document.body.innerHTML = `<div id="dayReportCard" style="display:none"></div>${TEMPLATE}`;
        applyTranslations(document);
        AnomaliesManager.renderDayReport({ sales: 400, saleCount: 1 }, { signedOut: true, counted: true, difference: -50 });
        await AnomaliesManager.refreshing;
        await AnomaliesManager.init();
        await AnomaliesManager.refreshing;
        const texts = [textAndAttrs(document.body)];
        AnomaliesManager.showView('patterns');
        texts.push(textAndAttrs(document.body));
        texts.push(AnomaliesManager.dayReportText());
        return texts.join('\n');
    }

    test('English: no Hindi outside user data; old stored sentence shows its English half', async () => {
        const text = await render('en');
        expect(text).toContain('Day report');
        expect(text).toContain('Needs review');
        expect(text).toContain('Mahua Naya: selling 1.0 kg, only 0.5 kg in stock');
        expect(text).toContain('Cash: closed, short ₹50');
        expect(strayHindi(text, userData)).toEqual([]);
    });

    test('Hindi: Hindi UI text, no English UI text', async () => {
        const text = await render('hi');
        ['आज की रिपोर्ट', 'जाँच बाकी', 'सभी गड़बड़ियाँ', 'खोलें', 'सुधारा', 'गंभीर', 'Mahua Naya: 1.0 किलो बिक्री',
            'नकद: बंद, ₹50 कम', 'गड़बड़ियाँ', 'सूची', 'पैटर्न', 'मुख्य पार्टी'].forEach(s => expect(text).toContain(s));
        ['Day report', 'Needs review', 'All anomalies', 'Open', 'Fixed', 'High', 'selling 1.0 kg', 'Cash:', 'Top parties',
            'Loading', 'Severity', 'Patterns'].forEach(s => expect(text).not.toContain(s));
    });

    test('switching the language redraws the open page and the day report', async () => {
        await render('en');
        setLang('hi');
        AnomaliesManager.refreshForLanguage();
        AnomaliesManager.drawDayReport();
        const text = textAndAttrs(document.body);
        expect(text).toContain('आज की रिपोर्ट');
        expect(text).not.toContain('Day report');
        expect(document.getElementById('anomalyFilterType').options[0].textContent).toBe('सभी प्रकार');
    });
});

describe('shared / printed text follows the app language', () => {
    afterEach(() => { resetLangForTests(); localStorage.clear(); });
    const bill = { billNumber: 'W1', customerName: 'राम', items: [{ name: 'महुआ', rate: 10, qty: 2, total: 20 }], total: 20, payment: { cash: 20, online: 0, due: 0 }, date: '2026-10-21' };
    const party = { name: 'राम', bills: [{ billNumber: 'W1', date: new Date(2026, 9, 1), due: 20 }] };

    test('English', () => {
        setLang('en');
        const texts = [
            buildBillShareText(bill, 'wholesale'), buildReminderText(party), (({ title, totalLabel, footer }) => [title, totalLabel, footer].join(' '))(buildStatement(party)),
            buildDayReportText({ dayKey: '2026-10-21', today: [{ type: 'oversell', severity: 'medium', party: 'राम' }] })
        ].join('\n');
        expect(strayHindi(texts, ['राम', 'महुआ'])).toEqual([]);
    });

    test('Hindi', () => {
        setLang('hi');
        const texts = [buildBillShareText(bill, 'wholesale'), buildReminderText(party), buildDayReportText({ dayKey: '2026-10-21' })].join('\n');
        ['थोक बिल', 'प्रति', 'कुल', 'नमस्ते', 'बकाया बिल', 'धन्यवाद', 'आज की रिपोर्ट', 'गड़बड़ियाँ: कोई नहीं'].forEach(s => expect(texts).toContain(s));
        ['Wholesale Bill', 'COPY', 'Total', 'Namaste', 'Open bills', 'Thank you', 'Day report', 'Anomalies'].forEach(s => expect(texts).not.toContain(s));
    });
});
