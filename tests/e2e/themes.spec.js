/**
 * Themes (redesign 2.6, DIRECTION §4): text contrast (axe `color-contrast`, WCAG AA) on Billing (with a line and a ticked "Fill"),
 * Today and Outstanding, on the open Workers row, and on the app bar with the More sheet open, in every theme × mode (and in Hindi for the serif themes, whose Devanagari stays
 * in the sans face), and the Settings › Appearance gallery: a tap previews
 * a theme app-wide without saving it, Cancel or leaving Settings restores the saved one, Apply saves it
 * (it survives a reload, applied before first paint); printing from a serif theme looks like Modern.
 * Phone project only: the CSS is the same on desktop.
 */
const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect, login, showTab, settle } = require('./support/app');
const { seed } = require('./support/seed');
const { commit } = require('./support/emulator');

const COMBOS = [
    ['modern', 'light'], ['modern', 'dark'], ['nordic', 'light'], ['nordic', 'dark'],
    ['nature', 'light'], ['nature', 'dark'], ['dark', 'light'], ['midnight', 'system'],
    ['vintage', 'light'], ['vintage', 'dark'], ['classic', 'light'], ['classic', 'dark'],
    ['premium', 'light'], ['premium', 'dark'],
    ['vintage', 'light', 'hi'], ['vintage', 'dark', 'hi'], ['classic', 'light', 'hi'], ['classic', 'dark', 'hi'],
    ['premium', 'light', 'hi'], ['premium', 'dark', 'hi'],
];
const DARK_KIND = new Set(['dark', 'midnight']);
const MONTH = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
// Part-paid this month: the open row shows a warning tag and a balance line
const THEME_WORKER = {
    name: 'Theme Worker', startMonth: MONTH, active: true, pays: [{ from: MONTH, amount: 9000 }],
    entries: [{ id: 'e2e-theme-entry', amount: 3000, kind: 'advance', month: MONTH, date: `${MONTH}-01`, mode: 'cash' }],
};
const PAGES = [['Billing', 'billing'], ['Today', 'day'], ['Outstanding', 'due']];

/** Billing with a line in the row list and the whole bill put in Cash with its "Fill" (3.5), so axe sees both. */
async function billWithFill(page) {
    const rice = await page.$eval('#billItem', (sel) => [...sel.options].find(o => /Rice|चावल/.test(o.textContent))?.value);
    await page.selectOption('#billItem', rice);
    await page.fill('#billRate', '30');
    await page.fill('#newWeight', '10');
    await page.press('#newWeight', 'Enter');
    await page.evaluate(() => window.app.billing.addToBill());
    await expect(page.locator('#billTable tbody tr.bill-line')).toHaveCount(1);
    await expect(page.locator('#cashCheckbox')).toHaveAccessibleName(/^(Fill|पूरा) \(\S/);
    await page.locator('#purchaseSection .pay-fill', { has: page.locator('#cashCheckbox') }).click();
    await expect(page.locator('#cashCheckbox')).toBeChecked();
    await expect(page.locator('#cashCheckbox')).toHaveAccessibleName(/^(Filled|भरा) \(\S/);
    await expect(page.locator('#cashPayment')).toHaveValue(await page.locator('#amountPayable').textContent());
    // Ticked, it reads "Filled" on a solid fill at least 3:1 against the panel (unticked Fill has no fill)
    const cash = page.locator('#purchaseSection .pay-fill', { has: page.locator('#cashCheckbox') });
    await expect(cash.locator('.pay-fill-on')).toBeVisible();
    await expect(cash.locator('.pay-fill-off')).toBeHidden();
    const ratio = await cash.evaluate((label) => {
        const rgba = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const over = ([r, g, b, a = 1], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
        const page = rgba(getComputedStyle(document.body).backgroundColor);
        const panel = over(rgba(getComputedStyle(label.closest('.bill-totals')).backgroundColor), page);
        const onCs = getComputedStyle(label.querySelector('.pay-fill-on'));
        const lum = (rgb) => {
            const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        // The fill or its 2px ring, whichever stands out more
        return Math.max(contrast(over(rgba(onCs.backgroundColor), panel), panel), contrast(over(rgba(onCs.borderTopColor), panel), panel));
    });
    expect(ratio, 'a ticked Fill stands out from the panel').toBeGreaterThanOrEqual(3);
    await page.evaluate(() => document.activeElement?.blur?.());
}

test.skip(({ isMobile }) => !isMobile, 'phone project only');
test.beforeEach(async () => { await seed(); });

async function useTheme(page, theme, appearance, lang = 'en') {
    // Once per test: a reload keeps what the app saved since
    await page.addInitScript(([th, ap, kind, lg]) => {
        if (sessionStorage.getItem('e2e.themeSet')) return;
        sessionStorage.setItem('e2e.themeSet', '1');
        localStorage.setItem('happa.theme', th);
        localStorage.setItem('happa.appearance', ap);
        localStorage.setItem('happa.themeKind', kind);
        localStorage.setItem('aadhat.lang', lg);
    }, [theme, appearance, DARK_KIND.has(theme) ? 'dark' : 'both', lang]);
}

for (const [theme, appearance, lang = 'en'] of COMBOS) {
    test(`text contrast is WCAG AA in ${theme} (${appearance}${lang === 'en' ? '' : `, ${lang}`})`, async ({ page, problems }) => {
        test.setTimeout(180000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await useTheme(page, theme, appearance, lang);
        await login(page, 'owner');
        const mode = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode, document.documentElement.lang]);
        expect(mode).toEqual([theme, DARK_KIND.has(theme) || appearance === 'dark' ? 'dark' : 'light', lang]);
        // Section titles take the theme's face; Devanagari keeps a sans face before the generic serif, and no italic
        const title = await page.evaluate(() => {
            const cs = getComputedStyle(document.querySelector('#billing .bill-section-title'));
            return { family: cs.fontFamily, style: cs.fontStyle };
        });
        expect(title.style).toBe(theme === 'vintage' && lang === 'en' ? 'italic' : 'normal');
        if (/serif$/.test(title.family) && !/sans-serif$/.test(title.family)) {
            expect(title.family.indexOf('Nirmala UI')).toBeGreaterThan(-1);
            expect(title.family.indexOf('Nirmala UI')).toBeLessThan(title.family.lastIndexOf('serif'));
        }
        const found = [];
        for (const [name, route] of PAGES) {
            await showTab(page, route);
            expect(await settle(page), `${name} finished loading`).toBe(true);
            if (route === 'billing') await billWithFill(page);
            const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
            for (const v of result.violations) {
                for (const n of v.nodes) found.push(`${name}: ${n.target.join(' ')} — ${(n.any[0]?.message || v.help).replace(/\s+/g, ' ')}`);
            }
        }
        // Workers / Salaries (#373): the open row, and each row's name above its details
        await commit([['dev_workers', 'e2e-theme-worker', THEME_WORKER]]);
        await showTab(page, 'workers');
        const worker = page.locator('#workersBody .row[data-worker="e2e-theme-worker"]');
        await worker.click();
        await expect(worker).toHaveAttribute('aria-expanded', 'true');
        await expect(worker.locator('[data-wp-state]')).toBeVisible();
        const box = await worker.evaluate(r => {
            const [title, meta] = [...r.querySelector('.row-main').children].map(c => c.getBoundingClientRect());
            return { below: meta.top >= title.bottom - 1, fits: r.getBoundingClientRect().right <= innerWidth };
        });
        expect(box, 'details sit below the name, and the row fits the screen').toEqual({ below: true, fits: true });
        const workers = await new AxeBuilder({ page }).include('#workersBody .wp-list').withRules(['color-contrast']).analyze();
        for (const v of workers.violations) {
            for (const n of v.nodes) found.push(`Workers: ${n.target.join(' ')} — ${(n.any[0]?.message || v.help).replace(/\s+/g, ' ')}`);
        }
        // The app bar and the More sheet (redesign 4.1)
        await page.evaluate(() => window.app.nav.toggleMenu());
        await expect(page.locator('#sideNav')).toBeVisible();
        const sheet = await new AxeBuilder({ page }).include('#sideNav').include('#appBar').withRules(['color-contrast']).analyze();
        for (const v of sheet.violations) {
            for (const n of v.nodes) found.push(`More: ${n.target.join(' ')} — ${(n.any[0]?.message || v.help).replace(/\s+/g, ' ')}`);
        }
        await page.evaluate(() => window.app.nav.closeMenu());
        if (found.length) console.log(`[themes] ${theme} ${appearance} ${found.length} element(s):\n${found.join('\n')}`);
        expect(found).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
    });
}

test('printing from the serif themes looks like Modern: colours, faces, italic, rules and corners are screen-only', async ({ page, problems }) => {
    test.setTimeout(120000);
    await useTheme(page, 'modern', 'light');
    await login(page, 'owner');
    await showTab(page, 'billing');
    expect(await settle(page)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    const look = (theme, mode) => page.evaluate(([th, m]) => {
        const html = document.documentElement;
        html.dataset.theme = th;
        html.dataset.mode = m;
        document.body.classList.toggle('dark-mode', m === 'dark');
        const cs = (sel) => getComputedStyle(document.querySelector(sel));
        const title = cs('#billing .bill-section-title');
        const total = cs('#billing .grand-total strong');
        const head = cs('#billTable thead th');
        const card = cs('#purchaseSection .bill-totals');
        return {
            page: [cs('body').backgroundColor, cs('body').color],
            title: [title.fontFamily, title.fontStyle, title.color],
            total: [total.fontFamily, total.fontWeight, total.fontVariantNumeric],
            rules: [head.borderBottomColor, cs('#saveBillBtn').backgroundColor],
            card: [card.backgroundColor, card.borderTopLeftRadius],
        };
    }, [theme, mode]);
    const modern = await look('modern', 'light');
    for (const theme of ['vintage', 'classic', 'premium']) {
        for (const mode of ['light', 'dark']) expect(await look(theme, mode), `${theme} ${mode} in print`).toEqual(modern);
    }
    expect(problems.pageErrors).toEqual([]);
});

test('the gallery previews without saving; Cancel, leaving Settings and Apply behave', async ({ page, problems }) => {
    test.setTimeout(180000);
    await useTheme(page, 'modern', 'light');
    await login(page, 'owner');
    const html = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode]);
    const bar = page.locator('#themePreviewBar');

    await showTab(page, 'settings-common');
    await expect(page.locator('#themeGallery .theme-card')).toHaveCount(8);
    await expect(page.locator('[data-theme-choice="modern"]')).toHaveAttribute('aria-pressed', 'true');

    await page.click('[data-theme-choice="nordic"]');
    expect(await html()).toEqual(['nordic', 'light']);
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('happa.theme'))).toBe('modern');
    await page.click('#themePreviewBar .theme-preview-cancel');
    expect(await html()).toEqual(['modern', 'light']);
    await expect(bar).toBeHidden();
    await expect(page.locator('[data-theme-choice="nordic"]')).toBeFocused();

    await page.click('[data-theme-choice="midnight"]');
    expect(await html()).toEqual(['midnight', 'dark']);
    await expect(page.locator('#themeDarkHint')).toBeVisible();
    await showTab(page, 'billing');
    expect(await html()).toEqual(['modern', 'light']);
    await expect(bar).toBeHidden();

    await showTab(page, 'settings-common');
    await page.click('[data-theme-choice="nature"]');
    await page.click('#themePreviewBar .theme-preview-apply');
    expect(await html()).toEqual(['nature', 'light']);
    await expect(bar).toBeHidden();
    await expect(page.locator('[data-theme-choice="nature"]')).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('happa.theme'))).toBe('nature');
    await expect(page.locator('[data-theme-choice="nature"]')).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'nature');
    expect(problems.pageErrors).toEqual([]);
});
