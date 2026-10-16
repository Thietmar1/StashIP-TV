/**
 * Session-scoped cache for scene pools.
 *
 * Pools are the expensive part of opening the guide. Keyed by day and channel so
 * a cache entry cannot outlive the broadcast day it was fetched for.
 *
 * Storage is optional: private-mode browsers and quota exhaustion both throw,
 * and a cache that cannot store is only ever a performance loss.
 */

import { mergeSceneMetadata } from './sceneMetadata.js';

const PREFIX = 'tvguide:pool';
const METADATA_KEY = 'tvguide:scene-metadata:v1';

export function createPoolCache({ storage } = {}) {
    const store = storage === undefined ? safeSessionStorage() : storage;

    const keyFor = (channelId, dayKey) => `${PREFIX}:${channelId}:${dayKey}`;
    let metadata = {};
    try { metadata = JSON.parse(store?.getItem(METADATA_KEY) || '{}') || {}; } catch { /* optional */ }

    return {
        getMetadata() { return metadata; },

        updateMetadata(scenes) {
            let changed = false;
            for (const patch of scenes) {
                const previous = metadata[patch.id] || { id: patch.id };
                const next = mergeSceneMetadata(previous, patch);
                if (next !== previous) { metadata = { ...metadata, [patch.id]: next }; changed = true; }
            }
            if (changed) {
                try { store?.setItem(METADATA_KEY, JSON.stringify(metadata)); } catch { /* memory still works */ }
            }
        },

        get(channelId, dayKey) {
            if (!store) return null;
            try {
                const raw = store.getItem(keyFor(channelId, dayKey));
                return raw ? JSON.parse(raw).map((scene) => mergeSceneMetadata(scene, metadata[scene.id])) : null;
            } catch (e) {
                return null;
            }
        },

        set(channelId, dayKey, scenes) {
            if (!store) return;
            try {
                store.setItem(keyFor(channelId, dayKey), JSON.stringify(scenes));
            } catch (e) {
                // Over quota. Drop what we have and carry on uncached rather
                // than letting a storage limit break channel loading.
                this.clear();
            }
        },

        clear() {
            if (!store) return;
            try {
                const doomed = [];
                for (let i = 0; i < store.length; i++) {
                    const key = store.key(i);
                    if (key && key.startsWith(PREFIX)) doomed.push(key);
                }
                doomed.forEach((key) => store.removeItem(key));
            } catch (e) {
                /* nothing sensible left to do */
            }
        }
    };
}

function safeSessionStorage() {
    try {
        return globalThis.sessionStorage || null;
    } catch (e) {
        return null;
    }
}
