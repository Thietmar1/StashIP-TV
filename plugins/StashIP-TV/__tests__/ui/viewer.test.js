import {
    createViewer,
    withStart,
    SEEK_TIMEOUT_MS,
    DRIFT_CHECK_MS
} from '../../src/ui/viewer.js';

const scene = (overrides = {}) => ({
    id: 's1',
    title: 'Scene',
    paths: { stream: '/scene/1/stream', screenshot: '/scene/1/screenshot' },
    ...overrides
});

/**
 * jsdom's <video> has no playback engine: currentTime never moves and play()
 * is unimplemented. These stubs give us a controllable stand-in so the seek
 * and drift logic can be driven deterministically.
 */
function stubVideo(video) {
    let time = 0;
    Object.defineProperty(video, 'currentTime', {
        get: () => time,
        set: (v) => {
            time = v;
        },
        configurable: true
    });
    video.play = jest.fn(() => Promise.resolve());
    video.load = jest.fn();
    video.pause = jest.fn();
    Object.defineProperty(video, 'paused', { value: false, configurable: true, writable: true });
    return {
        setTime: (v) => {
            time = v;
        },
        getTime: () => time,
        /** Simulate a stream that accepts currentTime but never moves. */
        freeze: () => {
            Object.defineProperty(video, 'currentTime', {
                get: () => 0,
                set: () => {},
                configurable: true
            });
        }
    };
}

describe('withStart', () => {
    it('adds a start offset to a bare url', () => {
        expect(withStart('/scene/1/stream', 90)).toBe('/scene/1/stream?start=90');
    });

    it('appends to an existing query string', () => {
        expect(withStart('/scene/1/stream?resolution=720', 90)).toBe(
            '/scene/1/stream?resolution=720&start=90'
        );
    });

    it('floors fractional seconds', () => {
        expect(withStart('/s', 90.7)).toBe('/s?start=90');
    });
});

describe('createViewer', () => {
    let clock;

    beforeEach(() => {
        jest.useFakeTimers();
        clock = 1000000;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const build = () => {
        const viewer = createViewer({ now: () => clock });
        const control = stubVideo(viewer.element);
        return { viewer, control };
    };

    describe('alternate streams', () => {
        const streams = [
            { url: '/scene/1202/stream.mpd', mime_type: 'application/dash+xml' },
            { url: '/scene/1202/stream.mp4?resolution=STANDARD', mime_type: 'video/mp4' },
            { url: '/scene/1202/stream.webm', mime_type: 'video/webm' }
        ];
        const setup = (getStreams = jest.fn(async () => streams)) => {
            const viewer = createViewer({ now: () => clock, getStreams });
            const control = stubVideo(viewer.element);
            viewer.element.canPlayType = jest.fn((mime) => mime.startsWith('video/') ? 'probably' : '');
            viewer.tune(scene({ id: '1202' }), 90000, true);
            const fail = async () => {
                Object.defineProperty(viewer.element, 'error', { value: { code: 4 }, configurable: true });
                viewer.element.dispatchEvent(new Event('error'));
                await Promise.resolve();
                await Promise.resolve();
                Object.defineProperty(viewer.element, 'error', { value: null, configurable: true });
            };
            return { viewer, control, fail, getStreams };
        };

        it('loads compatible transcodes at the live offset and preserves their timeline on retune', async () => {
            const { viewer, fail, getStreams } = setup();
            clock += 5000;
            await fail();
            expect(getStreams).toHaveBeenCalledWith('1202');
            expect(viewer.element.getAttribute('src')).toBe('/scene/1202/stream.mp4?resolution=STANDARD&start=95');
            expect(viewer._streamBaseSeconds()).toBe(95);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));
            expect(viewer.element.currentTime).toBe(0);
            viewer.tune(scene({ id: '1202' }), 180000, true);
            expect(viewer.element.getAttribute('src')).toContain('start=180');
            expect(getStreams).toHaveBeenCalledTimes(1);
        });

        it('tries each compatible source once and reports exhaustion', async () => {
            const { viewer, fail, getStreams } = setup();
            const events = [];
            viewer.subscribe((event) => events.push(event));
            await fail();
            await fail();
            expect(viewer.element.getAttribute('src')).toBe('/scene/1202/stream.webm?start=90');
            await fail();
            expect(events.at(-1).type).toBe('error');
            expect(getStreams).toHaveBeenCalledTimes(1);
        });

        it('keeps the active transcode for redundant tunes and temporary fullscreen drift', async () => {
            const { viewer, control, fail } = setup();
            await fail();
            viewer.element.load.mockClear();
            control.setTime(10);
            clock += 10000;
            viewer.tune(scene({ id: '1202' }), 100000, true);
            expect(viewer.element.load).not.toHaveBeenCalled();
            clock += 5000;
            viewer._checkDrift();
            expect(viewer.element.load).not.toHaveBeenCalled();
            expect(viewer.element.getAttribute('src')).toContain('start=90');
        });

        it('corrects transcode drift within the available stream without reloading', async () => {
            const { viewer, control, fail } = setup();
            await fail();
            Object.defineProperty(viewer.element, 'seekable', {
                value: { length: 1, start: () => 0, end: () => 60 }, configurable: true
            });
            viewer.element.load.mockClear();
            clock += 20000;
            control.setTime(10);
            viewer._checkDrift();
            expect(control.getTime()).toBe(20);
            expect(viewer.element.load).not.toHaveBeenCalled();
        });

        it.each(['stop', 'tune'])('ignores late stream responses after %s', async (action) => {
            let resolve;
            const getStreams = jest.fn(() => new Promise((done) => { resolve = done; }));
            const { viewer, fail } = setup(getStreams);
            await fail();
            if (action === 'stop') viewer.stop();
            else viewer.tune(scene({ id: 'next', paths: { stream: '/scene/next/stream' } }), 0, true);
            resolve(streams);
            await Promise.resolve();
            expect(viewer.element.getAttribute('src')).toBe(action === 'stop' ? null : '/scene/next/stream');
        });

        it('keeps a paused viewer paused while an alternative loads', async () => {
            const { viewer, fail } = setup();
            clock += 5000;
            viewer.setPaused(true);
            clock += 30000;
            viewer.element.play.mockClear();
            await fail();
            expect(viewer.element.getAttribute('src')).toContain('start=95');
            expect(viewer.element.play).not.toHaveBeenCalled();
        });

        it('handles a rejected stream lookup', async () => {
            const { viewer, fail } = setup(async () => { throw new Error('offline'); });
            const events = [];
            viewer.subscribe((event) => events.push(event));
            await fail();
            expect(events.at(-1).type).toBe('error');
        });

        it('falls back on NotSupportedError but leaves autoplay rejection alone', async () => {
            const { viewer, getStreams } = setup();
            viewer.element.play = jest.fn(() => Promise.reject({ name: 'NotAllowedError' }));
            viewer.setPaused(false);
            await Promise.resolve();
            expect(getStreams).not.toHaveBeenCalled();
            viewer.element.play = jest.fn().mockRejectedValueOnce({ name: 'NotSupportedError' }).mockResolvedValue(undefined);
            viewer.setPaused(false);
            await Promise.resolve();
            await Promise.resolve();
            expect(getStreams).toHaveBeenCalledTimes(1);
            expect(viewer.element.getAttribute('src')).toContain('/stream.mp4');
        });
    });

    it('creates a muted, inline video element', () => {
        const { viewer } = build();
        expect(viewer.element.tagName).toBe('VIDEO');
        expect(viewer.element.muted).toBe(true);
        expect(viewer.element.hasAttribute('playsinline')).toBe(true);
    });

    it('loads the scene stream and shows its screenshot while buffering', () => {
        const { viewer } = build();
        viewer.tune(scene(), 0, true);

        expect(viewer.element.getAttribute('src')).toBe('/scene/1/stream');
        expect(viewer.element.poster).toContain('/scene/1/screenshot');
        expect(viewer.element.play).toHaveBeenCalled();
    });

    it('seeks to the live offset once metadata arrives', () => {
        const { viewer, control } = build();
        viewer.tune(scene(), 125000, true);

        viewer.element.dispatchEvent(new Event('loadedmetadata'));

        expect(control.getTime()).toBe(125);
    });

    it('applies the mute state it is given', () => {
        const { viewer } = build();
        viewer.tune(scene(), 0, false);
        expect(viewer.element.muted).toBe(false);

        viewer.setMuted(true);
        expect(viewer.element.muted).toBe(true);
    });

    it('nudges rather than reloading when retuned to the same scene', () => {
        const { viewer } = build();
        viewer.tune(scene(), 0, true);
        viewer.element.dispatchEvent(new Event('loadedmetadata'));
        viewer.element.load.mockClear();

        viewer.tune(scene(), 60000, true);

        expect(viewer.element.load).not.toHaveBeenCalled();
    });

    it('reloads when the scene changes', () => {
        const { viewer } = build();
        viewer.tune(scene(), 0, true);
        viewer.element.load.mockClear();

        viewer.tune(scene({ id: 's2', paths: { stream: '/scene/2/stream' } }), 0, true);

        expect(viewer.element.load).toHaveBeenCalled();
        expect(viewer.element.getAttribute('src')).toBe('/scene/2/stream');
    });

    it('stops when a scene has no stream to play', () => {
        const { viewer } = build();
        viewer.tune(scene({ id: 's9', paths: {} }), 0, true);
        expect(viewer.element.pause).toHaveBeenCalled();
    });

    describe('transcode seek fallback', () => {
        it('re-requests the stream with ?start= when the seek does not take', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 90000, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            control.freeze(); // stream ignored the seek
            jest.advanceTimersByTime(SEEK_TIMEOUT_MS);

            expect(viewer.element.getAttribute('src')).toBe('/scene/1/stream?start=90');
            expect(viewer.element.load).toHaveBeenCalled();
        });

        it('leaves a working seek alone', () => {
            const { viewer } = build();
            viewer.tune(scene(), 90000, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            jest.advanceTimersByTime(SEEK_TIMEOUT_MS);

            expect(viewer.element.getAttribute('src')).toBe('/scene/1/stream');
        });

        it('does not re-seek forever after the fallback shifts the stream timeline', () => {
            // Regression: once ?start= engages, the stream's t=0 IS the offset.
            // Comparing currentTime against absolute schedule time would make
            // drift correction think it was hours behind, on every check.
            const { viewer, control } = build();
            viewer.tune(scene(), 600000, true); // 10 minutes in
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            control.freeze();
            jest.advanceTimersByTime(SEEK_TIMEOUT_MS);
            expect(viewer.element.getAttribute('src')).toBe('/scene/1/stream?start=600');
            expect(viewer._streamBaseSeconds()).toBe(600);

            // The shifted stream is playing correctly from its own zero.
            const control2 = stubVideo(viewer.element);
            clock += 30000;
            control2.setTime(30); // 30s into a stream that began at 600
            viewer._checkDrift();

            expect(control2.getTime()).toBe(30); // left alone, not yanked
        });

        it('resets the stream timeline when a new scene is tuned', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 600000, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));
            control.freeze();
            jest.advanceTimersByTime(SEEK_TIMEOUT_MS);
            expect(viewer._streamBaseSeconds()).toBe(600);

            stubVideo(viewer.element);
            viewer.tune(scene({ id: 's2', paths: { stream: '/scene/2/stream' } }), 0, true);

            expect(viewer._streamBaseSeconds()).toBe(0);
        });

        it('cancels the fallback as soon as the element confirms the seek', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 90000, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            viewer.element.dispatchEvent(new Event('seeked'));
            control.freeze();
            jest.advanceTimersByTime(SEEK_TIMEOUT_MS);

            expect(viewer.element.getAttribute('src')).toBe('/scene/1/stream');
        });
    });

    describe('drift correction', () => {
        it('does nothing while playback tracks the schedule', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            clock += 30000;
            control.setTime(30); // exactly where it should be
            viewer._checkDrift();

            expect(control.getTime()).toBe(30);
        });

        it('re-seeks when playback falls behind the schedule', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            clock += 60000;
            control.setTime(20); // stalled 40s behind
            viewer._checkDrift();

            expect(control.getTime()).toBeCloseTo(60, 3);
        });

        it('tracks drift from the offset it was tuned to, not from zero', () => {
            const { viewer } = build();
            viewer.tune(scene(), 300000, true);
            clock += 10000;
            expect(viewer._expectedSeconds()).toBeCloseTo(310, 3);
        });

        it('runs on a timer once tuned', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            clock += DRIFT_CHECK_MS * 2;
            control.setTime(0); // never advanced
            jest.advanceTimersByTime(DRIFT_CHECK_MS);

            expect(control.getTime()).toBeGreaterThan(0);
        });

        it('leaves a paused or seeking element alone', () => {
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            clock += 60000;
            control.setTime(0);
            viewer.element.paused = true;
            viewer._checkDrift();

            expect(control.getTime()).toBe(0);
        });

        it('does nothing before anything is tuned', () => {
            const { viewer, control } = build();
            viewer._checkDrift();
            expect(control.getTime()).toBe(0);
        });
    });

    describe('pause', () => {
        it('pauses and resumes on request', () => {
            const { viewer } = build();
            viewer.tune(scene(), 0, true);

            viewer.setPaused(true);
            expect(viewer.element.pause).toHaveBeenCalled();
            expect(viewer.isPaused()).toBe(true);

            viewer.element.play.mockClear();
            viewer.setPaused(false);
            expect(viewer.element.play).toHaveBeenCalled();
        });

        it('leaves a deliberately paused element alone when drift is checked', () => {
            // Otherwise the drift timer would drag playback forward under a
            // user who chose to pause.
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            viewer.setPaused(true);
            clock += 60000;
            control.setTime(0);
            viewer._checkDrift();

            expect(control.getTime()).toBe(0);
        });

        it('clears the pause when retuned', () => {
            const { viewer } = build();
            viewer.setPaused(true);
            viewer.tune(scene(), 0, true);
            expect(viewer.isPaused()).toBe(false);
        });

        it('starts playing again when retuned to the scene it was paused on', () => {
            // Regression: the same-scene path only re-seeked and returned, so a
            // paused element was never told to play and unpausing did nothing.
            const { viewer } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));

            viewer.setPaused(true);
            viewer.element.play.mockClear();

            viewer.tune(scene(), 60000, true);

            expect(viewer.element.play).toHaveBeenCalled();
        });
    });

    describe('resume after the tab was hidden', () => {
        it('re-seeks and plays', () => {
            // iOS pauses the element on app switch and fires nothing that drift
            // correction can act on.
            const { viewer, control } = build();
            viewer.tune(scene(), 0, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));
            viewer.element.play.mockClear();

            expect(viewer.resume(300000)).toBe(true);

            expect(control.getTime()).toBe(300);
            expect(viewer.element.play).toHaveBeenCalled();
        });

        it('refuses when the user chose to pause', () => {
            const { viewer } = build();
            viewer.tune(scene(), 0, true);
            viewer.setPaused(true);
            expect(viewer.resume(1000)).toBe(false);
        });

        it('refuses with nothing tuned', () => {
            const { viewer } = build();
            expect(viewer.resume(1000)).toBe(false);
        });
    });

    describe('events', () => {
        it('reports loading and playing to subscribers', () => {
            const { viewer } = build();
            const seen = [];
            viewer.subscribe((e) => seen.push(e.type));

            viewer.element.dispatchEvent(new Event('loadstart'));
            viewer.element.dispatchEvent(new Event('waiting'));
            viewer.element.dispatchEvent(new Event('playing'));
            viewer.element.dispatchEvent(new Event('pause'));

            expect(seen).toEqual(['loading', 'loading', 'playing', 'paused']);
        });

        it('unsubscribes', () => {
            const { viewer } = build();
            const listener = jest.fn();
            const off = viewer.subscribe(listener);
            off();
            viewer.element.dispatchEvent(new Event('playing'));
            expect(listener).not.toHaveBeenCalled();
        });

        it('keeps notifying when one subscriber throws', () => {
            const { viewer } = build();
            const healthy = jest.fn();
            viewer.subscribe(() => {
                throw new Error('broken');
            });
            viewer.subscribe(healthy);

            expect(() => viewer.element.dispatchEvent(new Event('playing'))).not.toThrow();
            expect(healthy).toHaveBeenCalled();
        });
    });

    it('tears down cleanly', () => {
        const { viewer } = build();
        viewer.tune(scene(), 0, true);

        viewer.stop();

        expect(viewer.element.pause).toHaveBeenCalled();
        expect(viewer.element.hasAttribute('src')).toBe(false);
    });

    it('survives a play() that the browser refuses', () => {
        const viewer = createViewer({ now: () => clock });
        stubVideo(viewer.element);
        viewer.element.play = jest.fn(() => Promise.reject(new Error('NotAllowedError')));

        expect(() => viewer.tune(scene(), 0, true)).not.toThrow();
    });

    it('survives a play() that returns nothing, as older engines do', () => {
        const viewer = createViewer({ now: () => clock });
        stubVideo(viewer.element);
        viewer.element.play = jest.fn(() => undefined);

        expect(() => viewer.tune(scene(), 0, true)).not.toThrow();
    });

    it('survives an element that rejects currentTime before metadata', () => {
        const viewer = createViewer({ now: () => clock });
        stubVideo(viewer.element);
        Object.defineProperty(viewer.element, 'currentTime', {
            get: () => 0,
            set: () => {
                throw new Error('InvalidStateError');
            },
            configurable: true
        });

        expect(() => {
            viewer.tune(scene(), 5000, true);
            viewer.element.dispatchEvent(new Event('loadedmetadata'));
        }).not.toThrow();
    });
});
