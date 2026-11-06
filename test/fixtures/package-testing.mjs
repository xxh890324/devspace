import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [installed, directory] = process.argv.slice(2);
const load = name => import(pathToFileURL(join(installed,'dist',name+'.js')).href);
const {WorkflowManager} = await load('workflow-manager');
const {WorkflowStore} = await load('workflow-store');
const {createLocalAgentDrivers} = await load('local-agent-adapters');
const subagents = {enabled:true,instructions:'on-demand',providers:[{id:'codex',driver:'codex',enabled:true},{id:'dsh',driver:'dsh',enabled:true,command:process.execPath}]};

assert.ok(createLocalAgentDrivers({subagents}).some(driver=>driver.provider==='dsh'));

mkdirSync(directory,{recursive:true});

const root=realpathSync.native(directory);

execFileSync('git',['init','-q'],{cwd:root});

execFileSync('git',['-c','user.name=Package','-c','user.email=package@example.invalid','commit','--allow-empty','-qm','fixture'],{cwd:root});

const result={status:'completed',artifacts:[],verification:[],evidence:['actual fixture files'],unresolved:[],nextOwner:'codex'};
const records=new Map();
const ok=value=>({isOk:()=>true,isErr:()=>false,value});

const agents={
 async start(input){
  let output=result;

  if(input.prompt.startsWith('Analyze'))output={...result,uncertainty:'low',testPlan:'Assert integer addition',implementationTask:'Add a node assertion test'};

  if(input.prompt.startsWith('Implement')){mkdirSync(join(input.workspaceRoot,'tests'),{recursive:true});writeFileSync(join(input.workspaceRoot,'tests/case.cjs'),"require('node:assert/strict').equal(1+1,2)");output={...result,artifacts:['tests/case.cjs']};}

  records.set(input.agentId,{turnId:input.agentId,status:'running',response:JSON.stringify(output)});

return ok({});
 },
 getTurn(id){return ok(records.get(id));},
 async wait(ids){return ok(ids.map(id=>{const record=records.get(id);record.status='completed';

return {status:'completed',response:record.response};}));},
 async stop(id){records.get(id).status='stopped';

return ok({});}
};

const config={stateDir:join(root,'../state'),allowedRoots:[root],worktreeRoot:join(root,'../worktrees')};
const store=new WorkflowStore(config.stateDir);
const manager=new WorkflowManager({store,agents,config,subagents,allowedRoots:[root],loadProfiles:async()=>[]});

try{
 const scope={workspaceRoot:root};
 const run=await manager.run({...scope,builtin:'testing-coordination',writeMode:'allowed',args:{task:'Test addition',allowedPaths:['tests'],artifacts:['tests/case.cjs'],acceptance:['Assert addition'],checks:[{id:'unit',executable:process.execPath,args:['tests/case.cjs']}]}});
 const final=await manager.wait(run.id,scope,30000);
 assert.equal(final.result?.status,'completed',JSON.stringify(final));
 assert.equal(manager.calls(run.id,scope).length,3);
 console.log('Installed DSH adapter and builtin offline plan -> implement -> verify -> review passed');
}finally{await manager.close();}
