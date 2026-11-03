// /download: the language switch and the latest release's version and notes.
(function () {
    var root = document.documentElement;
    var appName = document.querySelector('h1').textContent;
    var titles = { en: appName + ' — Download', hi: appName + ' — डाउनलोड' };
    var releaseNotes = null;

    function fillNotes(lang) {
        var list = document.getElementById('notesList');
        var notes = releaseNotes || {};
        var items = Array.isArray(notes[lang]) && notes[lang].length ? notes[lang] : (notes[lang === 'hi' ? 'en' : 'hi'] || []);
        list.textContent = '';
        list.lang = items === notes[lang] ? lang : (lang === 'hi' ? 'en' : 'hi');
        items.forEach(function (note) {
            var li = document.createElement('li');
            li.textContent = String(note);
            list.appendChild(li);
        });
        document.getElementById('notesSection').hidden = !list.children.length;
    }

    function show(lang) {
        root.lang = lang;
        document.title = titles[lang];
        document.querySelectorAll('[data-lang-option]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang-option') === lang));
        });
        var group = document.querySelector('.lang-switch');
        group.setAttribute('aria-label', lang === 'hi' ? 'भाषा' : 'Language');
        if (releaseNotes) fillNotes(lang);
    }

    document.querySelectorAll('[data-lang-option]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var lang = btn.getAttribute('data-lang-option');
            try { localStorage.setItem('aadhat.lang', lang); } catch (e) { /* storage blocked */ }
            show(lang);
        });
    });
    show(root.lang === 'hi' ? 'hi' : 'en');

    fetch('/changelog.json', { cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
            var latest = data && Array.isArray(data.releases) ? data.releases[0] : null;
            if (!latest) return;
            document.getElementById('latestVersion').textContent = 'v' + String(latest.version || '');
            if (latest.date) document.getElementById('latestDate').textContent = '(' + String(latest.date) + ')';
            releaseNotes = latest.notes || {};
            fillNotes(root.lang);
        })
        .catch(function () { /* page still works without notes */ });
})();
