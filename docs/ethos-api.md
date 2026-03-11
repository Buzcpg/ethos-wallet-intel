# Ethos API — Reference for ethos-wallet-intel

> LLM-ready reference committed to project memory.
> Sources: https://developers.ethos.network/
> OpenAPI spec: https://api.ethos.network/docs/openapi.json
> Full LLM docs: https://developers.ethos.network/llms-full.txt

---

## Base URL

```
https://api.ethos.network/api/v2
```

(v1 is deprecated but still used by Ethosians sync scripts for addresses — see below)

---

## Required Headers

Every request must include:

```http
X-Ethos-Client: ethos-wallet-intel@1.0.0
```

Requests without this header may be rate-limited. No auth token required for public endpoints.

---

## Userkey Formats

Many endpoints accept a `userkey` to identify a user:

| Format | Example |
|--------|---------|
| `profileId:<id>` | `profileId:10` |
| `address:<address>` | `address:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` |
| `service:discord:<id>` | `service:discord:797130033613242441` |
| `service:farcaster:<id>` | `service:farcaster:1112412` |
| `service:x.com:<id>` | `service:x.com:295218901` |
| `service:x.com:username:<username>` | `service:x.com:username:VitalikButerin` |

---

## Endpoints Used by ethos-wallet-intel

### Profile + Wallet Sync

#### GET /api/v1/addresses/profileId:{id}
> **Primary wallet sync endpoint** — confirmed used by Ethosians sync-addresses.js

Returns all wallet addresses linked to an Ethos profile.

**Response shape:**
```json
{
  "ok": true,
  "data": {
    "primaryAddress": "0x...",
    "allAddresses": ["0x...", "0x...", "..."]
  }
}
```

- `allAddresses`: every address linked to this profile
- `primaryAddress`: the main address (may be null; fallback to allAddresses[0])
- Returns `ok: false` or empty array if profile has no addresses

**Recommended concurrency:** max 20 simultaneous connections, 150ms between batches of 100 profiles
**Header:** `X-Ethos-Client: ethos-wallet-intel@1.0.0`

---

#### GET /api/v2/profiles (paginated)
> Use to enumerate all Ethos profiles for backfill

Query params:
- `limit` (max 1000, default 50)
- `offset` (default 0)

Returns paginated list of profiles. Use `total` in response to calculate pages.

Profile object includes:
- `id` — numeric profile ID (use as `profileId:N` userkey)
- `displayName`, `username`
- `status` — `ACTIVE` | `INACTIVE` | `MERGED`
- `score`
- `userkeys` — array of all associated userkeys including addresses
- `stats` — review counts, vouch totals

**Note:** MERGED profiles should still be tracked for wallet intel purposes.

---

#### GET /api/v2/users/{userkey}
> Resolve any userkey to a full user/profile object

Accepts any userkey format. Returns same shape as profiles list.

---

### Score & Credibility

#### GET /api/v2/score/{userkey}
> Get credibility score breakdown for a profile

Useful for enriching match evidence with credibility context.

---

## Pagination Pattern

Standard across all list endpoints:
```json
{
  "values": [...],
  "total": 40000,
  "limit": 1000,
  "offset": 0
}
```

Loop: `offset += limit` while `offset < total`.

---

## Rate Limiting

- No official rate limit published
- Ethosians uses: 20 concurrent HTTP connections, 150ms sleep between batches
- Always include `X-Ethos-Client` header to avoid anonymous rate limiting
- Implement exponential backoff on 429s

---

## Key Notes for ethos-wallet-intel

1. **Profile IDs are integers** — enumerate via `/api/v2/profiles` pagination
2. **One profile → multiple wallets** — `allAddresses` can have N entries across all chains
3. **`primaryAddress` may differ from allAddresses[0]** — store both; wallet_source = 'ethos_api'
4. **MERGED profiles** — include in wallet index; may share wallets with active profiles, sybil signal
5. **v1 addresses endpoint** is what Ethosians uses for daily sync — treat as canonical
6. **v2 has a `wallets` tag** — check for newer address resolution if needed

---

## Relevant API Doc Pages

- Profiles: https://developers.ethos.network/api-documentation/api-v2/profiles
- Users: https://developers.ethos.network/api-documentation/api-v2/users
- Wallets: https://developers.ethos.network/api-documentation/api-v2/wallets
- Score: https://developers.ethos.network/api-documentation/api-v2/score
- Slash: https://developers.ethos.network/api-documentation/api-v2/slash
- Full LLM index: https://developers.ethos.network/llms-full.txt
