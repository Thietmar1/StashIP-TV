/**
 * Integration: real store, real reducer, real views, real DOM.
 *
 * These drive the guide the way a user does -- dispatching events and asserting
 * what appears -- rather than testing view internals.
 */

import { createStore } from '../../src/state/store.js';
import { createOverlay, HASH, BODY_CLASS } from '../../src/ui/overlay.js';
import { createGrid } from '../../src/ui/grid.js';
import { createList } from '../../src/ui/list.js';
import { createBanner } from '../../src/ui/banner.js';
import { createAnnouncer } from '../../src/ui/a11y.js';
import { createTouchGuard } from '../../src/ui/gestures.js';
import { Events } from '../../src/state/actions.js';
import { buildDaySchedule, dayBucket } from '../../src/domain/schedule.js';
import { PoolStatus } from '../../src/state/initialState.js';
import { createInitialState } from '../../src/state/initialState.js';
import { groupChannels, flattenGroups } from '../../src/domain/channelPrefs.js';
import { KNOWN_SOURCES } from '../../src/domain/lineup.js';
import { relatedChannel } from '../../src/domain/relatedChannel.js';

const MIN = 60000;
const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();
const { key: DAY_KEY, startMs: DAY_START } = dayBucket(NOON);

const scenes = (n, minutes = 30) =>
    Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `Scene ${i + 1}`,
        details: `Description ${i + 1}`,
        paths: { stream: `/scene/${i + 1}/stream`, screenshot: `/scene/${i + 1}/shot` },
        files: [{ duration: minutes * 60 }]
    }));

const channel = (id, name) => ({
    id,
    source: 'studio',
    name,
    logo: { type: 'monogram', initials: 'XX', hue: 200 },
    sceneCount: 10,
    sceneFilter: { studios: { value: [id], modifier: 'INCLUDES' } }
});

function baseState(overrides = {}) {
    const state = {
        ...createInitialState(),
        open: true,
        nowMs: NOON,
        dayKey: DAY_KEY,
        dayStartMs: DAY_START,
        windowStartMs: NOON,
        allChannels: [channel('studio:1', 'Channel One'), channel('studio:2', 'Channel Two')],
        channels: [channel('studio:1', 'Channel One'), channel('studio:2', 'Channel Two')],
        channelsStatus: PoolStatus.READY,
        tunedChannelId: 'studio:1',
        focus: { channelId: 'studio:1', timeMs: NOON },
        pools: { 'studio:1': { status: PoolStatus.READY, scenes: scenes(4), error: null } },
        schedules: { 'studio:1': buildDaySchedule('studio:1', scenes(4), DAY_KEY) },
        ...overrides
    };

    // The guide renders from groups now, so a fixture has to carry them.
    state.channelGroups = groupChannels(state.allChannels, {
        prefs: state.prefs,
        pinOrder: state.pinOrder,
        sourceOrder: KNOWN_SOURCES,
        collapsed: state.collapsedGroups
    });
    state.channels = flattenGroups(state.channelGroups);
    return state;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('grid rendering', () => {
    function mountGrid(state) {
        const store = createStore({ initialState: state });
        const grid = createGrid({
            store,
            onRowVisible: jest.fn(),
            touchGuard: createTouchGuard()
        });
        document.body.appendChild(grid.element);
        grid.render(store.getState());
        return { store, grid };
    }

    it('uses ARIA grid roles', () => {
        const { grid } = mountGrid(baseState());
        expect(grid.element.querySelector('[role="grid"]')).not.toBeNull();
        expect(grid.element.querySelectorAll('.tvguide-row')).toHaveLength(2);
        expect(grid.element.querySelectorAll('[role="rowheader"]')).toHaveLength(2);
        // Plus a group header row for the Studios group.
        expect(grid.element.querySelectorAll('.tvguide-group')).toHaveLength(1);
    });

    it('renders a row per channel with its name', () => {
        const { grid } = mountGrid(baseState());
        const names = Array.from(grid.element.querySelectorAll('.tvguide-row-name')).map(
            (n) => n.textContent
        );
        expect(names).toEqual(['Channel One', 'Channel Two']);
    });

    it('renders programme blocks positioned by percentage', () => {
        const { grid } = mountGrid(baseState());
        const blocks = grid.element.querySelectorAll('.tvguide-block');
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            expect(block.style.left).toMatch(/%$/);
            expect(block.style.width).toMatch(/%$/);
        }
    });

    it('marks exactly one block live and one focused', () => {
        const { grid } = mountGrid(baseState());
        expect(grid.element.querySelectorAll('.tvguide-block-live')).toHaveLength(1);
        expect(grid.element.querySelectorAll('.tvguide-block-focused')).toHaveLength(1);
    });

    it('keeps exactly one cell tabbable (roving tabindex)', () => {
        const { grid } = mountGrid(baseState());
        const tabbable = Array.from(grid.element.querySelectorAll('.tvguide-block')).filter(
            (b) => b.getAttribute('tabindex') === '0'
        );
        expect(tabbable).toHaveLength(1);
    });

    it('shows a skeleton for a channel whose pool has not arrived', () => {
        const { grid } = mountGrid(baseState());
        const row = grid.element.querySelector('[data-channel-id="studio:2"]');
        expect(row.querySelector('.tvguide-row-skeleton')).not.toBeNull();
    });

    it('reports a channel that failed to load', () => {
        const state = baseState();
        state.pools['studio:2'] = { status: PoolStatus.ERROR, scenes: [], error: 'boom' };
        const { grid } = mountGrid(state);
        const row = grid.element.querySelector('[data-channel-id="studio:2"]');
        expect(row.textContent).toContain('Could not load');
    });

    it('says so when a channel has no programming', () => {
        const state = baseState();
        state.pools['studio:2'] = { status: PoolStatus.READY, scenes: [], error: null };
        state.schedules['studio:2'] = buildDaySchedule('studio:2', [], DAY_KEY);
        const { grid } = mountGrid(state);
        expect(grid.element.querySelector('[data-channel-id="studio:2"]').textContent).toContain(
            'No programming'
        );
    });

    it('renders clock labels across the head', () => {
        const { grid } = mountGrid(baseState());
        const labels = Array.from(grid.element.querySelectorAll('.tvguide-tick')).map(
            (t) => t.textContent
        );
        expect(labels).toEqual(['12:00 PM', '12:30 PM', '1:00 PM', '1:30 PM', '2:00 PM', '2:30 PM']);
    });

    it('positions the now-line and hides it when panned away', () => {
        const { grid } = mountGrid(baseState({ nowMs: NOON + 90 * MIN }));
        const line = grid.element.querySelector('.tvguide-nowline');
        expect(line.style.left).toBe('50%');

        grid.render(baseState({ windowStartMs: NOON + 10 * 3600000 }));
        expect(line.style.display).toBe('none');
    });

    it('tunes the channel when the live block is clicked', () => {
        const { store, grid } = mountGrid(baseState({ tunedChannelId: 'studio:2' }));
        const row = grid.element.querySelector('[data-channel-id="studio:1"]');
        row.querySelector('.tvguide-block-live').click();
        expect(store.getState().tunedChannelId).toBe('studio:1');
    });

    it('pins the details, rather than tuning, when a block that is not on is clicked', () => {
        const { store, grid } = mountGrid(baseState({ tunedChannelId: 'studio:2' }));
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const future = [...blocks].find((b) => !b.classList.contains('tvguide-block-live'));

        future.click();

        expect(store.getState().focus.channelId).toBe('studio:1');
        expect(store.getState().focus.source).toBe('sticky');
        // The player is left strictly alone.
        expect(store.getState().tunedChannelId).toBe('studio:2');
        expect(store.getState().viewerPaused).toBe(false);
    });

    it('shows a programme in the details on hover', () => {
        const { store, grid } = mountGrid(baseState());
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const target = blocks[blocks.length - 1];

        target.dispatchEvent(new MouseEvent('mouseenter'));

        expect(store.getState().focus.timeMs).toBe(Number(target.dataset.startMs));
        expect(store.getState().focus.source).toBe('hover');
    });

    it('ignores the synthetic mouseenter that follows a tap', () => {
        const store = createStore({ initialState: baseState() });
        const touchGuard = createTouchGuard();
        const grid = createGrid({ store, onRowVisible: jest.fn(), touchGuard });
        document.body.appendChild(grid.element);
        grid.render(store.getState());

        const before = store.getState().focus.timeMs;
        touchGuard.noteTouch(); // a finger just lifted
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        blocks[blocks.length - 1].dispatchEvent(new MouseEvent('mouseenter'));

        expect(store.getState().focus.timeMs).toBe(before);
    });

    it('updates the row header when a channel is renamed', () => {
        // Regression: a rename changes neither the id list nor the block set,
        // so keying the rebuild on ids alone left the old name on screen.
        const { store, grid } = mountGrid(baseState());
        expect(grid.element.querySelector('.tvguide-row-name').textContent).toBe('Channel One');

        store.dispatch({
            type: Events.SET_CHANNEL_PREF,
            channelId: 'studio:1',
            patch: { name: 'Renamed' }
        });
        grid.render(store.getState());

        // The rename also re-sorts it -- "Renamed" now follows "Channel Two" --
        // so look the row up by channel rather than by position.
        const renamed = grid.element.querySelector('[data-channel-id="studio:1"] .tvguide-row-name');
        expect(renamed.textContent).toBe('Renamed');
    });

    it('updates the row badge when a custom logo is set', () => {
        const { store, grid } = mountGrid(baseState());
        store.dispatch({
            type: Events.SET_CHANNEL_PREF,
            channelId: 'studio:1',
            patch: { logoUrl: '/custom.png' }
        });
        grid.render(store.getState());

        const badge = grid.element.querySelector('[data-channel-id="studio:1"] .tvguide-logo');
        expect(badge.tagName).toBe('IMG');
        expect(badge.getAttribute('src')).toBe('/custom.png');
    });

    it('does not rebuild blocks on a plain clock tick', () => {
        const { store, grid } = mountGrid(baseState());
        const block = grid.element.querySelector('.tvguide-block');

        store.dispatch({ type: Events.TICK, nowMs: NOON + 1000 });
        grid.render(store.getState());

        // Same node: a tick restyles, it does not replace the DOM.
        expect(grid.element.querySelector('.tvguide-block')).toBe(block);
    });

    it('rebuilds blocks when the window pans', () => {
        const { store, grid } = mountGrid(baseState());
        const block = grid.element.querySelector('.tvguide-block');

        store.dispatch({ type: Events.PAN, deltaMs: 60 * MIN });
        grid.render(store.getState());

        expect(grid.element.querySelector('.tvguide-block')).not.toBe(block);
    });
});

describe('list rendering', () => {
    function mountList(state) {
        const store = createStore({ initialState: state });
        const list = createList({ store, onRowVisible: jest.fn() });
        document.body.appendChild(list.element);
        list.render(store.getState());
        return { store, list };
    }

    it('renders one item per channel', () => {
        const { list } = mountList(baseState({ layout: 'list' }));
        expect(list.element.querySelectorAll('.tvguide-list-item')).toHaveLength(2);
    });

    it('shows now, next and a description', () => {
        const { list } = mountList(baseState({ layout: 'list' }));
        const item = list.element.querySelector('[data-channel-id="studio:1"]');
        expect(item.textContent).toMatch(/Scene \d/);
        expect(item.textContent).toContain('Description');
        expect(item.textContent).toContain('Next');
    });

    it('marks the tuned channel', () => {
        const { list } = mountList(baseState({ layout: 'list' }));
        const item = list.element.querySelector('[data-channel-id="studio:1"]');
        expect(item.classList.contains('tvguide-list-item-tuned')).toBe(true);
        expect(item.querySelector('.tvguide-list-button').getAttribute('aria-pressed')).toBe('true');
    });

    it('tunes on tap', () => {
        const { store, list } = mountList(baseState({ layout: 'list', tunedChannelId: 'studio:2' }));
        list.element
            .querySelector('[data-channel-id="studio:1"] .tvguide-list-button')
            .click();
        expect(store.getState().tunedChannelId).toBe('studio:1');
    });

    it('has no per-row watch button on mobile -- tapping the row already tunes', () => {
        const { list } = mountList(baseState({ layout: 'list' }));
        expect(list.element.querySelector('.tvguide-list-expand')).toBeNull();
    });

    it('reports load failures', () => {
        const state = baseState({ layout: 'list' });
        state.pools['studio:2'] = { status: PoolStatus.ERROR, scenes: [], error: 'boom' };
        const { list } = mountList(state);
        expect(
            list.element.querySelector('[data-channel-id="studio:2"]').textContent
        ).toContain('Could not load');
    });
});

describe('banner', () => {
    it('collapses mobile details by default, keeps the disclosure stable on ticks, and resets for another scene', () => {
        const banner = createBanner();
        const state = baseState({ layout: 'list' });
        banner.render(state);
        const more = banner.element.querySelector('.tvguide-show-more');
        const extra = banner.element.querySelector('.tvguide-banner-extra');
        expect(extra.hidden).toBe(true);
        more.click();
        expect(extra.hidden).toBe(false);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        banner.render({ ...state, nowMs: NOON + 1000 });
        expect(banner.element.querySelector('.tvguide-show-more')).toBe(more);
        expect(extra.hidden).toBe(false);
        more.click();
        expect(extra.hidden).toBe(true);
        more.click();
        const future = state.schedules['studio:1'].entries[2];
        banner.render({ ...state, focus: { channelId: 'studio:1', timeMs: DAY_START + future.offsetMs } });
        expect(banner.element.querySelector('.tvguide-banner-extra').hidden).toBe(true);
        banner.render({ ...state, layout: 'grid' });
        expect(banner.element.querySelector('.tvguide-banner-extra').hidden).toBe(false);
        expect(banner.element.querySelector('.tvguide-show-more').hidden).toBe(true);
    });
    it('describes the focused programme, with its poster', () => {
        const banner = createBanner();
        banner.render(baseState());

        expect(banner.element.querySelector('.tvguide-banner-title').textContent).toMatch(/Scene \d/);
        expect(banner.element.textContent).toContain('Channel One');
        expect(banner.element.textContent).toContain('Description');
        expect(banner.element.querySelector('.tvguide-banner-poster')).not.toBeNull();
        expect(banner.element.querySelector('.tvguide-live-badge')).not.toBeNull();
        // Progress moved to the player, under the video.
        expect(banner.element.querySelector('[role="progressbar"]')).toBeNull();
    });

    it('prompts when nothing is focused', () => {
        const banner = createBanner();
        banner.render(baseState({ focus: null }));
        expect(banner.element.textContent).toContain('Select a channel');
    });

    it('says when a focused channel has nothing scheduled', () => {
        const banner = createBanner();
        banner.render(baseState({ focus: { channelId: 'studio:2', timeMs: NOON } }));
        expect(banner.element.textContent).toContain('nothing scheduled');
    });

    it('drops the live badge for a programme in the future', () => {
        const banner = createBanner();
        const state = baseState();
        const future = state.schedules['studio:1'].entries[2];
        banner.render({ ...state, focus: { channelId: 'studio:1', timeMs: DAY_START + future.offsetMs } });
        expect(banner.element.querySelector('.tvguide-live-badge')).toBeNull();
    });

    it('offers to open the described scene in Stash', () => {
        // The button used to live on the player, where it always meant "the
        // tuned channel" -- so it opened a different scene from the one the
        // details described.
        const store = createStore({ initialState: baseState() });
        const banner = createBanner({ store });
        const future = store.getState().schedules['studio:1'].entries[2];
        const timeMs = DAY_START + future.offsetMs;

        store.dispatch({ type: Events.FOCUS_CELL, channelId: 'studio:1', timeMs });
        banner.render(store.getState());

        const watch = banner.element.querySelector('.tvguide-watch');
        expect(watch.textContent).toBe('Watch in Stash');

        const dispatched = [];
        const spy = createStore({ initialState: baseState() });
        spy.dispatch = (event) => dispatched.push(event);
        const spied = createBanner({ store: spy });
        spied.render(store.getState());
        spied.element.querySelector('.tvguide-watch').click();

        expect(dispatched).toEqual([{ type: Events.EXPAND, channelId: 'studio:1', timeMs }]);
    });

    it('stacks the artwork, the channel badge and Watch in one column', () => {
        const store = createStore({ initialState: baseState() });
        const banner = createBanner({ store });
        banner.render(store.getState());

        const art = banner.element.querySelector('.tvguide-banner-art');
        const order = [...art.children].map((n) => n.className.split(' ')[0]);
        expect(order).toEqual([
            'tvguide-banner-poster',
            'tvguide-banner-logo',
            'tvguide-watch'
        ]);
    });

    it('renders related model and tag chips below the scene details', () => {
        const state = baseState();
        const entry = state.schedules['studio:1'].entries[0];
        entry.scene = {
            ...entry.scene,
            performers: [{ id: '7', name: 'Avery Lane' }],
            tags: [{ id: '9', name: 'Outdoor' }]
        };
        const store = createStore({ initialState: state });
        const banner = createBanner({ store });
        banner.render(store.getState());

        expect(banner.element.querySelector('[data-source="performer"]').textContent).toContain('Avery Lane');
        expect(banner.element.querySelector('[data-source="tag"]').textContent).toContain('Outdoor');
    });

    it('keeps the details scroll position when the same scene re-renders', () => {
        const state = baseState();
        const banner = createBanner();
        banner.render(state);

        banner.element.querySelector('.tvguide-banner-body').scrollTop = 72;
        banner.render({ ...state, nowMs: NOON + 1000 });

        expect(banner.element.querySelector('.tvguide-banner-body').scrollTop).toBe(72);
    });

    it('tunes a temporary model channel from its related chip', () => {
        const state = baseState();
        const entry = state.schedules['studio:1'].entries[0];
        entry.scene = { ...entry.scene, performers: [{ id: '7', name: 'Avery Lane' }] };
        const store = createStore({ initialState: state });
        const banner = createBanner({ store });
        banner.render(store.getState());

        banner.element.querySelector('.tvguide-related-chip').click();
        expect(store.getState().tunedChannelId).toBe('performer:7');
    });

    it('shows Save channel while a temporary channel is described', () => {
        const temporary = relatedChannel('performer', { id: '7', name: 'Avery Lane' });
        const state = baseState({
            allChannels: [...baseState().allChannels, temporary],
            temporaryChannel: temporary,
            tunedChannelId: temporary.id,
            focus: { channelId: temporary.id, timeMs: NOON },
            schedules: { [temporary.id]: buildDaySchedule(temporary.id, scenes(4), DAY_KEY) }
        });
        const banner = createBanner({ store: createStore({ initialState: state }) });
        banner.render(state);

        expect(banner.element.querySelector('.tvguide-save-channel').textContent).toBe('Save channel');
    });

    it('opens the channel in Stash from its badge', () => {
        // The badge in the guide row watches the channel now, so this is where
        // the link to Stash went.
        const store = createStore({ initialState: baseState() });
        const banner = createBanner({ store });
        banner.render(store.getState());

        const open = jest.spyOn(window, 'open').mockImplementation(() => null);
        banner.element.querySelector('.tvguide-banner-logo-button').click();

        expect(open).toHaveBeenCalledWith('/studios/1', '_blank', 'noopener');
        open.mockRestore();
    });

    it('leaves a saved filter as a plain badge, having no page to open', () => {
        const saved = { ...channel('savedFilter:1', 'Favourites'), source: 'savedFilter' };
        const state = baseState({ allChannels: [saved] });
        const store = createStore({
            initialState: {
                ...state,
                schedules: { 'savedFilter:1': buildDaySchedule('savedFilter:1', scenes(4), DAY_KEY) },
                tunedChannelId: 'savedFilter:1',
                focus: { channelId: 'savedFilter:1', timeMs: NOON }
            }
        });
        const banner = createBanner({ store });
        banner.render(store.getState());

        expect(banner.element.querySelector('.tvguide-banner-logo')).not.toBeNull();
        expect(banner.element.querySelector('.tvguide-banner-logo-button')).toBeNull();
    });

    it('has nothing to open when nothing is described', () => {
        const store = createStore({ initialState: baseState({ focus: null }) });
        const banner = createBanner({ store });
        banner.render(store.getState());
        expect(banner.element.querySelector('.tvguide-watch')).toBeNull();
    });
});

describe('overlay', () => {
    function mountOverlay(state, withPlayerEffects = false) {
        const store = createStore({
            initialState: state,
            runEffect: (effect) => {
                if (!withPlayerEffects) return;
                if (effect.type === 'setPlayerMode') overlay.player.setMode(effect.mode);
                if (effect.type === 'setPaused') viewer.setPaused(effect.paused);
                if (effect.type === 'setMuted') viewer.setMuted(effect.muted);
            }
        });
        const viewer = {
            element: document.createElement('video'),
            tune: jest.fn(),
            stop: jest.fn(),
            setMuted: jest.fn(),
            setPaused: jest.fn(),
            showPoster: jest.fn(),
            subscribe: jest.fn(() => () => {})
        };
        const overlay = createOverlay({
            store,
            viewer,
            announcer: createAnnouncer(),
            touchGuard: createTouchGuard(),
            onRowVisible: jest.fn()
        });
        store.subscribe((s) => overlay.render(s));
        overlay.render(store.getState());
        return { store, overlay, viewer };
    }

    it('updates details on a channel change and delayed pool arrival without any hover', () => {
        const { store, overlay } = mountOverlay(baseState());
        store.dispatch({ type: Events.TUNE, channelId: 'studio:2' });
        expect(overlay.element.querySelector('.tvguide-banner-title')).toBeNull();
        const nextScenes = scenes(4).map(scene => ({ ...scene, title: 'New channel programme' }));
        store.dispatch({ type: Events.POOL_LOADED, channelId: 'studio:2', scenes: nextScenes });
        expect(overlay.element.querySelector('.tvguide-banner-title').textContent).toBe('New channel programme');
        expect(overlay.element.querySelector('.tvguide-unpin-details')).toBeNull();
        overlay.destroy();
    });

    const typeOptions = (overlay) =>
        [...overlay.element.querySelectorAll('.tvguide-type-select option')].map((b) => b.textContent);

    it('jumps to the tuned channel in the mobile list after switching layouts', () => {
        const { store, overlay } = mountOverlay(baseState());
        expect(overlay.element.querySelector('.tvguide-list-top').hidden).toBe(true);
        store.dispatch({ type: Events.LAYOUT_CHANGED, layout: 'list' });
        const list = overlay.element.querySelector('.tvguide-list');
        const tunedRow = list.querySelector('[data-channel-id="studio:1"]');
        tunedRow.getBoundingClientRect = () => ({ top: 420 });

        overlay.element.querySelector('.tvguide-jump').click();

        expect(overlay.element.scrollTop).toBe(420);
        const top = overlay.element.querySelector('.tvguide-list-top');
        expect(top.hidden).toBe(false);
        top.click();
        expect(overlay.element.scrollTop).toBe(0);
        overlay.destroy();
    });

    const mixedState = (overrides = {}) =>
        baseState({
            allChannels: [
                channel('studio:1', 'Channel One'),
                channel('studio:2', 'Channel Two'),
                { ...channel('tag:1', 'Beach'), source: 'tag' }
            ],
            ...overrides
        });

    it('uses the clock preference throughout the guide, details, player and mobile list', () => {
        const state = baseState();
        state.settings = { ...state.settings, guide_12_hour_clock: true };
        const { store, overlay } = mountOverlay(state);
        expect(overlay.element.querySelector('.tvguide-tick').textContent).toBe('12:00 PM');
        expect(overlay.element.querySelector('.tvguide-block-time').textContent).toMatch(/PM$/);
        expect(overlay.element.querySelector('.tvguide-block').getAttribute('aria-label')).toContain('PM');
        expect(overlay.element.querySelector('.tvguide-banner-meta').textContent).toContain('PM');
        expect(overlay.element.querySelector('.tvguide-player-times').textContent).toMatch(/ends .* PM/);
        const list = createList({ store, onRowVisible: jest.fn() });
        list.render({ ...state, layout: 'list' });
        expect(list.element.querySelector('.tvguide-list-times').textContent).toMatch(/Next .* PM/);
        list.destroy();
        overlay.destroy();
    });

    it('consumes a saved-channel scroll target after rendering its guide row', () => {
        const { store, overlay } = mountOverlay(baseState({ guideScrollChannelId: 'studio:1' }));
        expect(overlay.element.querySelector('[data-channel-id="studio:1"]')).not.toBeNull();
        expect(store.getState().guideScrollChannelId).toBeNull();
    });

    describe('the grouping dropdown', () => {
        it('live in the toolbar, not in a bar of their own', () => {
            // Two stacked strips of channel controls read as two unrelated
            // things, and the lower one was being squeezed to nothing by the
            // guide below it.
            const { overlay } = mountOverlay(mixedState());
            const bar = overlay.element.querySelector('.tvguide-typebar');
            expect(bar.closest('.tvguide-topbar')).not.toBeNull();
            expect(overlay.element.querySelector('.tvguide-grid .tvguide-typebar')).toBeNull();
        });

        it('pins every control after Search to the toolbar’s right edge', () => {
            const { overlay } = mountOverlay(mixedState());
            const right = overlay.element.querySelector('.tvguide-toolbar-right');

            expect(right).not.toBeNull();
            expect(right.contains(overlay.element.querySelector('.tvguide-typebar'))).toBe(true);
            expect(right.contains(overlay.element.querySelector('.tvguide-recent'))).toBe(true);
            expect(right.contains(overlay.element.querySelector('.tvguide-close'))).toBe(true);
        });

        it('puts the whole toolbar below the scene details', () => {
            const { overlay } = mountOverlay(mixedState());
            const children = [...overlay.element.children].map((n) => n.className);
            expect(children.indexOf('tvguide-topbar')).toBeGreaterThan(
                children.indexOf('tvguide-header')
            );
        });

        it('offers All plus an option per type that has channels', () => {
            const { overlay } = mountOverlay(mixedState());
            expect(typeOptions(overlay)).toEqual(['All', 'Studios', 'Tags']);
        });

        it('leaves out a type with no channels, since it is not a mode you can be in', () => {
            const { overlay } = mountOverlay(mixedState());
            expect(typeOptions(overlay)).not.toContain('Models');
            expect(typeOptions(overlay)).not.toContain('Groups');
        });

        it('hides the dropdown when there is only one type', () => {
            const { overlay } = mountOverlay(baseState());
            expect(overlay.element.querySelector('.tvguide-typebar').hidden).toBe(true);
        });

        it('narrows the guide to one type', () => {
            const { store, overlay } = mountOverlay(mixedState());
            const select = overlay.element.querySelector('.tvguide-type-select');
            select.value = 'tag';
            select.dispatchEvent(new Event('change'));

            expect(store.getState().typeFilter).toBe('tag');
            const ids = [...overlay.element.querySelectorAll('.tvguide-row')].map(
                (r) => r.dataset.channelId
            );
            expect(ids).toEqual(['tag:1']);
        });

        it('expands a collapsed grouping when selected', () => {
            const { store, overlay } = mountOverlay(mixedState({ collapsedGroups: ['tag'] }));
            const select = overlay.element.querySelector('.tvguide-type-select');
            select.value = 'tag';
            select.dispatchEvent(new Event('change'));

            expect(store.getState().collapsedGroups).not.toContain('tag');
            expect(overlay.element.querySelector('.tvguide-row[data-channel-id="tag:1"]')).not.toBeNull();
            expect(select.value).toBe('tag');
            select.value = 'all';
            select.dispatchEvent(new Event('change'));
            expect(overlay.element.querySelectorAll('.tvguide-row')).toHaveLength(3);
        });

        it('preserves the dropdown and its options across unrelated renders', () => {
            const { store, overlay } = mountOverlay(mixedState());
            const select = overlay.element.querySelector('.tvguide-type-select');
            const option = select.options[1];
            select.focus();
            overlay.render({ ...store.getState(), nowMs: NOON + MIN });

            expect(overlay.element.querySelector('.tvguide-type-select')).toBe(select);
            expect(select.options[1]).toBe(option);
            expect(document.activeElement).toBe(select);
        });

        it('jumps to a group as well as filtering to it', () => {
            const { overlay } = mountOverlay(mixedState());
            const select = overlay.element.querySelector('.tvguide-type-select');
            select.value = 'tag';
            select.dispatchEvent(new Event('change'));

            expect(overlay.element.querySelector('.tvguide-group[data-group="tag"]')).not.toBeNull();
        });
    });

    it('presents itself as a modal dialog', () => {
        const { overlay } = mountOverlay(baseState());
        expect(overlay.element.getAttribute('role')).toBe('dialog');
        expect(overlay.element.getAttribute('aria-modal')).toBe('true');
        expect(overlay.element.getAttribute('aria-label')).toBe('StashIP-TV');
    });

    it('mounts into the body and flags it while open', () => {
        mountOverlay(baseState());
        expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
        expect(document.querySelector('.tvguide-overlay')).not.toBeNull();
    });

    it('unmounts and unflags when closed', () => {
        const { store } = mountOverlay(baseState());
        store.dispatch({ type: Events.CLOSE });
        expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
        expect(document.querySelector('.tvguide-overlay')).toBeNull();
    });

    it('shows the grid on desktop and the list on a phone', () => {
        const { store, overlay } = mountOverlay(baseState());
        expect(overlay.element.querySelector('.tvguide-grid')).not.toBeNull();

        store.dispatch({ type: Events.LAYOUT_CHANGED, layout: 'list' });

        expect(overlay.element.querySelector('.tvguide-list')).not.toBeNull();
        expect(overlay.element.querySelector('.tvguide-grid')).toBeNull();
    });

    it('pans with the toolbar controls', () => {
        const { store, overlay } = mountOverlay(baseState());
        const before = store.getState().windowStartMs;

        overlay.element.querySelectorAll('.tvguide-pan')[1].click();

        expect(store.getState().windowStartMs).toBeGreaterThan(before);
    });

    it('returns to now', () => {
        const { store, overlay } = mountOverlay(baseState({ windowStartMs: DAY_START }));
        overlay.element.querySelector('.tvguide-now').click();
        expect(store.getState().windowStartMs).toBeGreaterThan(DAY_START);
    });

    it('opens Recent directly below the toolbar and loads uncached channel schedules', () => {
        const { store, overlay } = mountOverlay(baseState({ recentChannelIds: ['studio:2', 'studio:1'] }));
        const button = overlay.element.querySelector('.tvguide-recent');
        const panel = overlay.element.querySelector('.tvguide-recent-panel');

        expect(panel.closest('.tvguide-topbar')).not.toBeNull();
        expect(button.dataset.icon).toBe('history');
        expect(panel.hidden).toBe(true);

        button.click();

        expect(panel.hidden).toBe(false);
        expect(panel.textContent).toContain('Channel One');
        expect(store.getState().pools['studio:2'].status).toBe(PoolStatus.LOADING);
    });

    it('toggles mute from the player controls', () => {
        const { store, overlay } = mountOverlay(baseState({ muted: true }));
        overlay.element.querySelector('.tvguide-mute').click();
        expect(store.getState().muted).toBe(false);
    });

    it('names the tuned channel and its programme under the player', () => {
        const { overlay } = mountOverlay(baseState());
        expect(overlay.element.querySelector('.tvguide-player-caption').textContent).toMatch(
            /Channel One · Scene \d/
        );
    });

    it('hides the player entirely when autoplay is off', () => {
        const state = baseState();
        state.settings = { ...state.settings, guide_autoplay: false };
        const { overlay } = mountOverlay(state);
        expect(overlay.element.querySelector('.tvguide-player').hidden).toBe(true);
    });

    it.each(['grid'])('preserves the %s channel position and restores theater scrolling on mode changes', (layout) => {
        const { store, overlay } = mountOverlay(baseState({ layout }));
        const scroller = overlay.element.querySelector(layout === 'grid' ? '.tvguide-grid-scroll' : '.tvguide-list');
        scroller.scrollTop = 420;
        // Emulate layout clamping the inner scroller during the class change.
        const toggle = overlay.element.classList.toggle.bind(overlay.element.classList);
        jest.spyOn(overlay.element.classList, 'toggle').mockImplementation((name, on) => {
            if (name === 'is-theater') scroller.scrollTop = 0;
            return toggle(name, on);
        });
        store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'theater' });
        expect(scroller.scrollTop).toBe(420);
        overlay.element.scrollTop = 500;
        scroller.scrollTop = 680;
        store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'corner' });
        expect(scroller.scrollTop).toBe(680);
        expect(overlay.element.scrollTop).toBe(0);
        store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'theater' });
        expect(scroller.scrollTop).toBe(680);
        expect(overlay.element.scrollTop).toBe(500);
    });

    it('does not re-render the guide while native fullscreen is pending', () => {
        const state = baseState({ playerMode: 'fullscreen' });
        const { store, overlay } = mountOverlay(state);
        const stage = overlay.element.querySelector('.tvguide-player-stage');
        const scrollTo = window.scrollTo;
        window.scrollTo = jest.fn();
        stage.requestFullscreen = jest.fn(() => new Promise(() => {}));
        const render = jest.spyOn(overlay.player, 'render');

        overlay.player.setMode('fullscreen');
        render.mockClear();
        overlay.render(state);

        expect(render).not.toHaveBeenCalled();
        overlay.destroy();
        window.scrollTo = scrollTo;
    });

    it('updates playback controls while native fullscreen is pending', () => {
        const state = baseState({ playerMode: 'fullscreen' });
        const { store, overlay } = mountOverlay(state);
        const stage = overlay.element.querySelector('.tvguide-player-stage');
        const play = overlay.element.querySelector('.tvguide-play');
        const scrollTo = window.scrollTo;
        window.scrollTo = jest.fn();
        stage.requestFullscreen = jest.fn(() => new Promise(() => {}));

        overlay.player.setMode('fullscreen');
        play.click();

        expect(store.getState().viewerPaused).toBe(true);
        expect(play.dataset.icon).toBe('play');
        expect(play.getAttribute('aria-label')).toBe('Play');
        overlay.destroy();
        window.scrollTo = scrollTo;
    });

    it.each(['requestFullscreen', 'webkitRequestFullscreen'])('keeps the stage mounted and controls live through %s', async (api) => {
        const { store, overlay, viewer } = mountOverlay(baseState({ playerMode: 'theater' }), true);
        const stage = overlay.element.querySelector('.tvguide-player-stage');
        const fullscreen = stage.querySelector('.tvguide-fullscreen');
        const play = stage.querySelector('.tvguide-play');
        const mute = stage.querySelector('.tvguide-mute');
        const fullscreenProperty = api === 'requestFullscreen' ? 'fullscreenElement' : 'webkitFullscreenElement';
        const eventName = api === 'requestFullscreen' ? 'fullscreenchange' : 'webkitfullscreenchange';
        let active = null;
        Object.defineProperty(document, fullscreenProperty, { get: () => active, configurable: true });
        stage[api] = jest.fn(() => {
            active = stage;
            return api === 'requestFullscreen' ? Promise.resolve() : undefined;
        });
        const observer = new MutationObserver(() => {});
        observer.observe(overlay.element, { childList: true, subtree: true });
        const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
        try {
            fullscreen.click();
            document.dispatchEvent(new Event(eventName));
            await Promise.resolve();
            play.focus();
            play.click();
            mute.click();
            store.dispatch({ type: Events.TICK, nowMs: NOON + 1000 });
            store.dispatch({ type: Events.LAYOUT_CHANGED, layout: 'list' });

            expect(document[fullscreenProperty]).toBe(stage);
            expect(stage.isConnected).toBe(true);
            expect(stage.querySelector('video')).toBe(viewer.element);
            expect(document.activeElement).toBe(play);
            expect(observer.takeRecords()).toHaveLength(0);
            expect(play.getAttribute('aria-label')).toBe('Play');
            expect(mute.getAttribute('aria-label')).toBe('Mute');
            expect(fullscreen.getAttribute('aria-pressed')).toBe('true');
            expect(viewer.setPaused).toHaveBeenCalledWith(true);
            expect(viewer.setMuted).toHaveBeenCalledWith(false);

            active = null;
            document.dispatchEvent(new Event(eventName));
            expect(store.getState().playerMode).toBe('theater');
            expect(overlay.element.querySelector('.tvguide-list')).not.toBeNull();
            expect(fullscreen.getAttribute('aria-pressed')).toBe('false');
        } finally {
            observer.disconnect();
            active = null;
            overlay.destroy();
            delete document[fullscreenProperty];
            scrollTo.mockRestore();
        }
    });

    it('toggles the shortcut help panel', () => {
        const { overlay } = mountOverlay(baseState());
        const help = overlay.element.querySelector('.tvguide-help');
        expect(help.hidden).toBe(true);

        overlay.toggleHelp();
        expect(help.hidden).toBe(false);
        expect(help.textContent).toContain('Back to now');
    });

    it('reports loading, failure and an empty lineup', () => {
        const { store, overlay } = mountOverlay(
            baseState({ channels: [], channelsStatus: PoolStatus.LOADING })
        );
        expect(overlay.element.querySelector('.tvguide-status').textContent).toContain('Loading');

        store.dispatch({ type: Events.CHANNELS_FAILED, message: 'offline' });
        expect(overlay.element.querySelector('.tvguide-status').textContent).toContain('offline');

        store.dispatch({ type: Events.CHANNELS_LOADED, channels: [], errors: [] });
        expect(overlay.element.querySelector('.tvguide-status').textContent).toContain('No channels');
    });

    it('does not claim there are no channels when they are merely collapsed', () => {
        // Collapsing every group empties the visible list, which is not the
        // same thing as a library with nothing in it -- and "lower the minimum
        // scene count" is useless advice when the lineup is full.
        const { store, overlay } = mountOverlay(baseState());
        store.dispatch({ type: Events.TOGGLE_GROUP, key: 'studio' });

        expect(store.getState().channels).toEqual([]);
        expect(overlay.element.querySelector('.tvguide-status').textContent).not.toContain('No channels');
    });

    it('says so when a search matches nothing', () => {
        const { store, overlay } = mountOverlay(baseState());
        store.dispatch({ type: Events.GUIDE_SEARCH, query: 'nothing at all' });

        expect(overlay.element.querySelector('.tvguide-status').textContent).not.toContain('No channels');
        expect(overlay.element.querySelector('.tvguide-grid-empty').textContent).toBe('No channels match.');
    });

    it('keeps quiet about matching when the guide is only collapsed', () => {
        const { store, overlay } = mountOverlay(baseState());
        store.dispatch({ type: Events.TOGGLE_GROUP, key: 'studio' });
        expect(overlay.element.querySelector('.tvguide-grid-empty')).toBeNull();
    });

    it('scrolls back to the player when it expands to theater', () => {
        // Theater makes the overlay itself scrollable, and it inherited
        // whatever the corner layout was scrolled to -- which put the guide on
        // screen and the newly-enlarged player above it.
        const { store, overlay } = mountOverlay(baseState());
        overlay.element.scrollTop = 400;

        store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'theater' });

        expect(overlay.element.classList.contains('is-theater')).toBe(true);
        expect(overlay.element.scrollTop).toBe(0);
    });

    it('mentions partly-failed sources without hiding the channels that worked', () => {
        const { store, overlay } = mountOverlay(baseState({ channels: [] }));
        store.dispatch({
            type: Events.CHANNELS_LOADED,
            channels: [channel('studio:1', 'One')],
            errors: [{ source: 'tag', message: 'boom' }]
        });
        expect(overlay.element.querySelector('.tvguide-status').textContent).toContain('1 source(s) failed');
    });

    it('closes from the close button', () => {
        const { store, overlay } = mountOverlay(baseState());
        overlay.element.querySelector('.tvguide-close').click();
        expect(store.getState().open).toBe(false);
    });

    it('pushes the hash when opened so Back can close it', () => {
        const { store, overlay } = mountOverlay(baseState({ open: false }));
        overlay.open();
        expect(window.location.hash).toBe(HASH);
        expect(store.getState().open).toBe(true);
    });
});
