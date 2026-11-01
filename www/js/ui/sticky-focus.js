/**
 * @fileoverview Laptop billing (#104): at laptop heights the bill's totals card sticks
 * to the top of the screen and its Save/Print row to the bottom (desktop.css). A field
 * between them (notes, date, wholesale expenses) can be focused while one of them
 * covers it; this scrolls the page so the field shows in the gap.
 * @module ui/sticky-focus
 */

const GAP_PX = 8;

/**
 * How far to scroll so a field sits between a top and a bottom bar (0 when it already does).
 * @param {{top: number, bottom: number}} field
 * @param {number} topBarBottom - bottom edge of the bar stuck at the top
 * @param {number} bottomBarTop - top edge of the bar stuck at the bottom
 * @returns {number} positive: scroll down
 */
export function scrollIntoGap(field, topBarBottom, bottomBarTop) {
    if (field.top < topBarBottom + GAP_PX) return field.top - topBarBottom - GAP_PX;
    if (field.bottom > bottomBarTop - GAP_PX) return field.bottom - bottomBarTop + GAP_PX;
    return 0;
}

/** @param {Event} event */
function onFocusIn(event) {
    const field = event.target;
    const column = field?.closest?.('.bill-col-summary');
    if (!column) return;
    const card = column.querySelector(':scope > .bill-totals:first-child');
    const row = column.lastElementChild;
    const tab = field.closest('.tab');
    if (!card || !row || !tab || card.contains(field) || row.contains(field)) return;
    if (getComputedStyle(card).position !== 'sticky') return;
    const reveal = () => {
        const delta = scrollIntoGap(field.getBoundingClientRect(), card.getBoundingClientRect().bottom, row.getBoundingClientRect().top);
        if (delta) tab.scrollBy({ top: delta, behavior: 'instant' });
    };
    // A click: move the field only once it is released, or the click (a date picker) is lost
    if (pointerDown) field.ownerDocument.addEventListener('pointerup', () => requestAnimationFrame(reveal), { once: true });
    else requestAnimationFrame(reveal);
}

let installed = false;
let pointerDown = false;

/** Listens once for focus in the bill summary columns. */
export function installStickyFocus(doc = document) {
    if (installed || !doc) return;
    installed = true;
    doc.addEventListener('pointerdown', () => { pointerDown = true; }, true);
    doc.addEventListener('pointerup', () => { pointerDown = false; }, true);
    doc.addEventListener('pointercancel', () => { pointerDown = false; }, true);
    doc.addEventListener('focusin', onFocusIn);
}
