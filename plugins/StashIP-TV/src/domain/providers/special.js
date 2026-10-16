import { makeChannelId } from '../lineup.js';
import { resolveLogo } from '../logo.js';

const SPECIALS = [
    {
        id: 'all-scenes',
        name: 'All Scenes',
        filter: () => ({})
    },
    {
        id: 'new-releases',
        name: 'New releases',
        filter: (settings, now) => ({
            date: { value: dateDaysAgo(now, settings.guide_new_release_days), modifier: 'GREATER_THAN' }
        })
    },
    {
        id: 'recently-added',
        name: 'Recently added',
        filter: (settings, now) => ({
            created_at: { value: instantDaysAgo(now, settings.guide_recently_added_days), modifier: 'GREATER_THAN' }
        })
    },
    {
        id: 'movies',
        name: 'Movies',
        filter: (settings) => ({
            duration: { value: settings.guide_movie_min_minutes * 60, modifier: 'GREATER_THAN' }
        })
    },
    {
        id: 'shorts',
        name: 'Shorts',
        filter: (settings) => ({
            duration: { value: settings.guide_short_max_minutes * 60, modifier: 'LESS_THAN' }
        })
    }
];

const DEFAULT_SPECIAL_SETTINGS = {
    guide_new_release_days: 30,
    guide_recently_added_days: 14,
    guide_movie_min_minutes: 90,
    guide_short_max_minutes: 5
};

const allSpecials = (settings, now) => {
    const config = { ...DEFAULT_SPECIAL_SETTINGS, ...(settings && typeof settings === 'object' ? settings : {}) };
    return SPECIALS.map((special) => ({
    id: makeChannelId('special', special.id),
    source: 'special',
    name: special.name,
    logo: resolveLogo(null, special.name),
    sceneCount: null,
    sceneFilter: special.filter(config, now)
    }));
};

function dateDaysAgo(now, days) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
}

function instantDaysAgo(now, days) {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default {
    source: 'special',
    capabilities: { favorite: false, gender: false },

    async listChannels(entry, _gql, settings, now = new Date()) {
        const channels = allSpecials(settings, now);
        if (!Array.isArray(entry.ids) || entry.ids.length === 0) return channels;
        const selected = new Set(entry.ids);
        return channels.filter((channel) => selected.has(channel.id.slice('special:'.length)));
    },

    async listCatalogPage({ page = 1, perPage = 50, query = '' }, _gql, settings, now = new Date()) {
        const normalized = query.trim().toLowerCase();
        const filtered = normalized
            ? allSpecials(settings, now).filter((channel) => channel.name.toLowerCase().includes(normalized))
            : allSpecials(settings, now);
        const start = (page - 1) * perPage;
        return { channels: filtered.slice(start, start + perPage), total: filtered.length };
    }
};
