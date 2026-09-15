/**
 * Drives the built stdio server as a real subprocess over MCP, against a mock
 * WHOOP API. Covers protocol wiring, token refresh with rotation, pagination,
 * and the shape of what each tool returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockWhoop } from "./mock-whoop.mjs";

const SERVER = path.resolve("dist/stdio.js");

async function withServer({ expiresInMs = 3600_000 } = {}, fn) {
  const mock = await startMockWhoop();
  const dir = await mkdtemp(path.join(tmpdir(), "whoop-mcp-test-"));
  const tokenFile = path.join(dir, "tokens.json");

  await writeFile(
    tokenFile,
    JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: Date.now() + expiresInMs,
      scope: "offline",
      token_type: "bearer",
      client_id: "cid",
      client_secret: "csecret",
    }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      WHOOP_MCP_TOKEN_FILE: tokenFile,
      WHOOP_API_BASE: mock.apiBase,
      WHOOP_TOKEN_URL: mock.tokenUrl,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);

  try {
    return await fn({ client, mock, tokenFile });
  } finally {
    await client.close();
    await mock.close();
  }
}

const parse = (result) => JSON.parse(result.content[0].text);

test("exposes the expected tool set", async () => {
  await withServer({}, async ({ client }) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "whoop_daily_summary",
      "whoop_get_body_measurement",
      "whoop_get_cycles",
      "whoop_get_profile",
      "whoop_get_recovery",
      "whoop_get_sleep",
      "whoop_get_workouts",
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
    }
  });
});

test("fetches profile through the live token", async () => {
  await withServer({}, async ({ client }) => {
    const out = parse(await client.callTool({ name: "whoop_get_profile", arguments: {} }));
    assert.equal(out.user_id, 42);
    assert.equal(out.email, "a@b.com");
  });
});

test("paginates past the 25-record page cap", async () => {
  // The mock serves 2 records per page and holds 5 cycles, so this only passes
  // if next_token is followed.
  await withServer({}, async ({ client }) => {
    const out = parse(
      await client.callTool({ name: "whoop_get_cycles", arguments: { days: 30 } }),
    );
    assert.equal(out.length, 5, "should have followed next_token across 3 pages");
    assert.equal(out[0].strain, 10);
    assert.equal(out[0].calories, Math.round(8000 / 4.184));
  });
});

test("refreshes an expired token and persists the rotated pair", async () => {
  // Token already past the 5-minute skew window, so the first call must refresh.
  await withServer({ expiresInMs: 60_000 }, async ({ client, mock, tokenFile }) => {
    const out = parse(await client.callTool({ name: "whoop_get_profile", arguments: {} }));
    assert.equal(out.user_id, 42);
    assert.equal(mock.state.refreshCount, 1, "expected exactly one refresh");

    const saved = JSON.parse(await readFile(tokenFile, "utf8"));
    assert.equal(saved.refresh_token, "refresh-2", "rotated refresh token must be written to disk");
    assert.equal(saved.access_token, "access-2");
    assert.ok(saved.expires_at > Date.now() + 3_000_000, "expiry should be pushed out an hour");
    assert.equal(saved.client_id, "cid", "credentials must survive the rotation");
  });
});

test("concurrent calls on an expired token refresh only once", async () => {
  // Two parallel refreshes would race and invalidate each other's token.
  await withServer({ expiresInMs: 60_000 }, async ({ client, mock }) => {
    await Promise.all([
      client.callTool({ name: "whoop_get_profile", arguments: {} }),
      client.callTool({ name: "whoop_get_body_measurement", arguments: {} }),
      client.callTool({ name: "whoop_get_cycles", arguments: { days: 7 } }),
    ]);
    assert.equal(mock.state.refreshCount, 1, "single-flight should collapse concurrent refreshes");
  });
});

test("recovers from a 401 on a token that looked valid", async () => {
  await withServer({}, async ({ client, mock }) => {
    mock.state.expireOnce = true;
    const out = parse(await client.callTool({ name: "whoop_get_profile", arguments: {} }));
    assert.equal(out.user_id, 42, "should have refreshed and retried");
    assert.equal(mock.state.refreshCount, 1);
  });
});

test("converts sleep milliseconds into hours", async () => {
  await withServer({}, async ({ client }) => {
    const out = parse(await client.callTool({ name: "whoop_get_sleep", arguments: { days: 30 } }));
    const first = out[0];
    assert.equal(first.time_in_bed_h, 8);
    assert.equal(first.asleep_h, 7.5, "in-bed minus awake");
    assert.equal(first.deep_h, 1.5);
    assert.equal(first.rem_h, 2);
    assert.equal(first.respiratory_rate, 14.5);
  });
});

test("workout zone durations become minutes", async () => {
  await withServer({}, async ({ client }) => {
    const out = parse(
      await client.callTool({ name: "whoop_get_workouts", arguments: { days: 30 } }),
    );
    assert.equal(out[0].sport, "running");
    assert.equal(out[0].distance_km, 8);
    assert.equal(out[0].zone_minutes.zone_2, 20);
    assert.equal(out[0].duration_h, 1);
  });
});

test("daily summary joins recovery, sleep and strain per day", async () => {
  await withServer({}, async ({ client }) => {
    const out = parse(
      await client.callTool({ name: "whoop_daily_summary", arguments: { days: 30 } }),
    );
    assert.equal(out.days_returned, 5);
    assert.ok(Array.isArray(out.days_detail));

    const row = out.days_detail.at(-1);
    assert.ok(row.day, "each row needs a day");
    assert.ok(row.recovery_score !== null, "recovery should be joined");
    assert.ok(row.asleep_h !== null, "sleep should be joined by sleep_id");
    assert.ok(row.day_strain !== null, "strain should be joined by cycle_id");

    // Averages across the mock's 50,55,60,65,70 recovery scores.
    assert.equal(out.averages.recovery_score, 60);
    assert.ok(out.days_detail[0].day <= out.days_detail.at(-1).day, "rows sorted by day");
  });
});

test("surfaces a clear error when credentials are missing", async () => {
  const mock = await startMockWhoop();
  const dir = await mkdtemp(path.join(tmpdir(), "whoop-mcp-empty-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      WHOOP_MCP_TOKEN_FILE: path.join(dir, "nope.json"),
      WHOOP_API_BASE: mock.apiBase,
      WHOOP_TOKEN_URL: mock.tokenUrl,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);

  const res = await client.callTool({ name: "whoop_get_profile", arguments: {} });
  assert.ok(res.isError, "missing credentials should surface as a tool error");
  assert.match(res.content[0].text, /login/i, "error should tell the user how to fix it");

  await client.close();
  await mock.close();
});
