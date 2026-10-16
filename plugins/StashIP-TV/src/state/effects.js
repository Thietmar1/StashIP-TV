/**
 * The effect runner: the only place in the state layer that touches the world.
 *
 * Everything it needs is injected, so the whole surface can be driven from
 * tests with plain objects -- no jsdom video element, no network.
 */

import { Events } from './actions.js';
import { resolveLineup, fetchCatalog, fetchCatalogPage } from '../domain/providers/index.js';
import { fetchScenePool, fetchAllScenePool } from '../api/scenes.js';
import { ALL_SCENES_CHANNEL_ID } from '../domain/allScenes.js';
import specialProvider from '../domain/providers/special.js';

/** Concurrent pool fetches. Enough to fill a screen, few enough not to
 *  stampede the server when someone scrolls fast through a long lineup. */
export const MAX_CONCURRENT_POOL_FETCHES = 4;

export function createEffectRunner({
    gql,
    cache,
    viewer,
    player,
    storage,
    announce,
    navigate,
    getLineup,
    // Injected like every other dependency here, so the failure path is
    // reachable from a test rather than being untestable defensive code.
    fetchCatalogFn = fetchCatalog,
    fetchCatalogPageFn = fetchCatalogPage,
    maxConcurrent = MAX_CONCURRENT_POOL_FETCHES
}) {
    let inFlight = 0;
    const waiting = [];

    function pump() {
        while (inFlight < maxConcurrent && waiting.length > 0) {
            const job = waiting.shift();
            inFlight++;
            job().finally(() => {
                inFlight--;
                pump();
            });
        }
    }

    function schedule(job) {
        waiting.push(job);
        pump();
    }

    return function runEffect(effect, getState, dispatch) {
        switch (effect.type) {
            case 'loadChannels':
                // Promise.resolve().then so a synchronous throw (a corrupt
                // lineup, say) becomes a reported failure rather than an
                // exception escaping the effect drain loop.
                Promise.resolve()
                    .then(() => resolveLineup(getLineup(), gql, getState().settings))
                    .then(
                        ({ channels, errors }) =>
                            dispatch({ type: Events.CHANNELS_LOADED, channels, errors }),
                        (error) => dispatch({ type: Events.CHANNELS_FAILED, message: error.message })
                    );
                return;

            case 'fetchPool': {
                const { dayKey, settings } = getState();
                const poolCap = effect.poolCap || settings.guide_pool_cap;
                const allScenes = effect.channelId === ALL_SCENES_CHANNEL_ID;
                const cacheKey = allScenes ? 'all-scenes-index-v2' : `rotation-v1:${dayKey}:${poolCap}`;

                const cached = cache && cache.get(effect.channelId, cacheKey);
                if (cached) {
                    dispatch({ type: Events.POOL_LOADED, channelId: effect.channelId, scenes: cached });
                    return;
                }

                schedule(async () => {
                    if (!allScenes && getState().dayKey !== dayKey) return;
                    try {
                        let sceneFilter = effect.sceneFilter;
                        if (!allScenes && effect.channelId.startsWith('special:')) {
                            // Recompute date windows at broadcast midnight. The
                            // lineup reload may still carry yesterday's filters.
                            const [channel] = await specialProvider.listChannels(
                                { ids: [effect.channelId.slice('special:'.length)] }, gql, settings,
                                new Date(`${dayKey}T00:00:00`)
                            );
                            sceneFilter = channel?.sceneFilter || sceneFilter;
                        }
                        const scenes = allScenes ? await fetchAllScenePool(gql)
                            : await fetchScenePool(gql, sceneFilter, poolCap, dayKey, effect.channelId);
                        if (cache) cache.set(effect.channelId, cacheKey, scenes);
                        if (allScenes || getState().dayKey === dayKey) {
                            dispatch({ type: Events.POOL_LOADED, channelId: effect.channelId, scenes });
                        }
                    } catch (error) {
                        if (allScenes || getState().dayKey === dayKey) dispatch({
                            type: Events.POOL_FAILED,
                            channelId: effect.channelId,
                            message: error.message
                        });
                    }
                });
                return;
            }

            case 'loadCatalog':
                // Fetched one source at a time: the full catalogue is many
                // thousands of rows across studios, models and tags, and you
                // only ever browse one type at once.
                Promise.resolve()
                    .then(() => fetchCatalogFn(gql, effect.source ? [effect.source] : undefined, getState().settings))
                    .then(
                        ({ catalog }) =>
                            dispatch({ type: Events.CATALOG_LOADED, source: effect.source, catalog }),
                        (error) =>
                            dispatch({
                                type: Events.CATALOG_FAILED,
                                source: effect.source,
                                message: error.message
                            })
                    );
                return;

            case 'loadCatalogPage':
                Promise.resolve()
                    .then(() => fetchCatalogPageFn(gql, effect.source, effect, getState().settings))
                    .then(
                        ({ channels, total }) => dispatch({
                            type: Events.CATALOG_PAGE_LOADED,
                            source: effect.source,
                            requestKey: effect.requestKey,
                            page: effect.page,
                            channels,
                            total
                        }),
                        (error) => dispatch({
                            type: Events.CATALOG_PAGE_FAILED,
                            source: effect.source,
                            requestKey: effect.requestKey,
                            page: effect.page,
                            message: error.message
                        })
                    );
                return;

            case 'setPlayerMode':
                if (player) player.setMode(effect.mode);
                return;

            case 'setPaused':
                if (viewer) viewer.setPaused(effect.paused);
                return;

            case 'tuneViewer':
                if (viewer) viewer.tune(effect.scene, effect.offsetMs, getState().muted);
                return;

            case 'prepareViewer':
                if (viewer) viewer.prepare?.();
                return;

            case 'playbackError':
                if (viewer) viewer.reportError?.(effect.message);
                return;

            case 'stopViewer':
                if (viewer) viewer.stop();
                return;

            case 'setMuted':
                if (viewer) viewer.setMuted(effect.muted);
                return;

            case 'navigateToScene':
                if (navigate) navigate(effect.sceneId, effect.offsetSeconds);
                return;

            case 'persist':
                if (!storage) return;
                try {
                    storage.setItem(effect.key, effect.value);
                } catch (e) {
                    // Preferences are a nicety; a full or blocked store is not
                    // a reason to interrupt viewing.
                }
                return;

            case 'announce':
                if (announce) announce(effect.message);
                return;

            default:
                return;
        }
    };
}
