// Presentation fields only: editing metadata must not move the schedule or
// replace the stream underneath a playing video.
const FIELDS = ['title', 'details', 'date', 'updated_at', 'studio', 'performers', 'tags'];

export function sceneMetadata(scene) {
    const patch = { id: String(scene.id) };
    for (const field of FIELDS) {
        if (Object.prototype.hasOwnProperty.call(scene, field)) patch[field] = scene[field];
    }
    if (scene.paths && Object.prototype.hasOwnProperty.call(scene.paths, 'screenshot')) {
        patch.paths = { screenshot: scene.paths.screenshot };
    }
    return patch;
}

export function mergeSceneMetadata(scene, patch) {
    if (!patch || (scene.updated_at && patch.updated_at && Date.parse(scene.updated_at) > Date.parse(patch.updated_at))) return scene;
    let next = scene;
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'id') continue;
        const merged = key === 'paths' ? { ...scene.paths, ...value } : value;
        if (JSON.stringify(scene[key]) === JSON.stringify(merged)) continue;
        if (next === scene) next = { ...scene };
        next[key] = merged;
    }
    return next;
}

/** Reuse successful Stash edit responses; no polling, refetching, or new socket. */
export function watchSceneMetadata({ onScenes, pluginApi = globalThis.PluginApi,
    BroadcastChannelClass = globalThis.BroadcastChannel } = {}) {
    const client = pluginApi?.utils?.StashService?.getClient?.();
    const ApolloLink = pluginApi?.libraries?.Apollo?.ApolloLink;
    if (!client?.link || !client.setLink || !ApolloLink) return () => {};
    let active = true;
    let channel;
    try { channel = BroadcastChannelClass && new BroadcastChannelClass('tvguide:scene-metadata'); } catch { /* optional */ }
    if (channel) channel.onmessage = ({ data }) => {
        if (active && Array.isArray(data)) onScenes(data.filter((scene) => scene?.id).map(sceneMetadata));
    };

    const original = client.link;
    const observer = new ApolloLink((operation, forward) => {
        const result = forward(operation);
        const mutation = operation.query.definitions.some((definition) => definition.operation === 'mutation');
        if (!mutation) return result;
        return result.map((response) => {
            if (!active || response.errors?.length) return response;
            const scenes = [];
            function visit(value) {
                if (!value || typeof value !== 'object') return;
                if (value.__typename === 'Scene' && value.id != null) {
                    const patch = sceneMetadata(value);
                    if (Object.keys(patch).length > 1) scenes.push(patch);
                    return;
                }
                for (const child of Object.values(value)) visit(child);
            }
            // Plugin failures must never turn a successful Stash edit into
            // an API error or prevent Apollo from receiving its response.
            try {
                visit(response.data);
                if (scenes.length) { onScenes(scenes); channel?.postMessage(scenes); }
            } catch { /* best effort */ }
            return response;
        });
    });
    const link = observer.concat(original);
    client.setLink(link);
    return () => {
        active = false;
        channel?.close();
        if (client.link === link) client.setLink(original);
    };
}
