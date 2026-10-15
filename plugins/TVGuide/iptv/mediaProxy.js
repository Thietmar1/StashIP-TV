import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { stashHeaders } from './config.js';

/** FFmpeg follows HTTP redirects, including custom headers. Keep Stash's API
 * key in Node and relay range requests through a private loopback endpoint. */
export async function createMediaProxy(config, upstreamUrl, fetchFn = fetch) {
    const path = `/${randomUUID()}/media`;
    const server = createServer(async (request, response) => {
        if (request.url !== path || !['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(404).end();
            return;
        }
        const controller = new AbortController();
        const headerTimer = setTimeout(() => controller.abort(), 30000);
        response.once('close', () => controller.abort());
        try {
            const upstream = await fetchFn(upstreamUrl, {
                method: request.method,
                headers: { ...stashHeaders(config), ...(request.headers.range ? { Range: request.headers.range } : {}) },
                redirect: 'error',
                signal: controller.signal
            });
            // Only the handshake has a deadline. A feature-length response must
            // remain open; FFmpeg's read timeout handles a stalled media body.
            clearTimeout(headerTimer);
            if (![200, 206, 416].includes(upstream.status)) throw new Error('Media unavailable');
            const headers = {};
            for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                const value = upstream.headers.get(name);
                if (value) headers[name] = value;
            }
            response.writeHead(upstream.status, headers);
            if (request.method === 'HEAD' || !upstream.body) response.end();
            else {
                const body = Readable.fromWeb(upstream.body);
                body.on('error', () => response.destroy());
                body.pipe(response);
            }
        } catch {
            if (response.headersSent) response.destroy();
            else response.writeHead(502).end();
        } finally { clearTimeout(headerTimer); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { url: `http://127.0.0.1:${server.address().port}${path}`, close() { server.close(); server.closeAllConnections(); } };
}
