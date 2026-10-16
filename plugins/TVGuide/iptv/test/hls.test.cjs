const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { readConfig, createHlsService, streamChannel } = require('../../tvguide-server.js');

test('HLS shares one reserved slot, rewrites private paths, rejects stale segments and cleans up on close', async (t) => {
    const { EventEmitter } = require('node:events');
    const { Writable, Readable } = require('node:stream');
    const { writeFile } = require('node:fs/promises');
    let directory, active = 0, producers = 0, child;
    const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_API_KEY: 'secret-stash-key', TVGUIDE_PUBLIC_URL: 'http://live/prefix' });
    const service = createHlsService(config, {
        acquire: () => { if (active) return false; active++; return true; }, release: () => { active--; },
        spawnFn: (_binary, args) => {
            directory = require('node:path').dirname(args.at(-1));
            assert.equal(args[args.indexOf('-c') + 1], 'copy');
            assert.ok(!JSON.stringify(args).includes(config.apiKey));
            child = new EventEmitter();
            child.stderr = Readable.from([]);
            child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
            child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
            return child;
        },
        produce: async (_id, response) => {
            producers++;
            const files = [0, 1, 2].map((i) => `segment-${String(i).padStart(9, '0')}.ts`);
            for (const file of files) await writeFile(join(directory, file), Buffer.alloc(188, 0x47));
            await writeFile(join(directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + files.map((f) => `#EXTINF:2,\n${f}\n`).join(''));
            await once(response, 'close');
        }
    });
    t.after(() => service.close());
    const [first, second] = await Promise.all([service.playlist('tag:1', 'v1'), service.playlist('tag:1', 'v1')]);
    assert.equal(first.status, 200);
    assert.equal(first.body, second.body);
    assert.equal(producers, 1);
    assert.equal(active, 1);
    assert.equal((await service.playlist('tag:2', 'v2')).status, 503);
    const segment = new URL(first.body.split('\n').find((line) => line.startsWith('http:')));
    assert.equal(segment.searchParams.get('token'), config.token);
    assert.ok(!first.body.includes(directory));
    const [, generation, name] = /\/hls\/([^/]+)\/(.+)$/.exec(segment.pathname);
    assert.equal((await service.segment('tag:1', generation, name)).length, 188);
    assert.equal(await service.segment('tag:1', generation, '../index.m3u8'), null);
    assert.equal(await service.segment('tag:1', 'stale', name), null);
    assert.equal(await service.segment('missing', generation, name), null);
    service.close();
    assert.equal(active, 0);
    assert.equal(await service.segment('tag:1', generation, name), null);
    for (let i = 0; i < 20 && existsSync(directory); i++) await wait(30);
    assert.equal(existsSync(directory), false);
    await assert.rejects(service.playlist('tag:1', 'v1'), /stopped/);
});

test('HLS startup failures release slots, redact process details and allow a retry', async () => {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    let active = 0, starts = 0;
    const logs = [], directories = [];
    const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), FFMPEG_PATH: 'missing-secret-path' });
    const service = createHlsService(config, {
        acquire: () => { active++; return true; }, release: () => { active--; }, log: (line) => logs.push(line),
        produce: async (_channel, response) => { await once(response, 'close'); },
        spawnFn: (_binary, args) => {
            starts++;
            directories.push(require('node:path').dirname(args.at(-1)));
            const child = new EventEmitter();
            child.stdin = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { setImmediate(() => child.emit('close', null)); };
            setImmediate(() => child.emit('error', new Error('missing-secret-path token=secret')));
            return child;
        }
    });
    try {
        for (let i = 0; i < 2; i++) {
            assert.equal((await service.playlist('tag:1', 'v1')).status, 502);
            assert.equal(active, 0);
        }
        assert.equal(starts, 2);
        assert.equal(logs.length, 2);
        assert.ok(!logs.join('').includes('secret'));
        for (let i = 0; i < 20 && directories.some(existsSync); i++) await wait(30);
        assert.ok(directories.every((directory) => !existsSync(directory)));
    } finally { service.close(); }
});

test('HLS buffers real playable segments across a programme change, shares producers and reclaims idle slots',
    { skip: !process.env.FFMPEG_TEST_PATH, timeout: 45000 }, async (t) => {
    const binary = process.env.FFMPEG_TEST_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'tvguide-hls-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
    const run = (args) => {
        const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stderr?.toString());
        return result.stdout;
    };
    for (const color of ['red', 'blue']) {
        run(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(dir, `${color}.mp4`)]);
    }
    const media = createServer((req, res) => {
        assert.equal(req.headers.apikey, 'private-key');
        const body = readFileSync(join(dir, req.url.includes('red') ? 'red.mp4' : 'blue.mp4'));
        const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
        res.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
            ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
        res.end(body.subarray(start, end + 1));
    });
    media.listen(0, '127.0.0.1');
    await once(media, 'listening');
    t.after(() => { media.close(); media.closeAllConnections(); });
    const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_URL: `http://127.0.0.1:${media.address().port}`,
        STASH_API_KEY: 'private-key', TVGUIDE_PUBLIC_URL: 'http://tvguide:9898/prefix', FFMPEG_PATH: binary });
    const start = Date.now() - 1000;
    const guide = { channels: [{ id: 'tag:1' }], program: async (_channel, now) => {
        const index = Math.floor((now - start) / 8000);
        return { scene: { id: String(index), paths: { stream: `/${index % 2 ? 'blue' : 'red'}.mp4` } },
            startMs: start + index * 8000, endMs: start + (index + 1) * 8000 };
    } };
    let active = 0, producers = 0, privateDirectory;
    const service = createHlsService(config, { idleMs: 1200,
        acquire: () => { if (active) return false; active++; return true; }, release: () => { active--; },
        spawnFn: (binary, args, options) => {
            privateDirectory = require('node:path').dirname(args.at(-1));
            return require('node:child_process').spawn(binary, args, options);
        },
        produce: (channelId, response) => {
            producers++;
            return streamChannel({ response, config, channelId, getGuide: async () => guide });
        }
    });
    t.after(() => service.close());
    const first = await service.playlist('tag:1', 'virtual-id');
    assert.equal(first.status, 200, first.body);
    assert.ok((first.body.match(/^#EXTINF:/gm) || []).length >= 3);
    assert.ok(!first.body.includes('#EXT-X-ENDLIST'));
    assert.ok(!first.body.includes('private-key'));
    assert.equal((await service.playlist('other', 'other')).status, 503);
    const collected = new Map();
    const collect = async (playlist) => {
        for (const line of playlist.body.trim().split('\n').filter((line) => !line.startsWith('#'))) {
            const url = new URL(line);
            assert.equal(url.searchParams.get('token'), config.token);
            assert.ok(url.pathname.startsWith('/prefix/stashy/scene/virtual-id/hls/'));
            const [, generation, name] = /\/hls\/([^/]+)\/(.+)$/.exec(url.pathname);
            const body = await service.segment('tag:1', generation, name);
            assert.ok(body?.length > 188);
            assert.equal(body[0], 0x47);
            collected.set(name, body);
        }
    };
    await collect(first);
    // Polling the manifest renews one shared channel producer, not one encoder
    // per HTTP playlist/segment request or viewer.
    for (let i = 0; i < 8; i++) {
        await wait(600);
        const next = await service.playlist('tag:1', 'virtual-id');
        assert.equal(next.status, 200);
        await collect(next);
    }
    assert.equal(producers, 1);
    assert.equal(active, 1);
    assert.ok(collected.size <= 10);
    assert.equal(await service.segment('tag:1', 'missing', '../secret'), null);
    const transport = join(dir, 'buffer.ts');
    writeFileSync(transport, Buffer.concat([...collected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([,body])=>body)));
    const frames = run(['-i', transport, '-map', '0:v:0', '-vf', 'fps=1,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const pixels = [];
    for (let i = 0; i < frames.length; i += 3) pixels.push([...frames.subarray(i, i + 3)]);
    assert.ok(pixels.some(([r,,b]) => r > 180 && b < 80), 'first programme decodes');
    assert.ok(pixels.some(([r,,b]) => b > 180 && r < 80), 'second programme decodes');
    assert.ok(run(['-i', transport, '-map', '0:a:0', '-t', '3', '-f', 's16le', 'pipe:1']).length > 48000);
    await wait(2600);
    assert.equal(active, 0);
    for (let i = 0; i < 20 && existsSync(privateDirectory); i++) await wait(100);
    assert.equal(existsSync(privateDirectory), false, 'private rolling buffer is removed');
});
