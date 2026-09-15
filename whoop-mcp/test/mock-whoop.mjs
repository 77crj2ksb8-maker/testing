/**
 * Minimal stand-in for the WHOOP API, good enough to exercise auth refresh,
 * pagination, and record shaping without touching the real service.
 */
import { createServer } from "node:http";

export function startMockWhoop({ pageSize = 2 } = {}) {
  const state = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    refreshCount: 0,
    requests: [],
    /** Force the next data request to 401, to exercise the retry path. */
    expireOnce: false,
  };

  const day = (n) => new Date(Date.UTC(2026, 8, 15 - n, 12)).toISOString();

  const cycles = Array.from({ length: 5 }, (_, i) => ({
    id: 1000 + i,
    user_id: 42,
    created_at: day(i),
    updated_at: day(i),
    start: day(i),
    end: day(i - 1),
    timezone_offset: "-05:00",
    score_state: "SCORED",
    score: { strain: 10 + i, kilojoule: 8000 + i * 100, average_heart_rate: 60 + i, max_heart_rate: 150 },
  }));

  const sleeps = Array.from({ length: 5 }, (_, i) => ({
    id: `sleep-${i}`,
    cycle_id: 1000 + i,
    user_id: 42,
    created_at: day(i),
    updated_at: day(i),
    start: day(i),
    end: day(i),
    timezone_offset: "-05:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28_800_000,
        total_awake_time_milli: 1_800_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 14_400_000,
        total_slow_wave_sleep_time_milli: 5_400_000,
        total_rem_sleep_time_milli: 7_200_000,
        sleep_cycle_count: 4,
        disturbance_count: 3 + i,
      },
      sleep_needed: {
        baseline_milli: 28_000_000,
        need_from_sleep_debt_milli: 500_000,
        need_from_recent_strain_milli: 200_000,
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 14.5,
      sleep_performance_percentage: 80 + i,
      sleep_consistency_percentage: 70,
      sleep_efficiency_percentage: 92.5,
    },
  }));

  const recoveries = Array.from({ length: 5 }, (_, i) => ({
    cycle_id: 1000 + i,
    sleep_id: `sleep-${i}`,
    user_id: 42,
    created_at: day(i),
    updated_at: day(i),
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 50 + i * 5,
      resting_heart_rate: 52 + i,
      hrv_rmssd_milli: 45.123 + i,
      spo2_percentage: 96.5,
      skin_temp_celsius: 33.4,
    },
  }));

  const workouts = [
    {
      id: "workout-0",
      user_id: 42,
      created_at: day(1),
      updated_at: day(1),
      start: day(1),
      end: new Date(Date.parse(day(1)) + 3_600_000).toISOString(),
      timezone_offset: "-05:00",
      sport_name: "running",
      sport_id: 0,
      score_state: "SCORED",
      score: {
        strain: 12.3,
        average_heart_rate: 140,
        max_heart_rate: 175,
        kilojoule: 2500,
        percent_recorded: 100,
        distance_meter: 8000,
        altitude_gain_meter: 50,
        zone_durations: {
          zone_zero_milli: 0, zone_one_milli: 600_000, zone_two_milli: 1_200_000,
          zone_three_milli: 1_200_000, zone_four_milli: 600_000, zone_five_milli: 0,
        },
      },
    },
  ];

  const collections = {
    "/developer/v2/cycle": cycles,
    "/developer/v2/recovery": recoveries,
    "/developer/v2/activity/sleep": sleeps,
    "/developer/v2/activity/workout": workouts,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Token endpoint: rotates the refresh token exactly like WHOOP does.
    if (url.pathname === "/oauth/oauth2/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        state.requests.push({ kind: "token", grant: form.get("grant_type") });
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== state.refreshToken) {
            return send(400, { error: "invalid_grant" });
          }
          state.refreshCount += 1;
          state.accessToken = `access-${state.refreshCount + 1}`;
          state.refreshToken = `refresh-${state.refreshCount + 1}`;
        }
        send(200, {
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          expires_in: 3600,
          scope: "read:recovery read:sleep read:cycles read:workout read:profile read:body_measurement offline",
          token_type: "bearer",
        });
      });
      return;
    }

    const auth = (req.headers.authorization ?? "").replace("Bearer ", "");
    state.requests.push({ kind: "api", path: url.pathname, token: auth });

    if (state.expireOnce) {
      state.expireOnce = false;
      return send(401, { error: "unauthorized" });
    }
    if (auth !== state.accessToken) return send(401, { error: "unauthorized" });

    if (url.pathname === "/developer/v2/user/profile/basic") {
      return send(200, { user_id: 42, email: "a@b.com", first_name: "Test", last_name: "User" });
    }
    if (url.pathname === "/developer/v2/user/measurement/body") {
      return send(200, { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 });
    }

    const all = collections[url.pathname];
    if (all) {
      const offset = Number(url.searchParams.get("nextToken") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), pageSize);
      const slice = all.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return send(200, {
        records: slice,
        next_token: nextOffset < all.length ? String(nextOffset) : null,
      });
    }

    send(404, { error: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        state,
        apiBase: `http://127.0.0.1:${port}/developer`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/oauth2/token`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
