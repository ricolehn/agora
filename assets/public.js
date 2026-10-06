// Public pages (privacy, account deletion): show the instance's app name instead of "Agora"
(async () => {
    try {
        const cfg = await (await fetch('/assets/config.js')).text();
        const name = cfg.match(/appName\s*[:=]\s*["'`]([^"'`]+)/);
        if (name) document.querySelectorAll('.app-name').forEach(el => { el.textContent = name[1]; });
    } catch { /* keep "Agora" */ }
})();
