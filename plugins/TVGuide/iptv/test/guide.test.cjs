const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGuide, nextMidnight, renderM3u, renderXmltv, playableChannels, xml, xmlTime, readConfig, createStashClient, stashMediaUrl } = require('../../tvguide-server.js');

const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_API_KEY: 'private-stash-key', STASH_URL: 'http://stash:9999', TVGUIDE_PUBLIC_URL: 'http://tvguide:9898' });
const at = new Date(2026, 9, 15).getTime();
const scene = (id, duration = 600) => ({ id, title: `Scene ${id}`, details: 'Details & <more>', files: [{ duration }], paths: { stream: `http://stash:9999/scene/${id}/stream` } });

function fixture({ lineup = [{ source: 'studio', ids: ['1', '2', '3'] }], prefs = {}, pinOrder = [], scenes = [scene('1'), scene('2')], count, fail = false } = {}) {
    const calls = [];
    const gql = async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes('Configuration')) return { configuration: { plugins: { TVGuide: { tvguide_state: {
            tvguide_lineup: JSON.stringify(lineup), tvguide_channel_prefs: JSON.stringify(prefs), tvguide_pin_order: JSON.stringify(pinOrder)
        } } } } };
        if (query.includes('TVGuideStudios')) {
            if (fail) throw new Error('offline');
            return { findStudios: { studios: ['1', '2', '3'].map((id) => ({ id, name: `Studio ${id}`, scene_count: 3, image_path: `http://stash:9999/studio/${id}/image?apikey=hidden` })) } };
        }
        if (query.includes('SceneCount')) return { findScenes: { count: count ?? scenes.length } };
        if (query.includes('ScenePool') || query.includes('SceneIndex')) return { findScenes: { scenes } };
        throw new Error(`Unexpected query: ${query}`);
    };
    return { gql, calls };
}

test('configuration validates secrets, URLs and resource limits', () => {
    assert.throws(() => readConfig({}), /TVGUIDE_TOKEN/);
    for (const [key, value] of [['STASH_URL', 'file:///tmp'], ['TVGUIDE_PUBLIC_URL', 'http://a/?secret=x'], ['TVGUIDE_MAX_STREAMS', '0'], ['TVGUIDE_EPG_DAYS', '8']]) {
        assert.throws(() => readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), [key]: value }));
    }
    assert.equal(config.port, 9898);
    assert.equal(stashMediaUrl(config, '/scene/1/stream'), 'http://stash:9999/scene/1/stream');
    assert.throws(() => stashMediaUrl(config, 'http://other/secret'));
});

test('Stash client sends ApiKey only in headers and surfaces HTTP/GraphQL errors', async () => {
    let seen;
    const gql = createStashClient(config, async (url, options) => { seen = { url, options }; return { ok: true, json: async () => ({ data: { ok: 1 } }) }; });
    assert.deepEqual(await gql('query X', { id: '1' }), { ok: 1 });
    assert.equal(seen.options.headers.ApiKey, 'private-stash-key');
    assert.equal(seen.url, 'http://stash:9999/graphql');
    await assert.rejects(createStashClient(config, async () => ({ ok: false, status: 401 }))('query X'), /401/);
    await assert.rejects(createStashClient(config, async () => ({ ok: true, json: async () => ({ errors: [{}] }) }))('query X'), /rejected/);
});

test('GraphQL HTTP validation errors retain status and explanation while redacting credentials', async () => {
    for (const status of [400, 422]) {
        const gql = createStashClient({ ...config, sessionCookie: 'session=private-cookie' }, async () => new Response(JSON.stringify({ errors: [
            { message: `Invalid variable filter; ${config.apiKey}; ${config.token}; private-cookie; https://stash/graphql?key=secret` }, null
        ] }), { status }));
        await assert.rejects(gql('query TVGuideSceneCount { invalid }'), (error) => {
            assert.match(error.message, new RegExp(`TVGuideSceneCount: Stash GraphQL HTTP ${status}: Invalid variable filter`));
            for (const secret of [config.apiKey, config.token, 'private-cookie', 'key=secret']) assert.ok(!error.message.includes(secret));
            return true;
        });
    }
    for (const body of ['<html>private secret</html>', JSON.stringify({ message: 'private secret' })]) {
        await assert.rejects(createStashClient(config, async () => new Response(body, { status: 500 }))('query X'),
            (error) => error.message === 'X: Stash GraphQL HTTP 500');
    }
});

test('generic GraphQL unknown-field messages include the rejected variable path with redaction', async () => {
    for (const status of [200, 400, 422]) {
        const gql = createStashClient(config, async () => new Response(JSON.stringify({ errors: [{
            message: 'unknown field', path: ['variable', 'filter', 'tags', 'invalid_field', config.apiKey]
        }] }), { status }));
        await assert.rejects(gql('query TVGuideSceneCount { findScenes { count } }'), (error) => {
            assert.match(error.message, /unknown field \(path: variable.filter.tags.invalid_field.\[redacted\]\)/);
            assert.ok(!error.message.includes(config.apiKey));
            return true;
        });
    }
});

test('stored lineup, pins, names, hidden channels and pool caps are respected', async () => {
    const { gql, calls } = fixture({ prefs: { 'studio:1': { name: 'Renamed', poolCap: 1 }, 'studio:2': { hidden: true } }, pinOrder: ['studio:3'] });
    const guide = await loadGuide(gql);
    assert.deepEqual(guide.channels.map((c) => c.id), ['studio:3', 'studio:1']);
    assert.equal(guide.channels[1].name, 'Renamed');
    await guide.getPlan(guide.channels[1], at);
    assert.equal(calls.find((c) => c.query.includes('ScenePool')).variables.find.per_page, 1);
    assert.equal(calls.find((c) => c.query.includes('ScenePool')).variables.find.sort, 'id');
});

test('a failed source does not publish a partial lineup', async () => {
    await assert.rejects(loadGuide(fixture({ fail: true }).gql), /complete/);
});

test('plans share concurrent loads, retry failures and rotate at the next local day', async () => {
    const { gql, calls } = fixture();
    let failing = true;
    const guide = await loadGuide(async (q, v) => {
        if (q.includes('SceneCount') && failing) { failing = false; throw new Error('temporary'); }
        return gql(q, v);
    });
    const channel = guide.channels[0];
    await assert.rejects(guide.getPlan(channel, at));
    const [a, b] = await Promise.all([guide.getPlan(channel, at), guide.getPlan(channel, at)]);
    assert.equal(a, b);
    await guide.getPlan(channel, nextMidnight(at));
    assert.equal(calls.filter((c) => c.query.includes('ScenePool')).length, 2);
});

test('daily midnight clips a programme and the next plan starts at midnight', async () => {
    const guide = await loadGuide(fixture({ scenes: [scene('long', 7 * 3600)] }).gql);
    const midnight = nextMidnight(at);
    const before = await guide.program(guide.channels[0], midnight - 1);
    const after = await guide.program(guide.channels[0], midnight);
    assert.equal(before.endMs, midnight);
    assert.equal(after.startMs, midnight);
    assert.equal(after.elapsedMs, 0);
});

test('All Scenes keeps its epoch and fetches its index once across exported days', async () => {
    const { gql, calls } = fixture({ lineup: [{ source: 'special', ids: ['all-scenes'] }], scenes: [scene('long', 7 * 3600)] });
    const guide = await loadGuide(gql);
    const midnight = nextMidnight(at);
    const before = await guide.program(guide.channels[0], midnight - 1);
    const after = await guide.program(guide.channels[0], midnight);
    assert.equal(before.startMs, after.startMs);
    assert.equal(before.endMs, after.endMs);
    assert.equal(calls.filter((c) => c.query.includes('SceneIndex')).length, 1);
});

test('M3U and XMLTV use identical IDs, UTF-8 text, token URLs and no Stash credentials', async () => {
    const guide = await loadGuide(fixture({ prefs: { 'studio:1': { name: 'Ä & <News> "quoted"\nInjected' }, 'studio:2': { hidden: true }, 'studio:3': { hidden: true } } }).gql);
    const m3u = renderM3u(guide.channels, config);
    const epg = await renderXmltv(guide, guide.channels, config, at, at + 3600000);
    assert.match(m3u, /tvg-id="studio:1"/);
    assert.match(m3u, /\/stream\/studio%3A1\.ts\?token=/);
    assert.match(m3u, /x-tvg-url="http:\/\/tvguide:9898\/epg.xml\?token=/);
    assert.match(epg, /channel id="studio:1"/);
    assert.match(epg, /Ä &amp; &lt;News&gt; &quot;quoted&quot;/);
    assert.match(epg, /Details &amp; &lt;more&gt;/);
    assert.equal(m3u.split('\n').length, 4);
    for (const secret of ['private-stash-key', 'apikey=hidden']) assert.ok(!m3u.includes(secret) && !epg.includes(secret));
    assert.equal(xml('a\u0000b\ud800c😀'), 'abc😀');
    assert.equal(xmlTime(Date.UTC(2026, 9, 15, 12, 30)), '20261015123000 +0000');
});

test('EPG exports more than 500 programmes without gaps, with future day plans', async () => {
    const guide = await loadGuide(fixture({ scenes: [scene('short', 30)] }).gql);
    const end = nextMidnight(nextMidnight(at));
    const epg = await renderXmltv(guide, [guide.channels[0]], config, at, end);
    const entries = [...epg.matchAll(/start="([^"]+)" stop="([^"]+)"/g)];
    assert.ok(entries.length >= 23 * 3600 * 2 / 30);
    for (let i = 1; i < entries.length; i++) assert.equal(entries[i][1], entries[i - 1][2]);
    assert.equal(entries.at(-1)[2], xmlTime(end));
});

test('unplayable channels are omitted consistently', async () => {
    const guide = await loadGuide(fixture({ scenes: [scene('zero', 0)] }).gql);
    assert.deepEqual(await playableChannels(guide, at), []);
    assert.equal(await guide.program(guide.channels[0], at), null);
});

test('DST days end at local midnight rather than after a fixed 24 hours', () => {
    const march = new Date(2026, 2, 29).getTime();
    const october = new Date(2026, 9, 25).getTime();
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Europe/Berlin') return;
    assert.equal(nextMidnight(march) - march, 23 * 3600000);
    assert.equal(nextMidnight(october) - october, 25 * 3600000);
});

