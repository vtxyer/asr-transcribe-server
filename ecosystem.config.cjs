module.exports = {
  apps: [{
    name: "asr-transcribe-server",
    script: "./server.mjs",
    cwd: __dirname,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_restarts: 20,
    min_uptime: 5000,
    kill_timeout: 5000,
    time: true,
    merge_logs: true,
  }],
};
