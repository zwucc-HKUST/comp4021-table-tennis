// Page lifecycle, adapted from the lab game-room form and Socket.IO patterns.
// Auth, transport, physics, rendering and sound each retain their own module.
window.addEventListener('DOMContentLoaded', function() {
    const byId = id => document.getElementById(id);
    const ball = window.Ball;
    const paddle = window.Paddle;
    const net = window.Net;
    const cheat = window.CheatMode;
    const fixedStep = window.GameConfig.physics.fixedStep;
    const { flightRate, paddleRate } = window.GameConfig.pace;
    const paddleStep = fixedStep / flightRate * paddleRate;
    let inMatch = false;
    let connected = false;
    let hasConnected = false;
    let playerIndex = 0;
    let names = [];
    let endsAt = 0;
    let winningScore = 5;
    let previousTime = null;
    let accumulator = 0;
    let lastBallStatus = '';
    let serveKeyHeld = false;
    let pendingRoomRequest = null;
    let authPending = false;
    let roomRequestTimer = null;
    let lastHudKey = '';
    let lastSeconds = -1;
    let guideEnabled = true;
    const pointerKeys = new Map();
    const preferencesKey = 'table-tennis.preferences.v1';

    // Preferences are optional. Storage restrictions must not prevent a match.
    try {
        const saved = JSON.parse(localStorage.getItem(preferencesKey) || '{}');
        guideEnabled = saved.guide !== false;
        window.GameAudio.setMuted(saved.muted === true);
    } catch (_) {}

    function savePreferences() {
        try {
            localStorage.setItem(preferencesKey, JSON.stringify({
                guide: guideEnabled, muted: window.GameAudio.isMuted()
            }));
        } catch (_) {}
    }

    function updatePreferences() {
        const muted = window.GameAudio.isMuted();
        byId('audio-toggle').textContent = muted ? 'Sound off' : 'Sound on';
        byId('audio-toggle').setAttribute('aria-pressed', String(muted));
        byId('return-guide').textContent = guideEnabled ? 'Return guide on' : 'Return guide off';
        byId('return-guide').setAttribute('aria-pressed', String(guideEnabled));
        if (window.Renderer.setGuideEnabled) window.Renderer.setGuideEnabled(guideEnabled);
    }

    function finishRoomRequest() {
        clearTimeout(roomRequestTimer);
        roomRequestTimer = null;
        pendingRoomRequest = null;
        refreshAccount();
    }

    function restoreRoomRequestFocus(kind) {
        // Disabling a focused submit button can move keyboard focus to BODY.
        // Fast responses can leave it on the re-enabled submit button instead.
        // Handle both without interrupting someone typing or reading help.
        if (!kind || byId('lobby').hidden || byId('controls-dialog').open) return;
        const origin = byId(kind === 'join' ? 'join-room' : 'create-room');
        if (document.activeElement !== document.body && document.activeElement !== origin) return;
        const target = byId(kind === 'join' ? 'room-code' : 'create-room');
        if (!target.disabled && !target.hidden) target.focus();
    }

    function startRoomRequest(kind) {
        if (pendingRoomRequest || !connected || !window.Auth.getSession()) return false;
        pendingRoomRequest = kind;
        refreshAccount();
        message('room-status', kind === 'create' ? 'Setting up your table…' : 'Joining the table…');
        roomRequestTimer = setTimeout(() => {
            net.leaveRoom();
            finishRoomRequest();
            message('room-status', 'The room did not respond. Please try again.', true);
            restoreRoomRequestFocus(kind);
        }, 10000);
        return true;
    }

    function message(id, text, error = false) {
        const element = byId(id);
        element.textContent = text;
        element.classList.toggle('error', error);
    }

    function showPage(page) {
        const changed = document.body.dataset.page !== page;
        document.body.dataset.page = page;
        if (changed) window.scrollTo(0, 0);
        byId('home-page').hidden = page !== 'home';
        byId('game-page').hidden = page !== 'game';
        byId('match-result').hidden = page !== 'result';
    }

    function refreshAccount() {
        const session = window.Auth.getSession();
        byId('account-bar').hidden = !session;
        byId('account-name').textContent = session ? session.username : '';
        byId('auth-panel').hidden = Boolean(session);
        byId('lobby').hidden = !session;
        byId('create-room').disabled = !connected || !session || Boolean(pendingRoomRequest);
        byId('join-room').disabled = !connected || !session || Boolean(pendingRoomRequest);
        byId('join-form').setAttribute('aria-busy', String(Boolean(pendingRoomRequest)));
    }

    function showRoom(roomId) {
        byId('waiting-room').hidden = !roomId;
        byId('current-room-code').textContent = roomId || '';
        byId('copy-status').textContent = '';
        byId('create-room').hidden = Boolean(roomId);
        byId('join-form').hidden = Boolean(roomId);
        byId('room-code-hint').hidden = Boolean(roomId);
        document.querySelector('.lobby-divider').hidden = Boolean(roomId);
    }

    function focusHome(keepRoom = false) {
        const session = window.Auth.getSession();
        const target = session
            ? byId(keepRoom && net.getRoomId() ? 'copy-room-code' : 'create-room')
            : byId('login-username');
        // A disconnected lobby disables room actions. Its heading remains a
        // useful keyboard position, immediately before those actions.
        (target.disabled ? byId('lobby-title') : target).focus();
    }

    function stopGame() {
        inMatch = false;
        ball.stopOnline();
        paddle.setEnabled(false);
        cheat.setEnabled(false);
        window.Renderer.reset();
        accumulator = 0;
        lastBallStatus = '';
        lastHudKey = '';
        lastSeconds = -1;
        byId('match-feedback').hidden = true;
        releaseControls();
        if (byId('controls-dialog').open) byId('controls-dialog').close();
    }

    function goHome(text, keepRoom = false) {
        if (!keepRoom) net.leaveRoom();
        finishRoomRequest();
        stopGame();
        showPage('home');
        showRoom(keepRoom ? net.getRoomId() : null);
        refreshAccount();
        message('room-status', text || '');
        message('result-status', '');
        focusHome(keepRoom);
    }

    function setScores(scores) {
        byId('player-score').textContent = scores[playerIndex];
        byId('opponent-score').textContent = scores[1 - playerIndex];
        if (scores.some(score => score >= winningScore)) return;
        const matchPoints = scores.map(score => score === winningScore - 1);
        const deciding = matchPoints.every(Boolean);
        const text = deciding ? 'DECIDING POINT' : matchPoints.some(Boolean)
            ? 'MATCH POINT' : 'FIRST TO ' + winningScore;
        const label = byId('match-format');
        if (label.textContent !== text) {
            label.textContent = text;
            label.setAttribute('aria-label', deciding ? 'The next point wins the match' :
                matchPoints.some(Boolean) ? 'Match point for ' + names[matchPoints.indexOf(true)] : text);
        }
        label.classList.toggle('match-point', matchPoints.some(Boolean));
    }

    function showResult(data) {
        stopGame();
        if (data.names) names = data.names;
        const tie = data.winnerIndex === null;
        byId('result-title').textContent = tie ? 'The match is a draw' :
            data.winnerIndex === playerIndex ? 'You won the match' : names[data.winnerIndex] + ' won the match';
        byId('result-score').textContent = data.scores[playerIndex] + ' : ' + data.scores[1 - playerIndex];
        byId('match-result').dataset.outcome = tie ? 'draw' : (data.winnerIndex === playerIndex ? 'win' : 'loss');
        byId('result-detail').textContent = names[playerIndex] + ' vs ' + names[1 - playerIndex];
        byId('result-reason').textContent = data.reason === 'time-limit'
            ? (tie ? 'Time is up with the scores level.' : 'Time is up. The higher score takes the match.')
            : 'First to ' + (data.winningScore || 5) + ' points takes the match.';
        const stats = data.matchStats || {};
        const duration = Math.round((stats.durationMs || 0) / 1000);
        byId('result-duration').textContent = Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0');
        byId('result-longest-rally').textContent = stats.longestRally || 0;
        byId('result-total-rallies').textContent = stats.totalRallies || 0;
        const body = byId('result-ranking');
        body.replaceChildren();
        const rankings = data.rankings || data.scores.map((score, index) => ({
            username: names[index], score, returns: 0
        })).sort((a, b) => b.score - a.score);
        rankings.forEach((entry, index) => {
            const row = document.createElement('tr');
            if (entry.playerIndex === playerIndex) row.classList.add('your-result');
            [entry.rank || (tie ? 1 : index + 1), entry.username, entry.score,
                entry.returns || 0, entry.serves || 0, entry.faults || 0].forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
            });
            body.appendChild(row);
        });
        byId('restart-match').disabled = false;
        message('result-status', 'Play again starts a new match for both players in this room.');
        showPage('result');
        byId('result-title').focus();
    }

    function beginPoint(serving) {
        lastBallStatus = '';
        accumulator = 0;
        previousTime = performance.now();
        lastHudKey = '';
        ball.startOnline(serving);
        byId('player-serving').hidden = !serving;
        byId('opponent-serving').hidden = serving;
        byId('player-score-card').classList.toggle('serving', serving);
        byId('opponent-score-card').classList.toggle('serving', !serving);
        message('match-status', serving
            ? 'Your serve · Move with WASD, press Space when ready'
            : 'Opponent’s serve · Line up with WASD');

    }

    function pointFeedback(data) {
        const won = data.winnerIndex === playerIndex;
        const loser = won ? 'Your opponent' : 'You';
        const faults = {
            'net-hit': 'hit the net', out: 'sent the ball out',
            'wrong-half': 'landed on the wrong half', missed: 'missed the racket’s contact zone',
            'double-bounce': 'let the ball bounce twice', volley: 'touched the ball before its first bounce',
            'double-hit': 'hit the ball twice', unreachable: 'made contact but could not make a legal return'
        };
        const reason = faults[data.reason];
        const text = (won ? 'Your point.' : 'Opponent’s point.') +
            (reason ? ' ' + loser + ' ' + reason + '.' : '') +
            (data.rallyReturns > 1 ? ' ' + data.rallyReturns + '-return rally.' : '');
        const feedback = byId('match-feedback');
        feedback.dataset.tone = won ? 'won' : 'lost';
        feedback.textContent = text;
        feedback.hidden = false;
    }

    // Listeners are installed once. Remote events never create another loop.
    net.connect({
        onConnection(value) {
            const wasPlaying = inMatch || !byId('match-result').hidden;
            const wasWaiting = !byId('waiting-room').hidden;
            connected = value;
            byId('connection-status').textContent = value ? 'Connected · ready for a match' :
                hasConnected ? 'Connection lost · reconnecting…' : 'Connecting to the club…';
            if (value) hasConnected = true;
            byId('connection-status').classList.toggle('connected', value);
            if (!value) {
                if (byId('latency-status')) byId('latency-status').textContent = '';
                finishRoomRequest();
                stopGame();
                showRoom(null);
                showPage('home');
                if (wasPlaying || wasWaiting) message('room-status', 'Connection lost. Create or join a room again.', true);
            }
            refreshAccount();
            if (!value && (wasPlaying || wasWaiting)) focusHome();
        },
        onLatency(ms) {
            const label = byId('latency-status');
            if (!label) return;
            label.textContent = Number.isFinite(ms) ? Math.round(ms) + ' ms' : '';
            label.title = Number.isFinite(ms) ? 'Round-trip connection time' : '';
        },
        onRoom(data) {
            finishRoomRequest();
            showPage('home');
            showRoom(data.roomId);
            byId('room-code').value = '';
            message('room-status', 'Share this code with the other player.');
            byId('copy-room-code').focus({ preventScroll: true });
        },
        onError(text) {
            const requestKind = pendingRoomRequest;
            finishRoomRequest();
            message(byId('match-result').hidden ? 'room-status' : 'result-status', text, true);
            byId('restart-match').disabled = false;
            restoreRoomRequestFocus(requestKind);
        },
        onGameStart(data) {
            finishRoomRequest();
            stopGame();
            inMatch = true;
            playerIndex = data.playerIndex;
            names = data.names;
            endsAt = data.endsAt;
            winningScore = data.winningScore || 5;
            paddle.reset();
            paddle.setEnabled(true);
            cheat.setEnabled(true);
            cheat.setKeyboardEnabled(true);
            byId('player-name').textContent = names[playerIndex];
            byId('opponent-name').textContent = names[1 - playerIndex];
            byId('match-room-code').textContent = data.roomId;
            setScores(data.scores);
            showPage('game');
            byId('game-canvas').focus({ preventScroll: true });
            beginPoint(data.isServer);
        },
        onBallHit(data) {
            if (!inMatch) return;
            // The incoming snapshot starts a new flight at receipt. A hidden
            // tab may not have had a timer tick for a second; that old elapsed
            // time belongs to the previous shot, not to this fresh packet.
            previousTime = performance.now();
            accumulator = 0;
            ball.applyRemoteHit(data);
            if (data.isServe) byId('match-feedback').hidden = true;
        },
        onBallCorrection(data) { if (inMatch) ball.applyRemoteCorrection(data); },
        onCheatState(data) { if (inMatch) ball.applyRemoteCheat(data); },
        onPoint(data) {
            setScores(data.scores);
            if (data.gameOver) return showResult(data);
            beginPoint(data.nextServerIndex === playerIndex);
            pointFeedback(data);
        },
        onGameOver: showResult,
        onOpponentLeft() {
            goHome('Your opponent left. Share the room code to invite a new player.', true);
        }
    });

    function setAuthPending(pending) {
        authPending = pending;
        // Both forms share one session. A registration may be waiting for
        // another tab's lock, so no second login/register may overtake it.
        document.querySelectorAll('#auth-panel input, #auth-panel button').forEach(control => {
            control.disabled = pending;
        });
        ['login', 'register'].forEach(mode => {
            byId(mode + '-form').setAttribute('aria-busy', String(pending));
        });
    }

    function authTab(mode) {
        if (authPending) return;
        const login = mode === 'login';
        byId('login-form').hidden = !login;
        byId('register-form').hidden = login;
        byId('login-tab').setAttribute('aria-selected', String(login));
        byId('register-tab').setAttribute('aria-selected', String(!login));
        byId('login-tab').tabIndex = login ? 0 : -1;
        byId('register-tab').tabIndex = login ? -1 : 0;
        message('auth-status', '');
    }
    byId('login-tab').addEventListener('click', () => authTab('login'));
    byId('register-tab').addEventListener('click', () => authTab('register'));
    ['login', 'register'].forEach(mode => {
        byId(mode + '-tab').addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            if (authPending) return;
            const next = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' :
                mode === 'login' ? 'register' : 'login';
            authTab(next);
            byId(next + '-tab').focus();
        });
    });
    ['login', 'register'].forEach(mode => {
        byId(mode + '-form').addEventListener('submit', async function(event) {
            event.preventDefault();
            if (authPending) return;
            const focusedControl = this.contains(document.activeElement) ? document.activeElement : null;
            let failed = false;
            setAuthPending(true);
            message('auth-status', mode === 'register' ? 'Creating account…' : 'Signing in…');
            try {
                await window.Auth[mode](byId(mode + '-username').value, byId(mode + '-password').value);
                byId('login-password').value = '';
                byId('register-password').value = '';
                message('auth-status', '');
                refreshAccount();
                message('room-status', 'You are ready to create or join a room.');
                if (!byId('controls-dialog').open) byId('create-room').focus({ preventScroll: true });
            } catch (error) {
                failed = true;
                message('auth-status', error.message, true);
            } finally {
                setAuthPending(false);
                if (failed && focusedControl && !this.hidden && !byId('auth-panel').hidden &&
                        !byId('controls-dialog').open && document.activeElement === document.body) focusedControl.focus();
            }
        });
    });
    byId('logout').addEventListener('click', function() {
        goHome();
        try { window.Auth.logout(); }
        catch (error) {
            message(window.Auth.getSession() ? 'room-status' : 'auth-status', error.message, true);
            refreshAccount();
            return;
        }
        refreshAccount();
        authTab('login');
        byId('login-password').value = '';
        byId('register-password').value = '';
        byId('login-username').focus();
    });
    byId('copy-room-code').addEventListener('click', async function() {
        const code = byId('current-room-code').textContent;
        if (!code) return;
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error();
            await navigator.clipboard.writeText(code);
            message('copy-status', 'Room code copied. Send it to your friend.');
        } catch (_) {
            message('copy-status', 'Select and copy this room code: ' + code);
        }
    });
    byId('create-room').addEventListener('click', function() {
        if (!startRoomRequest('create')) return;
        window.GameAudio.unlock();
        net.createRoom();
    });
    byId('join-form').addEventListener('submit', function(event) {
        event.preventDefault();
        const code = byId('room-code').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) {
            message('room-status', 'Enter a six-character room code.', true);
            return;
        }
        if (!startRoomRequest('join')) return;
        window.GameAudio.unlock();
        net.joinRoom(code);
    });
    ['leave-room', 'return-lobby', 'cancel-room'].forEach(id => {
        byId(id).addEventListener('click', () => goHome('You left the room.'));
    });
    byId('restart-match').addEventListener('click', function() {
        window.GameAudio.unlock();
        this.disabled = true;
        message('result-status', 'Starting a new match…');
        net.restartMatch();
    });

    const controlsDialog = byId('controls-dialog');
    byId('help-button').addEventListener('click', () => {
        if (controlsDialog.open) return;
        paddle.setEnabled(false);
        cheat.setKeyboardEnabled(false);
        releaseControls();
        controlsDialog.showModal();
    });
    byId('close-controls').addEventListener('click', () => controlsDialog.close());
    controlsDialog.addEventListener('click', event => {
        if (event.target !== controlsDialog) return;
        const box = controlsDialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right ||
                event.clientY < box.top || event.clientY > box.bottom) controlsDialog.close();
    });
    controlsDialog.addEventListener('close', () => {
        paddle.setEnabled(inMatch);
        cheat.setKeyboardEnabled(true);
        if (inMatch) byId('game-canvas').focus({ preventScroll: true });
    });
    byId('audio-toggle').addEventListener('click', () => {
        window.GameAudio.setMuted(!window.GameAudio.isMuted());
        window.GameAudio.unlock();
        updatePreferences();
        savePreferences();
        if (inMatch) byId('game-canvas').focus({ preventScroll: true });
    });
    byId('return-guide').addEventListener('click', () => {
        guideEnabled = !guideEnabled;
        updatePreferences();
        savePreferences();
        byId('game-canvas').focus({ preventScroll: true });
    });
    byId('toggle-cheat').addEventListener('click', () => {
        if (!inMatch) return;
        cheat.toggle();
        byId('game-canvas').focus({ preventScroll: true });
    });

    function tryServe() {
        if (!inMatch || controlsDialog.open || ball.getState().phase !== 'waiting-serve') return;
        window.GameAudio.unlock();
        if (ball.serve()) {
            previousTime = performance.now();
            accumulator = 0;
            byId('match-feedback').hidden = true;
        }
    }
    byId('serve-button').addEventListener('click', () => {
        tryServe();
        byId('game-canvas').focus({ preventScroll: true });
    });

    function refreshPointerKey(code) {
        const down = Array.from(pointerKeys.values()).includes(code);
        paddle.setDirection(code, down);
        const button = document.querySelector('[data-move="' + code + '"]');
        if (button) button.classList.toggle('pressed', down);
    }
    document.querySelectorAll('[data-move]').forEach(button => {
        const code = button.dataset.move;
        button.addEventListener('pointerdown', event => {
            if (!inMatch || controlsDialog.open || event.button !== 0) return;
            event.preventDefault();
            button.setPointerCapture(event.pointerId);
            pointerKeys.set(event.pointerId, code);
            refreshPointerKey(code);
            window.GameAudio.unlock();
        });
        function release(event) {
            pointerKeys.delete(event.pointerId);
            refreshPointerKey(code);
        }
        button.addEventListener('pointerup', release);
        button.addEventListener('pointercancel', release);
        button.addEventListener('lostpointercapture', release);
        button.addEventListener('keydown', event => {
            if (!['Space', 'Enter'].includes(event.code) || !inMatch) return;
            event.preventDefault();
            pointerKeys.set('keyboard-' + code, code);
            refreshPointerKey(code);
        });
        button.addEventListener('keyup', event => {
            if (!['Space', 'Enter'].includes(event.code)) return;
            event.preventDefault();
            pointerKeys.delete('keyboard-' + code);
            refreshPointerKey(code);
        });
        button.addEventListener('blur', () => {
            pointerKeys.delete('keyboard-' + code);
            refreshPointerKey(code);
        });
    });
    function releaseControls() {
        pointerKeys.clear();
        document.querySelectorAll('[data-move]').forEach(button => button.classList.remove('pressed'));
        paddle.clearInput();
        serveKeyHeld = false;
    }
    window.addEventListener('keydown', function(event) {
        if (event.code !== 'Space') return;
        const target = event.target;
        const editing = target && (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName));
        if (!inMatch || controlsDialog.open || editing || event.ctrlKey || event.metaKey || event.altKey) return;
        // A fresh press is required. Holding Space through a scored point must
        // never launch the next serve or trigger another action in a rally.
        event.preventDefault();
        if (event.repeat || serveKeyHeld) return;
        serveKeyHeld = true;
        tryServe();
    });
    window.addEventListener('keyup', function(event) {
        if (event.code === 'Space') serveKeyHeld = false;
    });
    window.addEventListener('blur', releaseControls);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseControls();
    });
    cheat.onChange(() => ball.syncCheat());
    ball.onImpact((type, point) => {
        if (!inMatch) return;
        window.GameAudio.play(type);
        window.Renderer.addImpact(type, point);
    });
    paddle.setEnabled(false);
    cheat.setEnabled(false);
    refreshAccount();
    updatePreferences();
    authTab('login');
    showPage('home');

    function advancePhysics(now) {
        if (previousTime === null) previousTime = now;
        // Hidden tabs can receive timer callbacks only once per second. Keep
        // the same fixed steps when catching up instead of freezing the rally.
        const elapsed = Math.max(0, Math.min((now - previousTime) / 1000, 2));
        previousTime = now;
        if (!inMatch) return;
        // Match practice pacing while preserving the fixed flight steps used
        // by bounce corrections. The match countdown uses server time below.
        accumulator += elapsed * flightRate;
        while (accumulator >= fixedStep) {
            paddle.update(paddleStep);
            ball.update(fixedStep);
            accumulator -= fixedStep;
        }
    }

    function frame(now) {
        advancePhysics(now);
        if (inMatch) {
            const state = ball.getState();
            if (state.status !== lastBallStatus) {
                const labels = {
                    'ready-to-serve': 'Your serve · Move with WASD, press Space when ready',
                    'waiting-serve': 'Opponent’s serve · Line up with WASD',
                    'serve-unavailable': 'Cannot serve from here · Reposition with WASD, then press Space again',
                    serve: 'Serve in play · move to meet the ball',
                    returning: 'Receive the ball after one bounce',
                    hit: 'Return sent · get ready for the next ball',
                    'net-hit': 'Net hit · waiting for the score',
                    out: 'Ball out · waiting for the score',
                    missed: 'Ball missed the racket’s contact zone · waiting for the score',
                    'double-bounce': 'Double bounce · waiting for the score',
                    volley: 'Contact before the first bounce · waiting for the score',
                    'wrong-half': 'Wrong half · waiting for the score',
                    unreachable: 'Contact made, but no legal return · waiting for the score'
                };
                if (labels[state.status]) message('match-status', labels[state.status]);
                lastBallStatus = state.status;
            }
            const active = cheat.isActive();
            const rallyReturns = Math.max(0, net.getShotId() - 1);
            const hudKey = state.phase + ':' + active + ':' + rallyReturns;
            if (hudKey !== lastHudKey) {
                byId('cheat-status').textContent = active ? 'CHEAT ON · C to disable' : 'CHEAT OFF · C to enable';
                byId('cheat-status').classList.toggle('active', active);
                byId('toggle-cheat').setAttribute('aria-pressed', String(active));
                byId('toggle-cheat').textContent = active ? 'Cheat on · C' : 'Cheat off · C';
                byId('serve-button').disabled = state.phase !== 'waiting-serve';
                byId('rally-count').textContent = rallyReturns;
                lastHudKey = hudKey;
            }
            const serverNow = net.getServerNow ? net.getServerNow() : Date.now();
            const seconds = Math.max(0, Math.ceil((endsAt - serverNow) / 1000));
            if (seconds !== lastSeconds) {
                byId('match-time').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
                byId('match-time').classList.toggle('time-low', seconds <= 30);
                lastSeconds = seconds;
            }
            window.Renderer.render(state);
        }
        window.requestAnimationFrame(frame);
    }
    // requestAnimationFrame pauses in a background tab. This fallback shares
    // the same clock so visible and hidden callbacks never integrate twice.
    window.setInterval(() => {
        if (document.hidden && inMatch) advancePhysics(performance.now());
    }, 50);
    window.requestAnimationFrame(frame);
});
