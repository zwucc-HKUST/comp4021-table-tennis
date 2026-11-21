// Pure player-shot calculations: contact, aim and a low arc at selected speed.
// Ball applies the result; transport shares the solved shot with the opponent.
window.ShotPhysics = (function() {
    const cfg = window.GameConfig;
    const p = cfg.physics;
    const tuning = cfg.shot;
    const dt = p.fixedStep;
    const table = cfg.table;
    const netY = table.nearY + table.length / 2;
    const farY = table.nearY + table.length;
    const contactZ = table.height + p.ballRadius;

    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function fall(time) {
        const steps = time / dt;
        const n = Math.floor(steps + 1e-9);
        const fraction = Math.max(0, steps - n);
        return p.gravity * dt * dt * (n * (n + 1) / 2 + (n + 1) * fraction);
    }

    // Swept ball-versus-paddle box in relative coordinates. The paddle's
    // actual motion is used for contact; filtered motion is only for aiming.
    function findPaddleContact(previousBall, ball, paddle) {
        const start = {
            x: previousBall.x - paddle.previousX,
            y: previousBall.y - paddle.previousY,
            z: previousBall.z - paddle.previousZ
        };
        const end = { x: ball.x - paddle.x, y: ball.y - paddle.hitY, z: ball.z - paddle.z };
        const half = { x: paddle.halfWidth + ball.radius,
            y: tuning.paddleContactDepth, z: paddle.halfHeight + ball.radius };
        // Accept the front face only, and only while the objects approach.
        if (end.y >= start.y || start.y < -half.y) return null;
        let entry = 0, exit = 1;
        for (const axis of ['x', 'y', 'z']) {
            const movement = end[axis] - start[axis];
            if (Math.abs(movement) < 1e-12) {
                if (Math.abs(start[axis]) > half[axis]) return null;
                continue;
            }
            const a = (-half[axis] - start[axis]) / movement;
            const b = (half[axis] - start[axis]) / movement;
            entry = Math.max(entry, Math.min(a, b));
            exit = Math.min(exit, Math.max(a, b));
            if (entry > exit) return null;
        }
        const impactPaddle = Object.assign({}, paddle, {
            x: lerp(paddle.previousX, paddle.x, entry),
            y: lerp(paddle.previousY, paddle.hitY, entry),
            z: lerp(paddle.previousZ, paddle.z, entry),
            smoothedVx: lerp(paddle.previousSmoothedVx, paddle.smoothedVx, entry),
            smoothedVy: lerp(paddle.previousSmoothedVy, paddle.smoothedVy, entry)
        });
        impactPaddle.hitY = impactPaddle.y;
        return {
            fraction: entry,
            x: lerp(previousBall.x, ball.x, entry),
            y: lerp(previousBall.y, ball.y, entry),
            z: lerp(previousBall.z, ball.z, entry),
            paddle: impactPaddle
        };
    }

    function calculateAim(ball, paddle, options) {
        const incomingSpeed = Math.hypot(ball.vx, ball.vy);
        const swingVx = paddle.smoothedVx || 0;
        const swingVy = paddle.smoothedVy || 0;
        const baseSpeed = paddle.returnSpeed + tuning.incomingWeight *
            (incomingSpeed - paddle.returnSpeed);
        const minSpeed = Math.min(tuning.minShotSpeed, tuning.maxBallSpeed);
        // In this coordinate system the incoming normal velocity is negative.
        // A moving, infinitely heavy paddle gives v_out = e*|v_in| + (1+e)*v_paddle.
        const physicsSpeed = tuning.paddleRestitution * Math.abs(ball.vy) +
            (1 + tuning.paddleRestitution) * swingVy;
        const targetSpeed = baseSpeed + tuning.pushWeight * swingVy;
        const blend = clamp(tuning.physicsBlend, 0, 1);
        const requestedSpeed = options && options.physicalResponse === false
            ? targetSpeed : blend * physicsSpeed + (1 - blend) * targetSpeed;
        const speed = clamp(requestedSpeed, minSpeed, tuning.maxBallSpeed);
        // Passive contact retains only part of the ball's lateral direction.
        // As the paddle actively swings, its movement takes over the aim.
        const incomingLateral = incomingSpeed > 1e-9 ? ball.vx / incomingSpeed : 0;
        const swingActive = tuning.swingActiveSpeed > 0
            ? clamp(Math.abs(swingVx) / tuning.swingActiveSpeed, 0, 1)
            : (Math.abs(swingVx) > 0 ? 1 : 0);
        const inheritFactor = tuning.reflectInheritance * (1 - swingActive);
        const reflectedX = incomingLateral * speed * inheritFactor;
        const reflectedY = incomingSpeed > 1e-9 ? Math.abs(ball.vy) / incomingSpeed * speed : speed;
        const offsetX = clamp((ball.x - paddle.x) / paddle.halfWidth, -1, 1);
        const candidateX = reflectedX + tuning.speedWeight * swingVx +
            speed * tuning.positionWeight * offsetX;
        const angleLimit = tuning.maxAngleDegrees * Math.PI / 180;
        const angle = clamp(Math.atan2(candidateX, reflectedY), -angleLimit, angleLimit);
        return { x: Math.sin(angle), y: Math.cos(angle), angle: angle,
            speed: speed, swingVx: swingVx, swingVy: swingVy, offsetX: offsetX };
    }

    // Test only vertical reach after the legal bounce. The receiver may choose
    // any allowed depth; lateral placement and reaction time remain player skills.
    // Ball.update clamps the bounce to contactZ and then uses semi-implicit steps,
    // so the rebound is piecewise linear, with its peak at a step boundary.
    function hasReachableRebound(landingY, vy, bounceVz) {
        const paddle = cfg.paddle;
        const depthAxis = table.nearY * 2 + table.length;
        const firstY = depthAxis - (paddle.maxY + tuning.paddleContactDepth);
        const lastY = depthAxis - (paddle.minY - tuning.paddleContactDepth);
        const enter = Math.max(0, (firstY - landingY) / vy);
        const exit = (lastY - landingY) / vy;
        if (exit <= enter) return false;
        const height = time => contactZ + bounceVz * time - fall(time);
        const peakTime = clamp(Math.floor(bounceVz / (p.gravity * dt)) * dt, enter, exit);
        const firstZ = height(enter), lastZ = height(exit);
        const lowestZ = Math.min(firstZ, lastZ);
        const highestZ = Math.max(firstZ, lastZ, height(peakTime));
        const margin = tuning.reboundContactMargin;
        const minZ = paddle.startZ - paddle.halfHeight - p.ballRadius + margin;
        const maxZ = paddle.startZ + paddle.halfHeight + p.ballRadius - margin;
        return highestZ >= minZ && lowestZ <= maxZ;
    }

    function planTrajectory(ball, aim) {
        if (!(aim.speed > 0) || !(aim.y > 0)) return null;
        const nominalLandingY = netY + (farY - netY) * 0.72;
        const maximumZ = Math.max(ball.z, table.height + tuning.maximumApex);
        const safeNetZ = contactZ + table.netHeight + tuning.netClearance;
        const maxFlight = 2 * Math.sqrt(2 * Math.max(0, maximumZ - contactZ) / p.gravity);
        const maxSteps = Math.ceil(maxFlight / dt) + 2;
        let best = null;
        for (let n = 2; n <= maxSteps; n += 1) {
            const time = n * dt;
            const vz = (contactZ - ball.z + fall(time)) / time;
            if (vz - p.gravity * time >= 0 || Math.abs(vz) >= aim.speed) continue;
            // Reserve speed for the vertical arc instead of scaling a planned
            // shot afterward. Each candidate has the selected total speed.
            const horizontalSpeed = Math.sqrt(aim.speed * aim.speed - vz * vz);
            const vx = horizontalSpeed * aim.x;
            const vy = horizontalSpeed * aim.y;
            const landingX = ball.x + vx * time;
            const landingY = ball.y + vy * time;
            if (landingY <= netY + 0.08 || landingY > farY - p.ballRadius) continue;
            const apexZ = ball.z + Math.max(0, vz) ** 2 / (2 * p.gravity);
            if (apexZ > maximumZ) continue;
            const netTime = (netY - ball.y) / vy;
            if (!(netTime > 0 && netTime < time)) continue;
            const netZ = ball.z + vz * netTime - fall(netTime);
            if (netZ < safeNetZ) continue;
            const inBounds = Math.abs(landingX) <= table.width / 2 - p.ballRadius;
            const bounceVz = (p.gravity * time - vz) * p.tableRestitution;
            if (inBounds && !hasReachableRebound(landingY, vy, bounceVz)) continue;
            const score = Math.abs(landingY - nominalLandingY) + (inBounds ? 0 : table.length);
            if (!best || score < best.score) {
                best = { vx: vx, vy: vy, vz: vz, speed: aim.speed,
                    angle: aim.angle, swingVx: aim.swingVx, swingVy: aim.swingVy,
                    offsetX: aim.offsetX,
                    landingX: landingX, landingY: landingY, flightTime: time,
                    netClearance: netZ - (contactZ + table.netHeight),
                    apexZ: apexZ, inBounds: inBounds, score: score };
            }
        }
        // A wide angle is still played. It may miss the table naturally;
        // steering is never silently replaced with an automatic centre shot.
        return best;
    }

    function planPlayerShot(ball, paddle, options) {
        const aim = calculateAim(ball, paddle, options);
        if (!(aim.speed > 0)) return null;
        const targetSpeed = aim.speed;
        const minimum = Math.min(targetSpeed, tuning.minimumAssistSpeed);
        const increment = 0.25;
        const maxSteps = Math.ceil((tuning.maxBallSpeed - minimum) / increment);
        // The collision model supplies the preferred speed. Search outward
        // from it for the nearest speed whose solved arc clears the net and lands.
        // Some contacts need extra speed; near-net/high contacts may need less.
        for (let attempt = 0; attempt <= maxSteps; attempt += 1) {
            const candidates = attempt === 0 ? [targetSpeed] :
                [targetSpeed - attempt * increment, targetSpeed + attempt * increment];
            for (const candidate of candidates) {
                const speed = Math.round(candidate * 1000) / 1000;
                if (speed < minimum || speed > tuning.maxBallSpeed) continue;
                const shot = planTrajectory(ball, Object.assign({}, aim, { speed: speed }));
                if (shot) {
                    shot.targetSpeed = targetSpeed;
                    shot.assisted = Math.abs(speed - targetSpeed) > 1e-9;
                    shot.speedAdjustment = speed - targetSpeed;
                    return shot;
                }
            }
        }
        return null;
    }

    return Object.freeze({ findPaddleContact: findPaddleContact,
        calculateAim: calculateAim, planPlayerShot: planPlayerShot });
})();
