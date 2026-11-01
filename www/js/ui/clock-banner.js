/**
 * @fileoverview Wrong-clock banner at start-up (#115). Once a day the phone's clock is
 * compared with the server's (utils/clock-skew.js dailyClockSkew: one ID-token refresh,
 * no Firestore read); when it is off by CLOCK_WRONG_MS or more, a banner says so: bills
 * would get the wrong time and payments are refused by the server.
 * @module ui/clock-banner
 */

import { t } from '../i18n/index.js';
import { dailyClockSkew, isClockWrong, skewMinutes } from '../utils/clock-skew.js';

export const CLOCK_BANNER_ID = 'clockSkewBanner';

/**
 * Shows the banner for a wrong clock, removes it otherwise.
 * @param {?number} skewMs server time minus phone time
 * @param {{doc?: Document, onRecheck?: Function}} [opts]
 * @returns {?HTMLElement}
 */
export function renderClockBanner(skewMs, { doc = document, onRecheck } = {}) {
    let banner = doc.getElementById(CLOCK_BANNER_ID);
    if (!isClockWrong(skewMs)) {
        banner?.remove();
        return null;
    }
    if (!banner) {
        banner = doc.createElement('div');
        banner.id = CLOCK_BANNER_ID;
        banner.className = 'clock-banner';
        banner.setAttribute('role', 'alert');
        doc.body.appendChild(banner);
    }
    banner.textContent = '';
    const text = doc.createElement('span');
    text.className = 'clock-banner__text';
    text.textContent = t(skewMs > 0 ? 'ui.clock.behind' : 'ui.clock.ahead', { minutes: skewMinutes(skewMs) });
    const again = doc.createElement('button');
    again.type = 'button';
    again.className = 'clock-banner__recheck';
    again.textContent = t('ui.clock.recheck');
    again.addEventListener('click', () => onRecheck?.());
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'clock-banner__close';
    close.setAttribute('aria-label', t('ui.common.close'));
    close.textContent = '×';
    close.addEventListener('click', () => banner.remove());
    banner.append(text, again, close);
    return banner;
}

/**
 * Start-up check: at most one measurement a day; Check again measures now.
 * @param {{storage?: Storage, doc?: Document, measure?: Function, toast?: function(string): void}} [opts]
 * @returns {Promise<?number>} the skew used
 */
export async function startClockCheck({ storage = globalThis.localStorage, doc = document, measure, toast = () => {} } = {}) {
    const show = (skew) => renderClockBanner(skew, { doc, onRecheck: recheck });
    async function recheck() {
        const skew = await dailyClockSkew({ storage, measure, force: true });
        if (skew === null) {
            toast(t('msg.clock.unknown'));
            return;
        }
        show(skew);
        if (!isClockWrong(skew)) toast(t('msg.clock.ok'));
    }
    const skew = await dailyClockSkew({ storage, measure });
    show(skew);
    return skew;
}
