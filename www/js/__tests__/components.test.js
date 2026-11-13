/** @jest-environment jsdom */
import { moneyHtml } from '../ui/components.js';
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
