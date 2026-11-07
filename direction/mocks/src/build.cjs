// Builds the Phase 1 direction mocks (self-contained HTML) and renders them to PNG with Playwright.
// Usage: node build.cjs [--no-render]
const fs = require('fs');
const path = require('path');
const { sprite, ic } = require('./icons.cjs');

const OUT = path.resolve(__dirname, '..');
const registry = require('./themes/registry.cjs');
const themeCss = registry.filter((t) => t.id !== 'modern').map((t) => fs.readFileSync(path.join(__dirname, 'themes', t.id + '.css'), 'utf8'));
const css = [fs.readFileSync(path.join(__dirname, 'ds.css'), 'utf8'), ...themeCss].join('\n');
const inr = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n);
const m = (n, cls = '') => `<span class="money ${cls}"><span class="cur">₹</span>${inr(n)}</span>`;

const S = {
  en: {
    billing: 'Billing', today: 'Today', history: 'History', outstanding: 'Outstanding', more: 'More',
    purchase: 'Purchase', sale: 'Retail sale', drafts: 'Drafts', saveDraft: 'Save draft', clear: 'Clear',
    problem: '<b>1 problem</b> — check before saving', show: 'Show', customer: 'Customer', item: 'Item',
    rate: 'Rate', weight: 'Weight', add: 'Add', addToBill: 'Add to bill', newLine: 'New line',
    onBill: 'On this bill', bags: 'bags', bag: 'bag', synced: 'Synced', payable: 'Payable', save: 'Save', print: 'Print',
    mustard: 'Mustard', wheat: 'Wheat', speak: 'Speak', weightPh: 'Weight',
    total: 'Purchase total', labour: 'Labour', totalPayable: 'Total payable', payment: 'Payment',
    online: 'Online', cash: 'Cash', due: 'Due', notSplit: 'Not split yet', restDue: 'Rest → Due',
    notes: 'Notes', notesPh: 'GPay name, number etc.', date: 'Date', billNo: 'Bill P-1042 · prints on save'
  },
  hi: {
    billing: 'बिलिंग', today: 'आज', history: 'इतिहास', outstanding: 'बकाया', more: 'और',
    purchase: 'खरीद', sale: 'खुदरा बिक्री', drafts: 'ड्राफ्ट', saveDraft: 'ड्राफ़्ट सेव करें', clear: 'साफ़ करें',
    problem: '<b>1 समस्या</b> — सेव करने से पहले देखें', show: 'दिखाएँ', customer: 'ग्राहक', item: 'आइटम',
    rate: 'रेट', weight: 'वज़न', add: 'जोड़ें', addToBill: 'बिल में जोड़ें', newLine: 'नया आइटम',
    onBill: 'बिल के आइटम', bags: 'बोरी', bag: 'बोरी', synced: 'सिंक हो गया', payable: 'कुल देना', save: 'सेव', print: 'प्रिंट',
    mustard: 'सरसों', wheat: 'गेहूँ', speak: 'बोलें', weightPh: 'वज़न लिखें',
    total: 'खरीद कुल', labour: 'मज़दूरी', totalPayable: 'कुल देना', payment: 'भुगतान',
    online: 'ऑनलाइन', cash: 'नकद', due: 'उधार', notSplit: 'बाकी', restDue: 'बाकी उधार',
    notes: 'नोट', notesPh: 'GPay नाम, नंबर आदि', date: 'तारीख', billNo: 'बिल P-1042 · सेव पर प्रिंट'
  }
};

const statusbar = () => `<div class="statusbar"><span>9:41</span><span style="display:flex;gap:6px;align-items:center"><svg width="16" height="11" viewBox="0 0 16 11"><path d="M1 10h2V7H1zM5 10h2V5H5zM9 10h2V3H9zM13 10h2V1h-2z" fill="currentColor"/></svg><svg width="24" height="11" viewBox="0 0 24 11"><rect x=".5" y=".5" width="20" height="10" rx="2.5" fill="none" stroke="currentColor" opacity=".5"/><rect x="2" y="2" width="14" height="7" rx="1.5" fill="currentColor"/></svg></span></div>`;

const appbar = (title, t, sub = '') => `<header class="appbar"><h1>${title}${sub ? `<span class="sub">${sub}</span>` : ''}</h1>
  <span class="sync">${ic('cloudCheck', 'i-sm')}${t.synced}</span>
  <button class="btn btn-icon btn-ghost bell" aria-label="Notifications">${ic('bell')}<span class="pip"></span></button></header>`;

const tabbar = (on, t) => {
  const items = [['billing', 'receipt', t.billing], ['day', 'calendar', t.today], ['history', 'history', t.history], ['due', 'wallet', t.outstanding], ['more', 'grid', t.more]];
  return `<nav class="tabbar">${items.map(([k, i, l]) => `<a class="${k === on ? 'on' : ''}"><span class="pill">${ic(i)}</span>${l}</a>`).join('')}</nav>`;
};

const billLines = (t) => `<div class="panel">
  <div class="row"><div class="row-main"><div class="row-title">${t.mustard}</div><div class="row-meta num">50 kg × ₹56.00 · 1 ${t.bag}</div></div><div class="row-trail row-amt">${m(2800)}</div><button class="btn btn-icon btn-sm btn-ghost" aria-label="Remove">${ic('x', 'i-sm')}</button></div>
  <div class="row"><div class="row-main"><div class="row-title">${t.mustard}</div><div class="row-meta num">48.5 kg × ₹55.50 · 1 ${t.bag}</div></div><div class="row-trail row-amt">${m(2692)}</div><button class="btn btn-icon btn-sm btn-ghost" aria-label="Remove">${ic('x', 'i-sm')}</button></div>
</div>`;

const actionbar = (t, sale = false) => `<div class="actionbar">
  <div class="tot"><div class="label">${t.payable}</div><div class="money num">${m(5480)}</div></div>
  <button class="btn btn-secondary btn-icon" aria-label="WhatsApp">${ic('wa')}</button>
  <button class="btn btn-secondary btn-icon" aria-label="${t.print}">${ic('printer')}</button>
  <button class="btn btn-primary ${sale ? 'sale' : ''}" style="padding:0 22px">${t.save}</button></div>`;

function phoneBilling(lang) {
  const t = S[lang];
  return `<div class="phone">${statusbar()}${appbar(t.billing, t)}
  <main class="page">
    <div class="seg" role="tablist"><button class="on"><span class="dot purchase"></span>${t.purchase}</button><button><span class="dot sale"></span>${t.sale}</button></div>
    <div style="display:flex;align-items:center;gap:4px;margin:10px -8px 0">
      <button class="btn btn-sm btn-ghost">${ic('file', 'i-sm')}${t.drafts}<span class="badge">2</span></button>
      <button class="btn btn-sm btn-ghost">${t.saveDraft}</button><span style="flex:1"></span>
      <button class="btn btn-sm btn-ghost danger">${t.clear}</button></div>
    <div class="notice neg" style="margin-top:8px;align-items:center">${ic('alert', 'i-sm')}<span class="grow">${t.problem}</span><b>${t.show}</b></div>
    <div class="field" style="margin-top:16px"><label>${t.customer}</label>
      <div class="input"><span class="v">Ramesh Kumar</span><button class="btn btn-icon btn-sm btn-ghost" style="margin-right:-6px" aria-label="Pick contact">${ic('contact')}</button></div></div>
    <div class="section" style="margin-top:20px"><div class="section-head"><span class="section-title">${t.newLine}</span><span class="section-action" style="display:flex;gap:6px;align-items:center">${ic('mic', 'i-sm')}${t.speak}</span></div>
      <div class="panel panel-pad" style="display:flex;flex-direction:column;gap:12px">
        <div class="field"><label>${t.item}</label><div class="input"><span class="v">${t.mustard}</span>${ic('chevD', 'i-sm')}</div></div>
        <div class="grid2">
          <div class="field"><label>${t.rate}</label><div class="input"><span class="adorn">₹</span><span class="v num">55.50</span>${ic('chevD', 'i-sm')}</div></div>
          <div class="field"><label>${t.weight}</label><div class="input focus"><span class="ph">${t.weightPh}</span><span class="adorn">kg</span></div></div>
        </div>
        <div class="weights"><span class="wchip">48.5${ic('x')}</span><span class="wchip">50.0${ic('x')}</span><span class="wchip">49.2${ic('x')}</span></div>
        <div style="display:flex;align-items:center;gap:12px"><span class="muted num" style="flex:1;font-size:var(--fs-sm)">3 ${t.bags} · 147.7 kg · ${m(8197)}</span><button class="btn btn-tonal">${ic('plus', 'i-sm')}${t.addToBill}</button></div>
      </div></div>
    <div class="section"><div class="section-head"><span class="section-title">${t.onBill} · 2</span><span class="section-title num">2 ${t.bags} · 98.5 kg</span></div>${billLines(t)}</div>
  </main>${actionbar(t)}${tabbar('billing', t)}</div>`;
}

function phoneBillingBill(lang) {
  const t = S[lang];
  const pay = (label, focus = false, val = '') => `<div class="kv" style="min-height:56px"><span class="label" style="flex:1">${label}</span><button class="btn btn-sm btn-ghost" style="color:var(--accent-text)">${lang === 'hi' ? 'पूरा' : 'Fill'}</button><div class="input r ${focus ? 'focus' : ''}" style="width:132px"><span class="adorn">₹</span>${val ? `<span class="v num">${val}</span>` : '<span class="ph">0</span>'}</div></div>`;
  return `<div class="phone">${statusbar()}${appbar(t.billing, t)}
  <main class="page" style="padding-top:0">
    <div class="section" style="margin-top:4px"><div class="section-head"><span class="section-title">${t.onBill} · 2</span><span class="section-title num">2 ${t.bags} · 98.5 kg</span></div>${billLines(t)}</div>
    <div class="section"><div class="panel" style="padding:4px 16px">
      <div class="kv"><span class="ink2">${t.total}</span><span class="num">${m(5492)}</span></div>
      <div class="kv"><span style="display:flex;align-items:center;gap:10px;flex:1"><span class="switch on"></span><span class="ink2">${t.labour}</span><span class="muted num" style="font-size:var(--fs-sm)">6 × 2</span></span><div class="input r" style="width:96px;height:36px"><span class="adorn">−₹</span><span class="v num">12</span></div></div>
      <div class="kv" style="min-height:64px"><span style="font-weight:600">${t.totalPayable}</span><span class="display-num">${m(5480)}</span></div>
    </div></div>
    <div class="section"><div class="section-head"><span class="section-title">${t.payment}</span></div><div class="panel" style="padding:0 16px">
      ${pay(t.online, false, '3,000')}${pay(t.cash, true)}${pay(t.due)}
      <div class="kv" style="min-height:52px"><span class="ink2" style="flex:1">${t.notSplit} <b class="warn num" style="margin-left:6px">${m(2480)}</b></span><button class="btn btn-sm btn-tonal">${t.restDue}</button></div>
    </div></div>
    <div class="section"><div class="grid2" style="grid-template-columns:1.4fr 1fr">
      <div class="field"><label>${t.notes}</label><div class="input"><span class="ph">${t.notesPh}</span></div></div>
      <div class="field"><label>${t.date}</label><div class="input"><span class="v num">07/11/2026</span></div></div></div>
      <p class="muted" style="font-size:12px;margin-top:8px">${t.billNo}</p></div>
  </main>${actionbar(t)}${tabbar('billing', t)}</div>`;
}

function phoneToday() {
  const t = S.en;
  const row = (icon, tone, title, meta, trail = ic('chevR', 'chev')) => `<div class="row inset-lead"><span class="lead-icon ${tone}">${ic(icon)}</span><div class="row-main"><div class="row-title">${title}</div><div class="row-meta">${meta}</div></div>${trail}</div>`;
  return `<div class="phone">${statusbar()}${appbar('Today', t, 'Sat, 7 Nov')}
  <main class="page" style="padding-top:0">
    <div class="tabs"><a class="on">Summary</a><a>Cash</a></div>
    <div style="padding:18px 0 4px">
      <div class="muted" style="font-size:var(--fs-sm)">Net cash today</div>
      <div class="hero-num" style="margin-top:2px">${m(12480)}</div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:var(--fs-sm)" class="num">
        <span class="pos" style="display:flex;align-items:center;gap:4px">${ic('arrIn', 'i-sm')}In ${m(38200)}</span>
        <span class="ink2" style="display:flex;align-items:center;gap:4px">${ic('arrOut', 'i-sm')}Out ${m(25720)}</span></div>
      <div class="meter" style="margin-top:14px"><span style="width:46%;background:var(--accent)"></span><span style="width:38%;background:var(--positive)"></span><span style="width:16%;background:var(--warning-dot)"></span></div>
      <div class="legend"><div><span class="dot purchase"></span>Online<span class="num">${m(17572)}</span></div><div><span class="dot pos"></span>Cash<span class="num">${m(14516)}</span></div><div><span class="dot warn"></span>Due<span class="num">${m(6112)}</span></div></div>
    </div>
    <div class="section" style="margin-top:20px"><div class="section-head"><span class="section-title">Needs attention · 3</span></div><div class="panel">
      ${row('triangle', 'warn', '2 bills not split', 'Online, cash or due missing')}
      ${row('flag', 'neg', 'Day report: 1 high', 'Rate below cost on Wheat')}
      ${row('clipCheck', 'accent', 'Check a backup', 'None checked on this phone yet')}
    </div></div>
    <div class="section"><div class="section-head"><span class="section-title">Business</span><span class="section-action">Day report</span></div><div class="panel metrics">
      <div class="metric"><div class="metric-label"><span class="dot purchase"></span>Purchases</div><div class="metric-value">${m(25720)}</div><div class="metric-sub">4 bills</div></div>
      <div class="metric"><div class="metric-label"><span class="dot sale"></span>Retail sales</div><div class="metric-value">${m(31400)}</div><div class="metric-sub">9 bills</div></div>
      <div class="metric"><div class="metric-label">Business exp.</div><div class="metric-value">${m(1250)}</div><div class="metric-sub">3 entries</div></div>
      <div class="metric"><div class="metric-label">Personal exp.</div><div class="metric-value">${m(600)}</div><div class="metric-sub">1 entry</div></div>
    </div></div>
    <div class="section"><div class="section-head"><span class="section-title">Reminders</span><span class="section-action">+ Add</span></div><div class="panel"><div class="row"><div class="row-main muted" style="font-size:var(--fs-sm)">Nothing to do now.</div></div></div></div>
  </main>${tabbar('day', t)}</div>`;
}

function phoneOutstanding() {
  const t = S.en;
  const party = (ini, name, meta, amt, tag) => `<div class="row inset-lead"><span class="avatar">${ini}</span><div class="row-main"><div class="row-title">${name}</div><div class="row-meta">${meta}</div></div><div class="row-trail"><div class="row-amt">${m(amt)}</div>${tag}</div></div>`;
  return `<div class="phone">${statusbar()}${appbar('Outstanding', t)}
  <main class="page" style="padding-top:0">
    <div class="seg"><button class="on">To pay · Purchases</button><button>To collect · Sales</button></div>
    <div style="display:flex;gap:8px;margin-top:12px"><div class="input" style="flex:1">${ic('search', 'i-sm')}<span class="ph">Search name or bill no.</span></div></div>
    <div class="chips" style="margin-top:12px"><span class="chip on">All</span><span class="chip">Retail</span><span class="chip">Wholesale</span></div>
    <div style="padding:20px 0 4px">
      <div class="muted" style="font-size:var(--fs-sm)">You owe · 14 bills</div>
      <div class="hero-num" style="margin-top:2px">${m(124500)}</div>
      <div class="meter" style="margin-top:14px"><span style="width:52%;background:var(--ink-3)"></span><span style="width:24%;background:var(--warning-dot)"></span><span style="width:14%;background:#ea580c"></span><span style="width:10%;background:var(--negative)"></span></div>
      <div class="legend"><div><span class="dot" style="background:var(--ink-3)"></span>0–30 days<span class="num">${m(64740)}</span></div><div><span class="dot warn"></span>31–60<span class="num">${m(29880)}</span></div><div><span class="dot" style="background:#ea580c"></span>61–90<span class="num">${m(17430)}</span></div><div><span class="dot neg"></span>90+<span class="num neg">${m(12450)}</span></div></div>
    </div>
    <div class="section" style="margin-top:20px"><div class="section-head"><span class="section-title">By party · 6</span><span class="section-action" style="display:flex;align-items:center;gap:2px">Amount${ic('chevD', 'i-sm')}</span></div><div class="panel">
      ${party('SA', 'Shyam Agro Traders', '4 bills · oldest 96 days', 42300, '<span class="tag neg">96 d</span>')}
      ${party('RK', 'Ramesh Kumar', '3 bills · oldest 41 days', 28750, '<span class="tag warn">41 d</span>')}
      ${party('MF', 'Mahesh Farms', '2 bills · oldest 18 days', 21900, '<span class="tag">18 d</span>')}
      ${party('GS', 'Gopal Singh', '3 bills · oldest 9 days', 16050, '<span class="tag">9 d</span>')}
      ${party('BE', 'Before Edit', '2 bills · oldest 2 days', 1000, '<span class="tag">2 d</span>')}
    </div></div>
  </main>${tabbar('due', t)}</div>`;
}

function phoneMore() {
  const t = S.en;
  const tile = (i, l, b = '') => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 0;font-size:12px;font-weight:600;color:var(--ink-2);text-align:center"><span class="lead-icon" style="width:48px;height:48px;border-radius:14px;position:relative">${ic(i)}${b}</span>${l}</div>`;
  const grp = (title, tiles) => `<div class="section-title" style="margin:14px 0 4px">${title}</div><div style="display:grid;grid-template-columns:repeat(4,1fr)">${tiles}</div>`;
  return `<div class="phone">${statusbar()}${appbar(t.billing, t)}<main class="page"><div class="seg"><button class="on">${t.purchase}</button><button>${t.sale}</button></div></main>${tabbar('more', t)}
  <div class="scrim"></div>
  <div class="sheet"><div class="grabber"></div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span class="avatar" style="background:var(--accent);color:#fff">H</span><div style="flex:1"><div style="font-weight:600">happa</div><div class="muted" style="font-size:var(--fs-sm)">Owner · Synced</div></div><button class="btn btn-icon btn-ghost">${ic('x')}</button></div>
    <div class="seg" style="margin-top:8px"><button class="on">${ic('wheat', 'i-sm')}Aadhat</button><button>${ic('home', 'i-sm')}Rentals</button></div>
    ${grp('Daily', tile('truck', 'Wholesale') + tile('card', 'Expenses') + tile('tag', 'Rates') + tile('box', 'Stocks'))}
    ${grp('Money', tile('banknote', 'Money') + tile('trend', 'Insights') + tile('list', 'Statements') + tile('chat', 'Ask'))}
    ${grp('Manage', tile('flag', 'Anomalies', '<span class="badge accent" style="position:absolute;top:-4px;right:-6px;height:18px;min-width:18px;font-size:11px">1</span>') + tile('pulse', 'App health') + tile('shield', 'Admin') + tile('sliders', 'Settings'))}
  </div></div>`;
}

/* ---------- Desktop ---------- */
function sidebar(on) {
  const it = (k, i, l, kb, extra = '') => `<a class="nav-item ${k === on ? 'on' : ''}">${ic(i)}<span>${l}</span>${extra || (kb ? `<kbd>Alt ${kb}</kbd>` : '')}</a>`;
  return `<aside class="sidebar">
    <div class="ws"><span class="logo">h</span><div style="flex:1;min-width:0"><div class="name">happa · Aadhat</div><div class="role">Owner</div></div>${ic('chevD', 'i-sm')}</div>
    <div class="cmdk">${ic('search', 'i-sm')}Search or jump to…<kbd>Ctrl K</kbd></div>
    ${it('day', 'calendar', 'Today', 1)}${it('billing', 'receipt', 'Billing', 2)}${it('ws', 'truck', 'Wholesale', 3)}${it('exp', 'card', 'Expenses', 4)}
    <div class="nav-group">Records</div>
    ${it('history', 'history', 'History', 6)}${it('due', 'wallet', 'Outstanding', 8)}${it('stock', 'box', 'Stocks', 7)}${it('rates', 'tag', 'Rates', 5)}
    <div class="nav-group">Money</div>
    ${it('money', 'banknote', 'Money', 9)}${it('ins', 'trend', 'Insights')}${it('st', 'list', 'Statements')}
    <div class="nav-group">Manage</div>
    ${it('an', 'flag', 'Anomalies', '', '<span class="badge">1</span>')}${it('ad', 'shield', 'Admin')}
    <div class="grow"></div>
    ${it('set', 'sliders', 'Settings')}
    <a class="nav-item" style="color:var(--ink-3);font-weight:400">${ic('keyboard')}<span>Shortcuts</span><kbd style="opacity:1">?</kbd></a>
  </aside>`;
}

function deskHead(title, middle, right) {
  return `<header class="pagehead"><h1>${title}</h1>${middle}<span class="spacer"></span>${right}
    <span class="sync">${ic('cloudCheck', 'i-sm')}Synced</span>
    <button class="btn btn-icon btn-ghost bell">${ic('bell')}<span class="pip"></span></button></header>`;
}

function deskBilling(theme) {
  const t = S.en;
  return `<div class="desk-app">${sidebar('billing')}<div class="main">
  ${deskHead('Billing', `<div class="seg" style="width:260px"><button class="on"><span class="dot purchase"></span>Purchase</button><button><span class="dot sale"></span>Retail sale</button></div>`,
    `<button class="btn btn-sm btn-ghost">${ic('file', 'i-sm')}Drafts<span class="badge">2</span></button><button class="btn btn-sm btn-ghost">Save draft</button><button class="btn btn-sm btn-ghost danger">Clear</button>`)}
  <div class="content"><div class="cols">
    <div style="min-width:0;display:flex;flex-direction:column;gap:18px">
      <div class="notice neg" style="align-items:center">${ic('alert', 'i-sm')}<span class="grow">${t.problem}: payment not split</span><b>${t.show}</b></div>
      <div class="grid2" style="grid-template-columns:2fr 1fr"><div class="field"><label>Customer</label><div class="input"><span class="v">Ramesh Kumar</span>${ic('contact', 'i-sm')}</div></div>
        <div class="field"><label>Date</label><div class="input"><span class="v num">07/11/2026</span>${ic('calendar', 'i-sm')}</div></div></div>
      <div><div class="section-head"><span class="section-title">New line</span><span class="section-action" style="display:flex;gap:6px;align-items:center">${ic('mic', 'i-sm')}Speak</span></div>
        <div class="panel panel-pad" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1.4fr 1fr 1.2fr auto;gap:10px;align-items:end">
            <div class="field"><label>Item</label><div class="input"><span class="v">Mustard</span>${ic('chevD', 'i-sm')}</div></div>
            <div class="field"><label>Rate</label><div class="input"><span class="adorn">₹</span><span class="v num">55.50</span>${ic('chevD', 'i-sm')}</div></div>
            <div class="field"><label>Weight</label><div class="input focus"><span class="ph">Weight</span><span class="adorn">kg</span></div></div>
            <button class="btn btn-secondary">Add<kbd>↵</kbd></button></div>
          <div style="display:flex;align-items:center;gap:10px"><div class="weights" style="flex:1"><span class="wchip">48.5${ic('x')}</span><span class="wchip">50.0${ic('x')}</span><span class="wchip">49.2${ic('x')}</span></div>
            <span class="muted num" style="font-size:13px">3 bags · 147.7 kg · ${m(8197)}</span><button class="btn btn-tonal">${ic('plus', 'i-sm')}Add to bill</button></div>
        </div></div>
      <div><div class="section-head"><span class="section-title">On this bill · 2</span><span class="section-title num">2 bags · 98.5 kg</span></div>
        <div class="panel"><table class="tbl"><thead><tr><th>Item</th><th class="r">Rate</th><th class="r">Weight</th><th class="r">Bags</th><th class="r">Amount</th><th style="width:40px"></th></tr></thead><tbody>
          <tr><td style="font-weight:600">Mustard</td><td class="r">₹56.00</td><td class="r">50 kg</td><td class="r">1</td><td class="r" style="font-weight:600">${m(2800)}</td><td>${ic('x', 'i-sm muted')}</td></tr>
          <tr><td style="font-weight:600">Mustard</td><td class="r">₹55.50</td><td class="r">48.5 kg</td><td class="r">1</td><td class="r" style="font-weight:600">${m(2692)}</td><td>${ic('x', 'i-sm muted')}</td></tr>
        </tbody></table></div>
        <p class="muted" style="font-size:12px;margin-top:10px;display:flex;gap:14px"><span><kbd>↵</kbd> adds the weight</span><span><kbd>Ctrl S</kbd> saves</span><span><kbd>Ctrl P</kbd> prints</span><span><kbd>/</kbd> finds an item</span></p></div>
    </div>
    <aside class="aside-panel"><div class="body">
      <div class="kv"><span class="ink2">Purchase total</span><span class="num">${m(5492)}</span></div>
      <div class="kv"><span style="display:flex;align-items:center;gap:10px;flex:1"><span class="switch on"></span><span class="ink2">Labour</span><span class="muted num" style="font-size:13px">6 × 2</span></span><div class="input r" style="width:92px;height:30px"><span class="adorn">−₹</span><span class="v num">12</span></div></div>
      <div class="kv" style="min-height:56px"><span style="font-weight:600">Total payable</span><span class="display-num">${m(5480)}</span></div>
      <div class="section-title" style="margin:14px 0 4px">Payment</div>
      ${['Online', 'Cash', 'Due'].map((l, k) => `<div class="kv" style="min-height:42px"><span class="ink2" style="flex:1">${l}</span><span class="muted" style="font-size:12px;margin-right:6px">Fill</span><div class="input r ${k === 0 ? 'err' : ''}" style="width:130px;height:32px"><span class="adorn">₹</span><span class="ph">0</span></div></div>`).join('')}
      <div class="kv" style="min-height:44px"><span class="ink2" style="flex:1">Not split yet <b class="warn num" style="margin-left:6px">${m(5480)}</b></span><button class="btn btn-sm btn-tonal">Rest → Due</button></div>
      <div class="field" style="margin-top:8px"><label>Notes</label><div class="input"><span class="ph">GPay name, number etc.</span></div></div>
    </div>
    <div class="foot"><button class="btn btn-secondary btn-icon" title="WhatsApp">${ic('wa')}</button><button class="btn btn-secondary">${ic('printer', 'i-sm')}Print<kbd>Ctrl P</kbd></button><button class="btn btn-primary" style="flex:1">Save<kbd>Ctrl S</kbd></button></div></aside>
  </div></div></div></div>`;
}

function deskToday() {
  const bill = (time, no, party, type, amt, st) => `<tr><td class="muted">${time}</td><td>${no}</td><td style="font-weight:600">${party}</td><td>${type}</td><td class="r" style="font-weight:600">${m(amt)}</td><td>${st}</td></tr>`;
  const P = '<span class="tag purchase"><span class="dot purchase"></span>Purchase</span>';
  const Sx = '<span class="tag sale"><span class="dot sale"></span>Retail</span>';
  const W = '<span class="tag" style="background:var(--mode-wholesale-soft);color:var(--accent-text)"><span class="dot wholesale"></span>Wholesale</span>';
  const row = (icon, tone, title, meta) => `<div class="row inset-lead" style="min-height:52px"><span class="lead-icon ${tone}" style="width:32px;height:32px">${ic(icon, 'i-sm')}</span><div class="row-main"><div class="row-title" style="font-size:14px">${title}</div><div class="row-meta" style="font-size:12px">${meta}</div></div>${ic('chevR', 'chev i-sm')}</div>`;
  return `<div class="desk-app">${sidebar('day')}<div class="main">
  ${deskHead('Today', '<span class="crumb">Saturday, 7 November</span><div class="tabs" style="border:0;margin-left:12px"><a class="on">Summary</a><a>Cash</a></div>',
    `<button class="btn btn-sm btn-ghost">${ic('wa', 'i-sm')}Share</button><button class="btn btn-sm btn-ghost">${ic('printer', 'i-sm')}Print</button>`)}
  <div class="content" style="display:flex;flex-direction:column;gap:20px">
    <div class="panel" style="display:grid;grid-template-columns:1.3fr repeat(4,1fr)">
      <div class="metric" style="padding:16px 20px"><div class="metric-label">Net cash today</div><div class="display-num" style="margin-top:4px">${m(12480)}</div><div class="metric-sub pos" style="display:flex;gap:10px"><span>↙ In ${m(38200)}</span><span class="muted">↗ Out ${m(25720)}</span></div></div>
      ${[['purchase', 'Purchases', 25720, '4 bills'], ['sale', 'Retail sales', 31400, '9 bills'], ['wholesale', 'Wholesale', 18000, '2 bills'], ['', 'Expenses', 1850, '4 entries']].map(([d, l, v, s]) => `<div class="metric" style="padding:16px 20px;border-left:1px solid var(--line)"><div class="metric-label">${d ? `<span class="dot ${d}"></span>` : ''}${l}</div><div class="metric-value" style="margin-top:6px">${m(v)}</div><div class="metric-sub">${s}</div></div>`).join('')}
    </div>
    <div class="cols" style="grid-template-columns:minmax(0,1fr) 340px;height:auto">
      <div><div class="section-head"><span class="section-title">Today's bills · 15</span><span class="section-action">Open History</span></div>
        <div class="panel"><table class="tbl"><thead><tr><th>Time</th><th>Bill</th><th>Party</th><th>Type</th><th class="r">Amount</th><th>Payment</th></tr></thead><tbody>
        ${bill('5:37 pm', 'P-1042', 'Ramesh Kumar', P, 5480, '<span class="tag warn">Not split</span>')}
        ${bill('4:12 pm', 'S-2211', 'Walk-in', Sx, 1240, '<span class="tag pos">Cash</span>')}
        ${bill('3:55 pm', 'W-0318', 'Shyam Agro Traders', W, 18000, '<span class="tag">Due ₹6,000</span>')}
        ${bill('2:20 pm', 'P-1041', 'Mahesh Farms', P, 9640, '<span class="tag pos">Online</span>')}
        ${bill('1:02 pm', 'S-2210', 'Gopal Singh', Sx, 3360, '<span class="tag pos">Cash + Online</span>')}
        ${bill('11:48 am', 'P-1040', 'Sunita Devi', P, 6112, '<span class="tag warn">Due</span>')}
        </tbody></table></div></div>
      <div style="display:flex;flex-direction:column;gap:20px">
        <div><div class="section-head"><span class="section-title">Needs attention · 3</span></div><div class="panel">
          ${row('triangle', 'warn', '2 bills not split', 'Online, cash or due missing')}
          ${row('flag', 'neg', 'Day report: 1 high', 'Rate below cost on Wheat')}
          ${row('clipCheck', 'accent', 'Check a backup', 'None checked on this computer')}
        </div></div>
        <div><div class="section-head"><span class="section-title">Payment split</span></div><div class="panel panel-pad">
          <div class="meter"><span style="width:46%;background:var(--accent)"></span><span style="width:38%;background:var(--positive)"></span><span style="width:16%;background:var(--warning-dot)"></span></div>
          <div class="legend" style="grid-template-columns:1fr"><div><span class="dot purchase"></span>Online<span class="num">${m(17572)}</span></div><div><span class="dot pos"></span>Cash<span class="num">${m(14516)}</span></div><div><span class="dot warn"></span>Due<span class="num">${m(6112)}</span></div></div>
        </div></div>
      </div>
    </div>
  </div></div></div>`;
}

/* ---------- Design-system sheet ---------- */
function dsHalf(theme) {
  const sw = (v, l) => `<div style="display:flex;flex-direction:column;gap:4px;font-size:11px"><span style="height:36px;border-radius:8px;background:var(${v});border:1px solid var(--line)"></span><span class="muted">${l}</span></div>`;
  return `<div data-theme="modern" data-mode="${theme}" style="background:var(--bg);color:var(--ink);padding:28px;display:flex;flex-direction:column;gap:22px;height:100%">
    <div style="display:flex;justify-content:space-between;align-items:baseline"><div style="font-size:20px;font-weight:600">Bahi · ${theme === 'dark' ? 'Dark' : 'Light'}</div><span class="muted" style="font-size:12px">tokens → components</span></div>
    <div><div class="section-title" style="margin-bottom:8px">Neutrals</div><div style="display:grid;grid-template-columns:repeat(8,1fr);gap:8px">${sw('--bg', 'bg')}${sw('--surface', 'surface')}${sw('--surface-2', 'surface-2')}${sw('--surface-3', 'surface-3')}${sw('--line-strong', 'line')}${sw('--ink-3', 'ink-3')}${sw('--ink-2', 'ink-2')}${sw('--ink', 'ink')}</div></div>
    <div><div class="section-title" style="margin-bottom:8px">Modes · Status</div><div style="display:grid;grid-template-columns:repeat(8,1fr);gap:8px">${sw('--mode-purchase', 'purchase')}${sw('--mode-sale', 'retail')}${sw('--mode-wholesale', 'wholesale')}${sw('--mode-rentals', 'rentals')}${sw('--positive', 'positive')}${sw('--negative', 'negative')}${sw('--warning-dot', 'warning')}${sw('--info', 'info')}</div></div>
    <div style="display:flex;gap:28px;align-items:flex-end"><div><div class="section-title">Type · 400 / 600 only</div>
      <div class="hero-num" style="margin-top:6px">${m(124500)}</div><div style="font-size:20px;font-weight:600">Title 20 / 600</div><div style="font-size:15px">Body 15 / 400</div><div lang="hi" style="font-size:16px">बिल में जोड़ें · कुल देना</div><div class="muted" style="font-size:13px">Caption 13 · ink-3</div></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-left:auto">${['receipt', 'calendar', 'history', 'wallet', 'grid', 'truck', 'tag', 'box', 'banknote', 'trend', 'list', 'flag', 'shield', 'sliders', 'printer', 'wa'].reduce((a, n, k) => a + (k % 8 === 0 ? (k ? '</div>' : '') + '<div style="display:flex;gap:12px;color:var(--ink-2)">' : '') + ic(n), '') + '</div>'}</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary">Save</button><button class="btn btn-primary sale">Save sale</button><button class="btn btn-tonal">${ic('plus', 'i-sm')}Add to bill</button><button class="btn btn-secondary">${ic('printer', 'i-sm')}Print</button><button class="btn btn-ghost">Cancel</button><button class="btn btn-ghost danger">Clear</button><button class="btn btn-secondary btn-icon">${ic('wa')}</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="field"><label>Rate</label><div class="input"><span class="adorn">₹</span><span class="v num">55.50</span>${ic('chevD', 'i-sm')}</div></div><div class="field"><label>Weight</label><div class="input focus"><span class="ph">Weight</span><span class="adorn">kg</span></div></div></div>
    <div style="display:flex;gap:12px;align-items:center"><div class="seg" style="width:260px"><button class="on"><span class="dot purchase"></span>Purchase</button><button><span class="dot sale"></span>Retail sale</button></div><div class="tabs" style="flex:1"><a class="on">Summary</a><a>Cash</a></div></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip on">All</span><span class="chip">Retail</span><span class="tag pos">Cash</span><span class="tag warn">41 d</span><span class="tag neg">96 d</span><span class="badge">2</span><span class="switch on"></span><span class="check on">${ic('check', 'i-sm')}</span><span class="tooltip">Ctrl S · Save bill</span></div>
    <div class="panel"><div class="row inset-lead"><span class="avatar">RK</span><div class="row-main"><div class="row-title">Ramesh Kumar</div><div class="row-meta">3 bills · oldest 41 days</div></div><div class="row-amt">${m(28750)}</div>${ic('chevR', 'chev i-sm')}</div><div class="row inset-lead"><span class="lead-icon warn">${ic('triangle', 'i-sm')}</span><div class="row-main"><div class="row-title">2 bills not split</div><div class="row-meta">Online, cash or due missing</div></div>${ic('chevR', 'chev i-sm')}</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
      <div class="panel"><div class="empty" style="padding:18px"><span class="lead-icon">${ic('wallet')}</span><b>Nothing outstanding</b>Every bill is paid.</div></div>
      <div style="display:flex;flex-direction:column;gap:10px"><div class="panel panel-pad" style="display:flex;flex-direction:column;gap:8px"><div class="skel" style="width:60%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>
        <div class="notice neg">${ic('alert', 'i-sm')}<span class="grow"><b>Couldn't load.</b> Check the internet, then retry.</span><b>Retry</b></div>
        <div class="toast">${ic('check', 'i-sm')}Bill P-1042 saved<span class="act">Print</span></div></div></div>
  </div>`;
}
const dsSheet = () => `<div style="display:grid;grid-template-columns:1fr 1fr;height:100vh">${dsHalf('light')}${dsHalf('dark')}</div>`;

/* ---------- Themes ---------- */
const modeFor = (th, want) => (th.kind === 'dark' ? 'dark' : want);
const mini = (th, mode) => `<div class="mini" data-theme="${th.id}" data-mode="${mode}"><div class="phone">${appbar('Billing', S.en)}<main class="page"><div class="seg"><button class="on"><span class="dot purchase"></span>Purchase</button><button><span class="dot sale"></span>Retail sale</button></div><div class="section" style="margin-top:14px">${billLines(S.en)}</div><div style="display:flex;align-items:center;gap:10px;margin-top:14px"><span class="hero-num" style="flex:1;font-size:30px">${m(5480)}</span><button class="btn btn-primary" style="padding:0 26px">Save</button></div></main></div></div>`;
const tgCard = (th, mode, state) => `<div class="tg-card ${state}"><div class="tg-prev">${mini(th, modeFor(th, mode))}</div>${state === 'sel' ? `<span class="tg-check">${ic('check', 'i-sm')}</span>` : ''}<div class="tg-meta"><div class="tg-name">${th.name}${th.kind === 'dark' ? '<span class="tg-badge">Always dark</span>' : ''}</div><div class="tg-desc">${th.desc}</div></div></div>`;
const appearanceSeg = (on) => `<div class="seg">${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'auto', 'System']].map(([k, i, l]) => `<button class="${k === on ? 'on' : ''}">${ic(i, 'i-sm')}${l}</button>`).join('')}</div>`;

function phoneGallery(previewId) {
  const t = S.en;
  const pv = previewId && registry.find((x) => x.id === previewId);
  const cards = registry.map((th) => tgCard(th, 'light', th.id === 'modern' ? 'sel' : th.id === previewId ? 'peek' : '')).join('');
  return `<div class="phone">${statusbar()}${appbar('Settings', t)}
  <main class="page" style="padding-top:0">
    <div class="tabs"><a>General</a><a class="on">Appearance</a><a>Aadhat</a><a>Printer</a></div>
    <div class="section" style="margin-top:18px"><div class="section-head"><span class="section-title">Light or dark</span></div>${appearanceSeg('system')}
      <p class="muted" style="font-size:12px;margin-top:6px">System follows the phone (light now). Dark-only themes stay dark.</p></div>
    <div class="section"><div class="section-head"><span class="section-title">Theme · 12</span><span class="section-action">Reset to default</span></div>
      <div class="tg-grid">${cards}</div></div>
  </main>${pv ? `<div class="previewbar">${ic('palette')}<span class="grow">Previewing <b>${pv.name}</b> · not saved yet</span><button class="btn btn-sm btn-ghost">Cancel</button><button class="btn btn-sm btn-primary">Apply</button></div>` : ''}${tabbar('more', t)}</div>`;
}

function deskGallery() {
  const cards = registry.map((th) => tgCard(th, 'light', th.id === 'modern' ? 'sel' : th.id === 'nordic' ? 'peek' : '')).join('');
  return `<div class="desk-app">${sidebar('set')}<div class="main">${deskHead('Settings', '<div class="tabs" style="border:0;margin-left:12px"><a>General</a><a class="on">Appearance</a><a>Aadhat</a><a>Printer</a><a>Users</a></div>', '')}
  <div class="content"><div class="cols" style="grid-template-columns:minmax(0,1fr) 300px">
    <div style="overflow:hidden"><div style="display:flex;align-items:center;gap:16px;margin-bottom:16px"><span class="label">Light or dark</span><div style="width:330px">${appearanceSeg('system')}</div><span style="flex:1"></span><button class="btn btn-sm btn-ghost">Reset to default</button></div>
      <div class="tg-grid" style="grid-template-columns:repeat(4,1fr)">${cards}</div></div>
    <aside class="aside-panel"><div class="body" style="padding:14px 16px"><div class="section-head"><span class="section-title">Live preview · Nordic</span><span class="tg-badge">Light + dark</span></div>
      <div style="height:480px;width:222px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid var(--line)"><div data-theme="nordic" data-mode="light" style="width:390px;height:844px;transform:scale(.5692);transform-origin:0 0">${phoneBilling('en')}</div></div></div>
      <div class="foot"><button class="btn btn-secondary" style="flex:1">Cancel</button><button class="btn btn-primary" style="flex:1">Apply</button></div></aside>
  </div></div></div></div>`;
}

function themesOverview(mode) {
  const fr = registry.map((th) => {
    const md = modeFor(th, mode);
    return `<figure style="margin:0"><div style="width:195px;height:422px;border-radius:18px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.12),0 12px 28px -12px rgba(0,0,0,.35)"><div data-theme="${th.id}" data-mode="${md}" style="width:390px;height:844px;transform:scale(.5);transform-origin:0 0">${phoneBilling('en')}</div></div><figcaption style="font:600 13px/1.3 var(--font-ui);margin-top:8px;color:#16161d">${th.name}<span style="display:block;font-weight:400;color:#5c5c68;font-size:12px">${th.kind === 'dark' ? 'Always dark' : md === 'dark' ? 'Dark variant' : 'Light variant'}</span></figcaption></figure>`;
  }).join('');
  return `<div style="background:#ececf0;padding:26px 32px;height:100%;box-sizing:border-box"><div style="font:600 20px var(--font-ui);color:#16161d;margin-bottom:18px">12 themes · Billing · Appearance: ${mode === 'dark' ? 'Dark' : 'Light'}</div><div style="display:grid;grid-template-columns:repeat(6,195px);gap:26px 26px">${fr}</div></div>`;
}

/* ---------- Pages ---------- */const MOCKS = [
  { file: 'phone-light-billing', w: 390, h: 844, dpr: 2, html: () => phoneBilling('en'), title: 'Billing · phone · light' },
  { file: 'phone-light-billing-bill', w: 390, h: 844, dpr: 2, html: () => phoneBillingBill('en'), title: 'Billing totals + payment · phone · light' },
  { file: 'phone-dark-billing', w: 390, h: 844, dpr: 2, html: () => phoneBilling('en'), mode: 'dark', title: 'Billing · phone · dark' },
  { file: 'phone-light-hi-billing', w: 390, h: 844, dpr: 2, html: () => phoneBilling('hi'), lang: 'hi', title: 'Billing · phone · Hindi' },
  { file: 'phone-light-today', w: 390, h: 844, dpr: 2, html: phoneToday, title: 'Today · phone · light' },
  { file: 'phone-dark-today', w: 390, h: 844, dpr: 2, html: phoneToday, mode: 'dark', title: 'Today · phone · dark' },
  { file: 'phone-light-outstanding', w: 390, h: 844, dpr: 2, html: phoneOutstanding, title: 'Outstanding · phone · light' },
  { file: 'phone-light-more', w: 390, h: 844, dpr: 2, html: phoneMore, title: 'More sheet (replaces ☰ drawer on phone)' },
  { file: 'desktop-light-billing', w: 1366, h: 768, dpr: 1, html: () => deskBilling('light'), desk: true, title: 'Billing · desktop · light' },
  { file: 'desktop-dark-billing', w: 1366, h: 768, dpr: 1, html: () => deskBilling('dark'), desk: true, mode: 'dark', title: 'Billing · desktop · dark' },
  { file: 'desktop-light-today', w: 1366, h: 768, dpr: 1, html: deskToday, desk: true, title: 'Today · desktop · light' },
  { file: 'desktop-dark-today', w: 1366, h: 768, dpr: 1, html: deskToday, desk: true, mode: 'dark', title: 'Today · desktop · dark' },
  ...registry.filter((t) => t.id !== 'modern').flatMap((th) => (th.kind === 'dark' ? ['dark'] : ['light', 'dark']).map((md) => ({ file: `theme-${th.id}-${md}`, w: 390, h: 844, dpr: 1.5, html: () => phoneBilling('en'), themeId: th.id, mode: md, title: `Billing · ${th.name} · ${th.kind === 'dark' ? 'always dark' : md}` }))),
  { file: 'phone-light-theme-gallery', w: 390, h: 1540, dpr: 2, html: () => phoneGallery(), title: 'Settings › Appearance: Theme Gallery (whole scroll)' },
  { file: 'phone-theme-preview-vintage', w: 390, h: 844, dpr: 2, html: () => phoneGallery('vintage'), themeId: 'vintage', title: 'Theme Gallery: previewing Vintage before applying' },
  { file: 'desktop-light-theme-gallery', w: 1366, h: 768, dpr: 1, html: deskGallery, desk: true, title: 'Theme Gallery · desktop with live preview' },
  { file: 'themes-overview-light', w: 1366, h: 1050, dpr: 1, html: () => themesOverview('light'), title: 'All 12 themes · Appearance Light' },
  { file: 'themes-overview-dark', w: 1366, h: 1050, dpr: 1, html: () => themesOverview('dark'), title: 'All 12 themes · Appearance Dark' },
  { file: 'design-system', w: 1440, h: 1080, dpr: 1, html: dsSheet, title: 'Design system sheet (light | dark)' }
];

function page(mk) {
  const cls = mk.desk ? 'desk' : '';
  return `<!doctype html><html lang="${mk.lang || 'en'}" data-theme="${mk.themeId || 'modern'}" data-mode="${mk.mode || 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${mk.title}</title><style>${css}</style></head><body class="${cls}">${sprite}${mk.html()}</body></html>`;
}

async function main() {
  for (const mk of MOCKS) fs.writeFileSync(path.join(OUT, mk.file + '.html'), page(mk));
  fs.writeFileSync(path.join(OUT, 'mocks.json'), JSON.stringify(MOCKS.map(({ file, title, w, h }) => ({ file, title, w, h })), null, 1));
  const zlib = require('zlib');
  const sz = (s) => ({ raw: Buffer.byteLength(s), gz: zlib.gzipSync(s).length });
  console.log('sizes', JSON.stringify({ ds: sz(css.split('\n')[0] && fs.readFileSync(path.join(__dirname, 'ds.css'), 'utf8')), themes: sz(themeCss.join('\n')), perTheme: Object.fromEntries(registry.filter((t) => t.id !== 'modern').map((t, k) => [t.id, sz(themeCss[k]).gz])) }));
  if (process.argv.includes('--no-render')) return;
  const { chromium } = require(path.resolve(__dirname, '../../../.mocktool/node_modules/playwright-core'));
  const browser = await chromium.launch();
  for (const mk of MOCKS) {
    const ctx = await browser.newContext({ viewport: { width: mk.w, height: mk.h }, deviceScaleFactor: mk.dpr });
    const pg = await ctx.newPage();
    await pg.goto('file:///' + path.join(OUT, mk.file + '.html').replace(/\\/g, '/'));
    await pg.screenshot({ path: path.join(OUT, mk.file + '.png') });
    await ctx.close();
    console.log('rendered', mk.file);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
