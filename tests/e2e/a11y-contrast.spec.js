/**
 * Colour contrast (#68): axe-core's WCAG 2 AA `color-contrast` rule (4.5:1 for
 * text, 3:1 for large text) on the main pages, signed in as the owner, in English
 * and Hindi, on the phone and desktop projects. Fails on any contrast violation
 * of the visible screen.
 */
const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect, login, showTab, settle } = require('./support/app');
const { seed } = require('./support/seed');

const PAGES = [
    ['Billing', 'billing'], ['Today', 'day'], ['Today › Cash', 'day', "window.app.day.showSubTab('cash')"],
    ['History', 'history'], ['Outstanding', 'due'], ['Stocks', 'stock'], ['Wholesale', 'wholesale-sales'],
    ['Expenses', 'expenses'], ['Cash', 'cash-management'], ['Rates', 'rates'], ['Money', 'money'],
    ['Insights', 'insights'], ['Statements', 'statements'], ['Settings', 'settings-common'], ['Settings › Aadhat', 'settings-shop']
];

// The specs that add data may run before this one in a shard: start from the seed.
test.beforeEach(async () => {
    await seed();
});

for (const lang of ['en', 'hi']) {
    test(`text contrast is at least WCAG AA on the main pages (${lang})`, async ({ page, problems }) => {
        test.setTimeout(240000);
        await login(page, 'owner');
        await page.evaluate((l) => window.app.i18n.setLang(l), lang);
        const found = [];
        for (const [name, route, act] of PAGES) {
            await showTab(page, route);
            if (act) await page.evaluate(act);
            expect(await settle(page), `${name} finished loading`).toBe(true);
            const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
            for (const v of result.violations) {
                for (const n of v.nodes) {
                    found.push(`${name}: ${n.target.join(' ')} — ${(n.any[0]?.message || v.help).replace(/\s+/g, ' ')}`);
                }
            }
        }
        if (found.length) console.log(`[contrast] ${lang} ${found.length} element(s):\n${found.join('\n')}`);
        expect(found).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
    });
}
