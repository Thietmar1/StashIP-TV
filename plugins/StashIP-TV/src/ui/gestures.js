/**
 * Touch handling.
 *
 * A tap on a touchscreen produces a synthetic `mouseenter`/`mousemove` shortly
 * after the finger lifts. The guide shows a programme's details on hover, so
 * without a guard a tap would describe whatever the finger passed over on its
 * way up, fighting the tap that was actually intended.
 *
 * The timestamp is deliberately held ONCE for the whole guide rather than
 * per block. Per-element timestamps do not work: the synthetic event usually
 * lands on a *different* element than the one that was touched, so that
 * element's own timestamp is unset and the guard misses.
 */

export const SYNTHETIC_MOUSE_WINDOW_MS = 700;

export function createTouchGuard({ now = () => Date.now(), windowMs = SYNTHETIC_MOUSE_WINDOW_MS } = {}) {
    // One shared timestamp for every cell in the guide. See above.
    let lastTouchMs = -Infinity;

    return {
        noteTouch() {
            lastTouchMs = now();
        },

        /** True when a mouse event is really the echo of a recent touch. */
        isSyntheticMouse() {
            return now() - lastTouchMs < windowMs;
        },

        /** Watch a container for touches; returns a teardown. */
        attach(root) {
            const onTouch = () => this.noteTouch();
            root.addEventListener('touchstart', onTouch, { passive: true });
            root.addEventListener('touchend', onTouch, { passive: true });
            return () => {
                root.removeEventListener('touchstart', onTouch);
                root.removeEventListener('touchend', onTouch);
            };
        }
    };
}
