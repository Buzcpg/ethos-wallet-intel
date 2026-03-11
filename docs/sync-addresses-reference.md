# sync-addresses.js Reference

> Documents the wallet sync pattern used by Ethosians (Buzcpg/Ethos-Webapp).
> File: scripts/sync-addresses.js
> This is the battle-tested pattern we mirror in ethos-wallet-intel.

---

## What It Does

Daily sync that fetches all wallet addresses for every Ethos profile and upserts them
into the Ethosians `addresses` table. Runs in production against ~40k profiles.

## API Endpoint Used

```
GET https://api.ethos.network/api/v1/addresses/profileId:{rawProfileId}
Header: X-Ethos-Client: Ethosians@v0.1
```

## Response Parsing

```js
const json = await res.json();
const allAddresses = json.data.allAddresses;           // all linked wallets
const primaryAddress = json.data.primaryAddress || allAddresses[0] || null;
const secondaryAddress = allAddresses.find(a => a !== primaryAddress) || null;
const additionalAddresses = allAddresses.filter(a => a !== primaryAddress && a !== secondaryAddress);
```

## Concurrency Model

- `MAX_CONCURRENT_REQUESTS = 20` — simultaneous HTTP connections
- `DEFAULT_CONCURRENCY_LIMIT = 100` — profiles per batch
- `DEFAULT_SLEEP_MS = 150` — sleep between batches
- `DEFAULT_BATCH_SIZE = 1000` — DB upsert batch size
- `DEFAULT_MAX_RETRIES = 3` — per address fetch
- `PAGE_SIZE = 1000` — profile ID pagination from DB

## Profile ID Source (Ethosians)

```sql
SELECT raw_profile_id FROM public.profiles_v2 
WHERE raw_profile_id IS NOT NULL 
ORDER BY raw_profile_id 
LIMIT $1 OFFSET $2
```

In ethos-wallet-intel we use the Ethos public API (`GET /api/v2/profiles`) instead
of the Ethosians DB, keeping the intel service fully independent.

## Ethosians DB Schema (addresses table)

```sql
INSERT INTO public.addresses (
  address_id,         -- uuidv5(`addr-${raw_profile_id}`, ADDRESS_NAMESPACE)
  raw_profile_id,     -- integer profile ID from Ethos
  profile_id,         -- uuidv5(raw_profile_id.toString(), PROFILE_NAMESPACE)
  primary_address,    -- text, lowercase
  secondary_address,  -- text, nullable
  additional_addresses, -- text[] or null
  created_at
)
ON CONFLICT (address_id) DO UPDATE SET ...
```

## Our Mapping (ethos-wallet-intel)

We use a simpler, more normalised model: one row per wallet address (not one row per profile).

- `profiles.external_profile_id` = Ethos `id` (integer as string)
- `wallets.address` = each entry in `allAddresses` (lowercased)
- `wallets.is_primary` = true if address === primaryAddress
- `wallets.wallet_source` = 'ethos_api'
- One wallet row per (address, chain) pair — same address appears once per chain

## Retry Pattern

```js
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    const res = await fetch(url, { headers: { 'X-Ethos-Client': '...' } });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return json.data;
  } catch (err) {
    if (attempt === maxRetries) return null;
    await sleep(500 * attempt);  // exponential: 500ms, 1000ms, 1500ms
  }
}
```
