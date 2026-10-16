import { createLazySceneDetails } from '../../src/state/lazySceneDetails.js';
import { createStore } from '../../src/state/store.js';
import { createInitialState, PoolStatus } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';
import { buildDaySchedule } from '../../src/domain/schedule.js';
import { ALL_SCENES_CHANNEL_ID as id, ALL_SCENES_EPOCH_MS as epoch } from '../../src/domain/allScenes.js';
import { tunedProgram, nextProgram } from '../../src/state/selectors.js';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(gql) {
    const scenes = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), title: `Scene ${i}`, files: [{ duration: 60 }], _summary: true }));
    const schedule = buildDaySchedule(id, scenes, '2020-01-01');
    const effects = jest.fn();
    const store = createStore({ runEffect: effects, initialState: {
        ...createInitialState(), open: true, nowMs: epoch + 5000, dayStartMs: epoch, dayKey: '2020-01-01', windowStartMs: epoch,
        tunedChannelId: id, pools: { [id]: { status: PoolStatus.READY, scenes } }, schedules: { [id]: schedule }
    } });
    const stop = createLazySceneDetails({ store, gql });
    return { store, stop, schedule, effects };
}
const metadata = (id) => ({ findScene: { id, details: 'Full description', paths: { stream: `/scene/${id}/stream` }, files: [{ duration: 999 }] } });

it('fetches just current and next scene metadata, merges it without changing the timeline, and tunes only the current scene', async () => {
    const gql = jest.fn(async (_query, { id }) => metadata(id));
    const { store, stop, schedule, effects } = setup(gql);
    const current = tunedProgram(store.getState()).scene.id;
    const next = nextProgram(store.getState(), id).scene.id;
    await flush();
    expect(gql.mock.calls.map((call) => call[1].id)).toEqual([current, next]);
    expect(tunedProgram(store.getState()).scene.paths.stream).toBe(`/scene/${current}/stream`);
    expect(store.getState().schedules[id].totalMs).toBe(schedule.totalMs);
    expect(tunedProgram(store.getState()).scene.files[0].duration).toBe(60);
    expect(effects.mock.calls.filter(([effect]) => effect.type === 'tuneViewer')).toHaveLength(1);
    store.dispatch({ type: Events.TICK, nowMs: epoch + 10000 });
    await flush();
    expect(gql).toHaveBeenCalledTimes(2);
    stop();
});

it('loads a selected scene on demand and does not reload the playing scene', async () => {
    const gql = jest.fn(async (_query, { id }) => metadata(id));
    const { store, stop, schedule, effects } = setup(gql);
    await flush();
    effects.mockClear();
    store.dispatch({ type: Events.FOCUS_CELL, channelId: id, timeMs: epoch + 5 * 60000, source: 'hover' });
    await flush();
    expect(gql).toHaveBeenCalledTimes(3);
    expect(gql.mock.calls[2][1].id).toBe(schedule.entries[5].scene.id);
    expect(effects.mock.calls.filter(([effect]) => effect.type === 'tuneViewer')).toHaveLength(0);
    stop();
});

it('does not start playback from a late response after closing', async () => {
    const pending = [];
    const gql = jest.fn((_query, { id }) => new Promise((resolve) => pending.push(() => resolve(metadata(id)))));
    const { store, stop, effects } = setup(gql);
    store.dispatch({ type: Events.CLOSE });
    effects.mockClear();
    pending.forEach((resolve) => resolve());
    await flush();
    expect(effects.mock.calls.filter(([effect]) => effect.type === 'tuneViewer')).toHaveLength(0);
    expect(gql).toHaveBeenCalledTimes(2);
    stop();
});

it('fetches only the guide time window when the channel is visible, then follows time panning', async () => {
    const gql = jest.fn(async (_query, { id }) => metadata(id));
    const { store, stop, schedule } = setup(gql);
    await flush();
    // Load a short visible window away from the two prefetched playback scenes.
    store.dispatch({ type: Events.SETTINGS_LOADED, settings: { ...store.getState().settings, guide_window_hours: 1 / 30 } });
    store.dispatch({ type: Events.PAN, deltaMs: 10 * 60000 });
    store.dispatch({ type: Events.CHANNELS_LOADED, channels: [{ id, source: 'special', name: 'All Scenes', sceneFilter: {} }] });
    await flush();
    expect(gql.mock.calls.map((call) => call[1].id)).toEqual([0, 1, 10, 11].map((index) => schedule.entries[index].scene.id));
    store.dispatch({ type: Events.PAN, deltaMs: 2 * 60000 });
    await flush();
    expect(gql.mock.calls.map((call) => call[1].id)).toEqual([0, 1, 10, 11, 12, 13].map((index) => schedule.entries[index].scene.id));
    stop();
});

it('reports metadata failures without retrying on every clock tick', async () => {
    const gql = jest.fn(async () => { throw new Error('offline'); });
    const { store, stop, effects } = setup(gql);
    await flush();
    expect(effects.mock.calls.some(([effect]) => effect.type === 'playbackError')).toBe(true);
    store.dispatch({ type: Events.TICK, nowMs: epoch + 10000 });
    await flush();
    expect(gql).toHaveBeenCalledTimes(2);
    stop();
});
