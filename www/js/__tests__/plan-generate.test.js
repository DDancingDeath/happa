/**
 * Plan page generator (tools/plan/generate.js): pure ordering + rendering, no network.
 */
const {
    parseEffort, parseDependencies, buildModel, renderMarkdown, MARKER, PLAN_TITLE,
    importInfo, translateRefs, isPlanIssue,
} = require('../../../tools/plan/generate.js');

const issue = (number, extra = {}) => ({
    number,
    title: `Issue ${number}`,
    state: 'open',
    labels: [],
    milestone: null,
    body: '',
    ...extra,
});

describe('plan generator', () => {
    test('parseEffort reads the bold and heading forms', () => {
        expect(parseEffort('**Effort:** S\n')).toBe('S');
        expect(parseEffort('**Effort** M')).toBe('M');
        expect(parseEffort('## Effort\n\n**L**, phased')).toBe('L');
        expect(parseEffort('no estimate')).toBe('');
    });

    test('parseDependencies: depends-on, decision Blocks, gap ids, ignores roadmap "P1 #17"', () => {
        const issues = [
            issue(10, { title: '[Decision] Pick one', body: 'Blocks: #12\nBlocks: PeriodMath (P1 #17)' }),
            issue(11, { body: '<!-- gap-id: G-005 -->' }),
            issue(12, { body: '- Depends on G-005; related #99' }),
            issue(13, { title: '[Decision] Questionnaire (non-blocking checklist)', body: 'Blocks: #14' }),
        ];
        const deps = parseDependencies(issues);
        expect([...deps.get(12)].sort()).toEqual([10, 11]);
        expect(deps.has(17)).toBe(false);
        expect(deps.has(14)).toBe(false);
    });

    test('buildModel orders phases, flags blocked rows, lists unplaced and skips the plan issue', () => {
        const order = {
            phases: [
                { title: 'A', items: [{ n: 1 }, { n: 2, after: [3] }, { n: 4, note: 'x' }] },
                { title: 'B', items: [{ n: 3 }, { n: 1 }] },
            ],
        };
        const now = new Date('2026-10-21T00:00:00Z');
        const issues = [
            issue(1, { state: 'closed', closed_at: '2026-10-20T00:00:00Z' }),
            issue(2),
            issue(3, { labels: [{ name: 'owner-decision' }] }),
            issue(4),
            issue(5, { labels: [{ name: 'P2' }] }),
            issue(6, { labels: [{ name: 'P0' }] }),
            issue(7, { pull_request: {} }),
            issue(8, { title: PLAN_TITLE }),
        ];
        const m = buildModel(order, issues, now);
        expect(m.phases[0].rows.map((r) => [r.number, r.status])).toEqual([[1, 'done'], [2, 'blocked'], [4, 'open']]);
        expect(m.phases[0].rows[1].blockers).toEqual([3]);
        expect(m.phases[1].rows.map((r) => r.number)).toEqual([3]);
        expect(m.unplaced.map((r) => r.number)).toEqual([6, 5]);
        expect(m.nextUp.map((r) => r.number)).toEqual([4]);
        expect(m.ownerTodo.map((r) => r.number)).toEqual([3]);
        expect(m.closedRecently.map((c) => c.number)).toEqual([1]);
        expect([m.done, m.total]).toEqual([1, 6]);

        const md = renderMarkdown(m, now);
        expect(md.startsWith(MARKER)).toBe(true);
        expect(md).toContain('| 1 | #1 ~~Issue 1~~ |');
        expect(md).toContain('⛔ #3');
        expect(md).toContain('## 🆕 Unplaced issues');
        expect(md).toContain('Progress: 1/6 done');
        expect(md).toContain('IST');
    });

    describe('issues moved from the old repo', () => {
        // old 12 -> 50, old 13 -> 51, old 14 -> 52; old 20 was closed there and not moved
        const order = {
            retiredPlanIssues: [53],
            imported: { repo: 'DDancingDeath/AadhatManagementApp', date: '2026-10-30', map: { 12: 50, 13: 51, 14: 52, 171: 53 } },
            phases: [{ title: 'A', items: [{ n: 50 }, { n: 51 }, { n: 52 }, { n: 7 }] }],
        };
        const imp = importInfo(order);

        test('translateRefs: bare #N in a moved body is old; qualified happa refs and native bare refs stay', () => {
            const body = 'Depends on #12 and #20; see DDancingDeath/happa#7 and AadhatManagementApp#13';
            expect(translateRefs(body, imp, true)).toBe('Depends on #50 and ; see DDancingDeath/happa#7 and #51');
            expect(translateRefs(body, imp, false)).toBe('Depends on #12 and #20; see DDancingDeath/happa#7 and #51');
        });

        test('dependencies in moved bodies resolve to happa numbers; roadmap refs the transfer qualified are ignored', () => {
            const issues = [
                issue(50, { body: '- Depends on #13\n- Blocked by DDancingDeath/happa#7' }),
                issue(51, { title: '[Decision] Pick', body: 'Blocks: PeriodMath (P1 DDancingDeath/happa#52), #14' }),
                issue(7, { body: 'Depends on #12' }),
            ];
            const deps = parseDependencies(issues, imp);
            expect([...deps.get(50)].sort()).toEqual([51, 7]);
            expect([...deps.get(52)]).toEqual([51]);
            expect([...deps.get(7)]).toEqual([12]);
        });

        test('rows show the old number, obsolete? rows are not Next up, and the plan skips the retired plan issue', () => {
            const issues = [
                issue(50),
                issue(51, { labels: [{ name: 'obsolete?' }] }),
                issue(52, { state: 'closed', closed_at: '2026-10-30T00:00:00Z' }),
                issue(7),
                issue(53, { title: PLAN_TITLE, body: MARKER }),
            ];
            const m = buildModel(order, issues, new Date('2026-10-31T00:00:00Z'));
            expect(m.nextUp.map((r) => r.number)).toEqual([50, 7]);
            expect(m.imported).toEqual({ repo: 'DDancingDeath/AadhatManagementApp', date: '2026-10-30', total: 4, closed: 1 });
            const md = renderMarkdown(m, new Date('2026-10-31T00:00:00Z'));
            expect(md).toContain('| 1 | #50 Issue 50 _(old 12)_ |');
            expect(md).toContain('| 4 | #7 Issue 7 |');
            expect(md).toContain('**Imported from the old app:** 4 issues');

            expect(issues.find((i) => isPlanIssue(i, order.retiredPlanIssues))).toBeUndefined();
            const fresh = issue(60, { title: PLAN_TITLE, body: MARKER });
            expect([...issues, fresh].find((i) => isPlanIssue(i, order.retiredPlanIssues))).toBe(fresh);
        });
    });
});
