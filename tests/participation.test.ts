import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state/store.js';
import { registerUser, finalizeDisconnect } from '../src/state/users.js';
import { registerAdminHandlers } from '../src/socket/admin.js';
test('assignment provenance survives reconnect, takeover, removal and AI removal',()=>{
 state.groups=[];state.users={};state.numUsers=0;state.gameStarted=true;state.gameEnded=false;
 const io:any={sockets:{sockets:new Map()},to:()=>({emit(){}})};
 registerUser('one','甲',io);const g=state.groups[0];assert.equal(g.roleAssignments![0].length,1);
 registerUser('two','甲',io);assert.equal(g.roleAssignments![0].length,1,'reconnect is not takeover');
 state.users['甲'].disconnectedAt=Date.now();finalizeDisconnect('甲',()=>{});
 registerUser('three','乙',io);assert.deepEqual(g.roleAssignments![0].map(r=>r.name),['甲','乙']);
 const handlers=new Map();registerAdminHandlers(io,{id:'admin',rooms:new Set(['admins']),on:(e:string,h:any)=>handlers.set(e,h)} as any);
 handlers.get('remove member')({groupIndex:0,roleIndex:0},()=>{});
 handlers.get('add agent')({groupIndex:0,roleIndex:0},()=>{});
 handlers.get('remove agent')({groupIndex:0,roleIndex:0},()=>{});
 registerUser('four','丙',io);
 assert.deepEqual(g.roleAssignments![0].map(r=>r.kind),['human','human','ai','human']);
 assert.equal(g.users[0].name,'丙');
 state.groups=[];state.users={};state.numUsers=0;state.gameStarted=false;
});

test('legacy assignments keep newly observed AI events without certifying earlier history',async()=>{
 const {recordAssignment}=await import('../src/state/participation.js');
 const g:any={week:10};
 recordAssignment(g,0,'旧成员','ai');recordAssignment(g,0,'旧成员','ai');recordAssignment(g,0,'接替者','human');
 assert.equal(g.roleAssignmentsComplete,false);
 assert.deepEqual(g.roleAssignments[0].map((r:any)=>r.kind),['ai','human']);
});
