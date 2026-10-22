/* eslint-disable @typescript-eslint/no-require-imports -- PM2 loads this configuration as CommonJS. */
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

// PM2 can retain variables from its daemon or the invoking shell. Always prefer
// the selected release's shared environment when starting the production app.
const environmentFile = path.join(__dirname, '.env');
const databaseEnvironment = {};
if (fs.existsSync(environmentFile)) {
    const configured = parseEnv(fs.readFileSync(environmentFile, 'utf8'));
    for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
        let url;
        try { url = new URL(configured[key]); } catch { throw new Error(`Missing or invalid ${key}.`); }
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
            throw new Error(`Invalid ${key} database configuration.`);
        }
        databaseEnvironment[key] = configured[key];
    }
}

module.exports = {
    apps: [
        {
            name: "kedapp",

            // ecosystem.config.cjs 会和 server.js 一起位于 release 根目录
            cwd: __dirname,
            script: "server.js",

            instances: 1,
            exec_mode: "fork",

            autorestart: true,
            watch: false,

            env: {
                NODE_ENV: "production",
                HOSTNAME: "127.0.0.1",
                PORT: "3000",
                ...databaseEnvironment,
            },
        },
    ],
};
