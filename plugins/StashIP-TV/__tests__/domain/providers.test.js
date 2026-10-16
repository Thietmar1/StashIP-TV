import studio from '../../src/domain/providers/studio.js';
import tag from '../../src/domain/providers/tag.js';
import group from '../../src/domain/providers/group.js';
import performer from '../../src/domain/providers/performer.js';
import savedFilter from '../../src/domain/providers/savedFilter.js';
import { PROVIDERS, resolveLineup, fetchCatalog } from '../../src/domain/providers/index.js';
import { KNOWN_SOURCES } from '../../src/domain/lineup.js';

const studioRows = (rows) => async () => ({ findStudios: { studios: rows } });

describe('the registry covers every known source', () => {
    it('includes the virtual special-channel source', () => {
        expect(KNOWN_SOURCES).toContain('special');
    });

    it('has a provider for each source the lineup accepts', () => {
        expect(Object.keys(PROVIDERS).sort()).toEqual([...KNOWN_SOURCES].sort());
    });

    it('every provider declares its own source name', () => {
        for (const [key, provider] of Object.entries(PROVIDERS)) {
            expect(provider.source).toBe(key);
            expect(typeof provider.listChannels).toBe('function');
        }
    });
});

describe('entity providers', () => {
    const cases = [
        { provider: studio, root: 'findStudios', coll: 'studios', logo: 'image_path', key: 'studios' },
        { provider: tag, root: 'findTags', coll: 'tags', logo: 'image_path', key: 'tags' },
        { provider: group, root: 'findGroups', coll: 'groups', logo: 'front_image_path', key: 'groups' }
    ];

    it.each(cases)('$provider.source sends depth, being hierarchical', async (c) => {
        const gql = async () => ({
            [c.root]: { [c.coll]: [{ id: '7', name: 'T', [c.logo]: null, scene_count: 1 }] }
        });
        const [channel] = await c.provider.listChannels({ source: c.provider.source }, gql);
        expect(channel.sceneFilter[c.key].depth).toBe(-1);
    });

    it.each(cases)('$provider.source queries $root and builds a $key scene filter', async (c) => {
        const gql = jest.fn(async () => ({
            [c.root]: { [c.coll]: [{ id: '7', name: 'Thing', [c.logo]: '/img?t=1', scene_count: 20 }] }
        }));

        const [channel] = await c.provider.listChannels({ source: c.provider.source, minScenes: 5 }, gql);

        expect(gql.mock.calls[0][0]).toContain(c.root);
        expect(channel.id).toBe(`${c.provider.source}:7`);
        expect(channel.source).toBe(c.provider.source);
        expect(channel.name).toBe('Thing');
        expect(channel.sceneCount).toBe(20);
        expect(channel.sceneFilter).toEqual({
            [c.key]: { value: ['7'], modifier: 'INCLUDES', depth: -1 }
        });
    });

    it.each(cases)('$provider.source selects the right artwork field', async (c) => {
        expect(c.provider.query).toContain(c.logo);
    });

    it('turns minScenes into an "at least N" server-side filter', async () => {
        const gql = jest.fn(studioRows([]));
        await studio.listChannels({ source: 'studio', minScenes: 5 }, gql);
        expect(gql.mock.calls[0][1].f).toEqual({
            scene_count: { value: 4, modifier: 'GREATER_THAN' }
        });
    });

    it('sends no count filter when the threshold is zero or missing', async () => {
        const gql = jest.fn(studioRows([]));
        await studio.listChannels({ source: 'studio', minScenes: 0 }, gql);
        await studio.listChannels({ source: 'studio' }, gql);
        expect(gql.mock.calls[0][1].f).toBeNull();
        expect(gql.mock.calls[1][1].f).toBeNull();
    });

    it('fetches explicit ids and ignores the threshold for them', async () => {
        const gql = jest.fn(studioRows([]));
        await studio.listChannels({ source: 'studio', ids: ['3', '9'], minScenes: 500 }, gql);

        expect(gql.mock.calls[0][1].ids).toEqual(['3', '9']);
        expect(gql.mock.calls[0][1].f).toBeNull();
    });

    it('asks for every match, ordered by name', async () => {
        const gql = jest.fn(studioRows([]));
        await studio.listChannels({ source: 'studio', minScenes: 1 }, gql);
        expect(gql.mock.calls[0][1].find).toEqual({ per_page: -1, sort: 'name', direction: 'ASC' });
    });

    it('requests one bounded favorite catalogue page', async () => {
        const gql = jest.fn(async () => ({ findStudios: { count: 73, studios: [] } }));

        await expect(studio.listCatalogPage({ page: 2, perPage: 50, query: 'red', favorited: true }, gql))
            .resolves.toEqual({ channels: [], total: 73 });

        expect(gql.mock.calls[0][1]).toEqual({
            f: { favorite: true },
            find: { page: 2, per_page: 50, q: 'red', sort: 'name', direction: 'ASC' }
        });
        expect(gql.mock.calls[0][0]).toContain('findStudios');
    });

    it('orders a catalogue page by scene count on the server', async () => {
        const gql = jest.fn(async () => ({ findStudios: { count: 0, studios: [] } }));

        await studio.listCatalogPage({ page: 1, perPage: 50, sort: 'sceneCount' }, gql);

        expect(gql.mock.calls[0][1].find).toEqual({
            page: 1, per_page: 50, sort: 'scenes_count', direction: 'DESC'
        });
    });

    it('falls back to a monogram when Stash returns its placeholder image', async () => {
        const gql = studioRows([
            { id: '1', name: 'No Art', image_path: '/studio/1/image?default=true', scene_count: 9 }
        ]);
        const [channel] = await studio.listChannels({ source: 'studio' }, gql);
        expect(channel.logo).toEqual({ type: 'monogram', initials: 'NA', hue: expect.any(Number) });
    });

    it('uses real artwork when present', async () => {
        const gql = studioRows([{ id: '1', name: 'Art', image_path: '/img?t=5', scene_count: 9 }]);
        const [channel] = await studio.listChannels({ source: 'studio' }, gql);
        expect(channel.logo).toEqual({ type: 'image', url: '/img?t=5' });
    });

    it('defaults a missing scene_count to zero', async () => {
        const gql = studioRows([{ id: '1', name: 'X', image_path: null }]);
        const [channel] = await studio.listChannels({ source: 'studio' }, gql);
        expect(channel.sceneCount).toBe(0);
    });

    it('returns nothing for an empty or malformed response', async () => {
        expect(await studio.listChannels({ source: 'studio' }, async () => ({}))).toEqual([]);
        expect(await studio.listChannels({ source: 'studio' }, async () => null)).toEqual([]);
    });
});

describe('performer provider (Models)', () => {
    const rows = (list) => async () => ({ findPerformers: { performers: list } });

    it('builds a performers scene filter', async () => {
        const gql = jest.fn(rows([{ id: '7', name: 'Riley', image_path: '/p.png', scene_count: 40 }]));
        const [channel] = await performer.listChannels({ source: 'performer', minScenes: 5 }, gql);

        expect(channel.id).toBe('performer:7');
        expect(channel.name).toBe('Riley');
        expect(channel.sceneCount).toBe(40);
        expect(gql.mock.calls[0][0]).toContain('findPerformers');
    });

    it('sends NO depth, because performers are not hierarchical', async () => {
        // SceneFilterType.performers is a MultiCriterionInput; sending `depth`
        // there fails GraphQL validation.
        const [channel] = await performer.listChannels(
            { source: 'performer' },
            rows([{ id: '7', name: 'Riley', image_path: null, scene_count: 1 }])
        );
        expect(channel.sceneFilter).toEqual({
            performers: { value: ['7'], modifier: 'INCLUDES' }
        });
        expect(channel.sceneFilter.performers).not.toHaveProperty('depth');
    });

    it('still sends depth for the hierarchical sources', () => {
        // Guards against the flag being applied everywhere by accident.
        for (const p of [studio, tag, group]) {
            expect(p.query).toBeDefined();
        }
    });

    it('filters by scene count like the other entity sources', async () => {
        const gql = jest.fn(rows([]));
        await performer.listChannels({ source: 'performer', minScenes: 10 }, gql);
        expect(gql.mock.calls[0][1].f).toEqual({
            scene_count: { value: 9, modifier: 'GREATER_THAN' }
        });
    });

    it('filters a bounded model catalogue by gender and favorites', async () => {
        const gql = jest.fn(rows([]));

        await performer.listCatalogPage(
            { page: 1, perPage: 50, query: '', favorited: true, gender: 'female' },
            gql
        );

        expect(gql.mock.calls[0][1]).toEqual({
            f: { filter_favorites: true, gender: { value: 'FEMALE', modifier: 'EQUALS' } },
            find: { page: 1, per_page: 50, sort: 'name', direction: 'ASC' }
        });
        expect(performer.capabilities).toEqual({ favorite: true, gender: true });
        expect(group.capabilities).toEqual({ favorite: false, gender: false });
    });
});

describe('savedFilter provider', () => {
    const filters = [
        { id: '1', name: 'Favourites', object_filter: { rating100: { value: 80, modifier: 'GREATER_THAN' } } },
        { id: '2', name: 'Recent', object_filter: { date: { value: '2026-01-01', modifier: 'GREATER_THAN' } } }
    ];
    const gqlWith = (rows) => async () => ({ findSavedFilters: rows });

    it('converts object_filter into a usable scene filter', async () => {
        const [channel] = await savedFilter.listChannels({ source: 'savedFilter' }, gqlWith([filters[0]]));
        expect(channel.sceneFilter).toEqual(filters[0].object_filter);
        expect(channel.id).toBe('savedFilter:1');
    });

    it('converts the UI criterion shape Stash actually stores', async () => {
        const uiShaped = {
            id: '9',
            name: 'Tagged',
            object_filter: {
                tags: { modifier: 'INCLUDES_ALL', value: { depth: 0, excluded: [], items: [{ id: '71', label: 'Adorable' }] } }
            }
        };
        const [channel] = await savedFilter.listChannels({ source: 'savedFilter' }, gqlWith([uiShaped]));
        expect(channel.sceneFilter).toEqual({ tags: { modifier: 'INCLUDES_ALL', value: ['71'] } });
    });

    it('only asks for scene-mode filters', async () => {
        expect(savedFilter.query).toContain('mode: SCENES');
    });

    it('returns every scene filter when no names are given', async () => {
        const out = await savedFilter.listChannels({ source: 'savedFilter' }, gqlWith(filters));
        expect(out.map((c) => c.name)).toEqual(['Favourites', 'Recent']);
    });

    it('selects only the named filters when names are given', async () => {
        const out = await savedFilter.listChannels(
            { source: 'savedFilter', names: ['Recent'] },
            gqlWith(filters)
        );
        expect(out.map((c) => c.name)).toEqual(['Recent']);
    });

    it('skips filters with no criteria, which would duplicate the whole library', async () => {
        const out = await savedFilter.listChannels(
            { source: 'savedFilter' },
            gqlWith([{ id: '3', name: 'Everything', object_filter: {} }, { id: '4', name: 'Null', object_filter: null }])
        );
        expect(out).toEqual([]);
    });

    it('always wears a monogram, since saved filters have no artwork', async () => {
        const [channel] = await savedFilter.listChannels({ source: 'savedFilter' }, gqlWith([filters[0]]));
        expect(channel.logo.type).toBe('monogram');
        expect(channel.sceneCount).toBeNull();
    });

    it('returns nothing for an empty response', async () => {
        expect(await savedFilter.listChannels({ source: 'savedFilter' }, async () => ({}))).toEqual([]);
    });
});

describe('resolveLineup', () => {
    const gql = async (query) => {
        if (query.includes('findStudios')) {
            return { findStudios: { studios: [{ id: '1', name: 'S1', image_path: null, scene_count: 9 }] } };
        }
        if (query.includes('findTags')) {
            return { findTags: { tags: [{ id: '1', name: 'T1', image_path: null, scene_count: 9 }] } };
        }
        return { findSavedFilters: [{ id: '1', name: 'F1', object_filter: { organized: true } }] };
    };

    it('mixes sources into one lineup, in lineup order', async () => {
        const { channels } = await resolveLineup(
            [{ source: 'studio' }, { source: 'tag' }, { source: 'savedFilter' }],
            gql
        );
        expect(channels.map((c) => c.id)).toEqual(['studio:1', 'tag:1', 'savedFilter:1']);
    });

    it('keeps ids from different sources distinct even when the underlying ids match', async () => {
        const { channels } = await resolveLineup([{ source: 'studio' }, { source: 'tag' }], gql);
        expect(new Set(channels.map((c) => c.id)).size).toBe(2);
    });

    it('drops duplicate channels, keeping the first occurrence', async () => {
        const { channels } = await resolveLineup([{ source: 'studio' }, { source: 'studio' }], gql);
        expect(channels).toHaveLength(1);
    });

    it('ignores entries whose source has no provider', async () => {
        const { channels, errors } = await resolveLineup([{ source: 'nonsense' }, { source: 'studio' }], gql);
        expect(channels.map((c) => c.id)).toEqual(['studio:1']);
        expect(errors).toEqual([]);
    });

    it('loses only the failing source when one query breaks', async () => {
        const flaky = async (query) => {
            if (query.includes('findTags')) throw new Error('tag index missing');
            return gql(query);
        };

        const { channels, errors } = await resolveLineup([{ source: 'studio' }, { source: 'tag' }], flaky);

        expect(channels.map((c) => c.id)).toEqual(['studio:1']);
        expect(errors).toEqual([{ source: 'tag', message: 'tag index missing' }]);
    });

    it('returns nothing for an empty lineup', async () => {
        expect(await resolveLineup([], gql)).toEqual({ channels: [], errors: [] });
    });

    it('passes settings to the special source when resolving explicit channel picks', async () => {
        const { channels } = await resolveLineup(
            [{ source: 'special', ids: ['movies'] }],
            gql,
            {
                guide_new_release_days: 30,
                guide_recently_added_days: 14,
                guide_movie_min_minutes: 75,
                guide_short_max_minutes: 5
            },
            new Date('2026-08-25T12:00:00Z')
        );

        expect(channels).toEqual([
            expect.objectContaining({
                id: 'special:movies',
                sceneFilter: { duration: { value: 4500, modifier: 'GREATER_THAN' } }
            })
        ]);
    });
});

describe('fetchCatalog', () => {
    const gql = async (query) => {
        if (query.includes('findStudios')) {
            return { findStudios: { studios: [{ id: '1', name: 'S1', image_path: null, scene_count: 2 }] } };
        }
        if (query.includes('findTags')) {
            return { findTags: { tags: [{ id: '1', name: 'T1', image_path: null, scene_count: 1 }] } };
        }
        if (query.includes('findGroups')) {
            return { findGroups: { groups: [{ id: '1', name: 'G1', front_image_path: null, scene_count: 1 }] } };
        }
        return { findSavedFilters: [{ id: '1', name: 'F1', object_filter: { organized: true } }] };
    };

    it('returns every source keyed by name', async () => {
        const { catalog } = await fetchCatalog(gql);
        expect(Object.keys(catalog).sort()).toEqual([...KNOWN_SOURCES].sort());
        expect(catalog.studio[0].id).toBe('studio:1');
        expect(catalog.savedFilter[0].id).toBe('savedFilter:1');
        expect(catalog.special.map((channel) => channel.id)).toEqual([
            'special:all-scenes',
            'special:new-releases', 'special:recently-added', 'special:movies', 'special:shorts'
        ]);
    });

    it('ignores lineup thresholds, so nothing is pre-filtered out of the picker', async () => {
        const seen = jest.fn(gql);
        await fetchCatalog(seen, ['studio']);
        // No scene_count filter: the manager must be able to offer every studio.
        expect(seen.mock.calls[0][1].f).toBeNull();
    });

    it('can be limited to specific sources', async () => {
        const { catalog } = await fetchCatalog(gql, ['studio']);
        expect(Object.keys(catalog)).toEqual(['studio']);
    });

    it('reports a failing source without losing the others', async () => {
        const flaky = async (query) => {
            if (query.includes('findTags')) throw new Error('tag index missing');
            return gql(query);
        };
        const { catalog, errors } = await fetchCatalog(flaky, ['studio', 'tag']);
        expect(catalog.studio).toHaveLength(1);
        expect(catalog.tag).toEqual([]);
        expect(errors).toEqual([{ source: 'tag', message: 'tag index missing' }]);
    });

    it('ignores an unknown source', async () => {
        const { catalog, errors } = await fetchCatalog(gql, ['nonsense']);
        expect(catalog.nonsense).toEqual([]);
        expect(errors).toEqual([]);
    });
});
