import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { StoredTokens, TokenStore } from "./types.js";

/**
 * Stores tokens in a single JSON file, owner-readable only (0600).
 *
 * Writes go to a temp file in the same directory and are renamed into place, so
 * an interrupted write cannot truncate an existing valid refresh token. Losing
 * that token means re-running the browser login, so it is worth the rename.
 */
export class FileTokenStore implements TokenStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.WHOOP_MCP_TOKEN_FILE ??
      path.join(homedir(), ".whoop-mcp", "tokens.json");
  }

  describe(): string {
    return this.filePath;
  }

  async load(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Token file at ${this.filePath} is not valid JSON. Delete it and run the login command again.`,
      );
    }

    const t = parsed as Partial<StoredTokens>;
    if (!t || typeof t.refresh_token !== "string" || typeof t.client_id !== "string") {
      throw new Error(
        `Token file at ${this.filePath} is missing required fields. Delete it and run the login command again.`,
      );
    }
    return t as StoredTokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Unique temp name so concurrent writers cannot clobber each other's temp file.
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    // rename preserves the temp file's mode, but be explicit in case the file
    // already existed with looser permissions.
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
