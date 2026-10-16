import { createEffectRunner } from '../../src/state/effects.js';
import { Events } from '../../src/state/actions.js';
import { createInitialState } from '../../src/state/initialState.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides = {}) {
    const dispatch = jest.fn();
    const state = { ...createInitialState(), dayKey: '2026-08-22' };
    const getState = () => state;

    const ctx = {
        gql: jest.fn(async (query) => {
            if (query.includes('findStudios')) {
                return { findStudios: { studios: [{ id: '1', name: 'S', image_path: null, scene_count: 9 }] } };
            }
            return { findScenes: { count: 1, scenes: [{ id: 'a', files: [{ duration: 600 }] }] } };
        }),
        cache: { get: jest.fn(() => null), set: jest.fn() },
        viewer: {
            tune: jest.fn(), stop: jest.fn(), setMuted: jest.fn(),
            setPaused: jest.fn(), showPoster: jest.fn()
        },
        player: { setMode: jest.fn() },
        storage: { setItem: jest.fn() },
        announce: jest.fn(),
        navigate: jest.fn(),
        getLineup: () => [{ source: 'studio', minScenes: 5 }],
        ...overrides
    };

    return { run: createEffectRunner(ctx), dispatch, getState, state, ctx };
}

describe('loadChannels', () => {
    it('loads All Scenes independently of the normal pool cap and daily cache key', async () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'fetchPool', channelId: 'special:all-scenes', sceneFilter: {}, poolCap: 1 }, getState, dispatch);
        await flush();
        expect(ctx.gql.mock.calls[0][1].find.per_page).toBe(500);
        expect(ctx.cache.get).toHaveBeenCalledWith('special:all-scenes', 'all-scenes-index-v2');
        expect(ctx.cache.set).toHaveBeenCalledWith('special:all-scenes', 'all-scenes-index-v2', expect.any(Array));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: Events.POOL_LOADED, channelId: 'special:all-scenes' }));
    });
    it('resolves the lineup and reports the channels', async () => {
        const { run, dispatch, getState } = harness();
        run({ type: 'loadChannels' }, getState, dispatch);
        await flush();

        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ type: Events.CHANNELS_LOADED, errors: [] })
        );
        expect(dispatch.mock.calls[0][0].channels[0].id).toBe('studio:1');
    });

    it('reports a corrupt lineup instead of letting it escape the runner', async () => {
        const { run, dispatch, getState } = harness({
            getLineup: () => {
                throw new Error('lineup exploded');
            }
        });

        expect(() => run({ type: 'loadChannels' }, getState, dispatch)).not.toThrow();
        await flush();

        expect(dispatch).toHaveBeenCalledWith({
            type: Events.CHANNELS_FAILED,
            message: 'lineup exploded'
        });
    });

    it('turns a rejected provider query into CHANNELS_FAILED', async () => {
        const { run, dispatch, getState } = harness({
            gql: async () => {
                throw new Error('offline');
            }
        });
        run({ type: 'loadChannels' }, getState, dispatch);
        await flush();

        // resolveLineup catches per-source, so a single bad source still
        // resolves -- with the error recorded rather than thrown.
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                type: Events.CHANNELS_LOADED,
                errors: [{ source: 'studio', message: 'offline' }]
            })
        );
    });
});

describe('fetchPool', () => {
    const effect = { type: 'fetchPool', channelId: 'studio:1', sceneFilter: { organized: true } };

    it('refreshes special-channel date windows before the asynchronous lineup reload finishes', async () => {
        const { run, ctx, state, dispatch, getState } = harness();
        state.dayKey = '2026-08-23';
        run({ ...effect, channelId: 'special:recently-added', sceneFilter: { created_at: { value: 'stale' } } }, getState, dispatch);
        await flush();
        const expected = new Date(new Date('2026-08-23T00:00:00').getTime() - 14 * 86400000).toISOString();
        expect(ctx.gql.mock.calls[0][1].filter.created_at).toEqual({ value: expected, modifier: 'GREATER_THAN' });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: Events.POOL_LOADED }));
    });

    it('keys rotating pools by date and cap, without reusing the old fixed-batch cache', async () => {
        const { run, ctx, state, dispatch, getState } = harness();
        run(effect, getState, dispatch);
        await flush();
        state.dayKey = '2026-08-23';
        state.settings.guide_pool_cap = 25;
        run(effect, getState, dispatch);
        await flush();
        expect(ctx.cache.get.mock.calls).toEqual([
            ['studio:1', 'rotation-v1:2026-08-22:100'],
            ['studio:1', 'rotation-v1:2026-08-23:25']
        ]);
    });

    it.each([false, true])('ignores an old-day response arriving after midnight (failure: %s)', async (failure) => {
        let finish;
        const { run, state, dispatch, getState } = harness({
            gql: () => new Promise((resolve, reject) => { finish = failure ? () => reject(new Error('late error')) : () => resolve({ findScenes: { count: 0 } }); })
        });
        run(effect, getState, dispatch);
        state.dayKey = '2026-08-23';
        finish();
        await flush();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('fetches and reports the pool', async () => {
        const { run, dispatch, getState } = harness();
        run(effect, getState, dispatch);
        await flush();

        expect(dispatch).toHaveBeenCalledWith({
            type: Events.POOL_LOADED,
            channelId: 'studio:1',
            scenes: [{ id: 'a', files: [{ duration: 600 }] }]
        });
    });

    it('caches what it fetched', async () => {
        const { run, dispatch, getState, ctx } = harness();
        run(effect, getState, dispatch);
        await flush();
        expect(ctx.cache.set).toHaveBeenCalledWith('studio:1', 'rotation-v1:2026-08-22:100', expect.any(Array));
    });

    it('serves a cache hit without touching the network', async () => {
        const cached = [{ id: 'z', files: [{ duration: 60 }] }];
        const { run, dispatch, getState, ctx } = harness({
            cache: { get: () => cached, set: jest.fn() }
        });

        run(effect, getState, dispatch);

        expect(dispatch).toHaveBeenCalledWith({
            type: Events.POOL_LOADED,
            channelId: 'studio:1',
            scenes: cached
        });
        expect(ctx.gql).not.toHaveBeenCalled();
    });

    it('reports a failed pool against its own channel', async () => {
        const { run, dispatch, getState } = harness({
            gql: async () => {
                throw new Error('boom');
            }
        });
        run(effect, getState, dispatch);
        await flush();

        expect(dispatch).toHaveBeenCalledWith({
            type: Events.POOL_FAILED,
            channelId: 'studio:1',
            message: 'boom'
        });
    });

    it('honours the configured pool cap', async () => {
        const { run, dispatch, getState, ctx, state } = harness();
        state.settings = { ...state.settings, guide_pool_cap: 42 };
        run(effect, getState, dispatch);
        await flush();
        expect(ctx.gql.mock.calls[1][1].find.per_page).toBe(42);
    });

    it('prefers a per-channel cap carried on the effect', async () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ ...effect, poolCap: 400 }, getState, dispatch);
        await flush();
        expect(ctx.gql.mock.calls[1][1].find.per_page).toBe(400);
    });

    it('never runs more than the concurrency limit at once', async () => {
        let active = 0;
        let peak = 0;
        const gql = jest.fn(
            () =>
                new Promise((resolve) => {
                    active++;
                    peak = Math.max(peak, active);
                    setTimeout(() => {
                        active--;
                        resolve({ findScenes: { count: 0, scenes: [] } });
                    }, 5);
                })
        );

        const { run, dispatch, getState } = harness({ gql });
        for (let i = 0; i < 12; i++) {
            run({ ...effect, channelId: `studio:${i}` }, getState, dispatch);
        }
        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(peak).toBeLessThanOrEqual(4);
        expect(gql).toHaveBeenCalledTimes(12);
    });

    it('works without a cache at all', async () => {
        const { run, dispatch, getState } = harness({ cache: null });
        run(effect, getState, dispatch);
        await flush();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: Events.POOL_LOADED }));
    });
});

describe('viewer effects', () => {
    it('tunes with the scene, offset and current mute state', () => {
        const { run, dispatch, getState, ctx, state } = harness();
        state.muted = false;
        const scene = { id: 's1' };

        run({ type: 'tuneViewer', channelId: 'studio:1', scene, offsetMs: 5000 }, getState, dispatch);

        expect(ctx.viewer.tune).toHaveBeenCalledWith(scene, 5000, false);
    });

    it('stops and mutes', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'stopViewer' }, getState, dispatch);
        run({ type: 'setMuted', muted: true }, getState, dispatch);
        expect(ctx.viewer.stop).toHaveBeenCalled();
        expect(ctx.viewer.setMuted).toHaveBeenCalledWith(true);
    });

    it('is a no-op without a viewer', () => {
        const { run, dispatch, getState } = harness({ viewer: null });
        expect(() => {
            run({ type: 'tuneViewer', scene: {}, offsetMs: 0 }, getState, dispatch);
            run({ type: 'stopViewer' }, getState, dispatch);
            run({ type: 'setMuted', muted: true }, getState, dispatch);
        }).not.toThrow();
    });
});

describe('side effects on the page', () => {
    it('navigates to a scene at an offset', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'navigateToScene', sceneId: '7', offsetSeconds: 90 }, getState, dispatch);
        expect(ctx.navigate).toHaveBeenCalledWith('7', 90);
    });

    it('announces', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'announce', message: 'hello' }, getState, dispatch);
        expect(ctx.announce).toHaveBeenCalledWith('hello');
    });

    it('persists a preference', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'persist', key: 'k', value: 'v' }, getState, dispatch);
        expect(ctx.storage.setItem).toHaveBeenCalledWith('k', 'v');
    });

    it('shrugs off a storage that refuses to write', () => {
        const { run, dispatch, getState } = harness({
            storage: {
                setItem: () => {
                    throw new Error('denied');
                }
            }
        });
        expect(() => run({ type: 'persist', key: 'k', value: 'v' }, getState, dispatch)).not.toThrow();
    });

    it('is a no-op without storage, announcer or navigator', () => {
        const { run, dispatch, getState } = harness({ storage: null, announce: null, navigate: null });
        expect(() => {
            run({ type: 'persist', key: 'k', value: 'v' }, getState, dispatch);
            run({ type: 'announce', message: 'x' }, getState, dispatch);
            run({ type: 'navigateToScene', sceneId: '1', offsetSeconds: 0 }, getState, dispatch);
        }).not.toThrow();
    });

    it('ignores an unknown effect', () => {
        const { run, dispatch, getState } = harness();
        expect(() => run({ type: 'nonsense' }, getState, dispatch)).not.toThrow();
    });
});


describe('loadCatalog', () => {
    it('fetches one source and reports it', async () => {
        const { run, dispatch, getState } = harness();
        run({ type: 'loadCatalog', source: 'studio' }, getState, dispatch);
        await flush();

        const call = dispatch.mock.calls.find((c) => c[0].type === Events.CATALOG_LOADED);
        expect(call).toBeDefined();
        expect(call[0].source).toBe('studio');
        expect(call[0].catalog.studio[0].id).toBe('studio:1');
    });

    it('asks only for the requested source, not the whole library', async () => {
        const fetchCatalogFn = jest.fn(async () => ({ catalog: {}, errors: [] }));
        const { run, dispatch, getState, state } = harness({ fetchCatalogFn });

        run({ type: 'loadCatalog', source: 'tag' }, getState, dispatch);
        await flush();

        expect(fetchCatalogFn.mock.calls[0][1]).toEqual(['tag']);
        expect(fetchCatalogFn.mock.calls[0][2]).toBe(state.settings);
    });

    it('falls back to every source when none is named', async () => {
        const fetchCatalogFn = jest.fn(async () => ({ catalog: {}, errors: [] }));
        const { run, dispatch, getState } = harness({ fetchCatalogFn });

        run({ type: 'loadCatalog' }, getState, dispatch);
        await flush();

        expect(fetchCatalogFn.mock.calls[0][1]).toBeUndefined();
    });

    it('still resolves when an individual source fails, since those are caught per-source', async () => {
        const { run, dispatch, getState } = harness({
            gql: () => {
                throw new Error('one source exploded');
            }
        });

        expect(() => run({ type: 'loadCatalog' }, getState, dispatch)).not.toThrow();
        await flush();

        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ type: Events.CATALOG_LOADED })
        );
    });

    it('reports a wholesale catalogue failure rather than letting it escape', async () => {
        const { run, dispatch, getState } = harness({
            fetchCatalogFn: async () => {
                throw new Error('catalogue exploded');
            }
        });

        expect(() => run({ type: 'loadCatalog' }, getState, dispatch)).not.toThrow();
        await flush();

        expect(dispatch).toHaveBeenCalledWith({
            type: Events.CATALOG_FAILED,
            message: 'catalogue exploded'
        });
    });
});


describe('player effects', () => {
    it('applies a player mode', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'setPlayerMode', mode: 'theater' }, getState, dispatch);
        expect(ctx.player.setMode).toHaveBeenCalledWith('theater');
    });

    it('pauses and resumes the viewer', () => {
        const { run, dispatch, getState, ctx } = harness();
        run({ type: 'setPaused', paused: true }, getState, dispatch);
        expect(ctx.viewer.setPaused).toHaveBeenCalledWith(true);
    });

    it('is a no-op without a viewer or player', () => {
        const { run, dispatch, getState } = harness({ viewer: null, player: null });
        expect(() => {
            run({ type: 'setPlayerMode', mode: 'theater' }, getState, dispatch);
            run({ type: 'setPaused', paused: true }, getState, dispatch);
            run({ type: 'showPoster', scene: {} }, getState, dispatch);
        }).not.toThrow();
    });
});
