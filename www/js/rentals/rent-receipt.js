/**
 * @fileoverview Rent receipts (#170 phase 2): plain, non-GST receipt of one rent
 * payment (RENT-12) as WhatsApp text, a printer/image canvas and a PDF; the
 * tenant's receipts list (reprint) and void. Loaded with import() by
 * rentals.js only when a receipt is opened, so Rentals itself stays small.
 * Receipts are issued by rent-store.js recordPayment() with the payment.
 * @module rentals/rent-receipt
 */

import { t, getLang } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { UIManager } from '../ui/ui-manager.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { openExternal } from '../utils/open-external.js';
import { cleanText, whatsAppReminderUrl } from '../utils/due-reminder.js';
import { round2 } from '../utils/money.js';
import { monthLabel, dateLabel, PAYMENT_MODES } from './rent-math.js';
import { typedPlace, UNIT_TYPES } from './rent-views.js';
import * as store from './rent-store.js';

const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);

/** ₹ with paise when there are any (a receipt shows exact amounts). */
export const inr = (n) => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(round2(Number(n) || 0));

/** "Flat 2B, Gupta Bhawan" in `lang` (the type word is stored as an id). */
export function receiptPlace(r, lang = getLang()) {
    const word = UNIT_TYPES.includes(r?.ut) ? t(`ui.rent.uword_${r.ut}`, null, lang) : '';
    return typedPlace(word, cleanText(r?.place), '');
}

/** Paid before this payment: total − paid now − balance (never below 0). */
export const paidEarlier = (r) => Math.max(0, round2((Number(r.total) || 0) - (Number(r.paid) || 0) - (Number(r.balance) || 0)));

/**
 * The receipt's amount lines in one language (RENT-12): [label, value, bold].
 * Electricity lines only when the month has a meter bill.
 */
export function receiptRows(r, lang = getLang()) {
    const tr = (k, p) => t(k, p, lang);
    const e = r.elec;
    const mode = PAYMENT_MODES.includes(r.mode) ? r.mode : 'cash';
    const rows = [
        [tr('ui.rcpt.months'), (r.months || []).map(m => monthLabel(m, lang)).join(', ')],
        [tr('ui.rcpt.rent'), inr(r.rent)]
    ];
    if (e && typeof e === 'object') {
        rows.push(
            [tr('ui.rcpt.reading'), tr('ui.rcpt.reading_value', { prev: e.prev, curr: e.curr })],
            [tr('ui.rcpt.units'), tr('ui.rcpt.units_value', { units: e.units, rate: inr(e.rate) })],
            [tr('ui.rcpt.electricity'), inr(e.amount)]
        );
    }
    rows.push([tr('ui.rcpt.total'), inr(r.total), true]);
    if (paidEarlier(r) > 0) rows.push([tr('ui.rcpt.paid_earlier'), inr(paidEarlier(r))]);
    rows.push(
        [tr('ui.rcpt.paid_now'), inr(r.paid), true],
        [tr('ui.rcpt.mode'), tr(`ui.rcpt.mode_${mode}`)],
        [tr('ui.rcpt.balance'), inr(r.balance), true]
    );
    return rows;
}

/** Header lines: business, address, receipt no., date, tenant, place. */
function headLines(r, lang) {
    return {
        biz: cleanText(r.biz),
        addr: cleanText(r.bizAddr),
        title: t('ui.rcpt.title', { no: r.no }, lang),
        date: t('ui.rcpt.date_value', { date: dateLabel(r.date) }, lang),
        tenant: t('ui.rcpt.tenant_value', { name: cleanText(r.tenantName) }, lang),
        place: receiptPlace(r, lang),
        by: t('ui.rcpt.received_by', { name: cleanText(r.byName) }, lang)
    };
}

/**
 * WhatsApp receipt in the app language only; stored text is cleaned so a name
 * can't add WhatsApp formatting or lines. The tenant link is added when on.
 */
export function buildReceiptText(r, { lang = getLang(), link = '' } = {}) {
    const h = headLines(r, lang);
    const lines = [];
    if (r.void) lines.push(`*${t('ui.rcpt.void_mark', null, lang)}*`);
    lines.push(`🧾 *${h.title}*`);
    if (h.biz) lines.push(h.biz);
    if (h.addr) lines.push(h.addr);
    lines.push(h.date, '', h.tenant);
    if (h.place) lines.push(`🏠 ${h.place}`);
    lines.push('');
    receiptRows(r, lang).forEach(([k, v, bold]) => lines.push(bold ? `*${k}: ${v}*` : `${k}: ${v}`));
    lines.push('', h.by);
    if (link) lines.push('', t('ui.rcpt.link', { url: link }, lang));
    lines.push('', t('ui.rcpt.thanks', null, lang));
    return lines.join('\n');
}

/** The receipt on a 384 px (58 mm printer) canvas, cropped to its height. */
export function drawReceipt(r, lang = getLang(), doc = document) {
    const W = 384;
    const canvas = doc.createElement('canvas');
    canvas.width = W;
    canvas.height = 1400;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, canvas.height);
    ctx.fillStyle = '#000000';
    let y = 28;
    const font = (size, bold) => { ctx.font = `${bold ? 'bold ' : ''}${size}px Arial`; };
    const wrap = (text, max) => {
        const out = [];
        let line = '';
        String(text).split(' ').forEach(w => {
            const next = line ? `${line} ${w}` : w;
            if (line && ctx.measureText(next).width > max) { out.push(line); line = w; } else line = next;
        });
        if (line) out.push(line);
        return out;
    };
    const center = (text, size, bold = false) => {
        font(size, bold);
        ctx.textAlign = 'center';
        wrap(text, W - 8).forEach(l => { ctx.fillText(l, W / 2, y); y += size + 6; });
        ctx.textAlign = 'left';
    };
    const left = (text, size, bold = false) => {
        font(size, bold);
        wrap(text, W - 8).forEach(l => { ctx.fillText(l, 4, y); y += size + 6; });
    };
    const pair = (k, v, bold) => {
        font(bold ? 20 : 18, bold);
        ctx.textAlign = 'left';
        ctx.fillText(k, 4, y);
        ctx.textAlign = 'right';
        ctx.fillText(v, W - 4, y);
        ctx.textAlign = 'left';
        y += (bold ? 20 : 18) + 8;
    };
    const rule = () => { ctx.fillRect(4, y - 8, W - 8, 2); y += 8; };
    const h = headLines(r, lang);
    if (r.void) center(t('ui.rcpt.void_mark', null, lang), 26, true);
    if (h.biz) center(h.biz, 24, true);
    if (h.addr) center(h.addr, 16);
    center(h.title, 21, true);
    center(h.date, 17);
    rule();
    left(h.tenant, 19, true);
    if (h.place) left(h.place, 17);
    rule();
    receiptRows(r, lang).forEach(([k, v, bold]) => pair(k, v, bold));
    rule();
    left(h.by, 17);
    center(t('ui.rcpt.thanks', null, lang), 17);
    const out = doc.createElement('canvas');
    out.width = W;
    out.height = Math.min(y + 4, canvas.height);
    const o = out.getContext('2d');
    o.fillStyle = '#ffffff';
    o.fillRect(0, 0, W, out.height);
    o.drawImage(canvas, 0, 0);
    return out;
}

/**
 * One-page PDF holding a JPEG (the receipt image), page size = image size
 * (px × 0.75 pt). No library: catalog, page, image XObject, content stream.
 * @param {Uint8Array} jpeg
 * @returns {Uint8Array}
 */
export function pdfFromJpeg(jpeg, w, h) {
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? Uint8Array.from(x, ch => ch.charCodeAt(0)) : x; parts.push(b); len += b.length; };
    const obj = (n, ...body) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
    const pw = Math.round(w * 0.75);
    const ph = Math.round(h * 0.75);
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream');
    obj(5, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    const xref = len;
    push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len);
    let at = 0;
    parts.forEach(p => { out.set(p, at); at += p.length; });
    return out;
}

async function shareFile(blob, filename) {
    const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: filename });
            return;
        } catch (e) {
            if (e?.name === 'AbortError') return;
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- dialogs (env from rentals.js: dialog, linkOf(leaseId), canVoid) ----------

let current = null;
let list = [];

const fileName = (r, ext) => `${String(r.no || 'receipt').replace(/[^\w-]/g, '')}.${ext}`;

function ensureCss() {
    if (document.getElementById('rentReceiptCss')) return;
    const link = document.createElement('link');
    link.id = 'rentReceiptCss';
    link.rel = 'stylesheet';
    link.href = 'css/rent-receipt.css';
    document.head.appendChild(link);
}

/** Receipt dialog: preview and WhatsApp / Print / Image / PDF (+ Cancel receipt for owner/manager). */
export function showReceipt(env, r) {
    ensureCss();
    current = { env, r };
    const lang = getLang();
    const h = headLines(r, lang);
    const rows = receiptRows(r, lang).map(([k, v, bold]) => `<div class="rent-rcpt-row${bold ? ' rent-rcpt-bold' : ''}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    const act = (a, cls, label) => `<button type="button" class="rent-btn${cls}" onclick="window.app.rentals.receiptAction('${a}')">${esc(t(label))}</button>`;
    return env.dialog(`<h3>🧾 ${esc(h.title)}</h3>
        ${r.void ? `<p class="rent-rcpt-void">${esc(t('ui.rcpt.void_mark'))}${r.voidReason ? ` · ${esc(r.voidReason)}` : ''}</p>` : ''}
        <div class="rent-rcpt">
            ${h.biz ? `<div class="rent-rcpt-biz">${esc(h.biz)}</div>` : ''}${h.addr ? `<div class="rent-sub">${esc(h.addr)}</div>` : ''}
            <div class="rent-sub">${esc(h.date)}</div>
            <div class="rent-name">${esc(h.tenant)}</div>${h.place ? `<div class="rent-sub">${esc(h.place)}</div>` : ''}
            ${rows}
            <div class="rent-sub">${esc(h.by)}</div>
        </div>
        <div class="rent-actions">
            ${act('wa', ' rent-btn-wa', 'ui.rcpt.send_whatsapp')}${act('print', '', 'ui.rcpt.print')}
            ${act('image', '', 'ui.rcpt.image')}${act('pdf', '', 'ui.rcpt.pdf')}
            ${env.canVoid && !r.void ? act('void', '', 'ui.rcpt.void') : ''}
        </div>`, { info: true });
}

/** The tenant's payment history: receipts newest first (one bounded query); each can be reprinted. */
export async function showHistory(env, tenantId) {
    ensureCss();
    const name = store.snapshot().tenants.find(x => x.id === tenantId)?.name || '';
    try {
        list = await store.listReceipts(tenantId);
    } catch (e) {
        console.warn('Receipts not loaded:', e?.code || e);
        UIManager.showToast(t('msg.rent.could_not_load'), 'error');
        return false;
    }
    const lang = getLang();
    const rows = list.map(r => `<div class="rent-rcpt-item">
            <div><div class="rent-name">${esc(r.no)}${r.void ? ` <span class="rent-badge rent-badge-late">${esc(t('ui.rcpt.void_mark'))}</span>` : ''}</div>
                <div class="rent-sub">${esc(dateLabel(r.date))} · ${esc((r.months || []).map(m => monthLabel(m, lang)).join(', '))} · ${esc(inr(r.paid))}</div></div>
            <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.receiptAction('open', '${js(r.id)}')">${esc(t('ui.rcpt.open'))}</button>
        </div>`).join('');
    current = { env, r: null };
    return env.dialog(`<h3>🧾 ${esc(t('ui.rcpt.history_title', { name: cleanText(name) }))}</h3>
        ${rows || `<p class="rent-empty">${esc(t('ui.rcpt.none'))}</p>`}
        <p class="rent-help">${esc(t('ui.rcpt.history_note'))}</p>`, { info: true });
}

async function voidReceipt(env, r) {
    const ok = await env.dialog(`<h3>${esc(t('ui.rcpt.void_title', { no: r.no }))}</h3>
        <p class="rent-help">${esc(t('ui.rcpt.void_help'))}</p>
        <label class="rent-label">${esc(t('ui.rcpt.void_reason'))}<input id="rentVoidReason" type="text" maxlength="200"></label>`);
    if (!ok) return false;
    const reason = (document.getElementById('rentVoidReason')?.value || '').trim();
    try {
        await store.voidReceipt(r.id, reason);
        UIManager.showToast(t('msg.rent.receipt_voided', { no: r.no }), 'success');
        AuditService.log('RENT_RECEIPT_VOID', { receiptId: r.id, no: r.no, reason }).catch(e => console.warn('Rentals audit entry not written:', e?.code || e));
        return true;
    } catch (e) {
        console.error('Receipt not cancelled:', e);
        UIManager.showToast(t(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed'), 'error');
        return false;
    }
}

/** Buttons of the dialogs above (window.app.rentals.receiptAction). */
export async function action(env, name, id) {
    if (name === 'open') {
        const r = list.find(x => x.id === id);
        if (r) showReceipt(env, r);
        return;
    }
    const r = current?.r;
    if (!r) return;
    if (name === 'wa') {
        const phone = store.snapshot().tenants.find(x => x.id === r.tenantId)?.phone || '';
        openExternal(whatsAppReminderUrl(buildReceiptText(r, { link: env.linkOf(r.leaseId) || '' }), phone));
        return;
    }
    if (name === 'void') {
        if (env.canVoid && !r.void) await voidReceipt(env, r);
        return;
    }
    let canvas;
    try {
        canvas = drawReceipt(r);
    } catch (e) {
        UIManager.showToast(t('msg.printer.failed_generate_image'), 'error');
        return;
    }
    if (name === 'print') {
        await PrinterService.printCanvas(canvas, fileName(r, 'png'), t('ui.rcpt.title', { no: r.no }));
    } else if (name === 'image') {
        canvas.toBlob(b => (b ? shareFile(b, fileName(r, 'png')) : UIManager.showToast(t('msg.printer.failed_generate_image'), 'error')), 'image/png');
    } else if (name === 'pdf') {
        const bin = atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1] || '');
        const jpeg = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        await shareFile(new Blob([pdfFromJpeg(jpeg, canvas.width, canvas.height)], { type: 'application/pdf' }), fileName(r, 'pdf'));
    }
}