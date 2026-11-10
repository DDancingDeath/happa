/**
 * @fileoverview Voice billing (#81): listens once, shows what was heard (and reads it
 * back aloud) and acts only after the user taps OK: one line fills the purchase /
 * retail form, several lines are added to the bill, a customer name fills the
 * customer box. A line can be corrected in the dialog, what was heard stays on screen,
 * and the last voice change can be undone (#131). It never saves; nothing heard is stored.
 * Loaded with import() on the first mic tap (ui/voice-mic.js). Design and limits:
 * docs/voice-billing.md.
 * @module modules/voice-billing
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t, getLang } from '../i18n/index.js';
import { pickVoiceBill, hasVoiceBillValues, isUndoCommand } from '../utils/voice-parse.js';
import { createVoiceUndo, planUndo, fieldChanges } from '../utils/voice-undo.js';
import { isArchivedItem } from '../utils/item-catalog.js';
import { safeSetItem } from '../utils/storage-full.js';
import { track, trackVoiceMiss } from '../services/usage.js';
import { on, BILL_CLEARED } from '../utils/events.js';
import { VoiceMic } from '../ui/voice-mic.js';
import { BillingManager, PurchaseManager, RetailSaleManager } from './billing.js';

const FIELDS = {
    purchase: {
        mic: 'voiceMicPurchase', item: 'billItem', rate: 'billRate', weight: 'newWeight',
        customer: 'customerName', customerNames: 'customerOptions',
        transcript: 'voiceTranscriptPurchase', undo: 'voiceUndoPurchase', lock: 'purchase',
        editing: () => !!PurchaseManager.isEditingLine?.(),
        pending: () => PurchaseManager.getWeights() || [],
        loadRates: () => BillingManager.loadRates(),
        addLine: () => PurchaseManager.addToBill(),
        lines: () => PurchaseManager.getBillItems() || [],
        removeLine: (i) => PurchaseManager.deleteBillItem(i),
        lineCount: () => (PurchaseManager.getBillItems() || []).length
    },
    sale: {
        mic: 'voiceMicSale', item: 'saleItem', rate: 'saleRate', weight: 'saleWeight',
        customer: 'saleCustomerName', customerNames: 'saleCustomerOptions',
        transcript: 'voiceTranscriptSale', undo: 'voiceUndoSale', lock: 'retail',
        editing: () => !!RetailSaleManager.isEditingLine?.(),
        pending: () => RetailSaleManager.getSaleWeights() || [],
        loadRates: () => BillingManager.loadSaleRates(),
        addLine: () => RetailSaleManager.addToSalesBill(),
        lines: () => RetailSaleManager.getSaleItems() || [],
        removeLine: (i) => RetailSaleManager.removeSaleItem(i),
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

let audio = null;

/**
 * A short tone after listening (#131), when switched on in Settings: high when something was
 * understood, low when not. Web Audio on this device; nothing is recorded or sent.
 * @param {'ok'|'fail'} kind
 * @returns {boolean} true when a tone was played
 */
export function beep(kind, win = window) {
    if (!VoiceMic.beepOn()) return false;
    try {
        const Ctx = win.AudioContext || win.webkitAudioContext;
        if (typeof Ctx !== 'function') return false;
        audio = audio || new Ctx();
        audio.resume?.()?.catch?.(() => {});
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = kind === 'ok' ? 880 : 220;
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(audio.destination);
        const start = audio.currentTime || 0;
        osc.start(start);
        osc.stop(start + (kind === 'ok' ? 0.12 : 0.3));
        return true;
    } catch {
        return false;
    }
}

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
const formKey = (mode) => (mode === 'sale' ? 'sale' : 'purchase');
const boxes = (f) => ({
    customer: String(byId(f.customer)?.value ?? ''), item: String(byId(f.item)?.value ?? ''),
    rate: String(byId(f.rate)?.value ?? ''), weight: String(byId(f.weight)?.value ?? '')
});
/** A typed correction: a positive number, else not heard. */
const typedNumber = (v) => {
    const text = String(v ?? '').trim();
    const n = Number(text.replace(',', '.'));
    return text !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

export const VoiceBilling = {
    busy: false,
    /** @type {?{text: string, lang: string}} what the open check dialog reads aloud */
    spoken: null,
    /** Voice changes per form, last first (#131). */
    undo: { purchase: createVoiceUndo(), sale: createVoiceUndo() },
    /** @type {?{lines: Array, items: Array}} the open check dialog's lines and the item list it offers */
    checking: null,
    /** What the current action heard, for the transcript strip. */
    heardNow: '',

    /**
     * One mic tap: listen, check (and read back), then fill or add.
     * @param {'purchase'|'sale'} mode
     * @param {'native'|'web'} engine
     * @returns {Promise<boolean>} true when something was filled or added
     */
    async listenOnce(mode, engine) {
        const key = formKey(mode);
        const f = FIELDS[key];
        if (this.busy) return false;
        this.busy = true;
        this.heardNow = '';
        const mic = byId(f.mic);
        mic?.classList.add('voice-listening');
        mic?.setAttribute('aria-busy', 'true');
        UIManager.showToast(t('msg.voice.listening'));
        this.setStrip(f, '', t('msg.voice.listening'));
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
                beep('fail');
                this.setStrip(f, '', t('msg.voice.no_speech'));
                UIManager.showToast(t('msg.voice.no_speech'));
                return false;
            }
            if (isUndoCommand(heard)) {
                beep('ok');
                this.heardNow = String(heard.find(h => String(h || '').trim())).trim();
                this.undoLast(key, true);
                return false;
            }
            const known = [...(byId(f.customerNames)?.options || [])].map(o => o.value).filter(Boolean);
            const bill = pickVoiceBill(heard, AppState.items, known);
            this.heardNow = bill.heard;
            if (!hasVoiceBillValues(bill)) {
                beep('fail');
                trackVoiceMiss(bill.heard);
                this.tell(f, t('msg.voice.not_understood', { heard: bill.heard }), 4000);
                return false;
            }
            beep('ok');
            this.setStrip(f, bill.heard, t('ui.voice.strip_check'));
            const lines = bill.lines.filter(l => l.itemIndex !== null || l.weight !== null || l.rate !== null)
                .map(l => ({ ...l, item: lineItem(l) }));
            const current = String(byId(f.customer)?.value || '').trim();
            const readback = !!localVoice(lang) && this.readbackText(bill.customer, lines);
            this.checking = { lines, items: AppState.items.slice() };
            const asked = UIManager.showModalWithHtml(this.previewHtml(bill, lines, current, !!readback), t('ui.voice.check_title'), true);
            this.spoken = readback ? { text: readback, lang } : null;
            if (this.spoken) Readback.speak(this.spoken.text, lang);
            const ok = await asked;
            this.spoken = null;
            Readback.stop();
            if (!ok) {
                this.setStrip(f, bill.heard, t('ui.voice.strip_cancelled'));
                return false;
            }
            if (Helpers.isBusy(f.lock)) {
                this.tell(f, t('msg.voice.finish_saving'), 4000);
                return false;
            }
            const used = lines.map((line, i) => this.correctedLine(line, i));
            if (used.some(l => l.edited)) track('voice.edit');
            const before = boxes(f);
            const linesBefore = f.lines().slice();
            try {
                return await this.apply(f, bill, used);
            } finally {
                const added = f.lines().filter(l => !linesBefore.includes(l));
                if (this.undo[key].push({ lines: added, fields: fieldChanges(before, boxes(f)) })) this.refreshUndo(key);
            }
        } catch (e) {
            const errKey = voiceErrorKey(e?.message || e);
            if (errKey) {
                beep('fail');
                this.setStrip(f, this.heardNow, t(errKey));
                UIManager.showToast(t(errKey), 4000);
            }
            return false;
        } finally {
            this.busy = false;
            this.spoken = null;
            this.checking = null;
            mic?.classList.remove('voice-listening');
            mic?.removeAttribute('aria-busy');
        }
    },

    /** After OK: the customer, then one line in the form or the ticked lines on the bill. */
    async apply(f, bill, lines) {
        const ticked = (el, fallback) => (el ? !!el.checked : fallback);
        const name = bill.customer && ticked(byId('voiceCustomerTick'), true) ? bill.customer : null;
        if (name && byId(f.customer)) {
            byId(f.customer).value = name;
            BillingManager.triggerAutoSave?.();
        }
        if (lines.length === 0) {
            if (name) this.tell(f, t('msg.voice.customer_filled', { name }), 4000);
            return !!name;
        }
        if (lines.length === 1) return this.fill(f, lines[0], lines[0].item) || !!name;
        const chosen = lines.filter((l, i) => complete(l) && ticked(document.querySelector(`[data-voice-line="${i}"]`), true));
        if (chosen.length === 0) {
            this.tell(f, t(name ? 'msg.voice.customer_filled' : 'msg.voice.nothing_added', { name }), 4000);
            return !!name;
        }
        return (await this.addLines(f, chosen)) || !!name;
    },

    /** A toast that also goes in the transcript strip, after what was heard. */
    tell(f, message, ms) {
        this.setStrip(f, this.heardNow, message);
        UIManager.showToast(message, ms);
    },

    /** The transcript strip under the mic (aria-live): what was heard and what came of it. */
    setStrip(f, heard, status) {
        const el = byId(f.transcript);
        if (!el) return;
        el.textContent = [heard ? t('ui.voice.transcript', { heard }) : '', status || ''].filter(Boolean).join(' ');
    },

    /** The Undo button shows while this form has a voice change to undo. */
    refreshUndo(mode) {
        const key = formKey(mode);
        const btn = byId(FIELDS[key].undo);
        if (btn) btn.hidden = this.undo[key].size === 0;
    },

    /**
     * Undoes the form's last voice change (the Undo button, or "undo" / "वापस" said): removes
     * the lines it added and puts back the boxes it filled, where they are still as voice left them.
     * @param {'purchase'|'sale'} mode
     * @param {boolean} [spoken] said into the mic (the listen is already running)
     * @returns {boolean} true when something was undone
     */
    undoLast(mode, spoken = false) {
        const key = formKey(mode);
        const f = FIELDS[key];
        if (this.busy && !spoken) return false;
        if (!spoken) this.heardNow = '';
        if (Helpers.isBusy(f.lock)) {
            this.tell(f, t('msg.voice.finish_saving'), 4000);
            return false;
        }
        const plan = planUndo(this.undo[key].peek(), { lines: f.lines(), fields: boxes(f) });
        if (('item' in plan.restore || 'rate' in plan.restore) && (f.pending().length > 0 || f.editing())) {
            this.tell(f, t('msg.voice.finish_weights'), 4000);
            return false;
        }
        this.undo[key].pop();
        this.refreshUndo(key);
        if (!plan.any) {
            this.tell(f, t('msg.voice.undo_none'), 4000);
            return false;
        }
        plan.removeAt.forEach(i => f.removeLine(i));
        const set = (id, v) => { const el = byId(id); if (el) el.value = v; };
        if ('customer' in plan.restore) set(f.customer, plan.restore.customer);
        if ('item' in plan.restore) {
            const rate = String(byId(f.rate)?.value ?? '');
            set(f.item, plan.restore.item);
            f.loadRates();
            set(f.rate, 'rate' in plan.restore ? plan.restore.rate : rate);
        } else if ('rate' in plan.restore) set(f.rate, plan.restore.rate);
        if ('weight' in plan.restore) set(f.weight, plan.restore.weight);
        BillingManager.triggerAutoSave?.();
        track('voice.undo');
        this.tell(f, t(plan.kept ? 'msg.voice.undo_partly' : 'msg.voice.undone'), 4000);
        return true;
    },

    /** The dialog's line i, with what was typed in its Correct boxes (when changed). */
    correctedLine(line, i) {
        const box = document.querySelector(`[data-voice-edit="${i}"]`);
        if (!box || box.dataset.changed !== '1') return line;
        const items = this.checking?.items || AppState.items;
        const pick = box.querySelector('[data-voice-field="item"]')?.value ?? '';
        const item = pick === '' ? null : items[Number(pick)] || null;
        return {
            ...line,
            itemIndex: item ? Number(pick) : null,
            item,
            weight: typedNumber(box.querySelector('[data-voice-field="weight"]')?.value),
            rate: typedNumber(box.querySelector('[data-voice-field="rate"]')?.value),
            extraNumbers: false,
            rateUnusual: false,
            edited: true
        };
    },

    /** Opens or closes line i's Correct boxes in the check dialog. */
    editLine(i) {
        const n = Number(i);
        const box = document.querySelector(`[data-voice-edit="${n}"]`);
        if (!box) return;
        box.hidden = !box.hidden;
        document.querySelector(`[data-voice-edit-btn="${n}"]`)?.setAttribute('aria-expanded', String(!box.hidden));
        if (!box.hidden) box.querySelector('select, input')?.focus();
    },

    /** A Correct box changed: the row shows the new values, and a line now complete can be ticked. */
    lineChanged(i) {
        const n = Number(i);
        const box = document.querySelector(`[data-voice-edit="${n}"]`);
        const line = this.checking?.lines?.[n];
        if (!box || !line) return;
        box.dataset.changed = '1';
        const now = this.correctedLine(line, n);
        const row = document.querySelector(`[data-voice-row="${n}"]`);
        const cell = (name, v) => {
            const c = row?.querySelector(`[data-voice-cell="${name}"]`);
            if (!c) return;
            if (v !== null && v !== '') {
                c.textContent = String(v);
                return;
            }
            const em = document.createElement('em');
            em.textContent = t('ui.voice.not_heard');
            c.replaceChildren(em);
        };
        cell('item', now.item ? itemLabel(now.item) : null);
        cell('weight', now.weight);
        cell('rate', now.rate);
        const ok = complete(now);
        const tick = document.querySelector(`[data-voice-line="${n}"]`);
        if (tick) {
            if (ok && tick.disabled) tick.checked = true;
            if (!ok) tick.checked = false;
            tick.disabled = !ok;
        }
        const note = document.querySelector(`[data-voice-incomplete="${n}"]`);
        if (note) note.hidden = ok;
        document.querySelectorAll(`[data-voice-warn="${n}"]`).forEach(w => { w.hidden = true; });
    },

    /** Line i's Correct boxes: item, weight (kg) and rate, filled with what was heard. */
    editorHtml(line, i) {
        const esc = (s) => Helpers.escapeHtml(String(s));
        const items = this.checking?.items || AppState.items;
        const options = [`<option value="">${esc(t('ui.voice.pick_item'))}</option>`];
        items.forEach((it, k) => {
            if (!it || (isArchivedItem(it) && k !== line.itemIndex)) return;
            options.push(`<option value="${esc(k)}"${k === line.itemIndex ? ' selected' : ''}>${esc(itemLabel(it))}</option>`);
        });
        const num = (field, label, v) => `<label class="field voice-edit-field"><span>${esc(label)}</span>`
            + `<input class="input" type="number" inputmode="decimal" min="0" step="any" data-voice-field="${esc(field)}" value="${v !== null ? esc(v) : ''}" data-oninput="voice.lineChanged(${esc(i)})"></label>`;
        return `<div class="voice-edit" id="voiceEdit${esc(i)}" data-voice-edit="${esc(i)}" hidden>`
            + `<label class="field voice-edit-field"><span>${esc(head('ui.common.item'))}</span>`
            + `<select class="input" data-voice-field="item" data-onchange="voice.lineChanged(${esc(i)})">${options.join('')}</select></label>`
            + num('weight', head('ui.billing.weight_kg'), line.weight)
            + num('rate', head('ui.billing.rate'), line.rate)
            + '</div>';
    },

    /** The button that opens line i's Correct boxes. */
    editButtonHtml(i) {
        const esc = (s) => Helpers.escapeHtml(String(s));
        return `<button type="button" class="btn btn-ghost btn-sm voice-edit-btn" data-voice-edit-btn="${esc(i)}" aria-expanded="false" `
            + `aria-controls="voiceEdit${esc(i)}" data-onclick="voice.editLine(${esc(i)})">${esc(t('ui.voice.correct'))}</button>`;
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
        const warns = (line, i) => (line.extraNumbers ? `<p class="voice-warn" data-voice-warn="${esc(i)}">${esc(t('ui.voice.extra_numbers'))}</p>` : '')
            + (line.rateUnusual ? `<p class="voice-warn" data-voice-warn="${esc(i)}">${esc(t('ui.voice.rate_unusual'))}</p>` : '');
        let html = `<div id="voiceCheck" class="voice-dialog"><p class="voice-heard">${esc(t('ui.voice.heard'))} <q>${esc(bill.heard)}</q></p>`;
        if (bill.customer) {
            html += `<p class="voice-customer"><label><input type="checkbox" id="voiceCustomerTick" checked> ${esc(t('ui.voice.customer_fill'))} <strong>${esc(bill.customer)}</strong></label></p>`;
            if (currentCustomer && currentCustomer !== bill.customer) html += `<p class="voice-warn">${esc(t('ui.voice.customer_replaces', { name: currentCustomer }))}</p>`;
        }
        if (lines.length === 1) {
            const [line] = lines;
            const row = (label, name, value) => `<tr><th scope="row">${esc(label)}</th><td data-voice-cell="${esc(name)}">${value}</td></tr>`;
            html += '<table class="voice-check"><tbody data-voice-row="0">'
                + row(t('ui.common.item'), 'item', line.item ? esc(itemLabel(line.item)) : missing)
                + row(t('ui.billing.weight_kg'), 'weight', val(line.weight))
                + row(t('ui.billing.rate'), 'rate', val(line.rate))
                + '</tbody></table>' + warns(line, 0)
                + `<p class="voice-edit-bar">${this.editButtonHtml(0)}</p>` + this.editorHtml(line, 0)
                + `<p class="voice-note">${esc(t('ui.voice.check_note', { ok: t('ui.modals.ok'), add: t('ui.common.add_bill') }))}</p>`;
        } else if (lines.length > 1) {
            html += `<table class="voice-check voice-lines"><thead><tr><th scope="col">${esc(t('ui.voice.tick_head'))}</th>`
                + `<th scope="col">${esc(head('ui.common.item'))}</th><th scope="col">${esc(head('ui.billing.weight_kg'))}</th><th scope="col">${esc(head('ui.billing.rate'))}</th>`
                + `<th scope="col">${esc(t('ui.voice.correct_head'))}</th></tr></thead>`;
            lines.forEach((line, i) => {
                const ok = complete(line);
                html += `<tbody data-voice-row="${esc(i)}"><tr><td><input type="checkbox" data-voice-line="${esc(i)}" aria-label="${esc(t('ui.voice.tick_line'))}"${ok ? ' checked' : ' disabled'}></td>`
                    + `<td data-voice-cell="item">${line.item ? esc(itemLabel(line.item)) : missing}</td><td data-voice-cell="weight">${val(line.weight)}</td><td data-voice-cell="rate">${val(line.rate)}</td>`
                    + `<td>${this.editButtonHtml(i)}</td></tr>`;
                const notes = (ok ? '' : `<p class="voice-warn" data-voice-incomplete="${esc(i)}">${esc(t('ui.voice.line_incomplete'))}</p>`) + warns(line, i);
                html += `<tr class="voice-line-notes"><td></td><td colspan="4">${notes}${this.editorHtml(line, i)}</td></tr></tbody>`;
            });
            html += '</table>'
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
            this.tell(f, t('msg.voice.item_changed'), 4000);
            return false;
        }
        if (select.value !== want) {
            if (f.pending().length > 0) {
                this.tell(f, t('msg.voice.finish_weights'), 4000);
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
        this.tell(f, t('msg.voice.filled', { add: t('ui.common.add_bill') }), 4000);
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
            this.tell(f, t('msg.voice.finish_weights'), 4000);
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
                this.tell(f, t('msg.voice.lines_stopped', { n: added, total: lines.length, add: t('ui.common.add_bill') }), 6000);
                return added > 0;
            }
            added++;
        }
        this.tell(f, t('msg.voice.lines_added', { n: added }), 4000);
        return true;
    }
};

// A saved or cleared bill ends its voice changes: Undo is never offered across bills.
on(BILL_CLEARED, (mode) => {
    VoiceBilling.undo[formKey(mode)].clear();
    VoiceBilling.refreshUndo(mode);
});
