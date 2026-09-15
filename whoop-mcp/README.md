# whoop-mcp

A Model Context Protocol server that gives Claude read access to your WHOOP data:
recovery, sleep, strain, cycles, workouts, and body measurements.

Runs locally over stdio for Claude Desktop. The WHOOP client, tool definitions,
and token storage are kept separate from the transport, so a hosted HTTP
deployment can reuse everything except `src/stdio.ts`.

## What Claude can do once this is connected

Ask things like:

- "What's my recovery been for the last two weeks?"
- "Does my REM sleep track with my day strain?"
- "Which workouts cost me the most recovery the next morning?"
- "Am I sleeping less on nights after hard training days?"

## Setup

### 1. Create a WHOOP developer app

1. Go to <https://developer.whoop.com> and sign in with your WHOOP account.
2. Create a team if prompted, then create an app.
3. Set the redirect URI to exactly:

   ```
   http://127.0.0.1:8788/callback
   ```

   Use `127.0.0.1`, not `localhost` — they are not interchangeable to OAuth
   servers, and a mismatch here is the most common setup failure.
4. Enable these scopes: `read:profile`, `read:body_measurement`, `read:cycles`,
   `read:recovery`, `read:sleep`, `read:workout`.
5. Copy the **client ID** and **client secret**.

> If port 8788 is taken, set `WHOOP_REDIRECT_PORT` to a free port and register
> the matching redirect URI in the dashboard instead.

### 2. Build

```bash
cd whoop-mcp
npm install
npm run build
```

### 3. Authorise

```bash
WHOOP_CLIENT_ID=your_id WHOOP_CLIENT_SECRET=your_secret npm run login
```

This opens WHOOP's consent page, catches the redirect on the loopback listener,
and writes the token pair to `~/.whoop-mcp/tokens.json` with `0600` permissions.
If no browser opens (SSH, headless), the URL is printed — open it yourself.

You only do this once. The server refreshes tokens on its own from here.

### 4. Point Claude Desktop at it

Edit the MCP config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["/absolute/path/to/whoop-mcp/dist/stdio.js"]
    }
  }
}
```

Use an absolute path — a relative one resolves against Claude's working
directory, not yours. Restart Claude Desktop fully (quit, don't just close the
window), then check that `whoop` appears in the tools menu.

## Tools

| Tool | Purpose |
| --- | --- |
| `whoop_daily_summary` | One row per day joining recovery, sleep, and strain. Best starting point for trends. |
| `whoop_get_recovery` | Recovery score, HRV, resting heart rate, SpO2, skin temperature. |
| `whoop_get_sleep` | Stage breakdown in hours, performance, efficiency, consistency, disturbances. |
| `whoop_get_cycles` | Day strain, average/max heart rate, calories. |
| `whoop_get_workouts` | Sport, duration, strain, heart rate zones, distance. |
| `whoop_get_profile` | Name, email, user id. |
| `whoop_get_body_measurement` | Height, weight, max heart rate. |

Range tools accept `days` (default 7), or explicit ISO `start`/`end`, plus a
`limit`. Durations are converted to hours and kilojoules to calories, since the
raw API returns milliseconds and kilojoules.

## How tokens are handled

WHOOP rotates refresh tokens: each refresh returns a new refresh token and
invalidates the one just used. Two consequences shaped this design.

**Storage must be writable.** A token pasted into an environment variable works
until the first refresh, roughly an hour in, and then breaks permanently. Tokens
therefore live in a file that the server rewrites on every refresh. Writes go to
a temp file and are renamed into place, so a crash mid-write cannot destroy a
valid refresh token.

**Refreshes must not race.** Two concurrent refreshes would each invalidate the
other's token. `WhoopAuth` shares one in-flight refresh between concurrent
callers.

Access tokens last one hour and are refreshed five minutes early to absorb clock
skew. If WHOOP rejects the stored refresh token (revoked in the WHOOP app, or
unused long enough to expire), tools return an error telling you to re-run
`npm run login`.

`client_id` and `client_secret` are stored next to the tokens because WHOOP
requires them on every refresh, not just the initial exchange. The file is
`0600`, but it is plaintext credentials on disk — treat it accordingly.

## Testing

```bash
npm test
```

Runs the built server as a real subprocess over MCP against a mock WHOOP API,
covering tool registration, pagination across `next_token`, refresh with
rotation, single-flight concurrency, 401 recovery, unit conversion, and the
missing-credentials error path. No network access and no real account needed.

## Extending to a hosted deployment

`TokenStore` in `src/store/types.ts` is the only thing tied to local disk.
A hosted version needs:

1. A `TokenStore` backed by Redis/KV instead of `FileTokenStore`.
2. An HTTP entry point calling `createWhoopServer(store)` with the SDK's
   streamable HTTP transport.
3. Authentication in front of it. **The endpoint would serve your health data,
   so it must not be publicly reachable without a check.**

`src/whoop`, `src/tools.ts`, and `src/format.ts` need no changes.

## Troubleshooting

**"No WHOOP credentials found"** — `npm run login` has not been run, or Claude is
running as a different user than the one that owns `~/.whoop-mcp/tokens.json`.

**Redirect URI mismatch at the consent screen** — the dashboard value must match
`http://127.0.0.1:8788/callback` character for character.

**The server does not appear in Claude Desktop** — the config needs an absolute
path to `dist/stdio.js`, the project must be built, and Claude must be fully
quit and reopened.

**Tools return empty arrays** — WHOOP scores records asynchronously. Very recent
days can exist with `score_state` other than `SCORED` and no score attached.
