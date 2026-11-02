/**
 * @fileoverview Unit tests for the helper utility functions
 * @module __tests__/helpers.test
 */

import { Helpers, getAndroidMajorVersion } from '../utils/helpers.js';

describe('Helpers.escapeHtml', () => {
    test('should escape HTML special characters', () => {
        const input = '<script>alert("XSS")</script>';
        const result = Helpers.escapeHtml(input);
        expect(result).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    test('should escape ampersand', () => {
        expect(Helpers.escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    test('should escape single quotes', () => {
        expect(Helpers.escapeHtml("It's fine")).toBe("It&#039;s fine");
    });

    test('should handle empty string', () => {
        expect(Helpers.escapeHtml('')).toBe('');
    });

    test('should handle string with no special characters', () => {
        expect(Helpers.escapeHtml('Hello World')).toBe('Hello World');
    });

    test('should return empty string for null/undefined and stringify other values', () => {
        expect(Helpers.escapeHtml(null)).toBe('');
        expect(Helpers.escapeHtml(undefined)).toBe('');
        expect(Helpers.escapeHtml(42)).toBe('42');
    });
});

describe('Helpers.safeUrl', () => {
    const hrefOf = (url) => {
        const div = document.createElement('div');
        div.innerHTML = `<a href="${Helpers.safeUrl(url)}">x</a>`;
        return div.firstChild.getAttribute('href');
    };

    test.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
        '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'])('blocks %j', (url) => {
        expect(hrefOf(url)).toBe('#');
    });

    test.each(['https://wa.me/919999999999?text=a%20b', 'http://x.in/a?b=1&c=2', 'mailto:a@b.in', 'tel:+919999999999',
        'upi://pay?pa=x@upi', '/r/abc', '#top', '?tab=2', 'a/b:c'])('keeps %j', (url) => {
        expect(hrefOf(url)).toBe(url);
    });

    test('escapes quotes so the value cannot leave the attribute', () => {
        expect(Helpers.safeUrl('https://x.in/"><img src=x onerror=alert(1)>')).not.toMatch(/["<>]/);
    });
});

describe('Helpers.escapeJsAttr', () => {
    // Simulates what the browser does: decode the attribute, then evaluate the JS string literal.
    const roundTrip = (value) => {
        const div = document.createElement('div');
        div.innerHTML = `<button onclick="return ['${Helpers.escapeJsAttr(value)}', &quot;${Helpers.escapeJsAttr(value)}&quot;]"></button>`;
        const handler = div.firstChild.getAttribute('onclick');
        return new Function(handler)();
    };

    test('cannot break out of a quoted JS string inside an onclick attribute', () => {
        const evil = `a');alert(1);('"\\<img src=x onerror=alert(2)>\n`;
        expect(roundTrip(evil)).toEqual([evil, evil]);
    });

    test('output contains no raw quotes or angle brackets', () => {
        expect(Helpers.escapeJsAttr(`x'"<>`)).not.toMatch(/['"<>]/);
    });

    test('handles null/undefined', () => {
        expect(Helpers.escapeJsAttr(null)).toBe('');
        expect(Helpers.escapeJsAttr(undefined)).toBe('');
    });
});

describe('Helpers.formatDate', () => {
    test('should format date correctly', () => {
        const result = Helpers.formatDate('2024-01-15');
        expect(result).toContain('15');
        expect(result).toContain('Jan');
        expect(result).toContain('2024');
    });

    test('should handle Date object', () => {
        const date = new Date('2024-06-20');
        const result = Helpers.formatDate(date);
        expect(result).toContain('20');
        expect(result).toContain('Jun');
        expect(result).toContain('2024');
    });

    test('should handle empty/null date', () => {
        expect(Helpers.formatDate('')).toBe('');
        expect(Helpers.formatDate(null)).toBe('');
    });
});

describe('Helpers.formatDateTime', () => {
    test('should format datetime with time', () => {
        const date = new Date('2024-01-15T14:30:00');
        const result = Helpers.formatDateTime(date);
        expect(result).toContain('15');
        expect(result).toContain('2024');
        // Time component should be present
        expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
});

describe('Helpers.formatCurrency', () => {
    test('should format positive number as currency', () => {
        const result = Helpers.formatCurrency(1234.56);
        expect(result).toContain('₹');
    });

    test('should format zero', () => {
        const result = Helpers.formatCurrency(0);
        expect(result).toContain('0');
    });

    test('should format negative number', () => {
        const result = Helpers.formatCurrency(-500);
        expect(result).toContain('500');
    });

    test('should contain rupee symbol', () => {
        const result = Helpers.formatCurrency(1234567.89);
        expect(result).toContain('₹');
    });
});

describe('Helpers.generateId', () => {
    test('should generate unique IDs', () => {
        const id1 = Helpers.generateId();
        const id2 = Helpers.generateId();
        expect(id1).not.toBe(id2);
    });

    test('should return a string', () => {
        const id = Helpers.generateId();
        expect(typeof id).toBe('string');
    });

    test('should have reasonable length', () => {
        const id = Helpers.generateId();
        expect(id.length).toBeGreaterThan(5);
    });
});

describe('Helpers.debounce', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should debounce function calls', () => {
        const mockFn = jest.fn();
        const debouncedFn = Helpers.debounce(mockFn, 300);

        debouncedFn();
        debouncedFn();
        debouncedFn();

        expect(mockFn).not.toHaveBeenCalled();

        jest.advanceTimersByTime(300);

        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('should call function with correct arguments', () => {
        const mockFn = jest.fn();
        const debouncedFn = Helpers.debounce(mockFn, 100);

        debouncedFn('arg1', 'arg2');
        jest.advanceTimersByTime(100);

        expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
    });
});

describe('Helpers.getInputNumber', () => {
    test('should parse valid number from input value', () => {
        document.body.innerHTML = '<input id="testInput" value="123.45">';
        const result = Helpers.getInputNumber('testInput');
        expect(result).toBe(123.45);
    });

    test('should return 0 for empty input', () => {
        document.body.innerHTML = '<input id="testInput" value="">';
        const result = Helpers.getInputNumber('testInput');
        expect(result).toBe(0);
    });

    test('should return 0 for non-existent input', () => {
        document.body.innerHTML = '';
        const result = Helpers.getInputNumber('nonExistent');
        expect(result).toBe(0);
    });
});

describe('Helpers.getInputInt', () => {
    test('should parse valid integer from input value', () => {
        document.body.innerHTML = '<input id="testInput" value="42">';
        const result = Helpers.getInputInt('testInput');
        expect(result).toBe(42);
    });

    test('should floor decimal values', () => {
        document.body.innerHTML = '<input id="testInput" value="42.9">';
        const result = Helpers.getInputInt('testInput');
        expect(result).toBe(42);
    });

    test('should return 0 for empty input', () => {
        document.body.innerHTML = '<input id="testInput" value="">';
        const result = Helpers.getInputInt('testInput');
        expect(result).toBe(0);
    });
});

describe('Helpers.getInputText', () => {
    test('should get text from input', () => {
        document.body.innerHTML = '<input id="testInput" value="Hello World">';
        const result = Helpers.getInputText('testInput');
        expect(result).toBe('Hello World');
    });

    test('should trim whitespace', () => {
        document.body.innerHTML = '<input id="testInput" value="  Hello  ">';
        const result = Helpers.getInputText('testInput');
        expect(result).toBe('Hello');
    });

    test('should return empty string for non-existent input', () => {
        document.body.innerHTML = '';
        const result = Helpers.getInputText('nonExistent');
        expect(result).toBe('');
    });
});

describe('getAndroidMajorVersion', () => {
    test('parses Android 11 WebView user agent', () => {
        expect(getAndroidMajorVersion('Mozilla/5.0 (Linux; Android 11; Pixel 3) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')).toBe(11);
    });

    test('parses Android 14 user agent', () => {
        expect(getAndroidMajorVersion('Mozilla/5.0 (Linux; Android 14; SM-S918B; wv)')).toBe(14);
    });

    test('returns Infinity when version is unknown', () => {
        expect(getAndroidMajorVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(Infinity);
        expect(getAndroidMajorVersion('')).toBe(Infinity);
    });
});

describe('offline bill numbers (#41)', () => {
    class MemStorage {
        constructor() { this.m = new Map(); }
        get length() { return this.m.size; }
        key(i) { return [...this.m.keys()][i] ?? null; }
        getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
        setItem(k, v) { this.m.set(k, String(v)); }
        removeItem(k) { this.m.delete(k); }
    }

    test('two devices offline on the same day never produce the same number', () => {
        const phoneA = new MemStorage();
        const phoneB = new MemStorage();
        phoneA.setItem('aadhatBillDeviceCode', 'AAA');
        phoneB.setItem('aadhatBillDeviceCode', 'BBB');
        const a = [1, 2, 3].map(() => Helpers.nextOfflineBillNumber('P', '20261021', phoneA));
        const b = [1, 2, 3].map(() => Helpers.nextOfflineBillNumber('P', '20261021', phoneB));
        expect(a).toEqual(['P20261021-AAA-001', 'P20261021-AAA-002', 'P20261021-AAA-003']);
        expect(b).toEqual(['P20261021-BBB-001', 'P20261021-BBB-002', 'P20261021-BBB-003']);
        expect(new Set([...a, ...b]).size).toBe(6);
        // Never collides with the online format P20261021-001.
        a.concat(b).forEach(n => expect(n).not.toMatch(/^P\d{8}-\d+$/));
    });

    test('device code is created once and kept; per-prefix sequences; old days pruned', () => {
        const s = new MemStorage();
        const code = Helpers.getBillDeviceCode(s);
        expect(code).toMatch(/^[2-9A-HJ-NP-Z]{3}$/);
        expect(Helpers.getBillDeviceCode(s)).toBe(code);
        Helpers.nextOfflineBillNumber('P', '20261020', s);
        expect(Helpers.nextOfflineBillNumber('S', '20261021', s)).toBe(`S20261021-${code}-001`);
        expect(Helpers.nextOfflineBillNumber('P', '20261021', s)).toBe(`P20261021-${code}-001`);
        expect(s.getItem('aadhatOfflineBillSeq:P20261020')).toBeNull();
    });

    test('generateBillNumber uses the device format offline and never Date.now digits', async () => {
        localStorage.setItem('aadhatBillDeviceCode', 'K7Q');
        const query = { where: () => query, get: jest.fn() };
        global.db = { collection: () => ({ ...query, doc: () => ({ get: jest.fn() }) }), runTransaction: jest.fn() };
        const online = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        const n1 = await Helpers.generateBillNumber('W', 'wholesaleSales');
        const n2 = await Helpers.generateBillNumber('W', 'wholesaleSales');
        expect(n1).toMatch(/^W\d{8}-K7Q-001$/);
        expect(n2).toMatch(/^W\d{8}-K7Q-002$/);
        expect(global.db.runTransaction).not.toHaveBeenCalled();
        online.mockRestore();
        delete global.db;
        localStorage.clear();
    });

    test('findDuplicateBillNumbers flags a synced bill whose number another bill already has', () => {
        const records = [
            { id: 'a', billNumber: 'P20261021-001' },
            { id: 'b', billNumber: 'P20261021-001' },
            { id: 'c', billNumber: 'P20261021-002' }
        ];
        expect(Helpers.findDuplicateBillNumbers([{ docId: 'b', newRec: records[1] }], records)).toEqual(['P20261021-001']);
        expect(Helpers.findDuplicateBillNumbers([{ docId: 'c', newRec: records[2] }], records)).toEqual([]);
        expect(Helpers.findDuplicateBillNumbers([{ docId: 'x', newRec: null }], records)).toEqual([]);
    });
});
