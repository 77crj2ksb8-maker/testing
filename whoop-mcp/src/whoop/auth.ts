import type { StoredTokens, TokenStore } from "../store/types.js";

export const WHOOP_AUTH_URL =
  process.env.WHOOP_AUTH_URL ?? "https://api.prod.whoop.com/oauth/oauth2/auth";
/** Overridable so tests can point at a local mock. */
export const WHOOP_TOKEN_URL =
  process.env.WHOOP_TOKEN_URL ?? "https://api.prod.whoop.com/oauth/oauth2/token";

/**
 * `offline` is what makes WHOOP return a refresh token at all. Without it the
 * grant expires in an hour and never comes back.
 */
export const WHOOP_SCOPES = [
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
  "offline",
] as const;

/** Refresh this far before actual expiry, to absorb clock skew and slow requests. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export class WhoopAuthError extends Error {
  constructor(
    message: string,
    readonly needsReauth: boolean = false,
  ) {
    super(message);
    this.name = "WhoopAuthError";
  }
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // invalid_grant means the refresh token is spent or revoked - no amount of
    // retrying fixes it, the user has to authorise again.
    const needsReauth = res.status === 400 && text.includes("invalid_grant");
    throw new WhoopAuthError(
      `WHOOP token request failed (${res.status}): ${text.slice(0, 500)}`,
      needsReauth,
    );
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new WhoopAuthError(`WHOOP returned a non-JSON token response: ${text.slice(0, 200)}`);
  }
}

export function toStoredTokens(
  res: TokenResponse,
  clientId: string,
  clientSecret: string,
): StoredTokens {
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    expires_at: Date.now() + res.expires_in * 1000,
    scope: res.scope,
    token_type: res.token_type,
    client_id: clientId,
    client_secret: clientSecret,
  };
}

/** Exchange an authorization code for the first token pair. Used by the login CLI. */
export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<StoredTokens> {
  const res = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
  );
  return toStoredTokens(res, opts.clientId, opts.clientSecret);
}

/**
 * Supplies a valid access token, refreshing when needed.
 *
 * Tokens are read from the store on every call rather than cached in memory, so
 * a separate `whoop-mcp-login` run is picked up immediately instead of being
 * overwritten by a stale in-process copy.
 */
export class WhoopAuth {
  /** In-flight refresh, shared by concurrent callers. */
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(private readonly store: TokenStore) {}

  async getAccessToken(): Promise<string> {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new WhoopAuthError(
        `No WHOOP credentials found at ${this.store.describe()}. Run "npm run login" to authorise.`,
        true,
      );
    }

    if (Date.now() < tokens.expires_at - EXPIRY_SKEW_MS) {
      return tokens.access_token;
    }

    const refreshed = await this.refresh(tokens);
    return refreshed.access_token;
  }

  /**
   * Refreshes regardless of local expiry. Used when WHOOP rejects a token that
   * still looked valid on this side (clock drift, or revocation elsewhere).
   */
  async forceRefresh(): Promise<string> {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new WhoopAuthError(
        `No WHOOP credentials found at ${this.store.describe()}. Run "npm run login" to authorise.`,
        true,
      );
    }
    const next = await this.refresh(tokens);
    return next.access_token;
  }

  /**
   * Refreshes the token pair. Concurrent callers share one request: WHOOP
   * invalidates the old refresh token on use, so two parallel refreshes would
   * race and leave one caller holding a dead token.
   */
  async refresh(current: StoredTokens): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const res = await postToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refresh_token,
          client_id: current.client_id,
          client_secret: current.client_secret,
          scope: "offline",
        }),
      );
      const next = toStoredTokens(res, current.client_id, current.client_secret);
      // Persist before returning: if the process dies here the rotated token is
      // already on disk, rather than lost with the old one invalidated.
      await this.store.save(next);
      return next;
    })();

    try {
      return await this.refreshing;
    } catch (err) {
      if (err instanceof WhoopAuthError && err.needsReauth) {
        throw new WhoopAuthError(
          `WHOOP rejected the stored refresh token. Run "npm run login" to authorise again. (${err.message})`,
          true,
        );
      }
      throw err;
    } finally {
      this.refreshing = null;
    }
  }
}
