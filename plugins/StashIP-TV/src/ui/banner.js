/**
 * The detail banner.
 *
 * A time-grid cannot hold a description -- blocks are sized by runtime, not by
 * how much there is to say -- so the focused programme is described here
 * instead, the way a cable box does it.
 */

import { el, replaceChildren } from './dom.js';
import { Events } from '../state/actions.js';
import { formatClock, formatDuration, formatRemaining } from '../domain/format.js';
import { sceneTitle } from '../api/scenes.js';
import * as sel from '../state/selectors.js';
import { logoBadge } from './logoBadge.js';
import { openSource, sourceUrl } from './sourceLink.js';

export function createBanner({ store } = {}) {
    const root = el('div', { class: 'tvguide-banner' });
    let renderedScrollKey = null;
    let renderedScene = null;
    let renderedSignature = null;
    let expanded = false;

    function relatedSection(label, source, entities) {
        const unique = new Map();
        for (const entity of entities || []) {
            const id = String(entity?.id || '').trim();
            const name = String(entity?.name || '').trim();
            if (id && name) unique.set(id, { id, name });
        }
        if (unique.size === 0) return null;

        return el(
            'section',
            { class: 'tvguide-related', 'data-source': source, 'aria-label': label },
            el('span', { class: 'tvguide-related-label' }, label),
            el(
                'span',
                { class: 'tvguide-related-items' },
                [...unique.values()].map((entity) =>
                    el(
                        'button',
                        {
                            class: 'tvguide-related-chip',
                            type: 'button',
                            'aria-label': `Tune to ${entity.name}`,
                            onclick: () => store?.dispatch({ type: Events.TUNE_RELATED, source, entity })
                        },
                        entity.name
                    )
                )
            )
        );
    }

    function featuringSection(group) {
        if (!group || group.programs.length < 2) return null;
        return el('section', { class: 'tvguide-featuring', 'aria-label': 'Featuring' },
            el('span', { class: 'tvguide-related-label' }, 'Featuring'),
            el('span', { class: 'tvguide-related-items' }, group.programs.map((program) =>
                el('button', { class: 'tvguide-related-chip', type: 'button', 'aria-label': `Pin ${sceneTitle(program.scene)} details`,
                    onclick: () => store?.dispatch({ type: Events.PIN_DETAILS, channelId: store.getState().focus.channelId, timeMs: program.startMs, forcePin: true }) }, sceneTitle(program.scene)))));
    }

    /**
     * Leaving for Stash belongs beside the scene it opens.
     *
     * It used to sit in the player's control bar, where it always meant "the
     * channel that is tuned" -- so pinning another programme's details and
     * pressing it opened a different scene from the one on screen.
     */
    function watchButton(state, channel) {
        if (!store) return null;
        return el(
            'button',
            {
                class: 'tvguide-watch',
                type: 'button',
                onclick: () =>
                    store.dispatch({
                        type: Events.EXPAND,
                        channelId: channel.id,
                        timeMs: state.focus.timeMs
                    })
            },
            'Watch in Stash'
        );
    }

    /**
     * The channel badge, as the way into that channel in Stash.
     *
     * The badge in the guide row tunes now, so the link that used to live there
     * needs somewhere to go -- and beside the scene it belongs to is where you
     * would look for it. A saved filter has no detail page, so it stays a badge.
     */
    function channelLink(channel) {
        const labelledBadge = channel.source === 'performer'
            ? [logoBadge(channel), el('span', { class: 'tvguide-banner-logo-name' }, channel.name)]
            : logoBadge(channel);
        if (!sourceUrl(channel)) return el('div', { class: 'tvguide-banner-logo' }, labelledBadge);
        return el(
            'button',
            {
                class: 'tvguide-banner-logo tvguide-banner-logo-button',
                type: 'button',
                'aria-label': `Open ${channel.name} in Stash`,
                title: `Open ${channel.name} in Stash`,
                onclick: () => openSource(channel)
            },
            labelledBadge
        );
    }

    return {
        element: root,

        render(state) {
            const program = sel.focusedProgram(state);
            const channel = sel.focusedChannel(state);

            if (!program || !channel) {
                renderedScrollKey = null;
                renderedScene = null;
                replaceChildren(
                    root,
                    el('p', { class: 'tvguide-banner-empty' },
                        channel ? `${channel.name} has nothing scheduled.` : 'Select a channel.')
                );
                return;
            }

            const { scene } = program;
            const group = sel.focusedPresentationGroup(state);
            const isLive = program.startMs <= state.nowMs && program.endMs > state.nowMs;
            const scrollKey = `${channel.id}:${scene.id}`;
            if (scrollKey !== renderedScrollKey) expanded = false;
            const meta = `${channel.name} · ${formatClock(program.startMs, state.settings.guide_12_hour_clock)}–${formatClock(program.endMs, state.settings.guide_12_hour_clock)}`
                + ` · ${formatDuration(program.durationMs / 1000)}`
                + (isLive ? ` · ${formatRemaining(program.endMs - state.nowMs)}` : '');
            const signature = [scrollKey, channel.name, JSON.stringify(channel.logo), program.startMs, state.focus?.source, state.layout, isLive,
                state.settings.guide_12_hour_clock, sel.temporaryChannelSaveState(state),
                group?.programs.map((p) => p.scene.id).join(',')].join(':');
            if (renderedScene === scene && renderedSignature === signature) {
                const label = root.querySelector('.tvguide-banner-meta');
                if (label.textContent !== meta) label.textContent = meta;
                return;
            }
            const mobile = state.layout === 'list';
            const extra = el('div', { class: 'tvguide-banner-extra', id: 'tvguide-banner-extra', hidden: mobile && !expanded },
                featuringSection(group),
                scene.details ? el('p', { class: 'tvguide-banner-details' }, scene.details) : null,
                relatedSection('Models', 'performer', scene.performers),
                relatedSection('Tags', 'tag', scene.tags));
            const more = el('button', {
                class: 'tvguide-show-more', type: 'button', hidden: !mobile || !extra.childElementCount,
                'aria-expanded': String(expanded), 'aria-controls': 'tvguide-banner-extra',
                onclick: () => {
                    expanded = !expanded;
                    extra.hidden = !expanded;
                    more.textContent = expanded ? 'Show less' : 'Show more';
                    more.setAttribute('aria-expanded', String(expanded));
                }
            }, expanded ? 'Show less' : 'Show more');
            const previousBody = root.querySelector('.tvguide-banner-body');
            const scrollTop = renderedScrollKey === scrollKey ? previousBody?.scrollTop || 0 : 0;

            replaceChildren(
                root,
                // Left column: what the scene looks like, whose channel it is,
                // and the way out to Stash -- stacked, so the artwork reads as
                // one block rather than the button floating in the prose.
                el(
                    'div',
                    { class: 'tvguide-banner-art' },
                    scene.paths?.screenshot
                        ? el('img', {
                              class: 'tvguide-banner-poster',
                              src: scene.paths.screenshot,
                              alt: '',
                              loading: 'lazy'
                          })
                        : null,
                    channelLink(channel),
                    watchButton(state, channel)
                ),
                el(
                    'div',
                    { class: 'tvguide-banner-body' },
                    el(
                        'div',
                        { class: 'tvguide-banner-heading' },
                        el('h2', { class: 'tvguide-banner-title' }, sceneTitle(scene)),
                        state.focus?.source === 'sticky' ? el('button', { class: 'tvguide-unpin-details', type: 'button', 'aria-label': 'Unpin details', title: 'Return to live details', onclick: () => store?.dispatch({ type: Events.UNPIN_DETAILS }) }, '×') : null,
                        isLive ? el('span', { class: 'tvguide-live-badge' }, 'LIVE') : null
                    ),
                    el(
                        'p',
                        { class: 'tvguide-banner-meta' },
                        meta
                    ),
                    more,
                    extra,
                    sel.temporaryChannelSaveState(state)
                        ? el(
                              'button',
                              {
                                  class: 'tvguide-save-channel',
                                  type: 'button',
                                  disabled: sel.temporaryChannelSaveState(state) === 'saved',
                                  onclick: () => store?.dispatch({ type: Events.SAVE_TEMPORARY_CHANNEL })
                              },
                              sel.temporaryChannelSaveState(state) === 'saved' ? 'Saved' : 'Save channel'
                          )
                        : null
                )
            );
            root.querySelector('.tvguide-banner-body').scrollTop = scrollTop;
            renderedScrollKey = scrollKey;
            renderedScene = scene;
            renderedSignature = signature;
        }
    };
}
