// The paddle owns player input and its world-space position.
window.Paddle = (function() {
    const cfg = window.GameConfig;
    const limits = cfg.paddle;
    const pressed = new Set();
    // Pointer controls and the keyboard can be used together. Releasing a
    // touch button must not release a key that is still physically held.
    const pointerPressed = new Set();
    const movementKeys = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS']);
    let enabled = false;

    const state = {
        x: limits.startX,
        y: limits.startY,
        z: limits.startZ,
        previousX: limits.startX,
        previousY: limits.startY,
        previousZ: limits.startZ,
        vx: 0, vy: 0, vz: 0,
        smoothedVx: 0, smoothedVy: 0,
        previousSmoothedVx: 0, previousSmoothedVy: 0
    };

    window.addEventListener('keydown', function(event) {
        const target = event.target;
        const editing = target && (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
        if (enabled && !editing && !event.metaKey && !event.ctrlKey && !event.altKey && movementKeys.has(event.code)) {
            pressed.add(event.code);
            event.preventDefault();
        }
    });

    window.addEventListener('keyup', function(event) {
        pressed.delete(event.code);
    });

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function update(dt) {
        if (!enabled || !(dt > 0) || !Number.isFinite(dt)) return;
        state.previousX = state.x;
        state.previousY = state.y;
        state.previousZ = state.z;
        state.previousSmoothedVx = state.smoothedVx;
        state.previousSmoothedVy = state.smoothedVy;
        let horizontal = 0;
        let depth = 0;
        const down = key => pressed.has(key) || pointerPressed.has(key);
        if (down('KeyA')) horizontal -= 1;
        if (down('KeyD')) horizontal += 1;
        if (down('KeyS')) depth -= 1;
        if (down('KeyW')) depth += 1;

        // Clamp to the reachable area of the court.
        state.x = clamp(
            state.x + horizontal * limits.speed * dt,
            -cfg.table.width / 2 + limits.edgeMargin,
            cfg.table.width / 2 - limits.edgeMargin
        );

        state.y = clamp(
            state.y + depth * limits.depthSpeed * dt,
            limits.minY,
            limits.maxY
        );
        // Measure actual world-space displacement after clamping to the table.
        state.vx = (state.x - state.previousX) / dt;
        state.vy = (state.y - state.previousY) / dt;
        const smoothingTime = cfg.shot.smoothingTime;
        const alpha = smoothingTime > 0 ? 1 - Math.exp(-dt / smoothingTime) : 1;
        state.smoothedVx += alpha * (state.vx - state.smoothedVx);
        state.smoothedVy += alpha * (state.vy - state.smoothedVy);
        if (Math.abs(state.smoothedVx) < 0.001) state.smoothedVx = 0;
        if (Math.abs(state.smoothedVy) < 0.001) state.smoothedVy = 0;
        if (window.Net && window.Net.isInGame()) {
            window.Net.sendPaddle(state.x, state.y);
        }
    }

    function getState() {
        return Object.assign({
            hitY: state.y,
            halfWidth: limits.halfWidth,
            halfHeight: limits.halfHeight,
            returnSpeed: limits.returnSpeed
        }, state);
    }

    function reset() {
        state.x = limits.startX;
        state.y = limits.startY;
        state.z = limits.startZ;
        clearMotion();
    }

    function clearMotion() {
        pressed.clear();
        pointerPressed.clear();
        state.previousX = state.x;
        state.previousY = state.y;
        state.previousZ = state.z;
        state.vx = state.vy = state.vz = 0;
        state.smoothedVx = state.smoothedVy = 0;
        state.previousSmoothedVx = state.previousSmoothedVy = 0;
    }

    window.addEventListener('blur', clearMotion);

    function setEnabled(value) {
        enabled = Boolean(value);
        clearMotion();
    }

    function setDirection(code, down) {
        if (!movementKeys.has(code)) return;
        if (enabled && down) pointerPressed.add(code);
        else pointerPressed.delete(code);
    }

    return Object.freeze({ update, getState, reset, setEnabled, setDirection,
        clearInput: clearMotion });
})();
