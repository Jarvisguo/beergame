const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/performance.js');
function group(cost=13) { return {week:27, demandTrend:'mixed', demandProfile:{schedule:[{until:26,demand:4}]}, roleAssignments:[[{name:'甲',kind:'human',week:1}]], users:[{name:'甲',role:{name:'零售商'},historyStartWeek:1,cost,inventory:0,backlog:3,inventoryHistory:Array(26).fill(12),backlogHistory:[99,...Array(25).fill(0)],costHistory:Array(26).fill(0),orderHistory:Array(26).fill(4)}]}; }
test('ranks only completed eligible humans by role/scenario with exact-cost ties',()=>{
 const a=group(),b=group(),c=group(13.5),d=group(1);d.week=26;
 const boards=P.boards([a,b,c,d]); assert.deepEqual(boards[0].rows.map(r=>r.rank),[1,1,3]);
 c.demandProfile.schedule[0].demand=8;assert.equal(P.boards([a,c]).length,2);
});
test('uses post-settlement history including final week and excludes setup',()=>{
 const m=P.member(group(),0);assert.equal(m.backlogSum,3);assert.equal(m.backlogWeeks,1);assert.equal(m.inventorySum,300);
});
test('takeovers, AI history and legacy data are marked and excluded, not scored as zero',()=>{
 for(const mode of ['takeover','ai','legacy','partial']){
  const g=group();if(mode==='takeover')g.roleAssignments[0].push({name:'甲',kind:'human',week:8});
  if(mode==='ai')g.roleAssignments[0].push({name:'AI',kind:'ai',week:8});
  if(mode==='legacy')delete g.roleAssignments;
  if(mode==='partial')g.users[0].backlogHistory=[];
  assert.equal(P.member(g,0).eligible,false,mode);assert.equal(P.boards([g]).length,0);
 }
});
test('unknown role and incomplete assignment provenance remain unranked without crashing',()=>{
 const g=group();delete g.users[0].role;assert.doesNotThrow(()=>P.boards([g]));
 const old=group();old.roleAssignmentsComplete=false;old.roleAssignments[0].push({name:'AI',kind:'ai',week:10});
 assert.match(P.member(old,0).status,/参与历史未知/);assert.match(P.member(old,0).status,/AI/);assert.equal(P.boards([old]).length,0);
});
