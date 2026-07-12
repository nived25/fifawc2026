export default {
  apps: [
    {
      name: 'fifa-scheduler',
      script: 'src/scheduler.js',
      node_args: '--env-file=.env',
      watch: false,
      autorestart: true
    },
    {
      name: 'fifa-server',
      script: 'src/server.js',
      node_args: '--env-file=.env',
      watch: false,
      autorestart: true
    }
  ]
};
