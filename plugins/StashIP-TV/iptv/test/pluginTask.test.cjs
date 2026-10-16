const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pluginConfig, runPluginTask, readInput, createStashClient } = require('../../tvguide-server.js');
const token = 'plugin-test-token-'.repeat(3);
const settings = { iptv_03_public_url: 'http://192.168.1.50:9898', iptv_04_token: token, iptv_09_timezone: 'Europe/Berlin' };

test('Stash task config reads plugin settings with its session and preserves server credentials in memory', async () => {
    let bootstrap;
    const client = (config) => { bootstrap = config; return async () => ({ configuration: { plugins: { TVGuide: { ...settings, iptv_02_api_key: 'stash-key', iptv_07_epg_days: 5 } }, general: { ffmpegPath: '/usr/bin/ffmpeg' } } }); };
    const config = await pluginConfig({ server_connection: { Port: 9999, SessionCookie: { Name: 'session', Value: 'cookie-value' } } }, { client });
    assert.equal(bootstrap.sessionCookie, 'session=cookie-value');
    assert.equal(config.apiKey, 'stash-key');
    assert.equal(config.days, 5);
    assert.equal(config.ffmpeg, '/usr/bin/ffmpeg');
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.timezone, 'Europe/Berlin');
    assert.equal(config.stashyEnabled, false);
    await assert.rejects(pluginConfig({}, { client: () => async () => ({ configuration: { plugins: { TVGuide: { ...settings, iptv_03_public_url: '' } } } }) }), /Public URL/);
    await assert.rejects(pluginConfig({}, { client: () => async () => ({ configuration: { plugins: { TVGuide: { ...settings, iptv_09_timezone: 'not-a-zone' } } } }) }), /timezone/);
});

test('Stashy adapter must be explicitly enabled in plugin settings', async () => {
    for (const enabled of [true, false, undefined, 'true']) {
        const config = await pluginConfig({}, { client: () => async () => ({ configuration: {
            plugins: { TVGuide: { ...settings, iptv_12_stashy_adapter: enabled } }, general: {}
        } }) });
        assert.equal(config.stashyEnabled, enabled === true);
    }
});

test('Plex tuner settings require explicit enablement and trusted server IPs', async () => {
    const configured = (values) => pluginConfig({}, { client: () => async () => ({ configuration: {
        plugins: { TVGuide: { ...settings, ...values } }, general: {}
    } }) });
    assert.equal((await configured({})).tunerEnabled, false);
    assert.equal((await configured({ iptv_13_plex_tuner: 'true' })).tunerEnabled, false);
    await assert.rejects(configured({ iptv_13_plex_tuner: true }), /Allowed IPs/);
    const config = await configured({ iptv_13_plex_tuner: true, iptv_14_plex_clients: '192.168.178.30,192.168.178.31' });
    assert.equal(config.tunerEnabled, true);
    assert.deepEqual(config.tunerClients, ['192.168.178.30', '192.168.178.31']);
});

test('session-cookie auth is used only when an API key is absent', async () => {
    for (const apiKey of ['', 'key']) {
        let headers;
        const gql = createStashClient({ stashUrl: 'http://stash:9999', apiKey, sessionCookie: 'session=test' }, async (_url, opts) => {
            headers = opts.headers;
            return { ok: true, json: async () => ({ data: {} }) };
        });
        await gql('query X');
        if (apiKey) { assert.equal(headers.ApiKey, 'key'); assert.equal(headers.Cookie, undefined); }
        else assert.equal(headers.Cookie, 'session=test');
    }
});

test('Stash NUMBER defaults of zero or blank use documented defaults without accepting invalid nonzero values', async () => {
    const configured = async (values) => pluginConfig({}, { client: () => async () => ({ configuration: {
        plugins: { TVGuide: { ...settings, ...values } }, general: {}
    } }) });
    for (const value of [0, '0', '', '  ', null, undefined]) {
        const config = await configured({ iptv_06_port: value, iptv_07_epg_days: value, iptv_08_max_streams: value, iptv_11_first_channel_number: value });
        assert.equal(config.port, 9898);
        assert.equal(config.days, 3);
        assert.equal(config.maxStreams, 2);
        assert.equal(config.firstChannelNumber, 12);
    }
    const custom = await configured({ iptv_06_port: 9000, iptv_07_epg_days: 7, iptv_08_max_streams: 4, iptv_11_first_channel_number: 42 });
    assert.equal(custom.port, 9000);
    assert.equal(custom.days, 7);
    assert.equal(custom.maxStreams, 4);
    assert.equal(custom.firstChannelNumber, 42);
    for (const [key, value] of [['iptv_06_port', -1], ['iptv_07_epg_days', 8], ['iptv_08_max_streams', 'invalid'], ['iptv_11_first_channel_number', -1], ['iptv_11_first_channel_number', 1000000]]) {
        await assert.rejects(configured({ [key]: value }), /Invalid/);
    }
});

test('raw task input is parsed as JSON and malformed/oversized input is rejected', async () => {
    assert.deepEqual(await readInput(Readable.from(['{"args":', '{"operation":"status"}}'])), { args: { operation: 'status' } });
    await assert.rejects(readInput(Readable.from(['bad-json'])));
    await assert.rejects(readInput(Readable.from(['x'.repeat(2 * 1024 * 1024 + 1)])), /limit/);
});

test('raw task JSON retains UTF-8 characters split between stream chunks on all platforms', async () => {
    const value = { path: 'C:\\Videos\\Überblick\\日本語', title: 'Chaîne 📺' };
    const bytes = Buffer.from(JSON.stringify(value));
    const chunks = [...bytes].map((byte) => Buffer.from([byte]));
    assert.deepEqual(await readInput(Readable.from(chunks)), value);
});

async function temp(t) {
    const root = await mkdtemp(join(tmpdir(), 'StashIP-TV tasks Ü with spaces-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections(); });
    return server.address().port;
}

test('real detached Stash plugin tasks start, report, restart and stop the packaged server', { timeout: 20000 }, async (t) => {
    const root = await temp(t);
    const free = createServer();
    free.listen(0, '127.0.0.1');
    await once(free, 'listening');
    const port = free.address().port;
    await new Promise((resolve) => free.close(resolve));
    const config = { ...settings, iptv_02_api_key: 'secret-api-key', iptv_05_host: '127.0.0.1', iptv_06_port: port,
        iptv_03_public_url: `http://127.0.0.1:${port}`, tvguide_state: { tvguide_lineup: JSON.stringify([{ source: 'studio', ids: ['1'] }]) } };
    const seen = [];
    let failPool = false;
    const stash = createServer(async (req, res) => {
        let raw = '';
        for await (const part of req) raw += part;
        seen.push(req.headers);
        const { query } = JSON.parse(raw);
        if (failPool && query.includes('SceneCount')) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ errors: [{
                message: `Invalid scene criterion; secret-api-key; ${token}; task-session`
            }] }));
            return;
        }
        const data = query.includes('Configuration') ? { configuration: { plugins: { TVGuide: config }, general: {} } }
            : query.includes('Studios') ? { findStudios: { studios: [{ id: '1', name: 'Test Channel', scene_count: 1 }] } }
            : query.includes('SceneCount') ? { findScenes: { count: 1 } }
            : { findScenes: { scenes: [{ id: '1', title: 'Test Show', files: [{ duration: 600 }], paths: { stream: '/scene/1/stream' } }] } };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    });
    const stashPort = await listen(t, stash);
    const input = { server_connection: { Dir: root, Port: stashPort, SessionCookie: { Name: 'session', Value: 'task-session' } }, args: {} };
    const commandLines = [];
    const script = join(root, 'plugin server Ü.js');
    await copyFile(require.resolve('../../tvguide-server.js'), script);
    const options = { script, checkBinary: () => true,
        spawnFn: (binary, args, opts) => { commandLines.push([binary, ...args]); return spawn(binary, args, opts); } };
    const task = (operation) => runPluginTask({ ...input, args: { operation } }, options);
    t.after(async () => { await task('stop').catch(() => {}); });
    assert.equal((await task('status')).running, false);
    const first = await task('start');
    assert.equal(first.running, true);
    assert.match(first.playlist, /playlist\.m3u\?token=/);
    assert.equal((await task('start')).pid, first.pid);
    assert.equal((await task('status')).pid, first.pid);
    const playlist = await fetch(first.playlist);
    assert.equal(playlist.status, 200);
    assert.match(await playlist.text(), /tvg-id="studio:1"/);
    const privateState = await readFile(join(root, 'tvguide-iptv/server.json'), 'utf8');
    for (const secret of ['secret-api-key', 'task-session', token]) {
        assert.ok(!privateState.includes(secret));
        assert.ok(!JSON.stringify(commandLines).includes(secret));
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/control/stop?token=${token}`, { method: 'POST' })).status, 401);
    const next = await task('restart');
    assert.equal(next.running, true);
    assert.notEqual(next.pid, first.pid);
    failPool = true;
    assert.equal((await fetch(next.playlist)).status, 502);
    const logPath = join(root, 'tvguide-iptv/server.log');
    let diagnostics = '';
    for (let i = 0; i < 50; i++) {
        diagnostics = await readFile(logPath, 'utf8');
        if (diagnostics.includes('Invalid scene criterion')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(diagnostics, /TVGuideSceneCount.*HTTP 400.*Invalid scene criterion/);
    for (const secret of ['secret-api-key', 'task-session', token]) assert.ok(!diagnostics.includes(secret));
    failPool = false;
    await task('restart');
    assert.equal(await readFile(logPath, 'utf8'), '');
    assert.ok(seen.some((headers) => headers.cookie === 'session=task-session'));
    assert.ok(seen.some((headers) => headers.apikey === 'secret-api-key'));
    assert.equal((await task('stop')).running, false);
    assert.equal((await task('status')).running, false);
});

test('stale instance state never stops a different service or signals a reused PID', async (t) => {
    const root = await temp(t);
    let stopRequests = 0;
    const other = createServer((req, res) => {
        if (req.method === 'POST') stopRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ instanceId: 'another-instance' }));
    });
    const port = await listen(t, other);
    const dir = join(root, 'tvguide-iptv');
    await mkdir(dir);
    await writeFile(join(dir, 'server.json'), JSON.stringify({ controlUrl: `http://127.0.0.1:${port}`, controlToken: 'stale', instanceId: 'old-instance', pid: process.pid }));
    const result = await runPluginTask({ server_connection: { Dir: root }, args: { operation: 'stop' } });
    assert.equal(result.running, false);
    assert.equal(stopRequests, 0);
});

test('invalid task arguments, unavailable FFmpeg and concurrent tasks fail without spawning', async (t) => {
    const root = await temp(t);
    await assert.rejects(runPluginTask({ args: { operation: 'unknown' } }), /Unknown/);
    await assert.rejects(runPluginTask({ args: { operation: 'start' } }), /directory/);
    const input = { server_connection: { Dir: root }, args: { operation: 'start' } };
    await assert.rejects(runPluginTask(input, { configure: async () => ({ ffmpeg: 'missing' }), checkBinary: () => false }), /FFmpeg/);
    await writeFile(join(root, 'tvguide-iptv/task.lock'), 'busy');
    await assert.rejects(runPluginTask(input), /Another/);
});
