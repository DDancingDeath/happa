/**
 * @fileoverview Voice billing (#81): listens once, shows what was heard (and reads it
 * back aloud) and acts only after the user taps OK: one line fills the purchase /
 * retail form, several lines are added to the bill, a customer name fills the
 * customer box. It never saves; nothing heard is stored. Loaded with import() on the
 * first mic tap (ui/voice-mic.js). Design and limits: docs/voice-billing.md.
 * @module modules/voice-billing
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t, getLang } from '../i18n/index.js';
import { pickVoiceBill, hasVoiceBillValues } from '../utils/voice-parse.js';
import { safeSetItem } from '../utils/storage-full.js';
import { BillingManager, PurchaseManager, RetailSaleManager } from './billing.js';

const FIELDS = {
    purchase: {
        mic: 'voiceMicPurchase', item: 'billItem', rate: 'billRate', weight: 'newWeight',
        customer: 'customerName', customerNames: 'customerOptions',
        pending: () => PurchaseManager.getWeights() || [],
        loadRates: () => BillingManager.loadRates(),
        addLine: () => PurchaseManager.addToBill(),
        lineCount: () => (PurchaseManager.getBillItems() || []).length
    },
    sale: {
        mic: 'voiceMicSale', item: 'saleItem', rate: 'saleRate', weight: 'saleWeight',
        customer: 'saleCustomerName', customerNames: 'saleCustomerOptions',
        pending: () => RetailSaleManager.getSaleWeights() || [],
        loadRates: () => BillingManager.loadSaleRates(),
        addLine: () => RetailSaleManager.addToSalesBill(),
        lineCount: () => (RetailSaleManager.getSaleItems() || []).length
    }
};

export const READBACK_KEY = 'aadhat.voiceReadback';

/**
 * Spoken readback (#81 A1) with the browser's speechSynthesis, only through a voice on
 * this device (`localService`): a network voice (Chrome's "Google …" voices) would send
 * the text to a server. None for the language (the Android WebView often has no
 * speechSynthesis or no voices): nothing is said and the switch is hidden.
 * @param {string} lang 'hi-IN' or 'en-IN'
 * @param {any} [win]
 * @returns {?SpeechSynthesisVoice}
 */
export function localVoice(lang, win = window) {
    try {
        const synth = win.speechSynthesis;
        if (typeof synth?.speak !== 'function' || typeof win.SpeechSynthesisUtterance !== 'function') return null;
        const want = String(lang || '').toLowerCase();
        const tag = (v) => String(v.lang || '').replace('_', '-').toLowerCase();
        const voices = (synth.getVoices?.() || []).filter(v => v && v.localService === true);
        return voices.find(v => tag(v) === want) || voices.find(v => tag(v).split('-')[0] === want.split('-')[0]) || null;
    } catch {
        return null;
    }
}

export const Readback = {
    /** On unless muted on this device. */
    isOn() {
        try { return localStorage.getItem(READBACK_KEY) !== '0'; } catch { return true; }
    },

    setOn(on) {
        safeSetItem(READBACK_KEY, on ? '1' : '0');
        if (!on) this.stop();
    },

    /** @returns {boolean} true when it was handed to an on-device voice */
    speak(text, lang, win = window) {
        if (!text || !this.isOn()) return false;
        const voice = localVoice(lang, win);
        if (!voice) return false;
        try {
            const synth = win.speechSynthesis;
            synth.cancel();
            const u = new win.SpeechSynthesisUtterance(text);
            u.lang = lang;
            u.voice = voice;
            synth.speak(u);
            return true;
        } catch {
            return false;
        }
    },

    stop(win = window) {
        try { win.speechSynthesis?.cancel?.(); } catch { /* nothing to stop */ }
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
/** Readback names the item in the language it is spoken in. */
const spokenLabel = (item) => (getLang() === 'hi' && item.hindiName ? item.hindiName : item.name) || '';
/** Column heads reuse the form labels without their colon. */
const head = (key) => t(key).replace(/\s*[:：]\s*$/, '');
const lineItem = (line) => (line.itemIndex !== null ? AppState.items[line.itemIndex] : null);
const complete = (line) => line.itemIndex !== null && line.weight !== null && line.rate !== null;

export const VoiceBilling = {
    busy: false,
    /** @type {?{text: string, lang: string}} what the open check dialog reads aloud */
    spoken: null,

    /**
     * One mic tap: listen, check (and read back), then fill or add.
     * @param {'purchase'|'sale'} mode
     * @param {'native'|'web'} engine
     * @returns {Promise<boolean>} true when something was filled or added
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
            // Chrome loads its voice list on first ask; by the time speech is heard it is there
            try { window.speechSynthesis?.getVoices?.(); } catch { /* no speech synthesis */ }
            const lang = getLang() === 'hi' ? 'hi-IN' : 'en-IN';
            const heard = engine === 'native'
                ? await listenNative(lang, window.Capacitor?.Plugins?.SpeechRecognition)
                : await listenWeb(lang);
            mic?.classList.remove('voice-listening');
            const toast = byId('toast');
            if (toast?.textContent === t('msg.voice.listening')) toast.classList.remove('show');
            if (!heard.some(h => String(h || '').trim())) {
                UIManager.showToast(t('msg.voice.no_speech'));
                return false;
            }
            const known = [...(byId(f.customerNames)?.options || [])].map(o => o.value).filter(Boolean);
            const bill = pickVoiceBill(heard, AppState.items, known);
            if (!hasVoiceBillValues(bill)) {
                UIManager.showToast(t('msg.voice.not_understood', { heard: bill.heard }), 4000);
                return false;
            }
            const lines = bill.lines.filter(l => l.itemIndex !== null || l.weight !== null || l.rate !== null)
                .map(l => ({ ...l, item: lineItem(l) }));
            const current = String(byId(f.customer)?.value || '').trim();
            const readback = !!localVoice(lang) && this.readbackText(bill.customer, lines);
            const asked = UIManager.showModalWithHtml(this.previewHtml(bill, lines, current, !!readback), t('ui.voice.check_title'), true);
            this.spoken = readback ? { text: readback, lang } : null;
            if (this.spoken) Readback.speak(this.spoken.text, lang);
            const ok = await asked;
            this.spoken = null;
            Readback.stop();
            if (!ok) return false;
            const ticked = (el, fallback) => (el ? !!el.checked : fallback);
            const name = bill.customer && ticked(byId('voiceCustomerTick'), true) ? bill.customer : null;
            if (name && byId(f.customer)) {
                byId(f.customer).value = name;
                BillingManager.triggerAutoSave?.();
            }
            if (lines.length === 0) {
                if (name) UIManager.showToast(t('msg.voice.customer_filled', { name }), 4000);
                return !!name;
            }
            if (lines.length === 1) return this.fill(f, lines[0], lines[0].item) || !!name;
            const chosen = lines.filter((l, i) => complete(l) && ticked(document.querySelector(`[data-voice-line="${i}"]`), true));
            if (chosen.length === 0) {
                UIManager.showToast(t(name ? 'msg.voice.customer_filled' : 'msg.voice.nothing_added', { name }), 4000);
                return !!name;
            }
            return (await this.addLines(f, chosen)) || !!name;
        } catch (e) {
            const key = voiceErrorKey(e?.message || e);
            if (key) UIManager.showToast(t(key), 4000);
            return false;
        } finally {
            this.busy = false;
            this.spoken = null;
            mic?.classList.remove('voice-listening');
            mic?.removeAttribute('aria-busy');
        }
    },

    /** The mute switch in the check dialog: per device, stops or restarts the readback. */
    setReadback(on) {
        Readback.setOn(!!on);
        if (on && this.spoken) Readback.speak(this.spoken.text, this.spoken.lang);
    },

    /** What the readback says: the customer, then each line's item, weight and rate as understood. */
    readbackText(customer, lines) {
        const parts = customer ? [t('ui.voice.say_customer', { name: customer })] : [];
        for (const line of lines) {
            const bits = [
                line.item ? spokenLabel(line.item) : '',
                line.weight !== null ? t('ui.voice.say_weight', { weight: line.weight }) : '',
                line.rate !== null ? t('ui.voice.say_rate', { rate: line.rate }) : ''
            ].filter(Boolean);
            if (bits.length) parts.push(bits.join(', '));
        }
        return parts.join('. ');
    },

    /** The check dialog: what was heard, the customer and the line(s) found. */
    previewHtml(bill, lines, currentCustomer = '', readback = false) {
        const esc = (s) => Helpers.escapeHtml(String(s));
        const missing = `<em>${esc(t('ui.voice.not_heard'))}</em>`;
        const val = (v) => (v !== null ? esc(v) : missing);
        const warns = (line) => (line.extraNumbers ? `<p class="voice-warn">${esc(t('ui.voice.extra_numbers'))}</p>` : '')
            + (line.rateUnusual ? `<p class="voice-warn">${esc(t('ui.voice.rate_unusual'))}</p>` : '');
        let html = `<div id="voiceCheck" class="voice-dialog"><p class="voice-heard">${esc(t('ui.voice.heard'))} <q>${esc(bill.heard)}</q></p>`;
        if (bill.customer) {
            html += `<p class="voice-customer"><label><input type="checkbox" id="voiceCustomerTick" checked> ${esc(t('ui.voice.customer_fill'))} <strong>${esc(bill.customer)}</strong></label></p>`;
            if (currentCustomer && currentCustomer !== bill.customer) html += `<p class="voice-warn">${esc(t('ui.voice.customer_replaces', { name: currentCustomer }))}</p>`;
        }
        if (lines.length === 1) {
            const [line] = lines;
            const row = (label, value) => `<tr><th scope="row">${esc(label)}</th><td>${value}</td></tr>`;
            html += '<table class="voice-check">'
                + row(t('ui.common.item'), line.item ? esc(itemLabel(line.item)) : missing)
                + row(t('ui.billing.weight_kg'), val(line.weight))
                + row(t('ui.billing.rate'), val(line.rate))
                + '</table>' + warns(line)
                + `<p class="voice-note">${esc(t('ui.voice.check_note', { ok: t('ui.modals.ok'), add: t('ui.common.add_bill') }))}</p>`;
        } else if (lines.length > 1) {
            html += `<table class="voice-check voice-lines"><thead><tr><th scope="col">${esc(t('ui.voice.tick_head'))}</th>`
                + `<th scope="col">${esc(head('ui.common.item'))}</th><th scope="col">${esc(head('ui.billing.weight_kg'))}</th><th scope="col">${esc(head('ui.billing.rate'))}</th></tr></thead><tbody>`;
            lines.forEach((line, i) => {
                const ok = complete(line);
                html += `<tr><td><input type="checkbox" data-voice-line="${esc(i)}" aria-label="${esc(t('ui.voice.tick_line'))}"${ok ? ' checked' : ' disabled'}></td>`
                    + `<td>${line.item ? esc(itemLabel(line.item)) : missing}</td><td>${val(line.weight)}</td><td>${val(line.rate)}</td></tr>`;
                const notes = (ok ? '' : `<p class="voice-warn">${esc(t('ui.voice.line_incomplete'))}</p>`) + warns(line);
                if (notes) html += `<tr class="voice-line-notes"><td></td><td colspan="3">${notes}</td></tr>`;
            });
            html += '</tbody></table>'
                + `<p class="voice-note">${esc(t('ui.voice.lines_note', { ok: t('ui.modals.ok') }))}</p>`;
        } else {
            html += `<p class="voice-note">${esc(t('ui.voice.customer_note', { ok: t('ui.modals.ok') }))}</p>`;
        }
        if (readback) {
            html += `<p class="voice-readback"><label><input type="checkbox" id="voiceReadback" data-onchange="voice.setReadback(this.checked)"${Readback.isOn() ? ' checked' : ''}> ${esc(t('ui.voice.readback'))}</label></p>`;
        }
        return html + '</div>';
    },

    /**
     * Picks the line's item in the form (found again by identity: the list can change
     * while the dialog is open). Refuses to move weights already entered for another item.
     * @returns {boolean}
     */
    selectItem(f, item) {
        if (!item) return true;
        const select = byId(f.item);
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
        return true;
    },

    /** Puts the checked values in the form; the user still taps Add to Bill and Save. */
    fill(f, line, item) {
        if (!this.selectItem(f, item)) return false;
        const rate = byId(f.rate);
        if (rate && line.rate !== null) rate.value = String(line.rate);
        const weight = byId(f.weight);
        if (weight && line.weight !== null) weight.value = String(line.weight);
        BillingManager.triggerAutoSave?.();
        UIManager.showToast(t('msg.voice.filled', { add: t('ui.common.add_bill') }), 4000);
        return true;
    },

    /**
     * Several lines (#81 A2): each ticked line goes through the form's own Add to Bill,
     * with its checks (bag weight, rate), one after another. A line those checks stop
     * stays in the form and the rest are not added. Never saves.
     * @returns {Promise<boolean>} true when at least one line was added
     */
    async addLines(f, lines) {
        if (f.pending().length > 0 || String(byId(f.weight)?.value || '').trim()) {
            UIManager.showToast(t('msg.voice.finish_weights'), 4000);
            return false;
        }
        let added = 0;
        for (const line of lines) {
            if (!this.selectItem(f, line.item)) return added > 0;
            byId(f.rate).value = String(line.rate);
            byId(f.weight).value = String(line.weight);
            const before = f.lineCount();
            await f.addLine();
            if (f.lineCount() === before) {
                UIManager.showToast(t('msg.voice.lines_stopped', { n: added, total: lines.length, add: t('ui.common.add_bill') }), 6000);
                return added > 0;
            }
            added++;
        }
        UIManager.showToast(t('msg.voice.lines_added', { n: added }), 4000);
        return true;
    }
};
