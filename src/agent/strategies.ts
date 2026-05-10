import type { GameUser, Group } from '../types.js';
import { STARTING_THROUGHPUT } from '../config.js';

export interface AgentParams {
  safetyFactor?: number;
  safetyStock?: number;
  lookbackWeeks?: number;
  submitDelay?: number;
}

export type StrategyName = 'default' | 'conservative' | 'aggressive';

const PRESETS: Record<StrategyName, Required<Omit<AgentParams, 'submitDelay'>>> = {
  default:      { safetyFactor: 1.5, safetyStock: 4, lookbackWeeks: 4 },
  conservative: { safetyFactor: 1.0, safetyStock: 2, lookbackWeeks: 4 },
  aggressive:   { safetyFactor: 2.0, safetyStock: 8, lookbackWeeks: 4 },
};

export function resolveParams(strategy: StrategyName, overrides: AgentParams = {}): Required<AgentParams> {
  const base = PRESETS[strategy] ?? PRESETS.default;
  return {
    safetyFactor: overrides.safetyFactor ?? base.safetyFactor,
    safetyStock: overrides.safetyStock ?? base.safetyStock,
    lookbackWeeks: overrides.lookbackWeeks ?? base.lookbackWeeks,
    submitDelay: overrides.submitDelay ?? 1500,
  };
}

export function computeOrder(
  user: GameUser,
  group: Group,
  strategy: StrategyName,
  params: Required<AgentParams>,
): number {
  const orderHistory = user.orderHistory ?? [];
  const lookback = Math.min(params.lookbackWeeks, orderHistory.length);

  let expectedDemand: number;
  if (lookback === 0) {
    expectedDemand = STARTING_THROUGHPUT;
  } else {
    const recent = orderHistory.slice(-lookback);
    expectedDemand = recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  const incomingShipments = (group.shipping[group.users.indexOf(user)] ?? [])
    .reduce((a, b) => a + b, 0);

  const targetInventory = expectedDemand * params.safetyFactor + params.safetyStock;
  const order = targetInventory - user.inventory - incomingShipments + user.backlog;

  return Math.max(0, Math.round(order));
}
