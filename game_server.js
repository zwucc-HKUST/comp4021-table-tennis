const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 8000;
const WINNING_SCORE = 5;
const MATCH_DURATION_MS = 180000;

function createGameServer(options = {}) {
    const app = express();
    const httpServer = http.createServer(app);
    const io = new Server(httpServer);
    const rooms = new Map();
    app.use(express.static(path.join(__dirname, 'public')));
    const winningScore = options.winningScore || WINNING_SCORE;
    const durationMs = options.durationMs || MATCH_DURATION_MS;

    function roomFor(socket) { return rooms.get(socket.data.roomId); }
    function names(room) {
        return room.players.map(id => io.sockets.sockets.get(id)?.data.username || 'Player');
    }
    function rankings(room) {
        return names(room).map((username, playerIndex) => ({
            username, playerIndex, score: room.scores[playerIndex],
            returns: room.hits[playerIndex], serves: room.serves[playerIndex],
            faults: room.faults[playerIndex]
        })).sort((a, b) => b.score - a.score).map((row, i, rows) => ({
            ...row, rank: i && row.score === rows[i - 1].score ? 1 : i + 1
        }));
    }
    function matchStats(room) {
        return {
            durationMs: room.startedAt === null ? 0 : Math.max(0,
                Math.min(room.endedAt ?? Date.now(), room.endsAt) - room.startedAt),
            totalRallies: room.totalRallies,
            // A time limit can end a long rally without awarding its point.
            longestRally: Math.max(room.longestRally, room.rallyReturns)
        };
    }
    function matchData(room) {
        return { roomId: room.id, names: names(room), scores: room.scores.slice(),
            rankings: rankings(room), roundId: room.roundId,
            winningScore, endsAt: room.endsAt, matchStats: matchStats(room) };
    }
    function resetStats(room) {
        room.scores = [0, 0]; room.hits = [0, 0]; room.cheats = [false, false];
        room.serves = [0, 0]; room.faults = [0, 0];
        room.totalRallies = 0; room.longestRally = 0;
        room.startedAt = null; room.endedAt = null; room.endsAt = null;
    }
    function endMatch(room) {
        room.endedAt = Math.min(Date.now(), room.endsAt);
        room.started = false;
        clearTimeout(room.timer);
    }
    function resetRound(room) {
        room.roundId += 1;
        room.shotId = 0;
        room.lastHitter = null;
        room.rallyReturns = 0;
        room.expectedSocket = room.players[room.nextServer];
    }
    function startMatch(room, restart = false) {
        clearTimeout(room.timer);
        resetStats(room);
        room.nextServer = 0; room.started = true;
        resetRound(room);
        room.startedAt = Date.now();
        room.endsAt = room.startedAt + durationMs;
        room.timer = setTimeout(() => {
            if (!room.started) return;
            endMatch(room);
            const winnerIndex = room.scores[0] === room.scores[1] ? null :
                (room.scores[0] > room.scores[1] ? 0 : 1);
            io.to(room.id).emit('game_over', { ...matchData(room),
                winnerIndex, reason: 'time-limit' });
        }, durationMs);
        io.to(room.id).emit('game_start', { ...matchData(room),
            serverTime: Date.now(),
            players: room.players.slice(),
            playerIndexById: Object.fromEntries(room.players.map((id, index) => [id, index])),
            serverId: room.players[room.nextServer], restart });
    }
    function awardPoint(room, loserIndex, reason) {
        const winnerIndex = 1 - loserIndex;
        const rallyReturns = room.rallyReturns;
        room.scores[winnerIndex] += 1;
        room.faults[loserIndex] += 1;
        room.totalRallies += 1;
        room.longestRally = Math.max(room.longestRally, rallyReturns);
        const gameOver = room.scores[winnerIndex] >= winningScore;
        // Service changes every two points in this first-to-five game.
        room.nextServer = Math.floor((room.scores[0] + room.scores[1]) / 2) % 2;
        resetRound(room);
        if (gameOver) endMatch(room);
        io.to(room.id).emit('point_awarded', { ...matchData(room),
            winnerIndex, loserIndex, reason, rallyReturns,
            nextServerIndex: room.nextServer, gameOver });
    }
    function leaveRoom(socket) {
        const room = roomFor(socket);
        if (!room) return;
        const index = room.players.indexOf(socket.id);
        if (index !== -1) room.players.splice(index, 1);
        socket.leave(room.id);
        delete socket.data.roomId; delete socket.data.playerIndex;
        clearTimeout(room.timer);
        room.started = false;
        if (!room.players.length) { rooms.delete(room.id); return; }
        resetStats(room);
        room.nextServer = 0;
        resetRound(room);
        const remaining = io.sockets.sockets.get(room.players[0]);
        if (remaining) remaining.data.playerIndex = 0;
        io.to(room.id).emit('opponent_left', {
            roomId: room.id, roundId: room.roundId, names: names(room)
        });
    }
    function makeRoomId() {
        let roomId;
        do { roomId = crypto.randomBytes(3).toString('hex').toUpperCase(); }
        while (rooms.has(roomId));
        return roomId;
    }
    function usernameFrom(payload) {
        if (!payload || typeof payload.username !== 'string') return null;
        const value = payload.username.trim();
        return value.length >= 2 && value.length <= 20 && !/[\u0000-\u001f<>]/.test(value)
            ? value : null;
    }
    function validNumber(value, minimum, maximum) {
        return Number.isFinite(value) && value >= minimum && value <= maximum;
    }
    function validBall(data) {
        return data && validNumber(data.x, -10, 10) && validNumber(data.y, -10, 10) &&
            validNumber(data.z, 0, 10) && validNumber(data.vx, -20, 20) &&
            validNumber(data.vy, -20, 20) && validNumber(data.vz, -20, 20) &&
            validNumber(data.cheatJitter || 0, -4.4, 4.4);
    }
    function current(room, data) {
        return room && room.started && data &&
            (data.roomId === undefined || data.roomId === room.id) &&
            data.roundId === room.roundId && data.shotId === room.shotId;
    }
    function joinError(socket, payload, message) {
        // Keep the original string argument for existing consumers.
        socket.emit('join_error', message, { requestId: payload?.requestId || 0 });
    }

    io.on('connection', socket => {
        // Clock/RTT sampling is independent of login, rooms, and gameplay.
        socket.on('latency_ping', acknowledge => {
            if (typeof acknowledge === 'function') acknowledge({ serverTime: Date.now() });
        });
        socket.on('create_room', payload => {
            const username = usernameFrom(payload);
            if (!username) return joinError(socket, payload, 'Please log in with a valid username.');
            leaveRoom(socket);
            socket.data.username = username;
            const room = { id: makeRoomId(), players: [socket.id], scores: [0, 0],
                hits: [0, 0], cheats: [false, false], roundId: 0, shotId: 0,
                started: false, nextServer: 0, expectedSocket: null,
                lastHitter: null, timer: null, endsAt: null };
            resetStats(room);
            rooms.set(room.id, room);
            socket.join(room.id);
            socket.data.roomId = room.id; socket.data.playerIndex = 0;
            socket.emit('room_created', { roomId: room.id, playerIndex: 0,
                names: [username], requestId: payload.requestId || 0 });
        });
        socket.on('join_room', payload => {
            const username = usernameFrom(payload);
            if (!username) return joinError(socket, payload, 'Please log in with a valid username.');
            const roomId = typeof payload.roomId === 'string' ? payload.roomId.trim().toUpperCase() : '';
            const room = rooms.get(roomId);
            if (!room) return joinError(socket, payload, 'Room not found. Check the room code.');
            if (socket.data.roomId === roomId) return joinError(socket, payload, 'You are already in this room.');
            if (room.players.length >= 2 || room.started) return joinError(socket, payload, 'This room is full.');
            if (names(room).some(name => name.toLowerCase() === username.toLowerCase())) {
                return joinError(socket, payload, 'This username is already in the room. Log in as another player.');
            }
            leaveRoom(socket);
            socket.data.username = username;
            const playerIndex = room.players.length;
            room.players.push(socket.id);
            socket.join(roomId);
            socket.data.roomId = roomId; socket.data.playerIndex = playerIndex;
            socket.emit('room_joined', { roomId, playerIndex, names: names(room),
                requestId: payload.requestId || 0 });
            startMatch(room);
        });
        socket.on('paddle_move', data => {
            const room = roomFor(socket);
            if (!room || !room.started || !data ||
                    (data.roomId !== undefined && data.roomId !== room.id) ||
                    (data.roundId !== undefined && data.roundId !== room.roundId) ||
                    !validNumber(data.x, -1, 1) || !validNumber(data.y, 0, 5)) return;
            socket.to(room.id).emit('opponent_paddle', {
                x: data.x, y: data.y, playerIndex: socket.data.playerIndex,
                roomId: room.id, roundId: room.roundId
            });
        });
        socket.on('ball_hit', data => {
            const room = roomFor(socket);
            if (!room || !room.started || !validBall(data) ||
                    (data.roomId !== undefined && data.roomId !== room.id) ||
                    data.roundId !== room.roundId || data.shotId !== room.shotId + 1) return;
            // A duplicate packet keeps the old sequence and is ignored above.
            // A second distinct contact by the same player is a double hit.
            if (room.lastHitter === socket.id) {
                awardPoint(room, socket.data.playerIndex, 'double-hit');
                return;
            }
            if (room.expectedSocket !== socket.id ||
                    Boolean(data.isServe) !== (room.shotId === 0)) return;
            room.shotId = data.shotId;
            room.lastHitter = socket.id;
            room.expectedSocket = room.players[1 - socket.data.playerIndex];
            room.cheats[socket.data.playerIndex] = Boolean(data.cheatActive);
            if (data.isServe) room.serves[socket.data.playerIndex] += 1;
            else {
                room.hits[socket.data.playerIndex] += 1;
                room.rallyReturns += 1;
            }
            socket.to(room.id).emit('ball_hit', {
                x: data.x, y: data.y, z: data.z, vx: data.vx, vy: data.vy, vz: data.vz,
                roomId: room.id, roundId: room.roundId, shotId: room.shotId,
                isServe: Boolean(data.isServe),
                cheatJitter: data.isServe ? 0 : (data.cheatJitter || 0),
                cheatActive: Boolean(data.cheatActive), playerIndex: socket.data.playerIndex
            });
        });
        socket.on('ball_correction', data => {
            const room = roomFor(socket);
            if (!current(room, data) || room.lastHitter !== socket.id ||
                    !validNumber(data.vx, -20, 20) || !validNumber(data.x, -10, 10) ||
                    data.bounceCount !== 1 || !Number.isInteger(data.bounceStep) ||
                    data.bounceStep < 1 || data.bounceStep > 36000) return;
            socket.to(room.id).emit('ball_correction', {
                x: data.x, vx: data.vx, cheatBall: Boolean(data.cheatBall),
                bounceCount: data.bounceCount, bounceStep: data.bounceStep,
                roomId: room.id, roundId: room.roundId, shotId: room.shotId
            });
        });
        socket.on('cheat_state', data => {
            const room = roomFor(socket);
            if (!room || !room.started || !data || data.roundId !== room.roundId ||
                    (data.roomId !== undefined && data.roomId !== room.id)) return;
            room.cheats[socket.data.playerIndex] = Boolean(data.active);
            socket.to(room.id).emit('cheat_state', {
                active: Boolean(data.active), playerIndex: socket.data.playerIndex,
                roomId: room.id, roundId: room.roundId
            });
        });
        socket.on('rally_lost', data => {
            const room = roomFor(socket);
            if (!current(room, data) || room.expectedSocket !== socket.id) return;
            const receiverFaults = ['missed', 'double-bounce', 'volley', 'double-hit', 'unreachable'];
            const hitterFaults = ['net-hit', 'out', 'wrong-half'];
            let loserIndex;
            if (receiverFaults.includes(data.reason)) loserIndex = socket.data.playerIndex;
            else if (hitterFaults.includes(data.reason) && room.lastHitter) {
                loserIndex = room.players.indexOf(room.lastHitter);
            } else return;
            if (room.shotId === 0 && data.reason !== 'unreachable') return;
            awardPoint(room, loserIndex, data.reason);
        });
        socket.on('restart_match', data => {
            const room = roomFor(socket);
            if (room && room.players.length === 2 && !room.started &&
                    (!data || ((data.roomId === undefined || data.roomId === room.id) &&
                        (data.roundId === undefined || data.roundId === room.roundId)))) startMatch(room, true);
        });
        socket.on('leave_room', () => leaveRoom(socket));
        socket.on('disconnect', () => leaveRoom(socket));
    });

    return { app, httpServer, io, rooms,
        listen(port = PORT) {
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, () => {
                    httpServer.off('error', reject);
                    resolve(httpServer.address().port);
                });
            });
        },
        close() {
            rooms.forEach(room => clearTimeout(room.timer));
            return new Promise(resolve => io.close(resolve));
        }
    };
}
if (require.main === module) {
    createGameServer().listen().then(port => {
        console.log(`Table Tennis Simulator is ready at http://localhost:${port}`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createGameServer };
