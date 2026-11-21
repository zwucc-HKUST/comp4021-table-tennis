// C controls one shared cheat state; forms never consume gameplay shortcuts.
window.CheatMode = (function() {
    const toggleKey = window.GameConfig.cheat.toggleKey;
    const listeners = new Set();
    let active = false;
    let enabled = false;
    let keyboardEnabled = true;

    function setActive(value) {
        value = Boolean(value);
        if (active === value) return;
        active = value;
        listeners.forEach(listener => listener(active));
    }

    window.addEventListener('keydown', function(event) {
        const target = event.target;
        const editing = target && (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
        if (!enabled || !keyboardEnabled || editing || event.code !== toggleKey || event.repeat ||
                event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        setActive(!active);
    });

    return Object.freeze({
        isActive: () => active,
        toggle() { if (enabled) setActive(!active); },
        setKeyboardEnabled(value) { keyboardEnabled = Boolean(value); },
        setEnabled(value) {
            enabled = Boolean(value);
            if (!enabled) setActive(false);
        },
        reset: () => setActive(false),
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    });
})();
