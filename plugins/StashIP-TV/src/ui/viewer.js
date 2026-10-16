/**
 * The corner viewer: the part that makes the guide feel live.
 *
 * Playback compatibility, seeking, and drift:
 *
 * Unsupported direct streams fall back to browser-playable endpoints from
 * Stash. File transcodes start at the schedule offset on the server.
 *
 * 1. Seeking. `paths.stream` may be served direct or transcoded. On a direct
 *    file, setting `currentTime` works. On a transcode it can silently do
 *    nothing, so if no `seeked` arrives in time we reload the stream with
 *    `?start=`, which Stash honours server-side.
 *
 * 2. Drift. A tuned stream slowly falls behind the schedule -- buffering,
 *    a throttled background tab, a paused-then-resumed element. The viewer
 *    holds its own baseline and nudges itself back when it strays far enough
 *    to be visible.
 */

import { el } from './dom.js';

export const SEEK_TIMEOUT_MS = 4000;
export const SEEK_TOLERANCE_S = 2;
export const DRIFT_CHECK_MS = 10000;
export const DRIFT_TOLERANCE_S = 3;

/** Add a server-side start offset to a stream URL. */
export function withStart(url, seconds) {
    const [address, hash] = url.split('#');
    const [path, query] = address.split('?');
    const params = new URLSearchParams(query);
    params.set('start', String(Math.max(0, Math.floor(seconds))));
    return `${path}?${params}${hash ? `#${hash}` : ''}`;
}

export function createViewer({ now = () => Date.now(), document: doc = document, getStreams = async () => [] } = {}) {
    const video = el('video', {
        class: 'tvguide-viewer-video',
        muted: true,
        playsinline: true,
        preload: 'metadata'
    });
    // The muted attribute alone is not always honoured before first play.
    video.muted = true;

    let baseOffsetMs = 0;
    let baseWallMs = 0;
    let currentSceneId = null;
    let streamUrl = null;
    let originalUrl = null;
    let generation = 0;
    let alternatives = null;
    let resolvingStream = false;
    let fileTranscode = false;
    let metadataHandler = null;
    const triedStreams = new Set();
    // When the `?start=` fallback engages, the stream's own t=0 is that offset
    // rather than the start of the scene. Everything comparing `currentTime`
    // against schedule time has to subtract this, or drift correction would
    // think it is hours behind and re-seek forever.
    let streamBaseSeconds = 0;
    let seekTimer = null;
    let driftTimer = null;
    // Set while the user has deliberately paused, so drift correction and the
    // resume path both leave the element alone.
    let userPaused = false;
    const listeners = new Set();

    function emit(event) {
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (e) {
                /* a broken listener must not stop playback */
            }
        }
    }

    // Loading state: the poster is up from the moment we tune, and the spinner
    // runs until the element actually reports playing.
    video.addEventListener('loadstart', () => emit({ type: 'loading' }));
    video.addEventListener('waiting', () => emit({ type: 'loading' }));
    video.addEventListener('playing', () => emit({ type: 'playing' }));
    video.addEventListener('pause', () => emit({ type: 'paused' }));
    video.addEventListener('error', () => { if (video.error) fallback(); });

    function clearMetadataHandler() {
        if (metadataHandler) video.removeEventListener('loadedmetadata', metadataHandler);
        metadataHandler = null;
    }

    function loadStream(sceneSeconds) {
        clearSeekTimer();
        clearMetadataHandler();
        streamBaseSeconds = fileTranscode ? Math.floor(Math.max(0, sceneSeconds)) : 0;
        video.src = fileTranscode ? withStart(streamUrl, streamBaseSeconds) : streamUrl;
        metadataHandler = () => {
            metadataHandler = null;
            if (!fileTranscode) seek(sceneSeconds);
        };
        video.addEventListener('loadedmetadata', metadataHandler, { once: true });
        emit({ type: 'loading' });
        video.load();
        if (!userPaused) play();
    }

    async function fallback() {
        if (!currentSceneId || resolvingStream) return;
        const requestGeneration = generation;
        resolvingStream = true;
        clearSeekTimer();
        clearMetadataHandler();
        emit({ type: 'loading' });
        try {
            if (alternatives === null) {
                const streams = await getStreams(currentSceneId);
                if (generation !== requestGeneration) return;
                alternatives = streams.filter((stream) => stream.url && stream.mime_type
                    && video.canPlayType(stream.mime_type));
            }
            const next = alternatives.find((stream) => !triedStreams.has(stream.url));
            if (!next) {
                emit({ type: 'error', message: 'Unable to play this scene. Try opening it in Stash.' });
                return;
            }
            triedStreams.add(next.url);
            streamUrl = next.url;
            fileTranscode = /\/stream\.(mp4|webm)(?:[?#]|$)/i.test(streamUrl);
            loadStream(userPaused ? baseOffsetMs / 1000 : expectedSeconds());
        } catch (error) {
            if (generation === requestGeneration) {
                emit({ type: 'error', message: 'Unable to load alternate streams. Try tuning this channel again.' });
            }
        } finally {
            if (generation === requestGeneration) resolvingStream = false;
        }
    }

    /** Where the schedule says we should be, in scene time. */
    function expectedSeconds() {
        return (baseOffsetMs + (now() - baseWallMs)) / 1000;
    }

    /** The same instant expressed in the current stream's own timeline. */
    function expectedStreamSeconds() {
        return expectedSeconds() - streamBaseSeconds;
    }

    function clearSeekTimer() {
        video.removeEventListener('seeked', clearSeekTimer);
        if (seekTimer) {
            clearTimeout(seekTimer);
            seekTimer = null;
        }
    }

    /**
     * Seek, then verify. A transcoded stream can accept `currentTime` and
     * ignore it, so the fallback re-requests the stream at the offset instead.
     */
    function seek(sceneSeconds, { allowReload = true } = {}) {
        clearSeekTimer();

        if (fileTranscode) {
            const target = sceneSeconds - streamBaseSeconds;
            // Fullscreen/visibility transitions can briefly pause playback.
            // Do not discard a healthy transcode for a redundant tune or a
            // drift correction outside the data already available to seek.
            if (Math.abs(video.currentTime - target) <= SEEK_TOLERANCE_S) return;
            for (let i = 0; i < video.seekable.length; i++) {
                if (target >= video.seekable.start(i) && target <= video.seekable.end(i)) {
                    try {
                        video.currentTime = target;
                        return;
                    } catch (_) { break; }
                }
            }
            if (allowReload) loadStream(sceneSeconds);
            return;
        }

        const target = sceneSeconds - streamBaseSeconds;

        try {
            video.currentTime = target;
        } catch (e) {
            // Metadata not ready yet; the fallback below still covers us.
        }

        seekTimer = setTimeout(() => {
            seekTimer = null;
            if (Math.abs(video.currentTime - target) > SEEK_TOLERANCE_S && streamUrl) {
                // The stream ignored the seek -- ask the server to start there
                // instead, and remember that its timeline is now shifted.
                streamBaseSeconds = Math.floor(sceneSeconds);
                video.src = withStart(streamUrl, sceneSeconds);
                video.load();
                play();
            }
        }, SEEK_TIMEOUT_MS);

        video.addEventListener('seeked', clearSeekTimer, { once: true });
    }

    function play() {
        const playGeneration = generation;
        const playSource = video.getAttribute('src');
        const attempt = video.play();
        // Autoplay policy may refuse; the poster stays up and the user can
        // start it themselves. Not an error worth surfacing.
        if (attempt && typeof attempt.catch === 'function') attempt.catch((error) => {
            if (error.name === 'NotSupportedError' && generation === playGeneration
                && video.getAttribute('src') === playSource) fallback();
        });
    }

    function checkDrift() {
        if (!currentSceneId || userPaused || video.paused || video.seeking) return;
        if (Math.abs(video.currentTime - expectedStreamSeconds()) > DRIFT_TOLERANCE_S) {
            seek(expectedSeconds(), { allowReload: false });
        }
    }

    function startDriftWatch() {
        if (driftTimer) return;
        driftTimer = setInterval(checkDrift, DRIFT_CHECK_MS);
    }

    return {
        element: video,

        prepare() {
            this.stop();
            emit({ type: 'loading' });
        },

        reportError(message) {
            emit({ type: 'error', message });
        },

        /** Subscribe to loading/playing/paused. Returns an unsubscribe. */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        /** Point the viewer at a scene, positioned where the schedule says. */
        tune(scene, offsetMs, muted) {
            userPaused = false;
            baseOffsetMs = offsetMs;
            baseWallMs = now();
            video.muted = Boolean(muted);

            const nextUrl = scene?.paths?.stream || null;

            // Same scene, still playing: nudge rather than reload, so switching
            // back to a channel does not restart its buffer.
            if (scene && scene.id === currentSceneId && originalUrl === nextUrl && !video.error && !resolvingStream) {
                seek(offsetMs / 1000);
                // Still has to start playing: this is the path taken when
                // resuming from a pause, where the element is stopped.
                play();
                return;
            }

            currentSceneId = scene ? scene.id : null;
            generation += 1;
            originalUrl = nextUrl;
            alternatives = null;
            resolvingStream = false;
            fileTranscode = false;
            triedStreams.clear();
            triedStreams.add(nextUrl);
            clearSeekTimer();
            clearMetadataHandler();
            streamUrl = nextUrl;
            streamBaseSeconds = 0;

            if (!streamUrl) {
                this.stop();
                return;
            }

            if (scene.paths?.screenshot) video.poster = scene.paths.screenshot;

            loadStream(offsetMs / 1000);
            startDriftWatch();
        },

        setMuted(muted) {
            video.muted = Boolean(muted);
        },

        setPaused(paused) {
            if (paused && !userPaused) baseOffsetMs = expectedSeconds() * 1000;
            if (!paused && userPaused) baseWallMs = now();
            userPaused = Boolean(paused);
            if (paused) video.pause();
            else play();
        },

        isPaused() {
            return userPaused || video.paused;
        },

        stop() {
            generation += 1;
            resolvingStream = false;
            clearMetadataHandler();
            userPaused = false;
            clearSeekTimer();
            if (driftTimer) {
                clearInterval(driftTimer);
                driftTimer = null;
            }
            currentSceneId = null;
            streamUrl = null;
            streamBaseSeconds = 0;
            video.pause();
            video.removeAttribute('src');
            video.load();
        },

        // Exposed for tests and for the drift watch to be driven deterministically.
        /**
         * Re-establish playback after the tab was backgrounded.
         *
         * iOS pauses the element on app switch and fires nothing drift
         * correction can act on -- and drift correction deliberately ignores a
         * paused element, so it can never recover on its own.
         */
        resume(offsetMs) {
            if (userPaused || !streamUrl) return false;
            baseOffsetMs = offsetMs;
            baseWallMs = now();
            seek(offsetMs / 1000);
            play();
            return true;
        },

        _checkDrift: checkDrift,
        _expectedSeconds: expectedSeconds,
        _streamBaseSeconds: () => streamBaseSeconds
    };
}
