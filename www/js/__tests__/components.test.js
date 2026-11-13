/** @jest-environment jsdom */
import { moneyHtml, moneyInText } from '../ui/components.js';
import { formatRupees } from '../utils/money.js';

describe('moneyHtml', () => {
    const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; };

    test.each([
        [0, undefined], [250000, undefined], [12456789, undefined], [987.5, { exact: true }], [-500, undefined], [-500, { trueMinus: true }], [0.4, { small: true }]
    ])('%p %p: text equals formatRupees, ₹ in .cur, minus outside it', (amount, opts) => {
        const html = moneyHtml(amount, opts);
        expect(textOf(html)).toBe(formatRupees(amount, opts));
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

    test('text without the figure is only escaped', () => {
        expect(moneyInText('Due: ₹9', 1500)).toBe('Due: ₹9');
    });

    test('several figures, in order; a missing one is skipped', () => {
        const d = document.createElement('div');
        d.innerHTML = moneyInText('cash ₹1,500 · online ₹500', 1500, 500);
        expect(d.textContent).toBe('cash ₹1,500 · online ₹500');
        expect([...d.querySelectorAll('.money')].map(m => m.textContent)).toEqual(['₹1,500', '₹500']);
        d.innerHTML = moneyInText('cash ₹1,500 · online ₹500', 7, 500);
        expect(d.textContent).toBe('cash ₹1,500 · online ₹500');
        expect([...d.querySelectorAll('.money')].map(m => m.textContent)).toEqual(['₹500']);
    });
});