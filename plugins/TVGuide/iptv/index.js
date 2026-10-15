import { readConfig } from './config.js';
import { createIptvServer } from './server.js';

export * from './config.js';
export * from './guide.js';
export * from './stream.js';
export * from './mediaProxy.js';
export * from './server.js';

// esbuild emits this entry as CommonJS. Importing it in tests never listens.
if (require.main === module) {
    try {
        const config = readConfig();
        const app = createIptvServer(config);
        app.server.on('error', () => { console.error('TVGuide IPTV: unable to listen'); process.exitCode = 1; });
        app.server.listen(config.port, config.host, () => console.log(`TVGuide IPTV listening on ${config.host}:${config.port}`));
        process.on('SIGINT', () => app.close());
        process.on('SIGTERM', () => app.close());
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
