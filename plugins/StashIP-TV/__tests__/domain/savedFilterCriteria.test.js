import { savedFilterToSceneFilter } from '../../src/domain/savedFilterCriteria.js';

describe('savedFilterToSceneFilter', () => {
    it('converts the shape Stash actually stores for a tag criterion', () => {
        // Taken verbatim from a real saved filter.
        const objectFilter = {
            tags: {
                modifier: 'INCLUDES_ALL',
                value: { depth: 0, excluded: [], items: [{ id: '71', label: 'Adorable' }] }
            }
        };
        expect(savedFilterToSceneFilter(objectFilter)).toEqual({
            tags: { modifier: 'INCLUDES_ALL', value: ['71'] }
        });
    });

    it('collects every selected id', () => {
        const out = savedFilterToSceneFilter({
            studios: {
                modifier: 'INCLUDES',
                value: { items: [{ id: '1' }, { id: '2' }, { id: '3' }], excluded: [], depth: 0 }
            }
        });
        expect(out.studios.value).toEqual(['1', '2', '3']);
    });

    it('renames excluded to excludes, which is what the API calls it', () => {
        const out = savedFilterToSceneFilter({
            tags: {
                modifier: 'INCLUDES',
                value: { items: [{ id: '1' }], excluded: [{ id: '9' }, { id: '8' }], depth: 0 }
            }
        });
        expect(out.tags.excludes).toEqual(['9', '8']);
    });

    it('omits excludes when nothing is excluded', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'INCLUDES', value: { items: [{ id: '1' }], excluded: [], depth: 0 } }
        });
        expect(out.tags).not.toHaveProperty('excludes');
    });

    it('keeps a meaningful depth', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'INCLUDES', value: { items: [{ id: '1' }], excluded: [], depth: -1 } }
        });
        expect(out.tags.depth).toBe(-1);
    });

    it('drops depth 0, so a non-hierarchical criterion cannot be sent an unsupported field', () => {
        const out = savedFilterToSceneFilter({
            performers: { modifier: 'INCLUDES', value: { items: [{ id: '1' }], excluded: [], depth: 0 } }
        });
        expect(out.performers).not.toHaveProperty('depth');
    });

    it('leaves scalar criteria alone -- they already match the API', () => {
        const rating = { value: 80, modifier: 'GREATER_THAN' };
        expect(savedFilterToSceneFilter({ rating100: rating }).rating100).toBe(rating);
    });

    it('leaves a bare boolean criterion alone', () => {
        expect(savedFilterToSceneFilter({ organized: true }).organized).toBe(true);
    });

    it('leaves an already-converted array value alone', () => {
        const already = { modifier: 'INCLUDES', value: ['1', '2'] };
        expect(savedFilterToSceneFilter({ tags: already }).tags).toBe(already);
    });

    it('converts nested AND, OR and NOT groups', () => {
        const out = savedFilterToSceneFilter({
            AND: {
                tags: { modifier: 'INCLUDES', value: { items: [{ id: '5' }], excluded: [], depth: 0 } }
            },
            NOT: {
                studios: { modifier: 'INCLUDES', value: { items: [{ id: '7' }], excluded: [], depth: 0 } }
            }
        });
        expect(out.AND.tags.value).toEqual(['5']);
        expect(out.NOT.studios.value).toEqual(['7']);
    });

    it('converts a list of nested groups', () => {
        const out = savedFilterToSceneFilter({
            OR: [
                { tags: { modifier: 'INCLUDES', value: { items: [{ id: '1' }], excluded: [], depth: 0 } } },
                { tags: { modifier: 'INCLUDES', value: { items: [{ id: '2' }], excluded: [], depth: 0 } } }
            ]
        });
        expect(out.OR.map((g) => g.tags.value)).toEqual([['1'], ['2']]);
    });

    it('coerces numeric ids to strings, as the ID type requires', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'INCLUDES', value: { items: [{ id: 71 }], excluded: [], depth: 0 } }
        });
        expect(out.tags.value).toEqual(['71']);
    });

    it('accepts bare ids as well as {id} objects', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'INCLUDES', value: { items: ['71'], excluded: [], depth: 0 } }
        });
        expect(out.tags.value).toEqual(['71']);
    });

    it('skips items with no id rather than emitting null', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'INCLUDES', value: { items: [{ id: '1' }, { label: 'no id' }, null], excluded: [], depth: 0 } }
        });
        expect(out.tags.value).toEqual(['1']);
    });

    it('tolerates missing items and excluded lists', () => {
        const out = savedFilterToSceneFilter({
            tags: { modifier: 'IS_NULL', value: { depth: 0 } }
        });
        expect(out.tags).toEqual({ modifier: 'IS_NULL', value: [] });
    });

    it('returns an empty filter for nothing', () => {
        expect(savedFilterToSceneFilter(null)).toEqual({});
        expect(savedFilterToSceneFilter(undefined)).toEqual({});
        expect(savedFilterToSceneFilter('nonsense')).toEqual({});
        expect(savedFilterToSceneFilter({})).toEqual({});
    });

    it('converts saved Stash-ID values alongside tags without losing either constraint', () => {
        const saved = {
            tags: { modifier: 'INCLUDES_ALL', value: { items: [{ id: '71' }], excluded: [], depth: 0 } },
            stash_id_endpoint: { modifier: 'EQUALS', value: { endpoint: 'https://stashdb.org/graphql', stashID: 'scene-id' } }
        };
        const before = JSON.stringify(saved);
        expect(savedFilterToSceneFilter(saved)).toEqual({
            tags: { modifier: 'INCLUDES_ALL', value: ['71'] },
            stash_id_endpoint: { modifier: 'EQUALS', endpoint: 'https://stashdb.org/graphql', stash_id: 'scene-id' }
        });
        expect(JSON.stringify(saved)).toBe(before);
    });

    it('supports legacy string Stash IDs and endpoint-qualified null checks', () => {
        expect(savedFilterToSceneFilter({ stash_id_endpoint: { modifier: 'NOT_EQUALS', value: 'old-id' } })).toEqual({
            stash_id_endpoint: { modifier: 'NOT_EQUALS', endpoint: '', stash_id: 'old-id' }
        });
        for (const modifier of ['IS_NULL', 'NOT_NULL']) {
            const out = savedFilterToSceneFilter({ NOT: { stash_id_endpoint: {
                modifier, value: { endpoint: 'https://stashdb.org/graphql', stashID: '' }
            } } });
            expect(out.NOT.stash_id_endpoint).toEqual({ modifier, endpoint: 'https://stashdb.org/graphql', stash_id: '' });
        }
    });

    it('supports snake-case nested IDs and empty saved values without adding an API value field', () => {
        expect(savedFilterToSceneFilter({ stash_id_endpoint: { modifier: 'EQUALS', value: { stash_id: 'scene-id' } } })).toEqual({
            stash_id_endpoint: { modifier: 'EQUALS', endpoint: '', stash_id: 'scene-id' }
        });
        for (const value of [null, undefined, {}]) {
            const out = savedFilterToSceneFilter({ stash_id_endpoint: { modifier: 'IS_NULL', value } });
            expect(out.stash_id_endpoint).toEqual({ modifier: 'IS_NULL', endpoint: '', stash_id: '' });
        }
    });

    it('preserves API-shaped Stash-ID criteria and null criteria', () => {
        const criterion = { modifier: 'EQUALS', endpoint: 'https://stashdb.org/graphql', stash_id: 'scene-id' };
        expect(savedFilterToSceneFilter({ stash_id_endpoint: criterion }).stash_id_endpoint).toBe(criterion);
        expect(savedFilterToSceneFilter({ stash_id_endpoint: null }).stash_id_endpoint).toBeNull();
    });

    it('converts saved numeric bounds to scalar API values and preserves zero', () => {
        for (const field of ['id', 'file_count', 'rating100', 'o_counter', 'framerate', 'bitrate',
            'duration', 'tag_count', 'performer_age', 'performer_count', 'stash_id_count',
            'interactive_speed', 'resume_time', 'play_count', 'play_duration']) {
            const saved = { [field]: { modifier: 'BETWEEN', value: { value: 0, value2: 5 } } };
            const before = JSON.stringify(saved);
            expect(savedFilterToSceneFilter(saved)[field]).toEqual({ modifier: 'BETWEEN', value: 0, value2: 5 });
            expect(JSON.stringify(saved)).toBe(before);
        }
    });

    it('converts saved date/timestamp bounds and nested numeric criteria', () => {
        for (const field of ['date', 'created_at', 'updated_at', 'last_played_at']) {
            expect(savedFilterToSceneFilter({ [field]: { modifier: 'BETWEEN', value: {
                value: '2026-01-01', value2: '2026-02-01'
            } } })[field]).toEqual({ modifier: 'BETWEEN', value: '2026-01-01', value2: '2026-02-01' });
        }
        expect(savedFilterToSceneFilter({ NOT: { stash_id_count: { modifier: 'GREATER_THAN', value: { value: 1 } } } }))
            .toEqual({ NOT: { stash_id_count: { modifier: 'GREATER_THAN', value: 1 } } });
    });

    it('uses Stash UI scalar defaults for empty/null range bounds and retains an explicit null upper bound', () => {
        for (const value of [{}, { value: null }, { value: undefined }]) {
            expect(savedFilterToSceneFilter({ stash_id_count: { modifier: 'IS_NULL', value } }).stash_id_count)
                .toEqual({ modifier: 'IS_NULL', value: 0 });
            expect(savedFilterToSceneFilter({ date: { modifier: 'IS_NULL', value } }).date)
                .toEqual({ modifier: 'IS_NULL', value: '' });
        }
        expect(savedFilterToSceneFilter({ rating100: { modifier: 'GREATER_THAN', value: { value: 50, value2: null } } }).rating100)
            .toEqual({ modifier: 'GREATER_THAN', value: 50, value2: null });
    });

    it('does not rewrite invalid scalar/unknown objects into empty lists', () => {
        for (const criterion of [null, {}, { value: null }, { value: ['invalid'] }]) {
            expect(savedFilterToSceneFilter({ stash_id_count: criterion }).stash_id_count).toBe(criterion);
        }
        const unknown = { modifier: 'EQUALS', value: { custom: 'unsupported' } };
        expect(savedFilterToSceneFilter({ unknown }).unknown).toBe(unknown);
        for (const value of [{ excluded: [] }, { items: [] }, { depth: 0 }]) {
            expect(savedFilterToSceneFilter({ tags: { modifier: 'IS_NULL', value } }).tags)
                .toEqual({ modifier: 'IS_NULL', value: [] });
        }
    });
});
