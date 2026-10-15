const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readConfig, createIptvServer, createMediaProxy, createStashClient, loadGuide } = require('../../tvguide-server.js');
const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_URL: 'http://stash:9999', STASH_API_KEY: 'never-export-this', TVGUIDE_MAX_STREAMS: '1' });
const channel = { id: 'studio:1', source: 'studio', name: 'Studio One', logo: { type: 'image', url: '/studio/1/image' } };
const scene = { id: '1', title: 'Scheduled show', files: [{ duration: 86400 }] };
const clock = new Date(2026, 9, 15).getTime();
const guide = { channels: [channel], getPlan: async () => ({ totalMs: 86400000 }), program: async (_channel, ms) => ({ scene, startMs: ms, endMs: ms + 86400000 }) };

async function setup(t, options = {}, overrides = {}) {
    const app = createIptvServer({ ...config, ...overrides }, { load: async () => guide, gql: async () => {}, now: () => clock, log: () => {}, ...options });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => app.close());
    const root = `http://127.0.0.1:${app.server.address().port}`;
    return { app, root, get: (path, opts) => fetch(`${root}${path}${path.includes('?') ? '&' : '?'}token=${config.token}`, opts) };
}

test('authentication precedes Stash I/O; HTTP methods, prefixes and HEAD are handled', async (t) => {
    let loads = 0;
    const { root, get } = await setup(t, { load: async () => { loads++; return guide; } }, { publicUrl: 'http://tvguide:9898/tvguide' });
    assert.equal((await fetch(root + '/tvguide/playlist.m3u')).status, 401);
    assert.equal(loads, 0);
    assert.equal((await get('/wrong/playlist.m3u')).status, 404);
    assert.equal((await get('/tvguide/health', { method: 'POST' })).status, 405);
    const head = await get('/tvguide/health', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const bearer = await fetch(root + '/tvguide/health', { headers: { Authorization: `Bearer ${config.token}` } });
    assert.equal(bearer.status, 200);
    assert.equal((await get('/tvguide/missing')).status, 404);
});

test('real HTTP exports return matching channel IDs and valid content types', async (t) => {
    const { get } = await setup(t);
    const playlist = await get('/playlist.m3u');
    assert.equal(playlist.status, 200);
    assert.match(playlist.headers.get('content-type'), /mpegurl/);
    const text = await playlist.text();
    const epg = await get('/epg.xml');
    assert.equal(epg.status, 200);
    assert.match(epg.headers.get('content-type'), /xml/);
    const xml = await epg.text();
    assert.match(text, /tvg-id="studio:1"/);
    assert.match(xml, /channel="studio:1"/);
    assert.ok(!text.includes(config.apiKey) && !xml.includes(config.apiKey));
    const head = await get('/stream/studio%3A1.ts', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'video/mp2t');
    assert.equal((await get('/stream/studio%3A2.ts')).status, 404);
    assert.equal((await get('/stream/studio%3A1')).status, 404);
    assert.equal((await get('/stream/%xx.ts')).status, 400);
});

test('saved tag and Stash-ID filters produce working M3U/XMLTV without unsupported input fields', async (t) => {
    const requests = [];
    const saved = {
        tags: { modifier: 'INCLUDES_ALL', value: { items: [{ id: '71' }], excluded: [], depth: 0 } },
        stash_id_endpoint: { modifier: 'NOT_NULL', value: { endpoint: 'https://stashdb.org/graphql', stashID: '' } }
    };
    const gql = createStashClient(config, async (_url, options) => {
        const { query, variables } = JSON.parse(options.body);
        let data;
        if (query.includes('IPTVConfiguration')) data = { configuration: { plugins: { TVGuide: { tvguide_state: {
            tvguide_lineup: JSON.stringify([{ source: 'savedFilter', names: ['Tagged channel'] }])
        } } } } };
        else if (query.includes('SavedFilters')) data = { findSavedFilters: [{ id: '9', name: 'Tagged channel', object_filter: saved }] };
        else {
            // Reproduce Stash's HTTP 400 for the original invalid input. The
            // regression test must fail as 502 before the conversion is fixed.
            if ('value' in variables.filter.stash_id_endpoint) return new Response(JSON.stringify({ errors: [{
                message: 'unknown field', path: ['variable', 'filter', 'stash_id_endpoint', 'value']
            }] }), { status: 400 });
            assert.deepEqual(variables.filter, {
                tags: { modifier: 'INCLUDES_ALL', value: ['71'] },
                stash_id_endpoint: { modifier: 'NOT_NULL', endpoint: 'https://stashdb.org/graphql', stash_id: '' }
            });
            requests.push(query);
            data = query.includes('SceneCount') ? { findScenes: { count: 1 } } : { findScenes: { scenes: [scene] } };
        }
        return new Response(JSON.stringify({ data }));
    });
    const { get } = await setup(t, { load: loadGuide, gql });
    const playlist = await get('/playlist.m3u');
    assert.equal(playlist.status, 200);
    assert.match(await playlist.text(), /tvg-id="savedFilter:9"/);
    const epg = await get('/epg.xml');
    assert.equal(epg.status, 200);
    assert.match(await epg.text(), /channel="savedFilter:9"/);
    assert.ok(requests.some((query) => query.includes('SceneCount')));
    assert.ok(requests.some((query) => query.includes('ScenePool')));
});

test('failed snapshots retry; snapshots expire after five minutes and at midnight', async (t) => {
    let time = clock;
    let calls = 0;
    const { get } = await setup(t, { now: () => time, load: async () => {
        calls++;
        if (calls === 1) throw new Error('secret');
        return guide;
    } });
    assert.equal((await get('/playlist.m3u')).status, 502);
    assert.equal((await get('/playlist.m3u')).status, 200);
    assert.equal((await get('/epg.xml')).status, 200);
    assert.equal(calls, 2);
    time += 300001;
    await get('/playlist.m3u');
    assert.equal(calls, 3);
    time = clock + 86400000;
    await get('/playlist.m3u');
    assert.equal(calls, 4);
});

test('Stash logos are proxied with credentials and external redirects are rejected', async (t) => {
    let request;
    const { get } = await setup(t, { fetchFn: async (url, options) => {
        request = { url, options };
        return new Response(Buffer.from('PNG'), { headers: { 'content-type': 'image/png' } });
    } });
    const result = await get('/logo/studio%3A1');
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'PNG');
    assert.equal(request.url, 'http://stash:9999/studio/1/image');
    assert.equal(request.options.headers.ApiKey, config.apiKey);
    assert.equal(request.options.redirect, 'error');
});

test('stream limit is released on disconnect, and shutdown closes active connections', async (t) => {
    let disconnected;
    const closed = new Promise((resolve) => { disconnected = resolve; });
    const { app, get } = await setup(t, { stream: async ({ response }) => {
        response.writeHead(200, { 'Content-Type': 'video/mp2t' });
        response.write('TS');
        await once(response, 'close');
        disconnected();
    } });
    const first = await get('/stream/studio%3A1.ts');
    assert.equal(first.status, 200);
    assert.equal((await get('/stream/studio%3A1.ts')).status, 503);
    await first.body.cancel();
    await closed;
    // Drain the disconnect event, rather than sleeping on an assumed duration.
    await new Promise((resolve) => setImmediate(resolve));
    const next = await get('/stream/studio%3A1.ts');
    assert.equal(next.status, 200);
    await next.body.cancel();
    app.close();
});

test('upstream failures never expose error details or credentials in HTTP responses/logs', async (t) => {
    const logs = [];
    const { get } = await setup(t, { stream: async () => { throw new Error('private-secret-url'); }, log: (line) => logs.push(line) });
    const result = await get('/stream/studio%3A1.ts');
    assert.equal(result.status, 502);
    assert.equal(await result.text(), 'TVGuide upstream unavailable\n');
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes('private-secret-url'));
});

test('GraphQL failures identify the operation and cause in logs while redacting secrets and URLs', async (t) => {
    const logs = [];
    const gql = createStashClient({ ...config, sessionCookie: 'session=private-cookie' }, async () => ({
        ok: true, json: async () => ({ errors: [{ message: `Unknown field invalidCriterion; ${config.apiKey}; ${config.token}; private-cookie; http://stash:9999/graphql?secret=other` }] })
    }));
    const { get } = await setup(t, { load: async () => {
        await gql('query TVGuideScenePool { invalidCriterion }');
    }, log: (line) => logs.push(line) });
    const result = await get('/playlist.m3u');
    assert.equal(result.status, 502);
    assert.equal(await result.text(), 'TVGuide upstream unavailable\n');
    assert.match(logs[0], /TVGuideScenePool/);
    assert.match(logs[0], /Unknown field invalidCriterion/);
    for (const secret of [config.apiKey, config.token, 'private-cookie', 'secret=other']) assert.ok(!logs[0].includes(secret));
});

test('private media proxy forwards byte ranges and rejects requests outside its random path', async (t) => {
    let captured;
    const proxy = await createMediaProxy(config, 'http://stash:9999/scene/1/stream', async (url, options) => {
        captured = { url, options };
        return new Response(Buffer.from('456'), { status: 206, headers: { 'content-range': 'bytes 4-6/10', 'content-type': 'video/mp4' } });
    });
    t.after(() => proxy.close());
    const response = await fetch(proxy.url, { headers: { Range: 'bytes=4-6' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '456');
    assert.equal(captured.options.headers.Range, 'bytes=4-6');
    assert.equal(captured.options.headers.ApiKey, config.apiKey);
    assert.equal(captured.options.redirect, 'error');
    assert.equal(response.headers.get('content-range'), 'bytes 4-6/10');
    assert.equal((await fetch(new URL('/wrong', proxy.url))).status, 404);
});

test('upstream redirects cannot forward the API key to another origin', async (t) => {
    const { createServer } = require('node:http');
    let received = false;
    const target = createServer((_req, res) => { received = true; res.end('leak'); });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    t.after(() => { target.close(); target.closeAllConnections(); });
    const upstream = createServer((_req, res) => res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/media` }).end());
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.close(); upstream.closeAllConnections(); });
    const proxy = await createMediaProxy(config, `http://127.0.0.1:${upstream.address().port}/media`);
    t.after(() => proxy.close());
    assert.equal((await fetch(proxy.url)).status, 502);
    assert.equal(received, false);
});

