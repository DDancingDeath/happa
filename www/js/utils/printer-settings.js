// Printer settings on this phone (#130, #107): saved printers, which one is in
// use, each printer's paper width and the preview-before-print choice. What the
// printed bill shows is shared by every phone (settings/app.receipt); the older
// per-phone choices are only used until a shared one exists. Pure: the caller
// stores the returned object.

/** Printable dots per line at 203 dpi. */
export const PAPER_DOTS = Object.freeze({ 58: 384, 80: 576 });
export const PAPER_WIDTHS = Object.freeze([58, 80]);
export const MAX_SAVED_PRINTERS = 5;

const widthOf = (mm) => (Number(mm) === 80 ? 80 : 58);

/** Dots per line for a paper width in mm (58 mm when unknown). */
export function paperDots(widthMm) {
    return PAPER_DOTS[widthOf(widthMm)];
}

/**
 * Reads any stored shape (old: one deviceId/deviceName) into
 * { enabled, deviceId, deviceName, previewFirst, printers: [{ deviceId, deviceName, widthMm }] }.
 */
export function normalizePrinterSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const printers = [];
    const add = (p) => {
        if (!p || !p.deviceId || printers.some(x => x.deviceId === String(p.deviceId))) return;
        printers.push({ deviceId: String(p.deviceId), deviceName: p.deviceName ? String(p.deviceName) : null, widthMm: widthOf(p.widthMm) });
    };
    if (Array.isArray(s.printers)) s.printers.forEach(add);
    if (s.deviceId) add({ deviceId: s.deviceId, deviceName: s.deviceName, widthMm: s.widthMm });
    const deviceId = s.deviceId ? String(s.deviceId) : null;
    const current = printers.find(p => p.deviceId === deviceId);
    return {
        enabled: !!s.enabled,
        deviceId,
        deviceName: current ? current.deviceName : null,
        previewFirst: !!s.previewFirst,
        printers: printers.slice(0, MAX_SAVED_PRINTERS),
        receipt: normalizeReceiptOptions(s.receipt)
    };
}

/** Raster threshold per print density: a higher threshold prints more grey edges black. */
export const DENSITY_THRESHOLDS = Object.freeze({ light: 96, normal: 128, dark: 176 });
export const RECEIPT_LANGS = Object.freeze(['app', 'en', 'hi']);
export const MAX_FOOTER_CHARS = 80;

/**
 * Receipt options (#107): { footer, qr, lang: 'app'|'en'|'hi', density: 'light'|'normal'|'dark' }.
 */
export function normalizeReceiptOptions(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
        footer: String(r.footer || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOOTER_CHARS),
        qr: !!r.qr,
        lang: RECEIPT_LANGS.includes(r.lang) ? r.lang : 'app',
        density: r.density in DENSITY_THRESHOLDS ? r.density : 'normal'
    };
}

export function setReceiptOptions(settings, patch) {
    const s = normalizePrinterSettings(settings);
    return { ...s, receipt: normalizeReceiptOptions({ ...s.receipt, ...patch }) };
}

/** Receipt options from a receipt ({ lang, density, … }) or printer settings ({ receipt }). */
const receiptOf = (r) => normalizeReceiptOptions(r?.receipt || r);

/** Language to print in: undefined = the app language. */
export function receiptLang(receipt) {
    const { lang } = receiptOf(receipt);
    return lang === 'app' ? undefined : lang;
}

export function rasterThreshold(receipt) {
    return DENSITY_THRESHOLDS[receiptOf(receipt).density];
}

/** Logo size on the slip: at most 384 × 120 dots, aspect kept, never enlarged. */
export const LOGO_MAX = Object.freeze({ width: 384, height: 120 });
/** Longest logo `bits` (base64 of 384 × 120 1-bit dots, 5,760 bytes); firestore.rules allow no more. */
export const LOGO_BITS_MAX = 7680;
export function logoSize(width, height) {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const k = Math.min(1, LOGO_MAX.width / w, LOGO_MAX.height / h);
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** A receipt logo { width, height, bits } (1-bit rows, base64) of the right size, or null. */
export function normalizeLogo(raw) {
    try {
        const ok = raw && Number.isInteger(raw.width) && Number.isInteger(raw.height)
            && raw.width > 0 && raw.height > 0 && raw.width <= LOGO_MAX.width && raw.height <= LOGO_MAX.height
            && typeof raw.bits === 'string' && raw.bits.length <= LOGO_BITS_MAX
            && atob(raw.bits).length === ((raw.width + 7) >> 3) * raw.height;
        return ok ? { width: raw.width, height: raw.height, bits: raw.bits } : null;
    } catch {
        return null;
    }
}

/**
 * The shop's receipt, shared by every phone (settings/app.receipt, #107):
 * { footer, qr, lang, density, logo }, or null when none has been saved yet.
 */
export function normalizeSharedReceipt(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return { ...normalizeReceiptOptions(raw), logo: normalizeLogo(raw.logo) };
}

/** What bills print with: the shared receipt, or this phone's own older choices until one is shared. */
export function effectiveReceipt(printerSettings, shared, localLogo) {
    return normalizeSharedReceipt(shared)
        || { ...normalizePrinterSettings(printerSettings).receipt, logo: normalizeLogo(localLogo) };
}

/** This phone has receipt choices of its own (not the defaults, or a logo) that could be shared. */
export function hasOwnReceipt(printerSettings, localLogo) {
    const own = normalizePrinterSettings(printerSettings).receipt;
    const plain = normalizeReceiptOptions({});
    return !!normalizeLogo(localLogo) || Object.keys(plain).some(k => own[k] !== plain[k]);
}

/** The printer in use, or null. */
export function currentPrinter(settings) {
    const s = normalizePrinterSettings(settings);
    return s.printers.find(p => p.deviceId === s.deviceId) || null;
}

/** Saves (or renames) a printer and puts it in use; the oldest drops off past the limit. */
export function usePrinter(settings, { deviceId, deviceName = null }) {
    const s = normalizePrinterSettings(settings);
    if (!deviceId) return s;
    const id = String(deviceId);
    const old = s.printers.find(p => p.deviceId === id);
    const entry = { deviceId: id, deviceName: deviceName ? String(deviceName) : (old?.deviceName || null), widthMm: old ? old.widthMm : 58 };
    const printers = [entry, ...s.printers.filter(p => p.deviceId !== id)].slice(0, MAX_SAVED_PRINTERS);
    return { ...s, deviceId: id, deviceName: entry.deviceName, printers };
}

/** Forgets a printer; when it was in use, no printer is in use. */
export function forgetPrinter(settings, deviceId) {
    const s = normalizePrinterSettings(settings);
    const printers = s.printers.filter(p => p.deviceId !== String(deviceId));
    if (s.deviceId !== String(deviceId)) return { ...s, printers };
    return { ...s, printers, deviceId: null, deviceName: null };
}

export function setPaperWidth(settings, deviceId, widthMm) {
    const s = normalizePrinterSettings(settings);
    return { ...s, printers: s.printers.map(p => (p.deviceId === String(deviceId) ? { ...p, widthMm: widthOf(widthMm) } : p)) };
}
