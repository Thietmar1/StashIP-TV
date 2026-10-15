import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createStashClient, stashMediaUrl, stashHeaders, endpoint } from './config.js';
import { loadGuide, renderM3u, renderXmltv, playableChannels, nextMidnight } from './guide.js';
import { dayBucket } from '../src/domain/schedule.js';
import { streamChannel } from './stream.js';

function authorized(request, url, token) {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createIptvServer(config, { gql = createStashClient(config), load = loadGuide, stream = streamChannel, fetchFn = fetch, now = Date.now, log = console.error } = {}) {
    let snapshot;
    let expires = 0;
    let active = 0;
    let epg;
    const prefix = new URL(config.publicUrl).pathname.replace(/\/$/, '');
    const getGuide = async () => {
        if (!snapshot || now() >= expires) {
            expires = Math.min(now() + 300000, nextMidnight(now()));
            const pending = load(gql);
            snapshot = pending;
            epg = null;
            pending.catch(() => { if (snapshot === pending) snapshot = null; });
        }
        return snapshot;
    };

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
            if (!authorized(request, url, config.token)) return reply(401, 'Unauthorized\n');
            if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'GET or HEAD required\n');
            if (prefix && !url.pathname.startsWith(`${prefix}/`)) return reply(404, 'Not found\n');
            const path = url.pathname.slice(prefix.length);
            if (path === '/health') return reply(200, 'TVGuide IPTV is running\n');
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
            // Errors from fetch/FFmpeg may include credentials. Keep logs generic.
            log('TVGuide IPTV: request failed; check Stash connectivity, media URLs and FFmpeg.');
            if (response.headersSent) response.destroy();
            else reply(error instanceof URIError ? 400 : 502, 'TVGuide upstream unavailable\n');
        }
    });
    return { server, getGuide, close() { server.close(); server.closeAllConnections(); } };
}
