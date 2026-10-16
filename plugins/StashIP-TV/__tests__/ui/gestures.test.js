import { createTouchGuard, SYNTHETIC_MOUSE_WINDOW_MS } from '../../src/ui/gestures.js';

describe('createTouchGuard', () => {
    let clock;
    const build = () => createTouchGuard({ now: () => clock });

    beforeEach(() => {
        clock = 100000;
    });

    it('reports no synthetic mouse before any touch has happened', () => {
        expect(build().isSyntheticMouse()).toBe(false);
    });

    it('suppresses mouse events immediately after a touch', () => {
        const guard = build();
        guard.noteTouch();
        expect(guard.isSyntheticMouse()).toBe(true);
    });

    it('stops suppressing once the window has passed', () => {
        const guard = build();
        guard.noteTouch();
        clock += SYNTHETIC_MOUSE_WINDOW_MS + 1;
        expect(guard.isSyntheticMouse()).toBe(false);
    });

    it('honours a custom window', () => {
        const guard = createTouchGuard({ now: () => clock, windowMs: 50 });
        guard.noteTouch();
        clock += 60;
        expect(guard.isSyntheticMouse()).toBe(false);
    });

    it('shares one timestamp across every element, not one per element', () => {
        // The synthetic mouseenter usually lands on a *different* block than
        // the one touched, so a per-element timestamp would miss it entirely.
        const guard = build();
        const root = document.createElement('div');
        const blockA = document.createElement('div');
        const blockB = document.createElement('div');
        root.append(blockA, blockB);
        guard.attach(root);

        blockA.dispatchEvent(new Event('touchend', { bubbles: true }));

        // The guard is consulted while handling an event on a neighbour.
        expect(guard.isSyntheticMouse()).toBe(true);
    });

    it('notes touches starting and ending on the container', () => {
        const guard = build();
        const root = document.createElement('div');
        guard.attach(root);

        root.dispatchEvent(new Event('touchstart', { bubbles: true }));
        expect(guard.isSyntheticMouse()).toBe(true);

        clock += SYNTHETIC_MOUSE_WINDOW_MS + 1;
        root.dispatchEvent(new Event('touchend', { bubbles: true }));
        expect(guard.isSyntheticMouse()).toBe(true);
    });

    it('stops listening after teardown', () => {
        const guard = build();
        const root = document.createElement('div');
        const detach = guard.attach(root);
        detach();

        root.dispatchEvent(new Event('touchstart', { bubbles: true }));

        expect(guard.isSyntheticMouse()).toBe(false);
    });
});
