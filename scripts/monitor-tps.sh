#!/bin/bash
# Lightweight TPS monitor — logs status (posted manually or via daily capture)
# Called from systemd timer (ethos-tps-monitor.timer)

PENDING=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='pending'" | tr -d ' ')
DONE=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='done'" | tr -d ' ')
FAILED=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='failed'" | tr -d ' ')

TOTAL=$((PENDING + DONE + FAILED))
COMPLETION=$(echo "scale=0; 100 * $DONE / $TOTAL" | bc 2>/dev/null || echo "0")
ETA_HOURS=$(echo "scale=0; ($PENDING / 330) / 3600" | bc 2>/dev/null || echo "?")

printf "[%s] TPS Monitor: pending=%d, done=%d, failed=%d, completion=%d%%, eta=%sh\n" \
  "$(date -u +'%Y-%m-%d %H:%M UTC')" \
  "$PENDING" "$DONE" "$FAILED" "$COMPLETION" "$ETA_HOURS" \
  >> /home/buzzers123/repos/ethos-wallet-intel/logs/monitor.log

# Also print for any calling context
printf "Pending: %d | Done: %d | Failed: %d | Completion: %d%% | ETA: ~%sh\n" \
  "$PENDING" "$DONE" "$FAILED" "$COMPLETION" "$ETA_HOURS"
