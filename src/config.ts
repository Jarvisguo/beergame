import type { DemandProfile } from './types.js';

export const INVENTORY_COST = 0.5;
export const BACKLOG_COST = 1;
export const STARTING_INVENTORY = 12;
export const STARTING_THROUGHPUT = 4;
export const MAX_WEEKS = 26;
export const DEFAULT_DEMAND_TREND = 'mixed';

export const BEER_NAMES = ['零售商', '批发商', '区域仓库', '工厂'];

export const DEMAND_PROFILES: Record<string, DemandProfile> = {
  growth: {
    name: '增长趋势',
    schedule: [
      { until: 4, demand: 4 }, { until: 8, demand: 6 },
      { until: 12, demand: 8 }, { until: 16, demand: 10 },
      { until: 20, demand: 12 }, { until: 24, demand: 14 },
      { until: 26, demand: 16 },
    ],
  },
  decline: {
    name: '下降趋势',
    schedule: [
      { until: 4, demand: 16 }, { until: 8, demand: 14 },
      { until: 12, demand: 12 }, { until: 16, demand: 10 },
      { until: 20, demand: 8 }, { until: 24, demand: 6 },
      { until: 26, demand: 4 },
    ],
  },
  mixed: {
    name: '混合趋势',
    schedule: [
      { until: 4, demand: 4 }, { until: 8, demand: 6 },
      { until: 12, demand: 8 }, { until: 16, demand: 10 },
      { until: 20, demand: 8 }, { until: 24, demand: 6 },
      { until: 26, demand: 4 },
    ],
  },
};

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

export const RECONNECT_GRACE_MS = (() => {
  const v = parseInt(process.env.MOBILE_RECONNECT_GRACE_MS || '300000', 10);
  return isNaN(v) || v < 0 ? 300000 : v;
})();

export const PORT = parseInt(process.env.PORT || '3000', 10);
