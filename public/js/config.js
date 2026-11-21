// All scene dimensions are in metres. Keep camera and table tuning here so
// the renderer does not contain unexplained numbers.
window.GameConfig = Object.freeze({
    canvas: { width: 960, height: 600 },
    table: {
        width: 1.525,
        length: 2.74,
        height: 0.76,
        nearY: 0.88,
        netHeight: 0.1525
    },
    camera: {
        x: 0,
        distance: 1,
        height: 1.58,
        focalLength: 1000,
        horizonY: 100
    },
    paddle: {
        startX: 0,
        startZ: 0.95,       // Racket height stays fixed; W/S moves its depth.
        startY: 0.98,
        minY: 0.7,
        maxY: 1.6,
        halfWidth: 0.1,
        halfHeight: 0.1,
        speed: 1.35,
        depthSpeed: 1.5,
        edgeMargin: 0.16,
        returnSpeed: 7
    },
    shot: {
        smoothingTime: 0.025, // Seconds; independent of the physics update rate.
        speedWeight: 0.8,     // Horizontal paddle velocity transferred into shot direction.
        pushWeight: 1.5,      // Forward/backward paddle velocity transferred into shot speed.
        incomingWeight: 0.5,  // Fallback target retains part of the incoming speed.
        paddleRestitution: 0.85, // Ball/paddle normal collision restitution.
        physicsBlend: 0.7,    // Blend physical normal response with playable target speed.
        reflectInheritance: 0.3, // Passive lateral inheritance when the paddle is still.
        swingActiveSpeed: 0.8, // Horizontal paddle speed that fully takes over lateral aim.
        positionWeight: 0,    // Disabled initially: tune swing influence first.
        maxAngleDegrees: 30,
        minShotSpeed: 3.5,    // Keep a pushed-back shot playable and solvable.
        maxBallSpeed: 11,    // Cap on the full launch velocity, in metres/second.
        minimumAssistSpeed: 4, // A low contact near the net may need a slower shot.
        maximumApex: 0.45,    // Ball-centre height above the tabletop.
        netClearance: 0.015,
        paddleContactDepth: 0.05,
        reboundContactMargin: 0.01 // Require clearance inside the contact envelope, not a tangent.
    },
    cheat: {
        toggleKey: 'KeyC',
        minBounceVxJitter: 3.2,
        maxBounceVxJitter: 4.4,
        maxLateralVx: 5.5
    },
    pace: {
        flightRate: 0.6,
        paddleRate: 1.6
    },
    physics: {
        gravity: 9.81,
        ballRadius: 0.021,
        tableRestitution: 0.8,
        fixedStep: 1 / 120
    }
});
