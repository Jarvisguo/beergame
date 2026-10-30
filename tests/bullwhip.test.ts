import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { advanceTurn } from '../src/game/turn';
import { makeRole } from '../src/utils';
import type { Group } from '../src/types';

const require = createRequire(import.meta.url);
const metrics = () => require('../public/bullwhip.js');
const demand = [4, 4, 6, 8, 10, 6];

test('settlement records received demand with one-week order delay, excluding backlog', () => {
  const group = { week: 1, cost: 0, waitingForOrders: [], demandTrend: 'mixed',
    demandProfile: { name: 'mixed', schedule: [] }, ready: true, costHistory: [],
    mailing: [[4], [4], [4]], shipping: Array.from({ length: 4 }, () => [4, 4]),
    users: Array.from({ length: 4 }, (_, i) => ({ name: 'p' + i, socketId: 's' + i,
      role: makeRole(i), inventory: 12, backlog: 50, cost: 0,
      inventoryHistory: [], backlogHistory: [], costHistory: [], orderHistory: [],
      demandHistory: [], historyStartWeek: 1 })) } as Group;
  const events: any[] = [];
  const received = [4, 7, 12, 3, 9];
  for (let w = 1; w <= 5; w++) {
    group.users.forEach((u, i) => { u.role.upstream.orders = i === 0 ? [7, 12, 3, 9, 22][w - 1] : 5; });
    advanceTurn(group, 0, (target, event, data) => events.push({ target, event, data }));
  }
  assert.deepEqual((group.users[0] as any).demandHistory, [4, 4, 4, 4, 6]);
  assert.deepEqual((group.users[1] as any).demandHistory, received);
  assert.equal(group.users[1].orderHistory.length, 5);
  const next = events.filter(e => e.event === 'next turn').at(-1).data;
  assert.deepEqual(next.analytics[1].demandHistory, received);
  assert.equal(next.analytics.length, 4, 'each player gets current summaries for all four roles');
  assert.equal(next.analytics[1].socketId, undefined, 'analytics contains only history fields');
});

test('variance amplification measures demand amplification, including the retailer, without a score cap', () => {
  const m = metrics();
  const calculate = (orders: number[]) => m.calculate(orders, demand, 6, 1);
  assert.equal(calculate(demand).ratio, 1);
  assert.equal(calculate(demand).label, '未放大');
  assert.equal(calculate(demand.map(x => 2 * x)).ratio, 4);
  assert.equal(calculate(demand.map(x => 2 * x)).label, '中度放大');
  assert.equal(calculate(demand.map(x => 10 * x)).ratio, 100);
  assert.equal(calculate(Array(6).fill(0)).note, '未发生订货');
  assert.equal(calculate(Array(6).fill(0)).ratio, 0);
});

test('five levels have exact boundaries and formatting does not conceal a boundary', () => {
  const m = metrics();
  for (const [ratio, level] of [[0, 0], [1, 0], [1.000001, 1], [2, 1], [2.000001, 2], [4, 2], [4.000001, 3], [8, 3], [8.000001, 4]]) {
    assert.equal(m.level(ratio).level, level);
    assert.equal(m.level(Number(m.formatRatio(ratio).replace('×', ''))).level, level);
  }
});

test('zero variance, few weeks and incomplete histories never become made-up ratios', () => {
  const m = metrics();
  assert.equal(m.calculate(demand, demand, 4, 1).status, 'collecting');
  assert.equal(m.calculate(Array(6).fill(4), Array(6).fill(4), 6, 1).status, 'constant');
  assert.equal(m.calculate(demand, Array(6).fill(4), 6, 1).status, 'constant-demand');
  for (const [orders, demands, start] of [[demand, undefined, 1], [demand, demand.slice(1), 1],
    [demand, [4, 4, null, 8, 10, 6], 1], [demand, [4, 4, Infinity, 8, 10, 6], 1],
    [demand, demand, 3], [demand, demand, undefined]]) {
    const result = m.calculate(orders, demands, 6, start);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.ratio, null);
  }
  assert.equal(m.calculate([...demand, 100], [...demand, 0], 6, 1).ratio, 1, 'unsettled week is excluded');
});

test('partial team results disclose coverage and constant-demand warnings', () => {
  const m = metrics();
  const user = (orders: number[], demands?: number[]) => ({ orderHistory: orders, demandHistory: demands, historyStartWeek: 1 });
  const users = [user(demand.map(x => x * 3), demand), user(demand, demand),
    user(demand, Array(6).fill(4)), user(demand)];
  const result = m.summarize(users, 6);
  assert.equal(result.max.ratio, 9);
  assert.equal(result.validCount, 2);
  assert.equal(result.warningCount, 1);
  assert.equal(result.incompleteCount, 1);
  assert.deepEqual(result.maxIndices, [0]);
});
