/**
 * @fileoverview Infinite scroll for history lists.
 * Puts a sentinel element right after a list; when it scrolls into view
 * (IntersectionObserver, works in Android WebView) it calls `loadMore`, shows
 * a "Loading…" row, and an end-of-list row once nothing older exists.
 * After a few consecutive automatic loads that don't push the sentinel out of
 * view (e.g. a filter hides every new row) it switches to a manual
 * "Load older" button so it never walks the whole history on its own.
 * @module ui/infinite-scroll
 */

import { loadOlderHistory, historyReachedEnd } from '../utils/history-window.js';
import { t } from '../i18n/index.js';

const controllers = new WeakMap();

const NOUNS = ['records', 'bills', 'withdrawals', 'expenses', 'adjustments', 'sales'];

/** Labels for the list's rows in the app language; `noun` is one of NOUNS. */
function olderLabels(noun = 'records') {
    const what = t(`ui.scroll.noun_${NOUNS.includes(noun) ? noun : 'records'}`);
    return {
        loading: t('ui.scroll.loading', { what }),
        end: t('ui.scroll.end', { what }),
        more: t('ui.scroll.more', { what }),
        error: t('ui.scroll.error', { what })
    };
}

class InfiniteScrollController {
    constructor(listEl, opts) {
        this.listEl = listEl;
        this.state = 'idle';
        this.autoLoads = 0;
        this.observer = null;
        this.setOptions(opts);
        this.sentinel = this.ensureSentinel();
        if (typeof IntersectionObserver === 'function') {
            this.observer = new IntersectionObserver(
                entries => entries.forEach(e => this.onIntersect(e)),
                { root: null, rootMargin: this.opts.rootMargin || '0px 0px 300px 0px' }
            );
        }
    }

    setOptions(opts) {
        this.opts = { maxAutoLoads: 3, ...opts };
        this.labels = { ...olderLabels(), ...(opts.labels || {}) };
    }

    ensureSentinel() {
        const next = this.listEl.nextElementSibling;
        if (next && next.classList.contains('infinite-scroll-sentinel')) return next;
        const el = document.createElement('div');
        el.className = 'infinite-scroll-sentinel';
        el.setAttribute('aria-live', 'polite');
        this.listEl.insertAdjacentElement('afterend', el);
        return el;
    }

    isEnabled() {
        return typeof this.opts.enabled === 'function' ? this.opts.enabled() !== false : true;
    }

    isEnded() {
        return typeof this.opts.isEnded === 'function' && !!this.opts.isEnded();
    }

    onIntersect(entry) {
        if (!entry.isIntersecting) {
            this.autoLoads = 0;
            if (this.state === 'manual') this.setState('idle');
            return;
        }
        if (this.state !== 'idle') return;
        if (this.autoLoads >= this.opts.maxAutoLoads) {
            this.setState('manual');
        } else {
            this.trigger();
        }
    }

    async trigger() {
        if (this.state === 'loading' || !this.isEnabled()) return;
        if (this.isEnded()) {
            this.setState('end');
            return;
        }
        this.setState('loading');
        let result;
        try {
            result = await this.opts.loadMore();
        } catch (err) {
            console.error('Loading older records failed:', err);
            this.setState('error');
            return;
        }
        const ended = !!result?.reachedEnd || this.isEnded();
        this.autoLoads++;
        this.setState(ended ? 'end' : (this.observer ? 'idle' : 'manual'));
        try {
            this.opts.onLoaded?.(result);
        } catch (err) {
            console.error('Re-render after loading older records failed:', err);
        }
        // Re-check visibility: if the sentinel is still on screen the
        // observer decides between another auto-load and the manual button.
        if (!ended) this.reobserve();
    }

    reobserve() {
        if (!this.observer) return;
        this.observer.unobserve(this.sentinel);
        this.observer.observe(this.sentinel);
    }

    setState(state) {
        this.state = state;
        const el = this.sentinel;
        el.dataset.state = state;
        el.textContent = '';
        el.style.display = '';

        if (state === 'disabled') {
            el.style.display = 'none';
            this.observer?.unobserve(el);
            return;
        }
        if (state === 'loading') {
            const spinner = document.createElement('span');
            spinner.className = 'history-range-spinner';
            el.appendChild(spinner);
            el.appendChild(document.createTextNode(this.labels.loading));
            return;
        }
        if (state === 'end') {
            this.observer?.unobserve(el);
            el.textContent = this.labels.end;
            return;
        }
        if (state === 'manual' || state === 'error') {
            if (state === 'error') {
                el.appendChild(document.createTextNode(this.labels.error + ' '));
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'infinite-scroll-more';
            btn.textContent = state === 'error' ? 'Retry' : this.labels.more;
            btn.addEventListener('click', () => {
                this.autoLoads = 0;
                this.state = 'idle';
                this.trigger();
            });
            el.appendChild(btn);
        }
    }

    /** Sync the sentinel with the current enabled/ended state. */
    update() {
        if (!this.listEl.isConnected) return;
        this.sentinel = this.ensureSentinel();
        if (this.state === 'loading') return;
        if (!this.isEnabled()) {
            this.setState('disabled');
            return;
        }
        if (this.isEnded()) {
            this.setState('end');
            return;
        }
        if (this.state === 'manual' || this.state === 'error') {
            this.setState(this.state);
            return;
        }
        if (!this.observer) {
            this.setState('manual');
            return;
        }
        this.setState('idle');
        this.reobserve();
    }

    destroy() {
        this.observer?.disconnect();
        this.sentinel?.remove();
        controllers.delete(this.listEl);
    }
}

/**
 * Attach (or refresh) infinite scroll on a list. Safe to call on every render.
 * @param {HTMLElement} listEl - The list container (sentinel goes right after it)
 * @param {Object} opts
 * @param {() => Promise<{reachedEnd?: boolean}>} opts.loadMore
 * @param {() => boolean} [opts.isEnded] - true when nothing older exists
 * @param {() => boolean} [opts.enabled] - false hides the sentinel (e.g. while searching)
 * @param {(result: Object) => void} [opts.onLoaded] - re-render after a load
 * @param {{loading?: string, end?: string, more?: string, error?: string}} [opts.labels]
 * @param {number} [opts.maxAutoLoads=3]
 * @param {string} [opts.rootMargin]
 * @returns {InfiniteScrollController|null}
 */
export function attachInfiniteScroll(listEl, opts) {
    if (!listEl) return null;
    let ctrl = controllers.get(listEl);
    if (ctrl) {
        ctrl.setOptions(opts);
    } else {
        ctrl = new InfiniteScrollController(listEl, opts);
        controllers.set(listEl, ctrl);
    }
    ctrl.update();
    return ctrl;
}

/** @returns {InfiniteScrollController|undefined} */
export function getInfiniteScroll(listEl) {
    return controllers.get(listEl);
}

/**
 * Infinite scroll that extends the shared history window by one month per
 * load (FirebaseService.loadOlderHistory); used by every history list.
 * @param {HTMLElement} listEl
 * @param {Object} [opts]
 * @param {string} [opts.noun='records'] - e.g. 'bills', 'expenses'
 * @param {(result: Object) => void} [opts.onLoaded]
 * @param {() => boolean} [opts.enabled]
 */
export function attachOlderHistoryScroll(listEl, { noun = 'records', onLoaded, enabled } = {}) {
    return attachInfiniteScroll(listEl, {
        loadMore: () => loadOlderHistory(1),
        isEnded: historyReachedEnd,
        enabled,
        onLoaded,
        // Each load reads a month of every history collection, so only auto-load
        // once per scroll-to-bottom; if the list didn't grow, ask the user.
        maxAutoLoads: 1,
        labels: olderLabels(noun)
    });
}
