import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import extension from '../index.ts';
import type { Usage } from '@earendil-works/pi-ai';
import type { Run } from '../runtime.ts';

async function host(body:(call:(tool:string,args:Record<string,unknown>,id?:string)=>Promise<any>, childUsage:Usage[], notifications:()=>any[], childSessionIds:(string|undefined)[])=>Promise<void>, window=200000) {
 const directory=await mkdtemp(join(tmpdir(),'pi-followup-'));const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 try {
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Retained fact fixture\ntools: read\n---\nWork.');
  const faux=fauxProvider({models:[{id:'faux-1',contextWindow:window}],tokenSize:{min:1000000,max:1000000}});
  const childUsage:Usage[]=[];const childSessionIds:(string|undefined)[]=[];const streamSimple=faux.provider.streamSimple;
  faux.provider.streamSimple=(model,context,options)=>{const stream=streamSimple(model,context,options);if(!context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'))){childSessionIds.push(options?.sessionId);void stream.result().then(message=>childUsage.push(message.usage));}return stream;};
  const models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});models.registerNativeProvider(faux.provider);
  const settings=SettingsManager.inMemory({defaultTools:['subagent','subagent_followup','subagent_status','subagent_wait','subagent_compact']});const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:models,model:models.getModel('faux','faux-1')!,settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.inMemory(directory),thinkingLevel:'off'}));
  await session.bindExtensions({mode:'print'});
  let turn=0;
  await body(async(tool,args,id=`parent-${++turn}`)=>{
   let parent=0;
   faux.setResponses(Array.from({length:8},()=>context=>{
    const isParent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
    if(isParent) return ++parent===1?fauxAssistantMessage([fauxToolCall(tool,args as Parameters<typeof fauxToolCall>[1],{id})],{stopReason:'toolUse'}):fauxAssistantMessage('Parent received result.');
    const retained=context.messages.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('The secret is orchid'));
    const answer=retained?'The secret is orchid.':'No retained secret.';
    const last=context.messages.findLast(m=>m.role==='user');
    return fauxAssistantMessage(answer+(last?.role==='user'&&typeof last.content==='string'&&last.content.includes('Long answer fixture.')?'B'.repeat(85000):''));
   }));
   await session!.prompt('Perform the operation.');
   const result=session!.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');return result;
  },childUsage,()=>session!.messages.filter(m=>m.role==='custom'&&m.customType==='durable-subagent-notification').map(m=>m.role==='custom'?m.details:undefined),childSessionIds);
 } finally {if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const [key,val]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(val===undefined)delete process.env[key];else process.env[key]=val;}await rm(directory,{recursive:true,force:true});}
}

test('host follow-up uses retained facts under a new execution and retrieves both answers without rebilling',async()=>{
 await host(async (call,childUsage,_notifications,childSessionIds)=>{
  const first=await call('subagent',{agent:'worker',task:'The secret is orchid. Remember it.'});assert.equal(first.isError,false);const old=first.details as Run;
  const second=await call('subagent_followup',{run:old.id,task:'What is the secret?'});assert.equal(second.isError,false,JSON.stringify(second.content));const next=second.details as Run;
  assert.deepEqual(childSessionIds,[old.id,old.id]);assert.notEqual(next.id,old.id);assert.equal(next.conversationId,old.id);assert.equal(next.output,'The secret is orchid.');assert.deepEqual(next.usage,childUsage[1]);assert.deepEqual(second.usage,childUsage[1]);
  assert.deepEqual(next.agent,old.agent);assert.deepEqual(next.model,old.model);assert.equal(next.cwd,old.cwd);
  for(const id of [old.id,next.id,old.id,next.id]) { const result=await call('subagent_status',{run:id});assert.equal((result.details as Run).output,'The secret is orchid.');assert.equal(result.usage,undefined); }
  const previous=await call('subagent_status',{run:old.id});assert.equal((previous.details as Run).task,'The secret is orchid. Remember it.');assert.deepEqual((previous.details as Run).usage,old.usage);
 });
});

test('host requires explicit reuse after warning and keeps a fresh-conversation alternative',async()=>{
 await host(async call=>{
  const first=await call('subagent',{agent:'worker',task:'The secret is orchid. '+ 'A'.repeat(32000)});const old=first.details as Run;
  const refused=await call('subagent_followup',{run:old.id,task:'What is the secret?'});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused.content),/explicitly choose reuse:true/);
  const reused=await call('subagent_followup',{run:old.id,task:'What is the secret?',reuse:true});assert.equal(reused.isError,false);assert.equal(reused.details.output,'The secret is orchid.');
  const fresh=await call('subagent_followup',{run:reused.details.id,task:'What is the secret?',fresh:true});assert.equal(fresh.isError,false);assert.equal(fresh.details.conversationId,fresh.details.id);assert.equal(fresh.details.output,'No retained secret.');
 },10000);
});

test('host follow-up preserves unknown context capacity and refuses replacement of authority',async()=>{
 await host(async call=>{
  const old=(await call('subagent',{agent:'worker',task:'The secret is orchid.'})).details as Run;
  for(const extra of [{agent:'other'},{model:'faux/other'},{tools:['bash']},{cwd:'/tmp'},{worktree:true}]) {
   const result=await call('subagent_followup',{run:old.id,task:'What is the secret?',...extra});assert.equal(result.isError,true);assert.match(JSON.stringify(result.content),/authority|additional|unexpected|not allowed/i);
  }
  const next=await call('subagent_followup',{run:old.id,task:'What is the secret?'});assert.equal(next.isError,false);assert.equal(next.details.contextHealth.modelCapacity,null);assert.equal(next.details.output,'The secret is orchid.');
 },0);
});

test('host nonblocking retained follow-up waits deliver and account once per execution',async()=>{
 await host(async(call,childUsage,notifications)=>{
  const old=(await call('subagent',{agent:'worker',task:'The secret is orchid.',nonblocking:true})).details as Run;
  const initial=await call('subagent_wait',{run:old.id,waitSeconds:5});assert.equal(initial.details.status,'succeeded');assert.equal(initial.details.output,'The secret is orchid.');assert.match(JSON.stringify(initial.content),/The secret is orchid\./);assert.deepEqual(initial.usage,childUsage[0]);
  const next=(await call('subagent_followup',{run:old.id,task:'What is the secret?',nonblocking:true})).details as Run;
  assert.equal(next.conversationId,old.id);
  const final=await call('subagent_wait',{run:next.id,waitSeconds:5});assert.equal(final.details.status,'succeeded');assert.equal(final.details.output,'The secret is orchid.');assert.deepEqual(final.usage,childUsage[1]);
  for(const id of [old.id,next.id,old.id,next.id])assert.equal((await call('subagent_status',{run:id})).usage,undefined);
  const notices=notifications();assert.deepEqual(notices,[],'Full final wait answers already delivered both executions');
 });
});

test('host follow-up excludes earlier separately billed compaction and later execution history',async()=>{
 await host(async(call,childUsage)=>{
  const old=(await call('subagent',{agent:'worker',task:'The secret is orchid. Long answer fixture. '+ 'A'.repeat(110000)})).details as Run;
  const compact=await call('subagent_compact',{run:old.id});assert.equal(compact.isError,false);assert.equal(compact.details.compactions.at(-1).outcome,'applied');
  const first=await call('subagent_followup',{run:old.id,task:'What is the secret?',reuse:true});assert.equal(first.isError,false);assert.deepEqual(first.usage,childUsage[2]);
  const second=await call('subagent_followup',{run:old.id,task:'What is the secret again?',reuse:true});assert.equal(second.isError,false);assert.deepEqual(second.usage,childUsage[3]);
  const replay=await call('subagent_status',{run:first.details.id});assert.equal(replay.usage,undefined);assert.deepEqual(replay.details.usage,childUsage[2]);
 });
});

test('completed group child follow-up leaves historical group membership and answers unchanged',async()=>{
 await host(async call=>{
  const started=await call('subagent',{agent:'worker',tasks:[{task:'The secret is orchid.'},{task:'Independent task.'}]});assert.equal(started.isError,false);const group=started.details;assert.match(group.id,/^[a-f0-9]{32}$/);assert.equal(group.steps.length,2);
  const original=group.steps[0] as Run & {groupId:string};assert.equal(original.groupId,group.id);
  const next=await call('subagent_followup',{run:original.id,task:'What is the secret?'});assert.equal(next.isError,false);assert.equal(next.details.groupId,undefined);assert.equal(next.details.conversationId,original.id);assert.equal(next.details.output,'The secret is orchid.');
  const retained=await call('subagent_status',{run:group.id});assert.equal(retained.isError,false);assert.deepEqual(retained.details.steps.map((step:Run)=>({id:step.id,task:step.task,output:step.output})),group.steps.map((step:Run)=>({id:step.id,task:step.task,output:step.output})));
  const retrieved=await call('subagent',{resume:next.details.id});assert.equal(retrieved.isError,false);assert.equal(retrieved.details.id,next.details.id);assert.equal(retrieved.details.steps,undefined);assert.equal(retrieved.usage,undefined);
 });
});
