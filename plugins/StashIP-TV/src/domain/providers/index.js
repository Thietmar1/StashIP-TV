/**
 * The provider registry -- the extension point for channel sources.
 *
 * Adding a source means adding one module here. Everything downstream (the
 * scheduler, the grid, the viewer) works in terms of channels and scene
 * filters, so it needs no changes at all.
 */

import studio from './studio.js';
import tag from './tag.js';
import group from './group.js';
import performer from './performer.js';
import savedFilter from './savedFilter.js';
import special from './special.js';

export const PROVIDERS = {
    [studio.source]: studio,
    [tag.source]: tag,
    [group.source]: group,
    [performer.source]: performer,
    [savedFilter.source]: savedFilter,
    [special.source]: special
};

/**
 * Expand a lineup into channels.
 *
 * Entries are resolved concurrently but emitted in lineup order, so the guide's
 * channel order is the user's, not whichever query returned first.
 *
 * A source that fails is reported rather than thrown: one broken saved filter
 * should cost you that channel, not the whole guide.
 *
 * @returns {Promise<{channels: Array, errors: Array<{source, message}>}>}
 */
export async function resolveLineup(lineup, gql, settings, now) {
    const results = await Promise.all(
        lineup.map(async (entry) => {
            const provider = PROVIDERS[entry.source];
            if (!provider) return { channels: [], error: null };
            try {
                return { channels: await provider.listChannels(entry, gql, settings, now), error: null };
            } catch (e) {
                return { channels: [], error: { source: entry.source, message: e.message } };
            }
        })
    );

    const channels = [];
    const errors = [];
    const seen = new Set();

    for (const result of results) {
        if (result.error) errors.push(result.error);
        for (const channel of result.channels) {
            // Two lineup entries can legitimately select the same studio; the
            // first wins so the guide has no duplicate rows.
            if (seen.has(channel.id)) continue;
            seen.add(channel.id);
            channels.push(channel);
        }
    }

    return { channels, errors };
}

/**
 * Every channel each source could offer, ignoring lineup rules.
 *
 * This is what the channel manager browses -- you cannot pick a studio that
 * the current threshold has already filtered out, so the catalogue deliberately
 * asks for everything (`minScenes: 0`).
 *
 * Fetched once, lazily, when the manager first opens: on a large library this
 * is thousands of rows, and the guide itself never needs them.
 *
 * @returns {Promise<{catalog: Object<string, Array>, errors: Array}>}
 */
export async function fetchCatalog(gql, sources = Object.keys(PROVIDERS), settings, now) {
    const results = await Promise.all(
        sources.map(async (source) => {
            const provider = PROVIDERS[source];
            if (!provider) return { source, channels: [], error: null };
            try {
                return { source, channels: await provider.listChannels({ source }, gql, settings, now), error: null };
            } catch (e) {
                return { source, channels: [], error: { source, message: e.message } };
            }
        })
    );

    const catalog = {};
    const errors = [];
    for (const result of results) {
        catalog[result.source] = result.channels;
        if (result.error) errors.push(result.error);
    }

    return { catalog, errors };
}

export async function fetchCatalogPage(gql, source, request, settings, now) {
    const provider = PROVIDERS[source];
    if (!provider || typeof provider.listCatalogPage !== 'function') {
        return { channels: [], total: 0 };
    }
    return provider.listCatalogPage(request, gql, settings, now);
}
