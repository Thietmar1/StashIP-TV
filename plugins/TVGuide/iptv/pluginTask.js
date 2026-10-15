import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStashClient, readConfig } from './config.js';

// Stash's native settings form writes unset NUMBER fields as 0. At this UI
// boundary, zero/blank means the documented default; environment config remains
// strict, and negative/out-of-range nonzero values still fail validation.
function optionalNumber(value) {
    return value == null || (typeof value === 'string' && !value.trim()) || Number(value) === 0 ? undefined : value;
}

export async function readInput(input = process.stdin) {
    let text = '';
    for await (const chunk of input) {
        text += chunk;
        if (text.length > 2 * 1024 * 1024) throw new Error('Plugin input exceeds limit');
    }
    return JSON.parse(text);
}

/** Bootstrap from the documented Stash raw-task connection, without reading
 * config.yml or putting credentials in files/command-line arguments. */
export async function pluginConfig(input, { client = createStashClient } = {}) {
    const conn = input.server_connection || {};
    const cookie = conn.SessionCookie;
    const sessionCookie = cookie?.Name && cookie?.Value ? `${cookie.Name}=${cookie.Value}` : '';
    const localUrl = `${conn.Scheme || 'http'}://127.0.0.1:${conn.Port || 9999}`;
    const bootstrap = { stashUrl: localUrl, apiKey: conn.ApiKey || '', sessionCookie };
    const data = await client(bootstrap)('query TVGuideIPTVTaskConfiguration { configuration { plugins general { ffmpegPath } } }');
    const stored = data?.configuration?.plugins?.TVGuide;
    if (!stored || typeof stored !== 'object') throw new Error('TVGuide settings are unavailable in Stash');
    const config = readConfig({
        STASH_URL: stored.iptv_01_stash_url || localUrl,
        STASH_API_KEY: stored.iptv_02_api_key || conn.ApiKey || '',
        STASH_SESSION_COOKIE: sessionCookie,
        TVGUIDE_PUBLIC_URL: stored.iptv_03_public_url,
        TVGUIDE_TOKEN: stored.iptv_04_token,
        TVGUIDE_HOST: stored.iptv_05_host || '0.0.0.0',
        TVGUIDE_PORT: optionalNumber(stored.iptv_06_port),
        TVGUIDE_EPG_DAYS: optionalNumber(stored.iptv_07_epg_days),
        TVGUIDE_MAX_STREAMS: optionalNumber(stored.iptv_08_max_streams),
        TVGUIDE_FIRST_CHANNEL_NUMBER: optionalNumber(stored.iptv_11_first_channel_number),
        FFMPEG_PATH: stored.iptv_10_ffmpeg || data.configuration.general?.ffmpegPath || 'ffmpeg'
    });
    if (!stored.iptv_03_public_url) throw new Error('Set IPTV Public URL in TVGuide plugin settings to the Stash LXC address on port 9898');
    const timezone = stored.iptv_09_timezone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Invalid IPTV timezone'); }
    return { ...config, timezone };
}

async function readState(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function control(state, action = 'status') {
    if (!state) return null;
    // State is private, but still refuse non-HTTP/control paths when reading it.
    const base = new URL(state.controlUrl);
    if (base.protocol !== 'http:' || base.pathname !== '/' || base.search || base.username || base.password) throw new Error('Invalid IPTV control state');
    try {
        const response = await fetch(new URL(`/control/${action}`, base), {
            method: action === 'stop' ? 'POST' : 'GET',
            headers: { 'X-TVGuide-Control': state.controlToken },
            signal: AbortSignal.timeout(1500), redirect: 'error'
        });
        if (!response.ok) return null;
        const result = await response.json();
        return result.instanceId === state.instanceId ? result : null;
    } catch { return null; }
}

export async function runPluginTask(input, { script = process.argv[1], configure = pluginConfig, spawnFn = spawn, checkBinary = (binary) => spawnSync(binary, ['-version'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }).status === 0 } = {}) {
    const operation = input.args?.operation;
    if (!['start', 'stop', 'restart', 'status'].includes(operation)) throw new Error('Unknown IPTV plugin task');
    const root = input.server_connection?.Dir;
    if (!root) throw new Error('Stash did not provide its configuration directory');
    const dir = join(root, 'tvguide-iptv');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'server.json');
    const lockFile = join(dir, 'task.lock');
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - (await stat(lockFile)).mtimeMs < 120000) throw new Error('Another IPTV task is running; retry shortly');
        await unlink(lockFile);
        lock = await open(lockFile, 'wx', 0o600);
    }
    try {
        const previous = await readState(file);
        const running = await control(previous);
        if (operation === 'status') return { running: Boolean(running), ...running, message: running ? 'TVGuide IPTV is running.' : 'TVGuide IPTV is stopped.' };
        if (operation === 'start' && running) return { running: true, ...running, message: 'TVGuide IPTV is already running. Use Restart IPTV Server after changing settings.' };
        // Validate new settings before stopping a working server.
        const config = operation === 'stop' ? null : await configure(input);
        if (config && !checkBinary(config.ffmpeg)) throw new Error('FFmpeg is unavailable. Install ffmpeg or set IPTV FFmpeg Path.');
        if (running) {
            if (!await control(previous, 'stop')) throw new Error('Unable to stop the IPTV instance');
            for (let i = 0; i < 30 && await control(previous); i++) await delay(100);
            if (await control(previous)) throw new Error('IPTV server is still shutting down; retry shortly');
        }
        await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        if (operation === 'stop') return { running: false, message: 'TVGuide IPTV is stopped.' };
        const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
        const state = {
            controlUrl: `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`,
            controlToken: randomBytes(32).toString('hex'), instanceId: randomUUID()
        };
        // Only the private control credential is persisted. Stash credentials
        // and the Jellyfin access token stay in child memory/stdin.
        await writeFile(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        // Stash closes the raw task's pipes when the task finishes. Give the
        // detached daemon its own private stderr file instead of discarding
        // diagnostics or keeping those pipes open. Each start resets the log.
        const logFile = await open(join(dir, 'server.log'), 'w', 0o600);
        let child;
        try {
            child = spawnFn(process.execPath, [script, '--plugin-server'], {
                detached: true, windowsHide: true, stdio: ['pipe', 'ignore', logFile.fd],
                env: { ...process.env, TZ: config.timezone }
            });
        } finally { await logFile.close(); }
        let failed = false;
        child.once('error', () => { failed = true; });
        child.once('exit', () => { failed = true; });
        child.stdin.on('error', () => { failed = true; });
        child.stdin.end(JSON.stringify({ ...config, ...state }));
        child.unref();
        const deadline = Date.now() + 45000;
        while (!failed && Date.now() < deadline) {
            const ready = await control(state);
            if (ready) return { running: true, ...ready, message: 'TVGuide IPTV started. The Stash task is complete; the server runs in the background.' };
            await delay(100);
        }
        // This is the child just spawned, never a PID recovered from disk.
        child.kill();
        await unlink(file).catch(() => {});
        throw new Error('IPTV startup failed. Check Node.js 20+, Stash credentials, Public URL and whether the port is free.');
    } finally {
        await lock.close();
        await unlink(lockFile).catch(() => {});
    }
}

