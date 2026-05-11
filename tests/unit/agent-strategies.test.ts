import assert from 'assert';
import { computeOrder, resolveParams } from '../../src/agent/strategies.js';
import { DEMAND_PROFILES, STARTING_INVENTORY, STARTING_THROUGHPUT } from '../../src/config.js';
import { makeRole } from '../../src/utils.js';
import type { GameUser, Group } from '../../src/types.js';

function makeUser(index: number): GameUser {
  return {
    name: `u${index}`,
    cost: 0,
    inventory: STARTING_INVENTORY,
    backlog: 0,
    role: makeRole(index),
    inventoryHistory: [],
    backlogHistory: [],
    costHistory: [],
    orderHistory: [],
  };
}

function makeGroup(users: GameUser[]): Group {
  return {
    week: 1,
    cost: 0,
    users,
    waitingForOrders: ['零售商', '批发商', '区域仓库', '工厂'],
    demandTrend: 'mixed',
    demandProfile: DEMAND_PROFILES.mixed,
    shipping: users.map(() => [STARTING_THROUGHPUT, STARTING_THROUGHPUT]),
    mailing: [[STARTING_THROUGHPUT], [STARTING_THROUGHPUT], [STARTING_THROUGHPUT]],
    costHistory: [],
    ready: false,
  };
}

const params = resolveParams('default');

{
  const users = [makeUser(0), makeUser(1), makeUser(2), makeUser(3)];
  const group = makeGroup(users);
  users[0].role.downstream.orders = 4;

  assert.strictEqual(
    computeOrder(users[0], group, 'default', params),
    4,
    'balanced agent should maintain normal demand at game start',
  );
}

{
  const users = [makeUser(0), makeUser(1), makeUser(2), makeUser(3)];
  const group = makeGroup(users);
  users[0].inventory = 0;
  users[0].backlog = 8;
  users[0].role.downstream.orders = 6;

  const order = computeOrder(users[0], group, 'default', params);
  assert(order > 6, 'balanced agent should recover from backlog and low inventory');
  assert(order <= 20, 'balanced agent should cap recovery orders');
}

{
  const users = [makeUser(0), makeUser(1), makeUser(2), makeUser(3)];
  const group = makeGroup(users);
  users[0].orderHistory = [4, 8, 8];
  users[1].orderHistory = [20, 20, 20];
  users[1].role.downstream.orders = 8;

  assert.strictEqual(
    computeOrder(users[1], group, 'default', params),
    7,
    'upstream agent should follow downstream demand history, not its own prior orders',
  );
}

console.log('agent strategy test passed');
