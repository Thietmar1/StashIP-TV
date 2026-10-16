/**
 * Store: holds the state, runs the reducer, drains effects, notifies views.
 *
 * Effects are queued rather than run inline, so an effect that dispatches
 * cannot re-enter the reducer mid-update. Follows the shape already used by
 * GalleryMode's session store.
 */

import { reduce } from './reducer.js';
import { createInitialState } from './initialState.js';

export function createStore({ runEffect, ctx, initialState } = {}) {
    let state = initialState || createInitialState();
    const listeners = new Set();
    let draining = false;
    let queue = [];

    const getState = () => state;

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notify() {
        // Copy first: a listener may unsubscribe while we iterate.
        for (const listener of Array.from(listeners)) {
            try {
                listener(state);
            } catch (e) {
                // A broken view must not stop the others from updating.
            }
        }
    }

    function dispatch(event) {
        const previous = state;
        const result = reduce(state, event);
        state = result.state;

        queue.push(...result.effects);

        if (!draining) {
            draining = true;
            try {
                while (queue.length > 0) {
                    const effect = queue.shift();
                    if (runEffect) runEffect(effect, getState, dispatch, ctx);
                }
            } finally {
                draining = false;
            }
        }

        if (state !== previous) notify();
    }

    function destroy() {
        listeners.clear();
        queue = [];
        state = createInitialState();
    }

    return { getState, dispatch, subscribe, destroy };
}
