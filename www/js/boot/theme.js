// Classic script, the first thing in <body>: applies the saved theme before first
// paint (#102); Settings only applies it once opened.
try { if (localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark-mode'); } catch (e) {}
