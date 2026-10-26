/**
 * @fileoverview Pure helpers for the item catalogue: id lookups, duplicate-name
 * checks and usage frequency. No Firebase / DOM access, so they are unit-tested.
 * @module utils/item-catalog
 */

import { createItemKeyResolver } from './stock-replay.js';
import { activityBills } from './money.js';
import { t } from '../i18n/index.js';

/**
 * Normalises an item name for comparisons: Unicode NFC, trimmed, inner
 * whitespace collapsed, lower-cased. Works for English and Hindi names.
 * @param {*} s
 * @returns {string}
 */
export function normalizeItemName(s) {
    if (s == null) return '';
    let str = String(s);
    if (typeof str.normalize === 'function') str = str.normalize('NFC');
    return str.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Finds an item by id.
 * @param {Array<{id: string}>} items
 * @param {string} id
 * @returns {Object|null}
 */
export function findItemById(items, id) {
    if (!id) return null;
    return (items || []).find(i => i && i.id === id) || null;
}

/**
 * Which catalogue item a bill line is: by itemId, else by its English or Hindi
 * name (lines saved while item names were shown in Hindi carry the Hindi name).
 * `key` groups lines of one item; `label` is the name to show in the chosen
 * language. Lines that match no item keep their own name.
 * @param {{itemId?: string, name?: string, item?: string}} line
 * @param {Array<{id: string, name?: string, hindiName?: string}>} items
 * @param {boolean} [showHindi=false]
 * @returns {{key: string, label: string, item: ?Object}}
 */
export function lineItemIdentity(line, items, showHindi = false) {
    const raw = String(line?.name || line?.item || '').trim();
    let item = findItemById(items, line?.itemId);
    if (!item && raw) {
        const n = normalizeItemName(raw);
        item = (items || []).find(i => i && (normalizeItemName(i.name) === n || (i.hindiName && normalizeItemName(i.hindiName) === n))) || null;
    }
    if (!item) return { key: `name:${raw}`, label: raw, item: null };
    return { key: `id:${item.id}`, label: (showHindi && item.hindiName) ? item.hindiName : (item.name || raw), item };
}

/**
 * Returns the existing item whose English or Hindi name collides with either
 * of the candidate names (case/space-insensitive). English and Hindi names
 * share one namespace because the stock replay resolves bill lines by either.
 * @param {Array<{id: string, name?: string, hindiName?: string}>} items
 * @param {{name?: string, hindiName?: string}} candidate
 * @param {string|null} [excludeId] id of the item being edited
 * @returns {{item: Object, name: string}|null} the clashing item and the clashing name
 */
export function findDuplicateItem(items, candidate, excludeId = null) {
    const wanted = [candidate?.name, candidate?.hindiName]
        .map(normalizeItemName)
        .filter(Boolean);
    if (wanted.length === 0) return null;
    for (const item of items || []) {
        if (!item || (excludeId && item.id === excludeId)) continue;
        for (const existing of [item.name, item.hindiName]) {
            const n = normalizeItemName(existing);
            if (n && wanted.includes(n)) return { item, name: existing };
        }
    }
    return null;
}

/**
 * Bilingual "name already exists" message.
 * @param {string} name
 * @returns {string}
 */
export function duplicateItemMessage(name) {
    return t('msg.items.duplicate_name', { name });
}

/**
 * Counts how many bill lines used each catalogue item across the loaded
 * purchase, wholesale and retail histories. Lines resolve to an item id the
 * same way the stock replay does (itemId, else English/Hindi name).
 * @param {{purchases?: Array, wholesaleSales?: Array, retailSales?: Array}} sources
 * @param {Array<{id: string, name?: string, hindiName?: string}>} items
 * @returns {Object.<string, number>} item id -> number of bill lines
 */
export function itemUsageFrequency(sources, items) {
    const getKey = createItemKeyResolver(items);
    const ids = new Set((items || []).map(i => i.id));
    const counts = {};
    [sources?.purchases, sources?.wholesaleSales, sources?.retailSales].forEach(bills => {
        activityBills(bills).forEach(bill => {
            (Array.isArray(bill?.items) ? bill.items : []).forEach(line => {
                if (!line) return;
                const key = getKey({ itemId: line.itemId, name: line.name || line.itemName });
                if (ids.has(key)) counts[key] = (counts[key] || 0) + 1;
            });
        });
    });
    return counts;
}

/**
 * Sorts items by usage (most used first), then alphabetically by name.
 * @param {Array<Object>} items
 * @param {Object.<string, number>} frequency item id -> count
 * @returns {Array<Object>} a new sorted array
 */
export function sortItemsByUsage(items, frequency) {
    return [...(items || [])].sort((a, b) => {
        const diff = (frequency[b.id] || 0) - (frequency[a.id] || 0);
        if (diff !== 0) return diff;
        return (a.name || '').localeCompare(b.name || '');
    });
}
/** Spreadsheet column names (export writes these; import reads them). */
export const ITEM_SHEET_COLUMNS = {
    id: 'ID',
    name: 'Item Name',
    hindiName: 'Hindi Name',
    contactPerson: 'Contact Person',
    rates: 'Purchase Rates',
    saleRates: 'Retail-Sale Rates',
    wholesaleRates: 'Wholesale Rates'
};

/** Older sheets used these headers for retail rates. */
const SALE_RATE_ALIASES = ['Retail-Sale Rates', 'Retail Sale Rates', 'Sale Rates'];

const RATE_FIELDS = ['rates', 'saleRates', 'wholesaleRates'];
const RATE_LABELS = { rates: 'purchase', saleRates: 'retail-sale', wholesaleRates: 'wholesale' };

const cellText = (v) => (v == null ? '' : String(v).trim());
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

/**
 * Parses a "41, 42" rate cell. Empty → []. Any non-positive / non-numeric
 * part is an error (returned, not silently dropped).
 * @param {*} value
 * @returns {{rates: number[], error: string|null}}
 */
export function parseRateCell(value) {
    const text = cellText(value);
    if (!text) return { rates: [], error: null };
    const rates = [];
    for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
        const n = Number(part);
        if (!Number.isFinite(n) || n <= 0) return { rates: [], error: `"${part}"` };
        rates.push(n);
    }
    return { rates, error: null };
}

/** Item row for export (round-trips through planItemImport). */
export function itemToSheetRow(item) {
    const C = ITEM_SHEET_COLUMNS;
    return {
        [C.id]: item.id || '',
        [C.name]: item.name || '',
        [C.hindiName]: item.hindiName || '',
        [C.contactPerson]: item.contactPerson || '',
        [C.rates]: (item.rates || []).join(', '),
        [C.saleRates]: (item.saleRates || []).join(', '),
        [C.wholesaleRates]: (item.wholesaleRates || []).join(', ')
    };
}

const sameRates = (a, b) => {
    const x = (a || []).map(Number).filter(n => n > 0);
    const y = (b || []).map(Number).filter(n => n > 0);
    return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Plans a MERGE import of spreadsheet rows into the catalogue. Nothing is
 * ever deleted: items missing from the sheet are left untouched. Each row is
 * matched by its ID column when present, otherwise by case/space-insensitive
 * English or Hindi name. Only columns present in the sheet are updated.
 *
 * Rows must come from SheetJS `sheet_to_json(ws, { defval: '' })` so that a
 * blank cell (clear the field) is distinguishable from a missing column
 * (leave the field alone).
 *
 * @param {Array<Object>} rows
 * @param {Array<Object>} items current catalogue
 * @returns {{
 *   updates: Array<{id: string, rowNumber: number, before: Object, fields: Object}>,
 *   adds: Array<{rowNumber: number, fields: Object}>,
 *   unchanged: Array<{id: string, rowNumber: number}>,
 *   errors: Array<{rowNumber: number, reason: string}>,
 *   skipped: number
 * }}
 */
export function planItemImport(rows, items) {
    const C = ITEM_SHEET_COLUMNS;
    const plan = { updates: [], adds: [], unchanged: [], errors: [], skipped: 0 };
    const catalogue = items || [];
    const claimedIds = new Set();
    const sheetNames = new Set();

    (rows || []).forEach((row, i) => {
        // Row 1 is the header, so data row i is spreadsheet row i + 2.
        const rowNumber = i + 2;
        if (!row || Object.values(row).every(v => cellText(v) === '')) {
            plan.skipped++;
            return;
        }
        const fail = (reason) => plan.errors.push({ rowNumber, reason });

        const fields = {};
        const name = cellText(row[C.name]);
        if (!name) return fail('Item Name is empty');
        fields.name = name;
        if (has(row, C.hindiName)) fields.hindiName = cellText(row[C.hindiName]);
        if (has(row, C.contactPerson)) fields.contactPerson = cellText(row[C.contactPerson]);

        const rateSources = {
            rates: has(row, C.rates) ? row[C.rates] : undefined,
            saleRates: SALE_RATE_ALIASES.map(k => (has(row, k) ? row[k] : undefined)).find(v => v !== undefined && cellText(v) !== '')
                ?? (SALE_RATE_ALIASES.some(k => has(row, k)) ? '' : undefined),
            wholesaleRates: has(row, C.wholesaleRates) ? row[C.wholesaleRates] : undefined
        };
        for (const f of RATE_FIELDS) {
            if (rateSources[f] === undefined) continue;
            const { rates, error } = parseRateCell(rateSources[f]);
            if (error) return fail(`Invalid ${RATE_LABELS[f]} rate ${error}`);
            fields[f] = rates;
        }

        const rowId = cellText(row[C.id]);
        let target = null;
        if (rowId) {
            target = findItemById(catalogue, rowId);
            if (!target) return fail(`ID "${rowId}" not found in the app`);
        } else {
            const byName = findDuplicateItem(catalogue, { name });
            target = byName ? byName.item : null;
        }

        // The (new) names must not belong to a different item.
        const clash = findDuplicateItem(catalogue, { name, hindiName: fields.hindiName }, target ? target.id : null);
        if (clash) return fail(`Name "${clash.name}" belongs to another item`);

        if (target && claimedIds.has(target.id)) return fail(`Item "${target.name}" appears more than once in the sheet`);
        const keys = [name, fields.hindiName].map(normalizeItemName).filter(Boolean);
        if (keys.some(k => sheetNames.has(k))) return fail(`"${name}" appears more than once in the sheet`);
        keys.forEach(k => sheetNames.add(k));

        if (target) {
            claimedIds.add(target.id);
            const changed = Object.keys(fields).some(f => (RATE_FIELDS.includes(f)
                ? !sameRates(target[f], fields[f])
                : cellText(target[f]) !== fields[f]));
            if (changed) plan.updates.push({ id: target.id, rowNumber, before: target, fields });
            else plan.unchanged.push({ id: target.id, rowNumber });
            return;
        }

        plan.adds.push({
            rowNumber,
            fields: { hindiName: '', contactPerson: '', rates: [], saleRates: [], wholesaleRates: [], ...fields }
        });
    });
    return plan;
}