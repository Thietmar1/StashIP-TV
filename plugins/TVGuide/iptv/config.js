/** Configuration for the optional Node/FFmpeg companion; no Stash writes. */
function httpUrl(value, name) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${name} must be HTTP(S), without credentials, query or fragment`);
    }
    return url.href.replace(/\/$/, '');
}

function integer(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
}

export function readConfig(env = process.env) {
    const token = env.TVGUIDE_TOKEN || '';
    if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) throw new Error('TVGUIDE_TOKEN needs at least 24 letters, digits, hyphens or underscores');
    return {
        stashUrl: httpUrl(env.STASH_URL || 'http://127.0.0.1:9999', 'STASH_URL'),
        apiKey: env.STASH_API_KEY || '',
        publicUrl: httpUrl(env.TVGUIDE_PUBLIC_URL || 'http://127.0.0.1:9898', 'TVGUIDE_PUBLIC_URL'),
        host: env.TVGUIDE_HOST || '127.0.0.1',
        port: integer(env.TVGUIDE_PORT, 9898, 1, 65535, 'TVGUIDE_PORT'),
        days: integer(env.TVGUIDE_EPG_DAYS, 3, 1, 7, 'TVGUIDE_EPG_DAYS'),
        maxStreams: integer(env.TVGUIDE_MAX_STREAMS, 2, 1, 32, 'TVGUIDE_MAX_STREAMS'),
        ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
        token
    };
}

export function endpoint(config, path) {
    const url = new URL(`${config.publicUrl}${path}`);
    url.searchParams.set('token', config.token);
    return url.href;
}

/** Credentials are sent only to the configured Stash origin. */
export function stashMediaUrl(config, value) {
    const url = new URL(value, `${config.stashUrl}/`);
    if (url.origin !== new URL(config.stashUrl).origin || !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Stash returned a media URL outside STASH_URL; check its external host setting');
    }
    return url.href;
}

export function createStashClient(config, fetchFn = fetch) {
    return async (query, variables) => {
        const response = await fetchFn(`${config.stashUrl}/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { ApiKey: config.apiKey } : {}) },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error(`Stash GraphQL HTTP ${response.status}`);
        const body = await response.json();
        if (body.errors?.length || !body.data) throw new Error('Stash rejected the TVGuide GraphQL request');
        return body.data;
    };
}
