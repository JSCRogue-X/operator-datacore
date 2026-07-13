import pRetry, { AbortError } from 'p-retry';
import { setTimeout as sleep } from 'node:timers/promises';
import { getLwaAccessToken } from './auth.js';
import { SP_API_ENDPOINTS, SpApiRegion } from './endpoints.js';

export interface SpApiClientOptions {
  region: SpApiRegion;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SpApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
}

export interface SpApiResponse<T> {
  status: number;
  payload: T;
  rateLimit?: number;
}

export class SpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpApiError';
  }
}

export class SpApiClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: SpApiClientOptions) {
    this.baseUrl = SP_API_ENDPOINTS[opts.region];
  }

  async request<T>(req: SpApiRequest, retries = 10): Promise<SpApiResponse<T>> {
    return pRetry(
      async () => this.requestOnce<T>(req),
      {
        retries,
        minTimeout: 1_000,
        factor: 2,
        maxTimeout: 30_000,
        onFailedAttempt: async (err) => {
          if (err instanceof SpApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            // Permanent client errors (auth, malformed) — don't retry.
            throw new AbortError(err.message);
          }
          if (err instanceof SpApiError && err.status === 429) {
            // Reports API restores at 1 req/60s — wait 65s extra on top of backoff.
            console.log(`  [429] Rate limited on ${req.path} — waiting 65s before retry ${err.attemptNumber + 1}...`);
            await sleep(65_000);
          }
        },
      },
    );
  }

  private async requestOnce<T>(req: SpApiRequest): Promise<SpApiResponse<T>> {
    const token = await getLwaAccessToken({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      refreshToken: this.opts.refreshToken,
    });

    const url = new URL(this.baseUrl + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.append(k, String(v));
        }
      }
    }

    const init: RequestInit = {
      method: req.method,
      headers: {
        'x-amz-access-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'operator-datacore/0.1 (Language=TypeScript)',
      },
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    const res = await fetch(url.toString(), init);

    const rateLimit = parseFloat(res.headers.get('x-amzn-ratelimit-limit') ?? '');
    const text = await res.text();

    if (!res.ok) {
      throw new SpApiError(
        res.status,
        text,
        `SP-API ${req.method} ${req.path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    let payload: T;
    try {
      payload = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      payload = text as unknown as T;
    }

    const out: SpApiResponse<T> = { status: res.status, payload };
    if (Number.isFinite(rateLimit)) out.rateLimit = rateLimit;
    return out;
  }
}
