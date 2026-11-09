/**
 * Voice billing (#81 A1–A3) with a stand-in recogniser and speech engine (no microphone):
 * one sentence with a customer and several lines shows the check dialog, reads it back,
 * lets a line be unticked and adds only the ticked lines to the bill; the name goes in the
 * Customer box; nothing is saved. English on a purchase, Hindi on a retail sale.
 * Screenshots of the dialog go to the test's output folder (and the report).
 */
const { test, expect, login, showTab, expectToast } = require('./support/app');
const { listDocs, deleteAll } = require('./support/emulator');

const KILO = '\u0915\u093F\u0932\u094B';

async function shot(page, testInfo, name) {
    const path = testInfo.outputPath(`${testInfo.project.name}-${name}.png`);
    await page.waitForTimeout(500); // the dialog's opening transition
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** Voice on; the recogniser "hears" window.__voiceSaid; the speech engine records what it says. */
async function fakeSpeech(page) {
    await page.addInitScript(() => {
        localStorage.setItem('aadhat.voiceBilling', '1');
        window.__voiceSaid = [];
        window.__spoken = [];
        class FakeRecognition {
            start() {
                setTimeout(() => {
                    this.onresult?.({ resultIndex: 0, results: [window.__voiceSaid.map(transcript => ({ transcript }))] });
                    this.onend?.();
                }, 50);
            }
            abort() {}
            stop() {}
        }
        window.SpeechRecognition = FakeRecognition;
        window.webkitSpeechRecognition = FakeRecognition;
        const synth = {
            speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }),
            cancel: () => {},
            getVoices: () => []
        };
        Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    });
}

const say = (page, text) => page.evaluate((t) => { window.__voiceSaid = [t]; }, text);
const spoken = (page) => page.evaluate(() => window.__spoken.slice());

test.beforeEach(() => deleteAll('dev_autoSaves'));
test.afterEach(() => deleteAll('dev_autoSaves'));

test('one sentence: customer and several lines, read back, a line unticked, the rest added, nothing saved (#81)', async ({ page, problems }, testInfo) => {
    await fakeSpeech(page);
    await login(page, 'staff');
    await showTab(page, 'billing');
    await page.click('#purchaseModeBtn');
    const dialog = page.locator('#modalMessage #voiceCheck');

    // ---- English, purchase ----
    await say(page, 'customer ramesh kumar, wheat 50 kg 22 rupees, mustard 30 kg 55 rupees aur rice 10 kg');
    await page.click('#voiceMicPurchase');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#toast')).not.toHaveClass(/\bshow\b/);
    await expect(dialog).toContainText('Ramesh Kumar');
    await expect(dialog.locator('[data-voice-line]')).toHaveCount(3);
    await expect(dialog.locator('[data-voice-line="0"]')).toBeChecked();
    await expect(dialog.locator('[data-voice-line="2"]')).toBeDisabled();
    await expect.poll(() => spoken(page)).toEqual([{
        text: 'Customer Ramesh Kumar. Wheat, 50 kg, 22 rupees per kg. Mustard, 30 kg, 55 rupees per kg. Rice, 10 kg',
        lang: 'en-IN'
    }]);
    await shot(page, testInfo, 'voice-check-en');

    // Mute is kept on this device; untick Mustard; OK adds Wheat only
    await dialog.locator('#voiceReadback').uncheck();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('aadhat.voiceReadback'))).toBe('0');
    await dialog.locator('[data-voice-line="1"]').uncheck();
    await page.click('#modalConfirm');
    await expectToast(page, /Lines added to the bill: 1\./);
    await expect(page.locator('#customerName')).toHaveValue('Ramesh Kumar');
    await expect(page.locator('#billTable tbody')).toContainText('Wheat');
    await expect(page.locator('#billTable tbody')).not.toContainText('Mustard');

    // ---- Hindi, retail sale: the readback switched back on in the dialog speaks again ----
    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await page.click('#saleModeBtn');
    await say(page, `ग्राहक रमेश, गेहूँ 5 ${KILO} 26 रुपये, सरसों 3 ${KILO} 62 रुपये`);
    await page.click('#voiceMicSale');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-voice-line]')).toHaveCount(2);
    await expect(dialog.locator('#voiceReadback')).not.toBeChecked();
    expect(await spoken(page)).toHaveLength(1);
    await dialog.locator('#voiceReadback').check();
    await expect.poll(async () => (await spoken(page)).slice(1)).toEqual([{
        text: 'ग्राहक रमेश. गेहूं, 5 kg, 26 रुपये प्रति kg. सरसों, 3 kg, 62 रुपये प्रति kg',
        lang: 'hi-IN'
    }]);
    await shot(page, testInfo, 'voice-check-hi');
    await page.click('#modalConfirm');
    await expect(page.locator('#saleTotal')).toHaveText('316');
    await expect(page.locator('#saleCustomerName')).toHaveValue('रमेश');

    // Voice never saves
    const saved = [...await listDocs('dev_purchases'), ...await listDocs('dev_retailSales')];
    expect(saved.filter(b => ['Ramesh Kumar', 'रमेश'].includes(b.customerName))).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
    await page.evaluate(() => window.app.i18n.setLang('en'));
});
