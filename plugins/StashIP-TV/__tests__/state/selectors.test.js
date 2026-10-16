import * as sel from '../../src/state/selectors.js';
import { createInitialState, PoolStatus } from '../../src/state/initialState.js';
import { buildDaySchedule, dayBucket } from '../../src/domain/schedule.js';
import { groupChannels, flattenGroups } from '../../src/domain/channelPrefs.js';

const MIN = 60000;
const HOUR = 3600000;
const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();
const { key: DAY_KEY, startMs: DAY_START } = dayBucket(NOON);

const scenes = (n, minutes = 30) =>
    Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `Scene ${i + 1}`,
        details: `Details ${i + 1}`,
        files: [{ duration: minutes * 60 }]
    }));

const chan = (id, name) => ({ id, source: 'studio', name, logo: {}, sceneFilter: {} });

function state(overrides = {}) {
    const base = {
        ...createInitialState(),
        open: true,
        nowMs: NOON,
        dayKey: DAY_KEY,
        dayStartMs: DAY_START,
        windowStartMs: NOON,
        allChannels: [chan('studio:1', 'One'), chan('studio:2', 'Two')],
        channels: [chan('studio:1', 'One'), chan('studio:2', 'Two')],
        tunedChannelId: 'studio:1',
        focus: { channelId: 'studio:1', timeMs: NOON },
        pools: { 'studio:1': { status: PoolStatus.READY, scenes: scenes(4), error: null } },
        schedules: { 'studio:1': buildDaySchedule('studio:1', scenes(4), DAY_KEY) }
    };
    return { ...base, ...overrides };
}

describe('window', () => {
    it('derives its width from the setting', () => {
        expect(sel.windowMs(state())).toBe(3 * HOUR);
        expect(sel.windowEndMs(state())).toBe(NOON + 3 * HOUR);
    });
});

describe('channel selectors', () => {
    it('finds the tuned channel', () => {
        expect(sel.tunedChannel(state()).name).toBe('One');
    });

    it('returns null when nothing is tuned', () => {
        expect(sel.tunedChannel(state({ tunedChannelId: null }))).toBeNull();
    });

    it('reports pool status, defaulting to idle', () => {
        expect(sel.poolStatus(state(), 'studio:1')).toBe(PoolStatus.READY);
        expect(sel.poolStatus(state(), 'studio:2')).toBe(PoolStatus.IDLE);
    });

    it('reports whether the lineup resolved to anything', () => {
        expect(sel.hasChannels(state())).toBe(true);
        expect(sel.hasChannels(state({ allChannels: [] }))).toBe(false);
    });

    it('still reports channels when every group is collapsed', () => {
        // The visible list is empty, but the library plainly has channels --
        // telling the user to lower the minimum scene count would be nonsense.
        expect(sel.hasChannels(state({ channels: [] }))).toBe(true);
    });

    it('distinguishes a filter that matched nothing from a collapsed guide', () => {
        expect(sel.isFilteredEmpty(state({ channels: [] }))).toBe(false);
        expect(sel.isFilteredEmpty(state({ channels: [], guideSearch: 'zzz' }))).toBe(true);
        expect(sel.isFilteredEmpty(state({ channels: [], typeFilter: 'tag' }))).toBe(true);
        // Nothing to narrow in the first place.
        expect(sel.isFilteredEmpty(state({ allChannels: [], channels: [], guideSearch: 'z' }))).toBe(false);
    });

    it('counts the channels in the guide regardless of collapse', () => {
        const s = state({
            channels: [],
            channelGroups: [
                { key: 'studio', channels: [], collapsed: true, count: 7 },
                { key: 'tag', channels: [], collapsed: true, count: 3 }
            ]
        });
        expect(sel.channelCount(s)).toBe(10);
    });

    it('finds the tuned channel even while its group is collapsed', () => {
        expect(sel.tunedChannel(state({ channels: [] })).name).toBe('One');
    });

    it('exposes load status and errors', () => {
        expect(sel.isLoading(state({ channelsStatus: PoolStatus.LOADING }))).toBe(true);
        expect(sel.loadError(state({ channelsError: 'x' }))).toBe('x');
        expect(sel.sourceErrors(state({ sourceErrors: [{ source: 'tag' }] }))).toHaveLength(1);
        expect(sel.isOpen(state())).toBe(true);
        expect(sel.isGridLayout(state())).toBe(true);
        expect(sel.isGridLayout(state({ layout: 'list' }))).toBe(false);
        expect(sel.channels(state())).toHaveLength(2);
    });
});

describe('programme selectors', () => {
    it('reports what is live now', () => {
        const live = sel.liveProgram(state(), 'studio:1');
        expect(live.startMs).toBeLessThanOrEqual(NOON);
        expect(live.endMs).toBeGreaterThan(NOON);
    });

    it('reports what follows it, contiguously', () => {
        const s = state();
        const live = sel.liveProgram(s, 'studio:1');
        const next = sel.nextProgram(s, 'studio:1');
        expect(next.startMs).toBe(live.endMs);
    });

    it('returns null for a channel with no schedule', () => {
        expect(sel.liveProgram(state(), 'studio:2')).toBeNull();
        expect(sel.nextProgram(state(), 'studio:2')).toBeNull();
    });

    it('returns null for an empty schedule', () => {
        const s = state({ schedules: { 'studio:1': { entries: [], totalMs: 0 } } });
        expect(sel.liveProgram(s, 'studio:1')).toBeNull();
        expect(sel.nextProgram(s, 'studio:1')).toBeNull();
    });

    it('reports progress through the live programme as a fraction', () => {
        // Scenes are 30 min and the day divides evenly, so noon starts one.
        expect(sel.liveProgress(state(), 'studio:1')).toBe(0);
        expect(sel.liveProgress(state({ nowMs: NOON + 15 * MIN }), 'studio:1')).toBeCloseTo(0.5, 5);
    });

    it('reports zero progress when there is nothing playing', () => {
        expect(sel.liveProgress(state(), 'studio:2')).toBe(0);
    });
});

describe('rowBlocks', () => {
    it('fills the window with contiguous blocks', () => {
        const blocks = sel.rowBlocks(state(), 'studio:1');
        expect(blocks.length).toBeGreaterThan(0);
        for (const b of blocks) {
            expect(b.rect.leftPct).toBeGreaterThanOrEqual(0);
            expect(b.rect.leftPct + b.rect.widthPct).toBeLessThanOrEqual(100.000001);
        }
    });

    it('marks exactly one block as live', () => {
        expect(sel.rowBlocks(state(), 'studio:1').filter((b) => b.isLive)).toHaveLength(1);
    });

    it('marks the focused block', () => {
        const focused = sel.rowBlocks(state(), 'studio:1').filter((b) => b.isFocused);
        expect(focused).toHaveLength(1);
    });

    it('marks nothing focused on an unfocused channel', () => {
        const s = state({
            schedules: {
                'studio:1': buildDaySchedule('studio:1', scenes(4), DAY_KEY),
                'studio:2': buildDaySchedule('studio:2', scenes(4), DAY_KEY)
            }
        });
        expect(sel.rowBlocks(s, 'studio:2').some((b) => b.isFocused)).toBe(false);
    });

    it('returns nothing for a channel with no schedule', () => {
        expect(sel.rowBlocks(state(), 'studio:2')).toEqual([]);
    });
});

describe('focus selectors', () => {
    it('describes the focused programme for the banner', () => {
        const p = sel.focusedProgram(state());
        expect(p.scene.title).toMatch(/^Scene /);
    });

    it('names the focused channel', () => {
        expect(sel.focusedChannel(state()).name).toBe('One');
    });

    it('returns null without focus', () => {
        expect(sel.focusedProgram(state({ focus: null }))).toBeNull();
        expect(sel.focusedChannel(state({ focus: null }))).toBeNull();
    });

    it('returns null when the focused channel has no schedule yet', () => {
        expect(sel.focusedProgram(state({ focus: { channelId: 'studio:2', timeMs: NOON } }))).toBeNull();
    });

    it('returns null when the focused channel vanished from the lineup', () => {
        expect(sel.focusedChannel(state({ focus: { channelId: 'gone', timeMs: NOON } }))).toBeNull();
    });
});

describe('grid furniture', () => {
    it('emits half-hourly ticks across the window', () => {
        expect(sel.ticks(state())).toHaveLength(6);
    });

    it('positions the now-line inside the window', () => {
        expect(sel.nowMarkerPct(state())).toBe(0);
        expect(sel.nowMarkerPct(state({ nowMs: NOON + 90 * MIN }))).toBeCloseTo(50, 5);
    });

    it('hides the now-line when the window is panned away from now', () => {
        expect(sel.nowMarkerPct(state({ windowStartMs: NOON + 5 * HOUR }))).toBeNull();
    });
});

describe('channel manager selectors', () => {
    const cat = (id, name, source = 'studio') => ({
        id, source, name, logo: {}, sceneCount: 5, sceneFilter: {}
    });

    const managerState = (overrides = {}) =>
        state({
            managerOpen: true,
            managerSearch: '',
            sort: 'name',
            lineup: [{ source: 'studio', minScenes: 5 }],
            catalog: { studio: [cat('studio:1', 'Alpha'), cat('studio:9', 'Omega')] },
            allChannels: [cat('studio:1', 'Alpha')],
            prefs: {},
            ...overrides
        });

    it('exposes manager state', () => {
        const s = managerState({
            managerSource: 'studio',
            catalogStatus: { studio: PoolStatus.READY }
        });
        expect(sel.isManagerOpen(s)).toBe(true);
        expect(sel.sortMode(s)).toBe('name');
        expect(sel.managerSource(s)).toBe('studio');
        expect(sel.catalogStatus(s)).toBe(PoolStatus.READY);
        expect(sel.catalogError(s)).toBeNull();
    });

    it('reports status and errors per source', () => {
        const s = managerState({
            managerSource: 'studio',
            catalogStatus: { tag: PoolStatus.ERROR },
            catalogError: { tag: 'offline' }
        });
        expect(sel.catalogStatus(s, 'tag')).toBe(PoolStatus.ERROR);
        expect(sel.catalogError(s, 'tag')).toBe('offline');
        // A source never fetched is idle, not errored.
        expect(sel.catalogStatus(s, 'studio')).toBe(PoolStatus.IDLE);
    });

    it('finds the rule entry for a source', () => {
        expect(sel.lineupRule(managerState(), 'studio')).toEqual({ source: 'studio', minScenes: 5 });
        expect(sel.lineupRule(managerState(), 'tag')).toBeNull();
    });

    it('does not mistake an explicit-picks entry for a rule', () => {
        const s = managerState({ lineup: [{ source: 'studio', ids: ['1'] }] });
        expect(sel.lineupRule(s, 'studio')).toBeNull();
        expect(sel.explicitIds(s, 'studio')).toEqual(['1']);
    });

    it('reports no explicit picks when there are none', () => {
        expect(sel.explicitIds(managerState(), 'studio')).toEqual([]);
    });

    it('marks which catalogue rows are already in the guide', () => {
        const rows = sel.catalogRows(managerState(), 'studio');
        expect(rows.map((r) => [r.channel.id, r.included])).toEqual([
            ['studio:1', true],
            ['studio:9', false]
        ]);
    });

    it('filters catalogue rows by the search query', () => {
        const rows = sel.catalogRows(managerState({ managerSearch: ' OME ' }), 'studio');
        expect(rows.map((r) => r.channel.id)).toEqual(['studio:9']);
    });

    it('reports pinned, hidden and the raw pref for each row', () => {
        const s = managerState({
            prefs: { 'studio:1': { hidden: true, name: 'A' } },
            pinOrder: ['studio:1']
        });
        const [row] = sel.catalogRows(s, 'studio');
        expect(row.pinned).toBe(true);
        expect(row.hidden).toBe(true);
        expect(row.pref.name).toBe('A');
    });

    it('returns nothing for a source with no catalogue yet', () => {
        expect(sel.catalogRows(managerState({ catalog: {} }), 'studio')).toEqual([]);
        expect(sel.catalogRows(managerState(), 'tag')).toEqual([]);
    });
});


describe('the playback clock', () => {
    it('tracks the wall clock while playing', () => {
        expect(sel.playbackNowMs(state())).toBe(NOON);
    });

    it('freezes at the pause point while paused', () => {
        const paused = state({ viewerPaused: true, pausedAtMs: NOON - 5 * MIN, nowMs: NOON });
        expect(sel.playbackNowMs(paused)).toBe(NOON - 5 * MIN);
    });

    it('ignores a stale pause instant once playing again', () => {
        expect(sel.playbackNowMs(state({ viewerPaused: false, pausedAtMs: NOON - MIN }))).toBe(NOON);
        // Paused before the clock ever ran: nothing to freeze at.
        expect(sel.playbackNowMs(state({ viewerPaused: true, pausedAtMs: 0 }))).toBe(NOON);
    });

    it('describes the tuned programme against the frozen clock', () => {
        // Paused twenty minutes ago, the readout must describe the schedule as
        // it stood then -- not as it stands now.
        const pausedAtMs = NOON - 20 * MIN;
        const paused = sel.tunedProgram(state({ viewerPaused: true, pausedAtMs }));
        const thenLive = sel.liveProgram(state({ nowMs: pausedAtMs }), 'studio:1');

        expect(paused.elapsedMs).toBe(thenLive.elapsedMs);
        expect(paused.elapsedMs).not.toBe(sel.tunedProgram(state()).elapsedMs);
        expect(sel.tunedProgram(state({ tunedChannelId: 'studio:2' }))).toBeNull();
    });
});

describe('guide navigation selectors', () => {
    const chan = (id, name, source = 'studio') => ({
        id, source, name, logo: {}, sceneCount: 5, sceneFilter: {}
    });

    // The rail reads `channelGroups`, so derive it the way the reducer does
    // rather than hand-writing a shape that could drift from the real one.
    const navState = (overrides = {}) => {
        const sourceOrder = ['studio', 'performer', 'tag', 'group', 'savedFilter'];
        const allChannels = overrides.allChannels || [
            chan('studio:1', 'Alpha'),
            chan('studio:2', 'Bravo'),
            chan('tag:1', 'Beach', 'tag')
        ];
        const collapsedGroups = overrides.collapsedGroups || [];
        const channelGroups = groupChannels(allChannels, { sourceOrder, collapsed: collapsedGroups });

        return state({
            sourceOrder,
            allChannels,
            collapsedGroups,
            channelGroups,
            channels: flattenGroups(channelGroups),
            ...overrides
        });
    };

    it('offers a button per source type actually present', () => {
        expect(sel.availableTypes(navState())).toEqual(['studio', 'tag']);
    });

    it('offers Pinned as a grouping of its own once something is pinned', () => {
        // Pinned is a group in the guide like any other, so it belongs in the
        // same row of buttons -- first, since that is where the group sits.
        expect(sel.availableTypes(navState({ pinOrder: ['studio:1'] }))).toEqual([
            'pinned',
            'studio',
            'tag'
        ]);
    });

    it('reports a single type when that is all there is', () => {
        const single = navState({ allChannels: [chan('studio:1', 'Alpha')] });
        expect(sel.availableTypes(single)).toEqual(['studio']);
    });

    it('lists the first letters present in one group, sorted', () => {
        expect(sel.groupLetters(navState(), 'studio')).toEqual(['A', 'B']);
        expect(sel.groupLetters(navState(), 'tag')).toEqual(['B']);
    });

    it('offers no letters for a collapsed group or one that is not there', () => {
        expect(sel.groupLetters(navState({ collapsedGroups: ['studio'] }), 'studio')).toEqual([]);
        expect(sel.groupLetters(navState(), 'performer')).toEqual([]);
    });

    it('tolerates a channel with no name', () => {
        const s2 = navState({ allChannels: [{ id: 'studio:9', source: 'studio', logo: {} }] });
        expect(sel.groupLetters(s2, 'studio')).toEqual(['#']);
    });

    it('matches a nameless channel under # when jumping', () => {
        const s2 = navState({ allChannels: [{ id: 'studio:9', source: 'studio', logo: {} }] });
        expect(sel.firstChannelForLetterInGroup(s2, 'studio', '#')).toBe('studio:9');
    });

    it('falls back to name order for a sort mode it does not know', () => {
        const s2 = state({
            managerSource: 'studio',
            managerSearch: '',
            managerSort: 'nonsense',
            catalog: { studio: [chan('studio:2', 'Bravo'), chan('studio:1', 'Alpha')] },
            allChannels: []
        });
        expect(sel.catalogRows(s2).map((r) => r.channel.name)).toEqual(['Alpha', 'Bravo']);
    });

    it('defaults the catalogue source to the one being browsed', () => {
        const s2 = state({
            managerSource: 'studio',
            managerSearch: '',
            catalog: { studio: [{ id: 'studio:1', source: 'studio', name: 'A', logo: {}, sceneCount: 1 }] },
            allChannels: []
        });
        expect(sel.catalogRows(s2)).toHaveLength(1);
    });

    it('files a non-alphabetic name under #', () => {
        const s = navState({ allChannels: [chan('studio:9', '3D Available')] });
        expect(sel.groupLetters(s, 'studio')).toEqual(['#']);
    });

    it('finds the first channel in the group for a letter', () => {
        expect(sel.firstChannelForLetterInGroup(navState(), 'studio', 'B')).toBe('studio:2');
        expect(sel.firstChannelForLetterInGroup(navState(), 'studio', 'A')).toBe('studio:1');
    });

    it('stays inside its own group', () => {
        // 'Beach' is a tag; jumping to B in the studios must not reach it.
        expect(sel.firstChannelForLetterInGroup(navState(), 'tag', 'B')).toBe('tag:1');
        expect(sel.firstChannelForLetterInGroup(navState(), 'studio', 'B')).toBe('studio:2');
    });

    it('returns null when no channel in the group starts with that letter', () => {
        expect(sel.firstChannelForLetterInGroup(navState(), 'studio', 'Z')).toBeNull();
        expect(sel.firstChannelForLetterInGroup(navState(), 'nope', 'A')).toBeNull();
    });

    it('finds a non-alphabetic channel under #', () => {
        const s = navState({ allChannels: [chan('tag:9', '3D Available', 'tag')] });
        expect(sel.firstChannelForLetterInGroup(s, 'tag', '#')).toBe('tag:9');
    });

    it('exposes player and layout state', () => {
        const s = navState({ playerMode: 'theater', viewerPaused: true });
        expect(sel.playerMode(s)).toBe('theater');
        expect(sel.isViewerPaused(s)).toBe(true);
        expect(sel.playerWidthPx(navState({ playerWidthPx: 320 }))).toBe(320);
        expect(sel.guideSearch(navState({ guideSearch: 'x' }))).toBe('x');
        expect(sel.typeFilter(navState({ typeFilter: 'tag' }))).toBe('tag');
        expect(sel.channelGroups(navState({ channelGroups: [{ key: 'studio' }] }))).toHaveLength(1);
    });
});
