# 啤酒分销游戏 — 重构实施计划

> 基于 REQUIREMENTS.md 的服务端重构方案

---

## 1. 旧代码分析

### 1.1 现有文件结构

```
src/
└── server.ts          # 单文件，约 500 行，所有逻辑混在一起

index.js               # 入口：require('tsx/cjs'); require('./src/server.ts');
```

### 1.2 旧代码问题清单

| 问题 | 位置 | 处理方式 |
|------|------|---------|
| 所有逻辑在单文件 | server.ts | 拆分为多模块 |
| `RECONNECT_GRACE_MS` 默认 300000ms（5 分钟） | server.ts:97 | 改为 180000ms（3 分钟） |
| `registerUser` 分配逻辑：仅允许 week=0 的空槽位 | server.ts:175-213 | 改为允许任意 week 的空槽位 |
| 全局变量（`groups`, `users`, `numUsers` 等）直接操作 | server.ts:104-110 | 封装到状态模块 |
| `initGroup` 和 `advanceTurn` 依赖全局 `io` | server.ts | 解耦，通过参数传入回调 |
| `start game` 时只 init week=0 且有用户的组（缺少新场景处理） | server.ts | 按需完善 |
| `submit order` 推进条件：`g.users.length === 4`（不健壮） | server.ts:281 | 改为 `waitingForOrders.length === 0` |
| 单人多角色未做检查 | registerUser | 新增用户名唯一性校验 |

### 1.3 可复用的代码

以下逻辑可直接迁移，无需大改：

- **类型定义**（Role, GameUser, UserLookup, Group 等）→ `src/types.ts`
- **常量**（BEER_NAMES, DEMAND_PROFILES, 成本参数等）→ `src/config.ts`
- **辅助函数**（`log`, `ack`, `deepClone`, `clearDisconnectTimer`, `makeRole`, `customerDemand`, `normalizeTrend`）→ `src/utils.ts`
- **`advanceTurn` 核心逻辑**（游戏规则正确）→ `src/game/turn.ts`（解耦 io 依赖）
- **`finalizeDisconnect` 逻辑**→ `src/state/users.ts`
- **Express/Socket.IO 初始化代码**→ `src/server.ts`（精简版）

### 1.4 需要删除的代码

- 旧 `src/server.ts` 的全量内容（替换为新的精简版）
- `index.js` 保持不变（入口文件不动）

---

## 2. 目标文件结构

```
src/
├── config.ts              # 常量 + 环境变量
├── types.ts               # 接口类型定义
├── utils.ts               # 纯工具函数（log, deepClone, makeRole 等）
├── game/
│   ├── demand.ts          # customerDemand, normalizeTrend
│   └── turn.ts            # advanceTurn（纯函数，不依赖 io）
├── state/
│   ├── store.ts           # 全局状态（groups, users, numUsers, gameStarted, gameEnded）
│   └── users.ts           # registerUser, finalizeDisconnect
├── socket/
│   ├── player.ts          # 玩家端事件：submit username, submit order, disconnect
│   └── admin.ts           # 管理端事件：submit password, start/end/reset game, remove group
└── server.ts              # Express + Socket.IO 初始化 + 挂载路由（精简，< 50 行）
```

---

## 3. 关键修改详情

### 3.1 registerUser — 分配优先级修改

**旧逻辑：**
```
1. 已有用户名 → 重连
2. week > 0 → 查找 socketId 为空的槽位（顶替）
3. week === 0 且 < 4 人 → 分配空槽位
4. 创建新组
```

**新逻辑：**
```
1. 已有用户名 → 重连（同名不允许同时活跃，需检查是否已活跃）
2. 同用户名已活跃 → 拒绝（单人单角色约束）
3. 查找所有组中 socketId 为空的槽位（优先）
4. 查找所有组中 < 4 人的空槽位（不限 week）
5. 创建新组
```

### 3.2 断线宽限期

```typescript
// config.ts
const RECONNECT_GRACE_MS = (() => {
  const v = parseInt(process.env.MOBILE_RECONNECT_GRACE_MS || '180000', 10);  // 默认 3 分钟
  return isNaN(v) || v < 0 ? 180000 : v;
})();
```

### 3.3 advanceTurn — 解耦 io

```typescript
// game/turn.ts
export function advanceTurn(
  g: Group,
  groupIndex: number,
  currentDemandTrend: string,
  emit: (event: string, data: unknown, target: 'room' | 'socket' | 'admins', id?: string) => void
): void { ... }
```

### 3.4 submit order 推进条件修复

```typescript
// 旧（有 bug）：
if (g.waitingForOrders.length === 0 && g.users.length === 4) {

// 新（正确）：
if (g.waitingForOrders.length === 0) {
```

---

## 4. 验收标准

### 4.1 功能验收

| # | 场景 | 预期结果 |
|---|------|---------|
| F1 | 管理员登录，密码正确 | 返回游戏状态 |
| F2 | 管理员开始游戏 | 广播 `game can login` |
| F3 | 4 名玩家依次加入同一组 | 组自动推进到第 1 周，广播 `game started` |
| F4 | 所有玩家提交订单 | 触发 `advanceTurn`，广播 `next turn` |
| F5 | 完成 26 周 | 游戏结束 |
| F6 | 玩家断线后 3 分钟内重连 | 恢复状态 |
| F7 | 玩家断线超过 3 分钟 | 槽位释放，可被顶替 |
| F8 | 新玩家加入有空槽位（非 week=0）的组 | 成功加入，可本周下单 |
| F9 | 同用户名二次登录（已活跃） | 拒绝分配新槽位 |
| F10 | 管理员重置游戏 | 状态清零，广播 `game reset` |

### 4.2 技术验收

- [ ] 所有模块可独立 import，无循环依赖
- [ ] `advanceTurn` 可在不启动服务器的情况下单元测试
- [ ] `registerUser` 可在不启动服务器的情况下单元测试
- [ ] TypeScript 编译无错误（`npx tsc --noEmit`）
- [ ] 服务器正常启动（`npx tsx src/server.ts`）

---

## 5. 实施步骤

### Phase 1：基础模块（无依赖）
1. 创建 `src/types.ts`
2. 创建 `src/config.ts`（含 3 分钟默认值）
3. 创建 `src/utils.ts`

### Phase 2：游戏逻辑（依赖 Phase 1）
4. 创建 `src/game/demand.ts`
5. 创建 `src/game/turn.ts`（解耦 io）

### Phase 3：状态管理（依赖 Phase 1-2）
6. 创建 `src/state/store.ts`
7. 创建 `src/state/users.ts`（registerUser + finalizeDisconnect）

### Phase 4：Socket 事件处理（依赖 Phase 1-3）
8. 创建 `src/socket/player.ts`
9. 创建 `src/socket/admin.ts`

### Phase 5：入口整合
10. 重写 `src/server.ts`（精简版，< 50 行）
11. 验证 TypeScript 编译
12. 验证服务器启动

---

## 6. 不变约束

- `public/` 目录不动
- `index.js` 不动
- Socket 事件名和数据结构不变
- 环境变量接口不变（`PORT`, `ADMIN_PASSWORD`, `MOBILE_RECONNECT_GRACE_MS`）
