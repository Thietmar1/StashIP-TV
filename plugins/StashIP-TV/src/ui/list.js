/**
 * The phone layout: a vertical Now/Next list.
 *
 * A three-hour time-grid on a 390px screen is unreadable, so narrow viewports
 * get the layout that actually suits them -- and descriptions, which have
 * nowhere to go in a grid block, fit here.
 *
 * Same state, same selectors, different renderer.
 */

import { el, replaceChildren } from './dom.js';
import { formatClock, formatRemaining } from '../domain/format.js';
import { sceneTitle } from '../api/scenes.js';
import { Events } from '../state/actions.js';
import { PoolStatus } from '../state/initialState.js';
import * as sel from '../state/selectors.js';
import { logoBadge } from './logoBadge.js';

export function createList({ store, onRowVisible }) {
    const root = el('div', {
        class: 'tvguide-list',
        role: 'list',
        'aria-label': 'Channel guide'
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
                  { root: null, rootMargin: '300px' }
              )
            : null;

    let renderedChannelIds = '';
    let renderedFocusChannelId = null;
    const renderedRows = new WeakMap();

    function scrollToItem(item, alignStart = false) {
        if (!item) return;
        const scroller = root.closest('.tvguide-overlay') || root;
        const top = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        if (alignStart || top < scroller.scrollTop) scroller.scrollTop = top;
        else if (top + item.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
            scroller.scrollTop = Math.max(0, top + item.offsetHeight - scroller.clientHeight);
        }
    }

    return {
        element: root,

        render(state) {
            const ids = state.dayKey + ':' + state.channels.map((c) => c.id).join(',');
            if (ids !== renderedChannelIds) {
                renderedChannelIds = ids;
                build(state);
            }
            update(state);
            if (state.focus?.source === 'keyboard'
                && state.focus.channelId !== renderedFocusChannelId
                && state.playerMode !== 'fullscreen') {
                const item = [...root.querySelectorAll('[data-channel-id]')]
                    .find((node) => node.dataset.channelId === state.focus.channelId);
                scrollToItem(item);
            }
            renderedFocusChannelId = state.focus?.channelId ?? null;
        },

        scrollChannelIntoView(channelId) {
            const safeId = String(channelId).replace(/"/g, '\\"');
            const item = root.querySelector(`[data-channel-id="${safeId}"]`);
            scrollToItem(item, true);
        },

        destroy() {
            if (observer) observer.disconnect();
        }
    };

    function build(state) {
        observer?.disconnect();
        // A filter that matched nothing needs saying; an empty lineup is already
        // reported by the toolbar status.
        if (state.channels.length === 0 && sel.isFilteredEmpty(state)) {
            replaceChildren(root, el('p', { class: 'tvguide-list-empty' }, 'No channels match.'));
            return;
        }

        replaceChildren(
            root,
            state.channels.map((channel) => {
                const item = el('div', {
                    class: 'tvguide-list-item',
                    role: 'listitem',
                    'data-channel-id': channel.id
                });
                if (observer) observer.observe(item);
                return item;
            })
        );
    }

    function update(state) {
        for (const item of root.querySelectorAll('.tvguide-list-item')) {
            const channelId = item.dataset.channelId;
            const channel = state.channels.find((c) => c.id === channelId);
            if (!channel) continue;

            const isTuned = channelId === state.tunedChannelId;
            item.classList.toggle('tvguide-list-item-tuned', isTuned);

            const status = sel.poolStatus(state, channelId);
            const live = sel.liveProgram(state, channelId);
            const next = sel.nextProgram(state, channelId);
            const signature = [channel, isTuned, status, live?.scene, live?.startMs, next?.scene, next?.startMs,
                state.settings.guide_12_hour_clock];
            const previous = renderedRows.get(item);
            if (previous && signature.every((value, i) => value === previous[i])) {
                if (live) {
                    const pct = Math.min(100, Math.max(0, ((state.nowMs - live.startMs) / live.durationMs) * 100));
                    item.querySelector('.tvguide-progress')?.setAttribute('aria-valuenow', String(Math.round(pct)));
                    const fill = item.querySelector('.tvguide-progress-fill');
                    if (fill) fill.style.width = `${pct}%`;
                    const times = item.querySelector('.tvguide-list-times');
                    const text = timeText(state, live, next);
                    if (times && times.textContent !== text) times.textContent = text;
                }
                continue;
            }
            renderedRows.set(item, signature);

            replaceChildren(
                item,
                el(
                    'button',
                    {
                        class: 'tvguide-list-button',
                        type: 'button',
                        'aria-pressed': isTuned ? 'true' : 'false',
                        onclick: () => {
                            store.dispatch({
                                type: Events.FOCUS_CELL,
                                channelId,
                                timeMs: live ? live.startMs : state.nowMs
                            });
                            store.dispatch({ type: Events.TUNE, channelId, scrollIntoView: false });
                        }
                    },
                    el(
                        'span',
                        { class: 'tvguide-list-head' },
                        logoBadge(channel),
                        el('span', { class: 'tvguide-list-channel' }, channel.name),
                        isTuned ? el('span', { class: 'tvguide-live-badge' }, 'WATCHING') : null
                    ),
                    body(state, status, live, next)
                ),
                // No per-row Watch button: tapping the row already tunes, and
                // the player carries its own Watch control.
                null
            );
        }
    }

    function timeText(state, live, next) {
        return `${formatRemaining(live.endMs - state.nowMs)}`
            + (next ? ` · Next ${formatClock(next.startMs, state.settings.guide_12_hour_clock)}: ${sceneTitle(next.scene)}` : '');
    }

    function body(state, status, live, next) {
        if (status === PoolStatus.ERROR) {
            return el('span', { class: 'tvguide-list-empty' }, 'Could not load');
        }
        if (status !== PoolStatus.READY) {
            return el('span', { class: 'tvguide-list-skeleton' });
        }
        if (!live) {
            return el('span', { class: 'tvguide-list-empty' }, 'No programming');
        }

        const pct = ((state.nowMs - live.startMs) / live.durationMs) * 100;

        return el(
            'span',
            { class: 'tvguide-list-body' },
            el('span', { class: 'tvguide-list-now' }, sceneTitle(live.scene)),
            live.scene.details
                ? el('span', { class: 'tvguide-list-details' }, live.scene.details)
                : null,
            el(
                'span',
                {
                    class: 'tvguide-progress',
                    role: 'progressbar',
                    'aria-valuemin': '0',
                    'aria-valuemax': '100',
                    'aria-valuenow': String(Math.round(pct)),
                    'aria-label': 'Programme progress'
                },
                el('span', {
                    class: 'tvguide-progress-fill',
                    style: { width: `${Math.min(100, Math.max(0, pct))}%` }
                })
            ),
            el(
                'span',
                { class: 'tvguide-list-times' },
                timeText(state, live, next)
            )
        );
    }
}
