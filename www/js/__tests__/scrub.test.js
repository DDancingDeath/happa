/**
 * @fileoverview Error reports carry no personal data or secrets (#116), and audit
 * entries name what changed (#85).
 */
import { scrubText, scrubUrl, describeLogArg } from '../utils/scrub.js';
import { changedFields, formatAuditDetails } from '../utils/audit-changes.js';
import { buildTelemetryDoc, TelemetryService } from '../services/telemetry.js';

describe('scrubText (#116)', () => {
    test.each([
        ['Login failed for ram.kumar@gmail.com', 'Login failed for <email>'],
        ['Call 9876543210 now', 'Call <phone> now'],
        ['Call +91 98765 43210 now', 'Call <phone> now'],
        ['Call 098765-43210', 'Call <phone>'],
        ['Call 919876543210 now', 'Call <phone> now'],
        ['Call +91 987 654 3210 now', 'Call <phone> now'],
        ['Pay ramesh.k@okaxis today', 'Pay <upi> today'],
        ['Pay 9876543210@ybl', 'Pay <upi>'],
        // Safari / Firefox stack frames keep their function names and hosts
        ['render@https://myhappa.web.app/js/modules/money.js:585:12', 'render@https://myhappa.web.app/js/modules/money.js:585:12'],
        ['Object.loadAuditLogs@http://localhost:5000/js/a.js:1:2', 'Object.loadAuditLogs@http://localhost:5000/js/a.js:1:2'],
        ['Due ₹5,866.50 left', 'Due ₹<amount> left'],
        ['paid Rs. 1200', 'paid ₹<amount>'],
        ['Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz', 'Bearer <token>'],
        ['token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz', 'token <token>'],
        ['https://x/?apiKey=AIzaSyA1234567890abcdefghijklmn&mode=reset', 'https://x/?apiKey=<redacted>&mode=reset'],
        ['key AIzaSyA1234567890abcdefghijklmnop', 'key <key>'],
        ['oobCode=ABCdef123 failed', 'oobCode=<redacted> failed'],
        ['id ' + 'a1B2c3D4e5'.repeat(4), 'id <token>']
    ])('%s', (input, out) => {
        expect(scrubText(input)).toBe(out);
    });

    test('keeps ordinary error text, stack lines, ids and times', () => {
        const stack = 'TypeError: x is undefined\n    at render (https://myhappa.web.app/js/modules/stock.js?v=20261101r:123:45)';
        expect(scrubText(stack)).toBe(stack);
        expect(scrubText('bill P20261021-002 at 1761234567890 (doc abcDEF1234567890XYZa)')).toBe('bill P20261021-002 at 1761234567890 (doc abcDEF1234567890XYZa)');
        // 13-digit times (also ones starting with 91…), ids with digits inside and seconds stay
        expect(scrubText('at 9176123456789 and 1761234567 id a9876543210b K7x9876543210Qp')).toBe('at 9176123456789 and 1761234567 id a9876543210b K7x9876543210Qp');
        expect(scrubText(undefined)).toBeUndefined();
        expect(scrubText(5)).toBe(5);
    });

    test('scrubUrl drops query strings, keeps the route', () => {
        expect(scrubUrl('https://myhappa.web.app/?emulator=1&token=abc#outstanding?x=1')).toBe('https://myhappa.web.app/#outstanding');
        expect(scrubUrl('https://myhappa.web.app/r/tok?mode=x')).toBe('https://myhappa.web.app/r/tok');
    });

    test('long text stays fast (no backtracking blow-up) and is cut', () => {
        const started = Date.now();
        ['a', '1', 'a-', 'a.'].forEach(s => scrubText(s.repeat(100000)));
        expect(Date.now() - started).toBeLessThan(1000);
        expect(scrubText('x '.repeat(10000)).length).toBe(8000);
    });

    test('a Firestore "create index" link is kept', () => {
        const link = 'https://console.firebase.google.com/v1/r/project/p/firestore/indexes?create_composite=ClBwcm9qZWN0cy9oYXBwYS1iZmMwNy9kYXRhYmFzZXMv';
        expect(scrubText(`The query requires an index: ${link}`)).toBe(`The query requires an index: ${link}`);
    });

    test('console.error arguments: objects give only their code', () => {
        expect(describeLogArg(new Error('No account for a@b.co'))).toBe('No account for <email>');
        expect(describeLogArg({ customerName: 'Sita', amount: 500 })).toBe('[object]');
        expect(describeLogArg({ code: 'permission-denied', message: 'x' })).toBe('[object permission-denied]');
        expect(describeLogArg('Saving bill for 9876543210 failed:')).toBe('Saving bill for <phone> failed:');
        expect(describeLogArg(null)).toBe('null');
    });
});

describe('stored error reports are scrubbed', () => {
    test('buildTelemetryDoc scrubs message, stack, context and the page address', () => {
        const doc = buildTelemetryDoc({
            fingerprint: 'fp', count: 1, timestamp: 1, lastSeen: 1, type: 'manual',
            message: 'Reminder to 9876543210 for ₹500 failed', stack: 'at x (a@b.com)',
            context: { email: 'owner@shop.in', due: 'Rs 200' }, url: 'https://myhappa.web.app/?oobCode=XYZ#cash',
            source: 'https://myhappa.web.app/js/main.js?v=1'
        }, 'u1');
        expect(doc.message).toBe('Reminder to <phone> for ₹<amount> failed');
        expect(doc.stack).toBe('at x (<email>)');
        expect(doc.context).toBe('{"email":"<email>","due":"₹<amount>"}');
        expect(doc.url).toBe('https://myhappa.web.app/#cash');
        expect(doc.source).toBe('https://myhappa.web.app/js/main.js');
    });

    test('console.error with a data object stores no names or amounts', () => {
        TelemetryService.errorBuffer = [];
        TelemetryService.captureConsoleError(['Save failed:', { customerName: 'Sita Devi', total: 5866 }, new Error('ram@x.in denied')]);
        const [e] = TelemetryService.errorBuffer;
        expect(e.message).toBe('Save failed: [object] <email> denied');
        clearTimeout(TelemetryService.syncTimer);
        TelemetryService.errorBuffer = [];
    });
});

describe('changedFields (#85)', () => {
    test('formatAuditDetails shows the new details (cash, stock, settings, hidden reports, refused)', () => {
        expect(formatAuditDetails({ date: '2026-10-21', counted: 1250, expected: 1300, difference: -50 }))
            .toBe('Day: 2026-10-21 • Counted ₹1,250, expected ₹1,300');
        expect(formatAuditDetails({ itemName: 'Wheat', from: 10, to: 5, reason: 'Damaged', refused: true }))
            .toBe('Refused by the server, not saved • Item: Wheat • 10 → 5 • Reason: Damaged');
        expect(formatAuditDetails({ section: 'labour', changes: 'laborRate: 6 → 7' })).toBe('Changes: laborRate: 6 → 7');
        expect(formatAuditDetails({ reports: 3, all: true })).toBe('Reports: 3');
        expect(formatAuditDetails({ amount: 500, outcome: 'refused' })).toBe('Refused by the server, not saved • Amount: ₹500');
        expect(formatAuditDetails({ amount: 500, outcome: 'saved' })).toBe('Amount: ₹500');
        expect(formatAuditDetails({ source: 'purchases update' }, 'PERMISSION_DENIED')).toBe('Refused: purchases update');
        // other entries' source (an item added from the list, an Excel import) is no refusal
        expect(formatAuditDetails({ source: 'excel-import' }, 'EDIT_ITEM')).toBe('Source: excel-import');
        expect(formatAuditDetails({ what: 'void', billId: 'b1' })).toBe('Tried to void it • Bill: b1');
        expect(formatAuditDetails({ device: 'abc123' })).toBe('Phone: abc123');
        expect(formatAuditDetails(null)).toBe('');
    });
    test('lists only changed fields as before → after', () => {
        expect(changedFields({ laborRate: 6, heavyWeightThreshold: 30 }, { laborRate: 7, heavyWeightThreshold: 30 }))
            .toEqual(['laborRate: 6 → 7']);
        expect(changedFields({ businessName: '' }, { businessName: 'Gupta Traders' })).toEqual(['businessName: — → Gupta Traders']);
        expect(changedFields({ a: 1 }, { a: 1 })).toEqual([]);
        expect(changedFields({ a: 'x'.repeat(100) }, { a: 'y' })[0].length).toBeLessThan(80);
        expect(changedFields({ m: { a: 1 } }, { m: { a: 2 } })).toEqual(['m: {"a":1} → {"a":2}']);
    });
});
