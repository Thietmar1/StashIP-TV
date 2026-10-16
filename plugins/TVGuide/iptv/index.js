import { readConfig } from './config.js';
import { createIptvServer } from './server.js';
import { readInput, runPluginTask } from './pluginTask.js';

export * from './config.js';
export * from './guide.js';
export * from './stream.js';
export * from './mediaProxy.js';
export * from './server.js';
export * from './pluginTask.js';
export * from './stashy.js';

// esbuild emits this entry as CommonJS. Importing it in tests never listens.
if (require.main === module) {
    (async () => {
        if (process.argv.includes('--plugin-task')) {
            const result = await runPluginTask(await readInput());
            console.error(result.message);
            process.stdout.write(JSON.stringify({ output: result }));
            return;
        }
        const config = process.argv.includes('--plugin-server') ? await readInput() : readConfig();
        const app = createIptvServer(config);
        if (process.argv.includes('--plugin-server')) await app.getGuide();
        app.server.on('error', () => { console.error('TVGuide IPTV: unable to listen'); process.exitCode = 1; });
        app.server.listen(config.port, config.host, () => console.log(`TVGuide IPTV listening on ${config.host}:${config.port}`));
        process.on('SIGINT', () => app.close());
        process.on('SIGTERM', () => app.close());
    })().catch((error) => {
        const message = process.argv.includes('--plugin-task') ? error.message : 'TVGuide IPTV could not start; check settings and Stash connectivity.';
        if (process.argv.includes('--plugin-task')) process.stdout.write(JSON.stringify({ error: message }));
        console.error(message);
        process.exitCode = 1;
    });
}
