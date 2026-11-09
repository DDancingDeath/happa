// PARTY: the one shared name matcher (utils/parties.js, #139).
import { partyNameKey, sameParty, partyNameSpelling, duplicateCheckNameKey, pickPartyName, partyDisplayNames } from '../utils/parties.js';
import * as aging from '../utils/aging.js';
import * as duePayments from '../utils/due-payments.js';
import { groupRows } from '../utils/finance-breakdown.js';
import { partyKey as migrationPartyKey } from '../../../tests/migration-e2e/old-outstanding.js';

// Names that differ only in case, spaces or Unicode form, and some that must stay apart.
const CORPUS = [
    'Ramesh', 'ramesh', ' RAMESH ', 'Ram  Lal', 'ram\tlal', 'Ram\u00a0Lal', 'Ram\u2003Lal\n', 'Ramesh Ji', 'R. Kumar',
    'Caf\u00e9', 'Cafe\u0301', 'CAFE\u0301', 'रमेश', ' रमेश  जी ', '\u0958मल', '\u0915\u093c\u092e\u0932', 'कमल',
    'İstanbul', 'ẞtraße', '', '   ', null, undefined, 0, 42
];

// The formulas each call site used before #139, copied as they were.
const before = {
    agingAndDuePayments: (name) => String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(),
    financeBreakdown: (party) => { const label = String(party || '').trim(); return String(label ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' '); },
    billChecksDuplicate: (s) => (s == null ? '' : String(s).trim().toLowerCase())
};

describe('partyNameKey (PARTY)', () => {
    test('ignores case, extra spaces (any Unicode space) and Unicode form', () => {
        expect(partyNameKey(' RAMESH ')).toBe('ramesh');
        expect(partyNameKey('Ram  Lal')).toBe('ram lal');
        expect(partyNameKey('ram\tlal')).toBe('ram lal');
        expect(partyNameKey('Ram\u00a0Lal')).toBe('ram lal');
        expect(partyNameKey('Cafe\u0301')).toBe(partyNameKey('Caf\u00e9'));
        expect(partyNameKey(' रमेश  जी ')).toBe('रमेश जी');
    });

    test('a precomposed nukta letter equals its two-character form, but not the letter without nukta', () => {
        expect(partyNameKey('\u0958मल')).toBe(partyNameKey('\u0915\u093c\u092e\u0932'));
        expect(partyNameKey('\u0958मल')).not.toBe(partyNameKey('कमल'));
    });

    test('folds nothing else: honorifics, initials and script stay separate parties', () => {
        expect(partyNameKey('Ramesh Ji')).not.toBe(partyNameKey('Ramesh'));
        expect(partyNameKey('R. Kumar')).not.toBe(partyNameKey('R Kumar'));
        expect(partyNameKey('रमेश')).not.toBe(partyNameKey('Ramesh'));
    });

    test('blank and missing names give ""', () => {
        [null, undefined, '', '   ', '\u00a0\n'].forEach(n => expect(partyNameKey(n)).toBe(''));
        expect(partyNameKey(0)).toBe('0');
    });

    test('gives exactly the keys the call sites computed before', () => {
        CORPUS.forEach(name => {
            expect(partyNameKey(name)).toBe(before.agingAndDuePayments(name));
            expect(migrationPartyKey(name)).toBe(partyNameKey(name));
            expect(partyNameKey(String(name || '').trim())).toBe(before.financeBreakdown(name));
        });
    });

    test('the old names are the same function', () => {
        expect(aging.normalizePartyName).toBe(partyNameKey);
        expect(duePayments.normalizeParty).toBe(partyNameKey);
        expect(duePayments.sameParty).toBe(sameParty);
        expect(aging.pickPartyName).toBe(pickPartyName);
        expect(aging.partyDisplayNames).toBe(partyDisplayNames);
    });
});

describe('sameParty', () => {
    test('true only for the same non-blank key', () => {
        expect(sameParty('Ramesh', ' ramesh ')).toBe(true);
        expect(sameParty('Ram', 'Ramesh')).toBe(false);
        expect(sameParty('', '')).toBe(false);
        expect(sameParty(null, undefined)).toBe(false);
    });
});

describe('partyNameSpelling', () => {
    test('trims and collapses spaces, keeps case and form', () => {
        expect(partyNameSpelling('  Ram   Lal ')).toBe('Ram Lal');
        expect(partyNameSpelling('Cafe\u0301')).toBe('Cafe\u0301');
        expect(partyNameSpelling(undefined)).toBe('');
    });
});

describe('duplicateCheckNameKey (bill-checks, kept as before #139)', () => {
    test('trim and lower case only', () => {
        CORPUS.forEach(name => expect(duplicateCheckNameKey(name)).toBe(before.billChecksDuplicate(name)));
        expect(duplicateCheckNameKey('Ram  Lal')).not.toBe(duplicateCheckNameKey('Ram Lal'));
        expect(duplicateCheckNameKey('Cafe\u0301')).not.toBe(duplicateCheckNameKey('Caf\u00e9'));
    });
});

describe('pickPartyName / partyDisplayNames', () => {
    test('most used spelling, then more capitalised words, then the latest', () => {
        const m = (entries) => new Map(entries.map(([n, count, last]) => [n, { count, last }]));
        expect(pickPartyName(m([['test party', 2, 1], ['Test Party', 1, 5]]))).toBe('test party');
        expect(pickPartyName(m([['test party', 1, 9], ['Test Party', 1, 1]]))).toBe('Test Party');
        expect(pickPartyName(m([['Ram lal', 1, 1], ['Ram Lal', 1, 2], ['RAM LAL', 1, 3]]))).toBe('RAM LAL');
    });

    test('groups spellings by key and skips blank names', () => {
        const out = partyDisplayNames(['ramesh', 'Ramesh', ' Ramesh ', '', null, 'Suresh']);
        expect([...out.entries()]).toEqual([['ramesh', 'Ramesh'], ['suresh', 'Suresh']]);
    });
});

describe('Money breakdown "by party" grouping', () => {
    test('same groups and labels as before', () => {
        const rows = [
            { party: 'Ram Lal', amount: 10 }, { party: ' ram  lal ', amount: 5 }, { party: 'Cafe\u0301', amount: 1 },
            { party: 'Caf\u00e9', amount: 2 }, { party: '', amount: 3 }
        ];
        const groups = groupRows(rows, 'party');
        expect(groups.map(g => [g.key, g.label, g.subtotal, g.count])).toEqual([
            ['ram lal', 'Ram Lal', 15, 2], ['caf\u00e9', 'Cafe\u0301', 3, 2], ['', '', 3, 1]
        ]);
    });
});
