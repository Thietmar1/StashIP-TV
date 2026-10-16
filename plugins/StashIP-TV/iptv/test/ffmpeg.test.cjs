// Optional real-media smoke test. Set FFMPEG_TEST_PATH to a local FFmpeg binary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Writable } = require('node:stream');
const { readConfig, streamChannel } = require('../../tvguide-server.js');

test('real FFmpeg keeps one decodable video/audio transport stream across a live programme change', { skip: !process.env.FFMPEG_TEST_PATH, timeout: 45000 }, async (t) => {
    const binary = process.env.FFMPEG_TEST_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'tvguide-iptv-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const run = (args) => {
        const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
        assert.equal(result.status, 0, `FFmpeg status=${result.status}, signal=${result.signal}, error=${result.error?.message || 'none'}\n${result.stderr?.toString() || ''}`);
        return result.stdout;
    };
    for (const color of ['red', 'blue']) {
        run(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(dir, `${color}.mp4`)]);
    }
    const media = createServer((req, res) => {
        assert.equal(req.headers.apikey, 'test-key');
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
    const config = readConfig({ TVGUIDE_TOKEN: 'a'.repeat(32), STASH_URL: `http://127.0.0.1:${media.address().port}`, STASH_API_KEY: 'test-key', FFMPEG_PATH: binary });
    const chunks = [];
    const response = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
    response.writeHead = () => { response.headersSent = true; };
    const start = Date.now() - 1000;
    const guide = {
        channels: [{ id: 'studio:1' }],
        program: async (_channel, now) => {
            const index = Math.floor((now - start) / 4000);
            return { scene: { id: String(index), paths: { stream: `/${index % 2 ? 'blue' : 'red'}.mp4` } }, startMs: start + index * 4000, endMs: start + (index + 1) * 4000 };
        }
    };
    const timer = setTimeout(() => response.destroy(), 6500);
    t.after(() => clearTimeout(timer));
    await streamChannel({ response, config, channelId: 'studio:1', getGuide: async () => guide });
    const transport = Buffer.concat(chunks);
    assert.ok(transport.length > 188 * 10);
    assert.equal(transport[0], 0x47); // MPEG-TS sync byte
    const file = join(dir, 'channel.ts');
    writeFileSync(file, transport);
    // Decode through the concatenation boundary, rather than checking only bytes.
    const frames = run(['-i', file, '-map', '0:v:0', '-vf', 'fps=1,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const pixels = [];
    for (let i = 0; i < frames.length; i += 3) pixels.push([...frames.subarray(i, i + 3)]);
    assert.ok(pixels.some(([r, g, b]) => r > 180 && b < 80), 'red first programme decoded');
    assert.ok(pixels.some(([r, g, b]) => b > 180 && r < 80), 'blue next programme decoded');
    const audio = run(['-i', file, '-map', '0:a:0', '-t', '5', '-f', 's16le', 'pipe:1']);
    assert.ok(audio.length > 48000, 'audio survives the programme switch');
});
