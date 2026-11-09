/**
 * @fileoverview Voice billing (#81): off by default, mic buttons only when switched
 * on and a speech engine exists, and a heard line only fills the form after OK —
 * never adds to the bill or saves.
 */
import { BillingManager } from '../modules/billing.js';
import { PurchaseManager } from '../modules/purchase.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { VoiceMic, VOICE_KEY, voiceEngine } from '../ui/voice-mic.js';
import { VoiceBilling, listenNative, voiceErrorKey, localVoice, Readback, READBACK_KEY } from '../modules/voice-billing.js';
import { setLang } from '../i18n/index.js';

jest.mock('../firebase/repos/bill-drafts.js', () => ({
    getAutoSave: jest.fn(),
    saveAutoSave: jest.fn().mockResolvedValue(undefined),
    deleteAutoSave: jest.fn().mockResolvedValue(undefined),
    saveDraft: jest.fn().mockResolvedValue(undefined),
    countDrafts: jest.fn().mockResolvedValue(0)
}));

const DOM = `
  <input type="checkbox" id="settingVoiceBilling"><p id="voiceBillingUnavailable" hidden></p>
  <div id="purchaseSection">
    <input id="customerName"><datalist id="customerOptions"><option value="Ramesh kumar"></option></datalist>
    <button class="voice-mic-btn" id="voiceMicPurchase" hidden></button>
    <select id="billItem"><option value="0">Rice</option><option value="1">Wheat</option></select>
    <input id="billRate"><datalist id="rateOptions"></datalist><input id="newWeight"><div id="weightsDisplay"></div>
    <table id="billTable"><tbody></tbody></table>
  </div>
  <div id="saleSection"><button class="voice-mic-btn" id="voiceMicSale" hidden></button></div>`;

/** A browser recogniser that hears `said` once. */
const fakeWebSpeech = (said) => jest.fn().mockImplementation(function Rec() {
    this.start = () => setTimeout(() => {
        this.onresult({ resultIndex: 0, results: [said.map(transcript => ({ transcript }))] });
        this.onend();
    });
    this.abort = jest.fn();
});

beforeEach(() => {
    document.body.innerHTML = DOM;
    localStorage.clear();
    delete window.Capacitor;
    delete window.webkitSpeechRecognition;
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    AppState.items = [{ id: 'r', name: 'Rice', rates: [28, 30] }, { id: 'w', name: 'Wheat', hindiName: 'गेहूं', rates: [24] }];
    AppState.settings = { ...(AppState.settings || {}), showHindi: false };
    BillingManager.init();
    PurchaseManager.setWeights([]);
    PurchaseManager.setBillItems([]);
});

afterEach(() => {
    jest.restoreAllMocks();
    delete window.webkitSpeechRecognition;
    delete window.Capacitor;
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
    setLang('en');
});

describe('voiceEngine', () => {
    test('Android app: only with the speech plugin (the WebView has no Web Speech API)', () => {
        const win = (plugin) => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => plugin && n === 'SpeechRecognition' }, webkitSpeechRecognition: function W() {} });
        expect(voiceEngine(win(true))).toBe('native');
        expect(voiceEngine(win(false))).toBeNull();
    });

    test('browser: Web Speech API unless the Permissions-Policy blocks the microphone', () => {
        const Rec = function R() {};
        expect(voiceEngine({ webkitSpeechRecognition: Rec, document: {} })).toBe('web');
        expect(voiceEngine({ webkitSpeechRecognition: Rec, document: { featurePolicy: { allowsFeature: () => false } } })).toBeNull();
        expect(voiceEngine({ webkitSpeechRecognition: Rec, document: { permissionsPolicy: { allowsFeature: (f) => f === 'microphone' } } })).toBe('web');
        expect(voiceEngine({ document: {} })).toBeNull();
    });
});

describe('VoiceMic switch', () => {
    test('off by default: no mic buttons and a tap does nothing', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg rice 30']);
        VoiceMic.apply();
        expect([...document.querySelectorAll('.voice-mic-btn')].every(b => b.hidden)).toBe(true);
        expect(document.getElementById('settingVoiceBilling').checked).toBe(false);
        await expect(VoiceMic.start('purchase')).resolves.toBe(false);
        expect(window.webkitSpeechRecognition).not.toHaveBeenCalled();
    });

    test('switched on with an engine shows the buttons; with none it stays off and says so', () => {
        VoiceMic.setOn(true);
        expect(localStorage.getItem(VOICE_KEY)).toBe('1');
        expect(document.getElementById('settingVoiceBilling').disabled).toBe(true);
        expect(document.getElementById('voiceBillingUnavailable').hidden).toBe(false);
        expect(document.getElementById('voiceMicPurchase').hidden).toBe(true);

        window.webkitSpeechRecognition = fakeWebSpeech([]);
        VoiceMic.apply();
        expect(document.getElementById('settingVoiceBilling').checked).toBe(true);
        expect(document.getElementById('voiceBillingUnavailable').hidden).toBe(true);
        expect([...document.querySelectorAll('.voice-mic-btn')].every(b => !b.hidden)).toBe(true);
    });
});

describe('VoiceBilling.listenOnce', () => {
    const val = (id) => document.getElementById(id).value;

    test('OK fills item, rate and weight; nothing is added to the bill or saved', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg wheat 25 rupees']);
        const modal = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
        const addToBill = jest.spyOn(PurchaseManager, 'addToBill');
        const save = jest.spyOn(BillingManager, 'saveBillToHistory');

        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);

        expect(modal.mock.calls[0][0]).toContain('10 kg wheat 25 rupees');
        expect(modal.mock.calls[0][0]).toContain('Wheat');
        expect([val('billItem'), val('billRate'), val('newWeight')]).toEqual(['1', '25', '10']);
        expect(document.querySelectorAll('#rateOptions option')).toHaveLength(1);
        expect(addToBill).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });

    test("a rate far from the item's rates is flagged in the dialog", async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg wheat 240']);
        const modal = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(false);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(modal.mock.calls[0][0]).toContain('far from the item');
    });
    test('Cancel leaves the form as it was', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg wheat 25']);
        jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(false);
        document.getElementById('billRate').value = '28';
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect([val('billItem'), val('billRate'), val('newWeight')]).toEqual(['0', '28', '']);
    });

    test('heard text is escaped in the check dialog', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['<img src=x onerror=alert(1)> 10 kg rice']);
        const modal = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(false);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(modal.mock.calls[0][0]).not.toContain('<img');
    });

    test('weights already entered for another item are not moved to the spoken item', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg wheat 25']);
        jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
        PurchaseManager.setWeights([40]);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect(val('billItem')).toBe('0');
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/weights already entered/), 4000);
    });

    test('the item list changing while the dialog is open fills nothing', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['10 kg wheat 25']);
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async () => {
            AppState.items = [{ id: 'n', name: 'New' }, ...AppState.items];
            return true;
        });
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect([val('billItem'), val('billRate'), val('newWeight')]).toEqual(['0', '', '']);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/item list changed/), 4000);
    });
    test('nothing understood: no dialog, the heard words are shown', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['hello there']);
        const modal = jest.spyOn(UIManager, 'showModalWithHtml');
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect(modal).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringContaining('hello there'), 4000);
    });
});

describe('Android speech plugin', () => {
    test('asks for the microphone once and stops when refused', async () => {
        const plugin = {
            available: jest.fn().mockResolvedValue({ available: true }),
            checkPermissions: jest.fn().mockResolvedValue({ speechRecognition: 'prompt' }),
            requestPermissions: jest.fn().mockResolvedValue({ speechRecognition: 'denied' }),
            start: jest.fn()
        };
        await expect(listenNative('hi-IN', plugin)).rejects.toThrow('not-allowed');
        expect(plugin.start).not.toHaveBeenCalled();
        plugin.requestPermissions.mockResolvedValue({ speechRecognition: 'granted' });
        plugin.start.mockResolvedValue({ matches: ['दस kg गेहूं'] });
        await expect(listenNative('hi-IN', plugin)).resolves.toEqual(['दस kg गेहूं']);
        expect(plugin.start).toHaveBeenCalledWith({ language: 'hi-IN', maxResults: 3, partialResults: false, popup: false });
    });

    test('a recogniser that never answers is stopped', async () => {
        jest.useFakeTimers();
        const plugin = {
            available: jest.fn().mockResolvedValue({ available: true }),
            checkPermissions: jest.fn().mockResolvedValue({ speechRecognition: 'granted' }),
            start: jest.fn(() => new Promise(() => {})),
            stop: jest.fn().mockResolvedValue(undefined)
        };
        const heard = listenNative('en-IN', plugin);
        const settled = expect(heard).rejects.toThrow('no-speech');
        await jest.advanceTimersByTimeAsync(15000);
        await settled;
        expect(plugin.stop).toHaveBeenCalled();
        jest.useRealTimers();
    });
    test('engine errors map to plain messages', () => {
        expect(['no-speech', 'No match', 'not-allowed', 'network', 'Network error', 'aborted', 'unavailable', 'weird'].map(voiceErrorKey))
            .toEqual(['msg.voice.no_speech', 'msg.voice.no_speech', 'msg.voice.mic_denied', 'msg.voice.offline', 'msg.voice.offline', '', 'msg.voice.unavailable', 'msg.voice.failed']);
    });
});

/** The real modal keeps its HTML after OK; this one puts it in the page, then `act` (the user, once it is open) ticks or unticks. */
const dialog = (answer, act = () => {}) => jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
    document.getElementById('modalMessage')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div id="modalMessage">${html}</div>`);
    await Promise.resolve();
    act();
    return answer;
});
const untick = (sel) => () => { document.querySelector(sel).checked = false; };

describe('several lines in one sentence (#81 A2)', () => {
    const billLines = () => PurchaseManager.getBillItems().map(({ name, qty, rate }) => [name, qty, rate]);

    test('a list with ticks; OK adds the ticked lines to the bill, never saves', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24 aur rice 5 kg 30 aur wheat 2 kg 25']);
        const modal = dialog(true, untick('[data-voice-line="2"]'));
        const save = jest.spyOn(BillingManager, 'saveBillToHistory');
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(modal.mock.calls[0][0].match(/data-voice-line="\d"[^>]*checked/g)).toHaveLength(3);
        expect(billLines()).toEqual([['Wheat', 10, 24], ['Rice', 5, 30]]);
        expect(save).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Lines added to the bill: 2. Check them, then save.', 4000);
    });

    test('a line missing its rate is shown but cannot be ticked', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24, rice 5 kg']);
        const modal = dialog(true);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(modal.mock.calls[0][0]).toMatch(/data-voice-line="1"[^>]*disabled/);
        expect(modal.mock.calls[0][0]).toContain('this line can&#039;t be added. Type it.');
        expect(billLines()).toEqual([['Wheat', 10, 24]]);
    });

    test('Cancel adds nothing', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24 aur rice 5 kg 30']);
        dialog(false);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect(billLines()).toEqual([]);
    });

    test("a line the form's checks stop stays in the form, and the rest are not added", async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24 aur rice 5 kg 30 aur wheat 2 kg 25']);
        dialog(true);
        const real = PurchaseManager.addToBill.bind(PurchaseManager);
        jest.spyOn(PurchaseManager, 'addToBill').mockImplementationOnce(() => real()).mockImplementationOnce(async () => {});
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(billLines()).toEqual([['Wheat', 10, 24]]);
        expect([document.getElementById('billItem').value, document.getElementById('billRate').value, document.getElementById('newWeight').value]).toEqual(['0', '30', '5']);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/^1 of 3 lines added/), 6000);
    });

    test('weights already entered (or typed) stop it before anything is added', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24 aur rice 5 kg 30']);
        dialog(true);
        document.getElementById('newWeight').value = '7';
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect(billLines()).toEqual([]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/weights already entered/), 4000);
    });
});

describe('customer name (#81 A3)', () => {
    const name = () => document.getElementById('customerName').value;

    test('fills the customer box only after OK, with a known spelling', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['customer RAMESH KUMAR 10 kg wheat 24']);
        const modal = dialog(true);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(modal.mock.calls[0][0]).toContain('Ramesh kumar');
        expect(name()).toBe('Ramesh kumar');
        expect(document.getElementById('newWeight').value).toBe('10');
    });

    test('says which name it replaces; unticked, the name stays', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['customer Suresh']);
        document.getElementById('customerName').value = 'Old Name';
        const modal = dialog(true, untick('#voiceCustomerTick'));
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(false);
        expect(modal.mock.calls[0][0]).toContain('Replaces “Old Name”');
        expect(name()).toBe('Old Name');

        dialog(true);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(name()).toBe('Suresh');
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Customer name filled: Suresh.', 4000);
    });

    test('Cancel leaves the customer box alone', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['customer Suresh 10 kg wheat 24']);
        dialog(false);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(name()).toBe('');
    });
});

describe('spoken readback (#81 A1)', () => {
    const EN = { lang: 'en_IN', name: 'en', localService: true };
    const HI = { lang: 'hi-IN', name: 'hi', localService: true };
    const fakeSynth = (voices = [EN, HI]) => {
        window.speechSynthesis = { speak: jest.fn(), cancel: jest.fn(), getVoices: () => voices };
        window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
        return window.speechSynthesis;
    };

    test('reads back what was understood while the dialog is open, then stops', async () => {
        const synth = fakeSynth();
        window.webkitSpeechRecognition = fakeWebSpeech(['customer ramesh, wheat 10 kg 24 aur rice 5 kg 30']);
        let open = null;
        const modal = dialog(false, () => { open = synth.speak.mock.calls.length; });
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(open).toBe(1);
        expect(synth.speak).toHaveBeenCalledTimes(1);
        const [u] = synth.speak.mock.calls[0];
        expect(u).toMatchObject({ text: 'Customer Ramesh. Wheat, 10 kg, 24 rupees per kg. Rice, 5 kg, 30 rupees per kg', lang: 'en-IN', voice: EN });
        expect(modal).toHaveBeenCalled();
        expect(document.getElementById('voiceReadback').checked).toBe(true);
        expect(synth.cancel).toHaveBeenCalled();
    });

    test('in Hindi, with the Hindi item name and hi-IN', async () => {
        setLang('hi');
        const synth = fakeSynth();
        window.webkitSpeechRecognition = fakeWebSpeech(['गेहूं 10 kg 24 रुपये']);
        dialog(false);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(synth.speak.mock.calls[0][0]).toMatchObject({ text: 'गेहूं, 10 kg, 24 रुपये प्रति kg', lang: 'hi-IN', voice: HI });
    });

    test('the mute switch is kept on this device and stops or restarts the readback', async () => {
        const synth = fakeSynth();
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24']);
        dialog(false, () => {
            VoiceBilling.setReadback(false);
            VoiceBilling.setReadback(true);
        });
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(synth.speak).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem(READBACK_KEY)).toBe('1');

        VoiceBilling.setReadback(false);
        expect(localStorage.getItem(READBACK_KEY)).toBe('0');
        const muted = dialog(false);
        await VoiceBilling.listenOnce('purchase', 'web');
        expect(synth.speak).toHaveBeenCalledTimes(2);
        expect(muted).toHaveBeenCalled();
        expect(document.getElementById('voiceReadback').checked).toBe(false);
    });

    test('only a voice on this device: a network voice (Chrome "Google …") is never used, the text stays here', async () => {
        const synth = fakeSynth([{ lang: 'hi-IN', name: 'Google हिन्दी', localService: false }, { lang: 'en-US', name: 'local en', localService: true }]);
        setLang('hi');
        window.webkitSpeechRecognition = fakeWebSpeech(['गेहूं 10 kg 24 रुपये']);
        const modal = dialog(true);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(synth.speak).not.toHaveBeenCalled();
        expect(modal.mock.calls[0][0]).not.toContain('voiceReadback');
        // the same language from another region is fine
        expect(localVoice('en-IN', window)).toMatchObject({ name: 'local en' });
    });

    test('no speech engine (or the Android WebView with no voices): no readback, no switch, the dialog still works', async () => {
        window.webkitSpeechRecognition = fakeWebSpeech(['wheat 10 kg 24']);
        const modal = dialog(true);
        await expect(VoiceBilling.listenOnce('purchase', 'web')).resolves.toBe(true);
        expect(modal.mock.calls[0][0]).not.toContain('voiceReadback');
        const U = function U() {};
        expect(localVoice('en-IN', {})).toBeNull();
        expect(localVoice('en-IN', { speechSynthesis: {}, SpeechSynthesisUtterance: U })).toBeNull();
        expect(localVoice('en-IN', { speechSynthesis: { speak: () => {}, getVoices: () => [] }, SpeechSynthesisUtterance: U })).toBeNull();
        expect(localVoice('en-IN', { get speechSynthesis() { throw new Error('blocked'); } })).toBeNull();
        expect(Readback.speak('hello', 'en-IN', {})).toBe(false);
    });
});
