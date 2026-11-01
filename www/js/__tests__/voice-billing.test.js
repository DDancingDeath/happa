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
import { VoiceBilling, listenNative, voiceErrorKey } from '../modules/voice-billing.js';

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
