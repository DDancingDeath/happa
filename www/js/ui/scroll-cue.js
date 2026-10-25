/**
 * @fileoverview Fade at the right edge of a horizontally scrollable table
 * while more columns are hidden (F28, F34). Markup:
 * <div class="scroll-cue"><div class="scroll-cue-inner">…table…</div></div>
 * Styles: css/tables.css.
 * @module ui/scroll-cue
 */

/** Shows the cue while the scroller has hidden content on the right. */
export function updateScrollCue(scroller) {
    const wrap = scroller?.parentElement;
    if (!wrap) return;
    const more = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 2;
    wrap.classList.toggle('scroll-cue-more', more);
}

/**
 * Hooks a scroller once (scroll + resize) and refreshes its cue; call again
 * after the content changes.
 * @param {HTMLElement|null} scroller
 */
export function attachScrollCue(scroller) {
    if (!scroller) return;
    if (!scroller.dataset.scrollCue) {
        scroller.dataset.scrollCue = '1';
        const update = () => updateScrollCue(scroller);
        scroller.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
    }
    updateScrollCue(scroller);
}
