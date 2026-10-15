// Bundles src/ into the two root-level artifacts Stash loads: tvguide.js and
// tvguide.css. Both are build output and are gitignored; build_site.sh runs
// this before zipping.
import * as esbuild from 'esbuild';

const options = {
    entryPoints: ['src/index.js'],
    outfile: 'tvguide.js',
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    // Stash serves the bundle into a page it does not control the CSP of, so
    // everything must be inlined -- no code splitting, no external requests.
    loader: { '.css': 'css' },
    logLevel: 'info'
};

if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context({ ...options, sourcemap: 'inline' });
    await ctx.watch();
} else {
    await esbuild.build({ ...options, minify: true });
}

// Optional standalone companion. No npm modules are needed on the Stash host.
await esbuild.build({
    entryPoints: ['iptv/index.js'],
    outfile: 'tvguide-server.js',
    platform: 'node', target: ['node20'], format: 'cjs', bundle: true,
    logLevel: 'info'
});
