import {
    DEFAULT_LINEUP,
    KNOWN_SOURCES,
    validateLineup,
    parseLineup,
    serializeLineup,
    makeChannelId,
    parseChannelId
} from '../../src/domain/lineup.js';

describe('DEFAULT_LINEUP', () => {
    it('works with no configuration at all', () => {
        expect(validateLineup(DEFAULT_LINEUP)).toEqual(DEFAULT_LINEUP);
    });

    it('is studio-based, which every Stash library has', () => {
        expect(DEFAULT_LINEUP).toEqual([
            { source: 'special', minScenes: 0, ids: ['new-releases', 'recently-added', 'movies', 'shorts'] },
            { source: 'studio', minScenes: 5 }
        ]);
    });

    it('orders Special before the regular source groups', () => {
        expect(KNOWN_SOURCES[0]).toBe('special');
    });
});

describe('validateLineup', () => {
    it('keeps entries for every known source', () => {
        const entries = KNOWN_SOURCES.map((source) => ({ source }));
        expect(validateLineup(entries).map((e) => e.source)).toEqual(KNOWN_SOURCES);
    });

    it('drops entries with an unknown or missing source', () => {
        expect(validateLineup([{ source: 'gallery' }, { source: 'studio' }, {}])).toEqual([
            { source: 'studio', minScenes: 0 }
        ]);
    });

    it('coerces minScenes to a non-negative integer', () => {
        expect(validateLineup([{ source: 'studio', minScenes: '7' }])[0].minScenes).toBe(7);
        expect(validateLineup([{ source: 'studio', minScenes: -3 }])[0].minScenes).toBe(0);
        expect(validateLineup([{ source: 'studio', minScenes: 2.8 }])[0].minScenes).toBe(2);
        expect(validateLineup([{ source: 'studio', minScenes: 'abc' }])[0].minScenes).toBe(0);
        expect(validateLineup([{ source: 'studio' }])[0].minScenes).toBe(0);
    });

    it('normalises ids to strings and drops empty ones', () => {
        const out = validateLineup([{ source: 'tag', ids: [12, '34', '', null] }]);
        expect(out[0].ids).toEqual(['12', '34']);
    });

    it('omits ids entirely when none are usable', () => {
        expect(validateLineup([{ source: 'tag', ids: [] }])[0]).not.toHaveProperty('ids');
        expect(validateLineup([{ source: 'tag', ids: 'nope' }])[0]).not.toHaveProperty('ids');
    });

    it('keeps names for saved-filter entries', () => {
        expect(validateLineup([{ source: 'savedFilter', names: ['Favourites', ''] }])[0].names)
            .toEqual(['Favourites']);
    });

    it('tolerates non-array and nullish input', () => {
        expect(validateLineup(null)).toEqual([]);
        expect(validateLineup('nope')).toEqual([]);
        expect(validateLineup([null, 'x', 5])).toEqual([]);
    });
});

describe('parseLineup', () => {
    it('round-trips a serialised lineup', () => {
        const lineup = validateLineup([
            { source: 'studio', minScenes: 5 },
            { source: 'tag', ids: ['9'] }
        ]);
        expect(parseLineup(serializeLineup(lineup))).toEqual(lineup);
    });

    it('falls back to the default for malformed JSON', () => {
        expect(parseLineup('{oh no')).toEqual(DEFAULT_LINEUP);
    });

    it('falls back to the default for null, empty or non-string input', () => {
        expect(parseLineup(null)).toEqual(DEFAULT_LINEUP);
        expect(parseLineup('')).toEqual(DEFAULT_LINEUP);
        expect(parseLineup(undefined)).toEqual(DEFAULT_LINEUP);
    });

    it('falls back to the default when JSON is valid but holds no usable entry', () => {
        expect(parseLineup('[]')).toEqual(DEFAULT_LINEUP);
        expect(parseLineup('[{"source":"gallery"}]')).toEqual(DEFAULT_LINEUP);
        expect(parseLineup('{"source":"studio"}')).toEqual(DEFAULT_LINEUP);
    });
});

describe('channel ids', () => {
    it('namespaces ids by source so numbering cannot collide', () => {
        expect(makeChannelId('studio', '12')).toBe('studio:12');
        expect(makeChannelId('studio', 12)).not.toBe(makeChannelId('tag', 12));
    });

    it('round-trips', () => {
        expect(parseChannelId(makeChannelId('savedFilter', '3'))).toEqual({
            source: 'savedFilter',
            id: '3'
        });
    });

    it('keeps colons in the id portion intact', () => {
        expect(parseChannelId('savedFilter:a:b')).toEqual({ source: 'savedFilter', id: 'a:b' });
    });

    it('returns null for a malformed id', () => {
        expect(parseChannelId('nocolon')).toBeNull();
        expect(parseChannelId('')).toBeNull();
        expect(parseChannelId(null)).toBeNull();
    });
});
