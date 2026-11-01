// Desktop printing spike (#133): a PrinterLink transport over the Web Serial API
// (Chrome / Edge 117+ on a computer). A paired Bluetooth receipt printer shows up
// as a Serial Port Profile port, or as its Windows "outgoing" COM port. Not used
// by the app yet (so not in the service worker's lists); only the test page
// /spike/serial.html loads it.

/** Serial Port Profile service class id. */
export const SPP_SERVICE_CLASS_ID = '00001101-0000-1000-8000-00805f9b34fb';

/**
 * @param {() => Serial|undefined} [getSerial]
 * @param {{baudRate?: number}} [options] Bluetooth ports ignore the baud rate; a cable port may not
 */
export function webSerialTransport(getSerial = () => (typeof navigator !== 'undefined' ? navigator.serial : undefined), { baudRate = 9600 } = {}) {
    let open = null;

    const ports = async () => {
        const serial = getSerial();
        if (!serial) throw Object.assign(new Error('Web Serial is not available'), { kind: 'unavailable' });
        return serial.getPorts();
    };

    const describe = (port, index) => {
        const info = port.getInfo?.() || {};
        const bluetooth = !!info.bluetoothServiceClassId;
        return { id: `port:${index}`, address: `port:${index}`, name: bluetooth ? `Bluetooth ${index + 1}` : `Serial ${index + 1}`, bluetooth };
    };

    async function close() {
        const current = open;
        open = null;
        if (!current) return;
        try { current.writer.releaseLock(); } catch { /* already released */ }
        try { await current.port.close(); } catch { /* already closed */ }
    }

    return {
        available: () => !!getSerial(),
        canCheck: () => true,

        /** Ports this site may already use (no prompt). */
        async list() {
            return (await ports()).map(describe);
        },

        /** Asks the user to pick a port (needs a click); returns it as listed. */
        async request() {
            const serial = getSerial();
            if (!serial) throw Object.assign(new Error('Web Serial is not available'), { kind: 'unavailable' });
            const port = await serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_SERVICE_CLASS_ID] });
            const all = await serial.getPorts();
            return describe(port, Math.max(0, all.indexOf(port)));
        },

        async connect(deviceId, onDrop) {
            const index = Number(String(deviceId).replace('port:', ''));
            const port = (await ports())[index];
            if (!port) throw new Error('Printer port not found');
            if (open?.port === port && port.writable) return true;
            await close();
            await port.open({ baudRate });
            open = { port, writer: port.writable.getWriter() };
            port.addEventListener?.('disconnect', () => {
                if (open?.port !== port) return;
                close();
                if (onDrop) onDrop(new Error('Printer disconnected'));
            });
            return true;
        },

        disconnect: close,

        async isConnected() {
            return !!(open && open.port.writable && open.port.connected !== false);
        },

        /** A failed write closes the port, so the next print opens it afresh. */
        async write(bytes) {
            if (!open) throw new Error('Not connected');
            try {
                await open.writer.ready;
                await open.writer.write(bytes);
            } catch (error) {
                await close();
                throw error;
            }
        }
    };
}
