#!/bin/bash
# TPS monitor — posts to Discord every 30 mins
# Called from systemd timer (ethos-tps-monitor.timer)

LOG=/home/buzzers123/repos/ethos-wallet-intel/logs/monitor.log
STATE=/home/buzzers123/repos/ethos-wallet-intel/logs/monitor-state.json

PENDING=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='pending'" | tr -d ' \n')
DONE=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='done'" | tr -d ' \n')
FAILED=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='failed'" | tr -d ' \n')
RUNNING=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='running'" | tr -d ' \n')

TOTAL=$((PENDING + DONE + FAILED + RUNNING))
NOW=$(date +%s)
TIMESTAMP=$(date -u +'%H:%M UTC')

# Real throughput from saved state (done count 30 min ago)
RATE_STR="n/a"
ETA_STR="calculating..."
if [ -f "$STATE" ]; then
  PREV_DONE=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('done',0))" 2>/dev/null)
  PREV_TS=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('ts',0))" 2>/dev/null)
  if [ -n "$PREV_DONE" ] && [ -n "$PREV_TS" ] && [ "$PREV_TS" -gt 0 ]; then
    ELAPSED=$((NOW - PREV_TS))
    DELTA=$((DONE - PREV_DONE))
    if [ "$ELAPSED" -gt 60 ] && [ "$DELTA" -gt 0 ]; then
      RATE_MIN=$(echo "scale=0; $DELTA * 60 / $ELAPSED" | bc)
      RATE_SEC=$(echo "scale=1; $DELTA / $ELAPSED" | bc)
      ETA_SECS=$(echo "scale=0; $PENDING * $ELAPSED / $DELTA" | bc)
      ETA_H=$((ETA_SECS / 3600))
      ETA_M=$(( (ETA_SECS % 3600) / 60 ))
      RATE_STR="${RATE_MIN}/min (~${RATE_SEC}/sec)"
      ETA_STR="~${ETA_H}h ${ETA_M}m"
    fi
  fi
fi

# Persist current state for next run
python3 -c "import json; json.dump({'done': $DONE, 'ts': $NOW}, open('$STATE','w'))" 2>/dev/null

# Success/progress pct
if [ $((DONE + FAILED)) -gt 0 ]; then
  SUCCESS_RATE=$(echo "scale=1; 100 * $DONE / ($DONE + $FAILED)" | bc 2>/dev/null || echo "100")
else
  SUCCESS_RATE="100"
fi
PCT=$(echo "scale=1; 100 * $DONE / $TOTAL" | bc 2>/dev/null || echo "0")

# Log
printf "[%s] Done:%d Pending:%d Running:%d Failed:%d | Rate:%s | ETA:%s\n" \
  "$TIMESTAMP" "$DONE" "$PENDING" "$RUNNING" "$FAILED" "$RATE_STR" "$ETA_STR" >> "$LOG"

# Discord
source ~/.config/openclaw/gateway.env 2>/dev/null || true
if command -v openclaw &> /dev/null; then
  openclaw message send \
    --channel discord \
    --target 1481365308672446545 \
    --message "📊 **ethos-wallet-intel** [$TIMESTAMP]
✅ Done: $DONE  •  ⏳ Pending: $PENDING  •  ❌ Failed: $FAILED  •  🔄 Running: $RUNNING
Progress: ${PCT}%  •  Rate: $RATE_STR  •  ETA: $ETA_STR" 2>/dev/null || true
fi
