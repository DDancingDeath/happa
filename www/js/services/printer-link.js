// Bluetooth link to the receipt printer (#77): every call has a timeout and
// jobs (prints and manual connects) run one at a time. A bill makes one quick
// reconnect when the link is down; Test Print and Connect retry with backoff.
// A job whose bytes may have reached the printer is never sent again on its
// own. The transport is injected so tests can fake it.

export const LINK_TIMEOUTS = Object.freeze({
    checkMs: 3000,
    connectMs: 8000,
    quickConnectMs: 3500,
    writeBaseMs: 8000,
    writePerKbMs: 250
});

export const LINK_RETRY = Object.freeze({ attempts: 3, backoffMs: [1000, 2000] });

/**
 * outcome 'failed': nothing was sent, printing again is safe.
 * outcome 'uncertain': bytes may have reached the printer (may have printed).
 */
export class PrinterLinkError extends Error {
    constructor(kind, message, outcome = 'failed') {
        super(message || kind);
        this.name = 'PrinterLinkError';
        this.kind = kind;
        this.outcome = outcome;
    }
}

const asError = (e, fallback) => (e instanceof Error ? e : new Error(e || fallback));

export function withTimeout(promise, ms, kind) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PrinterLinkError(kind, `${kind} (${ms} ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Promise wrapper over the cordova bluetoothSerial plugin, looked up on every
 * call. The plugin calls connect's failure callback again when an open link
 * drops later; that is passed to onDrop.
 */
export function cordovaTransport(getPlugin = () => window.bluetoothSerial) {
    const call = (method, args, onLateError) => new Promise((resolve, reject) => {
        const plugin = getPlugin();
        if (!plugin || typeof plugin[method] !== 'function') {
            reject(new PrinterLinkError('unavailable', 'Bluetooth Serial plugin not available'));
            return;
        }
        let settled = false;
        try {
            plugin[method](...args, (value) => {
                settled = true;
                resolve(value);
            }, (error) => {
                if (settled) {
                    if (onLateError) onLateError(asError(error, 'Connection lost'));
                    return;
                }
                settled = true;
                reject(asError(error, `${method} failed`));
            });
        } catch (error) {
            reject(asError(error, `${method} failed`));
        }
    });
    return {
        available: () => !!getPlugin(),
        canCheck: () => typeof getPlugin()?.isConnected === 'function',
        canCheckEnabled: () => typeof getPlugin()?.isEnabled === 'function',
        connect: (deviceId, onDrop) => call('connect', [deviceId], onDrop),
        disconnect: () => call('disconnect', []),
        isConnected: () => call('isConnected', []).then(() => true, () => false),
        isEnabled: () => call('isEnabled', []).then(() => true, () => false),
        enable: () => call('enable', []),
        write: (bytes) => call('write', [bytes]),
        list: () => call('list', [])
    };
}

export class PrinterLink {
    constructor({ transport = cordovaTransport(), timeouts = {}, retry = {}, sleep, now } = {}) {
        this.transport = transport;
        this.timeouts = { ...LINK_TIMEOUTS, ...timeouts };
        this.retry = { ...LINK_RETRY, ...retry };
        this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = now || (() => Date.now());
        this.deviceId = null;
        this.deviceName = null;
        this.lastDevice = null;
        this.status = { checkedAt: null, lastError: null, lastJob: null, bluetoothOff: false };
        this.onChange = null;
        this.stopped = false;
        this._queue = Promise.resolve();
    }

    writeTimeoutMs(byteCount) {
        return this.timeouts.writeBaseMs + Math.ceil(byteCount / 1024) * this.timeouts.writePerKbMs;
    }

    _recordError(error) {
        this.status.lastError = { kind: error.kind || 'plugin', message: error.message, at: this.now() };
    }

    _changed() {
        if (typeof this.onChange === 'function') this.onChange();
    }

    _dropped(deviceId, error) {
        if (this.deviceId !== deviceId) return;
        this.deviceId = null;
        this._recordError(new PrinterLinkError('dropped', error?.message));
        this._changed();
    }

    async list() {
        return withTimeout(this.transport.list(), this.timeouts.connectMs, 'timeout_list');
    }

    /** False when the phone's Bluetooth is off or missing; true when on or the plugin can't tell. */
    async bluetoothOn() {
        if (!this.transport.canCheckEnabled?.()) return true;
        let on = true;
        try {
            on = await withTimeout(this.transport.isEnabled(), this.timeouts.checkMs, 'timeout_check');
        } catch {
            on = true;
        }
        this.status.bluetoothOff = !on;
        return on;
    }

    /** Asks Android to turn Bluetooth on (the user answers a system dialog). */
    async enableBluetooth() {
        if (await this.bluetoothOn()) return true;
        if (typeof this.transport.enable !== 'function') throw new PrinterLinkError('bluetooth_off', 'Bluetooth is off');
        try {
            await this.transport.enable();
        } catch {
            throw new PrinterLinkError('bluetooth_off', 'Bluetooth is off');
        }
        this.status.bluetoothOff = false;
        return true;
    }

    async connect(deviceId, deviceName = null, timeoutMs = this.timeouts.connectMs) {
        try {
            await withTimeout(
                this.transport.connect(deviceId, (error) => this._dropped(deviceId, error)),
                timeoutMs,
                'timeout_connect'
            );
        } catch (e) {
            const error = e instanceof PrinterLinkError ? e : new PrinterLinkError('connect', asError(e, 'Connection failed').message);
            this.deviceId = null;
            this._recordError(error);
            throw error;
        }
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.lastDevice = { deviceId, deviceName };
        this.status.checkedAt = this.now();
        this.status.lastError = null;
        return true;
    }

    /** Asks the plugin whether the link is up; a dropped link clears the device. */
    async check() {
        if (!this.deviceId) return false;
        if (!this.transport.canCheck()) return true;
        let up = false;
        try {
            up = await withTimeout(this.transport.isConnected(), this.timeouts.checkMs, 'timeout_check');
        } catch (error) {
            this._recordError(error);
        }
        this.status.checkedAt = this.now();
        if (!up) this.deviceId = null;
        return up;
    }

    /** The user's Disconnect: no reconnects until connectNow() succeeds. */
    async disconnect() {
        const had = this.deviceId;
        this.stopped = true;
        this.deviceId = null;
        this.deviceName = null;
        this.lastDevice = null;
        if (!had) return;
        try {
            await withTimeout(this.transport.disconnect(), this.timeouts.checkMs, 'timeout_check');
        } catch (error) {
            console.warn('[PRINTER] disconnect:', error?.message || error);
        }
    }

    /** Closes the link after an unanswered write so the next job starts clean. */
    _reset() {
        const id = this.deviceId;
        this.deviceId = null;
        if (!id) return;
        withTimeout(this.transport.disconnect(), this.timeouts.checkMs, 'timeout_check')
            .catch((error) => console.warn('[PRINTER] reset:', error?.message || error));
    }

    _enqueue(job) {
        const run = this._queue.then(job);
        this._queue = run.catch(() => {});
        return run;
    }

    /** Up to `attempts` checks/connects with backoff; resolves true or throws the last error. */
    async _linkWithRetries(deviceId, deviceName) {
        const { attempts, backoffMs } = this.retry;
        let lastError = null;
        for (let tries = 0; tries < attempts; tries++) {
            if (tries > 0) await this.sleep(backoffMs[Math.min(tries - 1, backoffMs.length - 1)] || 0);
            try {
                if ((await this.check()) || (await this.connect(deviceId, deviceName))) return tries + 1;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new PrinterLinkError('connect', 'Connection failed');
    }

    /** The user's Connect button: queued behind any print, retried with backoff. */
    connectNow(deviceId, deviceName = null) {
        return this._enqueue(async () => {
            if (this.deviceId && this.deviceId !== deviceId) this._reset();
            await this._linkWithRetries(deviceId, deviceName);
            this.stopped = false;
            this._changed();
            return true;
        });
    }

    /**
     * Sends one job; jobs run one at a time.
     * mode 'quick' (bills): a 3 s check when linked, else one short connect.
     * mode 'full' (Test Print): check/connect retried with backoff.
     * confirmReprint() runs inside the queue, before anything is sent; false cancels.
     * @param {Uint8Array} bytes
     * @param {{deviceId?: string, deviceName?: string}} [target] printer to reconnect to
     * @param {{mode?: 'quick'|'full', confirmReprint?: () => Promise<boolean>}} [options]
     * @returns {Promise<{outcome: 'printed'|'cancelled', attempts?: number}>}
     * @throws {PrinterLinkError} outcome 'failed' or 'uncertain'
     */
    send(bytes, target = {}, options = {}) {
        return this._enqueue(() => this._job(bytes, target, options));
    }

    _finish(outcome, error = null) {
        this.status.lastJob = { outcome, at: this.now() };
        if (error) this._recordError(error);
        else this.status.lastError = null;
        this._changed();
        return error;
    }

    async _job(bytes, target, { mode = 'quick', confirmReprint, onUncertain, onPrinted } = {}) {
        if (confirmReprint && !(await confirmReprint())) return { outcome: 'cancelled' };
        if (!this.transport.available()) {
            throw this._finish('failed', new PrinterLinkError('unavailable', 'Bluetooth Serial plugin not available'));
        }
        if (this.stopped) throw this._finish('failed', new PrinterLinkError('stopped', 'Printer disconnected'));
        const deviceId = this.deviceId || target.deviceId || this.lastDevice?.deviceId;
        const deviceName = this.deviceName || target.deviceName || this.lastDevice?.deviceName || null;
        if (!deviceId) throw this._finish('failed', new PrinterLinkError('no_printer', 'No printer selected'));

        let attempts = 1;
        try {
            if (mode === 'full') {
                attempts = await this._linkWithRetries(deviceId, deviceName);
            } else if (!(await this.check())) {
                await this.connect(deviceId, deviceName, this.timeouts.quickConnectMs);
            }
        } catch (error) {
            throw this._finish('failed', error);
        }

        try {
            await withTimeout(this.transport.write(bytes), this.writeTimeoutMs(bytes.length), 'timeout_write');
        } catch (e) {
            const kind = e instanceof PrinterLinkError ? e.kind : 'write';
            if (kind === 'timeout_write') this._reset();
            if (onUncertain) onUncertain();
            throw this._finish('uncertain', new PrinterLinkError(kind, asError(e, 'Print failed').message, 'uncertain'));
        }
        if (!(await this.check())) {
            if (onUncertain) onUncertain();
            throw this._finish('uncertain', new PrinterLinkError('dropped', 'Connection lost while printing', 'uncertain'));
        }
        if (onPrinted) onPrinted();
        this._finish('printed');
        return { outcome: 'printed', attempts };
    }
}