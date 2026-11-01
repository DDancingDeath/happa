/**
 * @fileoverview Desktop printing spike (#133): the Web Serial transport works
 * with PrinterLink (connect once, write the raster, drop = uncertain).
 */
import { webSerialTransport, SPP_SERVICE_CLASS_ID } from '../../spike/web-serial-transport.js';
import { PrinterLink } from '../services/printer-link.js';

function fakePort({ bluetooth = true, openFails = false } = {}) {
    const listeners = {};
    const written = [];
    const port = {
        written,
        connected: true,
        writable: null,
        getInfo: () => (bluetooth ? { bluetoothServiceClassId: SPP_SERVICE_CLASS_ID } : { usbVendorId: 1 }),
        open: jest.fn(async () => {
            if (openFails) throw new Error('Failed to open serial port.');
            port.writable = {
                getWriter: () => ({ ready: Promise.resolve(), write: async (b) => { written.push(b); }, releaseLock: jest.fn() })
            };
        }),
        close: jest.fn(async () => { port.writable = null; }),
        addEventListener: (name, fn) => { listeners[name] = fn; },
        fire: (name) => listeners[name]?.()
    };
    return port;
}

function fakeSerial(ports) {
    return {
        getPorts: async () => ports,
        requestPort: jest.fn(async (opts) => {
            expect(opts.allowedBluetoothServiceClassIds).toContain(SPP_SERVICE_CLASS_ID);
            return ports[ports.length - 1];
        })
    };
}

test('not available without navigator.serial', async () => {
    const tr = webSerialTransport(() => undefined);
    expect(tr.available()).toBe(false);
    await expect(tr.list()).rejects.toMatchObject({ kind: 'unavailable' });
});

test('request lists the chosen port; a print opens it once and sends the bytes', async () => {
    const usb = fakePort({ bluetooth: false });
    const bt = fakePort();
    const tr = webSerialTransport(() => fakeSerial([usb, bt]));
    const chosen = await tr.request();
    expect(chosen).toMatchObject({ id: 'port:1', bluetooth: true });
    expect(await tr.list()).toEqual([
        expect.objectContaining({ id: 'port:0', bluetooth: false }),
        expect.objectContaining({ id: 'port:1', bluetooth: true })
    ]);

    const link = new PrinterLink({ transport: tr, sleep: () => Promise.resolve() });
    const bytes = new Uint8Array([0x1B, 0x40]);
    await expect(link.send(bytes, { deviceId: chosen.id }, { mode: 'full' })).resolves.toMatchObject({ outcome: 'printed' });
    await link.send(bytes, { deviceId: chosen.id });
    expect(bt.open).toHaveBeenCalledTimes(1);
    expect(bt.open).toHaveBeenCalledWith({ baudRate: 9600 });
    expect(bt.written).toEqual([bytes, bytes]);
    expect(usb.open).not.toHaveBeenCalled();
});

test('a port that will not open fails before anything is sent (safe to retry)', async () => {
    const port = fakePort({ openFails: true });
    const link = new PrinterLink({ transport: webSerialTransport(() => fakeSerial([port])), sleep: () => Promise.resolve() });
    await expect(link.send(new Uint8Array([1]), { deviceId: 'port:0' })).rejects.toMatchObject({ outcome: 'failed' });
    expect(port.written).toEqual([]);
});

test('a failed write closes the port; the next print opens it again', async () => {
    const port = fakePort();
    let fail = true;
    const open = port.open.getMockImplementation();
    port.open.mockImplementation(async () => {
        await open();
        const ok = port.writable.getWriter;
        port.writable.getWriter = () => {
            const w = ok();
            return { ...w, write: async (b) => { if (fail) { fail = false; throw new Error('device lost'); } return w.write(b); } };
        };
    });
    const link = new PrinterLink({ transport: webSerialTransport(() => fakeSerial([port])), sleep: () => Promise.resolve() });
    await expect(link.send(new Uint8Array([1]), { deviceId: 'port:0' })).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(port.close).toHaveBeenCalled();
    await expect(link.send(new Uint8Array([2]), { deviceId: 'port:0' })).resolves.toMatchObject({ outcome: 'printed' });
    expect(port.open).toHaveBeenCalledTimes(2);
    expect(port.written).toEqual([new Uint8Array([2])]);
});

test('a disconnect closes the port and tells the link', async () => {
    const port = fakePort();
    const tr = webSerialTransport(() => fakeSerial([port]));
    const onDrop = jest.fn();
    await tr.connect('port:0', onDrop);
    expect(await tr.isConnected()).toBe(true);
    port.fire('disconnect');
    await Promise.resolve();
    expect(onDrop).toHaveBeenCalled();
    expect(await tr.isConnected()).toBe(false);
});
