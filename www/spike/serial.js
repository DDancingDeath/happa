// Desktop printing spike (#133): prints the app's own test receipt from a
// Windows computer, first over Web Serial (Bluetooth SPP / COM port), else
// through the Windows print dialog. Saves nothing, needs no login.
import { applyTranslations, t } from '/js/i18n/index.js';
import { PrinterService, packMonochromeRaster, buildRasterPrintCommand } from '/js/services/printer.js';
import { PrinterLink } from '/js/services/printer-link.js';
import { webSerialTransport } from '/spike/web-serial-transport.js';

const $ = (id) => document.getElementById(id);
const transport = webSerialTransport();
let link = new PrinterLink({ transport });
let chosen = null;
let printing = false;

function log(line) {
    const stamp = new Date().toTimeString().slice(0, 8);
    $('log').textContent += `${stamp} ${line}\n`;
}

function browserName() {
    const brands = navigator.userAgentData?.brands?.filter(b => !/Not/.test(b.brand)).map(b => `${b.brand} ${b.version}`);
    return brands?.length ? brands.join(', ') : navigator.userAgent;
}

function testBill() {
    return {
        type: 'TEST',
        billNumber: 'TEST-PC',
        date: new Date().toISOString(),
        customerName: t('ui.print.test_customer'),
        items: [{ name: t('ui.print.test_item'), qty: 10, rate: 100, total: 1000, weights: [10] }],
        billTotal: 1000,
        laborCharges: 6,
        amountPayable: 1006,
        isPurchase: true
    };
}

async function drawSlip() {
    const slip = await PrinterService.manager.generateBillCanvas(testBill());
    const view = $('slip');
    view.width = slip.width;
    view.height = slip.height;
    view.getContext('2d').drawImage(slip, 0, 0);
    $('slipImage').src = slip.toDataURL('image/png');
    return slip;
}

function slipBytes(canvas) {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return buildRasterPrintCommand(packMonochromeRaster(data, canvas.width, canvas.height), (canvas.width + 7) >> 3, canvas.height);
}

async function choose() {
    if (printing) return;
    try {
        const picked = await transport.request();
        if (picked.id !== chosen?.id) {
            await transport.disconnect();
            link = new PrinterLink({ transport });
        }
        chosen = picked;
        const info = (await navigator.serial.getPorts())[Number(chosen.id.slice(5))]?.getInfo?.() || {};
        $('chosen').textContent = t(chosen.bluetooth ? 'ui.spike.chosen_bluetooth' : 'ui.spike.chosen_serial');
        $('print').disabled = false;
        log(`chosen ${chosen.id} info=${JSON.stringify(info)}`);
    } catch (error) {
        log(`choose failed: ${error.name || ''} ${error.message || error}`);
    }
}

async function printSerial() {
    if (!chosen || printing) return;
    printing = true;
    $('print').disabled = true;
    $('choose').disabled = true;
    const started = performance.now();
    try {
        const bytes = slipBytes(await drawSlip());
        log(`sending ${bytes.length} bytes to ${chosen.id}`);
        const result = await link.send(bytes, { deviceId: chosen.id, deviceName: chosen.name }, { mode: 'full' });
        log(`result ${result.outcome} after ${Math.round(performance.now() - started)} ms (tries ${result.attempts})`);
    } catch (error) {
        log(`print ${error.outcome || 'failed'} (${error.kind || error.name || ''}) after ${Math.round(performance.now() - started)} ms: ${error.message || error}`);
    } finally {
        printing = false;
        $('print').disabled = false;
        $('choose').disabled = false;
    }
}

async function printWindows() {
    await drawSlip();
    log('opening the Windows print window');
    window.print();
}

function init() {
    applyTranslations(document);
    const serial = 'serial' in navigator;
    $('support').textContent = t(serial ? 'ui.spike.serial_yes' : 'ui.spike.serial_no');
    $('choose').disabled = !serial;
    log(`browser ${browserName()}; web serial ${serial ? 'yes' : 'no'}; ${navigator.platform || ''}`);
    $('choose').addEventListener('click', choose);
    $('print').addEventListener('click', printSerial);
    $('winprint').addEventListener('click', printWindows);
    drawSlip().catch((error) => log(`slip failed: ${error.message || error}`));
}

init();
