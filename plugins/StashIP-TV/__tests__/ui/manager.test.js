/**
 * Integration: the real manager panel over the real store and reducer.
 */

import { createStore } from '../../src/state/store.js';
import { createManager } from '../../src/ui/manager.js';
import { createInitialState, PoolStatus } from '../../src/state/initialState.js';
import { Events } from '../../src/state/actions.js';

const NOON = new Date(2026, 7, 22, 12, 0, 0).getTime();

const chan = (id, name, sceneCount = 10, source = 'studio') => ({
    id,
    source,
    name,
    logo: { type: 'monogram', initials: 'XX', hue: 1 },
    sceneCount,
    sceneFilter: {}
});

const CATALOG = {
    studio: [chan('studio:1', 'Alpha', 50), chan('studio:2', 'Bravo', 20), chan('studio:3', 'Tiny', 2)],
    tag: [chan('tag:9', 'Beach', 30, 'tag')],
    group: [],
    savedFilter: [{ ...chan('savedFilter:1', 'Favourites', null, 'savedFilter') }]
};

function mount(overrides = {}) {
    const initialState = {
        ...createInitialState(),
        open: true,
        nowMs: NOON,
        managerOpen: true,
        managerSource: 'studio',
        catalog: CATALOG,
        catalogStatus: { studio: PoolStatus.READY, tag: PoolStatus.READY, group: PoolStatus.READY, savedFilter: PoolStatus.READY, performer: PoolStatus.READY },
        lineup: [{ source: 'studio', minScenes: 5 }],
        allChannels: [chan('studio:1', 'Alpha', 50), chan('studio:2', 'Bravo', 20)],
        channels: [chan('studio:1', 'Alpha', 50), chan('studio:2', 'Bravo', 20)],
        channelGroups: [
            {
                key: 'studio',
                source: 'studio',
                channels: [chan('studio:1', 'Alpha', 50), chan('studio:2', 'Bravo', 20)],
                collapsed: false,
                count: 2
            }
        ],
        ...overrides
    };
    const store = createStore({ initialState });
    const manager = createManager({ store });
    document.body.appendChild(manager.element);
    store.subscribe((s) => manager.render(s));
    manager.render(store.getState());
    return { store, manager };
}

const rowFor = (manager, channelId) =>
    manager.element.querySelector(`[data-channel-id="${channelId}"]`);

const buttonLabelled = (root, pattern) =>
    Array.from(root.querySelectorAll('button')).find((b) =>
        pattern.test(b.getAttribute('aria-label') || '')
    );

describe('active channel view', () => {
    it('shows only selected non-hidden channels and allows hidden channels to be recovered', () => {
        const { store, manager } = mount({ managerView: 'active', prefs: { 'studio:2': { hidden: true } } });
        expect(rowFor(manager, 'studio:1')).not.toBeNull();
        expect(rowFor(manager, 'studio:2')).toBeNull();
        expect(rowFor(manager, 'studio:3')).toBeNull();
        expect(manager.element.querySelector('.tvguide-manager-load-more')).toBeNull();
        const view = manager.element.querySelector('.tvguide-manager-view');
        view.value = 'selected';
        view.dispatchEvent(new Event('change'));
        expect(store.getState().managerView).toBe('selected');
        expect(rowFor(manager, 'studio:2')).not.toBeNull();
        buttonLabelled(rowFor(manager, 'studio:2'), /^Show /).click();
        view.value = 'active'; view.dispatchEvent(new Event('change'));
        expect(rowFor(manager, 'studio:2')).not.toBeNull();
    });

    it('removing one rule-selected channel retains selected channels outside a catalogue page', () => {
        const { store, manager } = mount({ managerView: 'active', allChannels: [chan('studio:1', 'Alpha'), chan('studio:999', 'Last page')] });
        buttonLabelled(rowFor(manager, 'studio:1'), /^Remove from guide$/).click();
        expect(store.getState().lineup).toEqual([{ source: 'studio', ids: ['999'] }]);
        expect(store.getState().allChannels.map((c) => c.id)).toEqual(['studio:999']);
    });
});

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('presentation', () => {
    it('is a labelled dialog, hidden until opened', () => {
        const { manager } = mount({ managerOpen: false });
        expect(manager.element.getAttribute('role')).toBe('dialog');
        expect(manager.element.getAttribute('aria-label')).toBe('Manage channels');
        expect(manager.element.hidden).toBe(true);
    });

    it('shows one source at a time, chosen from a dropdown', () => {
        // 119 channels across five types is not a list anyone scrolls through.
        const { manager } = mount();
        const headings = Array.from(manager.element.querySelectorAll('h3')).map((h) => h.textContent);
        expect(headings).toEqual(['Studios']);
    });

    it('offers every source type in the dropdown, including Models', () => {
        const { manager } = mount();
        const options = Array.from(
            manager.element.querySelectorAll('.tvguide-manager-source option')
        ).map((o) => o.textContent);
        expect(options).toEqual(['Special', 'Studios', 'Models', 'Tags', 'Groups', 'Filters']);
    });

    it('switches source from the dropdown', () => {
        const { store, manager } = mount();
        const select = manager.element.querySelector('.tvguide-manager-source');
        select.value = 'tag';
        select.dispatchEvent(new Event('change'));
        expect(store.getState().managerSource).toBe('tag');
    });

    it('lists the catalogue, not just channels already in the guide', () => {
        const { manager } = mount();
        // studio:3 is below the threshold and absent from the guide.
        expect(rowFor(manager, 'studio:3')).not.toBeNull();
        expect(rowFor(manager, 'studio:3').classList.contains('is-included')).toBe(false);
        expect(rowFor(manager, 'studio:1').classList.contains('is-included')).toBe(true);
    });

    it('shows scene counts', () => {
        const { manager } = mount();
        expect(rowFor(manager, 'studio:1').textContent).toContain('50 scenes');
    });

    it('marks saved filters as countless', () => {
        const { manager } = mount({ managerSource: 'savedFilter' });
        expect(rowFor(manager, 'savedFilter:1').textContent).toContain('saved filter');
    });

    it('links a channel name to its Stash detail page in a new tab', () => {
        const { manager } = mount();
        const link = rowFor(manager, 'studio:1').querySelector('.tvguide-manager-row-name');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('/studios/1');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener');
    });

    it('keeps saved-filter names as text because Stash has no detail page for them', () => {
        const { manager } = mount({ managerSource: 'savedFilter' });
        expect(rowFor(manager, 'savedFilter:1').querySelector('.tvguide-manager-row-name').tagName).toBe('SPAN');
    });

    it('reports how many channels are in the guide', () => {
        const { manager } = mount();
        expect(manager.element.querySelector('.tvguide-manager-status').textContent)
            .toContain('2 channels in the guide');
    });

    it('reports catalogue loading and failure for the source being browsed', () => {
        const loading = mount({ catalogStatus: { studio: PoolStatus.LOADING }, catalog: {} });
        expect(loading.manager.element.querySelector('.tvguide-manager-status').textContent)
            .toContain('Loading');

        const failed = mount({
            catalogStatus: { studio: PoolStatus.ERROR },
            catalogError: { studio: 'offline' },
            catalog: {}
        });
        expect(failed.manager.element.querySelector('.tvguide-manager-status').textContent)
            .toContain('offline');
    });
});

describe('search', () => {
    it('filters the catalogue as you type', () => {
        const { store, manager } = mount();
        store.dispatch({ type: Events.MANAGER_SEARCH, query: 'brav' });

        expect(rowFor(manager, 'studio:2')).not.toBeNull();
        expect(rowFor(manager, 'studio:1')).toBeNull();
    });

    it('does not discard typed text when the guide clock re-renders before debounce', () => {
        const { store, manager } = mount();
        const input = manager.element.querySelector('.tvguide-manager-search');
        input.value = 'br';
        input.dispatchEvent(new Event('input'));

        store.dispatch({ type: Events.TICK, nowMs: NOON + 1000 });

        expect(input.value).toBe('br');
    });

    it('is case-insensitive', () => {
        const { store, manager } = mount();
        store.dispatch({ type: Events.MANAGER_SEARCH, query: 'ALPHA' });
        expect(rowFor(manager, 'studio:1')).not.toBeNull();
    });

    it('says so when nothing matches', () => {
        const { store, manager } = mount();
        store.dispatch({ type: Events.MANAGER_SEARCH, query: 'zzzz' });
        const requestKey = 'studio|zzzz|0|all|name';
        store.dispatch({
            type: Events.CATALOG_PAGE_LOADED,
            requestKey,
            page: 1,
            channels: [],
            total: 0
        });
        expect(manager.element.textContent).toContain('Nothing matches');
    });
});

describe('catalogue filters', () => {
    it('shows Favorites for sources that support it', () => {
        const { manager } = mount();
        expect(manager.element.querySelector('.tvguide-manager-favorited').hidden).toBe(false);
        expect(manager.element.querySelector('.tvguide-manager-gender').hidden).toBe(true);
    });

    it('shows gender only for Models', () => {
        const { store, manager } = mount();
        store.dispatch({ type: Events.SET_MANAGER_SOURCE, source: 'performer' });
        expect(manager.element.querySelector('.tvguide-manager-favorited').hidden).toBe(false);
        expect(manager.element.querySelector('.tvguide-manager-gender').hidden).toBe(false);
    });
});

describe('sorting', () => {
    it('offers the sort modes and reflects the current one', () => {
        const { manager } = mount({ managerSort: 'sceneCount' });
        const select = manager.element.querySelector('.tvguide-manager-sort');
        expect(select.value).toBe('sceneCount');
        // "Source" is gone: the guide groups by source, so sorting by it did nothing.
        expect(Array.from(select.options).map((o) => o.value)).toEqual(['name', 'sceneCount']);
    });

    it('reorders this dialog and leaves the guide alone', () => {
        // The control belongs to the panel you are looking at. Reaching out and
        // reordering the guide behind it is not what "Sort" offered to do.
        const { store, manager } = mount();
        const before = store.getState().channels;
        const select = manager.element.querySelector('.tvguide-manager-sort');
        select.value = 'sceneCount';
        select.dispatchEvent(new Event('change'));

        expect(store.getState().managerSort).toBe('sceneCount');
        expect(store.getState().channels).toBe(before);
    });

    it('actually orders its own rows by the chosen mode', () => {
        // It never did before: the select wrote to the guide's ordering and this
        // panel kept showing whatever order the server returned.
        const names = (m) =>
            [...m.element.querySelectorAll('.tvguide-manager-row-name')].map((n) => n.textContent);

        // Deliberately a catalogue where the two orders disagree.
        const catalog = {
            ...CATALOG,
            studio: [chan('studio:1', 'Zed', 90), chan('studio:2', 'Alpha', 5)]
        };

        expect(names(mount({ catalog }).manager)).toEqual(['Alpha', 'Zed']);
        expect(names(mount({ catalog, managerSort: 'sceneCount' }).manager)).toEqual(['Zed', 'Alpha']);
    });
});

describe('lineup rules', () => {
    it('shows the rule as enabled with its threshold', () => {
        const { manager } = mount();
        const section = manager.element.querySelector('.tvguide-manager-section');
        expect(section.querySelector('input[type="checkbox"]').checked).toBe(true);
        expect(section.querySelector('.tvguide-manager-threshold').value).toBe('5');
    });

    it('disables the threshold when the rule is off', () => {
        const { manager } = mount({ lineup: [] });
        const section = manager.element.querySelector('.tvguide-manager-section');
        expect(section.querySelector('input[type="checkbox"]').checked).toBe(false);
        expect(section.querySelector('.tvguide-manager-threshold').disabled).toBe(true);
    });

    it('turning a rule off removes it from the lineup', () => {
        const { store, manager } = mount();
        const checkbox = manager.element.querySelector('.tvguide-manager-section input[type="checkbox"]');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));

        expect(store.getState().lineup).toEqual([]);
    });

    it('turning a rule on adds it for the source being browsed', () => {
        const { store, manager } = mount({ lineup: [], managerSource: 'tag' });
        const checkbox = manager.element.querySelector('.tvguide-manager-section input[type="checkbox"]');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(store.getState().lineup).toEqual([{ source: 'tag', minScenes: 5 }]);
    });

    it('changing the threshold updates the rule', () => {
        const { store, manager } = mount();
        const threshold = manager.element.querySelector('.tvguide-manager-threshold');
        threshold.value = '20';
        threshold.dispatchEvent(new Event('change'));

        expect(store.getState().lineup).toEqual([{ source: 'studio', minScenes: 20 }]);
    });

    it('re-resolves channels from the server after a lineup change', () => {
        const runEffect = jest.fn();
        const store = createStore({
            runEffect,
            initialState: { ...createInitialState(), managerOpen: true, catalog: CATALOG, lineup: [] }
        });
        const manager = createManager({ store });
        manager.render(store.getState());

        const checkbox = manager.element.querySelector('.tvguide-manager-section input[type="checkbox"]');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(runEffect.mock.calls.map((c) => c[0].type)).toContain('loadChannels');
    });
});

describe('adding and removing channels', () => {
    it('adds and pins a special channel through the normal channel controls', () => {
        const movie = chan('special:movies', 'Movies', null, 'special');
        const { store, manager } = mount({
            managerSource: 'special',
            lineup: [],
            allChannels: [],
            channels: [],
            channelGroups: [],
            catalog: { ...CATALOG, special: [movie] }
        });

        expect(manager.element.querySelector('.tvguide-manager-rule')).toBeNull();
        expect(rowFor(manager, 'special:movies').textContent).toContain('special channel');
        buttonLabelled(rowFor(manager, 'special:movies'), /Add to guide/).click();
        buttonLabelled(rowFor(manager, 'special:movies'), /Pin Movies/).click();

        expect(store.getState().lineup).toEqual([{ source: 'special', ids: ['movies'] }]);
        expect(store.getState().pinOrder).toEqual(['special:movies']);
    });

    it('adds a channel the rule left out', () => {
        const { store, manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:3'), /Add to guide/).click();

        const entry = store.getState().lineup.find((e) => Array.isArray(e.ids));
        expect(entry.ids).toContain('3');
    });

    it('marks an added channel active without waiting for a lineup reload', () => {
        const { manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:3'), /Add to guide/).click();

        expect(rowFor(manager, 'studio:3').classList.contains('is-included')).toBe(true);
        expect(buttonLabelled(rowFor(manager, 'studio:3'), /Remove from guide/)).not.toBeUndefined();
    });

    it('shows only Add for a channel that is not in the guide', () => {
        const { manager } = mount();
        const row = rowFor(manager, 'studio:3');

        expect(buttonLabelled(row, /Add to guide/)).not.toBeUndefined();
        expect(buttonLabelled(row, /Pin Tiny|Hide Tiny/)).toBeUndefined();
        expect(row.querySelector('.tvguide-manager-edit')).toBeNull();
    });

    it('adds a channel from another source entirely', () => {
        const { store, manager } = mount({ managerSource: 'tag' });
        buttonLabelled(rowFor(manager, 'tag:9'), /Add to guide/).click();

        expect(store.getState().lineup).toContainEqual({ source: 'tag', ids: ['9'] });
    });

    it('removing a rule-swept channel freezes the rest as explicit picks', () => {
        // Otherwise the next resolve sweeps it straight back in, and the
        // button looks broken.
        const { store, manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:1'), /Remove from guide/).click();

        const lineup = store.getState().lineup;
        expect(lineup.some((e) => e.source === 'studio' && !e.ids)).toBe(false);

        const picks = lineup.find((e) => e.source === 'studio' && e.ids);
        expect(picks.ids).toContain('2');
        expect(picks.ids).not.toContain('1');
    });
});

describe('pinning and hiding', () => {
    it('pins a channel to the top of the guide', () => {
        const { store, manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:2'), /Pin Bravo/).click();

        expect(store.getState().pinOrder).toEqual(['studio:2']);
        expect(store.getState().channelGroups[0].key).toBe('pinned');
        expect(rowFor(manager, 'studio:2').classList.contains('is-pinned')).toBe(true);
    });

    it('unpins again', () => {
        const { store, manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:2'), /Pin Bravo/).click();
        buttonLabelled(rowFor(manager, 'studio:2'), /Unpin Bravo/).click();

        expect(store.getState().pinOrder).toEqual([]);
    });

    it('hides a channel from the guide but keeps it listed here', () => {
        const { store, manager } = mount();
        buttonLabelled(rowFor(manager, 'studio:2'), /Hide Bravo/).click();

        expect(store.getState().channels.map((c) => c.id)).toEqual(['studio:1']);
        expect(rowFor(manager, 'studio:2')).not.toBeNull();
        expect(rowFor(manager, 'studio:2').classList.contains('is-hidden')).toBe(true);
    });

    it('does not show pin or hide controls until a channel is in the guide', () => {
        const { manager } = mount();
        const row = rowFor(manager, 'studio:3');
        expect(buttonLabelled(row, /Pin Tiny/)).toBeUndefined();
        expect(buttonLabelled(row, /Hide Tiny/)).toBeUndefined();
    });

    it('marks toggle state for assistive tech', () => {
        const { manager } = mount();
        const pin = buttonLabelled(rowFor(manager, 'studio:2'), /Pin Bravo/);
        expect(pin.getAttribute('aria-pressed')).toBe('false');
        pin.click();
        expect(buttonLabelled(rowFor(manager, 'studio:2'), /Unpin Bravo/).getAttribute('aria-pressed'))
            .toBe('true');
    });
});

describe('per-channel customisation', () => {
    const openEditor = (manager, channelId) => {
        buttonLabelled(rowFor(manager, channelId), /Customise/).click();
        return rowFor(manager, channelId).querySelector('.tvguide-manager-editor');
    };

    it('opens and closes an editor', () => {
        const { manager } = mount();
        expect(openEditor(manager, 'studio:1')).not.toBeNull();
        expect(buttonLabelled(rowFor(manager, 'studio:1'), /Customise/).getAttribute('aria-expanded'))
            .toBe('true');

        buttonLabelled(rowFor(manager, 'studio:1'), /Customise/).click();
        expect(rowFor(manager, 'studio:1').querySelector('.tvguide-manager-editor')).toBeNull();
    });

    it('renames a channel', () => {
        const { store, manager } = mount();
        const editor = openEditor(manager, 'studio:1');
        const input = editor.querySelector('input[type="text"]');
        input.value = 'Short Name';
        editor.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));

        expect(store.getState().channels.find((c) => c.id === 'studio:1').name).toBe('Short Name');
        expect(store.getState().allChannels.find((c) => c.id === 'studio:1').name).toBe('Alpha');
    });

    it('shows the original name alongside a rename', () => {
        const { manager } = mount({ prefs: { 'studio:1': { name: 'Short' } } });
        const row = rowFor(manager, 'studio:1');
        expect(row.querySelector('.tvguide-manager-row-name').textContent).toBe('Short');
        expect(row.querySelector('.tvguide-manager-row-meta').textContent).toContain('Alpha');
    });

    it('clearing a rename restores the original', () => {
        const { store, manager } = mount({ prefs: { 'studio:1': { name: 'Short' } } });
        const editor = openEditor(manager, 'studio:1');
        const input = editor.querySelector('input[type="text"]');
        input.value = '';
        editor.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));

        expect(store.getState().channels.find((c) => c.id === 'studio:1').name).toBe('Alpha');
    });

    it('sets a custom logo', () => {
        const { store, manager } = mount();
        const editor = openEditor(manager, 'studio:1');
        const input = editor.querySelector('input[type="url"]');
        input.value = '/my-logo.png';
        input.dispatchEvent(new Event('change'));

        expect(store.getState().channels.find((c) => c.id === 'studio:1').logo)
            .toEqual({ type: 'image', url: '/my-logo.png' });
    });

    it('sets a per-channel scene cap', () => {
        const { store, manager } = mount();
        const editor = openEditor(manager, 'studio:1');
        const input = editor.querySelector('input[type="number"]');
        input.value = '400';
        input.dispatchEvent(new Event('change'));

        expect(store.getState().prefs['studio:1'].poolCap).toBe(400);
    });

    it('shows existing overrides in the editor', () => {
        const { manager } = mount({
            prefs: { 'studio:1': { name: 'Short', logoUrl: '/x.png', poolCap: 250 } }
        });
        const editor = openEditor(manager, 'studio:1');
        expect(editor.querySelector('input[type="text"]').value).toBe('Short');
        expect(editor.querySelector('input[type="url"]').value).toBe('/x.png');
        expect(editor.querySelector('input[type="number"]').value).toBe('250');
    });
});

describe('closing', () => {
    it('closes from the close button', () => {
        const { store, manager } = mount();
        manager.element.querySelector('.tvguide-manager-close').click();
        expect(store.getState().managerOpen).toBe(false);
        expect(manager.element.hidden).toBe(true);
    });
});

describe('bulk add and remove', () => {
    const bulkButton = (manager, re) =>
        Array.from(manager.element.querySelectorAll('.tvguide-manager-bulkbutton'))
            .find((b) => re.test(b.textContent));

    it('counts what each button would affect', () => {
        // studio:1 and studio:2 are in the guide; studio:3 is below the rule.
        const { manager } = mount();
        expect(bulkButton(manager, /^Add all/).textContent).toBe('Add all (1)');
        expect(bulkButton(manager, /^Remove all/).textContent).toBe('Remove all (2)');
    });

    it('adds everything currently listed', () => {
        const { store, manager } = mount();
        bulkButton(manager, /^Add all/).click();

        const entry = store.getState().lineup.find((e) => Array.isArray(e.ids));
        expect(entry.ids.sort()).toEqual(['1', '2', '3']);
    });

    it('drops the rule when adding, so nothing is swept back in', () => {
        const { store, manager } = mount();
        bulkButton(manager, /^Add all/).click();
        expect(store.getState().lineup.some((e) => e.source === 'studio' && !e.ids)).toBe(false);
    });

    it('removes everything currently listed', () => {
        const { store, manager } = mount();
        bulkButton(manager, /^Remove all/).click();

        const entry = store.getState().lineup.find((e) => e.source === 'studio' && e.ids);
        expect(entry).toBeUndefined();
    });

    it('acts only on the filtered list, not the whole type', () => {
        // The dropdown and the search box are how you scope a bulk action.
        const { store, manager } = mount();
        store.dispatch({ type: Events.MANAGER_SEARCH, query: 'alpha' });

        bulkButton(manager, /^Remove all/).click();

        const entry = store.getState().lineup.find((e) => e.source === 'studio' && e.ids);
        // Bravo was not listed, so it survives as an explicit pick.
        expect(entry.ids).toContain('2');
        expect(entry.ids).not.toContain('1');
    });

    it('disables a button with nothing to do', () => {
        // Everything listed is already in the guide, so there is nothing to add.
        const { manager } = mount({
            allChannels: CATALOG.studio,
            channels: CATALOG.studio
        });
        expect(bulkButton(manager, /^Add all/).disabled).toBe(true);
        expect(bulkButton(manager, /^Remove all/).disabled).toBe(false);
    });

    it('disables removing when nothing listed is in the guide', () => {
        const { manager } = mount({ allChannels: [], channels: [] });
        expect(bulkButton(manager, /^Remove all/).disabled).toBe(true);
    });

    it('confirms before adding a very large number of channels', () => {
        const many = Array.from({ length: 250 }, (_, i) => ({
            id: `tag:${i}`, source: 'tag', name: `Tag ${i}`, logo: {}, sceneCount: 3, sceneFilter: {}
        }));
        const { store, manager } = mount({
            managerSource: 'tag',
            lineup: [],
            allChannels: [],
            catalog: { ...CATALOG, tag: many }
        });

        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
        bulkButton(manager, /^Add all/).click();

        expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('250'));
        expect(store.getState().lineup).toEqual([]);
        confirmSpy.mockRestore();
    });

    it('proceeds when the confirmation is accepted', () => {
        const many = Array.from({ length: 250 }, (_, i) => ({
            id: `tag:${i}`, source: 'tag', name: `Tag ${i}`, logo: {}, sceneCount: 3, sceneFilter: {}
        }));
        const { store, manager } = mount({
            managerSource: 'tag',
            lineup: [],
            allChannels: [],
            catalog: { ...CATALOG, tag: many }
        });

        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
        bulkButton(manager, /^Add all/).click();

        expect(store.getState().lineup[0].ids).toHaveLength(250);
        confirmSpy.mockRestore();
    });

    it('does not confirm for a small change', () => {
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
        const { manager } = mount();
        bulkButton(manager, /^Add all/).click();
        expect(confirmSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });
});
