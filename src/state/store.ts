import type { Group, UserLookup } from '../types.js';
import { DEFAULT_DEMAND_TREND } from '../config.js';

export const state = {
  groups: [] as Group[],
  users: {} as Record<string, UserLookup>,
  numUsers: 0,
  gameStarted: false,
  gameEnded: false,
  currentDemandTrend: DEFAULT_DEMAND_TREND,
};
