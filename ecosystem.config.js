module.exports = {
  apps: [
    {
      name: "moonbags",
      script: "node",
      args: "--dns-result-order=ipv4first --import tsx src/main.ts",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 15,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};