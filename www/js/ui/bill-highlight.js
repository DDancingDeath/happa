/**
 * @fileoverview Live red/amber highlighting of bill problems (#188) and the
 * save gate built on the shared rule engine (utils/bill-checks.js, #37).
 *
 * Each billing form registers once with how to read its draft and where its
 * fields are. While the user types, the engine runs (debounced) and:
 * - marks offending inputs / bill rows (class + aria-invalid + a reason line),
 * - shows a banner at the top of the bill ("2 problems — check before saving"),
 * - colours the bill card border red (any block) or amber (only warnings),
 * - marks Save/Print as blocked (aria-disabled) while a block is present.
 * Nothing pops up while typing; dialogs only appear when Save is pressed.
 * @module ui/bill-highlight
 */

import { AppState } from '../utils/state.js';
import { UIManager } from './ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import {
    bannerText, buildCheckContext, canOverride, evaluateBill, saveGate, toFlags, toOverrides
} from '../utils/bill-checks.js';
import { hidePartyDue, renderPartyDue } from './party-due-line.js';
import { closeSuggestions, hideNameHint, renderNameHint } from './party-suggest.js';
import { confirmLineRates } from './rate-check.js';
import { lineItemIdentity } from '../utils/item-catalog.js';
import { getLang, t } from '../i18n/index.js';
import { tip } from '../tip/index.js';
import { AUTO_ROLLBACK_REASON } from '../tip/scenarios/bill-save.js';
import { awaitingServer } from '../utils/data-freshness.js';
import { on, DATA_FRESHNESS_CHANGED } from '../utils/events.js';

export const CHECK_DEBOUNCE_MS = 250;

/**
 * settings/app.tipPolicies key (#217): when its TIP policy trips on this device
 * and is not telemetry-only, overridable blocks become warnings (safe mode).
 */
export const BILL_CHECKS_BLOCKING_POLICY = 'billChecksBlocking';
export { AUTO_ROLLBACK_REASON };

const ICON = { block: '⛔', warn: '⚠️' };
const CLASS = { block: 'bill-check-block', warn: 'bill-check-warn' };
const TONE = { block: 'neg', warn: 'warn' };

/** @type {Object<string, Object>} kind -> registered form config */
const forms = {};
const timers = {};
/** Last issues per kind (read by tests and the save gate). */
const lastIssues = {};

const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

/**
 * Number typed in an input, or null when it is blank / not a number
 * (a blank field is "not entered yet", not 0).
 * @param {string} id
 * @returns {number|null}
 */
export function readTypedNumber(id) {
    const raw = byId(id)?.value;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
}
const text = (i) => (getLang() === 'hi' ? i.hi : i.en);

function sectionOf(kind) {
    const cfg = forms[kind];
    return cfg ? byId(cfg.sectionId) : null;
}

function bind(kind) {
    const section = sectionOf(kind);
    if (!section || section.dataset.billChecksBound) return section;
    section.dataset.billChecksBound = '1';
    const onEdit = (e) => {
        if (e.target?.closest?.('.bill-check-notice')) return;
        BillChecksUI.schedule(kind);
    };
    section.addEventListener('input', onEdit);
    section.addEventListener('change', onEdit);
    return section;
}

function clearMarks(section) {
    section.querySelectorAll('.bill-check-msg, .bill-check-row').forEach(el => el.remove());
    section.querySelectorAll('[data-bill-check]').forEach(el => {
        el.classList.remove(CLASS.block, CLASS.warn);
        el.removeAttribute('aria-invalid');
        const describedBy = (el.getAttribute('aria-describedby') || '').split(' ')
            .filter(id => id && !id.startsWith('billcheck-')).join(' ');
        if (describedBy) el.setAttribute('aria-describedby', describedBy);
        else el.removeAttribute('aria-describedby');
        delete el.dataset.billCheck;
    });
    section.classList.remove('bill-checks-block', 'bill-checks-warn');
}

function mark(el, severity, msgId) {
    if (!el) return;
    const worse = el.dataset.billCheck === 'block' ? 'block' : severity;
    el.classList.remove(CLASS.block, CLASS.warn);
    el.classList.add(CLASS[worse]);
    el.dataset.billCheck = worse;
    el.setAttribute('aria-invalid', 'true');
    if (msgId) {
        const ids = new Set((el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
        ids.add(msgId);
        el.setAttribute('aria-describedby', [...ids].join(' '));
    }
}

function messageEl(issue, msgId) {
    const div = document.createElement('div');
    div.className = `bill-check-msg ${CLASS[issue.severity]}`;
    div.id = msgId;
    div.textContent = `${ICON[issue.severity]} ${text(issue)}`;
    return div;
}

function itemRows(cfg) {
    const tbody = cfg.tableSelector ? document.querySelector(`${cfg.tableSelector} tbody`) : null;
    return tbody ? [...tbody.children].filter(tr => !tr.classList.contains('bill-check-row')) : [];
}

function placeFieldIssue(cfg, issue, n) {
    const field = cfg.fields?.[issue.field];
    if (!field) return null;
    const inputs = (field.inputs || []).map(byId).filter(Boolean);
    const anchor = byId(field.anchor) || inputs[0];
    if (!anchor) return null;
    const msgId = `billcheck-${cfg.kind}-${n}`;
    inputs.forEach(el => mark(el, issue.severity, msgId));
    const row = anchor.closest('.form-row, .payment-row') || anchor;
    let after = row;
    while (after.nextElementSibling?.classList.contains('bill-check-msg')) after = after.nextElementSibling;
    after.insertAdjacentElement('afterend', messageEl(issue, msgId));
    return inputs[0] || anchor;
}

function placeLineIssue(cfg, issue, n) {
    const rows = itemRows(cfg);
    const lines = issue.field.startsWith('items.') ? [Number(issue.field.slice(6))] : (issue.lines || []);
    const msgId = `billcheck-${cfg.kind}-${n}`;
    let first = null;
    lines.forEach((i, k) => {
        const tr = rows[i];
        if (!tr) return;
        mark(tr, issue.severity, msgId);
        first = first || tr;
        if (k !== lines.length - 1) return;
        const msgRow = document.createElement('tr');
        msgRow.className = 'bill-check-row';
        const td = document.createElement('td');
        td.colSpan = tr.children.length || 5;
        td.appendChild(messageEl(issue, msgId));
        msgRow.appendChild(td);
        let after = tr;
        while (after.nextElementSibling?.classList.contains('bill-check-row')) after = after.nextElementSibling;
        after.insertAdjacentElement('afterend', msgRow);
    });
    return first;
}

function ensureBanner(section) {
    let banner = section.querySelector(':scope > .bill-check-notice');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'notice solid bill-check-notice';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.hidden = true;
        section.insertBefore(banner, section.firstChild);
    }
    return banner;
}

function renderBanner(cfg, section, issues, unplaced, firstTarget) {
    const banner = ensureBanner(section);
    if (issues.length === 0) {
        banner.hidden = true;
        banner.className = 'notice solid bill-check-notice';
        banner.replaceChildren();
        return;
    }
    const severity = issues.some(i => i.severity === 'block') ? 'block' : 'warn';
    // The rate still in the entry box can repeat a line's warning: count each problem once
    const { en, hi } = bannerText(new Set(issues.map(i => `${i.id}|${i.en}`)).size);
    banner.hidden = false;
    banner.className = `notice solid ${TONE[severity]} bill-check-notice ${CLASS[severity]}`;
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'bill-check-notice-head';
    head.textContent = `${ICON[severity]} ${getLang() === 'hi' ? hi : en}`;
    head.onclick = () => {
        if (!firstTarget) return;
        firstTarget.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        if (typeof firstTarget.focus === 'function' && /INPUT|SELECT|TEXTAREA/.test(firstTarget.tagName)) firstTarget.focus();
    };
    const nodes = [head];
    if (unplaced.length) {
        const ul = document.createElement('ul');
        unplaced.forEach(i => {
            const li = document.createElement('li');
            li.textContent = `${ICON[i.severity]} ${text(i)}`;
            ul.appendChild(li);
        });
        nodes.push(ul);
    }
    banner.replaceChildren(...nodes);
}

/**
 * Save/Print state: 'blocked' (a red problem), 'override' (red problems an
 * owner/manager may save past with a reason) or 'ok'.
 */
function renderSaveButtons(cfg, state) {
    if (!cfg.saveButtons) return;
    document.querySelectorAll(cfg.saveButtons).forEach(btn => {
        btn.classList.remove('bill-check-save-blocked', 'bill-check-save-override');
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('title');
        if (state === 'blocked') {
            btn.setAttribute('aria-disabled', 'true');
            btn.classList.add('bill-check-save-blocked');
            btn.title = t('ui.checks.fix_red_first');
        } else if (state === 'override') {
            btn.classList.add('bill-check-save-override');
            btn.title = t('ui.checks.save_anyway_reason_needed');
        }
    });
}

/**
 * Paint issues onto a registered form.
 * @param {string} kind
 * @param {Array<Object>} issues
 */
export function renderIssues(kind, issues) {
    const cfg = forms[kind];
    const section = sectionOf(kind);
    if (!cfg || !section) return;
    clearMarks(section);
    const unplaced = [];
    let firstTarget = null;
    issues.forEach((issue, n) => {
        let target = null;
        if (issue.field === 'items' || issue.field.startsWith('items.')) target = placeLineIssue(cfg, issue, n);
        else target = placeFieldIssue(cfg, issue, n);
        if (!target) unplaced.push(issue);
        firstTarget = firstTarget || target;
    });
    const { blocks, hardBlocks } = saveGate(issues);
    const saveState = !blocks.length ? 'ok'
        : (!hardBlocks.length && canOverride(AppState.userRole) ? 'override' : 'blocked');
    if (issues.length) section.classList.add(issues.some(i => i.severity === 'block') ? 'bill-checks-block' : 'bill-checks-warn');
    renderBanner(cfg, section, issues, unplaced, firstTarget || section);
    renderSaveButtons(cfg, saveState);
}

function evaluate(kind, overrides = null) {
    const cfg = forms[kind];
    if (!cfg) return [];
    const base = cfg.getDraft();
    if (!base) return [];
    const draft = overrides ? { ...base, ...overrides } : base;
    const ctx = buildCheckContext({ ...AppState, stockUnconfirmed: awaitingServer() }, draft.kind, {
        now: Date.now(), editingBill: draft.editingBill || null, draftId: draft.id || null
    });
    return evaluateBill(draft, ctx);
}

export const BillChecksUI = {
    /**
     * Register a billing form.
     * @param {string} kind - 'purchase' | 'retail' | 'wholesale'
     * @param {{sectionId: string, getDraft: Function, fields: Object, tableSelector?: string, saveButtons?: string}} config
     */
    register(kind, config) {
        forms[kind] = { ...config, kind };
    },

    /** Run the checks after the user stops typing for CHECK_DEBOUNCE_MS. */
    schedule(kind) {
        if (!forms[kind]) return;
        clearTimeout(timers[kind]);
        timers[kind] = setTimeout(() => this.run(kind), CHECK_DEBOUNCE_MS);
    },

    /**
     * Evaluate and paint now.
     * @param {string} kind
     * @returns {Array<Object>} issues
     */
    run(kind) {
        clearTimeout(timers[kind]);
        if (!bind(kind)) return [];
        let issues = [];
        try {
            issues = evaluate(kind);
            renderIssues(kind, issues);
        } catch (error) {
            // Never let a check bug stop billing; the save path re-checks money rules.
            console.error('Bill checks failed:', error);
        }
        lastIssues[kind] = issues;
        try {
            const cfg = forms[kind];
            const draft = cfg.getDraft();
            renderPartyDue(kind, cfg.fields?.party?.inputs?.[0], draft);
            renderNameHint(kind, draft);
        } catch (error) {
            console.error('Party due line failed:', error);
        }
        return issues;
    },

    /** Remove every mark (bill cleared / saved). */
    clear(kind) {
        clearTimeout(timers[kind]);
        lastIssues[kind] = [];
        const section = sectionOf(kind);
        if (section) renderIssues(kind, []);
        hidePartyDue(kind);
        hideNameHint(kind);
        closeSuggestions(kind);
    },

    /**
     * Fields to store on the saved bill: accepted warnings as `flags`, owner/manager
     * overrides as `overrides` (kept across edits, they are approval records).
     * @param {{flags: Array<Object>, overrides: Array<Object>}} checks - confirmSave result
     * @param {Object|null} [original] - saved copy when editing
     * @returns {Object}
     */
    billFields(checks, original = null) {
        const out = {};
        const flags = checks?.flags || [];
        if (flags.length || Array.isArray(original?.flags)) out.flags = flags;
        const overrides = [...(Array.isArray(original?.overrides) ? original.overrides : []), ...(checks?.overrides || [])];
        if (overrides.length) out.overrides = overrides;
        return out;
    },

    /** @returns {Array<Object>} issues from the last run */
    lastIssues(kind) {
        return lastIssues[kind] || [];
    },

    /**
     * Decide whether the bill may be saved. Hard blocks stop the save with the
     * same message as before; other blocks need an owner/manager reason;
     * warnings need one confirm.
     * @param {string} kind
     * @param {Object} [draftOverrides] - e.g. the edit context from the bill editor
     * @returns {Promise<{ok: boolean, flags: Array<Object>, overrides: Array<Object>}>}
     */
    async confirmSave(kind, draftOverrides = null) {
        let issues;
        try {
            issues = evaluate(kind, draftOverrides);
        } catch (error) {
            console.error('Bill checks failed:', error);
            return { ok: false, flags: [], overrides: [] };
        }
        lastIssues[kind] = issues;
        if (sectionOf(kind)) renderIssues(kind, issues);
        const { hardBlocks } = saveGate(issues);
        const stop = { ok: false, flags: [], overrides: [] };
        const by = AppState.currentUser?.uid || 'unknown';

        if (hardBlocks.length) {
            UIManager.showToast(text(hardBlocks[0]));
            focusIssue(kind, hardBlocks[0]);
            return stop;
        }

        // BF-RATECHECK: an extreme rate not confirmed at Add to bill is asked now, with "Fix rate" first
        let rateDraft = null;
        try {
            const base = forms[kind]?.getDraft?.();
            rateDraft = base ? { ...base, ...(draftOverrides || {}) } : null;
        } catch (error) {
            console.error('Rate check failed:', error);
        }
        if (rateDraft) {
            const rates = await confirmLineRates(rateDraft);
            if (!rates.ok) {
                showLine(kind, /** @type {number} */ (rates.index));
                return stop;
            }
            if (rates.confirmed) {
                try {
                    issues = evaluate(kind, draftOverrides);
                } catch (error) {
                    console.error('Bill checks failed:', error);
                    return stop;
                }
                lastIssues[kind] = issues;
                if (sectionOf(kind)) renderIssues(kind, issues);
            }
        }
        const { blocks, warns } = saveGate(issues);

        let overrides = [];
        // Auto rollback (#217): only someone who may override anyway (owner/manager)
        // skips the reason prompt; the block is still recorded as an override with
        // reason "auto-rollback" + audit entry. Everyone else stays blocked.
        const autoOverride = blocks.length && canOverride(AppState.userRole) && tip.isRolledBack(BILL_CHECKS_BLOCKING_POLICY)
            ? blocks : [];
        if (blocks.length && !autoOverride.length) {
            if (!canOverride(AppState.userRole)) {
                UIManager.showToast(text(blocks[0]));
                focusIssue(kind, blocks[0]);
                return stop;
            }
            const reason = await askOverrideReason(blocks);
            if (reason === null) return stop;
            overrides = toOverrides(blocks, reason, by, Date.now());
            AuditService.log(AuditService.ACTIONS.OVERRIDE_CHECK, {
                kind, rules: overrides.map(o => o.rule), reason
            }).catch(e => console.warn('Audit log failed:', e));
        }

        const confirmList = [...autoOverride, ...warns];
        if (confirmList.length) {
            const list = confirmList.map(w => `${ICON.warn} ${text(w)}`).join('\n');
            const ok = await UIManager.showModal(
                t('msg.checks.save_anyway_list', { list }),
                t('msg.checks.check_before_saving'),
                true
            );
            if (!ok) return stop;
        }
        if (autoOverride.length) {
            overrides = toOverrides(autoOverride, AUTO_ROLLBACK_REASON, by, Date.now());
            AuditService.log(AuditService.ACTIONS.OVERRIDE_CHECK, {
                kind, rules: overrides.map(o => o.rule), reason: AUTO_ROLLBACK_REASON
            }).catch(e => console.warn('Audit log failed:', e));
        }
        return { ok: true, flags: toFlags(warns, by, Date.now()), overrides };
    }
};

function focusIssue(kind, issue) {
    const cfg = forms[kind];
    const id = cfg?.fields?.[issue.field]?.inputs?.[0];
    const el = id ? byId(id) : null;
    if (el && typeof el.focus === 'function') el.focus();
}

/** "Fix rate" at Save: point at the bill line to correct. */
function showLine(kind, index) {
    const cfg = forms[kind];
    const row = cfg ? itemRows(cfg)[index] : null;
    row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    const line = cfg?.getDraft?.()?.items?.[index];
    const name = line ? lineItemIdentity(line, AppState.items, AppState.settings?.showHindi).label : '';
    UIManager.showToast(t('msg.rate_check.fix_line', { item: name || '' }), 'warning');
}

/**
 * Ask an owner/manager why a blocked bill is saved anyway.
 * @param {Array<Object>} blocks
 * @returns {Promise<string|null>} reason, or null when cancelled / left blank
 */
async function askOverrideReason(blocks) {
    const list = blocks.map(b => `<li>${ICON.block} ${Helpers.escapeHtml(text(b))}</li>`).join('');
    const html = `<ul class="bill-check-modal-list">${list}</ul>
        <label for="billCheckOverrideReason">${Helpers.escapeHtml(t('ui.checks.reason_to_save_anyway'))}</label>
        <input type="text" id="billCheckOverrideReason" class="bill-check-reason" maxlength="200" autocomplete="off" />`;
    const ok = await UIManager.showModalWithHtml(html, t('msg.checks.save_anyway'), true);
    if (!ok) return null;
    const reason = (byId('billCheckOverrideReason')?.value || '').trim();
    if (!reason) {
        UIManager.showToast(t('msg.checks.write_reason_save_anyway'));
        return null;
    }
    return reason;
}

// A form whose checks have not run yet has no listener; its first edit starts
// them (e.g. typing the customer name first on the Wholesale page, #166).
if (typeof document !== 'undefined') {
    document.addEventListener('input', (e) => {
        Object.keys(forms).forEach(kind => {
            const section = sectionOf(kind);
            if (section && !section.dataset.billChecksBound && section.contains(e.target)) BillChecksUI.schedule(kind);
        });
    });
}

// The stock note and the oversell block follow the server's confirmation (#59)
on(DATA_FRESHNESS_CHANGED, () => Object.keys(forms).forEach(kind => BillChecksUI.schedule(kind)));
