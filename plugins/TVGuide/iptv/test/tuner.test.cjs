const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readConfig, createIptvServer, parseTunerClients, tunerClientAllowed, tunerIdentity,
    tunerDiscovery, tunerLineup, loadGuide, createStashyAdapter, renderM3u, renderXmltv, numberChannels } = require('../../tvguide-server.js');

const config = readConfig({ TVGUIDE_TOKEN: 'tuner-test-token-'.repeat(3), STASH_API_KEY: 'private-key',
    STASH_URL: 'http://stash:9999', TVGUIDE_PUBLIC_URL: 'http://live:9898', TVGUIDE_PLEX_ENABLED: 'true', TVGUIDE_PLEX_CLIENTS: '127.0.0.1' });
const time = new Date(2026, 9, 16, 12).getTime();
const channels = [{ id: 'tag:1', name: 'User channel & <one>' }, { id: 'studio:9', name: 'Empty' }, { id: 'tag:2', name: 'Second' }];
const guide = { channels, getPlan: async (c) => ({ totalMs: c.id === 'studio:9' ? 0 : 86400000 }),
    program: async (channel, now) => channel.id === 'studio:9' ? null : ({ scene: { id: 's1', title: 'Show' }, startMs: now, endMs: now + 86400000 }) };

async function setup(t, overrides = {}, options = {}) {
    let loads = 0;
    const streams = [];
    const app = createIptvServer({ ...config, ...overrides }, { gql: async () => {}, load: async () => { loads++; return guide; }, now: () => time,
        stream: async ({ response, channelId }) => { streams.push(channelId); response.writeHead(200, { 'Content-Type': 'video/mp2t' }); response.end('TS'); }, ...options });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => app.close());
    const root = `http://127.0.0.1:${app.server.address().port}`;
    return { app, root, streams, loads: () => loads };
}

test('virtual tuner is opt-in, requires literal allowed peer IPs and handles IPv4-mapped IPv6', () => {
    assert.equal(readConfig({ TVGUIDE_TOKEN: config.token }).tunerEnabled, false);
    assert.deepEqual(readConfig({ TVGUIDE_TOKEN: config.token, TVGUIDE_PLEX_CLIENTS: 'unfinished draft' }).tunerClients, []);
    assert.throws(() => readConfig({ TVGUIDE_TOKEN: config.token, TVGUIDE_PLEX_ENABLED: 'true' }), /Allowed IPs/);
    assert.deepEqual(parseTunerClients('127.0.0.1, ::1; 127.0.0.1'), ['127.0.0.1', '::1']);
    assert.deepEqual(parseTunerClients(null), []);
    for (const value of ['*', '192.168.1.0/24', 'plex.local', 'http://127.0.0.1', '127.1', Array(33).fill(0).map((_,i)=>`10.0.0.${i}`).join(',')]) {
        assert.throws(() => parseTunerClients(value), /IP addresses/);
    }
    assert.equal(tunerClientAllowed('::ffff:127.0.0.1', ['127.0.0.1']), true);
    assert.equal(tunerClientAllowed('::1', ['0:0:0:0:0:0:0:1']), true);
    assert.equal(tunerClientAllowed('127.0.0.2', ['127.0.0.1']), false);
    assert.equal(tunerClientAllowed('127.0.0.1', []), false);
    assert.equal(tunerClientAllowed(undefined, ['127.0.0.1']), false);
});

test('tuner identity stays stable across token/channel changes and includes a valid device-ID checksum', () => {
    assert.deepEqual(tunerDiscovery(config), tunerDiscovery({ ...config, token: 'different' }));
    const id = tunerIdentity(config.publicUrl).deviceId;
    const table = [10,5,15,6,7,12,1,11,9,2,8,13,4,3,14,0];
    assert.match(id, /^[0-9A-F]{8}$/);
    assert.equal([...id].reduce((sum, digit, i) => sum ^ (i % 2 ? parseInt(digit, 16) : table[parseInt(digit, 16)]), 0), 0);
    assert.notEqual(tunerIdentity('http://other:9898').deviceId, id);
});

test('disabled or untrusted tuner requests cannot read the guide, stream, scan or spoof a forwarded peer', async (t) => {
    const paths = ['/discover.json', '/device.xml', '/lineup.json', '/lineup.xml', '/lineup_status.json', '/guide.xml', '/auto/v12', '/lineup.post'];
    for (const [overrides, expected] of [[{ tunerEnabled: false }, 404], [{ tunerClients: ['192.0.2.1'] }, 403]]) {
        const app = await setup(t, overrides);
        for (const path of paths) {
            const result = await fetch(app.root + path + `?token=${config.token}`, { method: path.endsWith('.post') ? 'POST' : 'GET',
                headers: { 'X-Forwarded-For': '192.0.2.1', 'X-Real-IP': '192.0.2.1' } });
            assert.equal(result.status, expected, path);
        }
        assert.equal(app.loads(), 0);
        assert.deepEqual(app.streams, []);
    }
});

test('Plex HTTP discovery, lineups, channel numbers/names, XMLTV and stream URLs agree without exposing credentials', async (t) => {
    const { root, streams, loads } = await setup(t);
    const discover = await (await fetch(root + '/discover.json')).json();
    assert.equal(discover.FriendlyName, 'TVGuide Live TV');
    assert.equal(discover.TunerCount, config.maxStreams);
    assert.equal(discover.BaseURL, config.publicUrl);
    assert.equal(discover.LineupURL, config.publicUrl + '/lineup.json');
    assert.equal(loads(), 0);
    const xmlDevice = await (await fetch(root + '/device.xml')).text();
    assert.ok(xmlDevice.includes(discover.DeviceID));
    const status = await (await fetch(root + '/lineup_status.json')).json();
    assert.equal(status.ScanInProgress, 0);
    assert.deepEqual(status.SourceList, ['Cable']);
    const lineup = await (await fetch(root + '/lineup.json')).json();
    assert.deepEqual(lineup.map((c)=>[c.GuideNumber,c.GuideName]), [['12','User channel & <one>'],['14','Second']]);
    assert.deepEqual(lineup.map((c)=>c.URL), ['http://live:9898/auto/v12','http://live:9898/auto/v14']);
    const xml = await (await fetch(root + '/lineup.xml')).text();
    assert.match(xml, /User channel &amp; &lt;one&gt;/);
    const head = await fetch(root + '/auto/v12', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const play = await fetch(root + '/auto/v12?transcode=heavy&duration=10');
    assert.equal(play.headers.get('content-type'), 'video/mp2t');
    assert.equal(await play.text(), 'TS');
    assert.deepEqual(streams, ['tag:1']);
    assert.equal((await fetch(root + '/auto/v13')).status, 404);
    assert.equal((await fetch(root + '/auto/v99')).status, 404);
    // Existing token-authenticated routes do not gain the tuner's IP exemption.
    assert.equal((await fetch(root + '/playlist.m3u')).status, 401);
    assert.equal((await fetch(root + '/stream/tag%3A1.ts')).status, 401);
    assert.equal((await fetch(root + '/epg.xml')).status, 401);
    const epg = await (await fetch(root + '/guide.xml')).text();
    assert.match(epg, /<channel id="tag:1"><display-name>User channel &amp; &lt;one&gt;<\/display-name><display-name>12<\/display-name>/);
    assert.match(epg, /<programme channel="tag:1"/);
    assert.ok(!epg.includes('id="studio:9"'));
    for (const text of [JSON.stringify(discover), JSON.stringify(lineup), xml, xmlDevice]) {
        assert.ok(!text.includes(config.token)); assert.ok(!text.includes(config.apiKey));
    }
    assert.equal((await fetch(root + '/lineup.post?scan=start', { method: 'POST' })).status, 200);
    await fetch(root + '/lineup.json');
    assert.equal(loads(), 2);
});

test('tuner endpoints honor public URL prefixes, HTTP methods, HEAD and the shared stream limit', async (t) => {
    let release;
    const app = await setup(t, { publicUrl: 'http://live:9898/tv', maxStreams: 1 }, { stream: async ({ response }) => {
        response.writeHead(200, { 'Content-Type': 'video/mp2t' }); response.write('TS');
        await new Promise((resolve) => { release = resolve; response.once('close', resolve); });
    } });
    assert.equal((await fetch(app.root + '/discover.json')).status, 404);
    assert.equal((await (await fetch(app.root + '/tv/discover.json')).json()).LineupURL, 'http://live:9898/tv/lineup.json');
    assert.equal((await fetch(app.root + '/tv/discover.json', { method: 'POST' })).status, 405);
    assert.equal((await fetch(app.root + '/tv/lineup.post')).status, 405);
    assert.equal((await fetch(app.root + '/tv/guide.xml', { method: 'HEAD' })).status, 200);
    const first = await fetch(app.root + '/tv/auto/v12');
    assert.equal(first.status, 200);
    assert.equal((await fetch(app.root + '/tv/auto/v14')).status, 503);
    assert.equal((await fetch(app.root + `/tv/stream/tag%3A2.ts?token=${config.token}`)).status, 503);
    release(); await first.body.cancel();
});

test('a persisted custom name reaches M3U, XMLTV, Plex and Stashy while channel IDs and programme order stay fixed', async () => {
    let name = 'Personal TV & More';
    const gql = async (query) => {
        if (query.includes('Configuration')) return { configuration: { plugins: { TVGuide: { tvguide_state: {
            tvguide_lineup: JSON.stringify([{ source: 'studio', ids: ['1'] }]),
            tvguide_channel_prefs: JSON.stringify({ 'studio:1': { name } })
        } } } } };
        if (query.includes('Studios')) return { findStudios: { studios: [{ id: '1', name: 'Original studio', scene_count: 1 }] } };
        if (query.includes('SceneCount')) return { findScenes: { count: 1 } };
        return { findScenes: { scenes: [{ id: 's1', title: 'Current show', files: [{ duration: 600 }] }] } };
    };
    const custom = await loadGuide(gql);
    custom.channels = numberChannels(custom.channels, 12);
    assert.equal(custom.channels[0].name, name);
    const m3u = renderM3u(custom.channels, config);
    assert.match(m3u, /tvg-id="studio:1" tvg-chno="12"/);
    assert.ok(m3u.includes(name));
    assert.match(m3u, /tvg-group="Studios" group-title="Studios"/);
    const epg = await renderXmltv(custom, custom.channels, config, time, time + 1200000);
    assert.match(epg, /Personal TV &amp; More/);
    assert.equal(tunerLineup(custom.channels, config)[0].GuideName, name);
    const { buildSchema, introspectionFromSchema } = require('graphql');
    const { readFileSync } = require('node:fs');
    const schema = buildSchema(readFileSync(require('node:path').join(__dirname, 'fixtures/adapter-schema.graphql'), 'utf8'));
    const adapter = createStashyAdapter(config, { getGuide: async () => custom, now: () => time,
        bootstrap: async () => ({ introspection: introspectionFromSchema(schema), version: 'v0.31.1' }) });
    const result = await adapter.request({ query: '{ findScenes { scenes { id title } } }' });
    assert.equal(result.errors, undefined);
    assert.equal(result.data.findScenes.scenes[0].title, `12 · ${name} — Current show`);
    name = '';
    const original = await loadGuide(gql);
    assert.equal(original.channels[0].name, 'Original studio');
    assert.equal(original.channels[0].id, custom.channels[0].id);
    assert.deepEqual(await original.program(original.channels[0], time), await custom.program(custom.channels[0], time));
});
