// @ts-check
// On-demand loader for large third-party libraries that are only needed by
// specific features, so they don't block or slow down the first page load.

// Pinned version + Subresource Integrity: the browser refuses to run the file
// if the CDN ever serves different bytes. Update both together when upgrading.
export const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
export const XLSX_INTEGRITY = 'sha384-QCIdq2UMVEoSRhR3ZWZwdz2/pivLowr+eokFMdYyukq7qI26VYRxFa4Nl6FKetmL';

// The SheetJS build that writes .xlsx (no other formats), served from our own origin and
// cached by the service worker (LAZY_ASSETS), so saving an Excel file works offline (#415).
export const XLSX_WRITER_URL = '/vendor/sheetjs/0.20.1/xlsx.mini.min.js';
export const XLSX_WRITER_INTEGRITY = 'sha384-TjXf35Uh6/vxwJHl0xpS1x7QP39uEDl2FNRB3NRPJWTI7DWi/EiVP3nNoo9N98qt';

const pending = new Map();
/** window.XLSX when it is the writer-only build (ensureXLSX still loads the full one). @type {*} */
let writerOnly = null;
let fullLoaded = false;

/**
 * @param {string} src
 * @param {string} [globalName] - window property the script defines
 * @param {string} [integrity] - SRI hash; when set the script is fetched with CORS
 */
export function loadScriptOnce(src, globalName, integrity) {
    if (globalName && typeof window !== 'undefined' && /** @type {Rec} */ (/** @type {unknown} */ (window))[globalName]) {
        return Promise.resolve(/** @type {Rec} */ (/** @type {unknown} */ (window))[globalName]);
    }
    if (pending.has(src)) return pending.get(src);

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        if (integrity) {
            script.integrity = integrity;
            script.crossOrigin = 'anonymous';
        }
        script.onload = () => {
            if (globalName && !/** @type {Rec} */ (/** @type {unknown} */ (window))[globalName]) {
                reject(new Error(`${src} loaded but window.${globalName} is missing`));
                return;
            }
            resolve(globalName ? /** @type {Rec} */ (/** @type {unknown} */ (window))[globalName] : undefined);
        };
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });

    // Allow a retry after a failure (e.g. the user was offline).
    promise.catch(() => pending.delete(src));
    pending.set(src, promise);
    return promise;
}

const currentXLSX = () => (typeof window !== 'undefined' ? /** @type {Rec} */ (/** @type {unknown} */ (window)).XLSX : undefined);

/** Full SheetJS (reads Excel / CSV files too), from its CDN. */
export function ensureXLSX() {
    const have = currentXLSX();
    if (have && have !== writerOnly) return Promise.resolve(have);
    return loadScriptOnce(XLSX_URL, undefined, XLSX_INTEGRITY).then(() => {
        const X = currentXLSX();
        if (!X || X === writerOnly) throw new Error(`${XLSX_URL} loaded but window.XLSX is missing`);
        fullLoaded = true;
        return X;
    });
}

/** SheetJS for writing .xlsx files only: the full build when already loaded, else our own copy (works offline). */
export function ensureXLSXWriter() {
    const have = currentXLSX();
    if (have) return Promise.resolve(have);
    return loadScriptOnce(XLSX_WRITER_URL, 'XLSX', XLSX_WRITER_INTEGRITY).then((/** @type {*} */ X) => {
        if (!fullLoaded) writerOnly = X;
        return X;
    });
}