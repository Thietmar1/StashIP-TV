import { surfChannel } from '../../src/ui/channelSurf.js';
import { createStore } from '../../src/state/store.js';
import { createInitialState } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';

const channels = ['a', 'b', 'c'].map((id) => ({ id, name: id, source: 'studio', sceneFilter: {} }));
function mount(overrides = {}) {
    const runEffect = jest.fn();
    const store = createStore({ runEffect, initialState: {
        ...createInitialState(), open: true, channels, allChannels: channels,
        tunedChannelId: 'a', ...overrides
    } });
    return { store, runEffect };
}

it('wraps in guide order and requests programming without scrolling the guide', () => {
    const { store, runEffect } = mount({ viewerPaused: true, playerMode: 'fullscreen' });
    surfChannel(store, -1);
    expect(store.getState()).toMatchObject({ tunedChannelId: 'c', viewerPaused: false,
        playerMode: 'fullscreen', guideScrollChannelId: null });
    expect(runEffect.mock.calls.map(([effect]) => effect)).toContainEqual(expect.objectContaining({ type: 'fetchPool', channelId: 'c' }));
    surfChannel(store, 1);
    expect(store.getState().tunedChannelId).toBe('a');
});

it('uses only the filtered visible rows and recovers when the tuned row is absent', () => {
    const { store } = mount({ channels: [channels[1], channels[2]] });
    surfChannel(store, 1);
    expect(store.getState().tunedChannelId).toBe('b');
    surfChannel(store, -1);
    expect(store.getState().tunedChannelId).toBe('c');
});

it('leaves playback alone with zero channels or only the current channel', () => {
    for (const visible of [[], [channels[0]]]) {
        const { store, runEffect } = mount({ channels: visible, viewerPaused: true });
        surfChannel(store, 1);
        expect(store.getState().viewerPaused).toBe(true);
        expect(runEffect).not.toHaveBeenCalled();
    }
});

it('does not play an old pool response after surfing onward', () => {
    const { store, runEffect } = mount();
    surfChannel(store, 1);
    surfChannel(store, 1);
    runEffect.mockClear();
    store.dispatch({ type: Events.POOL_LOADED, channelId: 'b', scenes: [{ id: 'scene', files: [{ duration: 100 }] }] });
    expect(store.getState().tunedChannelId).toBe('c');
    expect(runEffect.mock.calls.map(([effect]) => effect.type)).not.toContain('tuneViewer');
});

it('starts the transition before switching streams, and skips it when there is no destination', () => {
    const { store } = mount();
    const beforeTune = jest.fn(() => expect(store.getState().tunedChannelId).toBe('a'));
    surfChannel(store, 1, { beforeTune });
    expect(beforeTune).toHaveBeenCalledTimes(1);
    expect(store.getState().tunedChannelId).toBe('b');
    const single = mount({ channels: [channels[0]] });
    beforeTune.mockClear();
    surfChannel(single.store, 1, { beforeTune });
    expect(beforeTune).not.toHaveBeenCalled();
});

it('updates guide details without pinning when surfing a loaded channel', () => {
    const { buildDaySchedule } = require('../../src/domain/schedule.js');
    const focus = { channelId: 'a', timeMs: 0, source: 'hover' };
    const { store } = mount({ focus, schedules: { b: buildDaySchedule('b', [{ id: 'scene', files: [{ duration: 100 }] }], '2026-09-06') } });
    surfChannel(store, 1);
    expect(store.getState().tunedChannelId).toBe('b');
    expect(store.getState().focus).toMatchObject({ channelId: 'b', source: 'live' });
    store.dispatch({ type: Events.FOCUS_CELL, channelId: 'a', timeMs: 0, source: 'hover' });
    expect(store.getState().focus.channelId).toBe('a');
});


it('follows the new scene when its pool arrives without overwriting a subsequent hover', () => {
    const { store } = mount({ focus: { channelId: 'a', timeMs: 0, source: 'sticky' } });
    surfChannel(store, 1);
    expect(store.getState().focus).toMatchObject({ channelId: 'b', source: 'live' });
    store.dispatch({ type: Events.POOL_LOADED, channelId: 'b', scenes: [{ id: 'scene', files: [{ duration: 100 }] }] });
    expect(store.getState().focus).toMatchObject({ channelId: 'b', source: 'live' });
    store.dispatch({ type: Events.FOCUS_CELL, channelId: 'a', timeMs: 20, source: 'hover' });
    store.dispatch({ type: Events.POOL_LOADED, channelId: 'b', scenes: [{ id: 'other', files: [{ duration: 100 }] }] });
    expect(store.getState().focus).toEqual({ channelId: 'a', timeMs: 20, source: 'hover' });
});


it('queues the latest keyboard destination for the guide, including while fullscreen', () => {
    const { store } = mount({ playerMode: 'fullscreen' });
    surfChannel(store, 1, { scrollIntoView: true });
    expect(store.getState().guideScrollChannelId).toBe('b');
    surfChannel(store, 1, { scrollIntoView: true });
    expect(store.getState().guideScrollChannelId).toBe('c');
    expect(store.getState().playerMode).toBe('fullscreen');
});
