/**
 * Tabs keyboard (UX C3, plan 6.2; www/js/ui/seg.js): every role=tablist is one Tab stop (roving
 * tabindex on the selected tab) and Left / Right / Home / End select a tab through its own handler.
 */
const { test, expect, login, showTab } = require('./support/app');

// showTabFromNav draws a page's default section in a 100 ms timer: let it run before pressing keys.
const NAV_TIMER_MS = 400;

const PAGES = [
    { route: 'day', list: '#day .day-tabs', pane: (n) => ['#dayTodayContent', '#dayCashContent'][n] },
    { route: 'money', list: '#money .tabs[role="tablist"]' },
    { route: 'insights', list: '#insights .tabs[role="tablist"]' }
];

test('tabs: one Tab stop, arrow keys / Home / End select and focus the tab', async ({ page }) => {
    await login(page, 'owner');
    for (const p of PAGES) {
        await showTab(page, p.route);
        await page.waitForTimeout(NAV_TIMER_MS);
        const tabs = page.locator(`${p.list} > [role="tab"]:not([hidden])`);
        const n = await tabs.count();
        expect(n, p.route).toBeGreaterThan(1);
        await expect(tabs.first(), p.route).toHaveAttribute('aria-selected', 'true');
        await expect(tabs.first(), p.route).toHaveAttribute('tabindex', '0');
        await expect(tabs.nth(1), p.route).toHaveAttribute('tabindex', '-1');

        await tabs.first().focus();
        await page.keyboard.press('ArrowRight');
        await expect(tabs.nth(1), `${p.route} → next`).toHaveAttribute('aria-selected', 'true');
        await expect(tabs.nth(1)).toBeFocused();
        await expect(tabs.nth(1)).toHaveAttribute('tabindex', '0');
        await expect(tabs.first()).toHaveAttribute('tabindex', '-1');
        if (p.pane) await expect(page.locator(p.pane(1))).toBeVisible();

        await page.keyboard.press('End');
        await expect(tabs.nth(n - 1), `${p.route} End`).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Home');
        await expect(tabs.first(), `${p.route} Home`).toHaveAttribute('aria-selected', 'true');
        await expect(tabs.first()).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(tabs.nth(n - 1), `${p.route} ← wraps`).toHaveAttribute('aria-selected', 'true');
        if (p.pane) await expect(page.locator(p.pane(n - 1))).toBeVisible();
    }
});
