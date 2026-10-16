import { el } from './dom.js';

/** Keep one playback element; slide a frozen outgoing frame over the new stream. */
export function createSurfTransition(stage, video) {
    const frame = el('canvas', { class: 'tvguide-surf-frame', hidden: true, 'aria-hidden': 'true' });
    stage.appendChild(frame);
    let animations = [];
    let generation = 0;

    function cancel() {
        generation += 1;
        animations.forEach((animation) => animation.cancel());
        animations = [];
        frame.hidden = true;
        // Release the captured picture when the transition ends.
        frame.width = frame.height = 0;
    }

    return {
        cancel,
        play(direction) {
            cancel();
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
                || typeof video.animate !== 'function' || typeof frame.animate !== 'function') return;

            // A stream may not yet have a decoded frame. A black outgoing panel
            // is still safe to animate, and capture failure must never block tuning.
            if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
                try {
                    const scale = Math.min(1, 1280 / video.videoWidth);
                    frame.width = Math.round(video.videoWidth * scale);
                    frame.height = Math.round(video.videoHeight * scale);
                    frame.getContext('2d')?.drawImage(video, 0, 0, frame.width, frame.height);
                } catch (_) { /* Unavailable / protected video frame. */ }
            }
            frame.hidden = false;
            const current = generation;
            const options = { duration: 300, easing: 'cubic-bezier(.22,.61,.36,1)' };
            try {
                animations.push(frame.animate([
                    { transform: 'translateY(0)' },
                    { transform: `translateY(${-direction * 100}%)` }
                ], options));
                animations.push(video.animate([
                    { transform: `translateY(${direction * 100}%)` },
                    { transform: 'translateY(0)' }
                ], options));
                Promise.all(animations.map((animation) => animation.finished)).then(
                    () => { if (generation === current) cancel(); },
                    () => { if (generation === current) cancel(); }
                );
            } catch (_) {
                cancel();
            }
        }
    };
}
