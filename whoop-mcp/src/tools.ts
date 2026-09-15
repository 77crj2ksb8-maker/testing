import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WhoopClient, RangeQuery } from "./whoop/client.js";
import { formatCycle, formatRecovery, formatSleep, formatWorkout, localDay } from "./format.js";

/** Shared range arguments. `days` is the ergonomic path; start/end override it. */
const rangeShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(180)
    .optional()
    .describe("Look back this many days from now. Defaults to 7. Ignored if start is given."),
  start: z
    .string()
    .optional()
    .describe("ISO 8601 start datetime, inclusive. Overrides `days`."),
  end: z.string().optional().describe("ISO 8601 end datetime, exclusive. Defaults to now."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum records to return. Defaults to 200."),
};

type RangeArgs = {
  days?: number;
  start?: string;
  end?: string;
  limit?: number;
};

function resolveRange(args: RangeArgs): RangeQuery {
  const end = args.end ?? new Date().toISOString();
  const start =
    args.start ??
    new Date(Date.now() - (args.days ?? 7) * 24 * 60 * 60 * 1000).toISOString();
  const q: RangeQuery = { start, end };
  if (args.limit !== undefined) q.limit = args.limit;
  return q;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerWhoopTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_get_profile",
    {
      title: "Get WHOOP profile",
      description:
        "Get the WHOOP account holder's name, email, and user id. Use to confirm which account is connected.",
      inputSchema: {},
    },
    async () => json(await client.getProfile()),
  );

  server.registerTool(
    "whoop_get_body_measurement",
    {
      title: "Get body measurements",
      description:
        "Get height (metres), weight (kilograms), and max heart rate from the WHOOP profile.",
      inputSchema: {},
    },
    async () => json(await client.getBodyMeasurement()),
  );

  server.registerTool(
    "whoop_get_recovery",
    {
      title: "Get recovery records",
      description:
        "Recovery scores over a date range, including HRV (ms), resting heart rate, SpO2, and skin temperature. Use for questions about readiness, recovery trends, or HRV.",
      inputSchema: rangeShape,
    },
    async (args) => json((await client.getRecoveries(resolveRange(args))).map(formatRecovery)),
  );

  server.registerTool(
    "whoop_get_sleep",
    {
      title: "Get sleep records",
      description:
        "Sleep records over a date range with stage breakdown (light/deep/REM hours), sleep performance, efficiency, consistency, respiratory rate, and disturbances. Includes naps.",
      inputSchema: rangeShape,
    },
    async (args) => json((await client.getSleep(resolveRange(args))).map(formatSleep)),
  );

  server.registerTool(
    "whoop_get_cycles",
    {
      title: "Get physiological cycles",
      description:
        "WHOOP day cycles over a date range with day strain, average and max heart rate, and calories burned. A cycle is WHOOP's version of a day and may not align with midnight.",
      inputSchema: rangeShape,
    },
    async (args) => json((await client.getCycles(resolveRange(args))).map(formatCycle)),
  );

  server.registerTool(
    "whoop_get_workouts",
    {
      title: "Get workouts",
      description:
        "Workouts over a date range with sport, duration, strain, heart rate, calories, distance, and time in each heart rate zone.",
      inputSchema: rangeShape,
    },
    async (args) => json((await client.getWorkouts(resolveRange(args))).map(formatWorkout)),
  );

  server.registerTool(
    "whoop_daily_summary",
    {
      title: "Daily summary",
      description:
        "One row per day joining recovery, sleep, and strain — the best starting point for questions about trends, patterns, or 'how have I been doing'. Cheaper than calling the individual tools and correlating by hand.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Number of days back to summarise. Defaults to 14."),
      },
    },
    async (args) => {
      const days = args.days ?? 14;
      const range = resolveRange({ days, limit: 200 });

      // Fetched together so a slow endpoint does not serialise the whole summary.
      const [cycles, recoveries, sleeps, workouts] = await Promise.all([
        client.getCycles(range),
        client.getRecoveries(range),
        client.getSleep(range),
        client.getWorkouts(range),
      ]);

      const cycleById = new Map(cycles.map((c) => [c.id, c]));
      const sleepById = new Map(sleeps.map((s) => [s.id, s]));

      // Key off the cycle the recovery belongs to, which is how WHOOP itself
      // pairs a morning recovery with the night of sleep behind it.
      const rows = recoveries.map((r) => {
        const cycle = cycleById.get(r.cycle_id);
        const sleep = sleepById.get(r.sleep_id);
        const day = cycle
          ? localDay(cycle.start, cycle.timezone_offset)
          : sleep
            ? localDay(sleep.end, sleep.timezone_offset)
            : null;

        const fs = sleep ? formatSleep(sleep) : null;
        const fc = cycle ? formatCycle(cycle) : null;

        return {
          day,
          recovery_score: r.score?.recovery_score ?? null,
          hrv_ms: r.score?.hrv_rmssd_milli ? Math.round(r.score.hrv_rmssd_milli * 10) / 10 : null,
          resting_heart_rate: r.score?.resting_heart_rate ?? null,
          day_strain: fc?.strain ?? null,
          calories: fc?.calories ?? null,
          asleep_h: fs?.asleep_h ?? null,
          sleep_performance_pct: fs?.sleep_performance_pct ?? null,
          deep_h: fs?.deep_h ?? null,
          rem_h: fs?.rem_h ?? null,
          disturbances: fs?.disturbances ?? null,
          workouts: workouts.filter(
            (w) => localDay(w.start, w.timezone_offset) === day,
          ).length,
        };
      });

      rows.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));

      const scored = rows.filter((r) => r.recovery_score !== null);
      const avg = (pick: (r: (typeof rows)[number]) => number | null) => {
        const vals = rows.map(pick).filter((v): v is number => typeof v === "number");
        if (vals.length === 0) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      };

      return json({
        range: { start: range.start, end: range.end, days },
        days_returned: rows.length,
        averages: {
          recovery_score: avg((r) => r.recovery_score),
          hrv_ms: avg((r) => r.hrv_ms),
          resting_heart_rate: avg((r) => r.resting_heart_rate),
          day_strain: avg((r) => r.day_strain),
          asleep_h: avg((r) => r.asleep_h),
          sleep_performance_pct: avg((r) => r.sleep_performance_pct),
        },
        note:
          scored.length < rows.length
            ? `${rows.length - scored.length} day(s) have no recovery score yet (still scoring, or unscorable).`
            : undefined,
        days_detail: rows,
      });
    },
  );
}
