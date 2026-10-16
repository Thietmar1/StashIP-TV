/**
 * The desktop time-grid: rows are channels, the x axis is the clock.
 *
 * Blocks are positioned by percentage, so the grid needs no pixel measurement
 * and stays correct through any resize. Rows render as skeletons until their
 * pool arrives; an IntersectionObserver asks for it, so a long lineup only
 * fetches what you actually look at.
 *
 * Two things here are easy to get wrong and are worth stating:
 *
 * - **The now-line and gridlines live in a track overlay**, not in the scroll
 *   container. Their `left: %` has to be a percentage of the track *after* the
 *   channel column; positioning them against the full container and adding a
 *   margin (as this used to) puts the line progressively further right the later
 *   in the window it falls.
 * - **Channels are always grouped**, and collapsed groups render no rows, so the
 *   flattened `state.channels` the reducer walks matches the DOM exactly.
 * - **Nothing here may call `scrollIntoView`, or `focus()` without
 *   `preventScroll`.** Both scroll every ancestor scroll container, and in
 *   theater mode the overlay itself is one -- which drags the player off screen
 *   the moment the grid re-adopts focus.
 */

import { el, replaceChildren } from './dom.js';
import { formatClock } from '../domain/format.js';
import { sceneTitle } from '../api/scenes.js';
import { programAt } from '../domain/schedule.js';
import { PINNED_GROUP } from '../domain/channelPrefs.js';
import { SOURCE_LABELS } from '../domain/lineup.js';
import { Events } from '../state/actions.js';
import { PoolStatus } from '../state/initialState.js';
import * as sel from '../state/selectors.js';
import { logoBadge } from './logoBadge.js';
import { createChannelRail } from './channelRail.js';

const GROUP_LABELS = { ...SOURCE_LABELS, [PINNED_GROUP]: 'Pinned' };

export function createGrid({ store, onRowVisible, touchGuard }) {
    const dateLabel = el('div', { class: 'tvguide-grid-corner' });
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
        weekday: 'short', month: 'short', day: 'numeric'
    });
    const ticksRow = el('div', { class: 'tvguide-ticks', 'aria-hidden': 'true' });
    const gridlines = el('div', { class: 'tvguide-gridlines', 'aria-hidden': 'true' });
    const nowLine = el('div', { class: 'tvguide-nowline', 'aria-hidden': 'true' });

    // Percentages inside this element are percentages of the track, which is
    // what makes the now-line land on the right minute.
    const trackOverlay = el(
        'div',
        { class: 'tvguide-track-overlay', 'aria-hidden': 'true' },
        gridlines,
        nowLine
    );

    const body = el('div', {
        class: 'tvguide-grid-body',
        role: 'grid',
        'aria-label': 'Channel guide',
        'aria-readonly': 'true'
    });

    const inner = el('div', { class: 'tvguide-grid-inner' }, trackOverlay, body);
    const scroll = el('div', { class: 'tvguide-grid-scroll' }, inner);

    const rail = createChannelRail({
        store,
        // 'start': you asked for T, so a T channel is what should be at the top.
        onJump: (channelId) => scrollChannelIntoView(channelId, 'start')
    });

    const root = el(
        'div',
        { class: 'tvguide-grid' },
        el(
            'div',
            { class: 'tvguide-grid-head' },
            dateLabel,
            ticksRow
        ),
        // The rail sits alongside the rows, pinned, while they scroll past it.
        el('div', { class: 'tvguide-grid-main' }, rail.element, scroll)
    );

    // Hovering shows a programme in the details; leaving the grid puts them back
    // on what is playing. Only a hover-sourced focus is reset -- a pinned
    // programme or keyboard focus must survive the mouse leaving.
    body.addEventListener('mouseleave', () => {
        const state = store.getState();
        if (state.focus?.source !== 'hover') return;
        store.dispatch({ type: Events.FOCUS_LIVE });
    });

    const observer =
        typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(
                  (entries) => {
                      for (const entry of entries) {
                          if (entry.isIntersecting && entry.target.dataset.channelId) {
                              onRowVisible(entry.target.dataset.channelId);
                          }
                      }
                  },
                  { root: null, rootMargin: '200px' }
              )
            : null;

    let renderedRowSignature = '';
    let renderedFocusChannelId = null;
    let dragChannelId = null;
    let railGroupKey = null;
    // Set while the grid moves DOM focus itself, so the block's own `onfocus`
    // cannot promote a hover into a keyboard focus -- which is what the banner's
    // mouse-leave revert keys on.
    let programmaticFocus = false;

    // The rail belongs to the group you are scrolled into, so it has to follow
    // the scroll -- but through a local, never the store: a dispatch per scroll
    // frame would re-render the whole grid.
    scroll.addEventListener('scroll', () => syncRail(store.getState()), { passive: true });

    return {
        element: root,

        render(state) {
            renderTicks(state);
            renderGridlines(state);
            renderNowLine(state);

            const signature = rowsSignature(state);
            if (signature !== renderedRowSignature) {
                renderedRowSignature = signature;
                buildRows(state);
            } else {
                updateRows(state);
            }

            if (state.focus?.source === 'keyboard'
                && state.focus.channelId !== renderedFocusChannelId
                && state.playerMode !== 'fullscreen') {
                scrollChannelIntoView(state.focus.channelId, 'nearest');
            }
            renderedFocusChannelId = state.focus?.channelId ?? null;
            syncRail(state);
        },

        scrollChannelIntoView,
        scrollGroupIntoView,

        destroy() {
            if (observer) observer.disconnect();
        }
    };

    // ---- chrome -------------------------------------------------------------

    function scrollGroupIntoView(key) {
        const header = body.querySelector(`.tvguide-group[data-group="${cssEscape(key)}"]`);
        if (header) scrollTo(header, 'start');
    }

    function renderTicks(state) {
        dateLabel.textContent = dateFormatter.format(state.nowMs);
        replaceChildren(
            ticksRow,
            sel.ticks(state).map((tick) =>
                el('span', { class: 'tvguide-tick', style: { left: `${tick.leftPct}%` } }, tick.label)
            )
        );
    }

    /** Vertical rules at each half hour, so a block's edges can be read. */
    function renderGridlines(state) {
        replaceChildren(
            gridlines,
            sel.ticks(state).map((tick) =>
                el('span', { class: 'tvguide-gridline', style: { left: `${tick.leftPct}%` } })
            )
        );
    }

    function renderNowLine(state) {
        const pct = sel.nowMarkerPct(state);
        if (pct == null) {
            nowLine.style.display = 'none';
            return;
        }
        nowLine.style.display = '';
        nowLine.style.left = `${pct}%`;
    }

    // ---- rows ---------------------------------------------------------------

    function rowsSignature(state) {
        return state.dayKey + ':' + state.channelGroups
            .map(
                (group) =>
                    `${group.key}:${group.collapsed ? 'c' : 'o'}:` +
                    group.channels.map((c) => `${c.id}~${c.name}~${c.logo?.url || c.logo?.initials || ''}`).join(',')
            )
            .join('|');
    }

    function buildRows(state) {
        observer?.disconnect();
        const nodes = [];
        for (const group of state.channelGroups) {
            nodes.push(groupHeader(group));
            if (group.collapsed) continue;
            for (const channel of group.channels) {
                nodes.push(channelRow(state, group, channel));
            }
        }
        // A search or type filter that matched nothing needs saying here. Every
        // group merely being collapsed does not -- the headers explain
        // themselves, and there is no lineup problem to report.
        if (nodes.length === 0 && sel.isFilteredEmpty(state)) {
            nodes.push(el('div', { class: 'tvguide-grid-empty' }, 'No channels match.'));
        }
        replaceChildren(body, nodes);
        updateRows(state);
    }

    /**
     * Which group the scroll position is inside: the last header at or above it.
     */
    function currentGroupKey() {
        const headers = body.querySelectorAll('.tvguide-group');
        let key = null;
        for (const header of headers) {
            if (header.offsetTop > scroll.scrollTop) break;
            key = header.dataset.group;
        }
        return key || (headers[0] ? headers[0].dataset.group : null);
    }

    function syncRail(state) {
        railGroupKey = currentGroupKey();
        rail.render(state, railGroupKey);
    }

    function groupHeader(group) {
        return el(
            'div',
            { class: 'tvguide-group', role: 'row', 'data-group': group.key },
            el(
                'button',
                {
                    class: 'tvguide-group-toggle',
                    type: 'button',
                    'aria-expanded': group.collapsed ? 'false' : 'true',
                    onclick: () => store.dispatch({ type: Events.TOGGLE_GROUP, key: group.key })
                },
                el('span', { class: 'tvguide-group-caret' }, group.collapsed ? '▸' : '▾'),
                el('span', { class: 'tvguide-group-label' }, GROUP_LABELS[group.key] || group.key),
                el('span', { class: 'tvguide-group-count' }, `(${group.count})`)
            )
        );
    }

    function channelRow(state, group, channel) {
        const pinned = state.pinOrder.includes(channel.id);
        const temporary = state.temporaryChannel?.id === channel.id;
        const savedTemporary = temporary && state.savedTemporaryChannelId === channel.id;
        const inPinnedGroup = group.key === PINNED_GROUP;
        const hasArtwork = channel.logo?.type === 'image';
        const showArtworkName = hasArtwork && channel.source === 'performer';

        const row = el(
            'div',
            {
                class: `tvguide-row${inPinnedGroup ? ' tvguide-row-pinned' : ''}`,
                role: 'row',
                'data-channel-id': channel.id,
                // Enumerated, not boolean: it needs the literal string.
                draggable: inPinnedGroup ? 'true' : false
            },
            el(
                'div',
                { class: 'tvguide-row-head', role: 'rowheader' },
                el(
                    'button',
                    {
                        class: 'tvguide-pin',
                        type: 'button',
                        'aria-label': temporary
                            ? savedTemporary ? `${channel.name} saved` : `Save temporary channel ${channel.name}`
                            : pinned ? `Unpin ${channel.name}` : `Pin ${channel.name}`,
                        title: temporary ? savedTemporary ? 'Saved' : 'Save channel' : undefined,
                        'aria-pressed': temporary ? null : pinned ? 'true' : 'false',
                        disabled: savedTemporary,
                        onclick: () => store.dispatch({
                            type: temporary ? Events.SAVE_TEMPORARY_CHANNEL : Events.TOGGLE_PIN,
                            channelId: channel.id
                        })
                    },
                    temporary ? savedTemporary ? '✓' : '＋' : pinned ? '★' : '☆'
                ),
                // Studio artwork is nearly always a wordmark, so showing the
                // name beside it said the same thing twice. Artwork replaces
                // the name; channels without it render the name as their badge.
                //
                // The badge is the channel button: pressing it watches that
                // channel, which is what pressing a channel in a guide means.
                // The way out to Stash lives on the badge in the scene details.
                el(
                    'button',
                    {
                        class: hasArtwork ? `tvguide-logo-button${showArtworkName ? ' tvguide-logo-button-with-name' : ''}` : 'tvguide-row-name',
                        type: 'button',
                        'aria-label': `Watch ${channel.name}`,
                        title: `Watch ${channel.name}`,
                        onclick: () => store.dispatch({
                            type: Events.TUNE,
                            channelId: channel.id,
                            scrollIntoView: false
                        })
                    },
                    hasArtwork ? [logoBadge(channel), showArtworkName ? el('span', { class: 'tvguide-logo-name' }, channel.name) : null] : channel.name
                )
            ),
            el('div', { class: 'tvguide-row-track' })
        );

        if (inPinnedGroup) attachDrag(row, channel.id);
        if (observer) observer.observe(row);
        return row;
    }

    /** Drag to reorder pinned channels; arrow keys do the same from the pin button. */
    function attachDrag(row, channelId) {
        row.addEventListener('dragstart', (event) => {
            dragChannelId = channelId;
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', (event) => event.preventDefault());
        row.addEventListener('drop', (event) => {
            event.preventDefault();
            if (!dragChannelId || dragChannelId === channelId) return;
            const order = store.getState().pinOrder;
            store.dispatch({
                type: Events.MOVE_PIN,
                channelId: dragChannelId,
                toIndex: order.indexOf(channelId)
            });
            dragChannelId = null;
        });
    }

    function updateRows(state) {
        for (const row of body.querySelectorAll('.tvguide-row')) {
            const channelId = row.dataset.channelId;
            const track = row.querySelector('.tvguide-row-track');
            const status = sel.poolStatus(state, channelId);

            row.classList.toggle('tvguide-row-tuned', channelId === state.tunedChannelId);

            const live = sel.liveProgram(state, channelId);
            const signature = [
                status,
                state.windowStartMs,
                state.settings.guide_12_hour_clock,
                sel.windowMs(state),
                state.dayKey,
                live?.startMs || '',
                live?.endMs || ''
            ].join('|');
            if (track.dataset.signature === signature) {
                restyleBlocks(state, channelId, track);
                continue;
            }
            track.dataset.signature = signature;

            if (status === PoolStatus.READY) renderTrack(state, channelId, track);
            else if (status === PoolStatus.ERROR) {
                replaceChildren(track, el('div', { class: 'tvguide-row-empty' }, 'Could not load'));
            } else {
                replaceChildren(track, el('div', { class: 'tvguide-row-skeleton' }));
            }
        }
    }

    function renderTrack(state, channelId, track) {
        const blocks = sel.rowPresentationBlocks(state, channelId);
        if (blocks.length === 0) {
            replaceChildren(track, el('div', { class: 'tvguide-row-empty' }, 'No programming'));
            return;
        }

        replaceChildren(track, blocks.map((block) => renderBlock(state, channelId, block)));
    }

    function renderBlock(state, channelId, { program, programs, rect, isLive, isFocused, title, dividerPct = [] }) {
        const activeProgram = isLive
            ? programAt(store.getState().schedules[channelId], store.getState().nowMs, store.getState().dayStartMs)
            : null;
        const displayTitle = activeProgram ? sceneTitle(activeProgram.scene) : title;
        const endMs = programs[programs.length - 1].endMs;
        const label = `${displayTitle}, ${formatClock(program.startMs, state.settings.guide_12_hour_clock)} to ${formatClock(endMs, state.settings.guide_12_hour_clock)}`;

        const block = el(
            'div',
            {
                class: [
                    'tvguide-block',
                    isLive && 'tvguide-block-live',
                    isFocused && 'tvguide-block-focused',
                    rect.clippedStart && 'tvguide-block-clip-start',
                    rect.clippedEnd && 'tvguide-block-clip-end'
                ]
                    .filter(Boolean)
                    .join(' '),
                role: 'gridcell',
                tabindex: isFocused ? '0' : '-1',
                'aria-label': label,
                'aria-selected': isFocused ? 'true' : 'false',
                'data-start-ms': String(program.startMs),
                'data-end-ms': String(endMs),
                style: { left: `${rect.leftPct}%`, width: `${rect.widthPct}%` },
                onclick: () => activate(channelId, isLive ? programAt(store.getState().schedules[channelId], store.getState().nowMs, store.getState().dayStartMs) : program),
                onfocus: () => {
                    // Our own `adoptFocus` triggers this too; recording that as
                    // a keyboard focus would upgrade a hover into something the
                    // mouse leaving can no longer undo.
                    if (programmaticFocus) return;
                    store.dispatch({
                        type: Events.FOCUS_CELL,
                        channelId,
                        timeMs: program.startMs,
                        source: 'keyboard'
                    });
                },
                onmouseenter: () => {
                    if (touchGuard && touchGuard.isSyntheticMouse()) return;
                    store.dispatch({
                        type: Events.FOCUS_CELL,
                        channelId,
                        timeMs: isLive ? programAt(store.getState().schedules[channelId], store.getState().nowMs, store.getState().dayStartMs).startMs : program.startMs,
                        source: 'hover'
                    });
                }
            },
            dividerPct.map((pct) => el('span', { class: 'tvguide-block-divider', style: { left: `${pct}%` } })),
            el('span', { class: 'tvguide-block-title' }, displayTitle),
            el('span', { class: 'tvguide-block-time' }, formatClock(program.startMs, state.settings.guide_12_hour_clock))
        );

        if (isFocused) adoptFocus(block);
        return block;
    }

    /**
     * Clicking a live block tunes; clicking anything else pins its details and
     * leaves the player alone. The reducer decides which, so the two paths
     * cannot disagree.
     */
    function activate(channelId, program) {
        store.dispatch({ type: Events.PIN_DETAILS, channelId, timeMs: program.startMs });
    }

    function restyleBlocks(state, channelId, track) {
        for (const block of track.querySelectorAll('.tvguide-block')) {
            const startMs = Number(block.dataset.startMs);
            const endMs = Number(block.dataset.endMs);

            block.classList.toggle('tvguide-block-live', startMs <= state.nowMs && endMs > state.nowMs);

            const isFocused =
                state.focus?.channelId === channelId &&
                startMs <= state.focus.timeMs &&
                endMs > state.focus.timeMs;

            block.classList.toggle('tvguide-block-focused', isFocused);
            block.tabIndex = isFocused ? 0 : -1;
            block.setAttribute('aria-selected', isFocused ? 'true' : 'false');

            if (isFocused) adoptFocus(block);
        }
    }

    function adoptFocus(block) {
        // The guide is not on screen in fullscreen; moving focus into it there
        // only risks scrolling something the user cannot see.
        if (store.getState().playerMode === 'fullscreen') return;

        const active = document.activeElement;
        const focusIsInGrid = active && (body.contains(active) || active === document.body);
        if (!focusIsInGrid || active === block) return;

        queueMicrotask(() => {
            if (!block.isConnected || document.activeElement === block) return;
            programmaticFocus = true;
            try {
                // `preventScroll` is load-bearing: without it every tick drags
                // the scroller back to the focused block, which is what undid a
                // letter jump a second after it happened.
                block.focus({ preventScroll: true });
            } finally {
                programmaticFocus = false;
            }
        });
    }

    // ---- navigation ---------------------------------------------------------

    function scrollChannelIntoView(channelId, block = 'center') {
        const row = body.querySelector(`.tvguide-row[data-channel-id="${cssEscape(channelId)}"]`);
        if (row) scrollTo(row, block);
    }

    /**
     * Scroll one element into view *within the grid*.
     *
     * Deliberately not `scrollIntoView`: that walks every ancestor scroll
     * container, and in theater mode the overlay is one of them -- so a jump by
     * letter also scrolled the player off the top of the screen.
     */
    function scrollTo(element, block) {
        if (block === 'nearest') {
            const top = element.offsetTop;
            const header = stickyHeaderHeight(element);
            const bottom = top + element.offsetHeight;
            if (top < scroll.scrollTop + header) {
                scroll.scrollTop = Math.max(0, top - header);
            } else if (bottom > scroll.scrollTop + scroll.clientHeight) {
                scroll.scrollTop = Math.max(0, bottom - scroll.clientHeight);
            }
            syncRail(store.getState());
            return;
        }
        // 'start' puts the element at the top of the viewport, allowing for the
        // group header stuck over it. Centring a letter jump left a screenful of
        // the *previous* letter above the channel you asked for.
        const offset =
            block === 'center'
                ? Math.max(0, (scroll.clientHeight - element.offsetHeight) / 2)
                : stickyHeaderHeight(element);

        scroll.scrollTop = Math.max(0, element.offsetTop - offset);
        syncRail(store.getState());
    }

    /** How much of `element` its own group header would cover once stuck. */
    function stickyHeaderHeight(element) {
        if (element.classList.contains('tvguide-group')) return 0;
        for (let node = element.previousElementSibling; node; node = node.previousElementSibling) {
            if (node.classList.contains('tvguide-group')) return node.offsetHeight || 0;
        }
        return 0;
    }

    function cssEscape(value) {
        return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
    }

}
