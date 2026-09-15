import { WhoopAuth } from "./auth.js";
import type { TokenStore } from "../store/types.js";
import type {
  BodyMeasurement,
  Cycle,
  Paged,
  Recovery,
  Sleep,
  UserProfile,
  Workout,
} from "./types.js";

/** Overridable so tests can point at a local mock. */
export const WHOOP_API_BASE =
  process.env.WHOOP_API_BASE ?? "https://api.prod.whoop.com/developer";

/** WHOOP caps collection pages at 25 records. */
const MAX_PAGE_LIMIT = 25;
/** Safety valve so a wide date range cannot spin forever. */
const DEFAULT_MAX_RECORDS = 200;

export class WhoopApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WhoopApiError";
  }
}

export interface RangeQuery {
  /** ISO 8601; inclusive lower bound. */
  start?: string;
  /** ISO 8601; exclusive upper bound. */
  end?: string;
  /** Total records to return across pages. */
  limit?: number;
}

export class WhoopClient {
  private readonly auth: WhoopAuth;

  constructor(store: TokenStore) {
    this.auth = new WhoopAuth(store);
  }

  private async request<T>(pathname: string, params?: URLSearchParams): Promise<T> {
    const url = new URL(WHOOP_API_BASE + pathname);
    if (params) url.search = params.toString();

    let attempt = 0;
    // Attempts: initial, one retry after a forced refresh on 401, plus up to two
    // rate-limit backoffs.
    while (true) {
      attempt += 1;
      const token = await this.auth.getAccessToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      if (res.ok) return (await res.json()) as T;

      // The token looked valid locally but WHOOP disagrees - force one refresh
      // and retry before giving up.
      if (res.status === 401 && attempt === 1) {
        await this.auth.forceRefresh();
        continue;
      }

      if (res.status === 429 && attempt <= 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const body = await res.text();
      throw new WhoopApiError(
        `WHOOP API ${res.status} on ${pathname}: ${body.slice(0, 400)}`,
        res.status,
      );
    }
  }

  /** Walks `next_token` pages until `limit` records are collected or pages run out. */
  private async paginate<T>(pathname: string, query: RangeQuery = {}): Promise<T[]> {
    const target = Math.max(1, query.limit ?? DEFAULT_MAX_RECORDS);
    const out: T[] = [];
    let nextToken: string | undefined;

    while (out.length < target) {
      const params = new URLSearchParams();
      if (query.start) params.set("start", query.start);
      if (query.end) params.set("end", query.end);
      params.set("limit", String(Math.min(MAX_PAGE_LIMIT, target - out.length)));
      if (nextToken) params.set("nextToken", nextToken);

      const page = await this.request<Paged<T>>(pathname, params);
      out.push(...(page.records ?? []));

      if (!page.next_token || (page.records ?? []).length === 0) break;
      nextToken = page.next_token;
    }

    return out.slice(0, target);
  }

  getProfile(): Promise<UserProfile> {
    return this.request<UserProfile>("/v2/user/profile/basic");
  }

  getBodyMeasurement(): Promise<BodyMeasurement> {
    return this.request<BodyMeasurement>("/v2/user/measurement/body");
  }

  getCycles(q?: RangeQuery): Promise<Cycle[]> {
    return this.paginate<Cycle>("/v2/cycle", q);
  }

  getRecoveries(q?: RangeQuery): Promise<Recovery[]> {
    return this.paginate<Recovery>("/v2/recovery", q);
  }

  getSleep(q?: RangeQuery): Promise<Sleep[]> {
    return this.paginate<Sleep>("/v2/activity/sleep", q);
  }

  getWorkouts(q?: RangeQuery): Promise<Workout[]> {
    return this.paginate<Workout>("/v2/activity/workout", q);
  }
}
