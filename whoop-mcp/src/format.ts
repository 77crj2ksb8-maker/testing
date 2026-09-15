import type { Cycle, Recovery, Sleep, Workout } from "./whoop/types.js";

export function msToHours(ms: number | undefined | null): number | null {
  if (typeof ms !== "number") return null;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

export function kjToKcal(kj: number | undefined | null): number | null {
  if (typeof kj !== "number") return null;
  return Math.round(kj / 4.184);
}

export function round(n: number | undefined | null, places = 1): number | null {
  if (typeof n !== "number") return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Calendar day for a record, in the wearer's own timezone rather than UTC.
 * WHOOP returns offsets like "-0500"; a UTC-based date would put late-evening
 * activity on the wrong day for anyone west of Greenwich.
 */
export function localDay(iso: string, timezoneOffset?: string): string {
  const base = new Date(iso);
  if (!timezoneOffset) return base.toISOString().slice(0, 10);

  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(timezoneOffset.trim());
  if (!m) return base.toISOString().slice(0, 10);

  const [, sign, hh, mm] = m;
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  return new Date(base.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

export function formatRecovery(r: Recovery) {
  return {
    cycle_id: r.cycle_id,
    sleep_id: r.sleep_id,
    scored: r.score_state === "SCORED",
    recovery_score: r.score?.recovery_score ?? null,
    hrv_ms: round(r.score?.hrv_rmssd_milli, 1),
    resting_heart_rate: r.score?.resting_heart_rate ?? null,
    spo2_percentage: round(r.score?.spo2_percentage, 1),
    skin_temp_celsius: round(r.score?.skin_temp_celsius, 1),
    still_calibrating: r.score?.user_calibrating ?? null,
  };
}

export function formatSleep(s: Sleep) {
  const st = s.score?.stage_summary;
  const inBed = msToHours(st?.total_in_bed_time_milli);
  const awake = msToHours(st?.total_awake_time_milli);
  return {
    id: s.id,
    day: localDay(s.end, s.timezone_offset),
    start: s.start,
    end: s.end,
    nap: s.nap,
    scored: s.score_state === "SCORED",
    time_in_bed_h: inBed,
    asleep_h: inBed !== null && awake !== null ? round(inBed - awake, 2) : null,
    light_h: msToHours(st?.total_light_sleep_time_milli),
    deep_h: msToHours(st?.total_slow_wave_sleep_time_milli),
    rem_h: msToHours(st?.total_rem_sleep_time_milli),
    awake_h: awake,
    sleep_cycles: st?.sleep_cycle_count ?? null,
    disturbances: st?.disturbance_count ?? null,
    sleep_performance_pct: s.score?.sleep_performance_percentage ?? null,
    sleep_efficiency_pct: round(s.score?.sleep_efficiency_percentage, 1),
    sleep_consistency_pct: s.score?.sleep_consistency_percentage ?? null,
    respiratory_rate: round(s.score?.respiratory_rate, 1),
    sleep_needed_h: msToHours(
      s.score?.sleep_needed
        ? s.score.sleep_needed.baseline_milli +
            s.score.sleep_needed.need_from_sleep_debt_milli +
            s.score.sleep_needed.need_from_recent_strain_milli +
            s.score.sleep_needed.need_from_recent_nap_milli
        : null,
    ),
  };
}

export function formatCycle(c: Cycle) {
  return {
    id: c.id,
    day: localDay(c.start, c.timezone_offset),
    start: c.start,
    end: c.end ?? null,
    in_progress: !c.end,
    scored: c.score_state === "SCORED",
    strain: round(c.score?.strain, 1),
    average_heart_rate: c.score?.average_heart_rate ?? null,
    max_heart_rate: c.score?.max_heart_rate ?? null,
    calories: kjToKcal(c.score?.kilojoule),
  };
}

export function formatWorkout(w: Workout) {
  const z = w.score?.zone_durations;
  return {
    id: w.id,
    day: localDay(w.start, w.timezone_offset),
    sport: w.sport_name ?? null,
    start: w.start,
    end: w.end,
    duration_h: round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 3_600_000, 2),
    scored: w.score_state === "SCORED",
    strain: round(w.score?.strain, 1),
    average_heart_rate: w.score?.average_heart_rate ?? null,
    max_heart_rate: w.score?.max_heart_rate ?? null,
    calories: kjToKcal(w.score?.kilojoule),
    distance_km: round((w.score?.distance_meter ?? 0) / 1000, 2) || null,
    altitude_gain_m: round(w.score?.altitude_gain_meter, 0),
    percent_recorded: w.score?.percent_recorded ?? null,
    zone_minutes: z
      ? {
          zone_1: Math.round(z.zone_one_milli / 60000),
          zone_2: Math.round(z.zone_two_milli / 60000),
          zone_3: Math.round(z.zone_three_milli / 60000),
          zone_4: Math.round(z.zone_four_milli / 60000),
          zone_5: Math.round(z.zone_five_milli / 60000),
        }
      : null,
  };
}
