import type { Server, Socket } from 'socket.io';
import { state } from '../state/store.js';
import { registerUser, finalizeDisconnect } from '../state/users.js';
import { advanceTurn } from '../game/turn.js';
import type { EmitFn } from '../game/turn.js';
import {
  BEER_NAMES,
  STARTING_THROUGHPUT,
  MAX_WEEKS,
  MAX_ORDER_QUANTITY,
  DEMAND_PROFILES,
  RECONNECT_GRACE_MS,
} from '../config.js';
import { log, groupRoom, ack } from '../utils.js';
import { customerDemand } from '../game/demand.js';
import { computeOrder, resolveParams } from '../agent/strategies.js';
import type { StrategyName } from '../agent/strategies.js';

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

export function scheduleAgentSubmissions(io: Server, groupIndex: number): void {
  const g = state.groups[groupIndex];
  if (!g || g.waitingForOrders.length === 0) return;

  for (let i = 0; i < g.users.length; i++) {
    const user = g.users[i];
    if (!user.agent) continue;
    if (!g.waitingForOrders.includes(user.role.name)) continue;

    const params = resolveParams(user.agent.strategy as StrategyName, user.agent.params);
    const delay = params.submitDelay;

    setTimeout(() => {
      const freshGroup = state.groups[groupIndex];
      if (!freshGroup || freshGroup.week !== g.week) return;
      const freshUser = freshGroup.users[i];
      if (!freshUser || !freshUser.agent) return;
      if (!freshGroup.waitingForOrders.includes(freshUser.role.name)) return;

      const order = computeOrder(freshUser, freshGroup, freshUser.agent!.strategy as StrategyName, params);

      freshUser.role.upstream.orders = order;
      const idx = freshGroup.waitingForOrders.indexOf(freshUser.role.name);
      if (idx !== -1) freshGroup.waitingForOrders.splice(idx, 1);

      io.to(groupRoom(groupIndex)).emit('update order wait', freshGroup.waitingForOrders);

      if (freshGroup.waitingForOrders.length === 0) {
        const emitFn: EmitFn = (target, event, data, id) => {
          if (target === 'socket' && id) {
            io.to(id).emit(event, data);
          } else if (target === 'room') {
            io.to(groupRoom(groupIndex)).emit(event, data);
          } else if (target === 'admins') {
            io.to('admins').emit(event, data);
          }
        };
        advanceTurn(freshGroup, groupIndex, emitFn);
        scheduleAgentSubmissions(io, groupIndex);
      }
    }, delay);
  }
}

export function registerPlayerHandlers(io: Server, socket: Socket): void {
  let addedUser = false;

  socket.on('submit username', (userName: string, callback?: Function) => {
    if (addedUser) {
      const currentName = (socket as any).name as string | undefined;
      const currentUser = currentName ? state.users[currentName] : undefined;
      if (currentUser && currentUser.socketId === socket.id) return;
      addedUser = false;
      delete (socket as any).name;
    }

    log('INFO', `${socket.id}: submit username ${userName}`);

    const result = registerUser(socket.id, userName, io);

    if ('error' in result) {
      if (result.error === 'game not started') {
        return ack(callback, '游戏尚未开始，请等待管理员启动。');
      }
      if (result.error === 'game already ended') {
        return ack(callback, 'Game Ended');
      }
      if (result.error === 'username already active') {
        return ack(callback, 'Game Started');
      }
      return ack(callback, result.error);
    }

    const { user, isReconnect } = result;
    (socket as any).name = user.name;
    addedUser = true;

    const g = state.groups[user.group];
    socket.join(groupRoom(user.group));

    if (!isReconnect) {
      io.to(groupRoom(user.group)).emit('group member joined', {
        idx: user.index,
        update: g.users[user.index],
      });
    } else if (state.gameStarted && !state.gameEnded) {
      socket.to(groupRoom(user.group)).emit('player rejoined', {
        idx: user.index,
        update: g.users[user.index],
      });
    }

    if (state.gameStarted && !state.gameEnded && g.week === 0 && g.users.length === 4) {
      initGroup(io, user.group);
      scheduleAgentSubmissions(io, user.group);
    } else if (state.gameStarted && !state.gameEnded && g.week > 0 && !isReconnect) {
      socket.emit('game started', {
        week: g.week,
        numUsers: state.numUsers,
        waitingForOrders: g.waitingForOrders,
        demandTrend: g.demandTrend,
        demandProfile: g.demandProfile,
        users: g.users,
      });
      io.to(groupRoom(user.group)).emit('update order wait', g.waitingForOrders);
    }

    io.to('admins').emit('update table', {
      numUsers: state.numUsers,
      groups: state.groups,
    });

    ack(callback, {
      numUsers: state.numUsers,
      idx: user.index,
      group: g,
      gameEnded: state.gameEnded,
      reconnected: isReconnect,
      demandTrend: g.demandTrend,
      demandProfile: g.demandProfile,
    });
  });

  socket.on('submit order', (order: string, callback?: Function) => {
    const name = (socket as any).name as string | undefined;
    const user = name ? state.users[name] : undefined;

    if (!user || user.group === undefined) {
      log('WARN', 'submit order: user not registered');
      return ack(callback, { err: '用户未注册或未加入团队。' });
    }

    const g = state.groups[user.group];
    if (!g) {
      log('WARN', 'submit order: group not found');
      return ack(callback, { err: '团队未找到。' });
    }

    if (g.week === 0) {
      return ack(callback, { err: '等待其他玩家加入，游戏尚未开始。' });
    }

    if (g.week > MAX_WEEKS) {
      return ack(callback, { err: `游戏已完成 ${MAX_WEEKS} 周，不再接受订单。` });
    }

    const roleName = g.users[user.index].role.name;
    if (!g.waitingForOrders.includes(roleName)) {
      return ack(callback, { err: '本周订单已提交，不能重复修改。' });
    }

    const parsed = parseInt(String(order).trim(), 10);
    if (isNaN(parsed) || parsed < 0 || !/^\d+$/.test(String(order).trim())) {
      return ack(callback, { err: '订单数量必须是有效的非负整数。' });
    }
    if (parsed > MAX_ORDER_QUANTITY) {
      return ack(callback, { err: `订单数量不能超过 ${MAX_ORDER_QUANTITY}。` });
    }

    log('INFO', `order: ${name} group=${user.group} amount=${parsed}`);

    g.users[user.index].role.upstream.orders = parsed;

    const idx = g.waitingForOrders.indexOf(roleName);
    if (idx !== -1) {
      g.waitingForOrders.splice(idx, 1);
    }

    if (g.waitingForOrders.length === 0) {
      ack(callback);
      const emitFn: EmitFn = (target, event, data, id) => {
        if (target === 'socket' && id) {
          io.to(id).emit(event, data);
        } else if (target === 'room') {
          io.to(groupRoom(user.group)).emit(event, data);
        } else if (target === 'admins') {
          io.to('admins').emit(event, data);
        }
      };
      advanceTurn(g, user.group, emitFn);
      scheduleAgentSubmissions(io, user.group);
    } else {
      ack(callback, g.waitingForOrders);
      io.to(groupRoom(user.group)).emit('update order wait', g.waitingForOrders);
    }
  });

  socket.on('disconnect', () => {
    if (!addedUser) return;
    const name = (socket as any).name as string | undefined;
    if (!name) return;

    log('INFO', `disconnect: ${name}`);
    const u = state.users[name];
    if (!u || u.socketId !== socket.id) return;

    u.disconnectedAt = Date.now();
    const g = state.groups[u.group];
    if (g && g.users[u.index]) {
      g.users[u.index].disconnectedAt = u.disconnectedAt;
    }

    clearTimeout(u.disconnectTimer);
    u.disconnectTimer = setTimeout(() => {
      const emitFn: EmitFn = (target, event, data, id) => {
        if (target === 'room' && id) {
          io.to(id).emit(event, data);
        } else if (target === 'admins') {
          io.to('admins').emit(event, data);
        }
      };
      finalizeDisconnect(name, emitFn);
    }, RECONNECT_GRACE_MS);
  });

  socket.on('ack getting kicked', () => {
    addedUser = false;
    delete (socket as any).name;
  });
}
