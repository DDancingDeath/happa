/** @jest-environment jsdom */
import { moneyHtml } from '../ui/components.js';
import { formatRupees } from '../utils/money.js';

const render = (html) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
};

describe('moneyHtml', () => {
    test.each([
        [12456789, undefined],
        [250000, undefined],
        [0, undefined],
        [-500, undefined],
        [-1234.5, { trueMinus: true }],
        [1234.56, { exact: true }],
        [99.5, { decimals: 2 }]
    ])('%p %p: its text is formatRupees and the ₹ sits alone in .cur', (amount, opts) => {
        const el = render(moneyHtml(amount, opts));
        expect(el.textContent).toBe(formatRupees(amount, opts));
        expect(el.querySelector('.money > .cur').textContent).toBe('₹');
    });

    test('a missing amount is a dash', () => {
        expect(moneyHtml(null)).toBe('—');
        expect(moneyHtml(undefined)).toBe('—');
    });
});
