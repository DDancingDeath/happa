/**
 * The app shell (redesign 4.1, DIRECTION §8): on the phone an app bar with the open page's title, the
 * sync pill and the bell (no floating menu button); "More" opens the side menu as a modal bottom sheet
 * (focus in, Tab kept inside, Esc / Back close it, focus back on More; closed, it can't be reached by Tab),
 * with the pages not on the tab bar in groups and the business switch. On desktop (redesign 4.2) the page header bar
 * carries the same title, the sync pill and the bell; the sidebar shows the same groups, only the pages the role may open.
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

// The sidebar links each role sees today (authentication.js applyRoleBasedRestrictions): unchanged by 4.2
const NAV = {
    owner: {
        Daily: ['day', 'billing', 'wholesale-sales', 'expenses', 'rates', 'history', 'stock', 'due'],
        Money: ['money', 'insights', 'statements', 'workers', 'recurring', 'ask'],
        Manage: ['anomalies', 'health', 'admin', 'diagnostics']
    },
    manager: {
        Daily: ['day', 'billing', 'wholesale-sales', 'expenses', 'rates', 'history', 'stock', 'due'],
        Money: ['money', 'insights', 'statements', 'ask'],
        Manage: ['anomalies', 'health', 'diagnostics']
    },
    staff: {
        Daily: ['day', 'billing', 'expenses', 'rates', 'history', 'stock', 'due'],
        Money: ['ask']
    }
};

const sidebar = (page) => page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const groups = {};
    for (const g of document.querySelectorAll('#sideNav .nav-group')) {
        if (!vis(g)) continue;
        const title = g.querySelector('.nav-group-title');
        groups[title.textContent.trim()] = {
            titleShown: vis(title),
            links: [...g.querySelectorAll('a')].filter(vis).map(a => /showTab\('([^']+)'/.exec(a.getAttribute('data-onclick'))?.[1])
        };
    }
    return groups;
});

/** Landmark of the focused element: banner (page header), nav (sidebar) or main (the open page). */
const focusedIn = (page) => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.closest('header.app-bar')) return 'banner';
    if (el.closest('#sideNav')) return 'nav';
    if (el.closest('[role="main"]')) return 'main';
    return el.id || el.tagName;
});

test('desktop: the page header names the open page (en, hi) with the sync pill and the bell; one banner, nav and main', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop shell');
    await login(page, 'owner');
    const pages = [['billing', 'Billing'], ['day', 'Today'], ['wholesale-sales', 'Wholesale'], ['expenses', 'Expenses'], ['rates', 'Rates'],
        ['history', 'History'], ['stock', 'Stock'], ['due', 'Outstanding'], ['money', 'Money'], ['insights', 'Insights'],
        ['statements', 'Statements'], ['anomalies', 'Anomalies'], ['admin', 'Admin'], ['settings-common', 'Settings']];
    for (const [route, title] of pages) {
        await showTab(page, route);
        const s = await shell(page);
        expect(s.title, route).toBe(title);
        expect(s.titleShown, route).toBe(true);
        expect(s.mains, route).toHaveLength(1);
    }
    const s = await shell(page);
    expect(s.pillInBar).toBe(true);
    expect(s.bellInBar).toBe(true);
    expect(s.menuButton).toBe(false);
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    // A page's own head (.page-head) is not a second banner; its title is for screen readers, its actions show
    await page.evaluate(() => document.querySelector('.tab.active').insertAdjacentHTML('afterbegin',
        '<header class="page-head" id="e2ePageHead"><h2>Head</h2><div class="page-head-actions"><button type="button" class="btn">Act</button></div></header>'));
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Head', level: 2 })).toHaveCount(1);
    expect((await page.locator('#e2ePageHead h2').boundingBox()).width).toBeLessThanOrEqual(1);
    await expect(page.locator('#e2ePageHead .btn')).toBeVisible();
    await page.evaluate(() => document.getElementById('e2ePageHead').remove());
    // The header runs from the sidebar's edge to the window's; the open page starts under it
    const box = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        return { bar: r(document.querySelector('header.app-bar')), nav: r(document.getElementById('sideNav')), tab: r(document.querySelector('.tab.active')), vw: window.innerWidth };
    });
    expect(box.bar.top).toBe(0);
    expect(Math.round(box.bar.left)).toBe(Math.round(box.nav.right));
    expect(Math.round(box.bar.right)).toBe(box.vw);
    expect(box.tab.top).toBeGreaterThanOrEqual(box.bar.bottom - 1);
    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await expect(page.locator('#appBarTitle')).toHaveText('सेटिंग');
    await showTab(page, 'due');
    await expect(page.locator('#appBarTitle')).toHaveText('बकाया');
    await expect(page.locator('#navGroupDaily')).toHaveText('रोज़ का काम');
    expect(problems.pageErrors).toEqual([]);
});

for (const role of ['owner', 'manager', 'staff']) {
    test(`desktop: the sidebar groups the pages a ${role} may open`, async ({ page, problems }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'desktop shell');
        await login(page, role);
        await showTab(page, 'billing');
        const groups = await sidebar(page);
        const want = Object.fromEntries(Object.entries(NAV[role]).map(([g, links]) => [g, { titleShown: true, links }]));
        expect(groups).toEqual(want);
        // Alt+1…9 hints follow the shortcuts; the business switch shows only with a Rentals role
        await expect(page.locator('#sideNav a[data-onclick*="\'billing\'"]')).toHaveAttribute('aria-keyshortcuts', 'Alt+2');
        await expect(page.locator('#sideNav a[data-onclick*="\'billing\'"] .nav-kbd')).toBeVisible();
        await expect(page.locator('#bizSwitch')).toBeVisible();
        await expect(page.locator('#sideNav .nav-header')).not.toContainText(/[\u{1F300}-\u{1FAFF}]/u);
        expect(problems.pageErrors).toEqual([]);
    });
}

test('desktop: Tab goes through the page header, then the sidebar, then the page; Alt+1…9 still switch pages', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop shell');
    await login(page, 'owner');
    await showTab(page, 'day');
    await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
    const order = ['body', 'banner', 'nav', 'main'];
    const seen = [];
    for (let i = 0; i < 40 && seen[seen.length - 1] !== 'main'; i++) {
        await page.keyboard.press('Tab');
        const at = await focusedIn(page);
        if (seen[seen.length - 1] !== at) seen.push(at);
    }
    expect(seen.every(a => order.includes(a)), seen.join(' → ')).toBe(true);
    expect(seen.map(a => order.indexOf(a)), seen.join(' → ')).toEqual([...seen.map(a => order.indexOf(a))].sort((a, b) => a - b));
    expect(seen).toContain('nav');
    expect(seen[seen.length - 1]).toBe('main');
    await page.keyboard.press('Alt+3');
    await expect(page.locator('#wholesale-sales.tab.active')).toBeVisible();
    await expect(page.locator('#appBarTitle')).toHaveText('Wholesale');
    await page.keyboard.press('Alt+1');
    await expect(page.locator('#day.tab.active')).toBeVisible();
    expect(problems.pageErrors).toEqual([]);
});

test('desktop 1024: the sidebar is a 64 px icon rail; links keep their names', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop shell');
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, 'owner');
    await showTab(page, 'billing');
    const nav = await page.locator('#sideNav').boundingBox();
    expect(nav.width).toBe(64);
    await expect(page.getByRole('link', { name: 'Outstanding' })).toBeVisible();
    await expect(page.locator('#sideNav a[data-onclick*="\'due\'"]')).toHaveAttribute('title', 'Outstanding (Alt+8)');
    const bar = await page.locator('header.app-bar').boundingBox();
    expect(bar.x).toBe(64);
    await expect(page.locator('#appBarTitle')).toHaveText('Billing');
    expect(problems.pageErrors).toEqual([]);
});