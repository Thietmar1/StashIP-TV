import { fetchScenePool, fetchAllScenePool, fetchSceneStreams, sceneTitle, SCENE_POOL_QUERY } from '../../src/api/scenes.js';

describe('the full library pool', () => {
    it('loads beyond the normal cap, deduplicates pages, and includes the final partial page', async () => {
        const first = Array.from({ length: 500 }, (_, i) => ({ id: String(i) }));
        const gql = jest.fn()
            .mockResolvedValueOnce({ findScenes: { scenes: first } })
            .mockResolvedValueOnce({ findScenes: { scenes: [first[499], { id: '500' }] } });
        const result = await fetchAllScenePool(gql);
        expect(result).toHaveLength(501);
        expect(result.at(-1).id).toBe('500');
        expect(result[0]._summary).toBe(true);
        expect(gql.mock.calls[0][0]).not.toMatch(/details|paths|performers|studio|tags/);
        expect(gql.mock.calls.map((call) => call[1])).toEqual([1, 2].map((page) => ({
            filter: {}, find: { per_page: 500, page, sort: 'id', direction: 'ASC' }
        })));
    });

    it('rejects incomplete results rather than scheduling a partial library', async () => {
        const gql = jest.fn()
            .mockResolvedValueOnce({ findScenes: { scenes: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })) } })
            .mockRejectedValueOnce(new Error('offline'));
        await expect(fetchAllScenePool(gql)).rejects.toThrow('offline');
        await expect(fetchAllScenePool(async () => ({}))).rejects.toThrow('full scene library');
        expect(await fetchAllScenePool(async () => ({ findScenes: { count: 0, scenes: [] } }))).toEqual([]);
    });
});

it('fetches alternate stream URLs for only the failed scene', async () => {
    const streams = [{ url: '/scene/1202/stream.mp4', mime_type: 'video/mp4' }];
    const gql = jest.fn(async () => ({ findScene: { sceneStreams: streams } }));
    expect(await fetchSceneStreams(gql, '1202')).toEqual(streams);
    expect(gql.mock.calls[0][1]).toEqual({ id: '1202' });
    expect(await fetchSceneStreams(async () => ({ findScene: null }), 'missing')).toEqual([]);
});

describe('fetchScenePool', () => {
    const filter = { studios: { value: ['1'], modifier: 'INCLUDES' } };

    function library(size) {
        const scenes = Array.from({ length: size }, (_, id) => ({ id: String(id) }));
        const gql = jest.fn(async (query, { find }) => query.includes('TVGuideSceneCount')
            ? { findScenes: { count: scenes.length } }
            : { findScenes: { scenes: scenes.slice((find.page - 1) * find.per_page, find.page * find.per_page) } });
        return { gql, scenes };
    }

    it('cycles the whole catalog in daily batches, wraps a short final page and stays stable on reload', async () => {
        const { gql } = library(250);
        const pools = [];
        for (const day of ['22', '23', '24', '25']) {
            gql.mockClear();
            const pool = await fetchScenePool(gql, filter, 100, `2026-08-${day}`);
            pools.push(pool);
            expect(pool).toHaveLength(100);
            expect(new Set(pool.map((scene) => scene.id)).size).toBe(100);
            // Count-only query, then no more than 100 scenes of metadata.
            expect(gql.mock.calls[0][0]).not.toMatch(/title|details|paths/);
            const fetched = await Promise.all(gql.mock.results.slice(1).map((call) => call.value));
            expect(fetched.reduce((sum, data) => sum + data.findScenes.scenes.length, 0)).toBe(100);
        }
        expect(pools[0]).not.toEqual(pools[1]);
        expect(new Set(pools.slice(0, 3).flat().map((scene) => scene.id)).size).toBe(250);
        expect(pools[3]).toEqual(pools[0]);
        expect(await fetchScenePool(gql, filter, 100, '2026-08-22')).toEqual(pools[0]);
    });

    it('admits newly added scenes without requiring a larger cap', async () => {
        const { gql, scenes } = library(100);
        expect(await fetchScenePool(gql, filter, 100, '2026-08-22')).toHaveLength(100);
        scenes.push({ id: 'new' });
        const next = await fetchScenePool(gql, filter, 100, '2026-08-23');
        const following = await fetchScenePool(gql, filter, 100, '2026-08-24');
        expect([...next, ...following]).toContainEqual({ id: 'new' });
    });

    it('avoids metadata requests for an empty channel and loads a small channel in one batch', async () => {
        const empty = library(0);
        expect(await fetchScenePool(empty.gql, filter, 100)).toEqual([]);
        expect(empty.gql).toHaveBeenCalledTimes(1);
        const small = library(3);
        expect(await fetchScenePool(small.gql, filter, 100)).toEqual(small.scenes);
        expect(small.gql).toHaveBeenCalledTimes(2);
    });

    it('passes the channel filter through untouched', async () => {
        const gql = jest.fn(async () => ({ findScenes: { count: 0, scenes: [] } }));
        await fetchScenePool(gql, filter, 50);
        expect(gql.mock.calls[0][1].filter).toBe(filter);
    });

    it('sorts by id ascending so the pool is stable between loads', async () => {
        const gql = jest.fn(async () => ({ findScenes: { count: 1, scenes: [{ id: '1' }] } }));
        await fetchScenePool(gql, filter, 50);

        const find = gql.mock.calls[1][1].find;
        expect(find.sort).toBe('id');
        expect(find.direction).toBe('ASC');
        expect(find.per_page).toBe(50);
    });

    it('requests the fields the schedule and guide need', () => {
        for (const field of ['duration', 'details', 'stream', 'screenshot', 'title']) {
            expect(SCENE_POOL_QUERY).toContain(field);
        }
    });

    it('requests related performer and tag identifiers for scene details', () => {
        expect(SCENE_POOL_QUERY).toContain('performers { id name image_path }');
        expect(SCENE_POOL_QUERY).toContain('tags { id name image_path }');
    });

    it('returns the scenes', async () => {
        const scenes = [{ id: '1' }];
        expect(await fetchScenePool(async () => ({ findScenes: { count: 1, scenes } }), filter, 10)).toEqual(scenes);
    });

    it('rejects malformed counts rather than silently scheduling nothing', async () => {
        await expect(fetchScenePool(async () => ({}), filter, 10)).rejects.toThrow('count');
        await expect(fetchScenePool(async () => ({ findScenes: {} }), filter, 10)).rejects.toThrow('count');
        await expect(fetchScenePool(async () => null, filter, 10)).rejects.toThrow('count');
    });
});

describe('sceneTitle', () => {
    it('uses the title when there is one', () => {
        expect(sceneTitle({ id: '4', title: 'Real Title' })).toBe('Real Title');
    });

    it('identifies untitled scenes by id rather than showing a blank', () => {
        expect(sceneTitle({ id: '4' })).toBe('Untitled scene 4');
        expect(sceneTitle({ id: '4', title: '' })).toBe('Untitled scene 4');
        expect(sceneTitle({ id: '4', title: '   ' })).toBe('Untitled scene 4');
    });
});
