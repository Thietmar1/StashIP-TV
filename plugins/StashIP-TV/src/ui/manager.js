/**
 * The channel manager.
 *
 * Two independent axes, which the UI has to keep visually distinct or it gets
 * confusing fast:
 *
 *   - the LINEUP decides which channels exist (a per-source rule, plus
 *     explicit picks). Stored in `tvguide_lineup`.
 *   - PREFS decide how an existing channel is presented -- pinned, hidden,
 *     renamed, re-badged, its own scene cap. Stored in `tvguide_channel_prefs`,
 *     keyed by channel id so they survive lineup changes.
 *
 * Changing the lineup re-queries the server; changing prefs never does.
 */

import { el, replaceChildren } from './dom.js';
import { Events } from '../state/actions.js';
import { PoolStatus } from '../state/initialState.js';
import { SORT_MODES } from '../domain/channelPrefs.js';
import { KNOWN_SOURCES, SOURCE_LABELS } from '../domain/lineup.js';
import * as sel from '../state/selectors.js';
import { logoBadge } from './logoBadge.js';
import { sourceUrl } from './sourceLink.js';

const SORT_LABELS = {
    name: 'Name',
    sceneCount: 'Scene count'
};

/**
 * Adding hundreds of channels at once is easy to do by accident and tedious to
 * undo -- Tags alone can be well over a thousand.
 */
const BULK_CONFIRM_THRESHOLD = 200;

export function createManager({ store }) {
    const viewSelect = el('select', {
        id: 'tvguide-manager-view', class: 'tvguide-manager-view',
        onchange: (event) => store.dispatch({ type: Events.SET_MANAGER_VIEW, view: event.target.value })
    }, el('option', { value: 'active' }, 'Active channels'),
    el('option', { value: 'selected' }, 'Selected (including hidden)'),
    el('option', { value: 'all' }, 'All available channels'));
    const search = el('input', {
        type: 'search',
        id: 'tvguide-manager-search',
        class: 'tvguide-manager-search',
        placeholder: 'Filter channels…',
        oninput: (e) => scheduleSearch(e.target.value)
    });

    const sortSelect = el(
        'select',
        {
            id: 'tvguide-manager-sort',
            class: 'tvguide-manager-sort',
            onchange: (e) => store.dispatch({ type: Events.SET_MANAGER_SORT, sort: e.target.value })
        },
        SORT_MODES.map((mode) => el('option', { value: mode }, SORT_LABELS[mode]))
    );

    const sourceSelect = el(
        'select',
        {
            id: 'tvguide-manager-source',
            class: 'tvguide-manager-source',
            onchange: (e) => store.dispatch({ type: Events.SET_MANAGER_SOURCE, source: e.target.value })
        },
        KNOWN_SOURCES.map((source) => el('option', { value: source }, SOURCE_LABELS[source]))
    );
    const favorited = el('label', { class: 'tvguide-manager-favorited', hidden: true },
        el('input', { type: 'checkbox', onchange: (e) => store.dispatch({ type: Events.SET_MANAGER_CATALOG_FAVORITED, favorited: e.target.checked }) }),
        ' Favorited'
    );
    const gender = el('select', {
        class: 'tvguide-manager-gender', hidden: true,
        onchange: (e) => store.dispatch({ type: Events.SET_MANAGER_CATALOG_GENDER, gender: e.target.value })
    }, el('option', { value: 'all' }, 'All genders'), el('option', { value: 'female' }, 'Female'), el('option', { value: 'male' }, 'Male'));

    const sections = el('div', { class: 'tvguide-manager-sections' });
    const status = el('p', { class: 'tvguide-manager-status' });

    const root = el(
        'div',
        {
            class: 'tvguide-manager',
            role: 'dialog',
            'aria-label': 'Manage channels',
            hidden: true
        },
        el(
            'div',
            { class: 'tvguide-manager-head' },
            el('h2', { class: 'tvguide-manager-title' }, 'Channels'),
            el(
                'div',
                { class: 'tvguide-manager-tools' },
                el('label', { for: 'tvguide-manager-source', class: 'tvguide-sr-only' }, 'Channel type'),
                sourceSelect,
                el('label', { for: 'tvguide-manager-view', class: 'tvguide-sr-only' }, 'Show channels'),
                viewSelect,
                el('label', { for: 'tvguide-manager-search', class: 'tvguide-sr-only' }, 'Filter channels'),
                search,
                favorited,
                gender,
                el('label', { for: 'tvguide-manager-sort' }, 'Sort'),
                sortSelect
            ),
            el('button', {
                class: 'tvguide-manager-close',
                type: 'button',
                'aria-label': 'Close channel manager',
                text: '×',
                onclick: () => store.dispatch({ type: Events.MANAGER_CLOSE })
            })
        ),
        status,
        sections
    );

    // Editing is local to the panel -- it is not guide state, and putting it in
    // the store would mean a re-render on every keystroke.
    const editing = new Set();
    let renderedSignature = '';
    let searchTimer = null;
    let pendingSearch = null;

    // Searching is remote and paged. A brief pause prevents one request per
    // keypress while keeping the result responsive.
    function scheduleSearch(query) {
        clearTimeout(searchTimer);
        pendingSearch = query;
        searchTimer = setTimeout(() => {
            searchTimer = null;
            store.dispatch({ type: Events.MANAGER_SEARCH, query });
            pendingSearch = null;
        }, 200);
    }

    function render(state) {
        root.hidden = !state.managerOpen;
        if (!state.managerOpen) return;

        if (sortSelect.value !== state.managerSort) sortSelect.value = state.managerSort;
        sourceSelect.value = state.managerSource;
        viewSelect.value = state.managerView;
        // The overlay clock re-renders every second. Until the debounced query
        // reaches state, the input is its own source of truth so a clock tick
        // cannot write the older store value over what the user is typing.
        if (pendingSearch === null && search.value !== state.managerSearch) search.value = state.managerSearch;
        const capabilities = sel.catalogCapabilities(state.managerSource);
        favorited.hidden = state.managerView !== 'all' || !capabilities.favorite;
        favorited.firstChild.checked = state.managerCatalogFavorited;
        gender.hidden = state.managerView !== 'all' || !capabilities.gender;
        if (gender.value !== state.managerCatalogGender) gender.value = state.managerCatalogGender;

        renderStatus(state);

        // Rebuild only when something the list depends on actually moved --
        // otherwise typing in an editor field would destroy the field.
        const signature = [
            state.managerSource,
            state.managerView,
            // Per-source now, so read it through the selector -- the raw value
            // is an object and would stringify identically every time.
            sel.catalogRequestKey(state),
            JSON.stringify(sel.catalogPage(state)),
            state.managerSearch,
            state.managerSort,
            JSON.stringify(state.lineup),
            JSON.stringify(state.prefs),
            // Pins live outside prefs now; without this, pinning changes the
            // store but not the panel.
            JSON.stringify(state.pinOrder),
            JSON.stringify(state.allChannels),
            [...editing].join(',')
        ].join('|');
        if (signature === renderedSignature) return;
        renderedSignature = signature;

        // One type at a time: 119 channels across five types is not a list
        // anyone scrolls through, and the catalogue is fetched per source.
        replaceChildren(sections, renderSection(state, state.managerSource));
    }

    /** Expanding an editor is local state, so it has to force the rebuild. */
    function toggleEditor(channelId) {
        if (editing.has(channelId)) editing.delete(channelId);
        else editing.add(channelId);
        renderedSignature = '';
        render(store.getState());
    }

    return { element: root, render, destroy: () => clearTimeout(searchTimer) };

    function renderStatus(state) {
        if (state.managerView !== 'all') {
            status.textContent = state.channelsStatus === PoolStatus.LOADING ? 'Loading selected channels…'
                : state.channelsError ? `Could not load selected channels: ${state.channelsError}`
                : `${sel.catalogRows(state).length} ${state.managerView === 'active' ? 'active' : 'selected'} channels of this type. Active means selected for TV and not hidden.`;
            return;
        }
        const page = sel.catalogPage(state);
        if ((page.loadingPage && page.channels.length === 0) || (!page.loadedPages.length && sel.catalogStatus(state) === PoolStatus.LOADING)) {
            status.textContent = 'Loading available channels…';
        } else if (page.error || (!page.loadedPages.length && sel.catalogError(state))) {
            status.textContent = `Could not load channels: ${page.error || sel.catalogError(state)}`;
        } else {
            // Counted from the groups, so collapsing one does not read as
            // channels having left the guide.
            const shown = sel.channelCount(state);
            const hidden = Object.values(state.prefs).filter((p) => p.hidden).length;
            status.textContent = hidden > 0
                ? `${shown} channels in the guide, ${hidden} hidden.`
                : `${shown} channels in the guide.`;
        }
    }

    function renderSection(state, source) {
        const rule = sel.lineupRule(state, source);
        const rows = sel.catalogRows(state, source);

        return el(
            'section',
            { class: 'tvguide-manager-section' },
            el(
                'header',
                { class: 'tvguide-manager-section-head' },
                el('h3', {}, SOURCE_LABELS[source]),
                source === 'special' ? null : ruleControl(state, source, rule),
                bulkControls(state, source, rows)
            ),
            rows.length === 0
                ? el('p', { class: 'tvguide-manager-empty' },
                      state.managerView === 'all' ? (sel.catalogPage(state).loadingPage ? '…' : 'Nothing matches.')
                          : 'No matching selected channels of this type. Choose All available channels to add channels.')
                : el('ul', { class: 'tvguide-manager-list' }, rows.map((row) => renderRow(state, source, row))),
            catalogFooter(state)
        );
    }

    function catalogFooter(state) {
        if (state.managerView !== 'all') return null;
        const page = sel.catalogPage(state);
        const nextPage = page.loadedPages.length + 1;
        if (page.error) return el('button', { class: 'tvguide-manager-load-more', type: 'button', text: 'Retry', onclick: () => store.dispatch({ type: Events.LOAD_MANAGER_CATALOG_PAGE, page: nextPage }) });
        if (page.channels.length >= page.total) return null;
        return el('button', { class: 'tvguide-manager-load-more', type: 'button', disabled: Boolean(page.loadingPage), text: page.loadingPage ? 'Loading…' : `Load more (${page.channels.length}/${page.total})`, onclick: () => store.dispatch({ type: Events.LOAD_MANAGER_CATALOG_PAGE, page: nextPage }) });
    }

    /**
     * The per-source rule. While it is on, newly-added studios (or tags, or
     * groups) become channels on their own; turning it off freezes the lineup
     * to whatever has been picked explicitly.
     */
    function ruleControl(state, source, rule) {
        const enabled = Boolean(rule);
        const checkboxId = `tvguide-rule-${source}`;
        const thresholdId = `tvguide-rule-threshold-${source}`;

        return el(
            'div',
            { class: 'tvguide-manager-rule' },
            el('input', {
                type: 'checkbox',
                id: checkboxId,
                checked: enabled,
                // Same default as the threshold input below, or enabling a rule
                // would silently apply 0 while the field showed something else.
                onchange: (e) =>
                    setRule(state, source, e.target.checked, rule?.minScenes ?? state.settings.guide_min_scenes)
            }),
            el('label', { for: checkboxId }, 'Include all with at least'),
            el('input', {
                type: 'number',
                id: thresholdId,
                class: 'tvguide-manager-threshold',
                min: '0',
                value: String(rule?.minScenes ?? state.settings.guide_min_scenes),
                disabled: !enabled,
                'aria-label': `Minimum scenes for ${SOURCE_LABELS[source]}`,
                onchange: (e) => setRule(state, source, true, Number(e.target.value))
            }),
            el('span', {}, 'scenes')
        );
    }

    /**
     * Add all / remove all, scoped to what is currently listed.
     *
     * Deliberately not "every channel of this type": the dropdown and the search
     * box are how you narrow the target, and an unscoped add on Tags would be
     * over a thousand channels.
     */
    function bulkControls(state, source, rows) {
        const missing = rows.filter((row) => !row.included);
        const present = rows.filter((row) => row.included);

        return el(
            'div',
            { class: 'tvguide-manager-bulk' },
            el(
                'button',
                {
                    class: 'tvguide-manager-bulkbutton',
                    type: 'button',
                    disabled: missing.length === 0,
                    onclick: () => bulkSet(state, source, rows, true)
                },
                `Add all (${missing.length})`
            ),
            el(
                'button',
                {
                    class: 'tvguide-manager-bulkbutton',
                    type: 'button',
                    disabled: present.length === 0,
                    onclick: () => bulkSet(state, source, rows, false)
                },
                `Remove all (${present.length})`
            )
        );
    }

    function bulkSet(state, source, rows, include) {
        const affected = rows.filter((row) => row.included !== include);
        if (affected.length === 0) return;

        if (affected.length > BULK_CONFIRM_THRESHOLD && typeof confirm === 'function') {
            const verb = include ? 'Add' : 'Remove';
            if (!confirm(`${verb} ${affected.length} channels?`)) return;
        }

        const localId = (channelId) => channelId.slice(source.length + 1);
        const picks = new Set(sel.explicitIds(state, source));
        const listed = new Set(rows.map((row) => row.channel.id));

        if (include) {
            // Anything already in the guide via the rule has to become an
            // explicit pick too, or turning the rule off later would drop it.
            for (const row of rows) picks.add(localId(row.channel.id));
        } else {
            for (const row of rows) picks.delete(localId(row.channel.id));
        }

        let lineup = state.lineup.filter(
            (entry) => !(entry.source === source && Array.isArray(entry.ids))
        );

        // A rule would immediately undo a removal, and makes an add redundant.
        lineup = lineup.filter((entry) => !(entry.source === source && !entry.ids && !entry.names));

        if (!include) {
            // Keep rule-swept channels that were not in the filtered view.
            for (const channel of state.allChannels) {
                if (channel.source !== source || listed.has(channel.id)) continue;
                picks.add(localId(channel.id));
            }
        }

        if (picks.size > 0) lineup = [...lineup, { source, ids: [...picks] }];
        store.dispatch({ type: Events.SET_LINEUP, lineup });
    }

    function setRule(state, source, enabled, minScenes) {
        const others = state.lineup.filter(
            (entry) => !(entry.source === source && !entry.ids && !entry.names)
        );
        const lineup = enabled
            ? [...others, { source, minScenes: Number(minScenes) || 0 }]
            : others;
        store.dispatch({ type: Events.SET_LINEUP, lineup });
    }

    function renderRow(state, source, row) {
        const { channel, included, pinned, hidden, pref } = row;
        const isEditing = editing.has(channel.id);
        const displayName = pref?.name || channel.name;
        const detailUrl = sourceUrl(channel);

        return el(
            'li',
            {
                class: [
                    'tvguide-manager-row',
                    included && 'is-included',
                    hidden && 'is-hidden',
                    pinned && 'is-pinned'
                ].filter(Boolean).join(' '),
                'data-channel-id': channel.id
            },
            el(
                'div',
                { class: 'tvguide-manager-row-main' },
                logoBadge(pref?.name || pref?.logoUrl
                    ? { ...channel, name: pref.name || channel.name,
                        logo: pref.logoUrl ? { type: 'image', url: pref.logoUrl } : channel.logo }
                    : channel),
                el(
                    'div',
                    { class: 'tvguide-manager-row-text' },
                    detailUrl
                        ? el('a', {
                            class: 'tvguide-manager-row-name', href: detailUrl,
                            target: '_blank', rel: 'noopener',
                            title: `Open ${channel.name} in Stash`
                        }, displayName)
                        : el('span', { class: 'tvguide-manager-row-name' }, displayName),
                    el('span', { class: 'tvguide-manager-row-meta' },
                        pref?.name ? `${channel.name} · ` : '',
                        channel.sceneCount == null
                            ? (source === 'special' ? 'special channel' : 'saved filter')
                            : `${channel.sceneCount} scenes`)
                ),
                el(
                    'div',
                    { class: 'tvguide-manager-row-actions' },
                    toggleButton({
                        label: included ? 'Remove from guide' : 'Add to guide',
                        text: included ? 'Remove' : 'Add',
                        pressed: included,
                        onclick: () => toggleIncluded(state, source, channel, included)
                    }),
                    included ? [
                        el('button', {
                            class: 'tvguide-manager-rename', type: 'button',
                            'aria-label': 'Rename channel', text: 'Rename',
                            onclick: () => {
                                editing.add(channel.id);
                                renderedSignature = '';
                                render(store.getState());
                                root.querySelectorAll('[data-channel-id]').forEach((item) => {
                                    if (item.dataset.channelId === channel.id) item.querySelector('input[type="text"]')?.focus();
                                });
                            }
                        }),
                        toggleButton({
                            label: pinned ? `Unpin ${channel.name}` : `Pin ${channel.name} to the top`,
                            text: pinned ? '★' : '☆',
                            pressed: pinned,
                            onclick: () => store.dispatch({ type: Events.TOGGLE_PIN, channelId: channel.id })
                        }),
                        toggleButton({
                            label: hidden ? `Show ${channel.name}` : `Hide ${channel.name}`,
                            text: hidden ? 'Show' : 'Hide',
                            pressed: hidden,
                            onclick: () => store.dispatch({ type: Events.TOGGLE_HIDDEN, channelId: channel.id })
                        }),
                        el('button', {
                            class: 'tvguide-manager-edit',
                            type: 'button',
                            'aria-expanded': isEditing ? 'true' : 'false',
                            'aria-label': `Customise ${channel.name}`,
                            text: 'Edit',
                            onclick: () => toggleEditor(channel.id)
                        })
                    ] : null
                )
            ),
            isEditing ? renderEditor(channel, pref) : null
        );
    }

    function toggleButton({ label, text, pressed, disabled, onclick }) {
        return el('button', {
            class: 'tvguide-manager-toggle',
            type: 'button',
            'aria-label': label,
            'aria-pressed': pressed ? 'true' : 'false',
            disabled: disabled || false,
            onclick
        }, text);
    }

    /**
     * Explicit picks live in a single ids entry per source. Removing a channel
     * the rule swept in also turns the rule off -- otherwise the next resolve
     * would simply bring it straight back, which reads as the button not
     * working.
     */
    function toggleIncluded(state, source, channel, included) {
        const localId = channel.id.slice(source.length + 1);
        const rule = sel.lineupRule(state, source);
        const picks = new Set(sel.explicitIds(state, source));

        if (included) picks.delete(localId);
        else picks.add(localId);

        const others = state.lineup.filter(
            (entry) => !(entry.source === source && Array.isArray(entry.ids))
        );

        let lineup = others;
        if (included && rule) {
            // Freeze the current membership, minus the one being removed.
            const swept = state.allChannels
                .filter((c) => c.source === source)
                .filter((c) => c.id !== channel.id)
                .map((c) => c.id.slice(source.length + 1));
            swept.forEach((id) => picks.add(id));
            lineup = others.filter((entry) => !(entry.source === source && !entry.ids && !entry.names));
        }

        if (picks.size > 0) lineup = [...lineup, { source, ids: [...picks] }];

        store.dispatch({
            type: included ? Events.MANAGER_CHANNEL_REMOVED : Events.MANAGER_CHANNEL_INCLUDED,
            lineup,
            channel
        });
    }

    function renderEditor(channel, pref) {
        const nameId = `tvguide-edit-name-${channel.id}`;
        const logoId = `tvguide-edit-logo-${channel.id}`;
        const capId = `tvguide-edit-cap-${channel.id}`;

        const commit = (patch) =>
            store.dispatch({ type: Events.SET_CHANNEL_PREF, channelId: channel.id, patch });

        return el(
            'div',
            { class: 'tvguide-manager-editor' },
            el('form', { class: 'tvguide-manager-name-form', onsubmit: (event) => {
                event.preventDefault();
                commit({ name: event.currentTarget.querySelector('input').value });
            } },
                field(nameId, 'Channel name', el('input', {
                    type: 'text', id: nameId, value: pref?.name || '', placeholder: channel.name
                })),
                el('button', { type: 'submit', text: 'Save name' }),
                el('button', { type: 'button', text: 'Reset name', onclick: () => commit({ name: null }) }),
                el('p', { class: 'tvguide-manager-name-help' },
                    'Used by Jellyfin, Stashy, Plex and Emby. Leave blank to use the original name.')
            ),
            field(logoId, 'Logo URL', el('input', {
                type: 'url',
                id: logoId,
                value: pref?.logoUrl || '',
                placeholder: 'Leave blank for the default',
                onchange: (e) => commit({ logoUrl: e.target.value })
            })),
            field(capId, 'Scenes in rotation', el('input', {
                type: 'number',
                id: capId,
                min: '1',
                value: pref?.poolCap ? String(pref.poolCap) : '',
                placeholder: 'Default',
                onchange: (e) => commit({ poolCap: e.target.value })
            }))
        );
    }

    function field(id, label, input) {
        return el('div', { class: 'tvguide-manager-field' }, el('label', { for: id }, label), input);
    }
}
