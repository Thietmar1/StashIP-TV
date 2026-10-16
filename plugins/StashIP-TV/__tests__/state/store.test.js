import { createStore } from '../../src/state/store.js';
import { createInitialState } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';

const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();

describe('createStore', () => {
    it('starts from the initial state', () => {
        expect(createStore().getState()).toEqual(createInitialState());
    });

    it('accepts a supplied initial state', () => {
        const initialState = { ...createInitialState(), layout: 'list' };
        expect(createStore({ initialState }).getState().layout).toBe('list');
    });

    it('applies events through the reducer', () => {
        const store = createStore();
        store.dispatch({ type: Events.OPEN, nowMs: NOON });
        expect(store.getState().open).toBe(true);
    });

    it('hands effects to the runner with the context', () => {
        const runEffect = jest.fn();
        const ctx = { marker: true };
        const store = createStore({ runEffect, ctx });

        store.dispatch({ type: Events.OPEN, nowMs: NOON });

        expect(runEffect).toHaveBeenCalled();
        const [effect, getState, dispatch, passedCtx] = runEffect.mock.calls[0];
        expect(effect.type).toBe('loadChannels');
        expect(getState().open).toBe(true);
        expect(typeof dispatch).toBe('function');
        expect(passedCtx).toBe(ctx);
    });

    it('notifies subscribers when the state changes', () => {
        const store = createStore();
        const listener = jest.fn();
        store.subscribe(listener);

        store.dispatch({ type: Events.OPEN, nowMs: NOON });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].open).toBe(true);
    });

    it('stays quiet when an event changes nothing', () => {
        const store = createStore();
        const listener = jest.fn();
        store.subscribe(listener);

        store.dispatch({ type: 'NOT_A_REAL_EVENT' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribes', () => {
        const store = createStore();
        const listener = jest.fn();
        const off = store.subscribe(listener);
        off();

        store.dispatch({ type: Events.OPEN, nowMs: NOON });

        expect(listener).not.toHaveBeenCalled();
    });

    it('keeps notifying the other views when one listener throws', () => {
        const store = createStore();
        const healthy = jest.fn();
        store.subscribe(() => {
            throw new Error('broken view');
        });
        store.subscribe(healthy);

        expect(() => store.dispatch({ type: Events.OPEN, nowMs: NOON })).not.toThrow();
        expect(healthy).toHaveBeenCalled();
    });

    it('tolerates a listener unsubscribing mid-notification', () => {
        const store = createStore();
        const second = jest.fn();
        const off = store.subscribe(() => off());
        store.subscribe(second);

        expect(() => store.dispatch({ type: Events.OPEN, nowMs: NOON })).not.toThrow();
        expect(second).toHaveBeenCalled();
    });

    it('queues effects dispatched from inside an effect instead of re-entering', () => {
        const order = [];
        const runEffect = (effect, getState, dispatch) => {
            order.push(effect.type);
            if (effect.type === 'loadChannels') {
                // An effect that dispatches, which is the normal async pattern.
                dispatch({ type: Events.CHANNELS_FAILED, message: 'nope' });
                order.push('after-nested-dispatch');
            }
        };

        const store = createStore({ runEffect });
        store.dispatch({ type: Events.OPEN, nowMs: NOON });

        expect(order).toEqual(['loadChannels', 'after-nested-dispatch']);
        expect(store.getState().channelsError).toBe('nope');
    });

    it('runs without an effect runner at all', () => {
        const store = createStore();
        expect(() => store.dispatch({ type: Events.OPEN, nowMs: NOON })).not.toThrow();
    });

    it('resets on destroy', () => {
        const store = createStore();
        const listener = jest.fn();
        store.subscribe(listener);

        store.dispatch({ type: Events.OPEN, nowMs: NOON });
        store.destroy();

        expect(store.getState()).toEqual(createInitialState());

        listener.mockClear();
        store.dispatch({ type: Events.OPEN, nowMs: NOON });
        expect(listener).not.toHaveBeenCalled();
    });
});
