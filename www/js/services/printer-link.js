// Bluetooth link to the receipt printer (#77): every call has a timeout, a
// dropped link is reconnected before a job, the reconnect is retried a limited
// number of times, and a job whose bytes may have reached the printer is never
// sent again on its own. The transport is injected so tests can fake it.

export const LINK_TIMEOUTS = Object.freeze({
    checkMs: 3000,
    connectMs: 8000,
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
        connect: (deviceId, onDrop) => call('connect', [deviceId], onDrop),
        disconnect: () => call('disconnect', []),
        isConnected: () => call('isConnected', []).then(() => true, () => false),
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
        this.status = { checkedAt: null, lastError: null, lastJob: null };
        this.onChange = null;
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

    async connect(deviceId, deviceName = null) {
        try {
            await withTimeout(
                this.transport.connect(deviceId, (error) => this._dropped(deviceId, error)),
                this.timeouts.connectMs,
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

    async disconnect() {
        const had = this.deviceId;
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

    /**
     * Sends one job; jobs run one at a time.
     * @param {Uint8Array} bytes
     * @param {{deviceId?: string, deviceName?: string}} [target] printer to reconnect to
     * @returns {Promise<{outcome: 'printed', attempts: number}>}
     * @throws {PrinterLinkError} outcome 'failed' or 'uncertain'
     */
    send(bytes, target = {}) {
        const run = this._queue.then(() => this._job(bytes, target));
        this._queue = run.catch(() => {});
        return run;
    }

    _finish(outcome, error = null) {
        this.status.lastJob = { outcome, at: this.now() };
        if (error) this._recordError(error);
        else this.status.lastError = null;
        this._changed();
        return error;
    }

    async _job(bytes, target) {
        if (!this.transport.available()) {
            throw this._finish('failed', new PrinterLinkError('unavailable', 'Bluetooth Serial plugin not available'));
        }
        const deviceId = this.deviceId || target.deviceId || this.lastDevice?.deviceId;
        const deviceName = this.deviceName || target.deviceName || this.lastDevice?.deviceName || null;
        if (!deviceId) throw this._finish('failed', new PrinterLinkError('no_printer', 'No printer selected'));

        const { attempts, backoffMs } = this.retry;
        let linked = false;
        let lastError = null;
        let tries = 0;
        while (!linked && tries < attempts) {
            if (tries > 0) await this.sleep(backoffMs[Math.min(tries - 1, backoffMs.length - 1)] || 0);
            tries++;
            try {
                linked = (await this.check()) || (await this.connect(deviceId, deviceName));
            } catch (error) {
                lastError = error;
            }
        }
        if (!linked) throw this._finish('failed', lastError || new PrinterLinkError('connect', 'Connection failed'));

        try {
            await withTimeout(this.transport.write(bytes), this.writeTimeoutMs(bytes.length), 'timeout_write');
        } catch (e) {
            const kind = e instanceof PrinterLinkError ? e.kind : 'write';
            if (kind === 'timeout_write') this._reset();
            throw this._finish('uncertain', new PrinterLinkError(kind, asError(e, 'Print failed').message, 'uncertain'));
        }
        if (!(await this.check())) {
            throw this._finish('uncertain', new PrinterLinkError('dropped', 'Connection lost while printing', 'uncertain'));
        }
        this._finish('printed');
        return { outcome: 'printed', attempts: tries };
    }
}
