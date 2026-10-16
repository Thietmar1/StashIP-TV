// Pass concrete filenames to Node: Windows cmd does not expand shell globs,
// and supported older Node versions do not expand them for --test either.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const files = readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => join(__dirname, name));
// Run media suites separately so concurrent encoders do not compete for a
// runner's CPU, and a leaked handle identifies its suite instead of hanging CI.
for (const file of files) {
    console.log(`\nIPTV suite: ${file}`);
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), file], {
        stdio: 'inherit', windowsHide: true, env: process.env, timeout: 120000, killSignal: 'SIGKILL'
    });
    if (result.error) console.error(`${file}: ${result.error.message}`);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
}
