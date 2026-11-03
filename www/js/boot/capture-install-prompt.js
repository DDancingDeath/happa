// Classic script in <head>, before anything else can miss the event: keeps the
// browser's install prompt for services/install-prompt.js (#89: no inline scripts).
window.addEventListener('beforeinstallprompt', function (e) { window.__installPromptEvent = e; });
