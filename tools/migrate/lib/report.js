/**
 * Human-readable plan report: counts and totals only (no party, item or user
 * names), safe to paste into a PR or issue.
 */
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const yes = (b) => (b ? 'yes' : 'NO');

export function formatReport(summary, { budget = 18000 } = {}) {
    const s = summary;
    const L = [];
    L.push('# Migration plan');
    L.push('');
    L.push(`Backup taken ${s.source.exportedAt} (cutoff). Mode: **${s.options.mode}**, bill numbers: **${s.options.billNumbers}**, payables: **${s.options.carryPayables ? 'carried' : 'checked only'}**, settings: **${s.options.settings ? 'carried' : 'not carried'}**, rate patterns: **${s.options.rateStats ? 'built' : 'not built'}**.`);
    L.push('');
    L.push('## Backup contents');
    L.push('| Collection | Docs |');
    L.push('|---|---|');
    Object.entries(s.source.collections).sort().forEach(([n, c]) => L.push(`| ${n} | ${c} |`));
    if (s.devExcluded.length) {
        L.push('');
        L.push(`Excluded (dev_ test data, never migrated): ${s.devExcluded.map(d => `${d.name} (${d.docs})`).join(', ')}`);
    }
    L.push('');
    L.push('## Copied as is');
    Object.entries(s.copied).forEach(([n, c]) => L.push(`- ${n}: ${c}`));
    L.push(`- settings docs: ${s.settings}`);
    L.push(`- bill-number counters: ${s.counters}`);
    L.push('');
    L.push('## Dues (opening balances)');
    L.push('| Page | Parties | Old bills | Old total | Carried | Opening total | Same as old page |');
    L.push('|---|---|---|---|---|---|---|');
    const label = { retail: 'Outstanding (retail sales)', wholesale: 'Wholesale → Outstanding', purchase: 'Outstanding (purchases, payable)' };
    Object.entries(s.dues).forEach(([type, d]) => {
        L.push(`| ${label[type]} | ${d.parties} | ${d.bills} | ${inr(d.total)} | ${d.carried ? 'yes' : 'no'} | ${d.carried ? inr(d.openingTotal) : '–'} | ${d.carried ? yes(d.matches) : '–'} |`);
    });
    L.push('');
    L.push('Old age buckets (receivables, retail): ' + s.dues.retail.buckets.map(b => `${b.key} days ${inr(b.total)} (${b.count})`).join(', '));
    L.push('In the new app each party\'s opening balance is dated at its oldest unpaid bill, so the whole amount shows in that bill\'s age bucket.');
    if (s.rateStats) {
        const r = s.rateStats;
        L.push('');
        L.push('## Buying and rate patterns (rateStats)');
        L.push(`- ${r.docs} item-year docs from ${r.bills} bills (${r.lines} lines; ${r.skippedLines} lines skipped: no kg/rate or not in the item list)`);
        L.push(`- monthly buckets equal the app's monthly aggregation: ${yes(r.mismatches === 0)} (${r.monthsChecked} item-months)`);
        L.push(`- weekly kg totals equal monthly kg totals: ${yes(r.weeksMatchMonths)}`);
        L.push(`- kg: purchase ${r.kgByKind.purchase || 0}, retail ${r.kgByKind.retail || 0}, wholesale ${r.kgByKind.wholesale || 0}`);
    }
    L.push('');
    L.push('## Writes in the new project');
    L.push('| Collection | Writes |');
    L.push('|---|---|');
    Object.entries(s.writes.byCollection).sort().forEach(([n, c]) => L.push(`| ${n} | ${c} |`));
    L.push(`| **total** | **${s.writes.total}** |`);
    L.push('');
    L.push(`Spark allows 20,000 writes a day. At the default budget of ${budget} writes per run this needs ${Math.max(1, Math.ceil(s.writes.total / budget))} run(s) (one per day).`);
    L.push('');
    L.push('## Warnings');
    if (s.warnings.length) s.warnings.forEach(w => L.push(`- ${w}`));
    else L.push('- none');
    return L.join('\n') + '\n';
}
