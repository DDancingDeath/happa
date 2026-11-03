// Classic script in /download's <head>: picks the page language before first paint
// (html[lang] hides the other language's text).
(function () {
    var lang = 'en';
    try {
        var saved = localStorage.getItem('aadhat.lang');
        if (saved === 'en' || saved === 'hi') lang = saved;
        else if (/^hi\b/i.test(navigator.language || '')) lang = 'hi';
    } catch (e) { /* storage blocked */ }
    document.documentElement.lang = lang;
})();
