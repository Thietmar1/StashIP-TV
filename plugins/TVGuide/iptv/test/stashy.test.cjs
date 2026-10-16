const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');
const { buildSchema, introspectionFromSchema } = require('graphql');
const { createIptvServer, readConfig, adapterSceneId } = require('../../tvguide-server.js');
const fixture = (name) => readFileSync(join(__dirname, 'fixtures/stashy', name), 'utf8');
const schema = buildSchema(readFileSync(join(__dirname, 'fixtures/adapter-schema.graphql'), 'utf8'));
const config = readConfig({ TVGUIDE_TOKEN: 'stashy-test-token-'.repeat(3), STASH_API_KEY: 'private-real-stash-key', STASH_URL: 'http://stash:9999', TVGUIDE_PUBLIC_URL: 'http://tvguide:9898', TVGUIDE_STASHY_ENABLED: 'true' });

async function setup(t, overrides = {}, options = {}) {
    let time = Date.UTC(2026, 9, 16, 10);
    const calls = [];
    const guide = { channels: [{ id: 'tag:7', name: 'My Channel', source: 'tag' }, { id: 'studio:9', name: 'Empty', source: 'studio' }],
        getPlan: async () => ({ totalMs: 86400000 }),
        program: async (channel) => channel.id === 'studio:9' ? null : ({ startMs: Date.UTC(2026, 9, 16, 9), endMs: Date.UTC(2026, 9, 16, 12),
            scene: { id: 'real-scene-id', title: time < Date.UTC(2026, 9, 16, 11) ? 'Current Scene' : 'Next Scene', paths: { screenshot: '/scene/real/screenshot' } } })
    };
    const app = createIptvServer({ ...config, ...overrides }, { load: async () => guide, now: () => time, log: () => {},
        gql: async (query) => { calls.push(query); throw new Error('Unexpected forwarding'); },
        adapterBootstrap: async () => ({ introspection: introspectionFromSchema(schema), version: 'v0.31.1' }),
        stream: async ({ response }) => { response.writeHead(200, { 'Content-Type': 'video/mp2t' }); response.end('LIVE-TS'); },
        fetchFn: async () => new Response('PNG', { headers: { 'content-type': 'image/png' } }), ...options
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => app.close());
    const root = `http://127.0.0.1:${app.server.address().port}`;
    const prefix = new URL(overrides.publicUrl || config.publicUrl).pathname.replace(/\/$/, '');
    const request = (query, variables, extra = {}) => fetch(root + prefix + '/stashy/graphql', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ApiKey: config.token }, body: JSON.stringify({ query, variables }), ...extra });
    return { app, root, calls, request, clock: (next) => { time = next; } };
}

test('Stashy connection probe authenticates with the IPTV key, not the real Stash key; adapter is optional', async (t) => {
    const { request, calls } = await setup(t);
    const query = '{ version { version } }';
    assert.equal((await request(query, null, { headers: { 'Content-Type': 'application/json', ApiKey: config.apiKey } })).status, 401);
    assert.equal((await request(query, null, { headers: { 'Content-Type': 'application/json' } })).status, 401);
    const result = await (await request(query)).json();
    assert.deepEqual(result, { data: { version: { version: 'v0.31.1' } } });
    assert.deepEqual(calls, []);
    const disabled = await setup(t, { stashyEnabled: false });
    assert.equal((await disabled.request(query)).status, 404);
});

test('original Stashy list/detail/configuration query contracts return channel and current scene names', async (t) => {
    const { request, calls } = await setup(t);
    const list = await (await request(fixture('findScenes.graphql') + fixture('fragment_SceneListFields.graphql'), { filter: { per_page: 20 } })).json();
    assert.equal(list.errors, undefined, JSON.stringify(list.errors));
    assert.equal(list.data.findScenes.count, 1);
    const scene = list.data.findScenes.scenes[0];
    assert.equal(scene.id, adapterSceneId('tag:7'));
    assert.equal(scene.title, '12 · My Channel — Current Scene');
    assert.equal(scene.files[0].duration, 0);
    assert.equal(scene.resume_time, 0);
    assert.deepEqual(scene.performers, []);
    const detailQuery = fixture('findScene.graphql') + fixture('fragment_SceneFields.graphql') + fixture('fragment_StudioFields.graphql') + fixture('fragment_PerformerFields.graphql') + fixture('fragment_TagFields.graphql');
    const detail = await (await request(detailQuery, { id: scene.id })).json();
    assert.equal(detail.errors, undefined, JSON.stringify(detail.errors));
    assert.match(detail.data.findScene.details, /Live channel: 12 · My Channel\nNow playing: Current Scene/);
    assert.ok(!JSON.stringify(detail).includes(config.apiKey));
    assert.ok(!JSON.stringify(detail).includes('real-scene-id'));
    const compact = await (await request(fixture('findScenesCompact.graphql'), { ids: [scene.id], filter: { per_page: -1 } })).json();
    assert.equal(compact.errors, undefined, JSON.stringify(compact.errors));
    assert.equal(compact.data.findScenes.count, 1);
    const configuration = await (await request(fixture('configuration.graphql'))).json();
    assert.equal(configuration.errors, undefined, JSON.stringify(configuration.errors));
    assert.deepEqual(configuration.data.configuration.general.stashes, []);
    assert.deepEqual(calls, []);
});

test('live title refresh keeps IDs stable and supports query aliases, pagination, text search and filters', async (t) => {
    const { request, clock } = await setup(t);
    const query = 'query Live($filter: FindFilterType, $scene_filter: SceneFilterType) { live: findScenes(filter: $filter, scene_filter: $scene_filter) { count scenes { id title } } }';
    const first = await (await request(query, { filter: { q: 'my channel', per_page: 1 } })).json();
    clock(Date.UTC(2026, 9, 16, 11));
    const next = await (await request(query, { filter: { per_page: 1 } })).json();
    assert.equal(first.data.live.scenes[0].id, next.data.live.scenes[0].id);
    assert.match(next.data.live.scenes[0].title, /Next Scene/);
    const empty = await (await request(query, { filter: { q: 'absent' } })).json();
    assert.equal(empty.data.live.count, 0);
    const secondPage = await (await request(query, { filter: { page: 2, per_page: 1 } })).json();
    assert.equal(secondPage.data.live.count, 1);
    assert.deepEqual(secondPage.data.live.scenes, []);
    const filtered = await (await request(query, { scene_filter: { organized: false } })).json();
    assert.equal(filtered.data.live.count, 0);
});

test('library mutations and unsupported reads never reach the real Stash connection', async (t) => {
    const { request, calls } = await setup(t);
    const mutation = await (await request('mutation { sceneDestroy(id:"real-id") }')).json();
    assert.match(mutation.errors[0].message, /read-only/);
    const unsupported = await (await request('{ privateLibrarySecret }')).json();
    assert.match(unsupported.errors[0].message, /not supported/);
    const configuration = await (await request('{ configuration { plugins general { apiKey } } }')).json();
    assert.deepEqual(configuration.data.configuration.plugins, {});
    assert.equal(configuration.data.configuration.general.apiKey, '');
    assert.deepEqual(calls, []);
});

test('Stashy primary media URLs reuse the live stream; thumbnails proxy credentials only to Stash', async (t) => {
    let captured;
    const { request, root } = await setup(t, { publicUrl: 'http://tvguide:9898/bridge' }, { fetchFn: async (url, options) => {
        captured = { url, options }; return new Response('PNG', { headers: { 'content-type': 'image/png' } });
    } });
    const result = await (await request('{ findScenes { scenes { paths { stream screenshot } } } }')).json();
    const paths = result.data.findScenes.scenes[0].paths;
    for (const [field, type, body] of [['stream', 'video/mp2t', 'LIVE-TS'], ['screenshot', 'image/png', 'PNG']]) {
        const url = new URL(paths[field]);
        const response = await fetch(root + url.pathname + url.search);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), new RegExp(type));
        assert.equal(await response.text(), body);
    }
    assert.equal(captured.options.headers.ApiKey, config.apiKey);
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.url, 'http://stash:9999/scene/real/screenshot');
});

test('adapter request limits, invalid JSON, media types and introspection bootstrap are bounded', async (t) => {
    const { request } = await setup(t);
    assert.equal((await request('', null, { body: 'bad json' })).status, 400);
    assert.equal((await request('', null, { headers: { ApiKey: config.token } })).status, 415);
    assert.equal((await request('', null, { body: 'x'.repeat(65537) })).status, 413);
    const invalid = await (await request('broken query')).json();
    assert.match(invalid.errors[0].message, /Invalid GraphQL/);
    const calls = [];
    const actual = await setup(t, {}, { adapterBootstrap: undefined, gql: async (query) => {
        calls.push(query);
        return query.includes('IntrospectionQuery') ? introspectionFromSchema(schema) : { version: { version: 'v0.31.1' } };
    } });
    assert.equal((await (await actual.request('{ version { version } }')).json()).data.version.version, 'v0.31.1');
    await actual.request('{ version { version } }');
    assert.equal(calls.length, 2);
});
