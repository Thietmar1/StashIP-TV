// Pass concrete filenames to Node: Windows cmd does not expand shell globs,
// and supported older Node versions do not expand them for --test either.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const files = readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => join(__dirname, name));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    stdio: 'inherit', windowsHide: true, env: process.env
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
