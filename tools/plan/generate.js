#!/usr/bin/env node
/**
 * Plan page generator: renders tools/plan/order.json + live GitHub issues into a
 * single pinned "[Plan] Roadmap" issue (and optionally docs/PLAN.md).
 *
 *   node tools/plan/generate.js              # upsert + pin the plan issue
 *   node tools/plan/generate.js --dry-run    # print markdown only
 *   node tools/plan/generate.js --write-docs # also write docs/PLAN.md
 *
 * Env: GITHUB_TOKEN or GH_TOKEN; GITHUB_REPOSITORY (owner/repo, optional).
 * Node 20+, no dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'DDancingDeath/happa';
const MARKER = '<!-- plan-page -->';
const PLAN_TITLE = '[Plan] Roadmap: pick order (auto-updated)';
const PLAN_LABELS = ['type:docs', 'P0'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const MILESTONES = ['Sprint 1 - Safety', 'Sprint 2 - Trust', 'Sprint 3 - Speed & offline', 'Sprint 4 - Features', 'Later'];
const OWNER_LABELS = ['owner-decision', 'owner-action'];
const NEXT_UP = 5;
const RECENT_DAYS = 14;

// ---------- pure helpers ----------

const labelsOf = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const priorityOf = (issue) => labelsOf(issue).find((l) => PRIORITIES.includes(l)) || '';
const typesOf = (issue) => labelsOf(issue).filter((l) => l.startsWith('type:')).map((l) => l.slice(5));
const isOwnerItem = (issue) => labelsOf(issue).some((l) => OWNER_LABELS.includes(l));
const isOpen = (issue) => String(issue.state).toLowerCase() === 'open';
const milestoneOf = (issue) => (issue.milestone && issue.milestone.title) || '';

function isPlanIssue(issue) {
    return issue.title === PLAN_TITLE || (issue.body || '').includes(MARKER);
}

function parseEffort(body) {
    const m = (body || '').match(/(?:\*\*[Ee]ffort:?\*\*|#+\s*[Ee]ffort)\s*:?\s*\**\s*(XL|S|M|L)\b/);
    return m ? m[1] : '';
}

/** Map "G-0xx" gap ids to issue numbers using the `<!-- gap-id: G-0xx -->` marker in bodies. */
function buildGapMap(issues) {
    const map = {};
    for (const i of issues) {
        const m = (i.body || '').match(/<!--\s*gap-id:\s*(G-\d{3})\s*-->/);
        if (m) map[m[1]] = i.number;
    }
    return map;
}

function normaliseRefs(body, gapMap) {
    return (body || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\bG-\d{3}\b/g, (g) => (gapMap[g] ? `#${gapMap[g]}` : g))
        .replace(/\b(?:P\d|PR|WALK-?)\s*#\d+/gi, '');
}

const refsIn = (text) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/**
 * Dependencies stated in issue bodies:
 *  - "Depends on / Blocked by / Waits for / Do after #N" in issue X  => X waits for N
 *  - "Blocks #N" in a [Decision] issue D (not the non-blocking checklist) => N waits for D
 * Returns Map<number, Set<number>> of issue -> prerequisites.
 */
function parseDependencies(issues) {
    const gapMap = buildGapMap(issues);
    const deps = new Map();
    const add = (n, dep) => {
        if (n === dep) return;
        if (!deps.has(n)) deps.set(n, new Set());
        deps.get(n).add(dep);
    };
    for (const issue of issues) {
        const isDecision = /^\[Decision\]/i.test(issue.title) && !/non-blocking/i.test(issue.title);
        for (const line of normaliseRefs(issue.body, gapMap).split('\n')) {
            const dep = line.match(/\b(?:depends on|blocked by|waits for|do after)\b([^;]*)/i);
            if (dep) {
                refsIn(dep[1]).forEach((r) => add(issue.number, r));
            } else if (isDecision && /^[\s>*_-]*blocks\b/i.test(line)) {
                refsIn(line).forEach((r) => add(r, issue.number));
            }
        }
    }
    return deps;
}

function compareUnplaced(a, b) {
    const rank = (list, v) => (list.includes(v) ? list.indexOf(v) : list.length);
    return (
        rank(PRIORITIES, priorityOf(a)) - rank(PRIORITIES, priorityOf(b)) ||
        rank(MILESTONES, milestoneOf(a)) - rank(MILESTONES, milestoneOf(b)) ||
        Number(isOwnerItem(b)) - Number(isOwnerItem(a)) ||
        a.number - b.number
    );
}

/** Combine order.json and the issue list into a render-ready model. */
function buildModel(order, allIssues, now = new Date()) {
    const issues = allIssues.filter((i) => !i.pull_request && !isPlanIssue(i));
    const byNum = new Map(issues.map((i) => [i.number, i]));
    const deps = parseDependencies(issues);
    const placed = new Set();

    const blockersOf = (n, extra = [], ignore = []) => {
        const all = new Set([...(deps.get(n) || []), ...extra]);
        return [...all]
            .filter((d) => d !== n && !ignore.includes(d) && byNum.has(d) && isOpen(byNum.get(d)))
            .filter((d) => !labelsOf(byNum.get(d)).includes('owner-action'))
            .sort((a, b) => a - b);
    };

    const toRow = (issue, item = {}) => {
        const open = isOpen(issue);
        const blockers = open ? blockersOf(issue.number, item.after, item.ignoreDeps) : [];
        const note = item.note || '';
        return {
            number: issue.number,
            title: issue.title,
            open,
            priority: priorityOf(issue),
            types: typesOf(issue),
            effort: parseEffort(issue.body),
            owner: isOwnerItem(issue),
            blockers,
            note,
            status: !open ? 'done' : blockers.length ? 'blocked' : 'open',
        };
    };

    const phases = order.phases.map((phase) => {
        const rows = [];
        for (const item of phase.items) {
            const issue = byNum.get(item.n);
            if (!issue || placed.has(item.n)) continue;
            placed.add(item.n);
            rows.push(toRow(issue, item));
        }
        return { title: phase.title, why: phase.why || '', rows };
    });

    const unplaced = issues
        .filter((i) => isOpen(i) && !placed.has(i.number))
        .sort(compareUnplaced)
        .map((i) => toRow(i));

    const ordered = phases.flatMap((p) => p.rows);
    const nextUp = ordered.filter((r) => r.status === 'open' && !r.owner).slice(0, NEXT_UP);
    const ownerTodo = ordered.filter((r) => r.open && r.owner);

    const cutoff = now.getTime() - RECENT_DAYS * 86400000;
    const closedRecently = issues
        .filter((i) => !isOpen(i) && i.closed_at && Date.parse(i.closed_at) >= cutoff)
        .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))
        .slice(0, 15)
        .map((i) => ({ number: i.number, title: i.title, closedAt: i.closed_at }));

    const all = [...ordered, ...unplaced];
    return {
        phases,
        unplaced,
        nextUp,
        ownerTodo,
        closedRecently,
        done: all.filter((r) => r.status === 'done').length,
        total: all.length,
        missing: order.phases.flatMap((p) => p.items.map((i) => i.n)).filter((n) => !byNum.has(n)),
    };
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function formatIST(date) {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: false,
    }).format(date) + ' IST';
}

function statusCell(row) {
    if (row.status === 'done') return '✅';
    if (row.status === 'blocked') return `⛔ ${row.blockers.map((b) => `#${b}`).join(' ')}`;
    return '⬜';
}

function tableRows(rows) {
    const out = ['| # | Issue | Pri | Type | Effort | Status | Notes |', '|---|---|---|---|---|---|---|'];
    rows.forEach((r, idx) => {
        const title = r.status === 'done' ? `~~${esc(r.title)}~~` : esc(r.title);
        out.push(`| ${idx + 1} | #${r.number} ${title} | ${r.priority} | ${r.types.join(', ')} | ${r.effort} | ${statusCell(r)} | ${esc(r.note)} |`);
    });
    return out;
}

function renderMarkdown(model, now = new Date(), repo = DEFAULT_REPO) {
    const pct = (d, t) => (t ? Math.round((d / t) * 100) : 0);
    const L = [
        MARKER,
        '# 🗺️ Roadmap: pick order',
        '',
        `Work top to bottom: pick the first open ⬜ row that isn't blocked. This issue is **regenerated automatically** whenever an issue is opened, edited, closed or relabelled (and daily) from [\`tools/plan/order.json\`](https://github.com/${repo}/blob/main/tools/plan/order.json) by [\`tools/plan/generate.js\`](https://github.com/${repo}/blob/main/tools/plan/generate.js). **Don't edit this body by hand** — change the order file instead.`,
        '',
        `_Last updated: ${formatIST(now)}_ · **Progress: ${model.done}/${model.total} done (${pct(model.done, model.total)}%)**`,
        '',
        '**Legend:** ⬜ open · ⛔ blocked (waits for the listed open issue) · ✅ done · Effort S/M/L from the issue body · 🆕 = not yet placed in the order',
        '',
        '## ▶️ Next up',
        '',
    ];
    if (model.nextUp.length) model.nextUp.forEach((r, i) => L.push(`${i + 1}. #${r.number} ${r.title}${r.note ? ` — _${r.note}_` : ''}`));
    else L.push('_Nothing unblocked — see owner to-do below._');
    if (model.ownerTodo.length) {
        L.push('', `**Waiting on the owner:** ${model.ownerTodo.map((r) => `#${r.number}`).join(' · ')}`);
    }
    L.push('', '## Progress by phase', '', '| Phase | Done |', '|---|---|');
    for (const p of model.phases) {
        const d = p.rows.filter((r) => r.status === 'done').length;
        L.push(`| ${esc(p.title)} | ${d}/${p.rows.length} |`);
    }
    for (const p of model.phases) {
        L.push('', `## ${p.title}`, '', p.why ? `_${p.why}_` : '', '', ...tableRows(p.rows));
    }
    L.push('', '## 🆕 Unplaced issues', '');
    if (model.unplaced.length) {
        L.push('_Open issues not in `tools/plan/order.json` yet (sorted by priority → milestone → owner-decision → number). Add each one to the right phase._', '', ...tableRows(model.unplaced));
    } else {
        L.push('_None — every open issue is placed._');
    }
    L.push('', `## Closed recently (last ${RECENT_DAYS} days)`, '');
    if (model.closedRecently.length) model.closedRecently.forEach((c) => L.push(`- ✅ #${c.number} ${c.title} (${c.closedAt.slice(0, 10)})`));
    else L.push('_None._');
    L.push('');
    return L.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
}

// ---------- GitHub I/O ----------

async function gh(token, method, url, body) {
    const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'aadhat-plan-page',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
    return { data: res.status === 204 ? null : await res.json(), link: res.headers.get('link') || '' };
}

async function fetchAllIssues(token, repo) {
    const out = [];
    let url = `/repos/${repo}/issues?state=all&per_page=100`;
    while (url) {
        const { data, link } = await gh(token, 'GET', url);
        out.push(...data.filter((i) => !i.pull_request));
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
    }
    return out;
}

async function pinIssue(token, nodeId) {
    const { data } = await gh(token, 'POST', '/graphql', {
        query: 'mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { number } } }',
        variables: { id: nodeId },
    });
    if (data.errors) throw new Error(data.errors.map((e) => e.message).join('; '));
}

async function main(argv = process.argv.slice(2)) {
    const dryRun = argv.includes('--dry-run');
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
    if (!token) throw new Error('Set GITHUB_TOKEN or GH_TOKEN');

    const order = JSON.parse(fs.readFileSync(path.join(__dirname, 'order.json'), 'utf8'));
    const issues = await fetchAllIssues(token, repo);
    const now = new Date();
    const model = buildModel(order, issues, now);
    const md = renderMarkdown(model, now, repo);

    if (model.missing.length) console.warn(`order.json lists issues that don't exist: ${model.missing.join(', ')}`);
    console.error(`Placed ${model.total - model.unplaced.length}, unplaced ${model.unplaced.length}, done ${model.done}/${model.total}`);

    if (argv.includes('--write-docs')) {
        const docsDir = path.join(__dirname, '..', '..', 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'PLAN.md'), md.replace(`${MARKER}\n`, ''));
    }
    if (dryRun) {
        process.stdout.write(md + '\n');
        return;
    }

    let plan = issues.find(isPlanIssue);
    if (plan) {
        const patch = { body: md, title: PLAN_TITLE };
        if (!isOpen(plan)) patch.state = 'open';
        const stable = (s) => (s || '').replace(/^_Last updated:.*$/m, '').replace(/\r\n/g, '\n');
        if (stable(plan.body) !== stable(md) || patch.state) ({ data: plan } = await gh(token, 'PATCH', `/repos/${repo}/issues/${plan.number}`, patch));
    } else if (!argv.includes('--create')) {
        console.log(`No plan issue in ${repo}; skipping (run with --create to open one).`);
        return;
    } else {
        ({ data: plan } = await gh(token, 'POST', `/repos/${repo}/issues`, { title: PLAN_TITLE, body: md, labels: PLAN_LABELS }));
    }
    console.log(`Plan issue: ${plan.html_url}`);
    try {
        await pinIssue(token, plan.node_id);
    } catch (e) {
        console.warn(`Could not pin (already pinned or 3 pins in use?): ${e.message}`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = {
    MARKER, PLAN_TITLE, parseEffort, buildGapMap, parseDependencies, compareUnplaced, buildModel, renderMarkdown, isPlanIssue,
};
