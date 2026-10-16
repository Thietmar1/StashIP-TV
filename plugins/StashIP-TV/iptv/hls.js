import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, chmod, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { endpoint } from './config.js';

export const hlsArgs = (directory) => [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-probesize', '1000000', '-analyzeduration', '1000000',
    '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_delete_threshold', '2',
    '-hls_flags', 'delete_segments+independent_segments+temp_file+omit_endlist',
    '-hls_segment_filename', join(directory, 'segment-%09d.ts'), join(directory, 'index.m3u8')
];

// One short-lived producer per watched channel. The second FFmpeg only remuxes
// the existing H.264/AAC output; it does not encode video again. Temporary files
// are private, bounded by the rolling playlist and removed after inactivity.
export function createHlsService(config, { produce, acquire, release, log = () => {},
    spawnFn = spawn, idleMs = 45000, startupMs = 25000, clock = Date.now } = {}) {
    const sessions = new Map();
    let closed = false;

    const stop = (session) => {
        if (session.stopped) return;
        session.stopped = true;
        if (sessions.get(session.channelId) === session) sessions.delete(session.channelId);
        session.response?.destroy();
        session.child?.kill('SIGKILL');
        if (session.reserved) { session.reserved = false; release(); }
        if (session.directory) {
            // Wait for FFmpeg to release its file handles before removing them.
            const done = session.childClosed || Promise.resolve();
            done.then(() => rm(session.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
                .catch(() => log('TVGuide HLS: temporary-file cleanup failed.'));
        }
    };
    const fail = (session) => {
        if (session.stopped) return;
        session.failed = true;
        log('TVGuide HLS: channel producer failed; check Stash connectivity and FFmpeg.');
        stop(session);
    };
    const start = async (session) => {
        session.directory = await mkdtemp(join(tmpdir(), 'tvguide-hls-'));
        if (process.platform !== 'win32') await chmod(session.directory, 0o700);
        if (session.stopped) {
            await rm(session.directory, { recursive: true, force: true });
            return;
        }
        const response = new PassThrough({ highWaterMark: 256 * 1024 });
        session.response = response;
        response.writeHead = () => { response.headersSent = true; };
        response.on('error', () => fail(session));
        const child = spawnFn(config.ffmpeg, hlsArgs(session.directory), {
            stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true
        });
        session.child = child;
        session.childClosed = new Promise((resolve) => child.once('close', resolve));
        child.stderr.resume(); // No input URLs or credentials in logs.
        child.stdin.on('error', () => fail(session));
        child.once('error', () => fail(session));
        child.once('close', () => fail(session));
        response.pipe(child.stdin);
        Promise.resolve().then(() => produce(session.channelId, response)).then(() => fail(session), () => fail(session));
    };
    const get = (channelId) => {
        if (closed) throw new Error('HLS service stopped');
        let session = sessions.get(channelId);
        if (!session) {
            if (!acquire()) return null;
            session = { channelId, generation: randomBytes(12).toString('hex'), touched: clock(), reserved: true, waiters: 0 };
            sessions.set(channelId, session);
            session.started = start(session).catch(() => fail(session));
        }
        session.touched = clock();
        return session;
    };
    const sweep = setInterval(() => {
        for (const session of sessions.values()) if (!session.waiters && clock() - session.touched > idleMs) stop(session);
    }, Math.min(idleMs, 5000));
    sweep.unref();

    return {
        async playlist(channelId, sceneId) {
            const session = get(channelId);
            if (!session) return { status: 503, body: 'Simultaneous stream limit reached\n' };
            session.waiters++;
            try {
                await session.started;
                const deadline = clock() + startupMs;
                while (!session.stopped && clock() < deadline) {
                    let playlist;
                    try { playlist = await readFile(join(session.directory, 'index.m3u8'), 'utf8'); }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                    // Three complete GOP-aligned segments give the player a real
                    // startup buffer, instead of pacing its decoder one frame at a time.
                    if (playlist && (playlist.match(/^#EXTINF:/gm) || []).length >= 3) {
                        session.touched = clock();
                        const lines = playlist.trim().split(/\r?\n/);
                        const body = lines.map((line) => {
                            if (!line || line.startsWith('#')) return line;
                            if (!/^segment-\d{9}\.ts$/.test(line)) throw new Error('Invalid HLS segment');
                            return endpoint(config, `/stashy/scene/${sceneId}/hls/${session.generation}/${line}`);
                        }).join('\n') + '\n';
                        return { status: 200, body };
                    }
                    await delay(100);
                }
                stop(session);
                return { status: 502, body: 'HLS channel could not start\n' };
            } finally { session.waiters--; session.touched = clock(); }
        },
        async segment(channelId, generation, name) {
            const session = sessions.get(channelId);
            if (!session || session.stopped || generation !== session.generation || !/^segment-\d{9}\.ts$/.test(name)) return null;
            session.touched = clock();
            try {
                const file = join(session.directory, name);
                if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('HLS segment exceeds limit');
                return await readFile(file);
            } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        close() {
            closed = true;
            clearInterval(sweep);
            for (const session of [...sessions.values()]) stop(session);
        }
    };
}
