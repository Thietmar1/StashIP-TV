import {
    SORT_MODES,
    DEFAULT_SORT,
    PINNED_GROUP,
    migrateSort,
    validatePrefs,
    parsePrefs,
    serializePrefs,
    setPref,
    isHidden,
    poolCapFor,
    applyPrefs,
    validatePinOrder,
    parsePinOrder,
    migratePinOrder,
    isPinned,
    togglePin,
    movePin,
    groupChannels,
    flattenGroups
} from '../../src/domain/channelPrefs.js';

const chan = (id, name, sceneCount = 10, source = 'studio') => ({
    id,
    source,
    name,
    logo: { type: 'monogram', initials: 'XX', hue: 1 },
    sceneCount,
    sceneFilter: {}
});

describe('validatePrefs', () => {
    it('keeps every supported override', () => {
        const prefs = validatePrefs({
            'studio:1': { name: 'Short', logoUrl: '/x.png', hidden: true, poolCap: 300 }
        });
        expect(prefs['studio:1']).toEqual({
            name: 'Short',
            logoUrl: '/x.png',
            hidden: true,
            poolCap: 300
        });
    });

    it('drops a legacy pinnedAt, which pin order replaced', () => {
        expect(validatePrefs({ 'studio:1': { pinnedAt: 1000 } })).toEqual({});
    });

    it('trims names and logo urls', () => {
        expect(validatePrefs({ 'studio:1': { name: '  Trimmed  ' } })['studio:1'].name).toBe('Trimmed');
        expect(validatePrefs({ 'studio:1': { logoUrl: ' /x.png ' } })['studio:1'].logoUrl).toBe('/x.png');
    });

    it('drops entries that override nothing', () => {
        expect(validatePrefs({ 'studio:1': {} })).toEqual({});
        expect(validatePrefs({ 'studio:1': { name: '   ' } })).toEqual({});
        expect(validatePrefs({ 'studio:1': { hidden: false } })).toEqual({});
    });

    it('only accepts hidden as a real true', () => {
        expect(validatePrefs({ 'studio:1': { hidden: 'yes' } })).toEqual({});
    });

    it('rejects a nonsensical pool cap', () => {
        expect(validatePrefs({ 'studio:1': { poolCap: 0 } })).toEqual({});
        expect(validatePrefs({ 'studio:1': { poolCap: -5 } })).toEqual({});
        expect(validatePrefs({ 'studio:1': { poolCap: 'lots' } })).toEqual({});
    });

    it('coerces a numeric-string pool cap', () => {
        expect(validatePrefs({ 'studio:1': { poolCap: '250' } })['studio:1'].poolCap).toBe(250);
    });

    it('tolerates junk input', () => {
        expect(validatePrefs(null)).toEqual({});
        expect(validatePrefs('nope')).toEqual({});
        expect(validatePrefs([])).toEqual({});
        expect(validatePrefs({ 'studio:1': null })).toEqual({});
        expect(validatePrefs({ 'studio:1': 'nope' })).toEqual({});
        expect(validatePrefs({ 'studio:1': [] })).toEqual({});
    });
});

describe('parsePrefs', () => {
    it('round-trips', () => {
        const prefs = { 'studio:1': { name: 'A', hidden: true } };
        expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
    });

    it('returns empty prefs rather than failing on corrupt data', () => {
        expect(parsePrefs('{oh no')).toEqual({});
        expect(parsePrefs('')).toEqual({});
        expect(parsePrefs(null)).toEqual({});
        expect(parsePrefs('[1,2,3]')).toEqual({});
    });
});

describe('setPref', () => {
    it('adds an override for a channel with none', () => {
        expect(setPref({}, 'studio:1', { name: 'New' })).toEqual({ 'studio:1': { name: 'New' } });
    });

    it('merges into existing overrides', () => {
        const prefs = { 'studio:1': { name: 'A' } };
        expect(setPref(prefs, 'studio:1', { hidden: true })['studio:1']).toEqual({
            name: 'A',
            hidden: true
        });
    });

    it('does not mutate the input', () => {
        const prefs = { 'studio:1': { name: 'A' } };
        setPref(prefs, 'studio:1', { hidden: true });
        expect(prefs).toEqual({ 'studio:1': { name: 'A' } });
    });

    it('clears a field when set to null, false or empty', () => {
        const prefs = { 'studio:1': { name: 'A', hidden: true, poolCap: 300 } };
        expect(setPref(prefs, 'studio:1', { hidden: false })['studio:1']).toEqual({
            name: 'A',
            poolCap: 300
        });
        expect(setPref(prefs, 'studio:1', { name: '' })['studio:1']).toEqual({
            hidden: true,
            poolCap: 300
        });
        expect(setPref(prefs, 'studio:1', { poolCap: null })['studio:1']).toEqual({
            name: 'A',
            hidden: true
        });
    });

    it('removes the channel entirely once nothing is overridden', () => {
        const prefs = { 'studio:1': { hidden: true } };
        expect(setPref(prefs, 'studio:1', { hidden: false })).toEqual({});
    });

    it('leaves other channels alone', () => {
        const prefs = { 'studio:1': { name: 'A' }, 'studio:2': { name: 'B' } };
        expect(setPref(prefs, 'studio:1', { name: 'C' })['studio:2']).toEqual({ name: 'B' });
    });
});

describe('predicates', () => {
    const prefs = { 'studio:2': { hidden: true } };

    it('reports hidden', () => {
        expect(isHidden(prefs, 'studio:2')).toBe(true);
        expect(isHidden(prefs, 'studio:1')).toBe(false);
    });

    it('falls back to the global cap when a channel has no override', () => {
        expect(poolCapFor({ 'studio:1': { poolCap: 300 } }, 'studio:1', 100)).toBe(300);
        expect(poolCapFor({}, 'studio:1', 100)).toBe(100);
    });
});

describe('applyPrefs', () => {
    const channels = [chan('studio:1', 'Long Studio Name'), chan('studio:2', 'Other')];

    it('renames a channel', () => {
        expect(applyPrefs(channels, { 'studio:1': { name: 'Short' } })[0].name).toBe('Short');
    });

    it('replaces the logo with a custom url', () => {
        const out = applyPrefs(channels, { 'studio:1': { logoUrl: '/mine.png' } });
        expect(out[0].logo).toEqual({ type: 'image', url: '/mine.png' });
    });

    it('removes hidden channels', () => {
        const out = applyPrefs(channels, { 'studio:1': { hidden: true } });
        expect(out.map((c) => c.id)).toEqual(['studio:2']);
    });

    it('leaves untouched channels as the very same object', () => {
        const out = applyPrefs(channels, {});
        expect(out[0]).toBe(channels[0]);
    });

    it('does not mutate the originals', () => {
        applyPrefs(channels, { 'studio:1': { name: 'Short' } });
        expect(channels[0].name).toBe('Long Studio Name');
    });

    it('ignores prefs that do not change presentation', () => {
        const out = applyPrefs(channels, { 'studio:1': { poolCap: 300 } });
        expect(out[0]).toBe(channels[0]);
    });

    it('keeps the original name when only a logo is overridden', () => {
        const out = applyPrefs(channels, { 'studio:1': { logoUrl: '/mine.png' } });
        expect(out[0].name).toBe('Long Studio Name');
    });
});


describe('sort modes', () => {
    it('no longer offers a source sort, since channels are always grouped by source', () => {
        expect(SORT_MODES).toEqual(['name', 'sceneCount']);
        expect(SORT_MODES).toContain(DEFAULT_SORT);
    });

    it('migrates a stored source sort to name', () => {
        expect(migrateSort('source')).toBe('name');
        expect(migrateSort('name')).toBe('name');
        expect(migrateSort('sceneCount')).toBe('sceneCount');
        expect(migrateSort(undefined)).toBe('name');
        expect(migrateSort('nonsense')).toBe('name');
    });
});

describe('pin order', () => {
    it('treats membership as pinned and position as order', () => {
        expect(isPinned(['a', 'b'], 'a')).toBe(true);
        expect(isPinned(['a', 'b'], 'z')).toBe(false);
    });

    it('pins to the end and unpins', () => {
        expect(togglePin(['a'], 'b')).toEqual(['a', 'b']);
        expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
    });

    it('does not mutate', () => {
        const order = ['a', 'b'];
        togglePin(order, 'c');
        movePin(order, 'a', 1);
        expect(order).toEqual(['a', 'b']);
    });

    it('moves a pin to a new position', () => {
        expect(movePin(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
        expect(movePin(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
        expect(movePin(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    });

    it('clamps a move beyond either end', () => {
        expect(movePin(['a', 'b', 'c'], 'b', -5)).toEqual(['b', 'a', 'c']);
        expect(movePin(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b']);
    });

    it('ignores a move for something that is not pinned', () => {
        const order = ['a', 'b'];
        expect(movePin(order, 'z', 0)).toBe(order);
    });

    it('validates stored order, dropping junk and duplicates', () => {
        expect(validatePinOrder(['a', 'a', '', null, 5, 'b'])).toEqual(['a', 'b']);
        expect(validatePinOrder('nope')).toEqual([]);
        expect(validatePinOrder(null)).toEqual([]);
    });

    it('parses stored JSON, surviving corruption', () => {
        expect(parsePinOrder(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
        expect(parsePinOrder('{oh no')).toEqual([]);
        expect(parsePinOrder('')).toEqual([]);
        expect(parsePinOrder(null)).toEqual([]);
    });

    it('migrates pins written as pinnedAt timestamps, preserving their order', () => {
        // The previous release could only express pinned-at order.
        const legacy = {
            'studio:3': { pinnedAt: 300 },
            'studio:1': { pinnedAt: 100 },
            'studio:2': { pinnedAt: 200, name: 'Renamed' },
            'studio:9': { name: 'Not pinned' }
        };
        expect(migratePinOrder(legacy)).toEqual(['studio:1', 'studio:2', 'studio:3']);
    });

    it('migrates nothing when there are no legacy pins', () => {
        expect(migratePinOrder({ 'studio:1': { name: 'A' } })).toEqual([]);
        expect(migratePinOrder({})).toEqual([]);
        expect(migratePinOrder(null)).toEqual([]);
    });
});

describe('groupChannels', () => {
    const SOURCES = ['studio', 'performer', 'tag', 'group', 'savedFilter'];

    const channels = [
        chan('studio:1', 'Alpha', 50),
        chan('studio:2', 'Bravo', 20),
        chan('tag:1', 'Beach', 30, 'tag'),
        chan('performer:1', 'Riley', 40, 'performer')
    ];

    const group = (opts = {}) =>
        groupChannels(channels, { sourceOrder: SOURCES, ...opts });

    it('emits one group per source, in the declared order', () => {
        expect(group().map((g) => g.key)).toEqual(['studio', 'performer', 'tag']);
    });

    it('omits sources with no channels', () => {
        expect(group().map((g) => g.key)).not.toContain('group');
    });

    it('sorts within a group, not across groups', () => {
        const groups = group({ sort: 'name' });
        expect(groups[0].channels.map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
    });

    it('sorts countless channels (saved filters) last, then by name', () => {
        const filters = [
            { ...chan('savedFilter:2', 'Zeta', 0, 'savedFilter'), sceneCount: null },
            { ...chan('savedFilter:1', 'Alpha', 0, 'savedFilter'), sceneCount: null },
            chan('savedFilter:3', 'Counted', 9, 'savedFilter')
        ];
        const groups = groupChannels(filters, { sourceOrder: SOURCES, sort: 'sceneCount' });
        expect(groups[0].channels.map((c) => c.name)).toEqual(['Counted', 'Alpha', 'Zeta']);
    });

    it('falls back to the default sort for an unknown mode', () => {
        const groups = group({ sort: 'nonsense' });
        expect(groups[0].channels.map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
    });

    it('applies scene-count sort inside each group', () => {
        const many = [
            chan('studio:1', 'Alpha', 5),
            chan('studio:2', 'Bravo', 90)
        ];
        const groups = groupChannels(many, { sourceOrder: SOURCES, sort: 'sceneCount' });
        expect(groups[0].channels.map((c) => c.name)).toEqual(['Bravo', 'Alpha']);
    });

    it('puts pinned channels first, in their manual order, regardless of source', () => {
        const groups = group({ pinOrder: ['tag:1', 'studio:2'] });
        expect(groups[0].key).toBe(PINNED_GROUP);
        expect(groups[0].channels.map((c) => c.id)).toEqual(['tag:1', 'studio:2']);
    });

    it('removes pinned channels from their source group', () => {
        const groups = group({ pinOrder: ['studio:1'] });
        const studio = groups.find((g) => g.key === 'studio');
        expect(studio.channels.map((c) => c.id)).toEqual(['studio:2']);
    });

    it('omits the pinned group when nothing is pinned', () => {
        expect(group().map((g) => g.key)).not.toContain(PINNED_GROUP);
    });

    it('ignores a pinned id that no longer exists', () => {
        const groups = group({ pinOrder: ['studio:404', 'studio:1'] });
        expect(groups[0].channels.map((c) => c.id)).toEqual(['studio:1']);
    });

    it('reports a count per group', () => {
        expect(group().find((g) => g.key === 'studio').count).toBe(2);
    });

    it('marks collapsed groups', () => {
        const groups = group({ collapsed: ['studio'] });
        expect(groups.find((g) => g.key === 'studio').collapsed).toBe(true);
        expect(groups.find((g) => g.key === 'tag').collapsed).toBe(false);
    });

    it('still lists a collapsed group\'s channels, so its count stays honest', () => {
        const groups = group({ collapsed: ['studio'] });
        expect(groups.find((g) => g.key === 'studio').channels).toHaveLength(2);
    });

    it('drops hidden channels before grouping', () => {
        const groups = group({ prefs: { 'studio:1': { hidden: true } } });
        expect(groups.find((g) => g.key === 'studio').channels.map((c) => c.id)).toEqual(['studio:2']);
    });

    it('groups by the renamed name for sorting', () => {
        const groups = group({ prefs: { 'studio:2': { name: 'Aaa' } } });
        expect(groups[0].channels.map((c) => c.name)).toEqual(['Aaa', 'Alpha']);
    });

    it('still emits a source the caller did not declare', () => {
        const groups = groupChannels(channels, { sourceOrder: ['studio'] });
        expect(groups.map((g) => g.key)).toEqual(['studio', 'tag', 'performer']);
    });

    it('handles an empty lineup', () => {
        expect(groupChannels([], { sourceOrder: SOURCES })).toEqual([]);
    });

    it('works with no options at all', () => {
        expect(groupChannels(channels).length).toBeGreaterThan(0);
    });
});

describe('flattenGroups', () => {
    const groups = [
        { key: 'pinned', channels: [chan('tag:1', 'Pinned')], collapsed: false },
        { key: 'studio', channels: [chan('studio:1', 'A'), chan('studio:2', 'B')], collapsed: false },
        { key: 'tag', channels: [chan('tag:9', 'Hidden away')], collapsed: true }
    ];

    it('flattens visible groups in order', () => {
        expect(flattenGroups(groups).map((c) => c.id)).toEqual(['tag:1', 'studio:1', 'studio:2']);
    });

    it('omits collapsed groups entirely, so keyboard focus cannot enter them', () => {
        expect(flattenGroups(groups).map((c) => c.id)).not.toContain('tag:9');
    });

    it('handles no groups', () => {
        expect(flattenGroups([])).toEqual([]);
    });
});
