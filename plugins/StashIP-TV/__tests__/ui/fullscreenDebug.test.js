import { createFullscreenDebug } from '../../src/ui/fullscreenDebug.js';

it('only instruments on request, records exit callers, and restores the document method', async () => {
    const stage = document.createElement('div');
    const video = document.createElement('video');
    stage.append(video);
    const original = document.exitFullscreen;
    const exit = jest.fn(() => Promise.resolve());
    document.exitFullscreen = exit;
    const debug = createFullscreenDebug({ stage, video, getState: () => ({ playerMode: 'fullscreen' }) });
    try {
        expect(document.exitFullscreen).toBe(exit);
        debug.start();
        await document.exitFullscreen();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(debug.trace).toContainEqual(expect.objectContaining({ event: 'exitFullscreen', stack: expect.any(String) }));
        video.dispatchEvent(new Event('emptied'));
        expect(debug.trace.at(-1).event).toBe('emptied');
        debug.stop();
        expect(document.exitFullscreen).toBe(exit);
        const count = debug.trace.length;
        video.dispatchEvent(new Event('emptied'));
        expect(debug.trace).toHaveLength(count);
    } finally {
        debug.stop();
        if (original) document.exitFullscreen = original;
        else delete document.exitFullscreen;
    }
});
