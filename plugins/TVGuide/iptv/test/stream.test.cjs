const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { readConfig, ffmpegArgs, sendProgramme, streamChannel } = require('../../tvguide-server.js');
const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_API_KEY: 'secret' });

function response() {
    const chunks = [];
    const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
    res.writeHead = () => { res.headersSent = true; };
    res.chunks = chunks;
    return res;
}

function child() {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.stdout.end(); proc.emit('close', null); };
    return proc;
}

test('FFmpeg seeks before input, paces video, normalizes formats and marks TS discontinuities', () => {
    const args = ffmpegArgs(config, 'http://127.0.0.1:9999/scene/1/stream', 123.5, 456, 60, 33);
    assert.equal(args[args.indexOf('-ss') + 1], '123.500');
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
    assert.ok(args.includes('-re') && args.includes('libx264') && args.includes('aac'));
    assert.equal(args[args.indexOf('-output_ts_offset') + 1], '60.000');
    assert.equal(args[args.indexOf('-tables_version') + 1], '1');
    assert.ok(args.includes('+resend_headers+initial_discontinuity'));
    assert.equal(args.at(-1), 'pipe:1');
});

test('programme output does not end the channel connection, and removes close listeners', async () => {
    const res = response();
    const proc = child();
    const pending = sendProgramme({ response: res, config, args: [], durationMs: 100, spawnFn: () => proc });
    proc.stdout.write(Buffer.from('transport-stream'));
    proc.stdout.end();
    proc.emit('close', 0);
    assert.equal(await pending, true);
    assert.equal(Buffer.concat(res.chunks).toString(), 'transport-stream');
    assert.equal(res.writableEnded, false);
    assert.equal(res.listenerCount('close'), 0);
});

test('disconnect kills FFmpeg; missing binary and empty/error output fail cleanly', async () => {
    const res = response();
    const proc = child();
    const pending = sendProgramme({ response: res, config, args: [], durationMs: 100, spawnFn: () => proc });
    res.destroy();
    assert.equal(await pending, false);
    assert.equal(proc.killed, true);
    for (const kind of ['error', 'empty', 'failed']) {
        const p = child();
        const result = sendProgramme({ response: response(), config, args: [], durationMs: 100, spawnFn: () => p });
        if (kind === 'error') p.emit('error', new Error('not found'));
        else p.emit('close', kind === 'failed' ? 1 : 0);
        await assert.rejects(result, /FFmpeg/);
    }
});

test('a channel starts live and advances to the next programme with monotonic timestamps', async () => {
    let clock = 30000;
    const res = response();
    const calls = [];
    const guide = {
        channels: [{ id: 'studio:1' }],
        program: async () => ({ scene: { id: String(Math.floor(clock / 60000)), paths: { stream: '/scene/1/stream' } }, startMs: Math.floor(clock / 60000) * 60000, endMs: (Math.floor(clock / 60000) + 1) * 60000 })
    };
    await streamChannel({ response: res, config, channelId: 'studio:1', getGuide: async () => guide, now: () => clock, gql: async () => {}, send: async (input) => {
        calls.push(input);
        clock += input.durationMs;
        if (calls.length === 2) res.destroy();
        return true;
    } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[calls[0].args.indexOf('-ss') + 1], '30.000');
    assert.equal(calls[1].args[calls[1].args.indexOf('-ss') + 1], '0.000');
    assert.equal(calls[1].args[calls[1].args.indexOf('-output_ts_offset') + 1], '30.000');
});

test('summary scenes resolve details lazily and never forward credentials to another origin', async () => {
    const res = response();
    const guide = { channels: [{ id: 'special:all-scenes' }], program: async () => ({ scene: { id: '1', _summary: true }, startMs: 0, endMs: 60000 }) };
    let fetched = 0;
    await assert.rejects(streamChannel({ response: res, config, channelId: 'special:all-scenes', getGuide: async () => guide, now: () => 1000,
        gql: async () => { fetched++; return { findScene: { id: '1', paths: { stream: 'http://untrusted/stream' } } }; }, send: async () => assert.fail('must not spawn') }), /outside/);
    assert.equal(fetched, 1);
});

test('early EOF and empty or removed channels fail instead of looping', async () => {
    const guide = { channels: [{ id: 'x' }], program: async () => ({ scene: { id: '1', paths: { stream: '/scene/1/stream' } }, startMs: 0, endMs: 60000 }) };
    const args = { response: response(), config, channelId: 'x', getGuide: async () => guide, now: () => 1000, send: async () => true };
    await assert.rejects(streamChannel(args), /ended before/);
    await assert.rejects(streamChannel({ ...args, channelId: 'missing' }), /no longer/);
    guide.program = async () => null;
    await assert.rejects(streamChannel(args), /no playable/);
});
