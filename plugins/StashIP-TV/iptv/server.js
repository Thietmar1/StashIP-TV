import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createStashClient, stashMediaUrl, stashHeaders, endpoint, StashRequestError } from './config.js';
import { loadGuide, renderM3u, renderXmltv, playableChannels, nextMidnight, numberChannels } from './guide.js';
import { dayBucket } from '../src/domain/schedule.js';
import { streamChannel } from './stream.js';
import { adapterSceneId, createStashyAdapter } from './stashy.js';
import { createHlsService } from './hls.js';
import { tunerClientAllowed } from './tunerAccess.js';
import { tunerDiscovery, tunerDeviceXml, tunerLineup, tunerLineupXml } from './tuner.js';

function authorized(request, url, token, adapter = false) {
    const supplied = (adapter && (request.headers.apikey || url.searchParams.get('apikey'))) ||
        request.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createIptvServer(config, { gql = createStashClient(config), load = loadGuide, stream = streamChannel, fetchFn = fetch, now = Date.now, log = console.error, adapterBootstrap, hlsFactory = createHlsService } = {}) {
    let snapshot;
    let expires = 0;
    let active = 0;
    let epg;
    const prefix = new URL(config.publicUrl).pathname.replace(/\/$/, '');
    const getGuide = async () => {
        if (!snapshot || now() >= expires) {
            expires = Math.min(now() + 300000, nextMidnight(now()));
            const pending = load(gql).then((guide) => ({
                ...guide, channels: numberChannels(guide.channels, config.firstChannelNumber ?? 12)
            }));
            snapshot = pending;
            epg = null;
            pending.catch(() => { if (snapshot === pending) snapshot = null; });
        }
        return snapshot;
    };
    const stashy = createStashyAdapter(config, { gql, getGuide, now, bootstrap: adapterBootstrap });
    const hls = hlsFactory(config, {
        acquire: () => { if (active >= config.maxStreams) return false; active++; return true; },
        release: () => { active--; }, log,
        produce: (channelId, response) => stream({ response, config, channelId, getGuide, gql, now })
    });

    const server = createServer(async (request, response) => {
        const reply = (status, text, type = 'text/plain; charset=utf-8') => {
            if (response.destroyed) return;
            response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            response.end(request.method === 'HEAD' ? undefined : text);
        };
        try {
            const url = new URL(request.url, 'http://tvguide.invalid');
            // Separate private control credential: the Jellyfin token cannot
            // stop the daemon. No process is ever killed by a stale PID file.
            if (config.controlToken && ['/control/status', '/control/stop'].includes(url.pathname)) {
                const supplied = Buffer.from(request.headers['x-tvguide-control'] || '');
                const expected = Buffer.from(config.controlToken);
                if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, 'Unauthorized\n');
                if (url.pathname.endsWith('/status') && request.method === 'GET') return reply(200, JSON.stringify({
                    instanceId: config.instanceId, pid: process.pid,
                    playlist: endpoint(config, '/playlist.m3u'), epg: endpoint(config, '/epg.xml')
                }), 'application/json');
                if (url.pathname.endsWith('/stop') && request.method === 'POST') {
                    reply(200, JSON.stringify({ instanceId: config.instanceId }), 'application/json');
                    setImmediate(() => { server.close(); server.closeAllConnections(); });
                    return;
                }
                return reply(405, 'Method not allowed\n');
            }
            if (prefix && !url.pathname.startsWith(`${prefix}/`)) return reply(404, 'Not found\n');
            let path = url.pathname.slice(prefix.length);
            let tunerAccess = false;
            if (['/discover.json', '/device.xml', '/lineup_status.json', '/lineup.json', '/lineup.xml', '/lineup.post', '/guide.xml'].includes(path) || /^\/auto\/v\d+$/.test(path)) {
                if (!config.tunerEnabled) return reply(404, 'Tuner disabled\n');
                // Plex's HDHomeRun requests have no configurable auth header.
                // Grant access only to explicitly configured TCP peer IPs.
                // Forwarded headers are intentionally never trusted here.
                if (!tunerClientAllowed(request.socket.remoteAddress, config.tunerClients)) return reply(403, 'Tuner client not allowed\n');
                tunerAccess = true;
                if (path === '/lineup.post') {
                    if (request.method !== 'POST') return reply(405, 'POST required\n');
                    snapshot = null; epg = null;
                    return reply(200, '');
                }
                if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'GET or HEAD required\n');
                if (path === '/discover.json') return reply(200, JSON.stringify(tunerDiscovery(config)), 'application/json');
                if (path === '/device.xml') return reply(200, tunerDeviceXml(config), 'application/xml; charset=utf-8');
                if (path === '/lineup_status.json') return reply(200, JSON.stringify({ ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] }), 'application/json');
                if (path === '/lineup.json' || path === '/lineup.xml') {
                    const guide = await getGuide();
                    const channels = await playableChannels(guide, now());
                    return path.endsWith('.json')
                        ? reply(200, JSON.stringify(tunerLineup(channels, config)), 'application/json')
                        : reply(200, tunerLineupXml(channels, config), 'application/xml; charset=utf-8');
                }
                if (path === '/guide.xml') path = '/epg.xml';
                else {
                    const guide = await getGuide();
                    const tunerChannel = guide.channels.find((channel) => String(channel.number) === path.slice(7));
                    if (!tunerChannel) return reply(404, 'Unknown channel\n');
                    path = `/stream/${encodeURIComponent(tunerChannel.id)}.ts`;
                }
            }
            if (path.startsWith('/stashy/')) {
                if (!config.stashyEnabled) return reply(404, 'Adapter disabled\n');
                if (!authorized(request, url, config.token, true)) return reply(401, 'Unauthorized\n');
                if (path === '/stashy/graphql') {
                    if (request.method !== 'POST') return reply(405, 'POST required\n');
                    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) return reply(415, 'JSON required\n');
                    const chunks = [];
                    let size = 0;
                    for await (const part of request) {
                        size += part.length;
                        if (size > 65536) return reply(413, 'Request too large\n');
                        chunks.push(part);
                    }
                    let input;
                    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, 'Invalid JSON\n'); }
                    return reply(200, JSON.stringify(await stashy.request(input)), 'application/json; charset=utf-8');
                }
                if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'GET or HEAD required\n');
                const live = /^\/stashy\/scene\/([^/]+)\/(stream(?:\.m3u8)?|hls\/([a-f0-9]{24})\/(segment-\d{9}\.ts))$/.exec(path);
                if (live) {
                    const id = decodeURIComponent(live[1]);
                    const guide = await getGuide();
                    const channel = guide.channels.find((item) => adapterSceneId(item.id) === id);
                    if (!channel || !await guide.program(channel, now())) return reply(404, 'Unknown or empty channel\n');
                    if (live[3]) {
                        const segment = await hls.segment(channel.id, live[3], live[4]);
                        return segment ? reply(200, segment, 'video/mp2t') : reply(404, 'Segment expired\n');
                    }
                    if (request.method === 'HEAD') return reply(200, '', 'application/vnd.apple.mpegurl');
                    const result = await hls.playlist(channel.id, id);
                    return reply(result.status, result.body, result.status === 200 ? 'application/vnd.apple.mpegurl' : 'text/plain');
                }
                const image = /^\/stashy\/scene\/([^/]+)\/screenshot$/.exec(path);
                if (image) {
                    const source = await stashy.imageScene(decodeURIComponent(image[1]));
                    if (!source) return reply(404, 'No image\n');
                    const upstream = await fetchFn(stashMediaUrl(config, source), {
                        headers: stashHeaders(config), signal: AbortSignal.timeout(15000), redirect: 'error'
                    });
                    const type = upstream.headers.get('content-type') || '';
                    if (!upstream.ok || !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(type)) return reply(502, 'Image unavailable\n');
                    const chunks = [];
                    let size = 0;
                    for await (const chunk of upstream.body) {
                        size += chunk.length;
                        if (size > 5 * 1024 * 1024) throw new Error('Image exceeds limit');
                        chunks.push(chunk);
                    }
                    return reply(200, Buffer.concat(chunks), type);
                }
                return reply(404, 'Not found\n');
            }
            if (!tunerAccess && !authorized(request, url, config.token)) return reply(401, 'Unauthorized\n');
            if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'GET or HEAD required\n');
            if (path === '/health') return reply(200, 'StashIP-TV is running\n');
            if (!['/playlist.m3u', '/epg.xml'].includes(path) && !/^\/(stream|logo)\/[^/]+$/.test(path)) return reply(404, 'Not found\n');
            const guide = await getGuide();
            if (path === '/playlist.m3u' || path === '/epg.xml') {
                const channels = await playableChannels(guide, now());
                if (path === '/playlist.m3u') return reply(200, renderM3u(channels, config), 'audio/x-mpegurl; charset=utf-8');
                if (!epg || epg.guide !== guide) {
                    const from = dayBucket(now()).startMs;
                    let to = from;
                    for (let i = 0; i < config.days; i++) to = nextMidnight(to);
                    const pending = renderXmltv(guide, channels, config, from, to);
                    const entry = { guide, pending };
                    epg = entry;
                    pending.catch(() => { if (epg === entry) epg = null; });
                }
                return reply(200, await epg.pending, 'application/xml; charset=utf-8');
            }
            const isStream = path.startsWith('/stream/');
            if (isStream && !path.endsWith('.ts')) return reply(404, 'Not found\n');
            const id = decodeURIComponent(path.slice(isStream ? 8 : 6, isStream ? -3 : undefined));
            const channel = guide.channels.find((c) => c.id === id);
            if (!channel) return reply(404, 'Unknown channel\n');
            if (!isStream) {
                if (channel.logo?.type !== 'image') return reply(404, 'No logo\n');
                const upstream = await fetchFn(stashMediaUrl(config, channel.logo.url), {
                    headers: stashHeaders(config),
                    signal: AbortSignal.timeout(15000), redirect: 'error'
                });
                const type = upstream.headers.get('content-type') || '';
                if (!upstream.ok || !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(type)) return reply(502, 'Logo unavailable\n');
                // Stash artwork is bounded, even if a reverse proxy misbehaves.
                const chunks = [];
                let size = 0;
                for await (const chunk of upstream.body) {
                    size += chunk.length;
                    if (size > 5 * 1024 * 1024) throw new Error('Logo exceeds limit');
                    chunks.push(chunk);
                }
                return reply(200, Buffer.concat(chunks), type);
            }
            if (!await guide.program(channel, now())) return reply(404, 'Channel has no playable scenes\n');
            if (request.method === 'HEAD') return reply(200, '', 'video/mp2t');
            if (active >= config.maxStreams) return reply(503, 'Simultaneous stream limit reached\n');
            active++;
            try { await stream({ response, config, channelId: id, getGuide, gql, now }); }
            finally { active--; }
            if (!response.destroyed) response.end();
        } catch (error) {
            // Keep arbitrary/FFmpeg errors generic, but give admins the operation
            // and validated, credential-redacted GraphQL error for API failures.
            log(error instanceof StashRequestError ? `StashIP-TV: ${error.message}`
                : 'StashIP-TV: request failed; check Stash connectivity, media URLs and FFmpeg.');
            if (response.headersSent) response.destroy();
            else reply(error instanceof URIError ? 400 : 502, 'TVGuide upstream unavailable\n');
        }
    });
    server.once('close', () => hls.close());
    return { server, getGuide, close() { hls.close(); server.close(); server.closeAllConnections(); } };
}
