#!/bin/bash
# Signal quality monitor — posts to Discord every 5 mins

STATE=/home/buzzers123/repos/ethos-wallet-intel/logs/signal-state.json
CHANNEL=1481365308672446545
source ~/.config/openclaw/gateway.env 2>/dev/null

NOW=$(date +%s)
TIMESTAMP=$(date -u +'%H:%M UTC')

DONE=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='done'" | tr -d ' \n')
PENDING=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM wallet_scan_jobs WHERE status='pending'" | tr -d ' \n')
SIGNALS=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM first_funder_signals" | tr -d ' \n')
DEPOSITS=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM deposit_transfer_evidence" | tr -d ' \n')
PROFILE_MATCHES=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "SELECT COUNT(*) FROM profile_matches" | tr -d ' \n')

# Shared funders (same address funded 2+ wallets = sybil signal)
SHARED_FUNDERS=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "
SELECT COUNT(*) FROM (
  SELECT funder_address FROM first_funder_signals
  GROUP BY funder_address HAVING COUNT(DISTINCT wallet_id) >= 2
) x" | tr -d ' \n')

# Top shared funders
TOP_SHARED=$(docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -t -c "
SELECT funder_address || ' (' || COUNT(DISTINCT wallet_id) || ' wallets)'
FROM first_funder_signals
GROUP BY funder_address HAVING COUNT(DISTINCT wallet_id) >= 2
ORDER BY COUNT(DISTINCT wallet_id) DESC LIMIT 3" | sed 's/^ //' | paste -sd ' | ' -)

# Rate calc
RATE_STR="n/a"
ETA_STR="..."
if [ -f "$STATE" ]; then
  PREV_DONE=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('done',0))" 2>/dev/null)
  PREV_TS=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('ts',0))" 2>/dev/null)
  if [ -n "$PREV_DONE" ] && [ "$PREV_TS" -gt 0 ]; then
    ELAPSED=$((NOW - PREV_TS))
    DELTA=$((DONE - PREV_DONE))
    if [ "$ELAPSED" -gt 30 ] && [ "$DELTA" -gt 0 ]; then
      RATE_MIN=$(echo "scale=0; $DELTA * 60 / $ELAPSED" | bc)
      ETA_SECS=$(echo "scale=0; $PENDING * $ELAPSED / $DELTA" | bc)
      ETA_H=$((ETA_SECS / 3600))
      ETA_M=$(( (ETA_SECS % 3600) / 60 ))
      RATE_STR="${RATE_MIN}/min"
      ETA_STR="${ETA_H}h ${ETA_M}m"
    fi
  fi
fi
python3 -c "import json; json.dump({'done':${DONE},'ts':${NOW}}, open('$STATE','w'))"

MSG="**🔍 Wallet Intel — ${TIMESTAMP}**
\`\`\`
Scanned : ${DONE} / $((DONE + PENDING))  (${RATE_STR}, ETA ${ETA_STR})
Signals : ${SIGNALS} first-funders | ${DEPOSITS} deposits | ${PROFILE_MATCHES} profile matches
Sybil   : ${SHARED_FUNDERS} shared funders detected
\`\`\`"

if [ -n "$SHARED_FUNDERS" ] && [ "$SHARED_FUNDERS" -gt 0 ] && [ -n "$TOP_SHARED" ]; then
  MSG="${MSG}
**Top clusters:** \`${TOP_SHARED}\`"
fi

openclaw message send --channel discord --target "$CHANNEL" --message "$MSG"
