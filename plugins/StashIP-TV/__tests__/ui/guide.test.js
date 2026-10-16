/**
 * The Phase 3 grid: grouping, the corrected now-line, pinning
 * from the guide, the type bar and the A-Z rail.
 */

import { createStore } from '../../src/state/store.js';
import { createGrid } from '../../src/ui/grid.js';
import { createChannelRail } from '../../src/ui/channelRail.js';
import { createTouchGuard } from '../../src/ui/gestures.js';
import { createInitialState, PoolStatus } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';
import { buildDaySchedule, dayBucket } from '../../src/domain/schedule.js';
import { groupChannels, flattenGroups } from '../../src/domain/channelPrefs.js';
import { KNOWN_SOURCES } from '../../src/domain/lineup.js';

const MIN = 60000;
const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();
const { key: DAY_KEY, startMs: DAY_START } = dayBucket(NOON);

const scenes = (n, minutes) =>
    Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `Scene ${i + 1}`,
        details: 'Details',
        paths: { stream: `/s/${i}`, screenshot: `/p/${i}` },
        files: [{ duration: minutes * 60 }]
    }));

const chan = (id, name, source = 'studio') => ({
    id, source, name, logo: { type: 'monogram', initials: 'XX', hue: 1 },
    sceneCount: 10, sceneFilter: {}
});

function mount(overrides = {}) {
    const state = {
        ...createInitialState(),
        open: true,
        nowMs: NOON,
        dayKey: DAY_KEY,
        dayStartMs: DAY_START,
        windowStartMs: NOON,
        channelsStatus: PoolStatus.READY,
        tunedChannelId: 'studio:1',
        focus: { channelId: 'studio:1', timeMs: NOON, source: 'keyboard' },
        allChannels: [chan('studio:1', 'Alpha'), chan('studio:2', 'Bravo'), chan('tag:1', 'Beach', 'tag')],
        pools: {
            'studio:1': { status: PoolStatus.READY, scenes: scenes(4, 30), error: null },
            'studio:2': { status: PoolStatus.READY, scenes: scenes(4, 30), error: null },
            'tag:1': { status: PoolStatus.READY, scenes: scenes(4, 30), error: null }
        },
        schedules: {
            'studio:1': buildDaySchedule('studio:1', scenes(4, 30), DAY_KEY),
            'studio:2': buildDaySchedule('studio:2', scenes(4, 30), DAY_KEY),
            'tag:1': buildDaySchedule('tag:1', scenes(4, 30), DAY_KEY)
        },
        ...overrides
    };

    state.channelGroups = groupChannels(state.allChannels, {
        prefs: state.prefs,
        pinOrder: state.pinOrder,
        sourceOrder: KNOWN_SOURCES,
        collapsed: state.collapsedGroups
    });
    state.channels = flattenGroups(state.channelGroups);

    const store = createStore({ initialState: state });
    const grid = createGrid({ store, onRowVisible: jest.fn(), touchGuard: createTouchGuard() });
    document.body.appendChild(grid.element);
    store.subscribe((s) => grid.render(s));
    grid.render(store.getState());
    return { store, grid };
}

const rows = (grid) => [...grid.element.querySelectorAll('.tvguide-row')].map((r) => r.dataset.channelId);

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('grouping', () => {
    it('puts a header before each source group', () => {
        const { grid } = mount();
        const labels = [...grid.element.querySelectorAll('.tvguide-group-label')].map((n) => n.textContent);
        expect(labels).toEqual(['Studios', 'Tags']);
    });

    it('shows a count per group', () => {
        const { grid } = mount();
        expect(grid.element.querySelector('.tvguide-group-count').textContent).toBe('(2)');
    });

    it('collapses a group, removing its rows', () => {
        const { store, grid } = mount();
        grid.element.querySelector('.tvguide-group-toggle').click();

        expect(store.getState().collapsedGroups).toContain('studio');
        expect(rows(grid)).toEqual(['tag:1']);
    });

    it('marks the collapsed state for assistive tech', () => {
        const { grid } = mount();
        const toggle = grid.element.querySelector('.tvguide-group-toggle');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        toggle.click();
        expect(grid.element.querySelector('.tvguide-group-toggle').getAttribute('aria-expanded')).toBe('false');
    });

    it('lifts a pinned channel into a pinned group at the top', () => {
        const { store, grid } = mount();
        const pin = grid.element.querySelector('[data-channel-id="tag:1"] .tvguide-pin');

        pin.click();

        expect(store.getState().pinOrder).toEqual(['tag:1']);
        expect(rows(grid)[0]).toBe('tag:1');
        expect(grid.element.querySelector('.tvguide-group-label').textContent).toBe('Pinned');
    });

    it('makes pinned rows draggable so they can be reordered', () => {
        const { grid } = mount({ pinOrder: ['studio:1', 'studio:2'] });
        const pinnedRow = grid.element.querySelector('.tvguide-row-pinned');
        expect(pinnedRow.getAttribute('draggable')).toBe('true');
    });

    it('reorders pins by drag and drop', () => {
        const { store, grid } = mount({ pinOrder: ['studio:1', 'studio:2'] });
        const [first, second] = grid.element.querySelectorAll('.tvguide-row-pinned');

        first.dispatchEvent(new Event('dragstart'));
        const drop = new Event('drop');
        second.dispatchEvent(drop);

        expect(store.getState().pinOrder).toEqual(['studio:2', 'studio:1']);
    });
});

describe('the guide date', () => {
    it('shows the current local date beside the times and updates at midnight', () => {
        const { store, grid } = mount();
        const date = grid.element.querySelector('.tvguide-grid-corner');
        expect(date.textContent).toBe('Sat, Aug 22');
        grid.render({ ...store.getState(), nowMs: new Date(2026, 7, 23, 0, 0).getTime() });
        expect(date.textContent).toBe('Sun, Aug 23');
    });
});

describe('the now-line', () => {
    it('is positioned as a percentage of the track, not of the whole grid', () => {
        // Regression: it used to be positioned against the full scroll
        // container and then offset by the channel column, which put it
        // progressively too far right and eventually off-screen.
        const { grid } = mount({ nowMs: NOON + 90 * MIN });
        const line = grid.element.querySelector('.tvguide-nowline');
        const overlay = grid.element.querySelector('.tvguide-track-overlay');

        expect(overlay.contains(line)).toBe(true);
        // 90 minutes into a 3-hour window is exactly halfway.
        expect(line.style.left).toBe('50%');
        // The offset now comes from the overlay, not a margin on the line.
        expect(line.style.marginLeft).toBe('');
    });

    it('tracks the clock across the window', () => {
        for (const [minutes, expected] of [[0, '0%'], [45, '25%'], [135, '75%']]) {
            document.body.innerHTML = '';
            const { grid } = mount({ nowMs: NOON + minutes * MIN });
            expect(grid.element.querySelector('.tvguide-nowline').style.left).toBe(expected);
        }
    });

    it('hides when the window is panned away from now', () => {
        const { grid } = mount({ windowStartMs: NOON + 5 * 3600000 });
        expect(grid.element.querySelector('.tvguide-nowline').style.display).toBe('none');
    });

    it('draws a boundary line at every tick', () => {
        const { grid } = mount();
        const lines = grid.element.querySelectorAll('.tvguide-gridline');
        const ticks = grid.element.querySelectorAll('.tvguide-tick');
        expect(lines).toHaveLength(ticks.length);
        expect([...lines].map((l) => l.style.left)).toEqual([...ticks].map((t) => t.style.left));
    });
});

describe('dense upcoming scenes', () => {
    it('groups short scenes by their duration, not the track width', () => {
        const nativeResizeObserver = global.ResizeObserver;
        const nativeClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        let width = 100;
        let onResize;

        global.ResizeObserver = class {
            constructor(callback) {
                onResize = callback;
            }
            observe() {}
            disconnect() {}
        };
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return this.classList?.contains('tvguide-row-track') ? width : 0;
            }
        });

        try {
            const dense = scenes(4, 4);
            const schedule = buildDaySchedule('studio:1', dense, DAY_KEY);
            const { grid } = mount({
                settings: { ...createInitialState().settings, guide_window_hours: 1 },
                allChannels: [chan('studio:1', 'Alpha')],
                pools: { 'studio:1': { status: PoolStatus.READY, scenes: dense, error: null } },
                schedules: { 'studio:1': schedule }
            });
            const track = grid.element.querySelector('[data-channel-id="studio:1"] .tvguide-row-track');

            expect(track.querySelectorAll('.tvguide-block-live')).toHaveLength(1);
            expect(track.querySelectorAll('.tvguide-block')).toHaveLength(1);
            expect(track.querySelectorAll('.tvguide-block-divider')).toHaveLength(14);
            expect(track.querySelector('.tvguide-block-title').textContent).toBe('Scene 2');
        } finally {
            if (nativeResizeObserver === undefined) delete global.ResizeObserver;
            else global.ResizeObserver = nativeResizeObserver;
            if (nativeClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', nativeClientWidth);
            else delete HTMLElement.prototype.clientWidth;
        }
    });
});

describe('the A-Z rail', () => {
    /**
     * jsdom lays nothing out, so give the grid a geometry to scroll through.
     * Without it every `offsetTop` is 0 and scrolling cannot be observed.
     */
    function layOut(grid, rowHeight = 76) {
        const scroll = grid.element.querySelector('.tvguide-grid-scroll');
        Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true });

        const nodes = grid.element.querySelectorAll('.tvguide-group, .tvguide-row');
        nodes.forEach((node, index) => {
            Object.defineProperty(node, 'offsetTop', { value: index * rowHeight, configurable: true });
            Object.defineProperty(node, 'offsetHeight', { value: rowHeight, configurable: true });
        });

        // Let the grid notice the geometry it now has.
        scroll.dispatchEvent(new Event('scroll'));
        return scroll;
    }

    it('keeps vertical keyboard focus visible without moving the outer overlay or chasing ticks', () => {
        const { store, grid } = mount();
        const scroll = layOut(grid);
        Object.defineProperty(scroll, 'clientHeight', { value: 200, configurable: true });
        grid.element.scrollTop = 35;
        store.dispatch({ type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });
        // Bravo ends at 228; scroll only enough to reveal its bottom.
        expect(scroll.scrollTop).toBe(28);
        expect(grid.element.scrollTop).toBe(35);
        store.dispatch({ type: Events.MOVE_FOCUS, axis: 'channel', delta: -1 });
        // Alpha begins at 76, immediately below the sticky 76px header.
        expect(scroll.scrollTop).toBe(0);
        scroll.scrollTop = 100;
        store.dispatch({ type: Events.TICK, nowMs: NOON + 1000 });
        expect(scroll.scrollTop).toBe(100);
    });

    const railLetters = (grid) =>
        [...grid.element.querySelectorAll('.tvguide-rail-letter')].map((b) => b.textContent);

    it('offers a letter per initial present in the group being scrolled', () => {
        const { grid } = mount();
        layOut(grid);
        // Scrolled to the top, so the rail belongs to the first group.
        expect(railLetters(grid)).toEqual(['A', 'B']);
    });

    it('follows the scroll into the next group', () => {
        // The guide is always grouped, so a global rail would offer letters that
        // throw you out of the section you are reading.
        const { store, grid } = mount();
        const scroll = layOut(grid);

        // Past the studio header and its two rows, into the tag group.
        scroll.scrollTop = 76 * 3;
        scroll.dispatchEvent(new Event('scroll'));

        expect(railLetters(grid)).toEqual(['B']);
        expect(store.getState().channels.map((c) => c.id)).toContain('tag:1');
    });

    it('puts the first channel for that letter at the top', () => {
        // Centring it left a screenful of the previous letter above the channel
        // you actually asked for -- click T, see two S channels.
        const { grid } = mount();
        const scroll = layOut(grid);

        [...grid.element.querySelectorAll('.tvguide-rail-letter')]
            .find((b) => b.textContent === 'B')
            .click();

        // studio:2 is the third laid-out node (header, Alpha, Bravo), less the
        // group header that would otherwise sit stuck over it.
        expect(scroll.scrollTop).toBe(76 * 2 - 76);
    });

    it('leaves nothing of the previous letter above it', () => {
        const { grid } = mount();
        const scroll = layOut(grid);

        [...grid.element.querySelectorAll('.tvguide-rail-letter')]
            .find((b) => b.textContent === 'B')
            .click();

        const target = grid.element.querySelector('[data-channel-id="studio:2"]');
        const header = grid.element.querySelector('.tvguide-group[data-group="studio"]');
        // The row starts exactly where the stuck header ends.
        expect(target.offsetTop - scroll.scrollTop).toBe(header.offsetHeight);
    });

    it('scrolls its own container and nothing above it', () => {
        // `scrollIntoView` walks every ancestor scroll container, and in theater
        // mode the overlay is one of them -- so a letter jump used to drag the
        // player off the top of the screen.
        const { grid } = mount();
        layOut(grid);
        for (const row of grid.element.querySelectorAll('.tvguide-row')) {
            row.scrollIntoView = jest.fn(() => {
                throw new Error('scrollIntoView must not be used inside the grid');
            });
        }

        [...grid.element.querySelectorAll('.tvguide-rail-letter')]
            .find((b) => b.textContent === 'B')
            .click();
    });

    it('leaves the guide order alone', () => {
        // The rail used to force the sort back to Name, which rebuilt every row
        // out from under the jump it was about to make. The guide is always
        // alphabetical now, so there is nothing to switch.
        const { store, grid } = mount();
        layOut(grid);
        const before = store.getState().channels;

        [...grid.element.querySelectorAll('.tvguide-rail-letter')]
            .find((b) => b.textContent === 'B')
            .click();

        expect(store.getState().channels).toBe(before);
    });

    it('is scrollable rather than clipping the tail of the alphabet', () => {
        const { grid } = mount();
        const rail = grid.element.querySelector('.tvguide-rail');
        expect(rail.parentElement.className).toContain('tvguide-grid-main');
        expect(rail.getAttribute('aria-orientation')).toBe('vertical');
    });

    it('offers nothing when there is no group to jump within', () => {
        const store = createStore({
            initialState: { ...createInitialState(), allChannels: [], channels: [] }
        });
        const onJump = jest.fn();
        const rail = createChannelRail({ store, onJump });
        rail.render(store.getState(), null);
        expect(rail.element.querySelectorAll('.tvguide-rail-letter')).toHaveLength(0);
        expect(onJump).not.toHaveBeenCalled();
    });

    it('does not jump to a letter no channel in the group starts with', () => {
        const store = createStore({
            initialState: {
                ...createInitialState(),
                allChannels: [chan('studio:1', 'Alpha')],
                channelGroups: [
                    { key: 'studio', source: 'studio', channels: [chan('studio:1', 'Alpha')], collapsed: false, count: 1 }
                ]
            }
        });
        const onJump = jest.fn();
        const rail = createChannelRail({ store, onJump });
        rail.render(store.getState(), 'studio');

        // Rewrite the only letter's target out from under it.
        store.getState().channelGroups[0].channels = [];
        rail.element.querySelector('.tvguide-rail-letter').click();

        expect(onJump).not.toHaveBeenCalled();
    });
});

describe('row controls', () => {
    it('shows the name as the badge when a channel has no artwork', () => {
        const { grid } = mount();
        const row = grid.element.querySelector('[data-channel-id="studio:1"]');
        expect(row.querySelector('.tvguide-logo-button')).toBeNull();
        expect(row.querySelector('.tvguide-row-name').textContent).toBe('Alpha');
    });

    it('shows artwork instead of the name, not as well as it', () => {
        // Studio artwork is a wordmark, so a name beside it repeats itself.
        const withArt = {
            ...chan('studio:1', 'Alpha'),
            logo: { type: 'image', url: '/img.png' }
        };
        const { grid } = mount({ allChannels: [withArt] });
        const row = grid.element.querySelector('[data-channel-id="studio:1"]');

        expect(row.querySelector('.tvguide-logo-button img')).not.toBeNull();
        expect(row.querySelector('.tvguide-row-name')).toBeNull();
        // The name is still available to assistive tech and on hover.
        expect(row.querySelector('.tvguide-logo-button').getAttribute('aria-label')).toBe('Watch Alpha');
        expect(row.querySelector('.tvguide-logo-button').title).toBe('Watch Alpha');
    });

    it('shows a performer name beside its portrait', () => {
        const performer = { ...chan('performer:1', 'Avery', 'performer'), logo: { type: 'image', url: '/avery.jpg' } };
        const { grid } = mount({ allChannels: [performer] });
        expect(grid.element.querySelector('.tvguide-logo-button-with-name').textContent).toContain('Avery');
    });

    it('watches the channel when its badge is pressed', () => {
        // Pressing a channel in a guide means "put this on". The way out to
        // Stash lives on the badge in the scene details instead.
        const { store, grid } = mount({ tunedChannelId: 'tag:1' });
        grid.element
            .querySelector('[data-channel-id="studio:2"] .tvguide-row-name')
            .click();

        expect(store.getState().tunedChannelId).toBe('studio:2');
    });

    it('labels the pin button by what it will do', () => {
        const { grid } = mount();
        const pin = grid.element.querySelector('[data-channel-id="studio:1"] .tvguide-pin');
        expect(pin.getAttribute('aria-label')).toBe('Pin Alpha');
        pin.click();
        expect(
            grid.element.querySelector('[data-channel-id="studio:1"] .tvguide-pin').getAttribute('aria-label')
        ).toBe('Unpin Alpha');
    });
});

describe('leaving the grid', () => {
    it('puts the details back on what is playing after a hover', () => {
        const { store, grid } = mount();
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const future = blocks[blocks.length - 1];

        future.dispatchEvent(new MouseEvent('mouseenter'));
        expect(store.getState().focus.source).toBe('hover');

        grid.element.querySelector('.tvguide-grid-body').dispatchEvent(new MouseEvent('mouseleave'));

        expect(store.getState().focus.source).toBe('live');
        expect(store.getState().focus.channelId).toBe('studio:1');
    });

    it('still reverts after the grid has re-adopted focus', async () => {
        // The bug: hovering set `source: 'hover'`, then the grid's own
        // `adoptFocus` focused that block a microtask later, whose `onfocus`
        // rewrote the source to 'keyboard' -- after which leaving the grid did
        // nothing and the details stayed on whatever the mouse last passed over.
        const { store, grid } = mount();
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const future = blocks[blocks.length - 1];

        future.dispatchEvent(new MouseEvent('mouseenter'));
        await Promise.resolve();
        await Promise.resolve();

        expect(store.getState().focus.source).toBe('hover');

        grid.element.querySelector('.tvguide-grid-body').dispatchEvent(new MouseEvent('mouseleave'));

        expect(store.getState().focus.source).toBe('live');
    });

    it('still records a real keyboard focus', async () => {
        // The guard must only cover the grid's own focus calls -- tabbing to a
        // block by hand is still keyboard focus and must survive the mouse
        // leaving.
        const { store, grid } = mount();
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const future = blocks[blocks.length - 1];

        future.dispatchEvent(new FocusEvent('focus'));
        await Promise.resolve();

        expect(store.getState().focus.source).toBe('keyboard');
    });

    it('leaves a clicked preview alone', () => {
        // A click is a deliberate choice; only a hover is transient.
        const { store, grid } = mount();
        const blocks = grid.element.querySelectorAll('[data-channel-id="studio:1"] .tvguide-block');
        const future = [...blocks].find((b) => !b.classList.contains('tvguide-block-live'));

        future.click();
        const previewed = store.getState().focus.timeMs;

        grid.element.querySelector('.tvguide-grid-body').dispatchEvent(new MouseEvent('mouseleave'));

        expect(store.getState().focus.timeMs).toBe(previewed);
    });

    it('leaves keyboard focus alone', () => {
        const { store, grid } = mount();
        store.dispatch({ type: Events.MOVE_FOCUS, axis: 'time', delta: 1 });
        const moved = store.getState().focus.timeMs;

        grid.element.querySelector('.tvguide-grid-body').dispatchEvent(new MouseEvent('mouseleave'));

        expect(store.getState().focus.timeMs).toBe(moved);
    });
});

describe('pinned channel letter navigation', () => {
    it('clears the letters for pinned channels and restores them for alphabetical groups', () => {
        const { store } = mount({ pinOrder: ['studio:1'] });
        const rail = createChannelRail({ store, onJump: jest.fn() });
        rail.render(store.getState(), 'studio');
        expect(rail.element.querySelectorAll('button').length).toBeGreaterThan(0);
        rail.render(store.getState(), 'pinned');
        expect(rail.element.querySelectorAll('button')).toHaveLength(0);
        rail.render(store.getState(), 'studio');
        expect(rail.element.querySelectorAll('button').length).toBeGreaterThan(0);
    });
});
