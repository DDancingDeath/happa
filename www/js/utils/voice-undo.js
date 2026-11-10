// @ts-check
/**
 * @fileoverview Undo of voice changes (#131): what one voice action changed on a bill form
 * (lines added, the customer box, the item / rate / weight boxes), kept per form, and what
 * undoing it means now. Only what is still as voice left it is undone: a line removed or
 * edited since, or a box typed over, is left alone. Pure, no DOM.
 * @module utils/voice-undo
 */

/** Voice actions kept per form. */
export const UNDO_LIMIT = 10;

/**
 * @typedef {{before: string, after: string}} FieldChange
 * @typedef {{lines: Object[], fields: Object<string, FieldChange>}} VoiceChange
 */

/**
 * A last-in first-out list of voice changes.
 * @param {number} [limit]
 */
export function createVoiceUndo(limit = UNDO_LIMIT) {
    /** @type {VoiceChange[]} */
    let stack = [];
    return {
        /** @param {VoiceChange} change kept only when it changed something */
        push(change) {
            if (!change || (!(change.lines || []).length && !Object.keys(change.fields || {}).length)) return false;
            stack.push({ lines: [...(change.lines || [])], fields: { ...(change.fields || {}) } });
            if (stack.length > limit) stack = stack.slice(-limit);
            return true;
        },
        peek() { return stack.length ? stack[stack.length - 1] : null; },
        pop() { return stack.pop() || null; },
        clear() { stack = []; },
        get size() { return stack.length; }
    };
}

/**
 * What undoing a change does now.
 * @param {?VoiceChange} change
 * @param {{lines: Object[], fields: Object<string, string>}} now the form's bill lines and box values
 * @returns {{removeAt: number[], restore: Object<string, string>, kept: number, any: boolean}}
 *   removeAt: indexes of the voice-added lines still on the bill, highest first;
 *   restore: boxes to put back; kept: lines or boxes changed since, left alone
 */
export function planUndo(change, now) {
    /** @type {number[]} */
    const removeAt = [];
    /** @type {Object<string, string>} */
    const restore = {};
    let kept = 0;
    if (!change) return { removeAt, restore, kept, any: false };
    const lines = now?.lines || [];
    for (const line of change.lines || []) {
        const at = lines.indexOf(line);
        if (at === -1) kept++;
        else removeAt.push(at);
    }
    removeAt.sort((a, b) => b - a);
    for (const [name, c] of Object.entries(change.fields || {})) {
        const value = String(now?.fields?.[name] ?? '');
        if (value === String(c.after ?? '')) {
            if (value !== String(c.before ?? '')) restore[name] = String(c.before ?? '');
        } else kept++;
    }
    return { removeAt, restore, kept, any: removeAt.length > 0 || Object.keys(restore).length > 0 };
}

/**
 * The boxes a voice action changed: only those whose value differs from before.
 * @param {Object<string, string>} before
 * @param {Object<string, string>} after
 * @returns {Object<string, FieldChange>}
 */
export function fieldChanges(before, after) {
    /** @type {Object<string, FieldChange>} */
    const out = {};
    for (const name of Object.keys(after || {})) {
        const b = String(before?.[name] ?? '');
        const a = String(after[name] ?? '');
        if (a !== b) out[name] = { before: b, after: a };
    }
    return out;
}
