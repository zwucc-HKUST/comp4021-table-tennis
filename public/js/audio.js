// Two original, short WAV effects played through the page's HTML <audio> tags.
window.GameAudio = (function() {
    let muted = false;
    const sounds = {
        racket: { id: 'sound-racket', element: null, revision: 0, primed: false },
        table: { id: 'sound-table', element: null, revision: 0, primed: false }
    };

    function soundFor(type) {
        const sound = sounds[type];
        if (!sound) return null;
        if (!sound.element) sound.element = document.getElementById(sound.id);
        return sound.element ? sound : null;
    }

    // Call directly from a button/form gesture. Prime each media element
    // silently so its later collision sound can start during the animation loop.
    function unlock() {
        Object.keys(sounds).forEach(function(type) {
            const sound = soundFor(type);
            if (!sound || sound.primed) return;
            const audio = sound.element;
            const revision = ++sound.revision;
            audio.muted = true;
            try {
                const started = audio.play();
                Promise.resolve(started).then(function() {
                    sound.primed = true;
                    // A collision may have started a real sound while this
                    // promise was pending. Do not pause that newer playback.
                    if (revision !== sound.revision) return;
                    audio.pause();
                    audio.currentTime = 0;
                    audio.muted = muted;
                }).catch(function() {
                    if (revision === sound.revision) audio.muted = muted;
                });
            } catch (_) {
                audio.muted = muted;
            }
        });
    }

    function play(type) {
        if (muted) return;
        const sound = soundFor(type);
        if (!sound) return;
        const audio = sound.element;
        sound.revision += 1;
        try {
            audio.muted = false;
            audio.volume = 0.55;
            audio.currentTime = 0;
            Promise.resolve(audio.play()).then(function() {
                sound.primed = true;
            }).catch(function() {});
        } catch (_) {
            // Autoplay restrictions or an unavailable device cannot stop play.
        }
    }

    function setMuted(value) {
        muted = Boolean(value);
        Object.keys(sounds).forEach(type => {
            const sound = soundFor(type);
            if (!sound) return;
            // A newly enabled sound may still be in its silent unlock pass.
            sound.element.muted = muted || !sound.primed;
            if (muted) {
                sound.revision += 1;
                sound.element.pause();
            }
        });
    }

    return Object.freeze({ unlock, play, setMuted, isMuted: () => muted });
})();
