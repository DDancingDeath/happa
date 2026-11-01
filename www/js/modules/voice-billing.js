/**
 * @fileoverview Voice billing (#81): listens once, shows what was heard and fills
 * the purchase / retail line only after the user taps OK. It never adds the line
 * to the bill or saves; nothing heard is stored. Loaded with import() on the first
 * mic tap (ui/voice-mic.js). Design and limits: docs/voice-billing.md.
 * @module modules/voice-billing
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t, getLang } from '../i18n/index.js';
import { pickVoiceLine, hasVoiceValues } from '../utils/voice-parse.js';
import { BillingManager, PurchaseManager, RetailSaleManager } from './billing.js';

const FIELDS = {
    purchase: {
        mic: 'voiceMicPurchase', item: 'billItem', rate: 'billRate', weight: 'newWeight',
        pending: () => PurchaseManager.getWeights() || [],
        loadRates: () => BillingManager.loadRates()
    },
    sale: {
        mic: 'voiceMicSale', item: 'saleItem', rate: 'saleRate', weight: 'saleWeight',
        pending: () => RetailSaleManager.getSaleWeights() || [],
        loadRates: () => BillingManager.loadSaleRates()
    }
};

const LISTEN_TIMEOUT_MS = 15000;

/** Error codes of both engines → message key ('' = say nothing, the user stopped it). */
export function voiceErrorKey(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'aborted') return '';
    if (c.includes('no-speech') || c.includes('no speech') || c.includes('no match')) return 'msg.voice.no_speech';
    if (c.includes('not-allowed') || c.includes('permission') || c.includes('audio-capture')) return 'msg.voice.mic_denied';
    if (c.includes('network')) return 'msg.voice.offline';
    if (c.includes('unavailable') || c.includes('not available')) return 'msg.voice.unavailable';
    return 'msg.voice.failed';
}

/** Browser Web Speech API (Chrome): one utterance, up to 3 alternatives. */
export function listenWeb(lang, win = window) {
    return new Promise((resolve, reject) => {
        const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
        if (!Ctor) { reject(new Error('unavailable')); return; }
        const rec = new Ctor();
        rec.lang = lang;
        rec.continuous = false;
        rec.interimResults = false;
        rec.maxAlternatives = 3;
        const heard = [];
        let done = false;
        let timer = null;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            fn(value);
        };
        timer = setTimeout(() => {
            try { rec.abort(); } catch { /* already stopped */ }
            finish(resolve, heard);
        }, LISTEN_TIMEOUT_MS);
        rec.onresult = (e) => {
            for (let i = e.resultIndex || 0; i < e.results.length; i++) {
                for (let k = 0; k < e.results[i].length; k++) heard.push(e.results[i][k].transcript);
            }
        };
        rec.onerror = (e) => finish(reject, new Error(e?.error || 'failed'));
        rec.onend = () => finish(resolve, heard);
        try { rec.start(); } catch (e) { finish(reject, e); }
    });
}

/** Android app: the phone's own recogniser through @capacitor-community/speech-recognition. */
export async function listenNative(lang, plugin) {
    if (!plugin) throw new Error('unavailable');
    const { available } = await plugin.available();
    if (!available) throw new Error('unavailable');
    let perm = await plugin.checkPermissions();
    if (perm?.speechRecognition !== 'granted') perm = await plugin.requestPermissions();
    if (perm?.speechRecognition !== 'granted') throw new Error('not-allowed');
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            Promise.resolve(plugin.stop?.()).catch(() => {});
            reject(new Error('no-speech'));
        }, LISTEN_TIMEOUT_MS);
    });
    try {
        const res = await Promise.race([plugin.start({ language: lang, maxResults: 3, partialResults: false, popup: false }), timeout]);
        return res?.matches || [];
    } finally {
        clearTimeout(timer);
    }
}

const byId = (id) => document.getElementById(id);
const itemLabel = (item) => (AppState.settings?.showHindi && item.hindiName ? item.hindiName : item.name) || '';

export const VoiceBilling = {
    busy: false,

    /**
     * One mic tap: listen, check, fill.
     * @param {'purchase'|'sale'} mode
     * @param {'native'|'web'} engine
     * @returns {Promise<boolean>} true when the line was filled
     */
    async listenOnce(mode, engine) {
        const f = FIELDS[mode === 'sale' ? 'sale' : 'purchase'];
        if (this.busy) return false;
        this.busy = true;
        const mic = byId(f.mic);
        mic?.classList.add('voice-listening');
        mic?.setAttribute('aria-busy', 'true');
        UIManager.showToast(t('msg.voice.listening'));
        try {
            const lang = getLang() === 'hi' ? 'hi-IN' : 'en-IN';
            const heard = engine === 'native'
                ? await listenNative(lang, window.Capacitor?.Plugins?.SpeechRecognition)
                : await listenWeb(lang);
            mic?.classList.remove('voice-listening');
            if (!heard.some(h => String(h || '').trim())) {
                UIManager.showToast(t('msg.voice.no_speech'));
                return false;
            }
            const line = pickVoiceLine(heard, AppState.items);
            if (!hasVoiceValues(line)) {
                UIManager.showToast(t('msg.voice.not_understood', { heard: line.heard }), 4000);
                return false;
            }
            const item = line.itemIndex !== null ? AppState.items[line.itemIndex] : null;
            const ok = await UIManager.showModalWithHtml(this.previewHtml(line, item), t('ui.voice.check_title'), true);
            return ok ? this.fill(f, line, item) : false;
        } catch (e) {
            const key = voiceErrorKey(e?.message || e);
            if (key) UIManager.showToast(t(key), 4000);
            return false;
        } finally {
            this.busy = false;
            mic?.classList.remove('voice-listening');
            mic?.removeAttribute('aria-busy');
        }
    },

    /** The check dialog: what was heard and what will be filled. */
    previewHtml(line, item) {
        const esc = (s) => Helpers.escapeHtml(String(s));
        const missing = `<em>${esc(t('ui.voice.not_heard'))}</em>`;
        const row = (label, value) => `<tr><th scope="row">${esc(label)}</th><td>${value}</td></tr>`;
        return `<p class="voice-heard">${esc(t('ui.voice.heard'))} <q>${esc(line.heard)}</q></p>`
            + '<table class="voice-check">'
            + row(t('ui.common.item'), item ? esc(itemLabel(item)) : missing)
            + row(t('ui.billing.weight_kg'), line.weight !== null ? esc(line.weight) : missing)
            + row(t('ui.billing.rate'), line.rate !== null ? esc(line.rate) : missing)
            + '</table>'
            + (line.extraNumbers ? `<p class="voice-warn">${esc(t('ui.voice.extra_numbers'))}</p>` : '')
            + `<p class="voice-note">${esc(t('ui.voice.check_note', { ok: t('ui.modals.ok'), add: t('ui.common.add_bill') }))}</p>`;
    },

    /**
     * Puts the checked values in the form; the user still taps Add to Bill and Save.
     * The item is found again by identity: the list can change while the dialog is open.
     */
    fill(f, line, item) {
        const select = byId(f.item);
        if (item) {
            const at = AppState.items.findIndex(i => i === item || (item.id && i?.id === item.id));
            const want = String(at);
            if (at === -1 || !select || ![...select.options].some(o => o.value === want)) {
                UIManager.showToast(t('msg.voice.item_changed'), 4000);
                return false;
            }
            if (select.value !== want) {
                if (f.pending().length > 0) {
                    UIManager.showToast(t('msg.voice.finish_weights'), 4000);
                    return false;
                }
                select.value = want;
                f.loadRates();
            }
        }
        const rate = byId(f.rate);
        if (rate && line.rate !== null) rate.value = String(line.rate);
        const weight = byId(f.weight);
        if (weight && line.weight !== null) weight.value = String(line.weight);
        BillingManager.triggerAutoSave?.();
        UIManager.showToast(t('msg.voice.filled', { add: t('ui.common.add_bill') }), 4000);
        return true;
    }
};
