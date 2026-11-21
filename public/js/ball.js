// Fixed-step flight and collisions. Only the receiver reports the result of a
// shot; both clients keep drawing it until the next hit or a server-awarded point.
window.Ball = (function() {
    const cfg = window.GameConfig;
    const table = cfg.table;
    const physics = cfg.physics;
    const shots = window.ShotPhysics;
    const farY = table.nearY + table.length;
    const netY = table.nearY + table.length / 2;
    const contactZ = table.height + physics.ballRadius;
    let state;
    let phase = 'idle';
    let onlineMode = false;
    const impactListeners = new Set();
    function impact(type) {
        const point = { x: state.x, y: state.y, z: state.z };
        impactListeners.forEach(listener => listener(type, point));
    }

    function reset() {
        const paddle = window.Paddle.getState();
        state = {
            x: paddle.x, y: paddle.hitY, z: paddle.z,
            vx: 0, vy: 0, vz: 0, radius: physics.ballRadius, visible: true,
            bounceCount: 0, paddleHitCount: 0,
            status: 'ready', returnPlan: null, lastPlayerShotAngle: 0,
            lastShotByPlayer: false, isServe: false, cheatBall: false,
            cheatActive: false, cheatJitter: 0, flightStep: 0,
            pendingCorrection: null, roundId: 0, shotId: 0, hitterIndex: null
        };
        phase = 'idle';
    }

    function finishRound(reason) {
        phase = 'waiting-round';
        state.status = reason;
        // The opponent's simulation starts when its hit packet arrives. Let
        // that receiving client judge misses, avoiding premature outbound points.
        if (onlineMode && (!state.lastShotByPlayer || reason === 'unreachable')) {
            window.Net.reportMiss(reason);
        }
    }

    function launch(shot, isServe) {
        state.visible = true;
        state.vx = shot.vx; state.vy = shot.vy; state.vz = shot.vz;
        state.returnPlan = shot;
        state.bounceCount = 0;
        state.lastShotByPlayer = true;
        state.isServe = Boolean(isServe);
        state.cheatActive = window.CheatMode.isActive();
        state.cheatBall = false;
        state.flightStep = 0;
        state.pendingCorrection = null;
        // Sample once at contact, then send the same signed value to both
        // simulations. Applying it on the bounce avoids latency-dependent turns.
        state.cheatJitter = 0;
        if (!isServe) {
            const signedRandom = Math.random() * 2 - 1;
            const magnitude = cfg.cheat.minBounceVxJitter + Math.abs(signedRandom) *
                (cfg.cheat.maxBounceVxJitter - cfg.cheat.minBounceVxJitter);
            state.cheatJitter = (signedRandom < 0 ? -1 : 1) * magnitude;
        }
        state.hitterIndex = window.Net.getPlayerIndex();
        const identity = window.Net.sendBallHit({
            x: state.x, y: state.y, z: state.z,
            vx: state.vx, vy: state.vy, vz: state.vz,
            isServe: state.isServe,
            cheatJitter: state.cheatJitter, cheatActive: state.cheatActive
        });
        if (identity) Object.assign(state, identity);
        impact('racket');
        state.status = isServe ? 'serve' : 'hit';
        phase = 'flying';
    }

    function startOnline(isServer) {
        onlineMode = true;
        reset();
        phase = isServer ? 'waiting-serve' : 'waiting-remote';
        state.status = isServer ? 'ready-to-serve' : 'waiting-serve';
        state.visible = Boolean(isServer);
        state.roundId = window.Net.getRoundId();
    }

    function placeAtPaddle(paddle) {
        state.x = paddle.x;
        state.y = paddle.hitY;
        state.z = paddle.z;
    }

    function serve() {
        if (!onlineMode || phase !== 'waiting-serve') return false;
        const paddle = window.Paddle.getState();
        // Sample at confirmation, not at the preceding point's end. Players
        // may reposition or keep swinging while pressing the serve key.
        placeAtPaddle(paddle);
        const incoming = Object.assign({}, state, { vy: -paddle.returnSpeed });
        const shot = shots.planPlayerShot(incoming, paddle, { physicalResponse: false });
        if (!shot) {
            state.status = 'serve-unavailable';
            return false;
        }
        launch(shot, true);
        return true;
    }

    function applyRemoteHit(data) {
        if (!onlineMode || !data) return;
        state.visible = true;
        state.x = data.x; state.y = data.y; state.z = data.z;
        state.vx = data.vx; state.vy = data.vy; state.vz = data.vz;
        state.returnPlan = null;
        state.bounceCount = 0;
        state.lastShotByPlayer = false;
        state.isServe = Boolean(data.isServe);
        state.cheatActive = Boolean(data.cheatActive);
        state.cheatJitter = data.cheatJitter || 0;
        state.cheatBall = false;
        state.flightStep = 0;
        state.roundId = data.roundId; state.shotId = data.shotId;
        state.hitterIndex = data.playerIndex;
        state.pendingCorrection = null;
        impact('racket');
        state.status = state.isServe ? 'serve' : 'returning';
        phase = 'flying';
    }

    function applyBounceCorrection(data) {
        // Both clients start the same fixed-step flight on the hit packet.
        // If this snapshot is late, also repair the distance already travelled
        // sideways instead of only changing the next frame's velocity.
        const stepsSinceBounce = Math.max(0, state.flightStep - data.bounceStep);
        state.x = data.x + data.vx * stepsSinceBounce * physics.fixedStep;
        state.vx = data.vx;
        state.cheatBall = state.cheatActive && !state.isServe && Boolean(data.cheatBall);
    }

    function applyRemoteCorrection(data) {
        if (!onlineMode || !data || data.roundId !== state.roundId ||
                data.shotId !== state.shotId || state.lastShotByPlayer ||
                data.bounceCount !== 1 || !Number.isInteger(data.bounceStep) ||
                data.bounceStep < 1 || !Number.isFinite(data.x) ||
                !Number.isFinite(data.vx)) return;
        if (state.bounceCount >= 1) {
            applyBounceCorrection(data);
        } else {
            state.pendingCorrection = data;
        }
    }

    function syncCheat() {
        const active = window.CheatMode.isActive();
        if (state.lastShotByPlayer) {
            state.cheatActive = active;
            if (!active) state.cheatBall = false;
        }
        if (onlineMode) window.Net.sendCheatState(active);
    }

    function applyRemoteCheat(data) {
        if (!onlineMode || !data || data.roundId !== state.roundId ||
                data.playerIndex !== state.hitterIndex) return;
        state.cheatActive = Boolean(data.active);
        if (!state.cheatActive) state.cheatBall = false;
    }

    function update(dt) {
        if (!onlineMode || !(dt > 0) || !Number.isFinite(dt)) return;
        if (phase === 'waiting-serve') {
            placeAtPaddle(window.Paddle.getState());
            return;
        }
        if (phase !== 'flying') return;
        const previous = { x: state.x, y: state.y, z: state.z };
        state.flightStep += 1;
        state.vz -= physics.gravity * dt;
        state.x += state.vx * dt;
        state.y += state.vy * dt;
        state.z += state.vz * dt;

        if ((previous.y < netY && state.y >= netY) ||
                (previous.y > netY && state.y <= netY)) {
            const t = (netY - previous.y) / (state.y - previous.y);
            const x = previous.x + (state.x - previous.x) * t;
            const z = previous.z + (state.z - previous.z) * t;
            if (Math.abs(x) <= table.width / 2 + state.radius &&
                    z - state.radius <= table.height + table.netHeight) {
                impact('net');
                finishRound('net-hit');
                return;
            }
        }

        const withinTable = Math.abs(state.x) <= table.width / 2 - state.radius &&
            state.y >= table.nearY + state.radius && state.y <= farY - state.radius;
        if (state.vz < 0 && previous.z >= contactZ && state.z <= contactZ + 1e-9) {
            if (withinTable) {
                const receiverHalf = state.lastShotByPlayer ? state.y > netY : state.y < netY;
                if (state.bounceCount === 0 && !receiverHalf) {
                    finishRound('wrong-half');
                    return;
                }
                state.z = contactZ;
                state.vz = -state.vz * physics.tableRestitution;
                state.bounceCount += 1;
                impact('table');
                if (state.bounceCount > 1) {
                    finishRound('double-bounce');
                    return;
                }
                if (!state.isServe && state.cheatActive && receiverHalf) {
                    state.vx = Math.max(-cfg.cheat.maxLateralVx,
                        Math.min(cfg.cheat.maxLateralVx, state.vx + state.cheatJitter));
                    state.cheatBall = true;
                }
                if (state.pendingCorrection && state.pendingCorrection.bounceCount === state.bounceCount) {
                    applyBounceCorrection(state.pendingCorrection);
                    state.pendingCorrection = null;
                }
                // The hitter is authoritative for the selected bounce. The
                // receiver queues this snapshot if its local clock is behind.
                if (state.lastShotByPlayer && state.bounceCount === 1) {
                    window.Net.sendBallCorrection({ x: state.x, vx: state.vx,
                        cheatBall: state.cheatBall, bounceCount: state.bounceCount,
                        bounceStep: state.flightStep });
                }
            } else if (state.bounceCount === 0) {
                finishRound('out');
                return;
            }
        }

        // A real paddle contact is required. Hitting an incoming ball before
        // its legal table bounce loses the point; each return resets the count.
        if (!state.lastShotByPlayer && state.vy < 0) {
            const paddle = window.Paddle.getState();
            const contact = shots.findPaddleContact(previous, state, paddle);
            if (contact) {
                if (state.bounceCount !== 1) {
                    finishRound('volley');
                    return;
                }
                state.x = contact.x; state.y = contact.y; state.z = contact.z;
                const shot = shots.planPlayerShot(state, contact.paddle);
                if (!shot) return finishRound('unreachable');
                state.lastPlayerShotAngle = shot.angle;
                state.paddleHitCount += 1;
                launch(shot, false);
            }
        }

        if (state.z <= state.radius || state.y < -cfg.camera.distance + 0.1 ||
                Math.abs(state.x) > 20 || state.y > farY + 30) {
            finishRound(state.bounceCount ? 'missed' : 'out');
        }
    }

    function stopOnline() { onlineMode = false; reset(); }
    function getState() { return Object.assign({ phase }, state); }
    reset();
    return Object.freeze({ update, getState, reset, startOnline, stopOnline, serve,
        applyRemoteHit, applyRemoteCorrection, applyRemoteCheat, syncCheat,
        onImpact(listener) { impactListeners.add(listener); return () => impactListeners.delete(listener); } });
})();
