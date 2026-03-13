#!/bin/bash
# Watchdog: ensure ethos-wallet-intel stays alive via PM2
# Runs every 5 min via openclaw cron — handles crashes AND reboots

REPO=/home/buzzers123/repos/ethos-wallet-intel
LOG=$REPO/logs/watchdog.log
TIMESTAMP=$(date -u +'%Y-%m-%d %H:%M UTC')

notify_discord() {
  source ~/.config/openclaw/gateway.env 2>/dev/null || true
  openclaw message send --channel discord --target 1481365308672446545 \
    --message "$1" 2>/dev/null || true
}

# Ensure Docker + Postgres are up first
if ! docker ps --filter "name=ethos-intel-pg" --filter "status=running" -q | grep -q .; then
  echo "[$TIMESTAMP] Postgres not running — starting" >> "$LOG"
  docker start ethos-intel-pg >> "$LOG" 2>&1
  sleep 5
fi

# Check PM2 daemon + app status
pm2_status=$(/home/buzzers123/.npm-global/bin/pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
  procs=json.load(sys.stdin)
  app=[p for p in procs if p.get('name')=='ethos-wallet-intel']
  print('online' if app and app[0].get('pm2_env',{}).get('status')=='online' else 'dead')
except: print('dead')
" 2>/dev/null || echo "dead")

if [ "$pm2_status" = "online" ]; then
  echo "[$TIMESTAMP] OK" >> "$LOG"
  exit 0
fi

# Dead — reset stuck running jobs then restart
echo "[$TIMESTAMP] PM2 dead — resetting stuck jobs and restarting" >> "$LOG"

docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel \
  -c "UPDATE wallet_scan_jobs SET status='pending', started_at=NULL, updated_at=now() WHERE status='running'" \
  >> "$LOG" 2>&1

cd "$REPO" && /home/buzzers123/.npm-global/bin/pm2 start ecosystem.config.cjs >> "$LOG" 2>&1
/home/buzzers123/.npm-global/bin/pm2 save >> "$LOG" 2>&1

notify_discord "⚠️ **ethos-wallet-intel watchdog**: worker was dead — auto-restarted at $TIMESTAMP"
