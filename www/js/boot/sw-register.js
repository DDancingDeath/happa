// Service worker registration + auto-reload on a new version. When a new SW takes
// control (after a deploy), reload so the user sees the new code without a hard refresh.
(function () {
    if (!('serviceWorker' in navigator)) return;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        console.log('[SW] New service worker took control — reloading for fresh code.');
        window.location.reload();
    });

    window.addEventListener('load', () => {
        let pending;
        try {
            pending = Promise.resolve(navigator.serviceWorker.register('/service-worker.js'));
        } catch (err) {
            pending = Promise.reject(err);
        }
        pending
            .then((registration) => {
                if (!registration) return;
                // Check for updates every time the page becomes visible.
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') {
                        registration.update?.()?.catch?.(() => {});
                    }
                });

                // A new SW skips waiting so it activates now, not after every tab closes.
                registration.addEventListener?.('updatefound', () => {
                    const sw = registration.installing;
                    if (!sw) return;
                    sw.addEventListener('statechange', () => {
                        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('[SW] Update installed; activating new version.');
                            try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
                        }
                    });
                });
            })
            .catch(err => console.warn('[SW] Registration failed:', err));
    });
})();
