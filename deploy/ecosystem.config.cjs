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
            },
        },
    ],
};