/**
 * Saved filters as channels.
 *
 * The odd one out: a saved filter is not an entity with scenes, it *is* a scene
 * query -- so any filter the user can build in the Stash UI becomes a channel.
 *
 * Its `object_filter` looks like a SceneFilterType but is actually the UI's own
 * criterion shape, so it goes through savedFilterToSceneFilter on the way in.
 *
 * Saved filters have no artwork, so these channels always wear a monogram.
 */

import { makeChannelId } from '../lineup.js';
import { resolveLogo } from '../logo.js';
import { savedFilterToSceneFilter } from '../savedFilterCriteria.js';

const QUERY = `query TVGuideSavedFilters {
  findSavedFilters(mode: SCENES) {
    id
    name
    object_filter
    find_filter { sort direction }
  }
}`;

export default {
    source: 'savedFilter',
    query: QUERY,
    capabilities: { favorite: false, gender: false },

    async listChannels(entry, gql) {
        const data = await gql(QUERY);
        const filters = data?.findSavedFilters || [];

        const wanted = Array.isArray(entry.names) && entry.names.length > 0
            ? new Set(entry.names)
            : null;

        return filters
            .filter((f) => !wanted || wanted.has(f.name))
            // A saved filter with no object_filter matches the entire library,
            // which would be a duplicate "everything" channel rather than a
            // useful one.
            .filter((f) => f.object_filter && Object.keys(f.object_filter).length > 0)
            .map((f) => ({
                id: makeChannelId('savedFilter', f.id),
                source: 'savedFilter',
                name: f.name,
                logo: resolveLogo(null, f.name),
                sceneCount: null, // not knowable without running the filter
                sceneFilter: savedFilterToSceneFilter(f.object_filter)
            }));
    },

    async listCatalogPage({ page = 1, perPage = 50, query = '' }, gql) {
        const channels = await this.listChannels({ source: 'savedFilter' }, gql);
        const normalized = query.trim().toLowerCase();
        const filtered = normalized
            ? channels.filter((channel) => channel.name.toLowerCase().includes(normalized))
            : channels;
        const start = (page - 1) * perPage;
        return { channels: filtered.slice(start, start + perPage), total: filtered.length };
    }
};
