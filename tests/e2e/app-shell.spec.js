/**
 * The app shell (redesign 4.1, DIRECTION §8): on the phone an app bar with the open page's title, the
 * sync pill and the bell (no floating menu button); "More" opens the side menu as a modal bottom sheet
 * (focus in, Tab kept inside, Esc / Back close it, focus back on More; closed, it can't be reached by Tab),
 * with the pages not on the tab bar in groups and the business switch. On desktop the sidebar is unchanged.
 */
const { test, expect, login, showTab } = require('./support/app');

const shell = (page) => page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const bar = document.querySelector('header.app-bar');
    return {
        title: document.getElementById('appBarTitle')?.textContent,
        titleShown: vis(document.getElementById('appBarTitle')),
        pillInBar: !!document.getElementById('syncStatus')?.closest('.app-bar') && document.querySelectorAll('#syncStatus').length === 1,
        bellInBar: !!bar?.contains(document.getElementById('notifBell')),
        menuButton: vis(document.querySelector('.hamburger')),
        mains: [...document.querySelectorAll('[role="main"]')].filter(vis).map(m => m.id)
    };
});

const inSheet = (page) => page.evaluate(() => !!document.activeElement?.closest('#sideNav'));

test('phone: the app bar names the open page in English and Hindi; the open page is the one main landmark', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone shell');
    await login(page, 'owner');
    for (const [route, title] of [['billing', 'Billing'], ['day', 'Today'], ['due', 'Outstanding'], ['rates', 'Rates'], ['settings-common', 'Settings']]) {
        await showTab(page, route);
        const s = await shell(page);
        expect(s.title, route).toBe(title);
        expect(s.titleShown).toBe(true);
        expect(s.mains).toHaveLength(1);
    }
    const s = await shell(page);
    expect(s.pillInBar).toBe(true);
    expect(s.bellInBar).toBe(true);
    expect(s.menuButton, 'no floating menu button on the phone').toBe(false);
    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await expect(page.locator('#appBarTitle')).toHaveText('सेटिंग');
    await showTab(page, 'due');
    await expect(page.locator('#appBarTitle')).toHaveText('बकाया');
    expect(problems.pageErrors).toEqual([]);
});

test('phone: More opens a modal sheet that keeps focus inside, closes on Esc and Back, and gives focus back', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone shell');
    await login(page, 'owner');
    await showTab(page, 'billing');
    await showTab(page, 'day');
    const more = page.locator('.bottom-nav-item[data-tab="more"]');
    const sheet = page.locator('#sideNav');

    // Closed: hidden, and Tab from More never reaches its links
    await expect(sheet).toBeHidden();
    await more.focus();
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); expect(await inSheet(page)).toBe(false); }

    await more.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet).toHaveAttribute('aria-label', 'Menu');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sideNav .close-btn')).toBeFocused();
    // The tab bar's pages are not repeated; the others are, in groups
    await expect(page.locator('#sideNav a[data-bar]').first()).toBeHidden();
    await expect(page.locator('#sideNav a[data-onclick*="wholesale-sales"]')).toBeVisible();
    await expect(page.locator('#navGroupMoney')).toBeVisible();
    for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); expect(await inSheet(page), `Tab ${i + 1}`).toBe(true); }
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); expect(await inSheet(page)).toBe(true); }

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.getElementById('sideNav').hasAttribute('role'))).toBe(false);

    // Back closes the sheet and stays on the page
    await more.click();
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#day.tab.active')).toBeVisible();

    // A page from the sheet opens it, names it and closes the sheet
    await more.click();
    await page.click('#sideNav a[data-onclick*="expenses"]');
    await expect(sheet).toBeHidden();
    await expect(page.locator('#appBarTitle')).toHaveText('Expenses');
    expect(problems.pageErrors).toEqual([]);
});

test('phone on its side: the sheet fits under the bar and scrolls', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone shell');
    await login(page, 'owner');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 740, height: 360 });
    await page.locator('.bottom-nav-item[data-tab="more"]').click();
    await expect(page.locator('#sideNav')).toBeVisible();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('sideNav')).transform === 'none');
    const box = await page.evaluate(() => {
        const r = document.getElementById('sideNav').getBoundingClientRect();
        const s = document.getElementById('sideNav');
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, scrolls: s.scrollHeight > s.clientHeight, overflow: getComputedStyle(s).overflowY };
    });
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.vh + 1);
    expect(box.scrolls).toBe(true);
    expect(box.overflow).toBe('auto');
    await expect(page.locator('#sideNav .close-btn')).toBeInViewport();
    await expect(page.locator('#bizSwitch')).toBeInViewport();
    await page.locator('#sideNav a[data-onclick*="diagnostics"]').scrollIntoViewIfNeeded();
    await expect(page.locator('#sideNav a[data-onclick*="diagnostics"]')).toBeInViewport();
    expect(problems.pageErrors).toEqual([]);
});

test('desktop: the sidebar keeps every page and the bell; no app bar title', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop shell');
    await login(page, 'owner');
    await showTab(page, 'billing');
    const s = await shell(page);
    expect(s.titleShown).toBe(false);
    expect(s.menuButton).toBe(false);
    expect(s.mains).toEqual(['billing']);
    await expect(page.locator('#sideNav')).toBeVisible();
    await expect(page.locator('#sideNav a[data-bar]')).toHaveCount(4);
    for (const a of await page.locator('#sideNav a[data-bar]').all()) await expect(a).toBeVisible();
    await expect(page.locator('#sideNav .nav-group-title').first()).toBeHidden();
    const bell = await page.locator('#notifBell').boundingBox();
    expect(bell && bell.x + bell.width).toBeLessThanOrEqual(240);
    expect(problems.pageErrors).toEqual([]);
});
