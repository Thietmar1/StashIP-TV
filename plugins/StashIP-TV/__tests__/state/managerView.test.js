import { createInitialState } from '../../src/state/initialState.js';
import { reduce } from '../../src/state/reducer.js';
import { catalogRows, catalogRequestKey } from '../../src/state/selectors.js';
import { Events, STORAGE_KEYS } from '../../src/state/actions.js';

const channel = (id, name = id) => ({ id, name, source: id.split(':')[0], sceneCount: 10 });
const state = () => ({ ...createInitialState(), managerOpen: true,
    allChannels: [channel('studio:1', 'Original'), channel('studio:99', 'Later page'), channel('studio:2', 'Hidden'), channel('tag:1')],
    prefs: { 'studio:1': { name: 'My channel' }, 'studio:2': { hidden: true } } });

test('active view uses the complete selected lineup, not the first available catalogue page', () => {
    const s = { ...state(), managerView: 'active' };
    s.catalogRequests[catalogRequestKey(s)] = { channels: [channel('studio:1')], loadedPages: [1] };
    expect(catalogRows(s).map((row) => row.channel.id)).toEqual(['studio:99', 'studio:1']);
    expect(catalogRows({ ...s, managerSearch: ' my CHANNEL ' }).map((row) => row.channel.id)).toEqual(['studio:1']);
    expect(catalogRows({ ...s, managerSearch: 'original' }).map((row) => row.channel.id)).toEqual(['studio:1']);
    expect(catalogRows({ ...s, managerView: 'selected' })).toHaveLength(3);
});

test('changing local view persists the choice without querying a large remote catalogue', () => {
    const active = reduce(state(), { type: Events.SET_MANAGER_VIEW, view: 'active' });
    expect(active.effects).toEqual([{ type: 'persist', key: STORAGE_KEYS.managerView, value: 'active' }]);
    expect(reduce(active.state, { type: Events.SET_MANAGER_VIEW, view: 'active' }).effects).toEqual([]);
    const searched = reduce(active.state, { type: Events.MANAGER_SEARCH, query: 'mine' });
    expect(searched.effects).toEqual([]);
    expect(reduce(active.state, { type: Events.SET_MANAGER_SOURCE, source: 'tag' }).effects).toEqual([]);
    const all = reduce(active.state, { type: Events.SET_MANAGER_VIEW, view: 'invalid' });
    expect(all.state.managerView).toBe('all');
    expect(all.effects.some((effect) => effect.type === 'loadCatalogPage')).toBe(true);
});
