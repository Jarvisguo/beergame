/* ========================================================================
 * Beer Distribution Game Simulator — TypeScript rewrite
 * 啤酒分销游戏模拟器 — 服务端
 * ======================================================================== */

import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────────────

interface Role {
  name: string;
  upstream: { name: string; orders: number; shipments: number };
  downstream: { name: string; orders: number; shipments: number };
}

interface GameUser {
  name: string;
  socketId?: string;
  disconnectedAt?: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  cost: number;
  inventory: number;
  backlog: number;
  role: Role;
  inventoryHistory: number[];
  backlogHistory: number[];
  costHistory: number[];
  orderHistory: number[];
}

interface UserLookup {
  name: string;
  socketId: string;
  group: number;
  index: number;
  disconnectedAt?: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

interface DemandEntry {
  until: number;
  demand: number;
}

interface DemandProfile {
  name: string;
  schedule: DemandEntry[];
}

interface Group {
  week: number;
  cost: number;
  users: GameUser[];
  waitingForOrders: string[];
  demandTrend: string;
  demandProfile: DemandProfile;
  shipping: number[][];
  mailing: number[][];
  costHistory: number[];
  ready: boolean;
}

// ── Config ─────────────────────────────────────────────────────────────

const INVENTORY_COST = 0.5;
const BACKLOG_COST = 1;
const STARTING_INVENTORY = 12;
const STARTING_THROUGHPUT = 4;
const MAX_WEEKS = 26;
const DEFAULT_DEMAND_TREND = 'mixed';

const BEER_NAMES = ['零售商', '批发商', '区域仓库', '工厂'];

const DEMAND_PROFILES: Record<string, DemandProfile> = {
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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('[FATAL] ADMIN_PASSWORD 环境变量未设置。请在 .env 中配置。');
  process.exit(1);
}

const RECONNECT_GRACE_MS = (() => {
  const v = parseInt(process.env.MOBILE_RECONNECT_GRACE_MS || '300000', 10);
  return isNaN(v) || v < 0 ? 300000 : v;
})();

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Game State ─────────────────────────────────────────────────────────

let groups: Group[] = [];
const users: Record<string, UserLookup> = {};
let numUsers = 0;
let gameStarted = false;
let gameEnded = false;
let currentDemandTrend = DEFAULT_DEMAND_TREND;

// ── Helpers ────────────────────────────────────────────────────────────

function log(level: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${level} ${msg}\n`);
}

function groupRoom(group: number): string {
  return String(group);
}

function ack(cb: Function | undefined, payload: unknown): void {
  if (typeof cb === 'function') cb(payload);
}

function normalizeTrend(trend: string): string {
  return DEMAND_PROFILES[trend] ? trend : DEFAULT_DEMAND_TREND;
}

function customerDemand(week: number, trend: string): number {
  const profile = DEMAND_PROFILES[normalizeTrend(trend)];
  for (const entry of profile.schedule) {
    if (week <= entry.until) return entry.demand;
  }
  return profile.schedule[profile.schedule.length - 1].demand;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function clearDisconnectTimer(user: UserLookup | GameUser): void {
  if (user.disconnectTimer) {
    clearTimeout(user.disconnectTimer);
    delete user.disconnectTimer;
  }
}

function makeRole(index: number): Role {
  const upstreams = ['批发商', '区域仓库', '工厂', '工厂'];
  const downstreams = ['客户', '零售商', '批发商', '区域仓库'];
  return {
    name: BEER_NAMES[index],
    upstream: { name: upstreams[index], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
    downstream: { name: downstreams[index], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
  };
}

// ── Disconnect Handling ────────────────────────────────────────────────

function finalizeDisconnect(userName: string): void {
  const user = users[userName];
  if (!user || !user.disconnectedAt) return;

  const group = groups[user.group];
  if (!group || !group.users[user.index]) return;

  clearDisconnectTimer(user);
  delete user.disconnectedAt;
  delete user.socketId;
  delete group.users[user.index].socketId;
  delete group.users[user.index].disconnectedAt;

  if (numUsers > 0) numUsers--;

  io.to(groupRoom(user.group)).emit('group member left', {
    idx: user.index,
    update: group.users[user.index],
  });

  io.emit('user left', { username: userName, numUsers });
  io.to('admins').emit('update table', { numUsers, groups });
}

// ── Turn Logic ─────────────────────────────────────────────────────────

function advanceTurn(groupIndex: number): void {
  const g = groups[groupIndex];

  // Week-0 init (first-turn setup)
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
  
  // Process each role: 0=零售商, 1=批发商, 2=区域仓库, 3=工厂
  for (let i = 0; i < g.users.length; i++) {
    const user = g.users[i];

    if (g.week === 0) {
      user.inventoryHistory = [];
      user.backlogHistory = [];
      user.costHistory = [];
      user.orderHistory = [];
    }

    // Snapshot current state
    user.costHistory.push(user.cost);
    user.inventoryHistory.push(user.inventory);
    user.backlogHistory.push(user.backlog);

    // 1. Receive shipment from upstream
    user.role.upstream.shipments = g.shipping[i].shift()!;
    user.inventory += user.role.upstream.shipments;

    // 2. Receive order from downstream
    if (i === 0) {
      user.role.downstream.orders = customerDemand(g.week, g.demandTrend || currentDemandTrend);
    } else {
      user.role.downstream.orders = g.mailing[i - 1].shift()!;
    }

    // 3. Ship to downstream
    const toShip = user.backlog + user.role.downstream.orders;
    user.role.downstream.shipments = toShip > user.inventory ? user.inventory : toShip;

    if (i !== 0) {
      g.shipping[i - 1].push(user.role.downstream.shipments);
    }

    // 4. Update backlog & inventory
    user.backlog = toShip > user.inventory ? toShip - user.inventory : 0;
    user.inventory = toShip > user.inventory ? 0 : user.inventory - toShip;

    // 5. Send order upstream
    if (g.week === 0) {
      user.role.upstream.orders = STARTING_THROUGHPUT;
    }

    if (i === 3) {
      g.shipping[i].push(user.role.upstream.orders);
    } else {
      g.mailing[i].push(user.role.upstream.orders);
    }

    user.orderHistory.push(user.role.upstream.orders);

    // 6. Accumulate costs
    g.cost += user.cost;
    user.cost += user.inventory * INVENTORY_COST + user.backlog * BACKLOG_COST;
  }

  g.costHistory.push(g.cost);

  // Advance week
  g.week++;
  const roles = g.users.map(u => u.role.name);
  g.waitingForOrders = g.week > MAX_WEEKS ? [] : [...roles];

  // Emit results
  for (let i = 0; i < g.users.length; i++) {
    const u = g.users[i];
    if (!u.socketId) continue;
    io.to(u.socketId).emit('next turn', {
      numUsers,
      week: g.week,
      update: u,
      waitingForOrders: g.waitingForOrders,
    });
  }

  io.to('admins').emit('update group', { groupNum: groupIndex, groupData: g, numUsers });
}

// ── Group Init ─────────────────────────────────────────────────────────

function initGroup(groupIndex: number): void {
  const g = groups[groupIndex];
  g.waitingForOrders = [...BEER_NAMES];
  g.demandTrend = currentDemandTrend;
  g.demandProfile = DEMAND_PROFILES[currentDemandTrend];
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

  g.week = 1;

  io.to(groupRoom(groupIndex)).emit('game started', {
    numUsers,
    week: 1,
    waitingForOrders: g.waitingForOrders,
    demandTrend: g.demandTrend,
    demandProfile: g.demandProfile,
  });
}

// ── Registration ───────────────────────────────────────────────────────

function registerUser(socketId: string, userName: string): UserLookup | null {
  log('info', `register: socketId=${socketId} userName=${userName} exists=${!!users[userName]}`);

  // Reconnect: same username, always allowed (any game state)
  if (users[userName]) {
    const u = users[userName];
    if (u.socketId && !u.disconnectedAt) return null; // Already active

    clearDisconnectTimer(u);
    const g = groups[u.group];
    g.users[u.index].socketId = socketId;
    delete g.users[u.index].disconnectedAt;
    u.socketId = socketId;
    delete u.disconnectedAt;
    return u;
  }

  // New user: only allowed during active game
  if (!gameStarted) return null;
  if (gameEnded) return null;

  // Find a slot in an existing incomplete group (skip completed groups)
  let assignedGroup = -1;
  let assignedIndex = -1;

  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].users.length < 4 && groups[gi].week <= MAX_WEEKS) {
      // Determine which roles are taken
      const taken = [false, false, false, false];
      for (const gu of groups[gi].users) {
        const ri = BEER_NAMES.indexOf(gu.role.name);
        if (ri >= 0) taken[ri] = true;
      }
      for (let ri = 0; ri < 4; ri++) {
        if (!taken[ri]) {
          assignedGroup = gi;
          assignedIndex = ri;
          break;
        }
      }
      if (assignedGroup >= 0) break;
    }
  }

  // Choose role
  const role = assignedIndex >= 0
    ? deepClone(makeRole(assignedIndex))
    : deepClone(makeRole(0));

  // Place user
  if (assignedGroup >= 0) {
    const u: GameUser = { name: userName, socketId, cost: 0, inventory: STARTING_INVENTORY, backlog: 0, role, inventoryHistory: [], backlogHistory: [], costHistory: [], orderHistory: [] };
    groups[assignedGroup].users[assignedIndex] = u;
    const lu: UserLookup = { name: userName, socketId, group: assignedGroup, index: assignedIndex };
    users[userName] = lu;
    return lu;
  }

  // No slot available — create new group
  if (groups.length === 0) {
    groups.push({ week: 0, cost: 0, users: [], waitingForOrders: [], demandTrend: DEFAULT_DEMAND_TREND, demandProfile: DEMAND_PROFILES[DEFAULT_DEMAND_TREND], shipping: [], mailing: [], costHistory: [], ready: false });
  }

  const last = groups[groups.length - 1];
  const newUser: GameUser = { name: userName, socketId, cost: 0, inventory: STARTING_INVENTORY, backlog: 0, role, inventoryHistory: [], backlogHistory: [], costHistory: [], orderHistory: [] };

  if (last.users.length < 4) {
    last.users.push(newUser);
  } else {
    const ng: Group = { week: 0, cost: 0, users: [newUser], waitingForOrders: [], demandTrend: DEFAULT_DEMAND_TREND, demandProfile: DEMAND_PROFILES[DEFAULT_DEMAND_TREND], shipping: [], mailing: [], costHistory: [], ready: false };
    groups.push(ng);
  }

  const gidx = groups.length - 1;
  const uidx = groups[gidx].users.length - 1;
  const newLookup: UserLookup = { name: userName, socketId, group: gidx, index: uidx };
  users[userName] = newLookup;
  return newLookup;
}

// ── Reset ──────────────────────────────────────────────────────────────

function resetGame(): void {
  for (const g of groups) {
    g.week = 0;
    g.cost = 0;
    // Create fresh role copies for each user
    const roles = [makeRole(0), makeRole(1), makeRole(2), makeRole(3)];
    for (let j = 0; j < g.users.length; j++) {
      g.users[j].role = roles[j];
      g.users[j].cost = 0;
      g.users[j].inventory = STARTING_INVENTORY;
      g.users[j].backlog = 0;
    }
  }
}

// ── Express & Socket.IO ────────────────────────────────────────────────

const app = express();
const http = createServer(app);
const io = new Server(http, {
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
});

app.use(express.static(resolve(__dirname, '..', 'public')));

io.on('connection', (socket: Socket) => {
  let addedUser = false;

  socket.on('submit username', (msg: string, callback?: Function) => {
    if (addedUser) return;

    log('info', `${socket.id}: submit username ${msg}`);
    const reconnecting = !!(users[msg] && users[msg].disconnectedAt);
    const user = registerUser(socket.id, msg);

    if (user) {
      if (!reconnecting) numUsers++;
      (socket as any).name = user.name;
      addedUser = true;

      const g = groups[user.group];
      ack(callback, {
        numUsers,
        idx: user.index,
        group: g,
        gameEnded,
        reconnected: reconnecting,
        demandTrend: g.demandTrend || currentDemandTrend,
        demandProfile: g.demandProfile || DEMAND_PROFILES[currentDemandTrend],
      });

      socket.join(groupRoom(user.group));

      if (!gameStarted && !gameEnded) {
        io.to(groupRoom(user.group)).emit('group member joined', { idx: user.index, update: g.users[user.index] });

        const activeCount = g.users.filter(u => u && u.socketId).length;
        if (activeCount === 4) {
          io.to(groupRoom(user.group)).emit('group ready');
        }
      }

      if (reconnecting && gameStarted && !gameEnded) {
        socket.to(groupRoom(user.group)).emit('player rejoined', {
          idx: user.index,
          update: g.users[user.index],
        });
      }

      // If game is active and this group is full but not yet started, init now
      if (gameStarted && !gameEnded && g.week === 0 && g.users.length === 4) {
        initGroup(user.group);
      } else if (gameStarted && !gameEnded && g.week > 0 && !reconnecting) {
        // Game already running, send current state to newly joining player
        socket.emit('game started', {
          numUsers,
          week: g.week,
          waitingForOrders: g.waitingForOrders,
          demandTrend: g.demandTrend,
          demandProfile: g.demandProfile,
        });
      }

      socket.broadcast.emit('user joined', { username: (socket as any).name, numUsers });
      io.to('admins').emit('update table', { numUsers, groups });
    } else {
      if (!gameStarted) {
        ack(callback, '游戏尚未开始，请等待管理员启动。');
      } else if (gameEnded) {
        ack(callback, 'Game Ended');
      } else {
        ack(callback, 'Game Started');
      }
    }
  });

  socket.on('disconnect', () => {
    if (!addedUser) return;
    const name = (socket as any).name as string | undefined;
    if (!name) return;

    log('info', `disconnect: ${name}`);
    const u = users[name];
    if (!u || u.socketId !== socket.id) return;

    u.disconnectedAt = Date.now();
    const g = groups[u.group];
    g.users[u.index].disconnectedAt = u.disconnectedAt;

    clearDisconnectTimer(u);
    u.disconnectTimer = setTimeout(() => finalizeDisconnect(name), RECONNECT_GRACE_MS);
  });

  socket.on('submit password', (msg: string, callback?: Function) => {
    if (msg === ADMIN_PASSWORD) {
      socket.join('admins');
      let status = 'waiting';
      if (gameStarted && !gameEnded) status = 'started';
      else if (gameStarted && gameEnded) status = 'ended';
      ack(callback, { status, numUsers, groups, demandTrend: currentDemandTrend, demandProfile: DEMAND_PROFILES[currentDemandTrend] });
    } else {
      ack(callback, 'Invalid Password');
    }
  });

  socket.on('change group', (msg: string) => {
    socket.leave(groupRoom(Number(msg) + 1));
    socket.join(groupRoom(msg));
  });

  socket.on('ack getting kicked', () => {
    addedUser = false;
  });

  socket.on('remove group', (msg: string, callback?: Function) => {
    const idx = Number(msg);
    if (msg === '' || idx >= groups.length || idx < 0) {
      ack(callback, 'Error');
      return;
    }

    const toRemove = groups[idx].users.length;
    for (const u of groups[idx].users) {
      log('info', `removing: ${u.name}`);
      clearDisconnectTimer(users[u.name]);
      delete users[u.name];
    }
    groups.splice(idx, 1);
    numUsers -= toRemove;

    io.to(groupRoom(idx)).emit('kicked out', idx);

    for (let i = idx; i < groups.length; i++) {
      for (let j = 0; j < groups[i].users.length; j++) {
        const uname = groups[i].users[j].name;
        users[uname].group--;
        const sid = users[uname].socketId;
        if (sid) io.to(sid).emit('change group subscription', users[uname].group);
      }
    }

    ack(callback, { numUsers, groups });
  });

  socket.on('start game', (options: { demandTrend?: string } | Function, callback?: Function) => {
    if (typeof options === 'function') {
      callback = options;
      options = {} as any;
    }
    const opts = (options && typeof options === 'object') ? options : {};

    if (gameStarted && !gameEnded) {
      return ack(callback as Function, { err: '游戏已经开始。' });
    }
    if (gameEnded) {
      return ack(callback as Function, { err: '游戏已结束，请先重置再开始。' });
    }

    const selectedTrend = normalizeTrend(opts.demandTrend || DEFAULT_DEMAND_TREND);

    log('info', `start game: trend=${selectedTrend}`);
    gameStarted = true;
    gameEnded = false;
    currentDemandTrend = selectedTrend;
    ack(callback as Function, { numUsers, demandTrend: currentDemandTrend, demandProfile: DEMAND_PROFILES[currentDemandTrend] });

    // Init any existing groups with at least 1 user (handles reset→restart case)
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].users.length > 0 && groups[i].week === 0) {
        initGroup(i);
      }
    }
  });

  socket.on('reset game', (callback?: Function) => {
    if (!gameStarted) {
      ack(callback, 'Error');
      return;
    }
    gameStarted = false;
    gameEnded = false;
    currentDemandTrend = DEFAULT_DEMAND_TREND;
    resetGame();
    ack(callback, { numUsers, groups });
    socket.broadcast.emit('game reset', { numUsers, week: 0 });
  });

  socket.on('end game', (callback?: Function) => {
    if (!gameStarted || gameEnded) {
      ack(callback, 'Error');
      return;
    }
    gameEnded = true;
    ack(callback, { numUsers, groups });
    socket.broadcast.emit('game ended', { numUsers });
  });

  socket.on('submit order', (order: string, callback?: Function) => {
    const name = (socket as any).name as string | undefined;
    const user = name ? users[name] : undefined;
    if (!user || user.group === undefined) {
      log('warn', 'submit order: user not registered');
      return ack(callback, { err: '用户未注册或未加入团队。' });
    }

    const g = groups[user.group];
    if (!g) {
      log('warn', 'submit order: group not found');
      return ack(callback, { err: '团队未找到。' });
    }

    if (g.week > MAX_WEEKS) {
      return ack(callback, { err: `游戏已完成 ${MAX_WEEKS} 周，不再接受订单。` });
    }

    // Validate order
    const parsed = parseInt(order, 10);
    if (isNaN(parsed) || parsed < 0 || !/^\d+$/.test(String(order).trim())) {
      return ack(callback, { err: '订单数量必须是有效的非负整数。' });
    }

    log('info', `order: ${name} group=${user.group} amount=${parsed}`);

    g.users[user.index].role.upstream.orders = parsed;

    const idx = g.waitingForOrders.indexOf(g.users[user.index].role.name);
    if (idx !== -1) {
      g.waitingForOrders.splice(idx, 1);
    }

    if (g.waitingForOrders.length === 0) {
      ack(callback);
      advanceTurn(user.group);
    } else {
      ack(callback, g.waitingForOrders);
      io.to(groupRoom(user.group)).emit('update order wait', g.waitingForOrders);
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────

http.listen(PORT, () => {
  log('info', `Beer Distribution Game Simulator v2.0 — http://0.0.0.0:${PORT}`);
});

// Export for tests
