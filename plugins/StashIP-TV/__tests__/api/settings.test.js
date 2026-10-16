import {
    DEFAULT_SETTINGS,
    PLUGIN_ID,
    normalizeSettings,
    loadSettings,
    loadPluginConfiguration,
    migratePluginSettings,
    SETTING_KEYS
} from '../../src/api/settings.js';
import { readFileSync } from 'node:fs';

describe('normalizeSettings', () => {
    it('returns the defaults for empty input', () => {
        expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    });

    it('takes stored values over the defaults', () => {
        const s = normalizeSettings({ guide_window_hours: 6, guide_autoplay: false });
        expect(s.guide_window_hours).toBe(6);
        expect(s.guide_autoplay).toBe(false);
        expect(s.guide_pool_cap).toBe(DEFAULT_SETTINGS.guide_pool_cap);
    });

    it('reads numbered settings first and treats an explicitly unset numbered value as unset', () => {
        expect(normalizeSettings({ guide_autoplay: true, guide_02_autoplay: false,
            guide_min_scenes: 5, guide_07_min_scenes: 0,
            guide_12_hour_clock: false, guide_01_12_hour_clock: null }))
            .toMatchObject({ guide_autoplay: false, guide_min_scenes: 0, guide_12_hour_clock: true });
    });

    it('uses defaults for unset values without overwriting explicit false or zero', () => {
        expect(normalizeSettings({ guide_pool_cap: null, guide_short_scene_minutes: '' }))
            .toMatchObject({ guide_pool_cap: 100, guide_short_scene_minutes: 15 });
        expect(normalizeSettings({ guide_min_scenes: 0, guide_start_muted: false }))
            .toMatchObject({ guide_min_scenes: 0, guide_start_muted: false });
        expect(normalizeSettings({})).toMatchObject({ guide_12_hour_clock: true,
            guide_autoplay: true, guide_channel_info: true, guide_start_muted: true });
    });

    it('normalizes special-channel windows and duration cutoffs', () => {
        expect(normalizeSettings({
            guide_new_release_days: '45',
            guide_recently_added_days: 10,
            guide_movie_min_minutes: 75,
            guide_short_max_minutes: 3
        })).toMatchObject({
            guide_new_release_days: 45,
            guide_recently_added_days: 10,
            guide_movie_min_minutes: 75,
            guide_short_max_minutes: 3
        });
    });

    it('uses ninety minutes for the default Movies cutoff', () => {
        expect(normalizeSettings({}).guide_movie_min_minutes).toBe(90);
    });

    it('coerces numeric strings, which is what Stash often stores', () => {
        expect(normalizeSettings({ guide_pool_cap: '250' }).guide_pool_cap).toBe(250);
    });

    it('clamps numbers into a usable range', () => {
        expect(normalizeSettings({ guide_window_hours: 99 }).guide_window_hours).toBe(12);
        expect(normalizeSettings({ guide_window_hours: 0 }).guide_window_hours).toBe(1);
        expect(normalizeSettings({ guide_pool_cap: -10 }).guide_pool_cap).toBe(1);
    });

    it('rounds fractional numbers', () => {
        expect(normalizeSettings({ guide_window_hours: 3.7 }).guide_window_hours).toBe(4);
    });

    it('falls back when a number cannot be parsed', () => {
        expect(normalizeSettings({ guide_pool_cap: 'lots' }).guide_pool_cap)
            .toBe(DEFAULT_SETTINGS.guide_pool_cap);
    });

    it('only accepts real booleans for boolean settings', () => {
        expect(normalizeSettings({ guide_autoplay: 'false' }).guide_autoplay).toBe(true);
        expect(normalizeSettings({ guide_autoplay: false }).guide_autoplay).toBe(false);
    });

    it('defaults to 12-hour time and preserves an explicit 24-hour preference', () => {
        expect(normalizeSettings({}).guide_12_hour_clock).toBe(true);
        expect(normalizeSettings({ guide_12_hour_clock: false }).guide_12_hour_clock).toBe(false);
        expect(normalizeSettings({ guide_12_hour_clock: 'true' }).guide_12_hour_clock).toBe(true);
    });

    it('ignores keys it does not know', () => {
        expect(normalizeSettings({ nonsense: 1 })).toEqual(DEFAULT_SETTINGS);
    });
});

describe('loadSettings', () => {
    it('reads this plugin\'s section of the server config', async () => {
        const gql = jest.fn(async () => ({
            configuration: { plugins: { [PLUGIN_ID]: { guide_window_hours: 2 } } }
        }));
        expect((await loadSettings(gql)).guide_window_hours).toBe(2);
    });

    it('falls back to defaults when the plugin has no stored settings', async () => {
        const gql = jest.fn(async () => ({ configuration: { plugins: {} } }));
        expect(await loadSettings(gql)).toEqual(DEFAULT_SETTINGS);
    });

    it('falls back to defaults when the query fails, so the guide still opens', async () => {
        const gql = jest.fn(async () => {
            throw new Error('offline');
        });
        expect(await loadSettings(gql)).toEqual(DEFAULT_SETTINGS);
    });

    it('falls back to defaults when the response shape is unexpected', async () => {
        expect(await loadSettings(async () => ({}))).toEqual(DEFAULT_SETTINGS);
    });
});

describe('loadPluginConfiguration', () => {
    it('returns the complete persisted plugin configuration', async () => {
        const config = { guide_window_hours: 2, tvguide_state: { tvguide_muted: 'false' } };
        const gql = jest.fn(async () => ({ configuration: { plugins: { [PLUGIN_ID]: config } } }));

        expect(await loadPluginConfiguration(gql)).toEqual(config);
    });
});

describe('ordered settings migration', () => {
    const response = (config) => ({ configuration: { plugins: { TVGuide: config } } });

    it('exposes management and scheduling settings while preserving legacy player migration keys', () => {
        const manifest = readFileSync('TVGuide.yml', 'utf8');
        const keys = [...manifest.matchAll(/^  (guide_\w+):$/gm)].map((match) => match[1]);
        const active = ['guide_navbar_button', 'guide_min_scenes', 'guide_pool_cap',
            'guide_new_release_days', 'guide_recently_added_days',
            'guide_movie_min_minutes', 'guide_short_max_minutes'];
        expect(keys).toEqual(active.map((key) => SETTING_KEYS[key]));
        expect(keys).toEqual([...keys].sort());
        expect(Object.keys(SETTING_KEYS).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
        expect(Object.keys(SETTING_KEYS).slice(0, 6).every((key) => typeof DEFAULT_SETTINGS[key] === 'boolean')).toBe(true);
        expect(Object.keys(SETTING_KEYS).slice(6).every((key) => typeof DEFAULT_SETTINGS[key] === 'number')).toBe(true);
    });

    it('migrates saved values without replacing them with defaults or dropping guide state', async () => {
        const config = { guide_autoplay: false, guide_min_scenes: 0, guide_pool_cap: 250,
            guide_sfw_text: true, future_option: 'keep', tvguide_state: { tvguide_lineup: '["saved"]' } };
        const expected = { guide_02_autoplay: false, guide_07_min_scenes: 0, guide_09_pool_cap: 250,
            guide_06_sfw_text: true, future_option: 'keep', tvguide_state: config.tvguide_state };
        const gql = jest.fn().mockResolvedValueOnce(response(config)).mockResolvedValueOnce({ configurePlugin: expected });
        expect(await migratePluginSettings(gql, config)).toEqual(expected);
        expect(gql).toHaveBeenLastCalledWith(expect.stringContaining('configurePlugin'), { pluginId: PLUGIN_ID, input: expected });
        expect(config.guide_autoplay).toBe(false);
        expect(config).not.toHaveProperty('guide_02_autoplay');
        expect(normalizeSettings(expected)).toEqual(normalizeSettings(config));
    });

    it('re-reads before saving and preserves newer numbered values and other preferences', async () => {
        const initial = { guide_autoplay: true, guide_pool_cap: 100 };
        const latest = { ...initial, guide_pool_cap: 300, guide_02_autoplay: false,
            guide_09_pool_cap: null, tvguide_state: { tvguide_muted: 'false' }, external: 'latest' };
        const gql = jest.fn().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce({});
        const result = await migratePluginSettings(gql, initial);
        expect(result).toEqual({ guide_02_autoplay: false, guide_09_pool_cap: null,
            tvguide_state: latest.tvguide_state, external: 'latest' });
        expect(normalizeSettings(result).guide_pool_cap).toBe(100);
    });

    it('does not write for fresh installs or after migration has completed', async () => {
        const gql = jest.fn();
        expect(await migratePluginSettings(gql, {})).toEqual({});
        const config = { guide_02_autoplay: false, tvguide_state: {} };
        expect(await migratePluginSettings(gql, config)).toBe(config);
        expect(gql).not.toHaveBeenCalled();
    });

    it('does not recreate a legacy value removed since the initial read', async () => {
        const gql = jest.fn().mockResolvedValue(response({}));
        expect(await migratePluginSettings(gql, { guide_autoplay: false })).toEqual({});
        expect(gql).toHaveBeenCalledTimes(1);
    });

    it.each(['read', 'write', 'malformed'])('keeps legacy values usable after a %s failure and retries later', async (failure) => {
        const initial = { guide_autoplay: false, guide_pool_cap: 300 };
        const gql = failure === 'read' ? jest.fn().mockRejectedValue(new Error('offline'))
            : failure === 'malformed' ? jest.fn().mockResolvedValue({})
                : jest.fn().mockResolvedValueOnce(response(initial)).mockRejectedValueOnce(new Error('offline'));
        const result = await migratePluginSettings(gql, initial);
        expect(result).toEqual(initial);
        expect(normalizeSettings(result)).toMatchObject({ guide_autoplay: false, guide_pool_cap: 300 });
        const retry = jest.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce({});
        expect(await migratePluginSettings(retry, result)).toEqual({ guide_02_autoplay: false, guide_09_pool_cap: 300 });
        expect(retry).toHaveBeenCalledTimes(2);
    });
});
