// Transport owns room identity and translates both first-person court views.
window.Net = (function() {
    const cfg = window.GameConfig;
    const socket = typeof window.io === 'function'
        ? window.io({ transports: ['websocket'] }) : null;
    const depthAxis = cfg.table.nearY * 2 + cfg.table.length;
    let callbacks = {};
    let roomId = null;
    let playerIndex = null;
    let roundId = 0;
    let shotId = 0;
    let inGame = false;
    let opponentPaddle = null;
    let lastPaddleSentAt = -Infinity;
    let requestSequence = 0;
    let pendingRequestId = 0;
    let queuedRequest = null;
    let latency = null;
    let serverEpoch = null;
    let serverSampleAt = 0;
    let latencyTimer = null;
    let connectionGeneration = 0;
    let pingPending = false;
    let disposed = false;
    const listeners = new Map();
    const LATENCY_INTERVAL_MS = 5000;
    const LATENCY_TIMEOUT_MS = 4000;

    function transform(data) {
        const result = Object.assign({}, data);
        if (playerIndex !== 1) return result;
        if (Number.isFinite(result.x)) result.x = -result.x;
        if (Number.isFinite(result.y)) result.y = depthAxis - result.y;
        if (Number.isFinite(result.vx)) result.vx = -result.vx;
        if (Number.isFinite(result.vy)) result.vy = -result.vy;
        if (Number.isFinite(result.cheatJitter)) result.cheatJitter = -result.cheatJitter;
        return result;
    }
    function call(name, ...args) { if (callbacks[name]) callbacks[name](...args); }
    function on(event, handler) {
        if (socket) { listeners.set(event, handler); socket.on(event, handler); }
    }
    function emit(event, data) { if (socket && !disposed) socket.emit(event, data); }
    function monotonicNow() {
        return window.performance ? window.performance.now() : Date.now();
    }
    function stopLatency() {
        clearInterval(latencyTimer);
        latencyTimer = null;
        connectionGeneration += 1;
        pingPending = false;
        latency = null; serverEpoch = null;
    }
    function sampleLatency() {
        if (disposed || !socket || !socket.connected || pingPending) return;
        const generation = connectionGeneration;
        const sentAt = monotonicNow();
        pingPending = true;
        // Socket.IO removes this acknowledgement on timeout or disconnect.
        socket.timeout(LATENCY_TIMEOUT_MS).emit('latency_ping', (error, data) => {
            if (disposed || generation !== connectionGeneration || !socket.connected) return;
            pingPending = false;
            const rtt = monotonicNow() - sentAt;
            if (error || !data || !Number.isFinite(data.serverTime) ||
                    !Number.isFinite(rtt) || rtt < 0) return;
            latency = rtt;
            // The response was stamped near the midpoint of the round trip.
            serverEpoch = data.serverTime + rtt / 2;
            serverSampleAt = monotonicNow();
            call('onLatency', latency);
        });
    }
    function startLatency() {
        if (disposed || !socket || !socket.connected || latencyTimer !== null) return;
        latencyTimer = setInterval(sampleLatency, LATENCY_INTERVAL_MS);
        if (typeof latencyTimer.unref === 'function') latencyTimer.unref();
        sampleLatency();
    }
    function clearRoom() {
        roomId = null; playerIndex = null; inGame = false;
        opponentPaddle = null; roundId = 0; shotId = 0;
    }
    function current(data) {
        return inGame && sameRoom(data) && data.roundId === roundId && data.shotId === shotId;
    }
    function sameRoom(data) {
        return data && roomId && (data.roomId === undefined || data.roomId === roomId);
    }
    function cancelRequests() {
        pendingRequestId = 0; queuedRequest = null;
    }
    function requestRoom(event, data) {
        if (pendingRequestId) {
            // Keep the latest intent, but settle the current membership first.
            queuedRequest = { event, data };
            return;
        }
        queuedRequest = null;
        pendingRequestId = ++requestSequence;
        emit(event, Object.assign({}, data, { requestId: pendingRequestId }));
    }
    function flushRequest() {
        const queued = queuedRequest;
        queuedRequest = null;
        const user = queued && loggedIn();
        if (user) requestRoom(queued.event, Object.assign({}, queued.data, { username: user.username }));
    }
    function roomReply(data, created) {
        if (!data || !pendingRequestId || data.requestId !== pendingRequestId) return;
        if (!(window.Auth && window.Auth.getSession())) { leaveRoom(); return; }
        pendingRequestId = 0;
        clearRoom();
        roomId = data.roomId; playerIndex = data.playerIndex;
        call('onRoom', data, created);
        flushRequest();
    }

    on('connect', () => { startLatency(); call('onConnection', true); });
    on('connect_error', () => { stopLatency(); call('onConnection', false); });
    on('disconnect', () => {
        stopLatency(); cancelRequests(); clearRoom(); call('onConnection', false);
    });
    on('room_created', data => roomReply(data, true));
    on('room_joined', data => roomReply(data, false));
    on('join_error', (message, data) => {
        if (!pendingRequestId || (data && data.requestId !== pendingRequestId)) return;
        if (!(window.Auth && window.Auth.getSession())) { leaveRoom(); return; }
        pendingRequestId = 0;
        call('onError', message);
        flushRequest();
    });
    on('game_start', data => {
        if (!data || !roomId || data.roomId !== roomId ||
                !(window.Auth && window.Auth.getSession()) ||
                !Number.isInteger(data.roundId) || data.roundId <= roundId ||
                !data.playerIndexById || ![0, 1].includes(data.playerIndexById[socket.id])) return;
        // Before the first RTT sample, the start timestamp is a coarse clock sync.
        if (latency === null && Number.isFinite(data.serverTime)) {
            serverEpoch = data.serverTime;
            serverSampleAt = monotonicNow();
        }
        roomId = data.roomId;
        playerIndex = data.playerIndexById[socket.id];
        roundId = data.roundId; shotId = 0; inGame = true;
        lastPaddleSentAt = -Infinity;
        opponentPaddle = { x: -cfg.paddle.startX, y: depthAxis - cfg.paddle.startY };
        call('onGameStart', Object.assign({}, data, {
            playerIndex, isServer: data.serverId === socket.id
        }));
    });
    on('opponent_paddle', data => {
        if (!inGame || !sameRoom(data) ||
                (data.roundId !== undefined && data.roundId !== roundId)) return;
        opponentPaddle = transform(data);
        call('onOpponentPaddle', opponentPaddle);
    });
    on('ball_hit', data => {
        if (!inGame || !sameRoom(data) || data.roundId !== roundId ||
                !Number.isInteger(data.shotId) || data.shotId <= shotId) return;
        shotId = data.shotId;
        call('onBallHit', transform(data));
    });
    on('ball_correction', data => {
        if (current(data)) call('onBallCorrection', transform(data));
    });
    on('cheat_state', data => {
        if (inGame && sameRoom(data) && data.roundId === roundId) call('onCheatState', data);
    });
    on('point_awarded', data => {
        if (!inGame || !data || data.roomId !== roomId ||
                !Number.isInteger(data.roundId) || data.roundId <= roundId) return;
        roundId = data.roundId; shotId = 0;
        if (data.gameOver) inGame = false;
        call('onPoint', data);
    });
    on('game_over', data => {
        if (!inGame || !data || data.roomId !== roomId || data.roundId !== roundId) return;
        inGame = false;
        call('onGameOver', data);
    });
    on('opponent_left', data => {
        if (!data || !roomId || data.roomId !== roomId ||
                !Number.isInteger(data.roundId) || data.roundId <= roundId) return;
        inGame = false; shotId = 0; opponentPaddle = null;
        // Keep the surviving player's room available for a replacement.
        roomId = data.roomId; playerIndex = 0; roundId = data.roundId;
        call('onOpponentLeft', data);
    });

    function loggedIn() {
        const session = window.Auth && window.Auth.getSession();
        if (!session) { call('onError', 'Please log in before creating or joining a room.'); return null; }
        if (disposed || !socket || !socket.connected) {
            call('onError', 'The server is not connected. Start the server and try again.');
            return null;
        }
        return session;
    }
    function connect(handlers) {
        if (disposed) return;
        callbacks = handlers || {};
        call('onConnection', Boolean(socket && socket.connected));
        if (latency !== null) call('onLatency', latency);
        startLatency();
    }
    function createRoom() {
        const user = loggedIn();
        if (user) {
            requestRoom('create_room', { username: user.username });
        }
    }
    function joinRoom(code) {
        const user = loggedIn();
        if (user) {
            requestRoom('join_room', { roomId: code, username: user.username });
        }
    }
    function sendPaddle(x, y) {
        if (!inGame) return;
        const now = monotonicNow();
        if (now - lastPaddleSentAt < 45) return;
        lastPaddleSentAt = now;
        emit('paddle_move', transform({ x, y, roomId, roundId }));
    }
    function sendBallHit(data) {
        if (!inGame) return null;
        shotId += 1;
        const identity = { roundId, shotId };
        emit('ball_hit', transform(Object.assign({}, data, identity, { roomId })));
        return identity;
    }
    function sendBallCorrection(data) {
        if (inGame) emit('ball_correction', transform(Object.assign({}, data, { roomId, roundId, shotId })));
    }
    function sendCheatState(active) {
        if (inGame) emit('cheat_state', { active: Boolean(active), roomId, roundId });
    }
    function reportMiss(reason) {
        if (inGame) emit('rally_lost', { roomId, roundId, shotId, reason: reason || 'missed' });
    }
    function restartMatch() { if (roomId) emit('restart_match', { roomId, roundId }); }
    function leaveRoom() {
        // A create/join may already have reached the server while its reply is
        // still in flight. Ordered Socket.IO delivery makes this cancel it too.
        emit('leave_room');
        cancelRequests();
        clearRoom();
    }
    function destroy() {
        if (disposed) return;
        disposed = true;
        stopLatency(); cancelRequests(); clearRoom(); callbacks = {};
        if (socket) {
            listeners.forEach((handler, event) => socket.off(event, handler));
            listeners.clear();
            socket.disconnect();
        }
    }

    return Object.freeze({ connect, createRoom, joinRoom, sendPaddle,
        sendBallHit, sendBallCorrection, sendCheatState, reportMiss, restartMatch, leaveRoom, destroy,
        getLatency: () => latency,
        getServerNow: () => serverEpoch === null ? Date.now() :
            serverEpoch + monotonicNow() - serverSampleAt,
        getRoomId: () => roomId, getPlayerIndex: () => playerIndex,
        getRoundId: () => roundId, getShotId: () => shotId,
        getOpponentPaddle: () => opponentPaddle, isInGame: () => inGame });
})();
