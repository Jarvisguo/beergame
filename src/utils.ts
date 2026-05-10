import { BEER_NAMES, STARTING_INVENTORY, STARTING_THROUGHPUT } from './config.js';
import type { Role, GameUser, UserLookup } from './types.js';

export function log(level: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${level} ${msg}\n`);
}

export function groupRoom(group: number): string {
  return String(group);
}

export function ack(cb: Function | undefined, payload?: unknown): void {
  if (typeof cb === 'function') cb(payload);
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function clearDisconnectTimer(user: UserLookup | GameUser): void {
  if (user.disconnectTimer) {
    clearTimeout(user.disconnectTimer);
    delete user.disconnectTimer;
  }
}

export function makeRole(index: number): Role {
  const upstreams = ['批发商', '区域仓库', '工厂', '工厂'];
  const downstreams = ['客户', '零售商', '批发商', '区域仓库'];
  return {
    name: BEER_NAMES[index],
    upstream: { name: upstreams[index], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
    downstream: { name: downstreams[index], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
  };
}
