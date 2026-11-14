/** @jest-environment jsdom */
import { moneyHtml, moneyInText } from '../ui/components.js';
import { moneyText } from '../utils/money.js';

describe('moneyHtml', () => {
    const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; };

    test.each([
        [0, undefined], [250000, undefined], [12456789, undefined], [987.5, { exact: true }], [-500, undefined], [-500, { trueMinus: true }], [0.4, { small: true }]
    ])('%p %p: text equals moneyText (the true minus), ₹ in .cur, minus outside it', (amount, opts) => {
        const html = moneyHtml(amount, opts);
        expect(textOf(html)).toBe(moneyText(amount, opts));
        const d = document.createElement('div');
        d.innerHTML = html;
        expect(d.querySelector('.money > .cur').textContent).toBe('₹');
    });

    test('a missing amount is a dash', () => {
        [null, undefined, '', NaN, 'x'].forEach(v => expect(moneyHtml(v)).toBe('—'));
    });
});

describe('moneyInText', () => {
    test('the text is unchanged and escaped; its figure is a .money span', () => {
        const d = document.createElement('div');
        d.innerHTML = moneyInText('<b> Due: ₹1,500', 1500);
        expect(d.textContent).toBe('<b> Due: ₹1,500');
        expect(d.querySelector('.money').textContent).toBe('₹1,500');
    });

    test('takes formatRupees options, so a rate keeps its paise inside the figure', () => {
        const d = document.createElement('div');
        d.innerHTML = moneyInText('Rate: ₹32.00/kg', 32, { decimals: 2 });
        expect(d.textContent).toBe('Rate: ₹32.00/kg');
        expect(d.querySelector('.money').textContent).toBe('₹32.00');
    });

    test('a negative figure written with the hyphen gets the true minus before ₹', () => {
        const d = document.createElement('div');
        d.innerHTML = moneyInText('You are worth -₹18,272.', -18272);
        expect(d.textContent).toBe('You are worth −₹18,272.');
        expect(d.querySelector('.money').textContent).toBe('−₹18,272');
    });

    test('text without the figure is only escaped', () => {
        expect(moneyInText('Due: ₹9', 1500)).toBe('Due: ₹9');
    });

    test('a missing amount leaves the text as it is ("₹0.00" stays, never "—")', () => {
        expect(moneyInText('Rate: ₹0.00/kg', undefined, { decimals: 2 })).toBe('Rate: ₹0.00/kg');
    });

    test('several figures, in order; one not in the text, or missing, is skipped', () => {
        const d = document.createElement('div');
        const figures = () => [...d.querySelectorAll('.money')].map(m => m.textContent);
        d.innerHTML = moneyInText('cash ₹1,500 · online ₹500', [1500, 500]);
        expect(d.textContent).toBe('cash ₹1,500 · online ₹500');
        expect(figures()).toEqual(['₹1,500', '₹500']);
        d.innerHTML = moneyInText('cash ₹1,500 · online ₹500', [7, 500]);
        expect(d.textContent).toBe('cash ₹1,500 · online ₹500');
        expect(figures()).toEqual(['₹500']);
        d.innerHTML = moneyInText('cash ₹0 · online ₹500', [null, 500]);
        expect(d.textContent).toBe('cash ₹0 · online ₹500');
        expect(figures()).toEqual(['₹500']);
    });

    test('an array of figures with opts', () => {
        const d = document.createElement('div');
        d.innerHTML = moneyInText('₹12.50/kg → ₹13.00/kg', [12.5, 13], { decimals: 2 });
        expect(d.textContent).toBe('₹12.50/kg → ₹13.00/kg');
        expect([...d.querySelectorAll('.money')].map(m => m.textContent)).toEqual(['₹12.50', '₹13.00']);
    });
});