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
        sessionCookie: env.STASH_SESSION_COOKIE || '',
        publicUrl: httpUrl(env.TVGUIDE_PUBLIC_URL || 'http://127.0.0.1:9898', 'TVGUIDE_PUBLIC_URL'),
        host: env.TVGUIDE_HOST || '127.0.0.1',
        port: integer(env.TVGUIDE_PORT, 9898, 1, 65535, 'TVGUIDE_PORT'),
        days: integer(env.TVGUIDE_EPG_DAYS, 3, 1, 7, 'TVGUIDE_EPG_DAYS'),
        maxStreams: integer(env.TVGUIDE_MAX_STREAMS, 2, 1, 32, 'TVGUIDE_MAX_STREAMS'),
        ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
        token
    };
}

export function stashHeaders(config) {
    return config.apiKey ? { ApiKey: config.apiKey } : config.sessionCookie ? { Cookie: config.sessionCookie } : {};
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

export class StashRequestError extends Error {}

/** Only explicitly sanitized API errors are eligible for detailed server logs. */
function apiMessage(config, text) {
    let message = String(text);
    const cookieValue = config.sessionCookie?.slice(config.sessionCookie.indexOf('=') + 1);
    for (const secret of [config.apiKey, config.sessionCookie, cookieValue, config.token]) {
        if (secret) message = message.split(secret).join('[redacted]');
    }
    return message.replace(/https?:\/\/[^\s<>"']+/gi, '[URL redacted]').slice(0, 1000);
}

function graphqlErrors(body) {
    if (!Array.isArray(body?.errors)) return '';
    return body.errors.map((error) => {
        const message = typeof error?.message === 'string' ? error.message : 'Unknown GraphQL error';
        // gqlgen often reports only "unknown field" in message and identifies
        // the rejected field in path, e.g. variable.filter.tags.some_field.
        const path = Array.isArray(error?.path) ? error.path.join('.') : '';
        return path ? `${message} (path: ${path})` : message;
    }).join('; ');
}

export function createStashClient(config, fetchFn = fetch) {
    return async (query, variables) => {
        const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || 'GraphQL';
        const fail = (message) => new StashRequestError(`${operation}: ${apiMessage(config, message)}`);
        let response;
        try { response = await fetchFn(`${config.stashUrl}/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...stashHeaders(config) },
            body: JSON.stringify({ query, variables }),
            redirect: 'error',
            signal: AbortSignal.timeout(30000)
        }); } catch { throw fail('Stash network request failed or timed out'); }
        if (!response.ok) {
            // GraphQL validation/variable errors can arrive with HTTP 400/422.
            // Preserve their explanation, using the same redaction as 200 errors.
            let body;
            try { body = await response.json(); } catch { /* HTML/plain HTTP errors have no GraphQL details. */ }
            const details = graphqlErrors(body);
            throw fail(`Stash GraphQL HTTP ${response.status}${details ? `: ${details}` : ''}`);
        }
        let body;
        try { body = await response.json(); } catch { throw fail('Stash returned invalid JSON'); }
        if (Array.isArray(body.errors) && body.errors.length) {
            throw fail(`Stash rejected the TVGuide GraphQL request: ${graphqlErrors(body)}`);
        }
        if (!body.data) throw fail('Stash rejected the TVGuide GraphQL request: no data returned');
        return body.data;
    };
}

