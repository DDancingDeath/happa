/**
 * @fileoverview Laptop billing (#104): a field focused between the stuck totals card and
 * the stuck Save/Print row is scrolled into the gap between them.
 */
import { scrollIntoGap } from '../ui/sticky-focus.js';

test('under the top bar: scroll up so it sits just below it', () => {
    expect(scrollIntoGap({ top: 300, bottom: 340 }, 420, 600)).toBe(300 - 420 - 8);
});

test('under the bottom bar: scroll down so it sits just above it', () => {
    expect(scrollIntoGap({ top: 580, bottom: 620 }, 420, 600)).toBe(620 - 600 + 8);
});

test('already in the gap: no scroll', () => {
    expect(scrollIntoGap({ top: 440, bottom: 480 }, 420, 600)).toBe(0);
});
