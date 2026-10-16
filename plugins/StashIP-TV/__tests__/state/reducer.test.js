import { reduce } from '../../src/state/reducer.js';
import { KNOWN_SOURCES } from '../../src/domain/lineup.js';
import { createInitialState, PoolStatus } from '../../src/state/initialState.js';
import { Events, STORAGE_KEYS } from '../../src/state/actions.js';
import { buildDaySchedule, dayBucket } from '../../src/domain/schedule.js';
import { relatedChannel } from '../../src/domain/relatedChannel.js';

const MIN = 60000;
const HOUR = 3600000;

const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();
const { key: DAY_KEY, startMs: DAY_START } = dayBucket(NOON);

const scenes = (n, minutes = 30) =>
    Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `Scene ${i + 1}`,
        files: [{ duration: minutes * 60 }]
    }));

const channel = (id, name = id) => ({
    id,
    source: 'studio',
    name,
    logo: { type: 'monogram', initials: 'XX', hue: 1 },
    sceneCount: 10,
    sceneFilter: { studios: { value: [id], modifier: 'INCLUDES' } }
});

describe('scene metadata edits', () => {
    it('updates every loaded appearance without rebuilding schedules or retuning playback', () => {
        const initial = readyState();
        initial.pools['studio:2'] = initial.pools['studio:1'];
        initial.schedules['studio:2'] = initial.schedules['studio:1'];
        const event = { type: Events.SCENE_METADATA_UPDATED, scenes: [{ id: 's1', title: 'Updated', details: '', tags: [] }] };
        const { state, effects } = reduce(initial, event);
        expect(effects).toEqual([]);
        for (const id of ['studio:1', 'studio:2']) {
            expect(state.pools[id].scenes.find((s) => s.id === 's1').title).toBe('Updated');
            expect(state.schedules[id].entries.map((e) => [e.offsetMs, e.durationMs])).toEqual(initial.schedules[id].entries.map((e) => [e.offsetMs, e.durationMs]));
            expect(state.schedules[id].entries.find((e) => e.scene.id === 's1').scene.title).toBe('Updated');
        }
        expect(reduce(state, event).state).toBe(state);
    });

    it('keeps an edit when an older in-flight pool response arrives afterwards', () => {
        const initial = readyState();
        const updated = reduce(initial, { type: Events.SCENE_METADATA_UPDATED, scenes: [{ id: 's1', title: 'Updated' }] }).state;
        const { state } = reduce(updated, { type: Events.POOL_LOADED, channelId: 'studio:2', scenes: scenes(4) });
        expect(state.pools['studio:2'].scenes.find((s) => s.id === 's1').title).toBe('Updated');
    });
});

/** A state with two channels loaded and a schedule for the first. */
function readyState(overrides = {}) {
    const base = {
        ...createInitialState(),
        open: true,
        nowMs: NOON,
        dayKey: DAY_KEY,
        dayStartMs: DAY_START,
        windowStartMs: NOON,
        allChannels: [channel('studio:1', 'One'), channel('studio:2', 'Two')],
        channels: [channel('studio:1', 'One'), channel('studio:2', 'Two')],
        channelsStatus: PoolStatus.READY,
        tunedChannelId: 'studio:1',
        focus: { channelId: 'studio:1', timeMs: NOON }
    };
    base.pools = {
        'studio:1': { status: PoolStatus.READY, scenes: scenes(4), error: null }
    };
    base.schedules = {
        'studio:1': buildDaySchedule('studio:1', scenes(4), DAY_KEY)
    };
    return { ...base, ...overrides };
}

const run = (state, event) => reduce(state, event);
const effectTypes = (effects) => effects.map((e) => e.type);

describe('OPEN', () => {
    it('opens on the current broadcast day with the window snapped to the half hour', () => {
        const t = new Date(2026, 7, 22, 15, 47).getTime();
        const { state } = run(createInitialState(), { type: Events.OPEN, nowMs: t });

        expect(state.open).toBe(true);
        expect(state.dayKey).toBe('2026-08-22');
        expect(new Date(state.windowStartMs).getMinutes()).toBe(30);
    });

    it('loads channels the first time it opens', () => {
        const { state, effects } = run(createInitialState(), { type: Events.OPEN, nowMs: NOON });
        expect(effectTypes(effects)).toContain('loadChannels');
        expect(state.channelsStatus).toBe(PoolStatus.LOADING);
    });

    it('reuses channels it already has and resumes the tuned channel instead', () => {
        const { effects } = run({ ...readyState(), open: false }, { type: Events.OPEN, nowMs: NOON });
        expect(effectTypes(effects)).not.toContain('loadChannels');
        expect(effectTypes(effects)).toContain('tuneViewer');
    });
});

describe('CLOSE', () => {
    it('stops the viewer so no video keeps streaming behind the page', () => {
        const { state, effects } = run(readyState(), { type: Events.CLOSE });
        expect(state.open).toBe(false);
        expect(effectTypes(effects)).toEqual(['stopViewer']);
    });
});

describe('temporary related channels', () => {
    it('creates and tunes one temporary model channel, requesting its pool', () => {
        const { state, effects } = run(readyState(), {
            type: Events.TUNE_RELATED,
            source: 'performer',
            entity: { id: '7', name: 'Avery Lane' }
        });

        expect(state.temporaryChannel.id).toBe('performer:7');
        expect(state.tunedChannelId).toBe('performer:7');
        expect(state.allChannels.map((c) => c.id)).toContain('performer:7');
        expect(state.guideScrollChannelId).toBe('performer:7');
        expect(effectTypes(effects)).toContain('fetchPool');
    });

    it('drops an unsaved temporary channel when tuning another channel', () => {
        const temporary = relatedChannel('tag', { id: '9', name: 'Outdoor' });
        const base = readyState();
        const state = { ...base, temporaryChannel: temporary, allChannels: [...base.allChannels, temporary] };

        const { state: next } = run(state, { type: Events.TUNE, channelId: 'studio:2' });
        expect(next.temporaryChannel).toBeNull();
        expect(next.allChannels.map((c) => c.id)).not.toContain('tag:9');
    });

    it('promotes the temporary channel into the persisted lineup and waits to scroll', () => {
        const temporary = relatedChannel('performer', { id: '7', name: 'Avery Lane' });
        const base = readyState();
        const state = { ...base, temporaryChannel: temporary, allChannels: [...base.allChannels, temporary] };

        const result = run(state, { type: Events.SAVE_TEMPORARY_CHANNEL });
        expect(result.state.lineup).toContainEqual({ source: 'performer', ids: ['7'] });
        expect(result.state.reloadScrollChannelId).toBe('performer:7');
        expect(effectTypes(result.effects)).toEqual(expect.arrayContaining(['persist', 'loadChannels']));
    });

    it('exposes the post-save scroll target once the reloaded lineup contains it', () => {
        const base = readyState({ reloadScrollChannelId: 'tag:9' });
        const saved = relatedChannel('tag', { id: '9', name: 'Outdoor' });
        const { state } = run(base, {
            type: Events.CHANNELS_LOADED,
            channels: [...base.allChannels, saved]
        });

        expect(state.guideScrollChannelId).toBe('tag:9');
        expect(run(state, { type: Events.CONSUME_GUIDE_SCROLL }).state.guideScrollChannelId).toBeNull();
    });
});

describe('RESTORE', () => {
    it('restores playback on mobile without requesting a jump to the remembered channel', () => {
        const initial = { ...createInitialState(), layout: 'list' };
        const restored = run(initial, { type: Events.RESTORE, tunedChannelId: 'studio:2' }).state;
        const opened = run(restored, { type: Events.OPEN, nowMs: NOON }).state;
        const { state, effects } = run(opened, {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1', 'One'), channel('studio:2', 'Two')]
        });
        expect(state.tunedChannelId).toBe('studio:2');
        expect(state.focus.channelId).toBe('studio:2');
        expect(state.guideScrollChannelId).toBeNull();
        expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fetchPool', channelId: 'studio:2' })]));
    });

    it('discards an old scroll request on mobile reopen while retaining explicit channel navigation', () => {
        const initial = readyState({ open: false, layout: 'list', guideScrollChannelId: 'studio:1' });
        const opened = run(initial, { type: Events.OPEN, nowMs: NOON }).state;
        expect(opened.guideScrollChannelId).toBeNull();
        const tuned = run(opened, { type: Events.TUNE, channelId: 'studio:2' }).state;
        expect(tuned.guideScrollChannelId).toBe('studio:2');
    });

    it('selects and scrolls to a remembered channel after the lineup loads', () => {
        const restored = run(createInitialState(), {
            type: Events.RESTORE,
            tunedChannelId: 'studio:2'
        }).state;
        const { state } = run(restored, {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1', 'One'), channel('studio:2', 'Two')]
        });

        expect(state.tunedChannelId).toBe('studio:2');
        expect(state.focus).toEqual({ channelId: 'studio:2', timeMs: 0 });
        expect(state.guideScrollChannelId).toBe('studio:2');
    });

    it('requests the remembered channel pool after the lineup loads', () => {
        const restored = run(createInitialState(), {
            type: Events.RESTORE,
            tunedChannelId: 'studio:2'
        }).state;
        const { state, effects } = run(restored, {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1', 'One'), channel('studio:2', 'Two')]
        });

        expect(state.pools['studio:2'].status).toBe(PoolStatus.LOADING);
        expect(effectTypes(effects)).toEqual(['fetchPool']);
        expect(effects[0].channelId).toBe('studio:2');
    });

    it('starts restored autoplay muted without overwriting the saved preference', () => {
        const { state, effects } = run(createInitialState(), {
            type: Events.RESTORE,
            tunedChannelId: 'studio:2',
            muted: false
        });

        expect(state.muted).toBe(true);
        expect(effects).toEqual([]);
    });

    it('restores a remembered channel that is still in the lineup', () => {
        const { state } = run(readyState({ tunedChannelId: null }), {
            type: Events.RESTORE,
            tunedChannelId: 'studio:2',
            muted: false
        });
        expect(state.tunedChannelId).toBe('studio:2');
        expect(state.muted).toBe(false);
    });

    it('ignores a remembered channel that has since disappeared', () => {
        const { state } = run(readyState(), {
            type: Events.RESTORE,
            tunedChannelId: 'studio:999'
        });
        expect(state.tunedChannelId).toBe('studio:1');
    });

    it('keeps the current mute state when none was remembered', () => {
        const { state } = run(readyState(), { type: Events.RESTORE, tunedChannelId: null });
        expect(state.muted).toBe(true);
    });
});

describe('TICK', () => {
    it('advances the clock', () => {
        const { state } = run(readyState(), { type: Events.TICK, nowMs: NOON + MIN });
        expect(state.nowMs).toBe(NOON + MIN);
    });

    it('ignores a tick for the same instant', () => {
        const before = readyState();
        const { state } = run(before, { type: Events.TICK, nowMs: NOON });
        expect(state).toBe(before);
    });

    it('does not retune while the same programme is still playing', () => {
        const { effects } = run(readyState(), { type: Events.TICK, nowMs: NOON + MIN });
        expect(effectTypes(effects)).not.toContain('tuneViewer');
    });

    it('retunes when the programme changes underneath it', () => {
        // Scenes are 30 minutes, so an hour on is definitely a different one.
        const state = readyState();
        const { effects } = run(state, { type: Events.TICK, nowMs: NOON + HOUR });
        expect(effectTypes(effects)).toContain('tuneViewer');
    });

    it('invalidates daily pools and requests the tuned channel when the broadcast day rolls over', () => {
        const beforeMidnight = new Date(2026, 7, 22, 23, 59, 30).getTime();
        const afterMidnight = new Date(2026, 7, 23, 0, 0, 30).getTime();

        const state = readyState({ nowMs: beforeMidnight });
        const { state: next, effects } = run(state, { type: Events.TICK, nowMs: afterMidnight });

        expect(next.dayKey).toBe('2026-08-23');
        expect(next.dayStartMs).toBe(dayBucket(afterMidnight).startMs);
        expect(next.schedules['studio:1']).toBeUndefined();
        expect(next.pools['studio:1'].status).toBe(PoolStatus.LOADING);
        expect(effects).toContainEqual(expect.objectContaining({ type: 'fetchPool', channelId: 'studio:1' }));
    });

    it('resets the window to the new day rather than leaving it in yesterday', () => {
        const afterMidnight = new Date(2026, 7, 23, 0, 0, 30).getTime();
        const { state } = run(readyState({ nowMs: new Date(2026, 7, 22, 23, 59).getTime() }), {
            type: Events.TICK,
            nowMs: afterMidnight
        });
        expect(state.windowStartMs).toBe(dayBucket(afterMidnight).startMs);
    });

    it('refreshes the tuned channel even when its row is filtered out at midnight', () => {
        const before = readyState({ channels: [] });
        const { state, effects } = run(before, { type: Events.TICK, nowMs: new Date(2026, 7, 23).getTime() });
        expect(state.pools[before.tunedChannelId].status).toBe(PoolStatus.LOADING);
        expect(effects).toContainEqual(expect.objectContaining({ type: 'fetchPool', channelId: before.tunedChannelId }));
    });

    it('drops yesterday\'s pending pools without eagerly requesting untuned channels', () => {
        const state = readyState();
        state.pools['studio:2'] = { status: PoolStatus.LOADING, scenes: [], error: null };
        const { state: next } = run(state, {
            type: Events.TICK,
            nowMs: new Date(2026, 7, 23, 0, 1).getTime()
        });
        expect(Object.keys(next.schedules)).toEqual([]);
        expect(next.pools['studio:2']).toBeUndefined();
    });

    it('keeps the full-library channel pool and continuous schedule at midnight', () => {
        const channelId = 'special:all-scenes';
        const state = readyState();
        const pool = { status: PoolStatus.READY, scenes: scenes(3, 1500), error: null };
        state.allChannels = [{ id: channelId, name: 'All Scenes', source: 'special' }];
        state.pools = { [channelId]: pool };
        state.schedules = { [channelId]: buildDaySchedule(channelId, pool.scenes, state.dayKey) };
        const result = run(state, { type: Events.TICK, nowMs: DAY_START + 24 * HOUR });
        expect(result.state.pools[channelId]).toBe(pool);
        expect(result.state.schedules[channelId]).toEqual(state.schedules[channelId]);
        expect(result.effects).not.toContainEqual({ type: 'loadChannels' });
    });

    it('refreshes special channels and drops their old pools at the day boundary', () => {
        const state = readyState({
            allChannels: [{ ...channel('special:new-releases'), source: 'special' }, channel('studio:1')],
            channels: [{ ...channel('special:new-releases'), source: 'special' }, channel('studio:1')]
        });
        state.pools['special:new-releases'] = { status: PoolStatus.READY, scenes: scenes(1), error: null };
        state.schedules['special:new-releases'] = buildDaySchedule('special:new-releases', state.pools['special:new-releases'].scenes, DAY_KEY);

        const { state: next, effects } = run(state, {
            type: Events.TICK,
            nowMs: new Date(2026, 7, 23, 0, 1).getTime()
        });

        expect(effects.map((effect) => effect.type)).toContain('loadChannels');
        expect(next.pools['special:new-releases']).toBeUndefined();
        expect(next.schedules['special:new-releases']).toBeUndefined();
        expect(next.pools['studio:1'].status).toBe(PoolStatus.LOADING);
    });

    it('stays quiet when nothing is tuned', () => {
        const { effects } = run(readyState({ tunedChannelId: null }), {
            type: Events.TICK,
            nowMs: NOON + HOUR
        });
        expect(effects).toEqual([]);
    });
});

describe('CHANNELS_LOADED', () => {
    it('stores the channels and auto-tunes the first', () => {
        const { state } = run(createInitialState(), {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1'), channel('studio:2')],
            errors: []
        });
        expect(state.channelsStatus).toBe(PoolStatus.READY);
        expect(state.tunedChannelId).toBe('studio:1');
        expect(state.focus).toEqual({ channelId: 'studio:1', timeMs: 0 });
    });

    it('keeps an already-tuned channel rather than jumping to the first', () => {
        const base = { ...createInitialState(), tunedChannelId: 'studio:2' };
        const { state } = run(base, {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1'), channel('studio:2')],
            errors: []
        });
        expect(state.tunedChannelId).toBe('studio:2');
    });

    it('records per-source errors without failing the whole load', () => {
        const { state } = run(createInitialState(), {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1')],
            errors: [{ source: 'tag', message: 'boom' }]
        });
        expect(state.channelsStatus).toBe(PoolStatus.READY);
        expect(state.sourceErrors).toEqual([{ source: 'tag', message: 'boom' }]);
    });

    it('clears a previous failure so a stale error cannot linger', () => {
        const failed = { ...createInitialState(), channelsError: 'offline', channelsStatus: PoolStatus.ERROR };
        const { state } = run(failed, {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1')],
            errors: []
        });
        expect(state.channelsError).toBeNull();
        expect(state.channelsStatus).toBe(PoolStatus.READY);
    });

    it('defaults the error list when the event omits it', () => {
        const { state } = run(createInitialState(), {
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1')]
        });
        expect(state.sourceErrors).toEqual([]);
    });

    it('copes with an empty lineup', () => {
        const { state } = run(createInitialState(), {
            type: Events.CHANNELS_LOADED,
            channels: [],
            errors: []
        });
        expect(state.tunedChannelId).toBeNull();
        expect(state.focus).toBeNull();
    });
});

describe('CHANNELS_FAILED', () => {
    it('records the error', () => {
        const { state } = run(createInitialState(), {
            type: Events.CHANNELS_FAILED,
            message: 'offline'
        });
        expect(state.channelsStatus).toBe(PoolStatus.ERROR);
        expect(state.channelsError).toBe('offline');
    });
});

describe('POOL_REQUESTED', () => {
    it('starts a fetch carrying the channel\'s own scene filter', () => {
        const state = readyState({ pools: {}, schedules: {} });
        const { state: next, effects } = run(state, {
            type: Events.POOL_REQUESTED,
            channelId: 'studio:2'
        });

        expect(next.pools['studio:2'].status).toBe(PoolStatus.LOADING);
        expect(effects).toEqual([
            {
                type: 'fetchPool',
                channelId: 'studio:2',
                sceneFilter: state.channels[1].sceneFilter,
                poolCap: state.settings.guide_pool_cap
            }
        ]);
    });

    it('ignores repeat requests, which scrolling produces constantly', () => {
        const state = readyState();
        const { state: next, effects } = run(state, {
            type: Events.POOL_REQUESTED,
            channelId: 'studio:1'
        });
        expect(next).toBe(state);
        expect(effects).toEqual([]);
    });

    it('retries a channel that previously failed', () => {
        const state = readyState();
        state.pools['studio:2'] = { status: PoolStatus.ERROR, scenes: [], error: 'boom' };
        const { effects } = run(state, { type: Events.POOL_REQUESTED, channelId: 'studio:2' });
        expect(effectTypes(effects)).toEqual(['fetchPool']);
    });

    it('ignores a channel that is not in the lineup', () => {
        const state = readyState();
        const { state: next, effects } = run(state, {
            type: Events.POOL_REQUESTED,
            channelId: 'studio:999'
        });
        expect(next).toBe(state);
        expect(effects).toEqual([]);
    });
});

describe('POOL_LOADED', () => {
    it('builds the channel\'s schedule', () => {
        const state = readyState({ pools: {}, schedules: {} });
        const { state: next } = run(state, {
            type: Events.POOL_LOADED,
            channelId: 'studio:2',
            scenes: scenes(3)
        });
        expect(next.pools['studio:2'].status).toBe(PoolStatus.READY);
        expect(next.schedules['studio:2'].entries).toHaveLength(3);
    });

    it('starts playback when the tuned channel\'s pool arrives', () => {
        const state = readyState({ pools: {}, schedules: {} });
        const { effects } = run(state, {
            type: Events.POOL_LOADED,
            channelId: 'studio:1',
            scenes: scenes(3)
        });
        expect(effectTypes(effects)).toEqual(['tuneViewer']);
    });

    it('stays silent for a channel nobody is watching', () => {
        const state = readyState({ pools: {}, schedules: {} });
        const { effects } = run(state, {
            type: Events.POOL_LOADED,
            channelId: 'studio:2',
            scenes: scenes(3)
        });
        expect(effects).toEqual([]);
    });

    it('produces an empty schedule for a channel with no usable scenes', () => {
        const state = readyState({ pools: {}, schedules: {} });
        const { state: next, effects } = run(state, {
            type: Events.POOL_LOADED,
            channelId: 'studio:1',
            scenes: []
        });
        expect(next.schedules['studio:1'].totalMs).toBe(0);
        expect(effects).toEqual([]);
    });
});

describe('POOL_FAILED', () => {
    it('marks the channel as failed without touching the others', () => {
        const { state } = run(readyState(), {
            type: Events.POOL_FAILED,
            channelId: 'studio:2',
            message: 'boom'
        });
        expect(state.pools['studio:2']).toEqual({ status: PoolStatus.ERROR, scenes: [], error: 'boom' });
        expect(state.pools['studio:1'].status).toBe(PoolStatus.READY);
    });
});

describe('TUNE', () => {
    it('switches channel, remembers it, and announces the change', () => {
        const { state, effects } = run(readyState(), { type: Events.TUNE, channelId: 'studio:2' });
        expect(state.tunedChannelId).toBe('studio:2');
        expect(state.guideScrollChannelId).toBe('studio:2');
        expect(effects).toContainEqual({
            type: 'persist',
            key: STORAGE_KEYS.tunedChannel,
            value: 'studio:2'
        });
        expect(effectTypes(effects)).toContain('announce');
    });

    it('does not scroll the guide for a direct guide-row tune', () => {
        const { state } = run(readyState(), {
            type: Events.TUNE,
            channelId: 'studio:2',
            scrollIntoView: false
        });

        expect(state.tunedChannelId).toBe('studio:2');
        expect(state.guideScrollChannelId).toBeNull();
    });

    it('names the programme in the announcement when there is one', () => {
        const { effects } = run(readyState(), { type: Events.TUNE, channelId: 'studio:1' });
        const announce = effects.find((e) => e.type === 'announce');
        expect(announce.message).toMatch(/^One\. Scene \d/);
    });

    it('says so when a channel has nothing scheduled', () => {
        const { effects } = run(readyState(), { type: Events.TUNE, channelId: 'studio:2' });
        expect(effects.find((e) => e.type === 'announce').message).toBe('Two. No programming');
    });

    it('falls back to "Untitled" when announcing a scene with no title', () => {
        const untitled = [{ id: 'u1', title: '', files: [{ duration: 1800 }] }];
        const state = readyState();
        state.schedules['studio:2'] = buildDaySchedule('studio:2', untitled, DAY_KEY);

        const { effects } = run(state, { type: Events.TUNE, channelId: 'studio:2' });

        expect(effects.find((e) => e.type === 'announce').message).toBe('Two. Untitled');
    });

    it('ignores a channel that does not exist', () => {
        const state = readyState();
        const { state: next, effects } = run(state, { type: Events.TUNE, channelId: 'nope' });
        expect(next).toBe(state);
        expect(effects).toEqual([]);
    });

    it('does not start video when autoplay is switched off', () => {
        const state = readyState();
        state.settings = { ...state.settings, guide_autoplay: false };
        const { effects } = run(state, { type: Events.TUNE, channelId: 'studio:1' });
        expect(effectTypes(effects)).not.toContain('tuneViewer');
    });
});

describe('EXPAND', () => {
    it('navigates to the live scene at the offset it had reached', () => {
        const state = readyState({ nowMs: NOON + 7 * MIN, windowStartMs: NOON });
        const { effects } = run(state, { type: Events.EXPAND, channelId: 'studio:1' });

        const nav = effects.find((e) => e.type === 'navigateToScene');
        expect(nav.sceneId).toMatch(/^s\d$/);
        expect(nav.offsetSeconds).toBeGreaterThan(0);
        expect(Number.isInteger(nav.offsetSeconds)).toBe(true);
    });

    it('does nothing for a channel with no programming', () => {
        const { effects } = run(readyState(), { type: Events.EXPAND, channelId: 'studio:2' });
        expect(effects).toEqual([]);
    });

    it('does nothing when the schedule has nothing at that time', () => {
        // An empty pool builds a schedule with no entries: there is a schedule,
        // but nothing in it to open.
        const state = readyState({
            schedules: { 'studio:1': buildDaySchedule('studio:1', [], DAY_KEY) }
        });
        expect(run(state, { type: Events.EXPAND, channelId: 'studio:1' }).effects).toEqual([]);
    });

    it('opens the programme the details are describing, not just what is live', () => {
        const state = readyState({ nowMs: NOON + 7 * MIN, windowStartMs: NOON });
        const live = run(state, { type: Events.EXPAND, channelId: 'studio:1' }).effects[0];
        const later = run(state, {
            type: Events.EXPAND,
            channelId: 'studio:1',
            timeMs: NOON + 40 * MIN
        }).effects[0];

        expect(later.sceneId).not.toBe(live.sceneId);
    });

    it('opens a programme that is not on yet at its start', () => {
        // Dropping into the middle of something scheduled for later would land
        // at an offset that means nothing yet.
        const state = readyState({ nowMs: NOON + 7 * MIN, windowStartMs: NOON });
        const { effects } = run(state, {
            type: Events.EXPAND,
            channelId: 'studio:1',
            timeMs: NOON + 40 * MIN
        });
        expect(effects[0].offsetSeconds).toBe(0);
    });
});

describe('PAN and GO_TO_NOW', () => {
    it('pans forward', () => {
        const { state } = run(readyState(), { type: Events.PAN, deltaMs: 30 * MIN });
        expect(state.windowStartMs).toBe(NOON + 30 * MIN);
    });

    it('will not pan back past the start of the broadcast day', () => {
        const { state } = run(readyState({ windowStartMs: DAY_START }), {
            type: Events.PAN,
            deltaMs: -HOUR
        });
        expect(state.windowStartMs).toBe(DAY_START);
    });

    it('will not pan more than a day ahead', () => {
        const { state } = run(readyState(), { type: Events.PAN, deltaMs: 5 * 24 * HOUR });
        expect(state.windowStartMs).toBe(DAY_START + 24 * HOUR);
    });

    it('returns an unchanged state when panning hits a limit', () => {
        const state = readyState({ windowStartMs: DAY_START });
        const { state: next } = run(state, { type: Events.PAN, deltaMs: -HOUR });
        expect(next).toBe(state);
    });

    it('jumps back to now, snapped to the half hour', () => {
        const state = readyState({
            nowMs: new Date(2026, 7, 22, 15, 47).getTime(),
            windowStartMs: DAY_START
        });
        const { state: next } = run(state, { type: Events.GO_TO_NOW });
        expect(new Date(next.windowStartMs).getHours()).toBe(15);
        expect(new Date(next.windowStartMs).getMinutes()).toBe(30);
    });
});

describe('focus movement', () => {
    it('sets focus directly', () => {
        const { state } = run(readyState(), {
            type: Events.FOCUS_CELL,
            channelId: 'studio:2',
            timeMs: NOON + MIN
        });
        expect(state.focus).toEqual({ channelId: 'studio:2', timeMs: NOON + MIN, source: 'sticky' });
    });

    it('moves down a channel keeping the time position', () => {
        const { state } = run(readyState(), { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });
        expect(state.focus).toEqual({ channelId: 'studio:2', timeMs: NOON, source: 'keyboard' });
    });

    it('stops at the first and last channel', () => {
        const top = readyState();
        expect(run(top, { type: Events.MOVE_FOCUS, axis: 'channel', delta: -1 }).state).toBe(top);

        const bottom = readyState({ focus: { channelId: 'studio:2', timeMs: NOON } });
        expect(run(bottom, { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 }).state).toBe(bottom);
    });

    it('moves to the next programme in time, landing on its start', () => {
        const state = readyState();
        const { state: next } = run(state, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 });

        // The schedule loops, so compare against offsets within a loop rather
        // than against first-loop absolute times.
        const schedule = state.schedules['studio:1'];
        const offsets = schedule.entries.map((e) => e.offsetMs);
        expect(offsets).toContain((next.focus.timeMs - DAY_START) % schedule.totalMs);
        expect(next.focus.timeMs).toBeGreaterThan(NOON);
    });

    it('moves back to the previous programme', () => {
        const state = readyState();
        const forward = run(state, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 }).state;
        const back = run(forward, { type: Events.MOVE_FOCUS, axis: 'time', delta: -1 }).state;
        // Back one from the next programme's start lands on the current one.
        expect(back.focus.timeMs).toBeLessThan(forward.focus.timeMs);
    });

    it('pans the window when focus walks off the right edge', () => {
        // A 1-hour window with 30-minute scenes: three steps right must scroll.
        const state = readyState();
        state.settings = { ...state.settings, guide_window_hours: 1 };

        let s = state;
        for (let i = 0; i < 4; i++) {
            s = run(s, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 }).state;
        }
        expect(s.windowStartMs).toBeGreaterThan(state.windowStartMs);
        expect(s.focus.timeMs).toBeGreaterThanOrEqual(s.windowStartMs);
    });

    it('pans the window when focus walks off the left edge', () => {
        const state = readyState({ windowStartMs: NOON });
        let s = state;
        for (let i = 0; i < 3; i++) {
            s = run(s, { type: Events.MOVE_FOCUS, axis: 'time', delta: -1 }).state;
        }
        expect(s.windowStartMs).toBeLessThan(state.windowStartMs);
    });

    it('does nothing without focus or channels', () => {
        const noFocus = readyState({ focus: null });
        expect(run(noFocus, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 }).state).toBe(noFocus);

        const noChannels = readyState({ channels: [] });
        expect(run(noChannels, { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 }).state).toBe(noChannels);
    });

    it('does nothing on a channel whose schedule has not loaded', () => {
        const state = readyState({ focus: { channelId: 'studio:2', timeMs: NOON } });
        expect(run(state, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 }).state).toBe(state);
    });

    it('does nothing on a channel with an empty schedule', () => {
        const state = readyState();
        state.schedules['studio:1'] = { entries: [], totalMs: 0 };
        expect(run(state, { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 }).state).toBe(state);
    });
});

describe('LAYOUT_CHANGED', () => {
    it('switches layout', () => {
        const { state } = run(readyState(), { type: Events.LAYOUT_CHANGED, layout: 'list' });
        expect(state.layout).toBe('list');
    });

    it('ignores a change to the layout already in use', () => {
        const state = readyState();
        expect(run(state, { type: Events.LAYOUT_CHANGED, layout: 'grid' }).state).toBe(state);
    });
});

describe('SET_MUTED', () => {
    it('applies and remembers the mute state', () => {
        const { state, effects } = run(readyState(), { type: Events.SET_MUTED, muted: false });
        expect(state.muted).toBe(false);
        expect(effects).toContainEqual({ type: 'setMuted', muted: false });
        expect(effects).toContainEqual({ type: 'persist', key: STORAGE_KEYS.muted, value: 'false' });
    });
});

describe('SETTINGS_LOADED', () => {
    it('adopts the loaded settings', () => {
        const settings = { ...createInitialState().settings, guide_window_hours: 6 };
        const { state } = run(createInitialState(), { type: Events.SETTINGS_LOADED, settings });
        expect(state.settings.guide_window_hours).toBe(6);
    });
});

describe('unknown events', () => {
    it('leave the state untouched', () => {
        const state = readyState();
        const { state: next, effects } = run(state, { type: 'NOT_A_REAL_EVENT' });
        expect(next).toBe(state);
        expect(effects).toEqual([]);
    });
});


describe('channel manager', () => {
    const managerState = (overrides = {}) => readyState(overrides);

    describe('PREFS_LOADED', () => {
        it('adopts stored prefs, sort and lineup', () => {
            const { state } = run(managerState(), {
                type: Events.PREFS_LOADED,
                prefs: { 'studio:1': { name: 'Renamed' } },
                sort: 'sceneCount',
                lineup: [{ source: 'tag', minScenes: 3 }]
            });
            expect(state.managerSort).toBe('sceneCount');
            expect(state.lineup).toEqual([{ source: 'tag', minScenes: 3 }]);
            expect(state.channels.find((c) => c.id === 'studio:1').name).toBe('Renamed');
        });

        it('keeps the current sort and lineup when the event omits them', () => {
            const { state } = run(managerState(), { type: Events.PREFS_LOADED, prefs: {} });
            expect(state.managerSort).toBe('name');
            expect(state.lineup).toEqual(managerState().lineup);
        });
    });

    describe('renaming and hiding', () => {
        it('renames a channel and persists it', () => {
            const { state, effects } = run(managerState(), {
                type: Events.SET_CHANNEL_PREF,
                channelId: 'studio:1',
                patch: { name: 'Short' }
            });
            expect(state.channels.find((c) => c.id === 'studio:1').name).toBe('Short');
            expect(effects.find((e) => e.type === 'persist').key).toBe(STORAGE_KEYS.prefs);
        });

        it('leaves the raw channel untouched so the rename can be undone', () => {
            const { state } = run(managerState(), {
                type: Events.SET_CHANNEL_PREF,
                channelId: 'studio:1',
                patch: { name: 'Short' }
            });
            expect(state.allChannels.find((c) => c.id === 'studio:1').name).toBe('One');
        });

        it('hides a channel, removing it from the guide', () => {
            const { state } = run(managerState(), { type: Events.TOGGLE_HIDDEN, channelId: 'studio:2' });
            expect(state.channels.map((c) => c.id)).toEqual(['studio:1']);
        });

        it('unhides again', () => {
            const hidden = run(managerState(), { type: Events.TOGGLE_HIDDEN, channelId: 'studio:2' }).state;
            const { state } = run(hidden, { type: Events.TOGGLE_HIDDEN, channelId: 'studio:2' });
            expect(state.channels.map((c) => c.id)).toEqual(['studio:1', 'studio:2']);
        });

        it('moves the tuned channel off one that was just hidden', () => {
            const { state } = run(managerState({ tunedChannelId: 'studio:2' }), {
                type: Events.TOGGLE_HIDDEN,
                channelId: 'studio:2'
            });
            expect(state.tunedChannelId).toBe('studio:1');
        });

        it('moves focus off a channel that was just hidden', () => {
            const { state } = run(
                managerState({ focus: { channelId: 'studio:2', timeMs: NOON } }),
                { type: Events.TOGGLE_HIDDEN, channelId: 'studio:2' }
            );
            expect(state.focus.channelId).toBe('studio:1');
        });

        it('copes with hiding the last visible channel', () => {
            const single = managerState({ channels: [channel('studio:1', 'One')], allChannels: [channel('studio:1', 'One')] });
            const { state } = run(single, { type: Events.TOGGLE_HIDDEN, channelId: 'studio:1' });
            expect(state.channels).toEqual([]);
            expect(state.tunedChannelId).toBeNull();
            expect(state.focus).toBeNull();
        });
    });

    describe('pinning', () => {
        it('lifts a pinned channel into the pinned group at the top', () => {
            const { state } = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2' });
            expect(state.channels.map((c) => c.id)).toEqual(['studio:2', 'studio:1']);
            expect(state.channelGroups[0].key).toBe('pinned');
        });

        it('unpins', () => {
            const pinned = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2' }).state;
            const { state } = run(pinned, { type: Events.TOGGLE_PIN, channelId: 'studio:2' });
            expect(state.pinOrder).toEqual([]);
            expect(state.channels.map((c) => c.id)).toEqual(['studio:1', 'studio:2']);
        });

        it('keeps pins in the order they were pinned', () => {
            let s2 = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2' }).state;
            s2 = run(s2, { type: Events.TOGGLE_PIN, channelId: 'studio:1' }).state;
            expect(s2.pinOrder).toEqual(['studio:2', 'studio:1']);
        });

        it('reorders a pin, which a timestamp could never express', () => {
            let s2 = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2' }).state;
            s2 = run(s2, { type: Events.TOGGLE_PIN, channelId: 'studio:1' }).state;

            const { state } = run(s2, { type: Events.MOVE_PIN, channelId: 'studio:1', toIndex: 0 });

            expect(state.pinOrder).toEqual(['studio:1', 'studio:2']);
            expect(state.channels.map((c) => c.id)).toEqual(['studio:1', 'studio:2']);
        });

        it('ignores a move for a channel that is not pinned', () => {
            const state = managerState();
            expect(run(state, { type: Events.MOVE_PIN, channelId: 'studio:1', toIndex: 0 }).state).toBe(state);
        });

        it('persists the pin order, not the prefs', () => {
            const { effects } = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2' });
            expect(effects.find((e) => e.type === 'persist').key).toBe(STORAGE_KEYS.pinOrder);
        });
    });

    describe('sorting', () => {
        it('leaves the guide alone and persists the choice', () => {
            // The control belongs to the manager dialog: it orders the list you
            // are looking at, not the guide behind it. The guide is always
            // alphabetical, which is what makes the A-Z rails mean anything.
            const state = managerState();
            state.allChannels = [
                { ...channel('studio:1', 'One'), sceneCount: 5 },
                { ...channel('studio:2', 'Two'), sceneCount: 90 }
            ];
            const { state: next, effects } = run(state, {
                type: Events.SET_MANAGER_SORT,
                sort: 'sceneCount'
            });

            expect(next.managerSort).toBe('sceneCount');
            expect(next.channels).toBe(state.channels);
            expect(next.channelGroups).toBe(state.channelGroups);
            expect(effects).toContainEqual({ type: 'persist', key: STORAGE_KEYS.sort, value: 'sceneCount' });
        });

        it('reloads the manager catalogue in the selected server order', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            const { effects } = run(open, { type: Events.SET_MANAGER_SORT, sort: 'sceneCount' });
            expect(effects).toContainEqual(expect.objectContaining({
                type: 'loadCatalogPage', sort: 'sceneCount', page: 1
            }));
        });

        it('ignores a change to the sort already in use', () => {
            const state = managerState();
            expect(run(state, { type: Events.SET_MANAGER_SORT, sort: 'name' }).state).toBe(state);
        });
    });

    describe('lineup changes', () => {
        it('persists the lineup and re-resolves channels from the server', () => {
            const lineup = [{ source: 'tag', minScenes: 2 }];
            const { state, effects } = run(managerState(), { type: Events.SET_LINEUP, lineup });

            expect(state.lineup).toEqual(lineup);
            expect(state.channelsStatus).toBe(PoolStatus.LOADING);
            expect(effectTypes(effects)).toEqual(['persist', 'loadChannels']);
        });
    });

    describe('the manager panel', () => {
        it('fetches the catalogue the first time it opens', () => {
            const { state, effects } = run(managerState(), { type: Events.MANAGER_OPEN });
            expect(state.managerOpen).toBe(true);
            expect(effectTypes(effects)).toEqual(['loadCatalogPage']);
            expect(effects[0]).toEqual(expect.objectContaining({ source: 'studio', page: 1, perPage: 50 }));
        });

        it('fetches only the source being browsed, not the whole catalogue', () => {
            const { effects } = run(managerState(), { type: Events.MANAGER_OPEN });
            expect(effects[0].source).toBe('studio');
        });

        it('fetches a source the first time it is selected', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            const { state, effects } = run(open, { type: Events.SET_MANAGER_SOURCE, source: 'tag' });

            expect(state.managerSource).toBe('tag');
            expect(effects).toEqual([expect.objectContaining({ type: 'loadCatalogPage', source: 'tag', page: 1 })]);
        });

        it('does not refetch a source it already has', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            const switched = run(open, { type: Events.SET_MANAGER_SOURCE, source: 'tag' });
            const loaded = run(switched.state, {
                type: Events.CATALOG_PAGE_LOADED,
                requestKey: switched.effects[0].requestKey,
                page: 1,
                channels: [],
                total: 0
            }).state;
            expect(run(loaded, { type: Events.SET_MANAGER_SOURCE, source: 'tag' }).effects).toEqual([]);
        });

        it('does not refetch the catalogue on a later open', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            const loaded = run(open, {
                type: Events.CATALOG_PAGE_LOADED,
                requestKey: 'studio||0|all',
                page: 1,
                channels: [],
                total: 0
            }).state;
            const closed = run(loaded, { type: Events.MANAGER_CLOSE }).state;
            expect(run(closed, { type: Events.MANAGER_OPEN }).effects).toEqual([]);
        });

        it('closes', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            expect(run(open, { type: Events.MANAGER_CLOSE }).state.managerOpen).toBe(false);
        });

        it('records the search query', () => {
            const { state, effects } = run(managerState(), { type: Events.MANAGER_SEARCH, query: 'als' });
            expect(state.managerSearch).toBe('als');
            expect(effectTypes(effects)).toEqual(['loadCatalogPage']);
        });

        it('keeps stale page results out of a newer search', () => {
            const first = run(managerState(), { type: Events.MANAGER_OPEN });
            const searched = run(first.state, { type: Events.MANAGER_SEARCH, query: 'new' });
            const { state } = run(searched.state, {
                type: Events.CATALOG_PAGE_LOADED,
                requestKey: first.effects[0].requestKey,
                page: 1,
                channels: [channel('studio:old', 'Old')],
                total: 1
            });
            expect(state.catalogRequests[searched.effects[0].requestKey].channels).toEqual([]);
        });

        it('adds one channel immediately and fetches only its pool', () => {
            const state = managerState({ pools: {}, schedules: {} });
            const added = channel('studio:9', 'Nine');
            const { state: next, effects } = run(state, {
                type: Events.MANAGER_CHANNEL_INCLUDED,
                channel: added,
                lineup: [{ source: 'studio', ids: ['1', '2', '9'] }]
            });
            expect(next.allChannels).toContainEqual(added);
            expect(effectTypes(effects)).toEqual(['persist', 'fetchPool']);
        });

        it('stores a loaded catalogue', () => {
            const catalog = { studio: [channel('studio:9', 'Nine')] };
            const { state } = run(managerState(), {
                type: Events.CATALOG_LOADED,
                source: 'studio',
                catalog
            });
            expect(state.catalog.studio).toEqual(catalog.studio);
            expect(state.catalogStatus.studio).toBe(PoolStatus.READY);
        });

        it('keeps catalogues for sources already fetched', () => {
            const first = run(managerState(), {
                type: Events.CATALOG_LOADED,
                source: 'studio',
                catalog: { studio: [channel('studio:9', 'Nine')] }
            }).state;
            const { state } = run(first, {
                type: Events.CATALOG_LOADED,
                source: 'tag',
                catalog: { tag: [] }
            });
            expect(state.catalog.studio).toHaveLength(1);
            expect(state.catalogStatus.studio).toBe(PoolStatus.READY);
        });

        it('falls back to the source being browsed when the event omits one', () => {
            const open = run(managerState(), { type: Events.MANAGER_OPEN }).state;
            const { state } = run(open, {
                type: Events.CATALOG_LOADED,
                catalog: { studio: [] }
            });
            expect(state.catalogStatus.studio).toBe(PoolStatus.READY);
        });

        it('falls back to the browsed source when a failure omits one', () => {
            const { state } = run(managerState(), { type: Events.CATALOG_FAILED, message: 'offline' });
            expect(state.catalogError.studio).toBe('offline');
        });

        it('records a catalogue failure', () => {
            const { state } = run(managerState(), {
                type: Events.CATALOG_FAILED,
                source: 'studio',
                message: 'offline'
            });
            expect(state.catalogStatus.studio).toBe(PoolStatus.ERROR);
            expect(state.catalogError.studio).toBe('offline');
        });
    });

    describe('per-channel scene cap', () => {
        it('overrides the global cap when fetching that channel\'s pool', () => {
            const state = managerState({ pools: {}, prefs: { 'studio:2': { poolCap: 400 } } });
            const { effects } = run(state, { type: Events.POOL_REQUESTED, channelId: 'studio:2' });
            expect(effects[0].poolCap).toBe(400);
        });

        it('falls back to the global cap without an override', () => {
            const state = managerState({ pools: {} });
            const { effects } = run(state, { type: Events.POOL_REQUESTED, channelId: 'studio:2' });
            expect(effects[0].poolCap).toBe(state.settings.guide_pool_cap);
        });
    });

    describe('keyboard order follows the visible order', () => {
        it('arrow-down moves to the next channel as displayed, not as resolved', () => {
            // Pin the second channel so display order is the reverse of raw order.
            const pinned = run(managerState(), { type: Events.TOGGLE_PIN, channelId: 'studio:2', nowMs: 5000 }).state;
            expect(pinned.channels.map((c) => c.id)).toEqual(['studio:2', 'studio:1']);

            const focused = { ...pinned, focus: { channelId: 'studio:2', timeMs: NOON } };
            const { state } = run(focused, { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });

            expect(state.focus.channelId).toBe('studio:1');
        });
    });
});

describe('grouping', () => {
    const mixed = () =>
        reduce(readyState(), {
            type: Events.CHANNELS_LOADED,
            channels: [
                channel('studio:1', 'Alpha'),
                channel('studio:2', 'Bravo'),
                { ...channel('tag:1', 'Beach'), source: 'tag' },
                { ...channel('performer:1', 'Riley'), source: 'performer' }
            ],
            errors: []
        }).state;

    it('emits a group per source in the declared order', () => {
        expect(mixed().channelGroups.map((g) => g.key)).toEqual(['studio', 'performer', 'tag']);
    });

    it('flattens groups into the visible order', () => {
        expect(mixed().channels.map((c) => c.id)).toEqual([
            'studio:1',
            'studio:2',
            'performer:1',
            'tag:1'
        ]);
    });

    it('collapsing a group removes its rows from the visible list', () => {
        const { state } = run(mixed(), { type: Events.TOGGLE_GROUP, key: 'studio' });
        expect(state.channels.map((c) => c.id)).toEqual(['performer:1', 'tag:1']);
        expect(state.channelGroups.find((g) => g.key === 'studio').collapsed).toBe(true);
    });

    it('keeps the collapsed group listed, with an honest count', () => {
        const { state } = run(mixed(), { type: Events.TOGGLE_GROUP, key: 'studio' });
        expect(state.channelGroups.find((g) => g.key === 'studio').count).toBe(2);
    });

    it('expands again', () => {
        const collapsed = run(mixed(), { type: Events.TOGGLE_GROUP, key: 'studio' }).state;
        const { state } = run(collapsed, { type: Events.TOGGLE_GROUP, key: 'studio' });
        expect(state.channels).toHaveLength(4);
    });

    it('persists collapsed groups', () => {
        const { effects } = run(mixed(), { type: Events.TOGGLE_GROUP, key: 'studio' });
        expect(effects[0].key).toBe(STORAGE_KEYS.collapsed);
    });

    it('never lets keyboard focus enter a collapsed group', () => {
        // Arrow-down from the last visible studio must skip into the next
        // group, not into a hidden row -- the Phase 2 invariant, under grouping.
        const collapsed = run(mixed(), { type: Events.TOGGLE_GROUP, key: 'performer' }).state;
        const focused = {
            ...collapsed,
            focus: { channelId: 'studio:2', timeMs: NOON, source: 'keyboard' }
        };

        const { state } = run(focused, { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });

        expect(state.focus.channelId).toBe('tag:1');
    });

    it('moves focus off a channel whose group was just collapsed', () => {
        const focused = { ...mixed(), focus: { channelId: 'tag:1', timeMs: NOON, source: 'keyboard' } };
        const { state } = run(focused, { type: Events.TOGGLE_GROUP, key: 'tag' });
        expect(state.channels.map((c) => c.id)).not.toContain('tag:1');
        expect(state.focus.channelId).toBe('studio:1');
    });

    it('keeps playing the tuned channel when its group is collapsed', () => {
        // Collapsing is about what is drawn. Retuning underneath the user
        // because a row stopped being shown is not something they asked for.
        const tuned = { ...mixed(), tunedChannelId: 'tag:1' };
        const { state, effects } = run(tuned, { type: Events.TOGGLE_GROUP, key: 'tag' });

        expect(state.tunedChannelId).toBe('tag:1');
        expect(state.channels.map((c) => c.id)).not.toContain('tag:1');
        expect(effects.filter((e) => e.type === 'tuneViewer')).toEqual([]);
    });

    it('keeps playing the tuned channel when every group is collapsed', () => {
        let state = mixed();
        state = { ...state, tunedChannelId: 'tag:1' };
        for (const key of ['studio', 'performer', 'tag']) {
            state = run(state, { type: Events.TOGGLE_GROUP, key }).state;
        }
        expect(state.channels).toEqual([]);
        expect(state.tunedChannelId).toBe('tag:1');
    });

    it('filters to just the pinned channels', () => {
        const pinned = run(mixed(), { type: Events.TOGGLE_PIN, channelId: 'tag:1' }).state;
        const { state } = run(pinned, { type: Events.SET_TYPE_FILTER, typeFilter: 'pinned' });

        expect(state.channels.map((c) => c.id)).toEqual(['tag:1']);
        expect(state.channelGroups.map((g) => g.key)).toEqual(['pinned']);
    });

    it('still drops a tuned channel that a search has narrowed away', () => {
        // Same code path, but a search is not a reason to stop playing either.
        const tuned = { ...mixed(), tunedChannelId: 'tag:1' };
        const { state } = run(tuned, { type: Events.GUIDE_SEARCH, query: 'alpha' });
        expect(state.tunedChannelId).toBe('tag:1');
    });
});

describe('guide search and type filter', () => {
    const mixed = () =>
        reduce(readyState(), {
            type: Events.CHANNELS_LOADED,
            channels: [
                channel('studio:1', 'Alpha'),
                { ...channel('tag:1', 'Alphabet'), source: 'tag' },
                { ...channel('tag:2', 'Beach'), source: 'tag' }
            ],
            errors: []
        }).state;

    it('narrows rows by name, case-insensitively', () => {
        const { state } = run(mixed(), { type: Events.GUIDE_SEARCH, query: 'ALPHA' });
        expect(state.channels.map((c) => c.id)).toEqual(['studio:1', 'tag:1']);
    });

    it('narrows rows to one source type', () => {
        const { state } = run(mixed(), { type: Events.SET_TYPE_FILTER, typeFilter: 'tag' });
        expect(state.channels.map((c) => c.id)).toEqual(['tag:1', 'tag:2']);
        expect(state.channelGroups.map((g) => g.key)).toEqual(['tag']);
    });

    it('combines search with the type filter', () => {
        const filtered = run(mixed(), { type: Events.SET_TYPE_FILTER, typeFilter: 'tag' }).state;
        const { state } = run(filtered, { type: Events.GUIDE_SEARCH, query: 'beach' });
        expect(state.channels.map((c) => c.id)).toEqual(['tag:2']);
    });

    it('never touches the lineup', () => {
        const { state, effects } = run(mixed(), { type: Events.SET_TYPE_FILTER, typeFilter: 'tag' });
        expect(state.lineup).toEqual(mixed().lineup);
        expect(effects).toEqual([]);
    });

    it('ignores a no-op change', () => {
        const state = mixed();
        expect(run(state, { type: Events.GUIDE_SEARCH, query: '' }).state).toBe(state);
        expect(run(state, { type: Events.SET_TYPE_FILTER, typeFilter: 'all' }).state).toBe(state);
    });
});

describe('the player', () => {
    it('changes mode and remembers it', () => {
        const { state, effects } = run(readyState(), {
            type: Events.SET_PLAYER_MODE,
            mode: 'theater'
        });
        expect(state.playerMode).toBe('theater');
        expect(effectTypes(effects)).toEqual(['setPlayerMode', 'persist']);
    });

    it('remembers theater as the mode to restore after fullscreen', () => {
        const { state } = run(readyState({ playerMode: 'theater' }), {
            type: Events.SET_PLAYER_MODE,
            mode: 'fullscreen'
        });

        expect(state.playerMode).toBe('fullscreen');
        expect(state.fullscreenReturnMode).toBe('theater');
    });

    it('ignores a mode it is already in', () => {
        const state = readyState();
        expect(run(state, { type: Events.SET_PLAYER_MODE, mode: 'corner' }).state).toBe(state);
    });

    it('ignores a pause it is already in', () => {
        const state = readyState();
        expect(run(state, { type: Events.SET_VIEWER_PAUSED, paused: false }).state).toBe(state);
    });

    it('pauses', () => {
        const { state, effects } = run(readyState(), { type: Events.SET_VIEWER_PAUSED, paused: true });
        expect(state.viewerPaused).toBe(true);
        expect(effects).toEqual([{ type: 'setPaused', paused: true }]);
    });

    it('remembers when the pause started, so the readout can freeze there', () => {
        const state = readyState({ nowMs: NOON + 7 * MIN });
        const paused = run(state, { type: Events.SET_VIEWER_PAUSED, paused: true }).state;
        expect(paused.pausedAtMs).toBe(NOON + 7 * MIN);

        // The schedule runs on while paused; the remembered instant does not.
        const later = run(paused, { type: Events.TICK, nowMs: NOON + 9 * MIN }).state;
        expect(later.pausedAtMs).toBe(NOON + 7 * MIN);

        const resumed = run(later, { type: Events.SET_VIEWER_PAUSED, paused: false }).state;
        expect(resumed.pausedAtMs).toBe(0);
    });

    it('does not retune a paused viewer when the programme changes', () => {
        // Otherwise the boundary watcher restarts playback under the user.
        const paused = run(readyState(), { type: Events.SET_VIEWER_PAUSED, paused: true }).state;
        const { effects } = run(paused, { type: Events.TICK, nowMs: NOON + HOUR });
        expect(effectTypes(effects)).not.toContain('tuneViewer');
    });

    it('re-syncs to live when unpaused, rather than resuming behind', () => {
        const paused = run(readyState(), { type: Events.SET_VIEWER_PAUSED, paused: true }).state;
        const { state, effects } = run(paused, { type: Events.SET_VIEWER_PAUSED, paused: false });
        expect(state.viewerPaused).toBe(false);
        expect(effectTypes(effects)).toContain('tuneViewer');
    });
});

describe('clicking a programme', () => {
    /** A time inside a programme that is definitely not live. */
    const futureStart = (state) => {
        const entries = state.schedules['studio:1'].entries;
        return DAY_START + entries[1].offsetMs + 1000;
    };

    it('pins the details of a scene that is not on, and nothing else', () => {
        // It used to stop the stream and put the scene up as a still, so idly
        // reading through the schedule killed whatever you were watching.
        const state = readyState();
        const { state: next, effects } = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: futureStart(state)
        });

        expect(next.focus.channelId).toBe('studio:1');
        expect(next.focus.timeMs).toBe(futureStart(state) - 1000);
        expect(effects).toEqual([]);
        expect(next.tunedChannelId).toBe(state.tunedChannelId);
        expect(next.viewerPaused).toBe(state.viewerPaused);
        expect(next.playerMode).toBe(state.playerMode);
    });

    it('pins them stickily, so a mouse leave cannot clear them', () => {
        const state = readyState();
        const { state: next } = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: futureStart(state)
        });
        expect(next.focus.source).toBe('sticky');
    });

    it('keeps the player running through a pinned programme boundary', () => {
        const state = readyState();
        const pinned = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: futureStart(state)
        }).state;

        const { effects } = run(pinned, { type: Events.TICK, nowMs: NOON + HOUR });
        expect(effectTypes(effects)).toContain('tuneViewer');
    });

    it('stays fullscreen', () => {
        const state = readyState({ playerMode: 'fullscreen' });
        const { state: next, effects } = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: futureStart(state)
        });

        expect(next.playerMode).toBe('fullscreen');
        expect(effectTypes(effects)).not.toContain('setPlayerMode');
    });

    it('tunes instead when the block is already live', () => {
        const { state, effects } = run(readyState(), {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: NOON
        });
        expect(effectTypes(effects)).toContain('tuneViewer');
    });

    it('leaves live details unpinned until the live block is clicked again', () => {
        const { state } = run(readyState(), {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: NOON
        });

        expect(state.focus.source).toBe('live');
    });

    it('tuning moves the details onto what is now playing', () => {
        // Otherwise clicking back to a live scene left the details describing
        // the programme you had pinned.
        const state = readyState();
        const pinned = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: futureStart(state)
        }).state;

        const { state: next } = run(pinned, { type: Events.TUNE, channelId: 'studio:1' });

        expect(next.focus.timeMs).not.toBe(pinned.focus.timeMs);
        expect(next.focus.timeMs).toBeLessThanOrEqual(NOON);
    });

    it('selects unpinned live details while the destination programming is loading', () => {
        const state = readyState();
        const { state: next } = run(state, { type: Events.TUNE, channelId: 'studio:2' });
        expect(next.focus).toEqual({ channelId: 'studio:2', timeMs: NOON, source: 'live' });
    });

    it('tuning also lifts a pause', () => {
        const paused = run(readyState(), { type: Events.SET_VIEWER_PAUSED, paused: true }).state;
        const { state, effects } = run(paused, { type: Events.TUNE, channelId: 'studio:2' });

        expect(state.viewerPaused).toBe(false);
        expect(effectTypes(effects)).toContain('announce');
    });

    it('ignores a channel with no schedule', () => {
        const state = readyState();
        expect(run(state, { type: Events.PIN_DETAILS, channelId: 'studio:2', timeMs: NOON }).state).toBe(state);
    });

    it('ignores an empty schedule', () => {
        const state = readyState();
        state.schedules['studio:1'] = { entries: [], totalMs: 0 };
        expect(run(state, { type: Events.PIN_DETAILS, channelId: 'studio:1', timeMs: NOON }).state).toBe(state);
    });
});

describe('the player size', () => {
    it('persists and restores the channel info minimized preference', () => {
        const minimized = run(readyState(), { type: Events.TOGGLE_CHANNEL_INFO });
        expect(minimized.state.channelInfoMinimized).toBe(true);
        expect(minimized.effects).toContainEqual({ type: 'persist', key: STORAGE_KEYS.channelInfoMinimized, value: 'true' });
        const restored = run(readyState(), { type: Events.PREFS_LOADED, prefs: {}, channelInfoMinimized: true });
        expect(restored.state.channelInfoMinimized).toBe(true);
        const expanded = run(restored.state, { type: Events.TOGGLE_CHANNEL_INFO });
        expect(expanded.state.channelInfoMinimized).toBe(false);
        expect(expanded.effects).toContainEqual({ type: 'persist', key: STORAGE_KEYS.channelInfoMinimized, value: 'false' });
    });

    it('clamps and persists a new width', () => {
        const { state, effects } = run(readyState(), { type: Events.SET_PLAYER_WIDTH, px: 400.4 });
        expect(state.playerWidthPx).toBe(400);
        expect(effects).toContainEqual({
            type: 'persist',
            key: STORAGE_KEYS.playerWidth,
            value: '400'
        });
    });

    it('will not go so small it is useless, or so big it crowds out the guide', () => {
        expect(run(readyState(), { type: Events.SET_PLAYER_WIDTH, px: 10 }).state.playerWidthPx).toBe(200);
        expect(run(readyState(), { type: Events.SET_PLAYER_WIDTH, px: 5000 }).state.playerWidthPx).toBe(640);
    });

    it('ignores a width it is already at', () => {
        const state = readyState();
        expect(run(state, { type: Events.SET_PLAYER_WIDTH, px: state.playerWidthPx }).state).toBe(state);
    });

    it('is restored with the other preferences', () => {
        const { state } = run(readyState(), {
            type: Events.PREFS_LOADED,
            prefs: {},
            playerWidthPx: 420
        });
        expect(state.playerWidthPx).toBe(420);
    });
});

describe('returning from another app', () => {
    it('re-establishes playback, which drift correction cannot do alone', () => {
        // iOS pauses the element on backgrounding and fires nothing useful.
        const { effects } = run(readyState(), { type: Events.RESUME_AFTER_HIDDEN });
        expect(effectTypes(effects)).toContain('tuneViewer');
    });

    it('leaves a deliberately paused viewer paused', () => {
        const paused = run(readyState(), { type: Events.SET_VIEWER_PAUSED, paused: true }).state;
        expect(run(paused, { type: Events.RESUME_AFTER_HIDDEN }).effects).toEqual([]);
    });

    it('does nothing when the guide is closed', () => {
        const closed = readyState({ open: false });
        expect(run(closed, { type: Events.RESUME_AFTER_HIDDEN }).effects).toEqual([]);
    });
});

describe('focus source', () => {
    it('records where the focus came from', () => {
        const hovered = run(readyState(), {
            type: Events.FOCUS_CELL,
            channelId: 'studio:1',
            timeMs: NOON,
            source: 'hover'
        }).state;
        expect(hovered.focus.source).toBe('hover');
    });

    it('treats an unsourced focus as sticky', () => {
        const { state } = run(readyState(), {
            type: Events.FOCUS_CELL,
            channelId: 'studio:1',
            timeMs: NOON
        });
        expect(state.focus.source).toBe('sticky');
    });

    it('marks keyboard movement as keyboard focus', () => {
        const { state } = run(readyState(), { type: Events.MOVE_FOCUS, axis: 'time', delta: 1 });
        expect(state.focus.source).toBe('keyboard');

        const across = run(readyState(), { type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });
        expect(across.state.focus.source).toBe('keyboard');
    });

    it('returns focus to the live programme when the mouse leaves', () => {
        const hovered = run(readyState(), {
            type: Events.FOCUS_CELL,
            channelId: 'studio:1',
            timeMs: NOON + 90 * MIN,
            source: 'hover'
        }).state;

        const { state } = run(hovered, { type: Events.FOCUS_LIVE });

        const live = state.schedules['studio:1'];
        expect(state.focus.channelId).toBe('studio:1');
        expect(state.focus.timeMs).toBeLessThanOrEqual(NOON);
        expect(live).toBeDefined();
    });

    it('does not disturb pinned details when the mouse leaves', () => {
        // Pinning is a deliberate choice; only a hover is transient.
        const state = readyState();
        const entries = state.schedules['studio:1'].entries;
        const pinned = run(state, {
            type: Events.PIN_DETAILS,
            channelId: 'studio:1',
            timeMs: DAY_START + entries[1].offsetMs + 1000
        }).state;

        expect(run(pinned, { type: Events.FOCUS_LIVE }).state).toBe(pinned);
    });

    it('clears the details when the tuned channel has no programming', () => {
        // Nothing live to fall back to. An empty banner is honest; leaving the
        // scene the mouse just left up would claim it is on.
        const state = readyState({ tunedChannelId: 'studio:2' });
        expect(run(state, { type: Events.FOCUS_LIVE }).state.focus).toBeNull();
    });
});
