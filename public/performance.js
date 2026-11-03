/* Role results are not a causal estimate of an individual's ability. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BeerPerformance = api;
})(globalThis, function() {
  const roles = ['零售商', '批发商', '区域仓库', '工厂'];
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  function settled(history, final, start) {
    if (start !== 1 || !Array.isArray(history) || history.length !== 26 || !history.every(valid) || !valid(final)) return null;
    return history.slice(1).concat(final);
  }
  function member(group, index) {
    const user = group.users[index];
    const roleName = user.role && user.role.name;
    const history = group.roleAssignments && group.roleAssignments[roles.indexOf(roleName)];
    const known = Array.isArray(history) && history.length > 0;
    const ai = !!user.agent || (known && history.some(h => h.kind === 'ai'));
    const takeover = known && history.length > 1;
    const inventory = settled(user.inventoryHistory, user.inventory, user.historyStartWeek);
    const backlog = settled(user.backlogHistory, user.backlog, user.historyStartWeek);
    const complete = inventory && backlog && Array.isArray(user.orderHistory) && user.orderHistory.length === 26 && user.orderHistory.every(valid) && valid(user.cost);
    const reasons = [];
    if (!known || group.roleAssignmentsComplete === false) reasons.push('参与历史未知');
    if (!roles.includes(roleName)) reasons.push('角色未知');
    if (takeover) reasons.push('接替／多人参与');
    if (ai) reasons.push('含 AI 补位记录');
    if (known && (history[0].week > 1 || history[0].name !== user.name)) reasons.push('非同一成员全程参与');
    if (user.removed) reasons.push('成员已移除');
    if (!complete) reasons.push('26 周数据不完整');
    return { user, index, eligible: reasons.length === 0, status: reasons.join('；') || '完整人工参与', history: known ? history : [],
      cost: valid(user.cost) ? user.cost : null,
      backlogSum: backlog ? backlog.reduce((a,b)=>a+b,0) : null,
      backlogWeeks: backlog ? backlog.filter(v=>v>0).length : null,
      inventorySum: inventory ? inventory.reduce((a,b)=>a+b,0) : null };
  }
  function boards(groups) {
    const result = new Map();
    groups.forEach((g,i)=>{
      if (!Number.isInteger(g.week) || g.week <= 26) return;
      (g.users || []).forEach((u,index)=>{
        if (!u) return;
        const m = member(g,index);
        if (!m.eligible || !roles.includes(u.role && u.role.name)) return;
        // Compare actual schedules as well as the named scenario.
        const scenario = JSON.stringify([g.demandTrend || '未知', g.demandProfile && g.demandProfile.schedule || null]);
        const key = JSON.stringify([u.role.name,scenario]);
        if (!result.has(key)) result.set(key,{role:u.role.name,scenario,trend:g.demandTrend || '未知',rows:[]});
        result.get(key).rows.push({...m,groupNumber:(g._originalIndex ?? i)+1});
      });
    });
    for (const board of result.values()) {
      board.rows.sort((a,b)=>a.cost-b.cost || a.groupNumber-b.groupNumber);
      board.rows.forEach((r,i)=>{r.rank=i>0 && r.cost===board.rows[i-1].cost ? board.rows[i-1].rank : i+1;});
    }
    return [...result.values()].sort((a,b)=>roles.indexOf(a.role)-roles.indexOf(b.role));
  }
  return {member,boards};
});
