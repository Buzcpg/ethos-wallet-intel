#!/bin/bash
# TPS monitor — posts to Discord every 30 mins
# Called from systemd timer (ethos-tps-monitor.timer)

PENDING=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='pending'" | tr -d ' ')
DONE=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='done'" | tr -d ' ')
FAILED=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='failed'" | tr -d ' ')

TOTAL=$((PENDING + DONE + FAILED))
SUCCESS_RATE=$(echo "scale=1; 100 * $DONE / ($DONE + $FAILED)" | bc 2>/dev/null || echo "0")
ETA_HOURS=$(echo "scale=1; $PENDING / 330 / 3600" | bc 2>/dev/null || echo "?")
TIMESTAMP=$(date -u +'%H:%M UTC')

# Log locally
printf "[%s] Total: %d | Done: %d | Failed: %d | Success rate: %s%% | ETA: %sh\n" \
  "$TIMESTAMP" "$TOTAL" "$DONE" "$FAILED" "$SUCCESS_RATE" "$ETA_HOURS" \
  >> /home/buzzers123/repos/ethos-wallet-intel/logs/monitor.log

# Post to Discord
source ~/.config/openclaw/gateway.env 2>/dev/null || true
if command -v openclaw &> /dev/null; then
  openclaw message send \
    --channel discord \
    --target 1481365308672446545 \
    --message "**ethos-wallet-intel** [$TIMESTAMP]
Total: $TOTAL | Done: $DONE | Failed: $FAILED
Success Rate: ${SUCCESS_RATE}% | ETA: ~${ETA_HOURS}h" 2>/dev/null || true
fi
