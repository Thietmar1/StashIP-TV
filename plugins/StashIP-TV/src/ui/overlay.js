/**
 * The overlay shell: chrome, layout switching, and hash routing.
 *
 * Deliberately a DOM overlay rather than a PluginApi route -- the other plugins
 * in this repo avoid coupling to Stash's React internals, which shift between
 * releases. The `#tvguide` hash gives back the parts of a real route that
 * matter: Back closes the guide, and the URL can be shared.
 */

import { el, replaceChildren } from './dom.js';
import { Events } from '../state/actions.js';
import { SOURCE_LABELS } from '../domain/lineup.js';
import { PINNED_GROUP } from '../domain/channelPrefs.js';
import { setIcon, ICONS } from './icons.js';
import * as sel from '../state/selectors.js';
import { createBanner } from './banner.js';
import { createGrid } from './grid.js';
import { createList } from './list.js';
import { trapFocus } from './a11y.js';
import { createManager } from './manager.js';
import { createPlayer } from './player.js';
import { logoBadge } from './logoBadge.js';

const TYPE_LABELS = { ...SOURCE_LABELS, [PINNED_GROUP]: 'Pinned' };

export const HASH = '#tvguide';
export const BODY_CLASS = 'stash-tvguide-active';

const SHORTCUTS = [
    ['← →', 'Previous / next programme'],
    ['↑ ↓', 'Previous / next channel'],
    ['← → (player)', 'Tune previous / next channel'],
    ['Space (player)', 'Play / pause'],
    ['Scroll down / swipe up (fullscreen)', 'Tune next channel'],
    ['Page Up / Down', 'Pan by one screen'],
    ['Home / End', 'Jump to window edges'],
    ['N', 'Back to now'],
    ['Enter', 'Watch in the corner viewer'],
    ['E', 'Open the scene at its live position'],
    ['M', 'Mute or unmute'],
    ['C', 'Manage channels'],
    ['?', 'This help'],
    ['Esc', 'Close the guide']
];

export function createOverlay({ store, viewer, announcer, touchGuard, onRowVisible }) {
    const banner = createBanner({ store });
    const manager = createManager({ store });
    const grid = createGrid({ store, onRowVisible, touchGuard });
    const list = createList({ store, onRowVisible });

    const player = createPlayer({ store, viewer });

    const status = el('div', { class: 'tvguide-status' });

    // Panning has no meaning in the list layout -- there is no time window --
    // so these are hidden there rather than shown as dead buttons.
    const timeControls = el(
        'div',
        { class: 'tvguide-time-controls' },
        panButton('‹‹', 'Pan back', () => pan(-1)),
        el('button', {
            class: 'tvguide-now',
            type: 'button',
            text: 'Now',
            onclick: () => store.dispatch({ type: Events.GO_TO_NOW })
        }),
        panButton('››', 'Pan forward', () => pan(1))
    );

    const guideSearch = el('input', {
        type: 'search',
        class: 'tvguide-search',
        'aria-label': 'Search channels',
        placeholder: 'Search channels…',
        oninput: (e) => store.dispatch({ type: Events.GUIDE_SEARCH, query: e.target.value })
    });

    const searchClear = el('button', {
        class: 'tvguide-search-clear',
        type: 'button',
        hidden: true,
        'aria-label': 'Clear search',
        text: '\u00d7',
        onclick: () => {
            store.dispatch({ type: Events.GUIDE_SEARCH, query: '' });
            guideSearch.focus();
        }
    });

    const searchBox = el(
        'div',
        { class: 'tvguide-searchbox' },
        el('span', { class: 'tvguide-search-icon', 'aria-hidden': 'true' }),
        guideSearch,
        searchClear
    );
    setIcon(searchBox.firstChild, 'search');

    const typeSelect = el('select', {
        class: 'tvguide-type-select',
        'aria-label': 'Channel grouping',
        onchange: () => {
            const value = typeSelect.value;
            if (value !== 'all' && store.getState().collapsedGroups.includes(value)) {
                store.dispatch({ type: Events.TOGGLE_GROUP, key: value });
            }
            store.dispatch({ type: Events.SET_TYPE_FILTER, typeFilter: value });
            if (value !== 'all' && sel.isGridLayout(store.getState())) {
                grid.scrollGroupIntoView(value);
            }
        }
    });
    const typeBar = el('div', { class: 'tvguide-typebar' }, typeSelect);
    let renderedTypes = null;

    const stage = el('div', { class: 'tvguide-stage' });
    const recentPanel = el('div', { class: 'tvguide-recent-panel', hidden: true });
    const recentButton = el('button', {
        class: 'tvguide-recent',
        type: 'button',
        'aria-label': 'Recent channels',
        title: 'Recent channels',
        onclick: () => {
            const opening = recentPanel.hidden;
            recentPanel.hidden = !opening;
            if (opening) {
                (store.getState().recentChannelIds || []).forEach((channelId) =>
                    store.dispatch({ type: Events.POOL_REQUESTED, channelId })
                );
            }
        }
    });
    setIcon(recentButton, 'history');

    const listTop = el('button', {
        class: 'tvguide-list-top',
        type: 'button',
        text: 'Top',
        'aria-label': 'Scroll to the top of the channel list',
        onclick: () => { root.scrollTop = 0; }
    });

    const helpPanel = el(
        'div',
        { class: 'tvguide-help', hidden: true, role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
        el('h2', {}, 'Keyboard shortcuts'),
        el(
            'dl',
            {},
            SHORTCUTS.flatMap(([keys, description]) => [
                el('dt', {}, keys),
                el('dd', {}, description)
            ])
        )
    );

    const closeButton = el('button', {
        class: 'tvguide-close',
        type: 'button',
        'aria-label': 'Close StashIP-TV',
        onclick: () => close()
    }, ICONS.close());

    const toolbarRight = el(
        'div',
        { class: 'tvguide-toolbar-right' },
        typeBar,
        el('span', { class: 'tvguide-toolbar-divider', 'aria-hidden': 'true' }),
        recentButton,
        recentPanel,
        listTop,
        el('button', {
            class: 'tvguide-jump',
            type: 'button',
            text: 'Current',
            'aria-label': 'Jump to the channel playing now',
            onclick: () => {
                const state = store.getState();
                const view = sel.isGridLayout(state) ? grid : list;
                if (state.tunedChannelId) view.scrollChannelIntoView(state.tunedChannelId);
            }
        }),
        el('button', {
            class: 'tvguide-manage',
            type: 'button',
            text: 'Channels',
            onclick: () => store.dispatch({ type: Events.MANAGER_OPEN })
        }),
        status,
        closeButton
    );

    const topbar = el(
        'div',
        { class: 'tvguide-topbar' },
        timeControls,
        searchBox,
        toolbarRight
    );

    const root = el(
        'div',
        {
            class: 'tvguide-overlay',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'StashIP-TV'
        },
        // Details first, then the single toolbar that acts on the channels
        // below it. The controls used to sit above the details, which put the
        // channel chrome further from the channels than the scene blurb was.
        el('header', { class: 'tvguide-header' }, banner.element, player.element),
        topbar,
        stage,
        manager.element,
        helpPanel,
        announcer.element
    );

    let releaseFocus = null;
    let detachTouch = null;
    let mountedLayout = null;
    let lockedScrollY = 0;
    let renderedMode = null;
    const modeScrollPositions = new Map();

    function panButton(label, ariaLabel, onclick) {
        return el('button', { class: 'tvguide-pan', type: 'button', 'aria-label': ariaLabel, onclick }, label);
    }

    function pan(direction) {
        store.dispatch({ type: Events.PAN, deltaMs: direction * sel.windowMs(store.getState()) });
    }

    function open() {
        if (store.getState().open) return;
        if (window.location.hash !== HASH) {
            window.history.pushState({ tvguide: true }, '', HASH);
        }
        store.dispatch({ type: Events.OPEN, nowMs: Date.now() });
    }

    function close() {
        if (!store.getState().open) return;
        store.dispatch({ type: Events.CLOSE });
        if (window.location.hash === HASH) window.history.back();
    }

    function mount() {
        if (root.isConnected) return;
        document.body.appendChild(root);

        // `overflow: hidden` alone does not lock scrolling in iOS Safari, which
        // is why the page behind the guide could still be panned sideways on an
        // iPad. Pinning the body is what actually holds it.
        lockedScrollY = window.scrollY || 0;
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.classList.add(BODY_CLASS);
        releaseFocus = trapFocus(root);
        detachTouch = touchGuard.attach(root);
    }

    function unmount() {
        if (!root.isConnected) return;
        if (detachTouch) detachTouch();
        if (releaseFocus) releaseFocus();
        detachTouch = null;
        releaseFocus = null;
        document.body.classList.remove(BODY_CLASS);
        document.body.style.top = '';
        window.scrollTo(0, lockedScrollY);
        root.remove();
    }

    return {
        element: root,
        open,
        close,
        toggleHelp() {
            helpPanel.hidden = !helpPanel.hidden;
        },

        render(state) {
            if (!state.open) {
                unmount();
                return;
            }
            mount();
            // The guide is behind native fullscreen; leave its layout idle,
            // but keep the visible controls in sync with playback state.
            if (player.isNativeFullscreenActive()) {
                player.renderControls(state);
                return;
            }
            const modeChanged = renderedMode !== null && state.playerMode !== renderedMode;
            const guideScroller = sel.isGridLayout(state)
                ? grid.element.querySelector('.tvguide-grid-scroll') : list.element;
            const guideScrollTop = modeChanged ? guideScroller.scrollTop : null;
            if (modeChanged && renderedMode) modeScrollPositions.set(renderedMode, root.scrollTop);
            renderedMode = state.playerMode;
            root.classList.toggle('is-theater', state.layout !== 'list' && state.playerMode === 'theater');
            root.classList.toggle('has-player', Boolean(state.settings.guide_autoplay));
            // On the overlay, not the player: the header sizes itself from this
            // and custom properties only inherit downwards.
            root.style.setProperty('--tvguide-player-width', `${state.playerWidthPx}px`);

            // Grid and list are two renderers over one state; only the one in
            // use is in the DOM, so neither pays for the other.
            const view = sel.isGridLayout(state) ? grid : list;
            if (mountedLayout !== state.layout) {
                mountedLayout = state.layout;
                replaceChildren(stage, view.element);
                if (state.layout === 'list') topbar.insertBefore(closeButton, toolbarRight);
                else toolbarRight.appendChild(closeButton);
            }

            timeControls.hidden = !sel.isGridLayout(state);
            listTop.hidden = sel.isGridLayout(state);
            if (guideSearch.value !== state.guideSearch) guideSearch.value = state.guideSearch;
            searchClear.hidden = state.guideSearch === '';
            renderTypeBar(state);
            const recent = sel.recentChannels(state);
            replaceChildren(recentPanel, recent.length ? recent.map(({ channel, program }) =>
                el('button', { class: 'tvguide-recent-row', type: 'button', onclick: () => { store.dispatch({ type: Events.TUNE, channelId: channel.id }); recentPanel.hidden = true; } },
                    logoBadge(channel), el('span', { class: 'tvguide-recent-name' }, channel.name), el('span', { class: 'tvguide-recent-now' }, program?.scene?.title || 'Nothing scheduled'))
            ) : el('p', { class: 'tvguide-recent-empty' }, 'No recent channels.'));

            banner.render(state);
            view.render(state);
            if (state.guideScrollChannelId) {
                view.scrollChannelIntoView?.(state.guideScrollChannelId, 'start');
                store.dispatch({ type: Events.CONSUME_GUIDE_SCROLL });
            }
            manager.render(state);
            player.render(state);
            if (modeChanged && state.layout !== 'list') {
                // Restore after layout updates, which can clamp scroll offsets.
                // The channel position is shared; each mode remembers its own
                // outer position so returning to theater does not jump to video.
                if (!state.guideScrollChannelId) guideScroller.scrollTop = guideScrollTop;
                root.scrollTop = modeScrollPositions.get(state.playerMode) || 0;
            }
            renderStatus(state);
        },

        player,

        destroy() {
            manager.destroy();
            grid.destroy();
            list.destroy();
            player.destroy();
            unmount();
        }
    };

    // Keep the native select and its options alive during clock/pool updates,
    // so rendering cannot interrupt a grouping selection in progress.
    function renderTypeBar(state) {
        const types = sel.availableTypes(state);
        typeBar.hidden = types.length < 2;
        const signature = JSON.stringify(types);
        if (signature !== renderedTypes) {
            renderedTypes = signature;
            replaceChildren(
                typeSelect,
                [['all', 'All'], ...types.map((t) => [t, TYPE_LABELS[t] || t])].map(
                    ([value, label]) => el('option', { value }, label)
                )
            );
        }
        if (typeSelect.value !== state.typeFilter) typeSelect.value = state.typeFilter;
    }

    function renderStatus(state) {
        if (sel.isLoading(state)) {
            replaceChildren(status, 'Loading channels…');
            return;
        }
        if (sel.loadError(state)) {
            replaceChildren(status, `Could not load channels: ${sel.loadError(state)}`);
            return;
        }
        if (!sel.hasChannels(state)) {
            replaceChildren(
                status,
                'No channels. Lower the minimum scene count in the plugin settings.'
            );
            return;
        }

        const errors = sel.sourceErrors(state);
        replaceChildren(
            status,
            errors.length > 0 ? `${errors.length} source(s) failed to load` : ''
        );
    }
}
