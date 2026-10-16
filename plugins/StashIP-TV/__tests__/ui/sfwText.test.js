import { createSfwText } from '../../src/ui/sfwText.js';
import { createGrid } from '../../src/ui/grid.js';
import { createBanner } from '../../src/ui/banner.js';
import { createList } from '../../src/ui/list.js';
import { createManager } from '../../src/ui/manager.js';
import { createPlayer } from '../../src/ui/player.js';
import { createStore } from '../../src/state/store.js';
import { createInitialState } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';
import { buildDaySchedule, dayBucket } from '../../src/domain/schedule.js';
import { withDemoPlayback } from '../../src/ui/demoContent.js';
import { readFileSync } from 'node:fs';

const nowMs = new Date(2026, 7, 22, 12).getTime();
const day = dayBucket(nowMs);
const scene = {
    id: '1202', title: 'Private program title', details: 'Private description',
    files: [{ duration: 1800 }], paths: { screenshot: '/private-poster.jpg' },
    performers: [{ id: '8', name: 'Private performer, Jr.' }],
    tags: [{ id: '9', name: 'Private tag' }],
    studio: { name: 'Private studio', image_path: '/logo.png' }
};
const channel = {
    id: 'studio:1', source: 'studio', name: 'Private channel', sceneCount: 5,
    logo: { type: 'monogram', initials: 'PC', hue: 0 }, sceneFilter: {}
};
let cleanup;
afterEach(() => { cleanup?.(); document.body.innerHTML = ''; });

function mount(enabled = true, studioArtwork = false) {
    const initial = createInitialState();
    const guideChannel = studioArtwork
        ? { ...channel, name: scene.studio.name, logo: { type: 'image', url: scene.studio.image_path } }
        : channel;
    const catalog = studioArtwork
        ? [guideChannel, { ...channel, id: 'studio:2', name: 'Private second studio', logo: { type: 'image', url: '/second-logo.png' } }]
        : [guideChannel];
    const store = createStore({ initialState: {
        ...initial, open: true, managerOpen: true,
        settings: { ...initial.settings, guide_sfw_text: enabled },
        nowMs, dayKey: day.key, dayStartMs: day.startMs, windowStartMs: nowMs,
        allChannels: [guideChannel], channels: [guideChannel],
        channelGroups: [{ key: 'studio', source: 'studio', channels: [guideChannel], collapsed: false, count: 1 }],
        channelsStatus: 'ready', tunedChannelId: channel.id,
        focus: { channelId: channel.id, timeMs: nowMs },
        pools: { [channel.id]: { status: 'ready', scenes: [scene] } },
        schedules: { [channel.id]: buildDaySchedule(channel.id, [scene], day.key) },
        catalog: { studio: catalog }, catalogStatus: { studio: 'ready' },
        lineup: [{ source: 'studio', minScenes: 0 }]
    } });
    const viewer = { element: document.createElement('video'), subscribe: () => () => {} };
    const views = [createGrid({ store, onRowVisible: jest.fn() }), createBanner({ store }),
        createList({ store, onRowVisible: jest.fn() }), createManager({ store }), createPlayer({ store, viewer })];
    const root = document.createElement('div');
    root.append(...views.map((view) => view.element));
    document.body.append(root);
    const render = () => views.forEach((view) => view.render(store.getState()));
    render();
    const filter = createSfwText({ root, getState: store.getState });
    store.subscribe(() => { render(); filter.refresh(); });
    cleanup = () => { filter.destroy(); views.forEach((view) => view.destroy?.()); store.destroy(); };
    return { root, store, filter, viewer, render, q: (selector) => root.querySelector(selector) };
}

function expectNoLibraryText(root) {
    expect(root.textContent).not.toMatch(/Private|\bPC\b/);
    for (const node of root.querySelectorAll('[title], [aria-label], [alt], [placeholder]')) {
        for (const attr of ['title', 'aria-label', 'alt', 'placeholder']) {
            expect(node.getAttribute(attr) || '').not.toContain('Private');
        }
    }
}

it('replaces library text throughout real views while retaining clocks and functional controls', () => {
    const { root, q, store } = mount();
    expectNoLibraryText(root);
    const title = q('.tvguide-banner-title').textContent;
    const name = q('.tvguide-row-name').textContent;
    expect(title).toBe('Echoes of Summer');
    expect(q('.tvguide-block-title').textContent).toBe(title);
    expect(q('.tvguide-list-now').textContent).toBe(title);
    expect(q('.tvguide-manager-row[data-channel-id="studio:1"] .tvguide-manager-row-name').textContent).toBe(name);
    expect(q('.tvguide-player-caption').textContent).toBe(`${name} · ${title}`);
    expect(q('.tvguide-banner-meta').textContent).toMatch(/\d{2}:\d{2}/);
    expect(q('.tvguide-list-times').textContent).toContain(`: ${title}`);
    expect(q('.tvguide-block').getAttribute('aria-label')).toContain(`${title}, `);
    expect(q('.tvguide-watch').textContent).toBe('Watch in Stash');
    expect(q('.tvguide-banner-details').textContent.length).toBeGreaterThan(60);
    expect(q('.tvguide-banner-details').textContent).toMatch(/\.$/);
    expect(q('.tvguide-play').getAttribute('aria-label')).toBe('Pause');
    // The closures behind the replaced labels still act on original entities.
    q('.tvguide-related[data-source="performer"] button').click();
    expect(store.getState().temporaryChannel.name).toBe('Private performer, Jr.');
});

it('masks names from late DOM changes and new attributes without remounting playback', async () => {
    const { root, q, viewer, store } = mount();
    store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'fullscreen' });
    q('.tvguide-player-stage').dispatchEvent(new MouseEvent('mousemove'));
    await Promise.resolve();
    const textNode = q('.tvguide-channel-info-program').firstChild;
    expectNoLibraryText(root);
    expect(q('.tvguide-channel-info-performers').textContent).toBe('Casey Hayes');
    expect(q('.tvguide-channel-info-performers').textContent)
        .toBe(q('.tvguide-related[data-source="performer"] button').textContent);
    expect(q('.tvguide-channel-info-studio').alt).toMatch(/ (Pictures|Studios|Productions|Films)$/);
    textNode.data = 'Another private title';
    q('.tvguide-channel-info-studio').alt = 'Another private studio';
    const recent = document.createElement('span');
    recent.className = 'tvguide-recent-now';
    recent.textContent = scene.title;
    root.append(recent);
    await Promise.resolve();
    expect(textNode.data).not.toBe('Another private title');
    expect(q('.tvguide-channel-info-studio').alt).toMatch(/ (Pictures|Studios|Productions|Films)$/);
    expect(q('.tvguide-channel-info-program').firstChild).toBe(textNode);
    expect(q('video')).toBe(viewer.element);
    expect(recent.textContent).toBe(q('.tvguide-banner-title').textContent);
});

it('does not rewrite original metadata through editor inputs and restores originals when disabled', async () => {
    const { store, q, filter } = mount();
    store.dispatch({ type: Events.SET_CHANNEL_PREF, channelId: channel.id, patch: { name: 'Private custom name', logoUrl: '/private-logo.png' } });
    q('.tvguide-manager-edit').click();
    await Promise.resolve();
    const input = q('input[id^="tvguide-edit-name-"]');
    const logo = q('input[id^="tvguide-edit-logo-"]');
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
    expect(input.getAttribute('value')).toBe('');
    expect(logo.value).toBe('');
    expect(store.getState().prefs[channel.id].name).toBe('Private custom name');
    // Disable directly to exercise restoration of retained DOM, not a rerender.
    store.getState().settings.guide_sfw_text = false;
    filter.refresh();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('Private custom name');
    expect(logo.value).toBe('/private-logo.png');
    expect(q('.tvguide-banner-title').textContent).toBe(scene.title);
    expect(q('.tvguide-manager-search').type).toBe('search');
});

it('is opt-in, preserves search values, and uses the same aliases after restarting', async () => {
    const { root, q, store, filter } = mount(false);
    expect(q('.tvguide-banner-title').textContent).toBe(scene.title);
    const search = q('.tvguide-manager-search');
    search.value = 'Private';
    store.dispatch({ type: Events.SETTINGS_LOADED, settings: { ...store.getState().settings, guide_sfw_text: true } });
    search.value = 'Private';
    filter.refresh();
    expect(search.type).toBe('password');
    expect(search.value).toBe('Private');
    const masked = q('.tvguide-banner-title').textContent;
    filter.refresh();
    expect(q('.tvguide-banner-title').textContent).toBe(masked);
    filter.destroy();
    expect(q('.tvguide-banner-title').textContent).toBe(scene.title);
    const restarted = createSfwText({ root, getState: store.getState });
    expect(q('.tvguide-banner-title').textContent).toBe(masked);
    restarted.destroy();
    q('.tvguide-banner-title').textContent = 'After teardown';
    await Promise.resolve();
    expect(q('.tvguide-banner-title').textContent).toBe('After teardown');
});

it('replaces new and changing artwork in place and restores the latest originals', async () => {
    const { root, q, store, filter } = mount();
    const image = q('.tvguide-banner-poster');
    const firstArtwork = image.src;
    expect(firstArtwork).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(firstArtwork)).toContain('DEMO');
    expect(decodeURIComponent(firstArtwork)).not.toContain('private');
    image.src = '/updated-poster.jpg';
    image.srcset = '/private-large.jpg 2x';
    image.style.width = '160px';
    const next = document.createElement('img');
    next.src = '/new-logo.jpg';
    root.append(next);
    await Promise.resolve();
    expect(q('.tvguide-banner-poster')).toBe(image);
    expect(image.style.width).toBe('160px');
    expect(image.src).toMatch(/^data:image\/svg\+xml,/);
    expect(image.src).not.toBe(firstArtwork);
    expect(image.getAttribute('srcset')).toBeNull();
    expect(next.src).toMatch(/^data:image\/svg\+xml,/);
    store.getState().settings.guide_sfw_text = false;
    filter.refresh();
    expect(image.getAttribute('src')).toBe('/updated-poster.jpg');
    expect(image.getAttribute('srcset')).toBe('/private-large.jpg 2x');
    expect(next.getAttribute('src')).toBe('/new-logo.jpg');
});

it('keeps original pixels hidden during DOM updates and fullscreen, leaving demo text and controls readable', () => {
    const { root, q, store } = mount();
    const style = document.createElement('style');
    style.textContent = readFileSync('src/styles/sfwSwitch.css', 'utf8') + readFileSync('src/styles/demo.css', 'utf8');
    document.head.append(style);
    try {
        root.classList.add('tvguide-sfw', 'tvguide-sfw-locked');
        for (const mode of ['corner', 'theater', 'fullscreen']) {
            store.dispatch({ type: Events.SET_PLAYER_MODE, mode });
            q('.tvguide-player-stage').dispatchEvent(new MouseEvent('mouseenter'));
            expect(getComputedStyle(q('video')).visibility).toBe('hidden');
            expect(getComputedStyle(q('canvas')).visibility).toBe('hidden');
            expect(getComputedStyle(q('.tvguide-banner-poster')).visibility).toBe('visible');
            expect(getComputedStyle(q('.tvguide-banner-title')).filter).toBe('');
            expect(getComputedStyle(q('.tvguide-play')).visibility).toBe('visible');
        }
        // A newly inserted real source is hidden even before MutationObserver runs.
        const fresh = document.createElement('img');
        fresh.src = '/private.jpg';
        root.append(fresh);
        expect(getComputedStyle(fresh).visibility).toBe('hidden');
        fresh.dispatchEvent(new MouseEvent('mouseover'));
        expect(getComputedStyle(fresh).visibility).toBe('hidden');
    } finally { style.remove(); }
});

it('enforces silent playback before tuning and after external unmuting without saving a preference', () => {
    const { store, viewer, filter, q } = mount();
    const real = { tune: jest.fn(), setMuted: jest.fn() };
    const demoViewer = withDemoPlayback(real, store.getState);
    demoViewer.tune(scene, 500, false);
    demoViewer.setMuted(false);
    expect(real.tune).toHaveBeenCalledWith(scene, 500, true);
    expect(real.setMuted).toHaveBeenCalledWith(true);
    const originalState = store.getState();
    viewer.element.muted = false;
    viewer.element.dispatchEvent(new Event('volumechange'));
    expect(viewer.element.muted).toBe(true);
    expect(store.getState()).toBe(originalState);
    expect(q('.tvguide-mute').disabled).toBe(true);
    expect(q('.tvguide-mute').getAttribute('aria-label')).toBe('Muted in demo mode');
    store.getState().settings.guide_sfw_text = false;
    filter.refresh();
    expect(viewer.element.muted).toBe(false);
    demoViewer.setMuted(false);
    expect(real.setMuted).toHaveBeenLastCalledWith(false);
    expect(q('.tvguide-mute').disabled).toBe(false);
});

it('blocks content links and keyboard escapes to real content, and releases them when disabled', () => {
    const { q, store, filter } = mount();
    expect(q('.tvguide-watch').disabled).toBe(true);
    expect(q('a.tvguide-manager-row-name').getAttribute('href')).toBeNull();
    const onClick = jest.fn();
    q('.tvguide-banner-logo-button').addEventListener('click', onClick);
    q('.tvguide-banner-logo-button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    for (const init of [{ key: 'm' }, { key: 'e' }, { key: 'Enter', shiftKey: true }]) {
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    }
    const inputEvent = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    q('.tvguide-manager-search').dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(false);
    store.getState().settings.guide_sfw_text = false;
    filter.refresh();
    expect(q('.tvguide-watch').disabled).toBe(false);
    expect(q('a.tvguide-manager-row-name').getAttribute('href')).toBe('/studios/1');
    const event = new KeyboardEvent('keydown', { key: 'e', cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

it('gives studios distinct wordmarks with matching names across guide, manager and fullscreen', async () => {
    const { root, q, store, filter } = mount(true, true);
    const first = q('.tvguide-manager-row[data-channel-id="studio:1"]');
    const second = q('.tvguide-manager-row[data-channel-id="studio:2"]');
    const name = first.querySelector('.tvguide-manager-row-name').textContent;
    const wordmark = first.querySelector('img').src;
    const svg = new DOMParser().parseFromString(decodeURIComponent(wordmark.split(',')[1]), 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.querySelector('title').textContent).toBe(name);
    expect([...svg.querySelectorAll('text')].map((node) => node.textContent).join(' ').toLowerCase())
        .toBe(name.toLowerCase());
    expect(second.querySelector('.tvguide-manager-row-name').textContent).not.toBe(name);
    expect(second.querySelector('img').src).not.toBe(wordmark);
    expect(q('.tvguide-row img').src).toBe(wordmark);
    expect(q('.tvguide-banner-logo img').src).toBe(wordmark);
    expect(q('.tvguide-list-channel').textContent).toBe(name);
    expect(q('.tvguide-banner-meta').textContent).toContain(name);
    expect(q('.tvguide-row img').alt).toBe(name);
    expect(q('.tvguide-row img').title).toBe(name);
    expect(q('.tvguide-banner-poster').src).not.toBe(wordmark);
    // Changing a logo URL or a display name must not create a new demo studio.
    store.dispatch({ type: Events.SET_CHANNEL_PREF, channelId: channel.id, patch: { name: 'Private custom name', logoUrl: '/custom-logo.png' } });
    expect(q('.tvguide-manager-row[data-channel-id="studio:1"] img').src).toBe(wordmark);
    expect(q('.tvguide-manager-row[data-channel-id="studio:1"] .tvguide-manager-row-name').textContent).toBe(name);
    store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'fullscreen' });
    q('.tvguide-player-stage').dispatchEvent(new MouseEvent('mousemove'));
    await Promise.resolve();
    expect(q('.tvguide-channel-info-studio').src).toBe(wordmark);
    expect(q('.tvguide-channel-info-studio').alt).toBe(name);
    expect(q('.tvguide-channel-info-name').textContent).toContain(name);
    expectNoLibraryText(root);
    store.getState().settings.guide_sfw_text = false;
    filter.refresh();
    expect(q('.tvguide-channel-info-studio').getAttribute('src')).toBe('/logo.png');
    expect(q('.tvguide-channel-info-studio').alt).toBe(scene.studio.name);
    expect(q('.tvguide-row img').getAttribute('title')).toBeNull();
});
