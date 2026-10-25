/**
 * @fileoverview Headings with gradient text (background-clip: text) paint emoji
 * as solid squares. Wraps emoji in headings in <span class="heading-emoji">,
 * which restores the normal fill (css/tabs.css). Re-runs when headings change
 * (templates loaded, language switched, pages redrawn).
 * @module ui/heading-emoji
 */

export const HEADING_SELECTOR = 'h1, h2, h3, h4, .gradient-text';
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/u;
const EMOJI_RE_G = new RegExp(EMOJI_RE.source, 'gu');

function inEmojiSpan(node) {
    return !!node.parentElement?.closest('.heading-emoji');
}

/** Splits one text node into text and <span class="heading-emoji"> parts. */
function wrapTextNode(node) {
    const text = node.nodeValue;
    if (!EMOJI_RE.test(text)) return false;
    const doc = node.ownerDocument;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(EMOJI_RE_G)) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        const span = doc.createElement('span');
        span.className = 'heading-emoji';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = m[0];
        frag.appendChild(span);
        last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
    return true;
}

/**
 * Wraps the emoji of every heading under root. Safe to run again: emoji already
 * wrapped are skipped.
 * @param {ParentNode} root
 * @returns {number} text nodes changed
 */
export function wrapHeadingEmoji(root = document) {
    if (!root?.querySelectorAll) return 0;
    const headings = [];
    if (root.matches?.(HEADING_SELECTOR)) headings.push(root);
    headings.push(...root.querySelectorAll(HEADING_SELECTOR));
    let changed = 0;
    for (const h of headings) {
        const walker = h.ownerDocument.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const n of nodes) {
            if (!inEmojiSpan(n) && wrapTextNode(n)) changed++;
        }
    }
    return changed;
}

/** Keeps headings wrapped as the page changes (one pass per animation frame). */
export function watchHeadingEmoji(root = document.body) {
    if (!root || typeof MutationObserver === 'undefined') return null;
    wrapHeadingEmoji(root);
    let queued = false;
    const run = () => { queued = false; wrapHeadingEmoji(root); };
    const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        (window.requestAnimationFrame || setTimeout)(run);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return observer;
}
