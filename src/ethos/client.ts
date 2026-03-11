// EthosApiClient — typed, rate-limited HTTP client for the Ethos public API.
// X-Ethos-Client header value: EthosiansSybilHunter

export interface EthosProfile {
  id: number;
  displayName: string;
  username: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'MERGED';
  score: number;
  userkeys: string[];
}

export interface EthosAddressData {
  primaryAddress: string | null;
  allAddresses: string[];
}

/**
 * Public interface used by ProfileSyncService (and testable with mocks).
 */
export interface IEthosApiClient {
  listAllProfiles(): AsyncGenerator<EthosProfile>;
  getProfileAddresses(profileId: number): Promise<EthosAddressData | null>;
  getProfile(profileId: number): Promise<EthosProfile | null>;
  fetchAddressesBatch(profileIds: number[]): Promise<Map<number, EthosAddressData>>;
}

interface ProfilesPageResponse {
  values: EthosProfile[];
  total: number;
  limit: number;
  offset: number;
}

interface AddressApiResponse {
  ok: boolean;
  data: {
    primaryAddress: string | null;
    allAddresses: string[];
  } | null;
}

interface UserApiResponse {
  ok: boolean;
  data: EthosProfile | null;
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

function createLimiter(max: number): Limiter {
  let running = 0;
  const queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];

  const next = (): void => {
    if (!queue.length || running >= max) return;
    running++;
    const item = queue.shift()!;
    item.fn().then(item.resolve, item.reject).finally(() => {
      running--;
      next();
    });
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        fn,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      next();
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EthosApiClientOptions {
  maxConcurrent?: number;
  sleepMs?: number;
  maxRetries?: number;
}

export class EthosApiClient implements IEthosApiClient {
  private readonly baseUrl = 'https://api.ethos.network';
  // Corrected client identifier — EthosiansSybilHunter
  private readonly clientHeader = 'EthosiansSybilHunter';
  private readonly maxConcurrent: number;
  private readonly sleepMs: number;
  private readonly maxRetries: number;
  private readonly limiter: Limiter;

  constructor(options?: EthosApiClientOptions) {
    this.maxConcurrent = options?.maxConcurrent ?? 20;
    this.sleepMs = options?.sleepMs ?? 150;
    this.maxRetries = options?.maxRetries ?? 3;
    this.limiter = createLimiter(this.maxConcurrent);
  }

  private get headers(): Record<string, string> {
    return {
      'X-Ethos-Client': this.clientHeader,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Paginate through all Ethos profiles.
   * GET /api/v2/profiles?limit=1000&offset=N
   */
  async *listAllProfiles(): AsyncGenerator<EthosProfile> {
    const limit = 1000;
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const url = `${this.baseUrl}/api/v2/profiles?limit=${limit}&offset=${offset}`;
      const res = await fetch(url, { headers: this.headers });

      if (!res.ok) {
        throw new Error(
          `[EthosApiClient] listAllProfiles failed: ${res.status} ${res.statusText}`,
        );
      }

      const json = (await res.json()) as ProfilesPageResponse;
      total = json.total;

      for (const profile of json.values) {
        yield profile;
      }

      offset += limit;

      if (offset < total) {
        await sleep(this.sleepMs);
      }
    }
  }

  /**
   * Get all wallet addresses for a profile.
   * GET /api/v1/addresses/profileId:{id}
   * Retries up to maxRetries times with exponential backoff (500ms * attempt).
   */
  async getProfileAddresses(profileId: number): Promise<EthosAddressData | null> {
    const url = `${this.baseUrl}/api/v1/addresses/profileId:${profileId}`;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, { headers: this.headers });

        if (res.status === 404) return null;

        if (!res.ok) {
          if (attempt < this.maxRetries) {
            await sleep(500 * attempt);
            continue;
          }
          console.warn(
            `[EthosApiClient] getProfileAddresses(${profileId}) failed after ${this.maxRetries} retries: ${res.status}`,
          );
          return null;
        }

        const json = (await res.json()) as AddressApiResponse;

        if (!json.ok || !json.data) return null;

        const { primaryAddress, allAddresses } = json.data;

        if (!allAddresses || allAddresses.length === 0) return null;

        return {
          primaryAddress: primaryAddress ?? null,
          allAddresses,
        };
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(500 * attempt);
        } else {
          console.warn(
            `[EthosApiClient] getProfileAddresses(${profileId}) threw after ${this.maxRetries} retries:`,
            err,
          );
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Fetch a single Ethos profile by numeric ID.
   * GET /api/v2/users/profileId:{id}
   */
  async getProfile(profileId: number): Promise<EthosProfile | null> {
    const url = `${this.baseUrl}/api/v2/users/profileId:${profileId}`;

    try {
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return null;

      const json = (await res.json()) as UserApiResponse;
      if (!json.ok || !json.data) return null;

      return json.data;
    } catch {
      return null;
    }
  }

  /**
   * Fetch addresses for a batch of profile IDs concurrently (max = maxConcurrent in-flight).
   */
  async fetchAddressesBatch(profileIds: number[]): Promise<Map<number, EthosAddressData>> {
    const results = new Map<number, EthosAddressData>();

    await Promise.all(
      profileIds.map((id) =>
        this.limiter(async () => {
          const data = await this.getProfileAddresses(id);
          if (data) results.set(id, data);
        }),
      ),
    );

    return results;
  }
}
