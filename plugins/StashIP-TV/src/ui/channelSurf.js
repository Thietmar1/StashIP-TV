import { Events } from '../state/actions.js';

/** Surf the current guide order, including wrapping at either end. */
export function surfChannel(store, direction, { beforeTune, scrollIntoView = false } = {}) {
    const state = store.getState();
    const channels = state.channels;
    if (!channels.length) return;
    const index = channels.findIndex((channel) => channel.id === state.tunedChannelId);
    const next = index < 0
        ? (direction > 0 ? 0 : channels.length - 1)
        : (index + direction + channels.length) % channels.length;
    const channelId = channels[next].id;
    if (channelId === state.tunedChannelId) return;
    beforeTune?.();
    store.dispatch({ type: Events.TUNE, channelId, scrollIntoView, pinDetails: false });
    // Fullscreen rows are not observed, so tuning must request programming.
    store.dispatch({ type: Events.POOL_REQUESTED, channelId });
}
