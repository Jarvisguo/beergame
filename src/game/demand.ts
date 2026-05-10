import { DEMAND_PROFILES, DEFAULT_DEMAND_TREND } from '../config.js';

export function normalizeTrend(trend: string): string {
  return trend in DEMAND_PROFILES ? trend : DEFAULT_DEMAND_TREND;
}

export function customerDemand(week: number, trend: string): number {
  const profile = DEMAND_PROFILES[normalizeTrend(trend)];
  const entry = profile.schedule.find((e) => week < e.until);
  return entry ? entry.demand : profile.schedule[profile.schedule.length - 1].demand;
}
