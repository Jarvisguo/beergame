import type { Group } from '../types.js';
import {
  BEER_NAMES,
  STARTING_THROUGHPUT,
  MAX_WEEKS,
  INVENTORY_COST,
  BACKLOG_COST,
} from '../config.js';
import { customerDemand } from './demand.js';

export type EmitFn = (
  target: 'socket' | 'room' | 'admins',
  event: string,
  data: unknown,
  id?: string,
) => void;

export function advanceTurn(g: Group, groupIndex: number, onSocketEmit: EmitFn): void {
  // Week-0 init
  if (g.week === 0) {
    g.waitingForOrders = [...BEER_NAMES];
    g.shipping = [];
    g.mailing = [];
    g.costHistory = [];
    for (let j = 0; j < 3; j++) {
      g.shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
      g.mailing.push([STARTING_THROUGHPUT]);
    }
    g.shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
  }

  for (let i = 0; i < g.users.length; i++) {
    const user = g.users[i];
    if (g.week === 0) {
      user.inventoryHistory = [];
      user.backlogHistory = [];
      user.costHistory = [];
      user.orderHistory = [];
    }
    user.costHistory.push(user.cost);
    user.inventoryHistory.push(user.inventory);
    user.backlogHistory.push(user.backlog);

    user.role.upstream.shipments = g.shipping[i].shift()!;
    user.inventory += user.role.upstream.shipments;

    if (i === 0) {
      user.role.downstream.orders = customerDemand(g.week, g.demandTrend);
    } else {
      user.role.downstream.orders = g.mailing[i - 1].shift()!;
    }

    const toShip = user.backlog + user.role.downstream.orders;
    user.role.downstream.shipments = toShip > user.inventory ? user.inventory : toShip;
    if (i !== 0) {
      g.shipping[i - 1].push(user.role.downstream.shipments);
    }

    user.backlog = toShip > user.inventory ? toShip - user.inventory : 0;
    user.inventory = toShip > user.inventory ? 0 : user.inventory - toShip;

    if (g.week === 0) {
      user.role.upstream.orders = STARTING_THROUGHPUT;
    }
    if (i === 3) {
      g.shipping[i].push(user.role.upstream.orders);
    } else {
      g.mailing[i].push(user.role.upstream.orders);
    }
    user.orderHistory.push(user.role.upstream.orders);
    user.cost += user.inventory * INVENTORY_COST + user.backlog * BACKLOG_COST;
  }

  g.cost = g.users.reduce((sum, u) => sum + u.cost, 0);
  g.costHistory.push(g.cost);
  g.week++;
  g.waitingForOrders = g.week > MAX_WEEKS ? [] : [...BEER_NAMES];

  for (let i = 0; i < g.users.length; i++) {
    const u = g.users[i];
    if (!u.socketId) continue;
    onSocketEmit('socket', 'next turn', {
      week: g.week,
      update: u,
      waitingForOrders: g.waitingForOrders,
    }, u.socketId);
  }
  onSocketEmit('admins', 'update group', { groupNum: groupIndex, groupData: g });
}
