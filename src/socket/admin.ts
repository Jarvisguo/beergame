import type { Server, Socket } from 'socket.io';
import { state } from '../state/store.js';
import {
  ADMIN_PASSWORD,
  DEMAND_PROFILES,
  DEFAULT_DEMAND_TREND,
  STARTING_THROUGHPUT,
  STARTING_INVENTORY,
  BEER_NAMES,
} from '../config.js';
import { log, groupRoom, ack, clearDisconnectTimer, deepClone, makeRole } from '../utils.js';
import { customerDemand, normalizeTrend } from '../game/demand.js';
import { scheduleAgentSubmissions } from './player.js';
import { resolveParams } from '../agent/strategies.js';
import type { StrategyName } from '../agent/strategies.js';
import type { GameUser, AgentConfig } from '../types.js';

// initGroup is duplicated here to avoid a circular dependency with player.ts.
// Both modules need it but neither should own the other.
function initGroup(io: Server, groupIndex: number): void {
  const g = state.groups[groupIndex];
  g.waitingForOrders = [...BEER_NAMES];
  g.demandTrend = state.currentDemandTrend;
  g.demandProfile = DEMAND_PROFILES[state.currentDemandTrend];
  g.shipping = [];
  g.mailing = [];
  g.costHistory = [];
  for (let j = 0; j < 3; j++) {
    g.shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
    g.mailing.push([STARTING_THROUGHPUT]);
  }
  g.shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
  for (let j = 0; j < g.users.length; j++) {
    g.users[j].inventoryHistory = [];
    g.users[j].backlogHistory = [];
    g.users[j].costHistory = [];
    g.users[j].orderHistory = [];
  }
  if (g.users[0]) {
    g.users[0].role.downstream.orders = customerDemand(1, g.demandTrend);
  }
  g.week = 1;
  io.to(groupRoom(groupIndex)).emit('game started', {
    week: 1,
    numUsers: state.numUsers,
    waitingForOrders: g.waitingForOrders,
    demandTrend: g.demandTrend,
    demandProfile: g.demandProfile,
    users: g.users,
  });
}

export function registerAdminHandlers(io: Server, socket: Socket): void {
  socket.on('submit password', (password: string, callback?: Function) => {
    if (password !== ADMIN_PASSWORD) {
      return ack(callback, 'Invalid Password');
    }

    socket.join('admins');

    let status = 'waiting';
    if (state.gameStarted && !state.gameEnded) status = 'started';
    else if (state.gameStarted && state.gameEnded) status = 'ended';

    ack(callback, {
      status,
      numUsers: state.numUsers,
      groups: state.groups,
      demandTrend: state.currentDemandTrend,
      demandProfile: DEMAND_PROFILES[state.currentDemandTrend],
    });
  });

  socket.on('start game', (options: { demandTrend?: string } | Function, callback?: Function) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = options && typeof options === 'object' ? options : {};

    if (state.gameStarted && !state.gameEnded) {
      return ack(callback, { err: '游戏已经开始。' });
    }
    if (state.gameEnded) {
      return ack(callback, { err: '游戏已结束，请先重置再开始。' });
    }

    const selectedTrend = normalizeTrend(opts.demandTrend || DEFAULT_DEMAND_TREND);
    log('INFO', `start game: trend=${selectedTrend}`);

    state.gameStarted = true;
    state.gameEnded = false;
    state.currentDemandTrend = selectedTrend;

    ack(callback, {
      numUsers: state.numUsers,
      demandTrend: state.currentDemandTrend,
      demandProfile: DEMAND_PROFILES[state.currentDemandTrend],
    });

    io.emit('game can login');

    for (let i = 0; i < state.groups.length; i++) {
      if (state.groups[i].users.length > 0 && state.groups[i].week === 0) {
        initGroup(io, i);
        scheduleAgentSubmissions(io, i);
      }
    }

    io.to('admins').emit('update table', {
      numUsers: state.numUsers,
      groups: state.groups,
    });
  });

  socket.on('end game', (callback?: Function) => {
    if (!state.gameStarted || state.gameEnded) {
      return ack(callback, 'Error');
    }
    state.gameEnded = true;
    ack(callback, { numUsers: state.numUsers, groups: state.groups });
    socket.broadcast.emit('game ended', { numUsers: state.numUsers });
  });

  socket.on('reset game', (callback?: Function) => {
    if (!state.gameStarted) {
      return ack(callback, 'Error');
    }

    state.groups.length = 0;
    for (const key of Object.keys(state.users)) delete state.users[key];
    state.numUsers = 0;
    state.gameStarted = false;
    state.gameEnded = false;
    state.currentDemandTrend = DEFAULT_DEMAND_TREND;

    ack(callback, { numUsers: state.numUsers, groups: state.groups });
    io.emit('game reset');
  });

  socket.on('remove group', (msg: string, callback?: Function) => {
    const idx = Number(msg);
    if (msg === '' || isNaN(idx) || idx < 0 || idx >= state.groups.length) {
      return ack(callback, 'Error');
    }

    const group = state.groups[idx];
    const removedCount = group.users.length;

    // Notify members before removing
    io.to(groupRoom(idx)).emit('kicked out', idx);

    // Clean up UserLookup entries for all members
    for (const u of group.users) {
      if (u.name && state.users[u.name]) {
        clearDisconnectTimer(state.users[u.name]);
        delete state.users[u.name];
      }
    }

    state.groups.splice(idx, 1);
    state.numUsers = Math.max(0, state.numUsers - removedCount);

    // Update group indices for all users in groups that shifted down
    for (let i = idx; i < state.groups.length; i++) {
      for (const u of state.groups[i].users) {
        if (u.name && state.users[u.name]) {
          state.users[u.name].group = i;
          const sid = state.users[u.name].socketId;
          if (sid) {
            io.to(sid).emit('change group subscription', i);
          }
        }
      }
    }

    ack(callback, { numUsers: state.numUsers, groups: state.groups });
    io.to('admins').emit('update table', {
      numUsers: state.numUsers,
      groups: state.groups,
    });
  });

  socket.on('add agent', (msg: {
    groupIndex: number;
    roleIndex: number;
    strategy?: string;
    params?: Record<string, number>;
  }, callback?: Function) => {
    const { groupIndex, roleIndex, strategy, params } = msg;

    if (roleIndex < 0 || roleIndex > 3) return ack(callback, { err: '无效角色索引。' });

    // Auto-create group if it doesn't exist
    if (!state.groups[groupIndex]) {
      const trend = state.currentDemandTrend;
      const profile = deepClone(DEMAND_PROFILES[trend] ?? DEMAND_PROFILES[DEFAULT_DEMAND_TREND]);
      state.groups[groupIndex] = {
        week: 0,
        cost: 0,
        users: [],
        waitingForOrders: [],
        demandTrend: trend,
        demandProfile: profile,
        shipping: [],
        mailing: [],
        costHistory: [],
        ready: false,
      };
    }

    const g = state.groups[groupIndex];
    const existing = g.users[roleIndex];
    if (existing && existing.socketId) {
      return ack(callback, { err: '该角色当前有在线玩家，无法指派 AI。' });
    }

    const agentConfig: AgentConfig = {
      strategy: strategy || 'default',
      params: params || {},
    };

    if (existing) {
      existing.agent = agentConfig;
    } else {
      const userName = `AI-${['零售商','批发商','区域仓库','工厂'][roleIndex]}-G${groupIndex + 1}`;
      const role = deepClone(makeRole(roleIndex));
      const newUser: GameUser = {
        name: userName,
        cost: 0,
        inventory: STARTING_INVENTORY,
        backlog: 0,
        role,
        inventoryHistory: [],
        backlogHistory: [],
        costHistory: [],
        orderHistory: [],
        agent: agentConfig,
      };
      g.users[roleIndex] = newUser;
    }

    if (g.users.length === 4 && g.week === 0 && state.gameStarted && !state.gameEnded) {
      initGroup(io, groupIndex);
      scheduleAgentSubmissions(io, groupIndex);
    } else if (g.week > 0 && state.gameStarted && !state.gameEnded) {
      scheduleAgentSubmissions(io, groupIndex);
    }

    io.to('admins').emit('update table', { numUsers: state.numUsers, groups: state.groups });
    ack(callback, { ok: true });
  });

  socket.on('remove agent', (msg: { groupIndex: number; roleIndex: number }, callback?: Function) => {
    const { groupIndex, roleIndex } = msg;
    const g = state.groups[groupIndex];

    if (!g) return ack(callback, { err: '团队不存在。' });
    const user = g.users[roleIndex];
    if (!user || !user.agent) return ack(callback, { err: '该角色没有 AI 代理。' });

    delete user.agent;

    if (!user.socketId) {
      g.users[roleIndex] = undefined as unknown as GameUser;
    }

    io.to('admins').emit('update table', { numUsers: state.numUsers, groups: state.groups });
    ack(callback, { ok: true });
  });

  socket.on('list agents', (callback?: Function) => {
    const agents: Array<{ groupIndex: number; roleIndex: number; name: string; strategy: string }> = [];
    for (let gi = 0; gi < state.groups.length; gi++) {
      for (let ri = 0; ri < state.groups[gi].users.length; ri++) {
        const u = state.groups[gi].users[ri];
        if (u && u.agent) {
          agents.push({ groupIndex: gi, roleIndex: ri, name: u.name, strategy: u.agent.strategy });
        }
      }
    }
    ack(callback, agents);
  });
}
