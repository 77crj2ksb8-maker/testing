/**
 * Persisted OAuth state.
 *
 * WHOOP rotates refresh tokens: every refresh returns a NEW refresh token and
 * invalidates the one used. So this must live in read-write storage — an
 * environment variable cannot work, because the rotated token would be lost on
 * the next cold start and the connection would break roughly an hour after setup.
 *
 * Client credentials are stored alongside the tokens because WHOOP requires
 * client_id and client_secret on every refresh, not just the initial exchange.
 */
export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds at which `access_token` expires. */
  expires_at: number;
  scope: string;
  token_type: string;
  client_id: string;
  client_secret: string;
}

/**
 * Storage seam. The local server uses a file in the user's home directory; a
 * remote deployment can implement this over Redis/KV without touching the
 * client, auth, or tool layers.
 */
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
  /** Human-readable location, for error messages. */
  describe(): string;
}
