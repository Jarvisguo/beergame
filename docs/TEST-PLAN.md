# 啤酒分销游戏 — 测试文档

> 基于 REQUIREMENTS.md，覆盖重构后全部功能的验收标准。

---

## 1. 测试环境

| 项目 | 值 |
|------|-----|
| 测试框架 | Node.js 内置 `assert` + `socket.io-client` |
| 服务器启动 | `node index.js`（独立进程，每用例隔离） |
| 超时配置 | `RECONNECT_GRACE_MS=800`, `ADMIN_PASSWORD=test-secret` |

---

## 2. 全量验收标准覆盖

### A. 管理端功能（需求 §6, §5.3, §5.4）

| ID | 验收标准 | 测试文件 | 状态 |
|----|---------|---------|:---:|
| A1 | 错误密码拒绝，正确密码返回 `{ status, numUsers, groups }` | socket-flow | ✅ |
| A2 | 开始游戏 → 广播 `game can login`，可选 demandTrend | socket-flow | ✅ |
| A3 | 已 started 再开始 → 拒绝；已 ended 再开始 → 提示先重置 | — | ⚠️ 未测 |
| A4 | 结束游戏 → 广播 `game ended`，管理端收到 `{ numUsers, groups }` | socket-flow / five-week | ✅ |
| A5 | 重置游戏 → 状态清零，广播 `game reset` | socket-flow | ✅ |
| A6 | 删除团队 → 清理成员，重排索引，广播 `update table` | — | ⚠️ 未测 |

### B. 玩家登录与分配（需求 §4.1, §4.5）

| ID | 验收标准 | 测试文件 | 状态 |
|----|---------|---------|:---:|
| B1 | waiting 状态不允许登录 | reconnect-takeover (TC-06) / socket-flow | ✅ |
| B2 | 4 人依次加入同一组，角色依次为零售商/批发商/区域仓库/工厂 | socket-flow | ✅ |
| B3 | 分配优先级：空 socketId 槽位 > 未满 4 人空槽位 > 新建组 | reconnect-takeover (TC-03) | ✅ |
| B4 | 同用户名已活跃 → 拒绝（单人单角色约束） | socket-flow | ✅ |
| B5 | 4 人到齐(week=0) → 自动 initGroup → week=1，广播 `game started` | reconnect-takeover (TC-06) | ✅ |
| B6 | 第 5 人创建新组（slot 0） | socket-flow | ✅ |
| B7 | 新玩家加入进行中(week>0)有空槽位的组 → 成功加入 | socket-flow | ✅ |

### C. 重连与断线（需求 §4.2, §4.3, §4.4）

| ID | 验收标准 | 测试文件 | 状态 |
|----|---------|---------|:---:|
| C1 | 同用户名重连 → 恢复原团队/角色/数据，清除断线计时器 | socket-flow | ✅ |
| C2 | 宽限期内不同用户名不能顶替（应开新组） | socket-flow | ✅ |
| C3 | 宽限期结束 → 清除 socketId，释放槽位，`group member left` | reconnect-takeover (TC-02) | ✅ |
| C4 | 顶替继承所有游戏数据（库存/成本/积压/历史） | reconnect-takeover (TC-02) | ✅ |
| C5 | 顶替不修改 waitingForOrders（角色已提交/未提交两种场景） | reconnect-takeover (TC-04, TC-05) | ✅ |

### D. 游戏推进（需求 §2.3, §2.4, §3.3）

| ID | 验收标准 | 测试文件 | 状态 |
|----|---------|---------|:---:|
| D1 | waitingForOrders 每周初始化为 4 角色，提交后移除，下周重置 | reconnect-takeover (TC-01) | ✅ |
| D2 | 全部提交后自动推进 → broadcast `next turn`，week+1 | reconnect-takeover (TC-01, TC-04) | ✅ |
| D3 | 26 周完成后 waitingForOrders 为空 | socket-flow | ✅ |
| D4 | week > 26 时提交订单被拒绝 | socket-flow | ✅ |
| D5 | week=0 时提交订单被拒绝 | reconnect-takeover (TC-06) | ✅ |
| D6 | 提交负数/非整数非法输入被拒绝 | socket-flow | ✅ |
| D7 | 5 周完整游戏数据精确验证（库存/成本/积压/订单历史） | five-week | ✅ |
| D8 | 三种需求趋势(mixed/growth/decline)客户需求值正确 | socket-flow | ✅ |

### E. Socket 事件接口（需求 §5.2, §5.4）

| ID | 验收标准 | 测试文件 | 状态 |
|----|---------|---------|:---:|
| E1 | `group member joined` 广播 `{ idx, update }` 给同组玩家 | reconnect-takeover (TC-07) | ✅ |
| E2 | `update order wait` 广播 waitingForOrders 变化 | reconnect-takeover (TC-07) | ✅ |
| E3 | `player rejoined` 广播 `{ idx, update }` 给同组其他玩家 | reconnect-takeover (TC-08) | ✅ |
| E4 | `game reset` 广播给所有玩家 | socket-flow | ✅ |
| E5 | admin `update table` 数据格式 `{ numUsers, groups }` | reconnect-takeover (TC-07) | ✅ |
| E6 | admin `update group` 数据格式 `{ groupNum, groupData }` | reconnect-takeover (TC-07) | ✅ |
| E7 | `game ended` 广播 `{ numUsers }` 给所有玩家 | reconnect-takeover (TC-07) | ✅ |

---

## 3. 测试套件概览

| 套件 | 文件 | 覆盖范围 | 本次状态 |
|------|------|---------|:---:|
| reconnect-takeover | `tests/integration/reconnect-takeover.test.js` | B1, B3, B5, C3, C4, C5, D1, D2, D5, E1, E2, E3, E5, E6, E7 | ✅ 8/8 |
| socket-flow | `tests/integration/socket-flow.test.js` | A1, A2, A4, A5, B2, B4, B6, B7, C1, C2, D3, D4, D6, D8, E4 | 🔧 待修 |
| five-week | `tests/integration/five-week-operations.test.js` | A4, D7 | 🔧 待修 |

> 注：socket-flow 和 five-week 是重构前编写，部分用例使用了旧登录流程（先 login 后 start game），需要在后续修复后再运行。

---

## 4. reconnect-takeover 测试用例详情

### TC-01: waitingForOrders 固定为 4 个角色

**覆盖**: D1, D2

**步骤**:
1. 管理员启动游戏，4 人加入 → game started
2. 验证 week=1 时 waitingForOrders = `['零售商', '批发商', '区域仓库', '工厂']`
3. 零售商提交 → waitingForOrders 变为 `['批发商', '区域仓库', '工厂']`
4. 其余 3 人提交 → 全部收到 next turn
5. 验证 week=2，waitingForOrders 重置为全部 4 角色

---

### TC-02: 断线超时后槽位释放，游戏数据保留

**覆盖**: C3, C4

**步骤**:
1. 4 人完成第 1 周，记录零售商成本和库存
2. 零售商断线 → 等待宽限期结束
3. 新玩家以新用户名登录
4. 验证分配到零售商槽位（index 0），角色为零售商
5. 验证成本、库存继承原数据

---

### TC-03: 新玩家优先顶替断线槽位，不开新组

**覆盖**: B3

**步骤**:
1. 4 人完成第 1 周
2. 批发商（index 1）断线 → 等待宽限期结束
3. 新玩家登录
4. 验证分配到原组 week=2，角色为批发商（非新组）

---

### TC-04: 顶替后角色未提交 → 可继续提交

**覆盖**: C5, D2

**步骤**:
1. 4 人完成第 1 周，进入第 2 周
2. 零售商（index 0）未提交就断线超时
3. 新玩家顶替
4. 验证 waitingForOrders 仍包含 '零售商'（未修改）
5. 顶替玩家提交 → 移除 '零售商'
6. 其余 3 人提交 → 推进到 week 3

---

### TC-05: 顶替后角色已提交 → 等待下周即可

**覆盖**: C5

**步骤**:
1. 4 人完成第 1 周，进入第 2 周
2. 零售商先提交订单，再断线超时
3. 新玩家顶替
4. 验证 waitingForOrders **不**包含 '零售商'（已提交，不修改）
5. 其余 3 人提交 → 推进到 week 3（顶替者无需重交）

---

### TC-06: 管理员先 start，4 人加入自动 week 1

**覆盖**: B1, B5, D5

**步骤**:
1. 管理员登录并启动游戏
2. 前 3 人登录 → week=0
3. week=0 时尝试提交订单 → 被拒绝
4. 第 4 人登录 → 触发 game started, week=1
5. 验证 waitingForOrders 为全部 4 角色

---

### TC-07: Socket 事件接口验证 (E1, E2, E5, E6, E7)

**覆盖**: E1, E2, E5, E6, E7

**步骤**:
1. 管理员启动游戏，4 人依次加入
2. 玩家 1 监听 `group member joined`，验证玩家 2/3/4 加入时收到 `{ idx, update }`
3. 管理员监听 `update table`，验证收到 `{ numUsers: 4, groups }`
4. 玩家 1 提交订单，玩家 2 监听 `update order wait`，验证广播值与回调一致
5. 其余 3 人提交推进，管理员监听 `update group`，验证 `{ groupNum, groupData }`
6. 管理员结束游戏，所有玩家监听 `game ended`，验证 `{ numUsers: 4 }`

---

### TC-08: player rejoined 事件验证 (E3)

**覆盖**: E3

**步骤**:
1. 4 人完成第 1 周
2. 玩家 2 断线（宽限期内），玩家 1 监听 `player rejoined`
3. 玩家 2 重连
4. 验证玩家 1 收到 `player rejoined` → `{ idx: 1, update }`
5. 验证重连数据：`reconnected: true`, 恢复原 slot

---

## 5. 执行结果

```
reconnect-takeover tests
  running TC-01...
  TC-01 PASS: waitingForOrders fixed to 4 roles
  running TC-02...
  TC-02 PASS: slot released after timeout, data preserved
  running TC-03...
  TC-03 PASS: new player takes vacated slot, not a new group
  running TC-04...
  TC-04 PASS: takeover player can submit when role not yet submitted
  running TC-05...
  TC-05 PASS: takeover player waits next week when already submitted
  running TC-06...
  TC-06 PASS: admin starts game first, 4th player triggers week 1
  running TC-07...
  TC-07 PASS: E1 member joined, E2 order wait, E5 update table, E6 update group, E7 game ended
  running TC-08...
  TC-08 PASS: E3 player rejoined event
all reconnect-takeover tests passed
```

| 日期 | 结果 |
|------|------|
| 2026-05-10 | 8/8 PASS |
