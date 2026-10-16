import { watchLayout, layoutFor, MOBILE_QUERY } from '../../src/ui/layoutWatcher.js';
import { Events } from '../../src/state/actions.js';

/** A matchMedia stand-in whose match state can be flipped from a test. */
function fakeMedia({ matches = false, modern = true } = {}) {
    const listeners = new Set();
    const mql = {
        matches,
        media: MOBILE_QUERY,
        _set(next) {
            mql.matches = next;
            for (const listener of listeners) listener({ matches: next });
        }
    };
    if (modern) {
        mql.addEventListener = (_, fn) => listeners.add(fn);
        mql.removeEventListener = (_, fn) => listeners.delete(fn);
    } else {
        mql.addListener = (fn) => listeners.add(fn);
        mql.removeListener = (fn) => listeners.delete(fn);
    }
    mql._count = () => listeners.size;
    return mql;
}

describe('layoutFor', () => {
    it('maps a narrow viewport to the list and everything else to the grid', () => {
        expect(layoutFor(true)).toBe('list');
        expect(layoutFor(false)).toBe('grid');
    });
});

describe('watchLayout', () => {
    it('uses a narrow viewport or a short touch viewport without treating all tablets as phones', () => {
        const matchMediaFn = jest.fn(() => fakeMedia());
        watchLayout({ store: { dispatch: jest.fn() }, matchMediaFn });
        expect(matchMediaFn).toHaveBeenCalledWith(MOBILE_QUERY);
    });

    it('applies the current layout immediately', () => {
        const dispatch = jest.fn();
        watchLayout({ store: { dispatch }, matchMediaFn: () => fakeMedia({ matches: true }) });
        expect(dispatch).toHaveBeenCalledWith({ type: Events.LAYOUT_CHANGED, layout: 'list' });
    });

    it('follows a viewport change, as on rotation', () => {
        const dispatch = jest.fn();
        const mql = fakeMedia({ matches: false });
        watchLayout({ store: { dispatch }, matchMediaFn: () => mql });
        dispatch.mockClear();

        mql._set(true);

        expect(dispatch).toHaveBeenCalledWith({ type: Events.LAYOUT_CHANGED, layout: 'list' });
    });

    it('supports the legacy listener API', () => {
        const dispatch = jest.fn();
        const mql = fakeMedia({ matches: false, modern: false });
        const stop = watchLayout({ store: { dispatch }, matchMediaFn: () => mql });

        mql._set(true);
        expect(dispatch).toHaveBeenCalledWith({ type: Events.LAYOUT_CHANGED, layout: 'list' });

        stop();
        expect(mql._count()).toBe(0);
    });

    it('falls back to the grid when matchMedia is unavailable', () => {
        // One missing browser API must not stop the guide from starting.
        const dispatch = jest.fn();
        expect(() => {
            const stop = watchLayout({ store: { dispatch }, matchMediaFn: undefined });
            stop();
        }).not.toThrow();
        expect(dispatch).toHaveBeenCalledWith({ type: Events.LAYOUT_CHANGED, layout: 'grid' });
    });

    it('falls back to the grid when matchMedia returns nothing', () => {
        const dispatch = jest.fn();
        const stop = watchLayout({ store: { dispatch }, matchMediaFn: () => null });
        stop();
        expect(dispatch).toHaveBeenCalledWith({ type: Events.LAYOUT_CHANGED, layout: 'grid' });
    });

    it('stops listening on teardown', () => {
        const mql = fakeMedia();
        const stop = watchLayout({ store: { dispatch: jest.fn() }, matchMediaFn: () => mql });
        stop();
        expect(mql._count()).toBe(0);
    });
});
