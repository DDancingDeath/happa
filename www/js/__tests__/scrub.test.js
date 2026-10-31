/**
 * @fileoverview Error reports carry no personal data or secrets (#116), and audit
 * entries name what changed (#85).
 */
import { scrubText, scrubUrl, describeLogArg } from '../utils/scrub.js';
import { changedFields } from '../utils/audit-changes.js';
import { buildTelemetryDoc, TelemetryService } from '../services/telemetry.js';

describe('scrubText (#116)', () => {
    test.each([
        ['Login failed for ram.kumar@gmail.com', 'Login failed for <email>'],
        ['Call 9876543210 now', 'Call <phone> now'],
        ['Call +91 98765 43210 now', 'Call <phone> now'],
        ['Call 098765-43210', 'Call <phone>'],
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
        expect(scrubText(undefined)).toBeUndefined();
        expect(scrubText(5)).toBe(5);
    });

    test('scrubUrl drops query strings, keeps the route', () => {
        expect(scrubUrl('https://myhappa.web.app/?emulator=1&token=abc#outstanding?x=1')).toBe('https://myhappa.web.app/#outstanding');
        expect(scrubUrl('https://myhappa.web.app/r/tok?mode=x')).toBe('https://myhappa.web.app/r/tok');
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
    test('lists only changed fields as before → after', () => {
        expect(changedFields({ laborRate: 6, heavyWeightThreshold: 30 }, { laborRate: 7, heavyWeightThreshold: 30 }))
            .toEqual(['laborRate: 6 → 7']);
        expect(changedFields({ businessName: '' }, { businessName: 'Gupta Traders' })).toEqual(['businessName: — → Gupta Traders']);
        expect(changedFields({ a: 1 }, { a: 1 })).toEqual([]);
        expect(changedFields({ a: 'x'.repeat(100) }, { a: 'y' })[0].length).toBeLessThan(80);
        expect(changedFields({ m: { a: 1 } }, { m: { a: 2 } })).toEqual(['m: {"a":1} → {"a":2}']);
    });
});
