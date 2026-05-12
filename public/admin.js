/* ========================================================================
 * Beer Distribution Game — 管理端 (modern vanilla JS)
 * ======================================================================== */

const MAX_WEEKS = 26;

const $ = (sel) => document.querySelector(sel);

// ── Socket ────────────────────────────────────────────────────────────
const socket = io(undefined, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 99999,
  timeout: 45000,
});

// ── State ─────────────────────────────────────────────────────────────
let gameGroup = [];
let adminGameStarted = false;
let adminGameEnded = false;
let agentTarget = null; // { groupIndex, roleIndex }

// Expose for report page
window.gameGroup = gameGroup;

// ── Helpers ───────────────────────────────────────────────────────────
function formatWeek(g) {
  const w = g.week || 0;
  const completed = Math.max(0, Math.min(w - 1, MAX_WEEKS));
  if (w > MAX_WEEKS) return `已完成 ${completed} 轮`;
  return `已完成 ${completed} 轮，当前第 ${w} 周`;
}

function calcGroupBullwhip(g) {
  if (!g.users || g.users.length === 0) return null;
  let maxCV = -1;
  for (const u of g.users) {
    const orders = (u.orderHistory || []).filter(x => typeof x === 'number');
    if (orders.length < 2) continue;
    const mean = orders.reduce((a, b) => a + b, 0) / orders.length;
    const variance = orders.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / orders.length;
    const cv = Math.sqrt(variance) / (mean || 1);
    if (cv > maxCV) maxCV = cv;
  }
  if (maxCV < 0) return null;
  if (maxCV >= 0.3) return { label: '剧烈', cls: 'tag-red' };
  if (maxCV >= 0.1) return { label: '波动', cls: 'tag-yellow' };
  return { label: '稳定', cls: 'tag-green' };
}

function updateAdminStatus() {
  const n = gameGroup.reduce((a, g) => a + g.users.filter(u => u.socketId).length, 0);
  const trendText = { growth: '增长趋势', decline: '下降趋势', mixed: '混合趋势' }[$('#demandTrend').value || 'mixed'];
  if (adminGameStarted) {
    const prefix = adminGameEnded ? '游戏已结束。' : '游戏进行中。';
    $('#adminStatus').textContent = `${prefix} 在线 ${n} 人，客户需求：${trendText}。`;
  } else {
    $('#adminStatus').textContent = `游戏尚未开始。当前 ${n} 名参与者。`;
  }
}

// ── Table ─────────────────────────────────────────────────────────────
function refreshTable(groups, gameStarted) {
  const tbody = $('#adminTbody');
  tbody.innerHTML = '';

  groups.forEach((g, i) => {
    const tr = document.createElement('tr');
    const w = gameStarted ? ` (${formatWeek(g)}，¥${(g.cost || 0).toFixed(0)})` : '';
    let html = `<td>${i + 1}${w}</td>`;

    let totalInv = 0, totalBack = 0;
    for (let j = 0; j < 4; j++) {
      if (g.users[j] && !g.users[j].removed) {
        totalInv += g.users[j].inventory || 0;
        totalBack += g.users[j].backlog || 0;
        const u = g.users[j];
        let badge = '';
        if (u.agent) {
          badge = ` <span class="tag tag-agent" title="AI: ${u.agent.strategy}">🤖</span>`;
        } else if (!u.socketId) {
          badge = ' <span class="tag tag-disc">已断开</span>';
        }
        const assignBtn = (!u.socketId && !u.agent && adminGameStarted && !adminGameEnded)
          ? ` <button class="btn btn-sm btn-outline btnAgentAssign" data-group="${i}" data-role="${j}">+AI</button>`
          : '';
        const removeBtn = adminGameStarted && !adminGameEnded
          ? ` <button class="btn btn-sm btn-outline btnMemberRemove" data-group="${i}" data-role="${j}">移出</button>`
          : '';
        html += `<td>${u.name}${badge}${assignBtn}${removeBtn}</td>`;
      } else {
        if (adminGameStarted && !adminGameEnded) {
          html += `<td><button class="btn btn-sm btn-outline btnAgentAssign" data-group="${i}" data-role="${j}">+AI</button></td>`;
        } else {
          html += '<td></td>';
        }
      }
    }

    html += `<td>${totalInv}</td><td>${totalBack}</td>`;

    if (gameStarted) {
      const cost = g.cost || 0;
      html += `<td>¥${cost.toFixed(0)}</td>`;
      const bw = calcGroupBullwhip(g);
      html += bw
        ? `<td><span class="tag ${bw.cls}">${bw.label}</span></td>`
        : '<td>—</td>';
    } else {
      html += '<td>—</td><td>—</td>';
    }

    const waiting = g.waitingForOrders || [];
    html += `<td>${waiting.length ? waiting.join('、') : '-'}</td>`;

    if (!gameStarted) {
      html += `<td><button class="btn btn-sm btn-outline btnRemoveGroup" data-group="${i}">删除</button></td>`;
    } else {
      html += '<td></td>';
    }

    tr.innerHTML = html;
    tbody.appendChild(tr);
  });

  gameGroup = groups;
  window.gameGroup = gameGroup;
  try { localStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* ignore */ }
  updateAdminStatus();
}

// ── Socket Events ─────────────────────────────────────────────────────
socket.on('update table', (msg) => {
  gameGroup = msg.groups;
  window.gameGroup = gameGroup;
  try { localStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* */ }
  refreshTable(gameGroup, adminGameStarted);
});

socket.on('update group', (msg) => {
  gameGroup[msg.groupNum] = msg.groupData;
  refreshTable(gameGroup, true);
});

// ── Admin Login ───────────────────────────────────────────────────────
$('#btnAdmin').addEventListener('click', () => {
  const pw = $('#passwordInput').value;
  socket.emit('submit password', pw, (msg) => {
    if (msg === 'Invalid Password') {
      $('#wrongPass').hidden = false;
    } else {
      $('#adminLogin').hidden = true;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      try { localStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* */ }
      $('#demandTrend').value = msg.demandTrend || 'mixed';
      $('#groupPanel').hidden = false;

      if (msg.status === 'started') {
        startGameUI(msg.numUsers);
      } else if (msg.status === 'ended') {
        startGameUI(msg.numUsers);
        $('#btnEndGame').disabled = true;
        rankGroups();
      } else {
        adminGameStarted = false;
        adminGameEnded = false;
        refreshTable(gameGroup, false);
      }
    }
  });
});

$('#passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnAdmin').click();
});

// ── Game Controls ─────────────────────────────────────────────────────
$('#btnStartGame').addEventListener('click', () => {
  if ($('#btnStartGame').disabled) return;
  $('#gameError').hidden = true;
  const trend = $('#demandTrend').value || 'mixed';
  socket.emit('start game', { demandTrend: trend }, (msg) => {
    if (msg.err) {
      $('#gameError').textContent = '无法开始游戏。' + msg.err;
      $('#gameError').hidden = false;
    } else {
      $('#demandTrend').value = msg.demandTrend || trend;
      $('#groupRank').textContent = '团队 #';
      startGameUI(msg.numUsers);
    }
  });
});

$('#btnEndGame').addEventListener('click', () => {
  if ($('#btnEndGame').disabled) return;
  socket.emit('end game', (msg) => {
    if (msg === 'Error') {
      $('#gameError').textContent = '游戏无法结束。';
      $('#gameError').hidden = false;
    } else {
      adminGameEnded = true;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      $('#btnEndGame').disabled = true;
      rankGroups();
    }
  });
});

$('#btnResetGame').addEventListener('click', () => {
  if ($('#btnResetGame').disabled) return;
  socket.emit('reset game', (msg) => {
    if (msg === 'Error') {
      $('#gameError').textContent = '游戏无法重置。';
      $('#gameError').hidden = false;
    } else {
      adminGameStarted = false;
      adminGameEnded = false;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      $('#btnStartGame').disabled = false;
      $('#btnEndGame').disabled = false;
      $('#btnEndGame').hidden = true;
      $('#btnResetGame').hidden = true;
      $('#gameSettings').hidden = false;
      $('#groupRank').textContent = '团队 #';
      refreshTable(gameGroup, false);
    }
  });
});

$('#btnReport').addEventListener('click', () => {
  window.open('report.html', '_blank');
});

// Delete group
$('#adminTbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.btnRemoveGroup');
  if (!btn) return;
  const groupIdx = btn.getAttribute('data-group');
  socket.emit('remove group', groupIdx, (msg) => {
    if (msg !== 'Error') {
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      refreshTable(gameGroup, false);
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────
function startGameUI(numUsers) {
  adminGameStarted = true;
  adminGameEnded = false;
  $('#gameSettings').hidden = true;
  $('#btnStartGame').disabled = true;
  $('#btnEndGame').disabled = false;
  $('#btnEndGame').hidden = false;
  $('#btnResetGame').hidden = false;

  refreshTable(gameGroup, true);
}

function rankGroups() {
  adminGameStarted = true;
  adminGameEnded = true;
  $('#groupRank').textContent = '排名';

  let lowestWeek = Infinity;
  gameGroup.forEach(g => { if (g.week < lowestWeek) lowestWeek = g.week; });

  gameGroup.sort((a, b) => {
    const ca = a.costHistory[lowestWeek - 1] || 0;
    const cb = b.costHistory[lowestWeek - 1] || 0;
    return ca - cb;
  });

  refreshTable(gameGroup, true);
}

// ── AI Agent Management ────────────────────────────────────────────────
$('#btnFillAI').addEventListener('click', () => {
  if (!adminGameStarted || adminGameEnded) return;
  gameGroup.forEach((g, gi) => {
    if (g.week > MAX_WEEKS) return;
    for (let ri = 0; ri < 4; ri++) {
      const u = g.users[ri];
      if (!u || (!u.socketId && !u.agent)) {
        socket.emit('add agent', { groupIndex: gi, roleIndex: ri, strategy: 'default', params: {} });
      }
    }
  });
});

$('#adminTbody').addEventListener('click', (e) => {
  const assignBtn = e.target.closest('.btnAgentAssign');
  const removeBtn = e.target.closest('.btnMemberRemove');

  if (assignBtn) {
    agentTarget = {
      groupIndex: parseInt(assignBtn.getAttribute('data-group')),
      roleIndex: parseInt(assignBtn.getAttribute('data-role')),
    };
    const g = gameGroup[agentTarget.groupIndex];
    const roleNames = ['零售商', '批发商', '区域仓库', '工厂'];
    $('#agentGroupLabel').textContent = '队伍 ' + (agentTarget.groupIndex + 1);
    $('#agentRoleLabel').textContent = roleNames[agentTarget.roleIndex];
    $('#agentModal').hidden = false;
  }

  if (removeBtn) {
    const gi = parseInt(removeBtn.getAttribute('data-group'));
    const ri = parseInt(removeBtn.getAttribute('data-role'));
    const u = gameGroup[gi] && gameGroup[gi].users && gameGroup[gi].users[ri];
    const label = u && u.name ? u.name : `队伍 ${gi + 1} 角色 ${ri + 1}`;
    if (!window.confirm(`确认将 ${label} 移出房间？`)) return;
    socket.emit('remove member', { groupIndex: gi, roleIndex: ri, reason: 'admin' }, (msg) => {
      if (msg && msg.err) {
        $('#gameError').textContent = '移出失败。' + msg.err;
        $('#gameError').hidden = false;
      }
    });
  }
});

$('#btnAgentCancel').addEventListener('click', () => {
  $('#agentModal').hidden = true;
  agentTarget = null;
});

$('#btnAgentConfirm').addEventListener('click', () => {
  if (!agentTarget) return;
  const strategy = $('#agentStrategy').value || 'default';
  socket.emit('add agent', {
    groupIndex: agentTarget.groupIndex,
    roleIndex: agentTarget.roleIndex,
    strategy,
    params: {},
  });
  $('#agentModal').hidden = true;
  agentTarget = null;
});
