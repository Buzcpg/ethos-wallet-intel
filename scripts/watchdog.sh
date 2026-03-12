#!/bin/bash
# Watchdog: ensure ethos-wallet-intel worker stays alive via PM2
# Runs every 5 min via openclaw cron

REPO=/home/buzzers123/repos/ethos-wallet-intel
LOG=$REPO/logs/watchdog.log
TIMESTAMP=$(date -u +'%Y-%m-%d %H:%M UTC')

# Check if PM2 daemon is alive and app is online
pm2_online=$(/home/buzzers123/.npm-global/bin/pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
  procs=json.load(sys.stdin)
  app=[p for p in procs if p.get('name')=='ethos-wallet-intel']
  print('yes' if app and app[0].get('pm2_env',{}).get('status')=='online' else 'no')
except: print('no')
" 2>/dev/null || echo "no")

if [ "$pm2_online" = "yes" ]; then
  echo "[$TIMESTAMP] OK" >> "$LOG"
  exit 0
fi

# Dead — reset any stuck running jobs then restart
echo "[$TIMESTAMP] PM2 dead — resetting stuck jobs and restarting" >> "$LOG"

docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel \
  -c "UPDATE wallet_scan_jobs SET status='pending', started_at=NULL, updated_at=now() WHERE status='running'" \
  >> "$LOG" 2>&1

cd "$REPO" && /home/buzzers123/.npm-global/bin/pm2 start ecosystem.config.cjs >> "$LOG" 2>&1
/home/buzzers123/.npm-global/bin/pm2 save >> "$LOG" 2>&1

# Alert Discord
source ~/.config/openclaw/gateway.env 2>/dev/null || true
openclaw message send --channel discord --target 1481365308672446545 \
  --message "⚠️ **ethos-wallet-intel watchdog**: worker was dead — auto-restarted at $TIMESTAMP" 2>/dev/null || true
