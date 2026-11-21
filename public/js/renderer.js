window.Renderer = (function() {
    'use strict';
    const cfg = window.GameConfig;
    const project = window.Projection.project;
    const canvas = document.getElementById('game-canvas');
    let ctx = canvas.getContext('2d');
    const width = cfg.canvas.width, height = cfg.canvas.height;
    const halfWidth = cfg.table.width / 2;
    const nearY = cfg.table.nearY, farY = nearY + cfg.table.length;
    const netY = nearY + cfg.table.length / 2, tableZ = cfg.table.height;
    const cream = '#f2efdc', lime = '#d5e87e';
    const tableImpactDuration = 520;
    const motionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    const paddleImg = new Image();
    let isPaddleImgLoaded = false;
    let stage = null, netLayer = null, opponentPaddleDisplay = null, lastRenderTime = null;
    let rasterScale = 0;
    let guideEnabled = true, lastRound = null, lastPhase = null, incomingVelocity = 0;
    let guideCache = null;
    const impacts = [];
    paddleImg.onload = () => { isPaddleImgLoaded = true; };
    paddleImg.src = 'assets/paddle-match.svg';

    function reducedMotion() { return Boolean(motionQuery && motionQuery.matches); }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function point(x, y, z) { return project({ x, y, z }); }
    function validPoint(p) {
        return p && [p.x, p.y, p.z].every(Number.isFinite) && cfg.camera.distance + p.y > 0.1;
    }
    function path(points, closePath) {
        ctx.beginPath();
        points.forEach(function(p, i) {
            const q = point(p[0], p[1], p[2]);
            if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        if (closePath) ctx.closePath();
    }
    function polygon(points, color) { path(points, true); ctx.fillStyle = color; ctx.fill(); }
    function line(a, b, color, size) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = color; ctx.lineWidth = size; ctx.stroke();
    }
    function worldLine(a, b, color, size) { path([a, b], false); ctx.strokeStyle = color; ctx.lineWidth = size; ctx.stroke(); }

    function logicalTransform(context) {
        // Use the actual rounded backing dimensions, keeping all world/projection
        // math in the original 960 x 600 logical coordinate system.
        context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    }
    function syncResolution() {
        // Numeric check only: browser zoom/monitor changes need no layout reads
        // or listeners. Cap the three raster buffers at 2x (4x pixel storage).
        const dpr = window.devicePixelRatio;
        const next = Number.isFinite(dpr) ? clamp(dpr, 1, 2) : 1;
        if (next === rasterScale) return;
        rasterScale = next;
        canvas.width = Math.round(width * next);
        canvas.height = Math.round(height * next);
        logicalTransform(ctx);
        // Release old bitmap storage immediately; reset() keeps valid caches.
        if (stage) { stage.width = stage.height = 0; stage = null; }
        if (netLayer) { netLayer.width = netLayer.height = 0; netLayer = null; }
    }
    function createLayer() {
        const layer = document.createElement('canvas');
        layer.width = canvas.width; layer.height = canvas.height;
        logicalTransform(layer.getContext('2d'));
        return layer;
    }

    function drawBackdrop() {
        const wall = ctx.createLinearGradient(0, 0, 0, height);
        wall.addColorStop(0, '#10191d'); wall.addColorStop(.37, '#202f31'); wall.addColorStop(1, '#0d181d');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, width, height);
        // Quiet architectural rhythm: no moving scenery behind the ball.
        for (let x = 80; x < width; x += 160) {
            line({ x, y: 0 }, { x, y: 202 }, '#d7e0cd08', 1);
        }
        const pool = ctx.createRadialGradient(width / 2, 210, 20, width / 2, 260, 460);
        pool.addColorStop(0, '#8ba89b16'); pool.addColorStop(1, '#8ba89b00');
        ctx.fillStyle = pool; ctx.fillRect(0, 0, width, height);
        [152, width - 312].forEach(x => {
            ctx.save(); ctx.translate(x + 80, 80); ctx.scale(2.2, 1);
            const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 85);
            glow.addColorStop(0, '#f5ebc912'); glow.addColorStop(1, '#f5ebc900');
            ctx.fillStyle = glow; ctx.fillRect(-85, -85, 170, 170); ctx.restore();
            ctx.fillStyle = '#d9d8bd65'; ctx.fillRect(x, 73, 160, 2);
        });
        ctx.fillStyle = '#0b1418'; ctx.fillRect(0, 204, width, 18);
        line({ x: 0, y: 204 }, { x: width, y: 204 }, '#c9d8bc20', 1);
        ctx.textAlign = 'center'; ctx.font = '600 21px sans-serif';
        ctx.fillStyle = '#e5e8d52d'; ctx.fillText('T H E  C L U B', width / 2, 155);
        ctx.font = '9px sans-serif'; ctx.fillStyle = '#cad6cb40';
        ctx.fillText('T A B L E   T E N N I S   C L U B', width / 2, 175);
        const floor = ctx.createLinearGradient(0, 222, 0, height);
        floor.addColorStop(0, '#223135'); floor.addColorStop(1, '#101d23');
        ctx.fillStyle = floor; ctx.fillRect(0, 222, width, height - 222);
        // Court boundaries are projected on the floor, like the table itself.
        [-1.65, 1.65].forEach(x => {
            worldLine([x, .4, .001], [x, 9, .001], '#c8d7bc19', 2);
            worldLine([x * 1.04, .4, .001], [x * 1.04, 9, .001], '#050e141c', 1);
        });
        worldLine([-1.65, 6, .001], [1.65, 6, .001], '#c8d7bc19', 2);
        const vignette = ctx.createRadialGradient(width / 2, 320, 170, width / 2, 300, 580);
        vignette.addColorStop(0, '#00000000'); vignette.addColorStop(1, '#02090e80');
        ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
    }

    function drawTable() {
        const top = [[-halfWidth, nearY, tableZ], [halfWidth, nearY, tableZ],
            [halfWidth, farY, tableZ], [-halfWidth, farY, tableZ]];
        // The undercarriage uses real world height; it does not float below the apron.
        [-1, 1].forEach(side => {
            const x = side * halfWidth * .75;
            polygon([[x - .022, nearY + .33, .71], [x + .022, nearY + .33, .71],
                [x + .022, nearY + .33, .05], [x - .022, nearY + .33, .05]], '#0b1419');
            worldLine([x - .02, nearY + .33, .68], [x - .02, nearY + .33, .05], '#56707540', 1);
        });
        polygon([[-halfWidth, nearY, tableZ], [halfWidth, nearY, tableZ],
            [halfWidth, nearY, tableZ - .055], [-halfWidth, nearY, tableZ - .055]], '#0b222c');
        path(top, true);
        const surface = ctx.createLinearGradient(0, point(0, farY, tableZ).y, 0, point(0, nearY, tableZ).y);
        surface.addColorStop(0, '#286779'); surface.addColorStop(.48, '#205a70'); surface.addColorStop(1, '#17475d');
        ctx.fillStyle = surface; ctx.fill();
        ctx.save(); path(top, true); ctx.clip();
        const sheen = ctx.createRadialGradient(370, 296, 12, 430, 310, 410);
        sheen.addColorStop(0, '#c9e3d810'); sheen.addColorStop(1, '#c9e3d800');
        ctx.fillStyle = sheen; ctx.fillRect(0, 230, width, height - 230);
        ctx.strokeStyle = '#d0e3e902'; ctx.lineWidth = 1;
        for (let y = 280; y < height; y += 4) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }
        ctx.restore();
        // Painted lines have world widths, so they foreshorten with the table.
        const stripe = .015;
        [-1, 1].forEach(side => {
            const outer = side * halfWidth, inner = side * (halfWidth - stripe);
            polygon([[outer, nearY, tableZ], [inner, nearY, tableZ],
                [inner, farY, tableZ], [outer, farY, tableZ]], '#e6e9d8');
        });
        [nearY, farY - stripe].forEach(y => polygon([[-halfWidth, y, tableZ],
            [halfWidth, y, tableZ], [halfWidth, y + stripe, tableZ], [-halfWidth, y + stripe, tableZ]], '#e6e9d8'));
        polygon([[-.0015, nearY, tableZ], [.0015, nearY, tableZ],
            [.0015, farY, tableZ], [-.0015, farY, tableZ]], '#d5e4da9c');
        worldLine([-halfWidth, nearY, tableZ - .052], [halfWidth, nearY, tableZ - .052], '#3b6070', 1);
        polygon([[-halfWidth, netY, tableZ], [halfWidth, netY, tableZ],
            [halfWidth, netY + .065, tableZ], [-halfWidth, netY + .065, tableZ]], '#061b2638');
        const edge = point(-halfWidth + .05, nearY, tableZ - .036);
        ctx.textAlign = 'left'; ctx.font = '600 9px sans-serif'; ctx.fillStyle = '#b4cacb7a';
        ctx.fillText('T A B L E  /  0 1', edge.x, edge.y);
    }

    function drawStage() {
        if (!stage) {
            stage = createLayer();
            const main = ctx;
            try { ctx = stage.getContext('2d'); drawBackdrop(); drawTable(); }
            finally { ctx = main; }
        }
        ctx.drawImage(stage, 0, 0, width, height);
    }

    function drawTableResponse(now) {
        // Actual table contacts light the material, not an object floating above
        // it. Keep the static stage cached; this pass sits below shadows/rackets.
        // Only the latest bounce on each half contributes (at most two patches).
        let nearDrawn = false, farDrawn = false;
        const steady = reducedMotion();
        for (let i = impacts.length - 1; i >= 0; i--) {
            const hit = impacts[i];
            if (hit.type !== 'table' || Math.abs(hit.x) > halfWidth || hit.y < nearY || hit.y > farY) continue;
            const age = (now - hit.started) / tableImpactDuration;
            if (age < 0 || age >= 1) continue;
            const near = hit.y < netY;
            if (near ? nearDrawn : farDrawn) continue;
            if (near) nearDrawn = true; else farDrawn = true;
            const strength = steady ? .72 : (1 - age) ** 2;
            const center = point(hit.x, hit.y, tableZ);
            const along = point(hit.x, hit.y + .01, tableZ);
            ctx.save();
            // Clip to the struck panel, including sideline/endline paint. The
            // stationary footprint foreshortens along the tabletop's plane.
            const startY = near ? nearY : netY, endY = near ? netY : farY;
            path([[-halfWidth, startY, tableZ], [halfWidth, startY, tableZ],
                [halfWidth, endY, tableZ], [-halfWidth, endY, tableZ]], true);
            ctx.clip();
            ctx.globalAlpha = strength;
            const radius = .38;
            ctx.transform(center.scale * radius, 0,
                (along.x - center.x) * radius / .01, (along.y - center.y) * radius / .01,
                center.x, center.y);
            const sheen = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
            sheen.addColorStop(0, '#e8efda57');
            sheen.addColorStop(.28, '#b5d8cd36');
            sheen.addColorStop(.68, '#90c9c113');
            sheen.addColorStop(1, '#90c9c100');
            ctx.fillStyle = sheen; ctx.fillRect(-1, -1, 2, 2);
            ctx.restore();
            if (nearDrawn && farDrawn) break;
        }
    }

    function drawNet(now) {
        if (impacts.some(i => i.type === 'net' && now - i.started < 680)) {
            paintNet(now);
            return;
        }
        if (!netLayer) {
            netLayer = createLayer();
            const main = ctx;
            try { ctx = netLayer.getContext('2d'); paintNet(now); }
            finally { ctx = main; }
        }
        ctx.drawImage(netLayer, 0, 0, width, height);
    }

    function paintNet(now) {
        const netHeight = cfg.table.netHeight;
        const hit = impacts.slice().reverse().find(i => i.type === 'net' && now - i.started < 680);
        const age = hit ? clamp((now - hit.started) / 680, 0, 1) : 1;
        const animate = !reducedMotion();
        function netPoint(x, z) {
            const local = hit ? Math.exp(-(((x - hit.x) / .32) ** 2)) : 0;
            const pinned = Math.max(0, 1 - (x / halfWidth) ** 8);
            const vertical = Math.sin(Math.PI * clamp((z - tableZ) / netHeight, 0, 1));
            const wave = hit && animate ? hit.direction * Math.sin(age * Math.PI * 5) *
                (1 - age) ** 2 * local * pinned * vertical * .075 : 0;
            return point(x, netY + wave, z);
        }
        const lb = netPoint(-halfWidth, tableZ), rb = netPoint(halfWidth, tableZ);
        const lt = netPoint(-halfWidth, tableZ + netHeight), rt = netPoint(halfWidth, tableZ + netHeight);
        // Transparent mesh: a far-side ball remains visible through the holes.
        polygon([[-halfWidth, netY, tableZ], [halfWidth, netY, tableZ],
            [halfWidth, netY, tableZ + netHeight], [-halfWidth, netY, tableZ + netHeight]], '#0a192c38');
        ctx.lineWidth = .7; ctx.strokeStyle = '#c1d5d360';
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
            for (let j = 0; j <= 8; j++) {
                const p = netPoint(-halfWidth + cfg.table.width * i / 40, tableZ + netHeight * j / 8);
                if (!j) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            }
        }
        for (let j = 1; j < 8; j++) {
            for (let i = 0; i <= 40; i++) {
                const p = netPoint(-halfWidth + cfg.table.width * i / 40, tableZ + netHeight * j / 8);
                if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            }
        }
        ctx.stroke();
        line(lb, rb, '#b4c6ba9c', 1);
        line(lt, rt, cream, 3);
        line({ x: lt.x, y: lt.y + 2 }, { x: rt.x, y: rt.y + 2 }, '#091d2a8c', 1);
        [-1, 1].forEach(side => {
            const x = side * (halfWidth + .025);
            const base = point(x, netY, tableZ - .027), top = point(x, netY, tableZ + netHeight + .012);
            line(base, top, '#0a1c26', 7);
            line({ x: base.x - 1, y: base.y }, { x: top.x - 1, y: top.y }, '#8caaa8', 2);
            line(point(x - .018, netY, tableZ - .01), point(x + .018, netY, tableZ - .01), '#bac8bd', 3);
        });
        if (hit) {
            const p = netPoint(clamp(hit.x, -halfWidth, halfWidth), clamp(hit.z, tableZ, tableZ + netHeight));
            ctx.save(); ctx.globalAlpha = 1 - age;
            ctx.strokeStyle = '#f6bc92'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(p.x, p.y, animate ? 5 + 7 * age : 5, 0, Math.PI * 2);
            ctx.stroke(); ctx.restore();
        }
    }

    function clipOutsideTable() {
        ctx.beginPath(); ctx.rect(0, 0, width, height);
        const silhouette = [[-halfWidth, farY, tableZ], [halfWidth, farY, tableZ],
            [halfWidth, nearY, tableZ], [halfWidth, nearY, tableZ - .055],
            [-halfWidth, nearY, tableZ - .055], [-halfWidth, nearY, tableZ]];
        silhouette.forEach((v, i) => {
            const q = point(v[0], v[1], v[2]);
            if (!i) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        ctx.closePath(); ctx.clip('evenodd');
    }

    function drawBallShadow(ball) {
        const onTable = Math.abs(ball.x) <= halfWidth && ball.y >= nearY && ball.y <= farY && ball.z >= tableZ;
        const baseZ = onTable ? tableZ + .001 : .003;
        if (ball.z < baseZ) return;
        const ground = point(ball.x, ball.y, baseZ);
        const altitude = Math.max(0, ball.z - baseZ - ball.radius);
        const r = ground.scale * ball.radius * (1.3 + altitude * .7);
        ctx.save();
        if (onTable) {
            path([[-halfWidth, nearY, tableZ], [halfWidth, nearY, tableZ],
                [halfWidth, farY, tableZ], [-halfWidth, farY, tableZ]], true); ctx.clip();
        } else clipOutsideTable();
        ctx.translate(ground.x, ground.y); ctx.scale(1, .32);
        const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        shade.addColorStop(0, 'rgba(0,10,19,' + (.42 / (1 + altitude * 2)) + ')');
        shade.addColorStop(1, '#00101a00'); ctx.fillStyle = shade;
        ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
    }

    function drawBall(ball) {
        const p = point(ball.x, ball.y, ball.z), r = Math.max(3.5, p.scale * ball.radius);
        if (p.y + r < 0) return;
        const shine = ctx.createRadialGradient(p.x - r * .3, p.y - r * .4, 0, p.x, p.y, r);
        shine.addColorStop(0, '#ffffff'); shine.addColorStop(.65, ball.cheatBall ? '#fff1a1' : '#fff9e7');
        shine.addColorStop(1, ball.cheatBall ? '#d89c2b' : '#c7c9bd');
        ctx.save();
        if (ball.z < tableZ) {
            // A missed ball can fall under the table. Mask the tabletop and
            // apron in screen space, instead of painting that ball over them.
            clipOutsideTable();
        }
        ctx.shadowColor = ball.cheatBall ? '#ffcd6155' : '#06131d80';
        // Canvas shadowBlur uses device pixels rather than the current transform.
        ctx.shadowBlur = (ball.cheatBall ? 9 : 3) * rasterScale;
        ctx.fillStyle = shine; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.strokeStyle = '#fffbe7b3'; ctx.lineWidth = .7; ctx.stroke();
        ctx.restore();
    }

    function updateOpponent(dt) {
        if (!window.Net || !window.Net.isInGame()) { opponentPaddleDisplay = null; return null; }
        const target = window.Net.getOpponentPaddle();
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y) ||
                cfg.camera.distance + target.y <= .1) { opponentPaddleDisplay = null; return null; }
        if (!opponentPaddleDisplay || reducedMotion()) opponentPaddleDisplay = { x: target.x, y: target.y };
        else {
            const blend = 1 - Math.exp(-dt * 18);
            opponentPaddleDisplay.x += (target.x - opponentPaddleDisplay.x) * blend;
            opponentPaddleDisplay.y += (target.y - opponentPaddleDisplay.y) * blend;
        }
        return { ...opponentPaddleDisplay, z: cfg.paddle.startZ,
            halfWidth: cfg.paddle.halfWidth, halfHeight: cfg.paddle.halfHeight };
    }

    function drawPaddle(paddle, local) {
        const p = point(paddle.x, paddle.y, paddle.z);
        const rx = p.scale * paddle.halfWidth, ry = p.scale * paddle.halfHeight;
        const handleAngle = local ? -Math.PI / 3 : Math.PI / 3;
        ctx.save(); ctx.translate(p.x, p.y);
        if (local) ctx.globalAlpha = .5;
        // The handle is decorative. Keep the face centred on its contact box.
        ctx.rotate(handleAngle);
        if (isPaddleImgLoaded) {
            // SVG origin is the rubber centre: 200 units = collider diameter.
            ctx.drawImage(paddleImg, -rx * 1.2, -ry * 1.2, rx * 2.4, ry * 3.4);
        } else {
            ctx.fillStyle = '#c4a179'; ctx.fillRect(-rx * .16, ry * .75, rx * .32, ry * 1.25);
            ctx.fillStyle = '#a43549'; ctx.strokeStyle = '#dcc39c'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
    }

    // Extrapolate public flight only to the NEXT event. Never inspect cheatJitter,
    // pendingCorrection, opponent input or a return plan. The step order and
    // bounce location match Ball.update (semi-implicit Euler). Stop at the bounce:
    // any subsequent lateral change is not yet visible game state.
    function predictGuide(ball, paddle) {
        const step = cfg.physics.fixedStep, floorZ = tableZ + ball.radius;
        const front = paddle.hitY + cfg.shot.paddleContactDepth;
        const bounced = ball.bounceCount === 1;
        // Before the bounce, show where the ball would land on an unobstructed path.
        if (ball.bounceCount > 1 || (bounced && ball.y <= front)) return null;
        let x = ball.x, y = ball.y, z = ball.z, vz = ball.vz;
        for (let i = 0; i < 180; i++) {
            const before = { x, y, z };
            vz -= cfg.physics.gravity * step; x += ball.vx * step; y += ball.vy * step; z += vz * step;
            if (before.y > netY && y <= netY) {
                const t = (netY - before.y) / (y - before.y);
                if (Math.abs(before.x + (x - before.x) * t) <= halfWidth + ball.radius &&
                    before.z + (z - before.z) * t - ball.radius <= tableZ + cfg.table.netHeight) return null;
            }
            if (vz < 0 && before.z >= floorZ && z <= floorZ + 1e-9) {
                if (bounced || y <= nearY + ball.radius || y >= netY || Math.abs(x) > halfWidth - ball.radius) return null;
                return { kind: 'bounce', x, y, z: tableZ + .003 };
            }
            if (bounced && y <= front) {
                const t = (front - before.y) / (y - before.y);
                const target = { x: before.x + (x - before.x) * t, y: front, z: before.z + (z - before.z) * t };
                // Reuse the real swept contact check, at the current stationary
                // racket. Alignment is an aid, not a guarantee of a solved return.
                const stationary = { ...paddle, previousX: paddle.x, previousY: paddle.hitY, previousZ: paddle.z };
                const contact = window.ShotPhysics && window.ShotPhysics.findPaddleContact(before,
                    { x, y, z, radius: ball.radius }, stationary);
                return { ...target, kind: 'contact', aligned: Boolean(contact) };
            }
            if (z < floorZ) return null;
        }
        return null;
    }

    function returnGuide(ball, paddle, now) {
        if (!guideEnabled || !ball || ball.phase !== 'flying' || ball.lastShotByPlayer ||
                !(ball.vy < 0) || ![ball.vx, ball.vy, ball.vz].every(Number.isFinite)) {
            guideCache = null; return null;
        }
        // At most 30 predictions/sec during a continuous flight; a known bounce,
        // correction or new shot invalidates immediately. Never run the shot solver.
        const key = [ball.roundId, ball.shotId, ball.bounceCount, ball.vx, ball.vy, ball.cheatBall].join('/');
        if (!guideCache || guideCache.key !== key || now - guideCache.time >= 1000 / 30) {
            guideCache = { key, time: now, value: predictGuide(ball, paddle) };
        }
        if (guideCache.value?.kind === 'bounce') return guideCache.value;
        // Drop a cached contact cue once the ball passes the racket.
        return ball.y > paddle.hitY + cfg.shot.paddleContactDepth ? guideCache.value : null;
    }

    function drawLanding(guide) {
        const p = point(guide.x, guide.y, guide.z);
        const rx = .06 * p.scale, ry = rx * .32;
        ctx.save();
        ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#0b1922bf'; ctx.lineWidth = 4.5; ctx.stroke();
        ctx.strokeStyle = lime; ctx.lineWidth = 2.1; ctx.stroke();
        ctx.fillStyle = '#d5e87e16'; ctx.fill();
        line({ x: p.x - 3, y: p.y }, { x: p.x + 3, y: p.y }, lime, 1);
        ctx.restore();
    }

    function drawDepthGuide(paddle, ball) {
        // Put both cues at the same height so their spacing reads as depth.
        const guideZ = tableZ + .002;
        const racketDepth = paddle.hitY + cfg.shot.paddleContactDepth;
        const span = halfWidth - .025;
        ctx.save();
        ctx.setLineDash([7, 5]);
        worldLine([-span, racketDepth, guideZ], [span, racketDepth, guideZ], '#daed96b5', 1.6);
        if (ball && ball.phase === 'flying' && !ball.lastShotByPlayer && ball.vy < 0 &&
                ball.z > guideZ && Math.abs(ball.x) <= halfWidth && ball.y >= nearY && ball.y <= farY) {
            const foot = point(ball.x, ball.y, guideZ);
            const center = point(ball.x, ball.y, ball.z);
            ctx.setLineDash([3, 4]);
            line(center, foot, '#b2eafbaf', 1.35);
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.ellipse(foot.x, foot.y, 5, 2.6, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#b2eafb'; ctx.fill();
            // Keep the depth readable when the racket covers the floor dot.
            worldLine([-span, ball.y, guideZ], [-span + .12, ball.y, guideZ], '#b2eafb', 2.6);
            worldLine([span - .12, ball.y, guideZ], [span, ball.y, guideZ], '#b2eafb', 2.6);
        }
        ctx.restore();
    }

    function brackets(p, rx, ry, color) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
        const tick = Math.min(9, rx * .22);
        [-1, 1].forEach(x => [-1, 1].forEach(y => {
            ctx.moveTo(p.x + x * (rx - tick), p.y + y * ry);
            ctx.lineTo(p.x + x * rx, p.y + y * ry);
            ctx.lineTo(p.x + x * rx, p.y + y * (ry - tick));
        }));
        ctx.stroke();
    }

    function drawContactGuide(paddle, guide) {
        // Ball-centre acceptance box includes radius, exactly as the collider.
        const p = point(paddle.x, paddle.hitY + cfg.shot.paddleContactDepth, paddle.z);
        brackets(p, p.scale * (paddle.halfWidth + cfg.physics.ballRadius),
            p.scale * (paddle.halfHeight + cfg.physics.ballRadius), guide && guide.aligned ? lime : '#e9edd68c');
        if (!guide || guide.kind !== 'contact') return;
        const target = point(guide.x, guide.y, guide.z);
        if (target.x < 16 || target.x > width - 16 || target.y < 65 || target.y > height - 65) {
            // Strong observed deflections may put the arrival outside the view.
            // Keep a direction cue, without claiming the shot is still reachable.
            const x = clamp(target.x, 22, width - 22), y = clamp(target.y, 80, height - 80);
            const angle = Math.atan2(target.y - y, target.x - x);
            ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
            line({ x: -5, y: -5 }, { x: 1, y: 0 }, '#f1c59b', 1.5);
            line({ x: 1, y: 0 }, { x: -5, y: 5 }, '#f1c59b', 1.5);
            ctx.restore();
            return;
        }
        const color = guide.aligned ? lime : '#f1c59b';
        // A cross, not a ghost ball: distinguish the aid from the live ball.
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(target.x, target.y, 7, 0, Math.PI * 2); ctx.stroke();
        line({ x: target.x - 11, y: target.y }, { x: target.x - 4, y: target.y }, color, 1.5);
        line({ x: target.x + 4, y: target.y }, { x: target.x + 11, y: target.y }, color, 1.5);
        line({ x: target.x, y: target.y - 11 }, { x: target.x, y: target.y - 4 }, color, 1.5);
        line({ x: target.x, y: target.y + 4 }, { x: target.x, y: target.y + 11 }, color, 1.5);
        ctx.restore();
    }

    function addImpact(type, location) {
        if (!validPoint(location) || !['net', 'table', 'racket'].includes(type)) return;
        impacts.push({ type, x: location.x, y: location.y, z: location.z,
            direction: incomingVelocity < 0 ? -1 : 1, started: performance.now() });
        if (impacts.length > 8) impacts.shift();
    }
    function drawImpact(impact, now) {
        if (impact.type !== 'racket') return;
        const age = clamp((now - impact.started) / 240, 0, 1);
        const p = point(impact.x, impact.y, impact.z);
        const radius = p.scale * (reducedMotion() ? .026 : .025 + age * .045);
        ctx.save(); ctx.globalAlpha = (1 - age) * .75;
        ctx.strokeStyle = lime; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke(); ctx.restore();
    }

    function reset() {
        opponentPaddleDisplay = null; lastRenderTime = null; lastRound = null; lastPhase = null;
        incomingVelocity = 0; impacts.length = 0; guideCache = null;
        // User's guide preference and the static stage survive a new point.
    }
    function setGuideEnabled(value) { guideEnabled = Boolean(value); guideCache = null; }

    function render(ballState) {
        syncResolution();
        const now = performance.now();
        const dt = lastRenderTime === null ? 1 / 60 : clamp((now - lastRenderTime) / 1000, 0, .1);
        lastRenderTime = now;
        const state = ballState || {};
        if ((lastRound !== null && state.roundId !== lastRound) ||
            (lastPhase !== state.phase && ['idle', 'waiting-serve', 'waiting-remote'].includes(state.phase))) {
            impacts.length = 0; guideCache = null;
        }
        lastRound = state.roundId; lastPhase = state.phase;
        for (let i = impacts.length - 1; i >= 0; i--) {
            const duration = impacts[i].type === 'net' ? 680 :
                impacts[i].type === 'table' ? tableImpactDuration : 240;
            if (now - impacts[i].started >= duration) impacts.splice(i, 1);
        }
        incomingVelocity = Number.isFinite(state.vy) ? state.vy : 0;
        const ball = state.visible !== false && validPoint(state) && Number.isFinite(state.radius) && state.radius > 0 ? state : null;
        const paddle = window.Paddle.getState();
        const opponent = updateOpponent(dt);
        const guide = returnGuide(ball, paddle, now);
        ctx.save();
        drawStage();
        drawTableResponse(now);
        if (ball) drawBallShadow(ball);
        if (guideEnabled) drawDepthGuide(paddle, ball);
        // Painter's order follows camera depth for every moving object. Ties put
        // the ball last (including held serves); a passed ball is in front of us.
        const layers = [{ y: netY, draw: () => drawNet(now) },
            { y: paddle.y, draw: () => drawPaddle(paddle, true) }];
        if (opponent) layers.push({ y: opponent.y, draw: () => drawPaddle(opponent, false) });
        impacts.forEach(impact => {
            if (impact.type === 'racket') layers.push({ y: impact.y, draw: () => drawImpact(impact, now) });
        });
        if (ball) layers.push({ y: ball.y, draw: () => drawBall(ball) });
        layers.sort((a, b) => b.y - a.y).forEach(layer => layer.draw());
        if (guideEnabled) {
            ctx.save();
            if (ball) {
                // Guidance must not paint across the real ball at contact.
                const p = point(ball.x, ball.y, ball.z);
                const radius = Math.max(3.5, p.scale * ball.radius) + 2;
                ctx.beginPath(); ctx.rect(0, 0, width, height);
                ctx.moveTo(p.x + radius, p.y);
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.closePath(); ctx.clip('evenodd');
            }
            if (guide?.kind === 'bounce') drawLanding(guide);
            drawContactGuide(paddle, guide);
            ctx.restore();
        }
        if (ball) {
            const p = point(ball.x, ball.y, ball.z);
            if (p.y + p.scale * ball.radius < 0) {
                ctx.fillStyle = cream; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
                ctx.fillText('↑ High ball', clamp(p.x, 45, width - 45), 68);
            }
        }
        ctx.restore();
    }

    return Object.freeze({ render, addImpact, reset, setGuideEnabled });
})();

