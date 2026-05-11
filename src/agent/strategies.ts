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
  default:      { safetyFactor: 0.5, safetyStock: 2, lookbackWeeks: 3 },
  conservative: { safetyFactor: 0.25, safetyStock: 1, lookbackWeeks: 4 },
  aggressive:   { safetyFactor: 0.75, safetyStock: 4, lookbackWeeks: 3 },
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
  const demandHistory = observedDemandHistory(user, group);
  const lookback = Math.min(params.lookbackWeeks, demandHistory.length);

  let expectedDemand: number;
  if (lookback === 0) {
    expectedDemand = STARTING_THROUGHPUT;
  } else {
    const recent = demandHistory.slice(-lookback);
    expectedDemand = recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  const incomingShipments = (group.shipping[group.users.indexOf(user)] ?? [])
    .reduce((a, b) => a + b, 0);

  const targetInventory = expectedDemand + params.safetyStock;
  const inventoryGap = Math.max(0, targetInventory - user.inventory);
  const excessCoverage = Math.max(
    0,
    user.inventory + incomingShipments - (targetInventory + expectedDemand * 3),
  );
  const backlogRecovery = user.backlog * params.safetyFactor;
  const order = expectedDemand + backlogRecovery + inventoryGap * 0.5 - excessCoverage * 0.25;
  const cap = expectedDemand * 2 + params.safetyStock + user.backlog;

  return Math.max(0, Math.min(Math.round(cap), Math.round(order)));
}

function observedDemandHistory(user: GameUser, group: Group): number[] {
  const roleIndex = group.users.indexOf(user);
  const currentDemand = user.role.downstream.orders;

  if (roleIndex > 0) {
    const downstreamUser = group.users[roleIndex - 1];
    const downstreamOrders = downstreamUser?.orderHistory ?? [];
    if (downstreamOrders.length > 0) return downstreamOrders;
  }

  return Number.isFinite(currentDemand) ? [currentDemand] : [];
}
