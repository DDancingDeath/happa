// Printer settings on this phone (#130): saved printers, which one is in use,
// each printer's paper width, and the preview-before-print choice. Pure: the
// caller stores the returned object.

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
        printers: printers.slice(0, MAX_SAVED_PRINTERS)
    };
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
