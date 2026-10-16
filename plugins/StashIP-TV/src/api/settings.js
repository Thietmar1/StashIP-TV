/**
 * Plugin settings, read from the Stash server config.
 *
 * Stash returns whatever the user typed (or nothing at all), so every value is
 * coerced against a default here. Downstream code can then treat settings as
 * trustworthy numbers and booleans.
 */

// Keep the installed plugin identity so the StashIP-TV rename is an update:
// all existing TVGuide settings, tokens and lineups remain attached.
export const PLUGIN_ID = 'TVGuide';

// Stash sorts manifest keys alphabetically. Keep the ordering at the config
// boundary so the rest of the guide can continue using its stable setting names.
export const SETTING_KEYS = {
    guide_12_hour_clock: 'guide_01_12_hour_clock',
    guide_autoplay: 'guide_02_autoplay',
    guide_channel_info: 'guide_03_channel_info',
    guide_start_muted: 'guide_04_start_muted',
    guide_navbar_button: 'guide_05_navbar_button',
    guide_sfw_text: 'guide_06_sfw_text',
    guide_min_scenes: 'guide_07_min_scenes',
    guide_window_hours: 'guide_08_window_hours',
    guide_pool_cap: 'guide_09_pool_cap',
    guide_new_release_days: 'guide_10_new_release_days',
    guide_recently_added_days: 'guide_11_recently_added_days',
    guide_movie_min_minutes: 'guide_12_movie_min_minutes',
    guide_short_max_minutes: 'guide_13_short_max_minutes',
    guide_short_scene_minutes: 'guide_14_short_scene_minutes'
};

export const DEFAULT_SETTINGS = {
    guide_min_scenes: 5,
    guide_window_hours: 3,
    guide_12_hour_clock: true,
    guide_pool_cap: 100,
    guide_new_release_days: 30,
    guide_recently_added_days: 14,
    guide_movie_min_minutes: 90,
    guide_short_max_minutes: 5,
    guide_short_scene_minutes: 15,
    guide_autoplay: true,
    guide_start_muted: true,
    guide_navbar_button: true,
    guide_channel_info: true,
    guide_sfw_text: false
};

/** Bounds keep a mistyped setting from producing an unusable guide. */
const NUMBER_BOUNDS = {
    guide_min_scenes: { min: 0, max: 100000 },
    guide_window_hours: { min: 1, max: 12 },
    guide_pool_cap: { min: 1, max: 1000 },
    guide_new_release_days: { min: 0, max: 3650 },
    guide_recently_added_days: { min: 0, max: 3650 },
    guide_movie_min_minutes: { min: 1, max: 1440 },
    guide_short_max_minutes: { min: 1, max: 1440 },
    guide_short_scene_minutes: { min: 1, max: 30 }
};

const SETTINGS_QUERY = `query TVGuideConfiguration { configuration { plugins } }`;
const CONFIGURE_SETTINGS_MUTATION = `mutation MigrateTVGuideSettings($pluginId: ID!, $input: Map!) {
    configurePlugin(plugin_id: $pluginId, input: $input)
}`;
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function orderedConfiguration(configuration) {
    const migrated = { ...configuration };
    let changed = false;
    for (const [legacy, ordered] of Object.entries(SETTING_KEYS)) {
        if (!owns(configuration, legacy)) continue;
        // An explicit new value (including false, zero or null) takes priority.
        if (!owns(configuration, ordered)) migrated[ordered] = configuration[legacy];
        delete migrated[legacy];
        changed = true;
    }
    return changed ? migrated : configuration;
}

/** Move only existing values; leave unset defaults unset in Stash's native UI. */
export async function migratePluginSettings(gql, configuration) {
    if (orderedConfiguration(configuration) === configuration) return configuration;
    let latest = configuration;
    try {
        // configurePlugin replaces the whole map. Re-read before writing so
        // recent edits, unknown options and tvguide_state are carried forward.
        const data = await gql(SETTINGS_QUERY);
        if (!data?.configuration?.plugins || typeof data.configuration.plugins !== 'object') {
            throw new Error('Plugin configuration is unavailable');
        }
        const remote = data.configuration.plugins[PLUGIN_ID] ?? {};
        if (typeof remote !== 'object' || Array.isArray(remote)) throw new Error('Invalid plugin configuration');
        latest = remote;
        const migrated = orderedConfiguration(latest);
        if (migrated === latest) return latest;
        await gql(CONFIGURE_SETTINGS_MUTATION, { pluginId: PLUGIN_ID, input: migrated });
        return migrated;
    } catch (_) {
        // Legacy reads remain supported, so a failed migration cannot reset the
        // guide's preferences. The next page load will retry the migration.
        return latest;
    }
}

function coerce(key, raw) {
    const fallback = DEFAULT_SETTINGS[key];
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return fallback;

    if (typeof fallback === 'boolean') {
        return typeof raw === 'boolean' ? raw : fallback;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;

    const { min, max } = NUMBER_BOUNDS[key];
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Load the full configuration when startup also needs persisted guide state. */
export async function loadPluginConfiguration(gql) {
    try {
        const data = await gql(SETTINGS_QUERY);
        const configuration = data?.configuration?.plugins?.[PLUGIN_ID];
        return configuration && typeof configuration === 'object' ? configuration : {};
    } catch (e) {
        return {};
    }
}

/** Merge stored values over the defaults, one key at a time. */
export function normalizeSettings(stored) {
    const source = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const storedKey = owns(source, SETTING_KEYS[key]) ? SETTING_KEYS[key] : key;
        out[key] = owns(source, storedKey) ? coerce(key, source[storedKey]) : DEFAULT_SETTINGS[key];
    }
    return out;
}

/**
 * Load settings, falling back to defaults if the server cannot be reached --
 * a config hiccup should not stop the guide from opening.
 */
export async function loadSettings(gql) {
    return normalizeSettings(await loadPluginConfiguration(gql));
}
