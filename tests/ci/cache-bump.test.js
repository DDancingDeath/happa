const { bumpProblems, stamps } = require('../../scripts/check-cache-bump.js');

const before = { cacheName: 'happa-v1', buildId: '20261101a-x', tokens: ['20261101a'] };
const bumped = { cacheName: 'happa-v2', buildId: '20261101b-y', tokens: ['20261101b'] };

test('no cached www/ change needs no bump', () => {
    expect(bumpProblems(['docs/a.md', 'www/js/__tests__/a.test.js', 'www/js/README.md', 'www/r.html', 'www/changelog.json'], before, before)).toEqual([]);
});

test('a shipped change needs all three stamps changed', () => {
    expect(bumpProblems(['www/js/main.js'], before, bumped)).toEqual([]);
    const problems = bumpProblems(['www/css/billing.css'], before, { ...bumped, cacheName: 'happa-v1' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/CACHE_NAME/);
    expect(bumpProblems(['www/templates/day.html'], before, before)).toHaveLength(3);
    expect(bumpProblems(['www/index.html'], before, { ...bumped, tokens: ['20261101b', '20261101a'] })[0]).toMatch(/one \?v= token/);
});

test('stamps are read from the three files', () => {
    expect(stamps({
        sw: "const CACHE_NAME = 'happa-v9';",
        main: "const BUILD_ID = '20261101c-z';",
        html: '<link href="a.css?v=20261101c"><script src="b.js?v=20261101c">'
    })).toEqual({ cacheName: 'happa-v9', buildId: '20261101c-z', tokens: ['20261101c'] });
});
