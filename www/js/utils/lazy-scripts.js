// @ts-check
// On-demand loader for large third-party libraries that are only needed by
// specific features, so they don't block or slow down the first page load.

// Pinned version + Subresource Integrity: the browser refuses to run the file
// if the CDN ever serves different bytes. Update both together when upgrading.
export const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
export const XLSX_INTEGRITY = 'sha384-QCIdq2UMVEoSRhR3ZWZwdz2/pivLowr+eokFMdYyukq7qI26VYRxFa4Nl6FKetmL';

const pending = new Map();

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

export function ensureXLSX() {
    return loadScriptOnce(XLSX_URL, 'XLSX', XLSX_INTEGRITY);
}