module.exports = {
  apps: [{
    name: 'ethos-wallet-intel',
    script: './node_modules/.bin/tsx',
    args: 'src/index.ts',
    cwd: '/home/buzzers123/repos/ethos-wallet-intel',
    exec_mode: 'fork',          // fork not cluster — single process ESM app
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    restart_delay: 5000,
    error_file: '/home/buzzers123/repos/ethos-wallet-intel/logs/error.log',
    out_file: '/home/buzzers123/repos/ethos-wallet-intel/logs/out.log',
    merge_logs: true,
    time: true,
  }],
};
