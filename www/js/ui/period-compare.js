/**
 * @fileoverview Period A vs period B (#140) for Money and Insights: the
 * "Compare with" bar (any preset or two chosen days), saved ranges on this
 * phone, and Money's short summary for WhatsApp and the thermal printer
 * (raster, like every receipt). Figures come from business-metrics
 * (periodRange, periodCompare: CMP-AB); this module only renders.
 * @module ui/period-compare
 */

import { t, getLang } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { formatDay, formatMonth, toLocalISODate } from '../utils/dates.js';
import { fiscalYearLabel, customRangePreset, periodRange } from '../utils/business-metrics.js';
import { getInsightsContext, setInsightsContext } from '../utils/insights-context.js';
import { readSavedRanges, addSavedRange, removeSavedRange, savedRangeId } from '../utils/saved-ranges.js';
import { formatRupees } from '../utils/money.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));

/** Presets offered as period B (and their labels). */
export const COMPARE_PRESETS = Object.freeze(['last-month', 'this-month', 'last-year', 'this-year', 'last-fy', 'this-fy', 'last-30']);
const PRESET_KEYS = Object.freeze({
    'this-month': 'ui.money.p_this_month', 'last-month': 'ui.money.p_last_month', 'this-year': 'ui.money.p_this_year',
    'last-year': 'ui.money.p_last_year', 'this-fy': 'ui.money.p_this_fy', 'last-fy': 'ui.money.p_last_fy', 'last-30': 'ui.money.p_last_30'
});
const ROW_KEYS = Object.freeze({ M1: 'ui.cmp.row_M1', M16: 'ui.cmp.row_M16', M4: 'ui.cmp.row_M4', M6: 'ui.cmp.row_M6', M14: 'ui.cmp.row_M14' });

/**
 * Two chosen days are being picked (before "Show"): a = the period, b = compare with. Each holds the
 * preset (or period B) shown when "Choose dates…" was picked, so the boxes close by themselves when the
 * period changes another way (‹ ›, a tapped month). undefined = not picking.
 */
const editing = { a: undefined, b: undefined };
const isEditing = (which) => {
    const now = getInsightsContext()[which === 'b' ? 'compare' : 'preset'] ?? null;
    if (editing[which] !== undefined && editing[which] !== now) editing[which] = undefined;
    return editing[which] !== undefined;
};
/** Last HTML written into each bar: rewriting the same bar would clear dates typed but not yet shown. */
const lastBar = new Map();

const store = () => {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
};

/**
 * Label of any period: a month, a year, an FY, "Last 30 days", or "5 Oct – 20 Oct 2026" for chosen days.
 * @param {{from: number, to: number, month?: string, fy?: number, custom?: boolean, first?: string, last?: string}} r periodRange()
 * @param {string} preset
 */
export function periodText(r, preset, lang = getLang()) {
    if (r.custom) {
        const sameYear = r.first.slice(0, 4) === r.last.slice(0, 4);
        return r.first === r.last ? formatDay(r.first, { lang })
            : `${formatDay(r.first, { lang, year: !sameYear })} – ${formatDay(r.last, { lang })}`;
    }
    if (r.month) return formatMonth(r.from, { lang });
    if (preset === 'last-30') return t('ui.money.p_last_30', null, lang);
    if (r.fy) return t('ui.money.fy_label', { years: fiscalYearLabel(r.fy) }, lang);
    if (preset === 'all') return t('ui.money.p_all', null, lang);
    return String(new Date(r.from).getFullYear());
}

/** Value for the period <select>: '' for a stepped month, 'custom' for chosen days. */
export function presetSelectValue(preset) {
    const picking = isEditing('a');
    if (/^month:/.test(preset)) return '';
    if (/^range:/.test(preset) || picking) return 'custom';
    return preset;
}

/** The B period of the shared context: its range and label, or null when off. */
export function compareTarget(cfg, now = new Date()) {
    const { compare } = getInsightsContext();
    if (!compare) return null;
    const r = periodRange(compare, now, cfg);
    return { preset: compare, range: r, label: periodText(r, compare) };
}

function datesHtml(page, which, preset) {
    const r = /^range:/.test(preset || '') ? periodRange(preset) : null;
    const today = toLocalISODate(new Date());
    const id = `${page}Cmp${which.toUpperCase()}`;
    return `<div class="ins-ab-dates" data-cmp-dates="${which}">`
        + `<input type="date" id="${id}From" max="${today}" value="${esc(r?.first || '')}" aria-label="${esc(t('ui.cmp.from'))}">`
        + `<span aria-hidden="true">–</span>`
        + `<input type="date" id="${id}To" max="${today}" value="${esc(r?.last || '')}" aria-label="${esc(t('ui.cmp.to'))}">`
        + `<button type="button" class="btn btn-secondary" onclick="window.app.${page}.applyDates('${which}')">${esc(t('ui.cmp.show'))}</button></div>`;
}

/**
 * The bar under the period: chosen days for A, "Compare with" B, saved ranges and (Money) Share / Print.
 * @param {'money'|'insights'} page
 * @param {{share?: boolean}} [opts]
 */
export function compareBarHtml(page, { share = false } = {}) {
    const { preset, compare } = getInsightsContext();
    const bValue = isEditing('b') || /^range:/.test(compare || '') ? 'custom' : (compare || '');
    const options = [['', t('ui.cmp.off')], ...COMPARE_PRESETS.map(p => [p, t(PRESET_KEYS[p])]), ['custom', t('ui.cmp.choose_dates')]]
        .map(([v, label]) => `<option value="${v}"${v === bValue ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const saved = readSavedRanges(store());
    const current = savedRangeId(preset, compare);
    const isSaved = saved.some(x => x.id === current);
    const savedLabel = (x) => {
        const a = periodText(periodRange(x.a), x.a);
        return x.b ? t('ui.cmp.a_vs_b', { a, b: periodText(periodRange(x.b), x.b) }) : a;
    };
    return (isEditing('a') || /^range:/.test(preset) ? datesHtml(page, 'a', preset) : '')
        + `<div class="ins-ab-bar">`
        + `<label class="ins-ab-pick"><span>${esc(t('ui.cmp.compare_with'))}</span>`
        + `<select id="${page}Compare" onchange="window.app.${page}.setCompare(this.value)">${options}</select></label>`
        + (saved.length ? `<select id="${page}Saved" class="ins-ab-saved" onchange="window.app.${page}.applySaved(this.value)" aria-label="${esc(t('ui.cmp.saved'))}">`
            + `<option value="">${esc(t('ui.cmp.saved'))}</option>`
            + saved.map(x => `<option value="${esc(x.id)}">${esc(savedLabel(x))}</option>`).join('') + '</select>' : '')
        + (isSaved
            ? `<button type="button" class="btn btn-secondary" onclick="window.app.${page}.removeRange()">${esc(t('ui.cmp.remove'))}</button>`
            : `<button type="button" class="btn btn-secondary" onclick="window.app.${page}.saveRange()">${esc(t('ui.cmp.save'))}</button>`)
        + (share ? `<button type="button" class="btn btn-secondary" onclick="window.app.${page}.shareSummary()">${esc(t('ui.cmp.share'))}</button>`
            + `<button type="button" class="btn btn-secondary" onclick="window.app.${page}.printSummary()">${esc(t('ui.cmp.print'))}</button>` : '')
        + '</div>'
        + (bValue === 'custom' ? datesHtml(page, 'b', compare) : '');
}

/** Period select changed: 'custom' opens the two date boxes; anything else is the new period. */
export function choosePreset(preset) {
    editing.a = preset === 'custom' ? getInsightsContext().preset : undefined;
    if (preset !== 'custom') setInsightsContext({ preset });
}

/** Writes the bar into its host unless it is already there (keeps half-typed dates through re-renders). */
export function writeBar(id, html) {
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (!el) return;
    if (lastBar.get(id) === html && el.firstChild) return;
    el.innerHTML = html;
    lastBar.set(id, html);
}

/** Compare-with select changed ('' = off, 'custom' = pick two days). */
export function chooseCompare(value) {
    editing.b = value === 'custom' ? (getInsightsContext().compare ?? null) : undefined;
    if (value !== 'custom') setInsightsContext({ compare: value || null });
}

/**
 * "Show" under two date boxes: saves the chosen days as the period (a) or period B (b).
 * @returns {boolean} false when a day is missing or the first day is after today
 */
export function applyDates(page, which) {
    const id = `${page}Cmp${String(which).toUpperCase()}`;
    const preset = customRangePreset(document.getElementById(`${id}From`)?.value, document.getElementById(`${id}To`)?.value);
    if (!preset) return false;
    editing[which === 'b' ? 'b' : 'a'] = undefined;
    setInsightsContext(which === 'b' ? { compare: preset } : { preset });
    return true;
}

export function applySaved(id) {
    const hit = readSavedRanges(store()).find(x => x.id === id);
    if (!hit) return false;
    editing.a = undefined;
    editing.b = undefined;
    setInsightsContext({ preset: hit.a, compare: hit.b });
    return true;
}

/** @returns {{ok: boolean, full?: boolean}} */
export function saveCurrentRange() {
    const { preset, compare } = getInsightsContext();
    return addSavedRange(store(), preset, compare);
}

export function removeCurrentRange() {
    const { preset, compare } = getInsightsContext();
    removeSavedRange(store(), savedRangeId(preset, compare));
}

/** Test helper. */
export function resetPeriodCompareForTests() {
    editing.a = undefined;
    editing.b = undefined;
    lastBar.clear();
}

const pctText = (c) => (!c ? '' : c.dir === 'same' ? '＝' : `${c.dir === 'up' ? '▲' : '▼'} ${Math.abs(c.pct)}%`);
const rupees = (v) => (v === null ? '—' : formatRupees(v));
const signed = (v) => (v === null ? '—' : `${v > 0 ? '+' : ''}${formatRupees(v)}`);

/**
 * CMP-AB card (Money): one row per figure with A, B, the ₹ change and %.
 * @param {Array<{id: string, a: ?number, b: ?number, diff: ?number, c: ?Object}>} rows periodCompare()
 * @param {{a: string, b: string}} labels
 */
export function compareTableHtml(rows, labels) {
    const head = `<thead><tr><th></th><th class="num">${esc(labels.a)}</th><th class="num">${esc(labels.b)}</th>`
        + `<th class="num">${esc(t('ui.cmp.change'))}</th><th class="num">%</th></tr></thead>`;
    const body = rows.map(r => `<tr data-cmp-row="${r.id}"${r.id === 'M6' ? ' data-perm="profit"' : ''}><td>${esc(t(ROW_KEYS[r.id]))}</td>`
        + `<td class="num">${rupees(r.a)}</td><td class="num">${rupees(r.b)}</td><td class="num">${signed(r.diff)}</td>`
        + `<td class="num ins-cmp-${r.c?.dir || 'none'}">${esc(pctText(r.c) || '—')}</td></tr>`).join('');
    return `<table class="ins-table ins-ab-table">${head}<tbody>${body}</tbody></table>`;
}

/**
 * Money's period summary as lines (WhatsApp text and the printed slip): A's figures,
 * and with B each figure's B value and % change.
 * @param {Array<Object>} rows periodCompare() (rows a role may not see already left out)
 * @param {{a: string, b: ?string, shop?: string}} labels
 * @returns {Array<{text?: string, left?: string, right?: string}>}
 */
export function summaryLines(rows, labels) {
    const lines = [];
    if (labels.shop) lines.push({ text: labels.shop });
    lines.push({ text: t('ui.cmp.summary_title', { period: labels.a }) });
    if (labels.b) lines.push({ text: t('ui.cmp.vs', { period: labels.b }) });
    rows.forEach(r => {
        lines.push({ left: t(ROW_KEYS[r.id]), right: rupees(r.a) });
        if (labels.b) lines.push({ left: `  ${labels.b}`, right: r.c ? `${rupees(r.b)}  ${pctText(r.c)}` : rupees(r.b) });
    });
    return lines;
}

/** The lines as WhatsApp text. */
export function summaryText(lines) {
    return lines.map(l => (l.text !== undefined ? `*${l.text}*` : `${l.left}: ${l.right}`)).join('\n');
}

/**
 * The lines on a 58 mm (384 dot) receipt canvas for PrinterService.printCanvas.
 * @returns {HTMLCanvasElement}
 */
export function summaryCanvas(lines, width = 384) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 40 + lines.length * 34;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, canvas.height);
    ctx.fillStyle = '#000000';
    let y = 30;
    lines.forEach(l => {
        if (l.text !== undefined) {
            ctx.font = 'bold 22px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(l.text, width / 2, y, width - 8);
        } else {
            ctx.font = '19px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(l.left, 4, y, width / 2);
            ctx.textAlign = 'right';
            ctx.fillText(l.right, width - 4, y, width / 2 - 8);
        }
        y += 34;
    });
    return canvas;
}
