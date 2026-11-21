// Convert a point in the small 3D world (x = left/right, y = depth,
// z = height) into a 2D Canvas point. This is a pinhole-camera projection.
window.Projection = (function() {
    const camera = window.GameConfig.camera;
    const width = window.GameConfig.canvas.width;

    function project(point) {
        const cameraDepth = camera.distance + point.y;
        if (cameraDepth <= 0) {
            throw new RangeError('Point is behind the camera.');
        }

        const scale = camera.focalLength / cameraDepth;
        return {
            x: width / 2 + (point.x - camera.x) * scale,
            y: camera.horizonY + (camera.height - point.z) * scale,
            scale: scale
        };
    }

    return Object.freeze({ project: project });
})();
