import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchSceneDetails } from '../src/api/scenes.js';
import { stashMediaUrl } from './config.js';
import { createMediaProxy } from './mediaProxy.js';

/** Normalize each programme so one MPEG-TS connection can survive scene changes. */
export function ffmpegArgs(config, url, offsetSeconds, durationSeconds, timestampSeconds, version) {
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-rw_timeout', '15000000',
        '-re', '-ss', offsetSeconds.toFixed(3), '-i', url,
        '-t', durationSeconds.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '50', '-bf', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1:first_pts=0',
        '-mpegts_flags', '+resend_headers+initial_discontinuity',
        '-tables_version', String(version % 32),
        '-output_ts_offset', timestampSeconds.toFixed(3),
        '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1'
    ];
}

/** A child belongs to one viewer and is always reaped on disconnect or shutdown. */
export function sendProgramme({ response, config, args, durationMs, spawnFn = spawn }) {
    return new Promise((resolve, reject) => {
        const child = spawnFn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let received = false;
        let failed = false;
        // Wall-clock deadline also catches a stuck input/encoder. Backpressure
        // is handled by pipe, rather than accumulating video in Node's heap.
        const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, durationMs + 10000);
        const cancel = () => child.kill('SIGKILL');
        response.once('close', cancel);
        child.stderr.resume(); // Never log FFmpeg's URLs/headers (may contain credentials).
        child.stdout.once('data', () => {
            received = true;
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        });
        child.stdout.pipe(response, { end: false });
        const cleanup = () => {
            clearTimeout(timer);
            response.off('close', cancel);
            child.stdout.unpipe(response);
        };
        child.once('error', () => { cleanup(); reject(new Error('Unable to start FFmpeg')); });
        child.once('close', (code) => {
            cleanup();
            if (response.destroyed) resolve(false);
            else if (failed || code !== 0 || !received) reject(new Error('FFmpeg could not play the scheduled scene'));
            else resolve(true);
        });
        if (response.destroyed) cancel();
    });
}

export async function streamChannel({ response, config, channelId, getGuide, gql, now = Date.now, send = sendProgramme, proxy = createMediaProxy }) {
    const epoch = now();
    let version = 0;
    while (!response.destroyed) {
        const guide = await getGuide();
        const channel = guide.channels.find((c) => c.id === channelId);
        if (!channel) throw new Error('Channel is no longer available');
        let current = await guide.program(channel, now());
        if (!current) throw new Error('Channel has no playable scenes');
        const scene = current.scene._summary || !current.scene.paths?.stream
            ? await fetchSceneDetails(gql, current.scene.id) : current.scene;
        if (response.destroyed) break;
        const start = now();
        // Metadata can cross a programme/day boundary; never start the old one.
        if (start >= current.endMs) continue;
        const url = stashMediaUrl(config, scene.paths.stream);
        const durationMs = current.endMs - start;
        const relay = await proxy(config, url);
        let complete;
        try {
            const args = ffmpegArgs(config, relay.url, (start - current.startMs) / 1000, durationMs / 1000, (start - epoch) / 1000, version++);
            complete = await send({ response, config, args, durationMs });
        } finally { relay.close(); }
        if (!complete || response.destroyed) break;
        // A damaged/truncated file must not loop its tail until schedule time.
        const waitMs = current.endMs - now();
        if (waitMs > 2000) throw new Error('Scheduled scene ended before its declared duration');
        if (waitMs > 0) {
            const abort = new AbortController();
            const cancel = () => abort.abort();
            response.once('close', cancel);
            try { await delay(waitMs, undefined, { signal: abort.signal }); }
            catch (error) { if (error.name !== 'AbortError') throw error; }
            finally { response.off('close', cancel); }
        }
    }
}
