import { fetchSceneDetails } from '../api/scenes.js';
import { ALL_SCENES_CHANNEL_ID } from '../domain/allScenes.js';
import { Events } from './actions.js';
import { tunedProgram, liveProgram, nextProgram, focusedProgram, rowBlocks } from './selectors.js';

/** Hydrate the visible guide window, prioritizing playback and selected details. */
export function createLazySceneDetails({ store, gql, now = () => Date.now() }) {
    const pending = new Set();
    const retryAfter = new Map();
    let stopped = false;

    function update() {
        const state = store.getState();
        if (stopped || !state.open) return;
        const wanted = [];
        if (state.tunedChannelId === ALL_SCENES_CHANNEL_ID) {
            wanted.push(tunedProgram(state));
        }
        if (state.focus?.channelId === ALL_SCENES_CHANNEL_ID) wanted.push(focusedProgram(state));
        if (state.tunedChannelId === ALL_SCENES_CHANNEL_ID) wanted.push(nextProgram(state, ALL_SCENES_CHANNEL_ID));
        if (state.playerMode !== 'fullscreen' && state.channels.some((channel) => channel.id === ALL_SCENES_CHANNEL_ID)) {
            if (state.layout === 'grid') {
                wanted.push(...rowBlocks(state, ALL_SCENES_CHANNEL_ID).map((block) => block.program));
            } else {
                // The compact list displays only now and next.
                wanted.push(liveProgram(state, ALL_SCENES_CHANNEL_ID), nextProgram(state, ALL_SCENES_CHANNEL_ID));
            }
        }
        for (const program of wanted) {
            if (pending.size >= 2) break;
            const scene = program?.scene;
            if (!scene?._summary || pending.has(scene.id) || (retryAfter.get(scene.id) || 0) > now()) continue;
            pending.add(scene.id);
            fetchSceneDetails(gql, scene.id).then(
                (details) => {
                    if (!stopped) store.dispatch({ type: Events.SCENE_DETAILS_LOADED, scene: details });
                },
                () => {
                    retryAfter.set(scene.id, now() + 30000);
                    if (!stopped) store.dispatch({ type: Events.SCENE_DETAILS_FAILED, sceneId: scene.id });
                }
            ).finally(() => {
                pending.delete(scene.id);
                update();
            });
        }
    }

    const unsubscribe = store.subscribe(update);
    update();
    return () => { stopped = true; unsubscribe(); };
}
