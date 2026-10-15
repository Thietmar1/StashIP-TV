import { normalizeSettings } from '../src/api/settings.js';
import { fetchScenePool, fetchAllScenePool } from '../src/api/scenes.js';
import { parseLineup, KNOWN_SOURCES, SOURCE_LABELS } from '../src/domain/lineup.js';
import { parsePrefs, parsePinOrder, migratePinOrder, groupChannels, poolCapFor } from '../src/domain/channelPrefs.js';
import { resolveLineup } from '../src/domain/providers/index.js';
import special from '../src/domain/providers/special.js';
import { dayBucket, buildDaySchedule, programAt } from '../src/domain/schedule.js';
import { ALL_SCENES_CHANNEL_ID } from '../src/domain/allScenes.js';
import { endpoint } from './config.js';

export function nextMidnight(ms) {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** One immutable lineup/config per snapshot; failed refreshes remain retryable. */
export async function loadGuide(gql) {
    const data = await gql('query TVGuideIPTVConfiguration { configuration { plugins } }');
    if (!data.configuration?.plugins) throw new Error('Stash plugin configuration is unavailable');
    const config = data.configuration.plugins.TVGuide || {};
    const state = config.tvguide_state || {};
    const settings = normalizeSettings(config);
    const lineup = state.tvguide_lineup == null ? [
        { source: 'special', minScenes: 0, ids: ['new-releases', 'recently-added', 'movies', 'shorts'] },
        { source: 'studio', minScenes: settings.guide_min_scenes }
    ] : parseLineup(state.tvguide_lineup);
    const { channels, errors } = await resolveLineup(lineup, gql, settings);
    if (errors.length) throw new Error('Unable to resolve the complete TVGuide lineup');
    const prefs = parsePrefs(state.tvguide_channel_prefs);
    let legacy = {};
    try { legacy = JSON.parse(state.tvguide_channel_prefs || '{}'); } catch { /* handled by parsePrefs */ }
    const pinOrder = state.tvguide_pin_order == null ? migratePinOrder(legacy) : parsePinOrder(state.tvguide_pin_order);
    const ordered = groupChannels(channels, { prefs, pinOrder, sourceOrder: KNOWN_SOURCES }).flatMap((g) => g.channels);
    const plans = new Map();
    let allScenes;

    async function getPlan(channel, ms) {
        const day = dayBucket(ms);
        const key = `${channel.id}|${day.key}`;
        if (!plans.has(key)) {
            const pending = (async () => {
                let scenes;
                if (channel.id === ALL_SCENES_CHANNEL_ID) {
                    // Share the full-library index across all exported days.
                    allScenes ||= fetchAllScenePool(gql).catch((error) => { allScenes = null; throw error; });
                    scenes = await allScenes;
                } else {
                    let filter = channel.sceneFilter;
                    if (channel.source === 'special') {
                        const [daily] = await special.listChannels({ ids: [channel.id.slice(8)] }, gql, settings, new Date(day.startMs));
                        filter = daily.sceneFilter;
                    }
                    scenes = await fetchScenePool(gql, filter, poolCapFor(prefs, channel.id, settings.guide_pool_cap), day.key, channel.id);
                }
                return buildDaySchedule(channel.id, scenes, day.key);
            })();
            plans.set(key, pending);
            pending.catch(() => plans.delete(key));
            // A long-lived stream must not retain an unlimited history of days.
            // Keep the full seven-day export horizon, so a future-day EPG load
            // cannot evict today's live pool from the same snapshot.
            for (const old of plans.keys()) if (old !== key && old.slice(old.lastIndexOf('|') + 1) < dayBucket(ms - 8 * 86400000).key) plans.delete(old);
        }
        return plans.get(key);
    }

    return {
        channels: ordered,
        getPlan,
        async program(channel, ms) {
            const day = dayBucket(ms);
            const current = programAt(await getPlan(channel, ms), ms, day.startMs);
            if (!current) return null;
            // Daily channels restart at midnight, even in the middle of a scene.
            const endMs = channel.id === ALL_SCENES_CHANNEL_ID ? current.endMs : Math.min(current.endMs, nextMidnight(ms));
            return { ...current, endMs };
        }
    };
}

/** XML 1.0 cannot contain control characters, even inside an escaped string. */
export function xml(value) {
    return String(value ?? '').replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
        .replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

export function xmlTime(ms) {
    return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
}

function m3uText(value) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f"<>]/g, ' ');
}

function logoUrl(channel, config) {
    if (channel.logo?.type !== 'image') return null;
    // Proxy Stash artwork so the Stash API key never appears in the exports.
    try {
        const url = new URL(channel.logo.url, `${config.stashUrl}/`);
        if (url.origin === new URL(config.stashUrl).origin) return endpoint(config, `/logo/${encodeURIComponent(channel.id)}`);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

export function renderM3u(channels, config) {
    const lines = [`#EXTM3U x-tvg-url="${endpoint(config, '/epg.xml')}"`];
    for (const channel of channels) {
        const logo = logoUrl(channel, config);
        lines.push(`#EXTINF:-1 tvg-id="${m3uText(channel.id)}" tvg-name="${m3uText(channel.name)}"${logo ? ` tvg-logo="${m3uText(logo)}"` : ''} group-title="${m3uText(SOURCE_LABELS[channel.source] || 'TVGuide')}",${m3uText(channel.name)}`);
        lines.push(endpoint(config, `/stream/${encodeURIComponent(channel.id)}.ts`));
    }
    return lines.join('\n') + '\n';
}

/** Walk without the browser grid's 500-programme cap. Never silently truncate. */
export async function renderXmltv(guide, channels, config, fromMs, toMs) {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Stash TVGuide">'];
    for (const channel of channels) {
        const logo = logoUrl(channel, config);
        lines.push(`<channel id="${xml(channel.id)}"><display-name>${xml(channel.name)}</display-name>${logo ? `<icon src="${xml(logo)}"/>` : ''}</channel>`);
    }
    for (const channel of channels) {
        let cursor = fromMs;
        let count = 0;
        while (cursor < toMs) {
            if (++count > 100000) throw new Error('Too many programmes for XMLTV; reduce TVGUIDE_EPG_DAYS');
            const program = await guide.program(channel, cursor);
            if (!program) { cursor = nextMidnight(cursor); continue; }
            const { scene, startMs, endMs } = program;
            const start = Math.max(startMs, dayBucket(cursor).startMs, fromMs);
            const end = Math.min(endMs, toMs);
            if (endMs <= cursor) throw new Error('Invalid programme boundary');
            if (Math.floor(end / 1000) > Math.floor(start / 1000)) {
                const title = scene.title?.trim() || `Untitled scene ${scene.id}`;
                lines.push(`<programme channel="${xml(channel.id)}" start="${xmlTime(start)}" stop="${xmlTime(end)}"><title>${xml(title)}</title>${scene.details ? `<desc>${xml(scene.details)}</desc>` : ''}</programme>`);
            }
            cursor = endMs;
        }
    }
    lines.push('</tv>');
    return lines.join('\n') + '\n';
}

export async function playableChannels(guide, nowMs) {
    const out = [];
    // Bound upstream concurrency, including for large lineups.
    for (let i = 0; i < guide.channels.length; i += 4) {
        const batch = guide.channels.slice(i, i + 4);
        const plans = await Promise.all(batch.map((channel) => guide.getPlan(channel, nowMs)));
        batch.forEach((channel, index) => { if (plans[index].totalMs > 0) out.push(channel); });
    }
    return out;
}
