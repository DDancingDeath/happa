/**
 * Tenant rent-history page (/r/<token>), read-only. Reads exactly ONE Firestore
 * document over REST (rent_public/<token>): no Firebase SDK, no app code, no
 * service worker. One language at a time (browser language or the toggle).
 */
(function () {
    'use strict';

    const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
    const LANG_KEY = 'happa.rentLang';
    const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
    const TEXT = {
        en: {
            title: 'Rent history', loading: 'Loading…', other: 'हिंदी', print: 'Print',
            notFound: 'This link is not available. It may have been turned off. Please ask for a new link.',
            failed: 'Could not load. Check the internet and try again.',
            movedOut: (m) => `Moved out. Last month: ${m}`,
            rent: 'Rent', due: 'Due on day', totalDue: 'Total due', paidAll: 'Paid (shown months)',
            elec: (u) => `Electricity (${u} units)`, total: 'Total', paid: 'Paid', left: 'Due',
            paidOn: 'Paid on', receipt: 'Receipt', st: { paid: 'Paid', partial: 'Part paid', due: 'Due', late: 'Late' },
            note: 'Read-only copy kept up to date by the owner. For questions, contact the owner.',
            ut: { flat: 'Flat', commercial: 'Shop', office: 'Office', godown: 'Godown', other: '' },
            since: (d) => `Tenant since ${d}`,
            em: { included: 'Electricity is included in the rent.', own: 'Electricity: your own meter, paid by you to the board.', meter: '' }
        },
        hi: {
            title: 'किराये का हिसाब', loading: 'लोड हो रहा है…', other: 'English', print: 'प्रिंट',
            notFound: 'यह लिंक उपलब्ध नहीं है। हो सकता है यह बंद कर दिया गया हो। कृपया नया लिंक माँगें।',
            failed: 'लोड नहीं हुआ। इंटरनेट जाँचकर फिर कोशिश करें।',
            movedOut: (m) => `मकान खाली किया। आखिरी महीना: ${m}`,
            rent: 'किराया', due: 'हर महीने की तारीख', totalDue: 'कुल बकाया', paidAll: 'चुकाया (दिखाए महीने)',
            elec: (u) => `बिजली (${u} यूनिट)`, total: 'कुल', paid: 'चुकाया', left: 'बकाया',
            paidOn: 'भुगतान की तारीख', receipt: 'रसीद', st: { paid: 'चुकाया', partial: 'कुछ चुकाया', due: 'बकाया', late: 'देर' },
            note: 'यह केवल देखने के लिए है, मालिक इसे अपडेट रखते हैं। सवाल हों तो मालिक से बात करें।',
            ut: { flat: 'फ़्लैट', commercial: 'दुकान', office: 'ऑफ़िस', godown: 'गोदाम', other: '' },
            since: (d) => `${d} से किरायेदार`,
            em: { included: 'बिजली किराये में शामिल है।', own: 'बिजली: आपका अपना मीटर, बिल आप खुद भरते हैं।', meter: '' }
        }
    };

    function pickLang(store, nav) {
        try {
            const saved = store && store.getItem(LANG_KEY);
            if (saved === 'en' || saved === 'hi') return saved;
        } catch (_) { /* private mode */ }
        return /^hi\b/i.test((nav && nav.language) || '') ? 'hi' : 'en';
    }

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Number(n) || 0);

    function monthLabel(m, lang) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m))) return String(m || '');
        const [y, mo] = m.split('-').map(Number);
        return `${(lang === 'hi' ? HI_MONTHS : EN_MONTHS)[mo - 1]} ${y}`;
    }

    function dateLabel(d) {
        const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
        return p ? `${p[3]}/${p[2]}/${p[1]}` : '';
    }

    /**
     * Status worked out when the page is opened (not the stored one, which is
     * only as fresh as the last write): Paid, else Late after the due day, else
     * Part paid / Due.
     */
    function statusOf(x, dueDay, today) {
        if ((Number(x.due) || 0) <= 0.005) return 'paid';
        const p = /^(\d{4})-(\d{2})$/.exec(String(x.m));
        const day = Math.min(Math.max(Number(x.dd || dueDay) || 10, 1), 28);
        if (p) {
            const dueDate = new Date(Number(p[1]), Number(p[2]) - 1, day);
            const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            if (start > dueDate) return 'late';
        }
        return (Number(x.paid) || 0) > 0 ? 'partial' : 'due';
    }

    /** Firestore REST value -> plain JS. */
    function decode(v) {
        if (!v || typeof v !== 'object') return null;
        if ('stringValue' in v) return v.stringValue;
        if ('integerValue' in v) return Number(v.integerValue);
        if ('doubleValue' in v) return Number(v.doubleValue);
        if ('booleanValue' in v) return v.booleanValue;
        if ('nullValue' in v) return null;
        if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
        if ('mapValue' in v) {
            const out = {};
            Object.entries(v.mapValue.fields || {}).forEach(([k, x]) => { out[k] = decode(x); });
            return out;
        }
        return null;
    }

    function tokenFrom(loc) {
        const m = /^\/r\/([^/?#]+)\/?$/.exec(loc.pathname);
        return m && TOKEN_RE.test(m[1]) ? m[1] : '';
    }

    async function loadConfig(fetchFn) {
        try {
            const r = await fetchFn('/__/firebase/init.json');
            if (r.ok) {
                const c = await r.json();
                if (c && c.projectId) return { projectId: c.projectId, apiKey: c.apiKey || '' };
            }
        } catch (_) { /* not on Firebase Hosting (local tests) */ }
        const r = await fetchFn('/firebaseConfig.js');
        const text = await r.text();
        const pid = /"?projectId"?\s*:\s*["']([^"']+)/.exec(text);
        const key = /"?apiKey"?\s*:\s*["']([^"']+)/.exec(text);
        if (!pid) throw new Error('config');
        return { projectId: pid[1], apiKey: key ? key[1] : '' };
    }

    function docUrl(cfg, token, params) {
        const emulator = params.get('emulator') === '1';
        const base = emulator ? 'http://127.0.0.1:8181/v1/' : 'https://firestore.googleapis.com/v1/';
        const coll = (params.get('d') === '1' ? 'dev_' : '') + 'rent_public';
        const key = !emulator && cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : '';
        return `${base}projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/${coll}/${token}${key}`;
    }

    function renderMessage(root, lang, key) {
        const L = TEXT[lang];
        root.innerHTML = `<div class="rh-empty"><p>${esc(L[key])}</p></div>`;
    }

    /** "Flat 2B, Gupta Bhawan": the type word in the page language, unless the unit name starts with it. */
    function placeLine(data, lang) {
        const word = (TEXT[lang].ut || {})[data.ut] || '';
        const place = String(data.place || '');
        return word && !place.toLowerCase().startsWith(word.toLowerCase()) ? `${word} ${place}` : place;
    }

    function render(root, data, lang, onToggle, today = new Date()) {
        const L = TEXT[lang];
        const months = (Array.isArray(data.months) ? data.months : []).slice()
            .sort((a, b) => (a.m !== b.m ? (a.m < b.m ? 1 : -1) : (a.pl ? 1 : 0) - (b.pl ? 1 : 0)));
        const totalDue = months.reduce((s, x) => s + (Number(x.due) || 0), 0);
        const totalPaid = months.reduce((s, x) => s + (Number(x.paid) || 0), 0);
        const rows = months.map(x => {
            const st = statusOf(x, data.dueDay, today);
            const elec = Number(x.elec) > 0 ? `<div class="rh-row"><span>${esc(L.elec(x.units))}</span><span>${esc(inr(x.elec))}</span></div>` : '';
            const pays = Array.isArray(x.py) && x.py.length ? x.py.filter(p => p && typeof p === 'object').map(p => `<div class="rh-dates">${esc(L.paidOn)}: ${esc([dateLabel(p.d), inr(p.a), p.r ? `${L.receipt} ${p.r}` : ''].filter(Boolean).join(' · '))}</div>`).join('') : '';
            const dates = pays || (Array.isArray(x.pd) && x.pd.length ? `<div class="rh-dates">${esc(L.paidOn)}: ${esc(x.pd.map(dateLabel).join(', '))}</div>` : '');
            return `<section class="rh-month">
                <div class="rh-mhead"><span>${esc(monthLabel(x.m, lang))}${x.pl ? ` · ${esc(placeLine({ place: x.pl, ut: x.pt }, lang))}` : ''}</span><span class="rh-st rh-st-${st}">${esc(L.st[st])}</span></div>
                <div class="rh-row"><span>${esc(L.rent)}</span><span>${esc(inr(x.rent))}</span></div>${elec}
                <div class="rh-row"><span>${esc(L.total)}</span><span>${esc(inr(x.total))}</span></div>
                <div class="rh-row"><span>${esc(L.paid)}</span><span>${esc(inr(x.paid))}</span></div>
                <div class="rh-row"><strong>${esc(L.left)}</strong><strong>${esc(inr(x.due))}</strong></div>${dates}
            </section>`;
        }).join('');
        root.innerHTML = `<header class="rh-top">
                <div>${data.shop ? `<p class="rh-shop">${esc(data.shop)}</p>` : ''}
                    <h1 class="rh-title">${esc(L.title)}: ${esc(data.tenant)}</h1>
                    <p class="rh-sub">${esc(placeLine(data, lang))}</p>
                    ${data.since ? `<p class="rh-sub">${esc(L.since(dateLabel(data.since)))}</p>` : ''}
                    ${L.em[data.em] ? `<p class="rh-sub">${esc(L.em[data.em])}</p>` : ''}</div>
                <div class="rh-btns"><button type="button" class="rh-btn" id="rhLang" lang="${lang === 'hi' ? 'en' : 'hi'}">${esc(L.other)}</button>
                    <button type="button" class="rh-btn" id="rhPrint">${esc(L.print)}</button></div>
            </header>
            ${data.ended ? `<div class="rh-banner">${esc(L.movedOut(monthLabel(data.endMonth, lang)))}</div>` : ''}
            <div class="rh-cards">
                <div class="rh-card"><span>${esc(L.rent)}</span><b>${esc(inr(data.rent))}</b></div>
                <div class="rh-card"><span>${esc(L.due)}</span><b>${esc(data.dueDay)}</b></div>
                <div class="rh-card"><span>${esc(L.totalDue)}</span><b>${esc(inr(totalDue))}</b></div>
                <div class="rh-card"><span>${esc(L.paidAll)}</span><b>${esc(inr(totalPaid))}</b></div>
            </div>
            ${rows}
            <p class="rh-note">${esc(L.note)}</p>`;
        root.querySelector('#rhLang').addEventListener('click', onToggle);
        root.querySelector('#rhPrint').addEventListener('click', () => window.print());
    }

    async function start(win = window, { today } = {}) {
        const doc = win.document;
        const root = doc.getElementById('rh');
        const store = (() => { try { return win.localStorage; } catch (_) { return null; } })();
        let lang = pickLang(store, win.navigator);
        const setLang = (l) => { lang = l; doc.documentElement.lang = l; doc.title = TEXT[l].title; };
        setLang(lang);
        root.innerHTML = `<p class="rh-loading">${esc(TEXT[lang].loading)}</p>`;
        const token = tokenFrom(win.location);
        if (!token) return renderMessage(root, lang, 'notFound');
        let data;
        try {
            const cfg = await loadConfig(win.fetch.bind(win));
            const res = await win.fetch(docUrl(cfg, token, new URLSearchParams(win.location.search)));
            if (res.status === 404 || res.status === 403) return renderMessage(root, lang, 'notFound');
            if (!res.ok) return renderMessage(root, lang, 'failed');
            data = decode({ mapValue: { fields: (await res.json()).fields || {} } });
        } catch (_) {
            return renderMessage(root, lang, 'failed');
        }
        const draw = () => render(root, data, lang, () => {
            setLang(lang === 'hi' ? 'en' : 'hi');
            try { store && store.setItem(LANG_KEY, lang); } catch (_) { /* private mode */ }
            draw();
        }, today || new Date());
        draw();
    }

    const api = { start, decode, tokenFrom, docUrl, pickLang, monthLabel, statusOf, placeLine, TEXT };
    if (typeof window !== 'undefined') {
        window.RentHistory = api;
        if (!window.__rentHistoryNoAutoStart) {
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start());
            else start();
        }
    }
})();
