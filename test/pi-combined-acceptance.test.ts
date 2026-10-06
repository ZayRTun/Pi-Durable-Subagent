import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type, type Context, type ToolResultMessage, type Usage } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import extension from '../index.ts';
import type { Run } from '../runtime.ts';

// This gate deliberately keeps the same owning host, conversation, workspace,
// group and billing history across controls that individual feature tests isolate.
test('combined host gate: detached Chain, parent reasoning, steering, allowance retry, reopen, continuation, compaction and retained follow-up', {timeout:15000}, async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-combined-'));
 const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
 const timer=globalThis.setTimeout;
 globalThis.setTimeout=((fn:(...args:unknown[])=>void,delay?:number,...args:unknown[])=>timer(fn,delay===60000?250:delay===48000?200:delay,...args)) as typeof setTimeout;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 let ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve);
 let tool='',args:Record<string,unknown>={},callId='',answered=false,handoffs=0,effects=0,finished=false;
 const providerUsage:Usage[]=[];const reported:Usage[]=[];const childInputs:string[]=[];
 try {
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Frozen combined worker\ntools: effect\n---\nOriginal fixed scope.');
  const faux=fauxProvider({models:[{id:'faux-1',contextWindow:40000}],tokenSize:{min:1000000,max:1000000}});
  const isParent=(context:Context)=>context.tools?.some(t=>t.name==='subagent')||context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
  const stream=faux.provider.streamSimple;
  faux.provider.streamSimple=(model,context,options)=>{const result=stream(model,context,options);if(/^[a-f0-9]{32}$/.test(options?.sessionId??''))void result.result().then(message=>providerUsage.push(message.usage));return result;};
  faux.setResponses(Array.from({length:150},()=>context=>{
   if(isParent(context)) {
    if(answered)return fauxAssistantMessage('Parent independently reasons: the child has not completed; inspect after doing other work.');
    answered=true;return fauxAssistantMessage([fauxToolCall(tool,args as Parameters<typeof fauxToolCall>[1],{id:callId})],{stopReason:'toolUse'});
   }
   const text=JSON.stringify(context.messages);childInputs.push(text);
   const latest=JSON.stringify(context.messages.findLast(m=>m.role==='user'));
   if(latest.includes('tool-free handoff')) {
    assert.deepEqual((context as unknown as {tools?:unknown[]}).tools??[],[],'Handoff retries have no workspace adapters');
    return ++handoffs===1?fauxAssistantMessage([],{stopReason:'error',errorMessage:'503 Transient checkpoint failure'}):fauxAssistantMessage('HANDOFF: first effect completed; finish remaining analysis.');
   }
   if(latest.includes('Parent reassessment: Finish analysis')) {
    assert.match(text,/Original fixed scope/);assert.doesNotMatch(text,/Replacement role/);
    return fauxAssistantMessage('FINAL: orchid; revised guidance applied. '+ 'B'.repeat(85000));
   }
   if(latest.includes('Follow-up retained fact'))return fauxAssistantMessage(text.includes('orchid')?'Retained orchid.':'Missing retained fact.');
   if(text.includes('Dependent analysis')) {assert.match(text,/FINAL: orchid/);assert.doesNotMatch(latest,/HANDOFF:/);return fauxAssistantMessage('Dependent final answer.');}
   // The real SDK compactor calls the same provider with its own summary request.
   if(tool==='subagent_compact')return fauxAssistantMessage('Summary: orchid; first effect completed; original fixed scope.');
   if(!context.messages.some(m=>m.role==='toolResult'))return fauxAssistantMessage([fauxToolCall('effect',{}, {id:'workspace-effect'})],{stopReason:'toolUse'});
   assert.match(text,/Use revised guidance/);return fauxAssistantMessage('Work boundary finished.');
  }));
  const models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});models.registerNativeProvider(faux.provider);
  const manager=SessionManager.inMemory(directory);const settings=SettingsManager.inMemory({defaultTools:['subagent','subagent_status','subagent_wait','subagent_steer','subagent_followup','subagent_compact']});
  async function open() {
   const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[extension,pi=>pi.registerTool({name:'effect',label:'Workspace effect',exposure:'codemode',description:'One observable append before a controlled safe boundary',parameters:Type.Object({}),async execute(){effects++;await appendFile(join(directory,'effects.txt'),'completed effect\n');ready();await held;finished=true;return {content:[{type:'text',text:'orchid effect finished'}],details:undefined};}})]});
   await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
   ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:models,model:faux.getModel(),settingsManager:settings,resourceLoader:loader,sessionManager:manager,thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});
  }
  await open();let sequence=0;
  async function call(name:string,input:Record<string,unknown>) {
   tool=name;args=input;callId=`combined-${++sequence}`;answered=false;await session!.prompt(`Perform ${name}.`);
   const result=session!.messages.findLast((m):m is ToolResultMessage=>m.role==='toolResult');assert.ok(result);if(result.usage)reported.push(result.usage);return result;
  }
  const start=await call('subagent',{agent:'worker',chain:[{task:'Remember orchid. '+ 'A'.repeat(110000)},{task:'Dependent analysis'}],nonblocking:true,timeoutMinutes:1});assert.equal(start.isError,false);
  const group=start.details as unknown as {id:string;steps:Run[];presentation:{entries:{runId:string;phase:string}[]}};const id=group.presentation.entries[0].runId;
  await started;assert.equal(finished,false);assert.match(session!.getLastAssistantText()!,/Parent independently reasons/,'Actual parent generation settles while the child adapter is held');
  const waiting=await call('subagent_wait',{run:id,waitSeconds:0});assert.equal((waiting.details as unknown as Run).status,'running','A started group child must never be reported as Pending');assert.equal(finished,false,'Bounded wait does not stop or finish child work');
  const refused=await call('subagent',{agent:'worker',task:'Competing workspace work',nonblocking:true});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused.content),/working directory|capacity/);
  const guidance=await call('subagent_steer',{run:id,guidance:'Use revised guidance within original scope.'});assert.equal(guidance.isError,false);assert.equal((guidance.details as unknown as Run).steering?.consumed,0);
  // Let the allowance elapse while an admitted tool owns the workspace.
  await new Promise(resolve=>timer(resolve,280));assert.equal(finished,false);release();
  const pause=await call('subagent_wait',{run:group.id,waitSeconds:5});assert.equal(pause.isError,false);
  const paused=(pause.details as unknown as {steps:Run[];presentation:{entries:{phase:string}[]}}).steps[0];assert.equal(paused.status,'paused');assert.equal(paused.handoffRetries,1);assert.equal(handoffs,2);assert.equal(paused.steering?.consumed,1);
  assert.deepEqual((pause.details as unknown as typeof group).presentation.entries.map(e=>e.phase),['run','pending']);assert.equal(effects,1);
  await session!.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session!.dispose();session=undefined;
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Replacement role\ntools: effect\n---\nReplacement role.');
  await open();const retained=await call('subagent_status',{run:group.id});assert.deepEqual((retained.details as unknown as typeof group).presentation.entries.map(e=>e.phase),['run','pending']);assert.equal(retained.usage,undefined);assert.equal(effects,1,'Reopening cannot advance a stopped graph');
  const continued=await call('subagent',{resume:id,reassessment:'Finish analysis',timeoutMinutes:null});assert.equal(continued.isError,false,JSON.stringify(continued.content));const final=(await call('subagent_wait',{run:group.id,waitSeconds:5})).details as unknown as typeof group;
  assert.deepEqual(final.steps.map(r=>r.status),['succeeded','succeeded']);assert.equal(effects,1);assert.ok(childInputs.some(text=>text.includes('Answer from the previous step in this chain:')));
  const historical=await call('subagent_status',{run:id});assert.equal(historical.usage,undefined);assert.match((historical.details as unknown as Run).output!,/^FINAL: orchid/);assert.equal((historical.details as unknown as Run).contextHealth?.warning,true);
  const compact=await call('subagent_compact',{run:id});assert.equal(compact.isError,false,JSON.stringify(compact.content));assert.equal((compact.details as unknown as Run).compactions?.at(-1)?.outcome,'applied');
  const previousUsageCount=providerUsage.length;
  const follow=await call('subagent_followup',{run:id,task:'Follow-up retained fact: what was remembered?',reuse:true,nonblocking:true});assert.equal(follow.isError,false,JSON.stringify(follow.content));const next=follow.details as unknown as Run;assert.notEqual(next.id,id);assert.equal(next.conversationId,id);assert.equal(next.groupId,undefined);
  const completed=await call('subagent_wait',{run:next.id,waitSeconds:5});assert.equal(completed.isError,false);assert.equal((completed.details as unknown as Run).output,'Retained orchid.');assert.deepEqual((completed.details as unknown as Run).usage,providerUsage[previousUsageCount],JSON.stringify({before:previousUsageCount,usage:providerUsage.map(u=>u.totalTokens)}));
  for(const handle of [group.id,id,next.id,group.id,id,next.id])assert.equal((await call('subagent_status',{run:handle})).usage,undefined,'Historical retrieval has no new billing');
  assert.equal(await readFile(join(directory,'effects.txt'),'utf8'),'completed effect\n');assert.equal(effects,1,'Retrieval, continuation, compaction and follow-up never repeat the old workspace effect');
  const notices=session!.messages.filter(m=>m.role==='custom'&&m.customType==='durable-subagent-notification').map(m=>m.role==='custom'?m.details as {executionId:string;kind:string}:undefined).filter(Boolean);
  const finals=notices.filter(n=>n!.kind==='succeeded');assert.deepEqual(finals.map(n=>n!.executionId).sort(),final.steps.map(run=>`${run.id}:${run.executionAttempt??0}`).sort(),'Group state summaries retain both child notices; the full follow-up wait answer needs no duplicate notice');
  assert.equal(reported.reduce((sum,u)=>sum+u.totalTokens,0),providerUsage.reduce((sum,u)=>sum+u.totalTokens,0),'All generation and explicit compaction usage is reported once across the combined history');
 } finally {
  release();globalThis.setTimeout=timer;if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
  for(const[key,value]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(directory,{recursive:true,force:true});
 }
});

test('combined host gate: interrupted detached effect, reopen approval, fresh permission adapters, retained follow-up and terminal cancellation', {timeout:15000}, async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-combined-recovery-'));
 const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 let tool='',args:Record<string,unknown>={},answered=false,sequence=0,epoch=0,effects=0,holds=0,denials=0,recoveryActive=false,followupToolCall=false;
 let waiting!:()=>void;let ready=new Promise<void>(resolve=>waiting=resolve);
 const reported:Usage[]=[];
 try {
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Original recovery worker\ntools: effect, hold\n---\nOriginal recovery scope.');
  const faux=fauxProvider();faux.setResponses(Array.from({length:120},()=>context=>{
   const parent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
   if(parent){if(answered)return fauxAssistantMessage('Parent remains available.');answered=true;return fauxAssistantMessage([fauxToolCall(tool,args as Parameters<typeof fauxToolCall>[1],{id:`recovery-${sequence}`})],{stopReason:'toolUse'});}
   const text=JSON.stringify(context.messages);const latest=JSON.stringify(context.messages.findLast(m=>m.role==='user'));
   const result=context.messages.findLast(m=>m.role==='toolResult');
   if(latest.includes('Follow-up permission check')&&!followupToolCall){followupToolCall=true;return fauxAssistantMessage([fauxToolCall('effect',{}, {id:'follow-up-permission-attempt'})],{stopReason:'toolUse'});}
   if(recoveryActive||latest.includes('Follow-up permission check')) {
    assert.match(text,/Original recovery scope/);assert.doesNotMatch(text,/Replacement recovery scope/);
    if(result?.role==='toolResult'&&result.toolCallId.endsWith('permission-attempt')) {assert.equal(result.isError,true);assert.match(JSON.stringify(result.content),/Current host permission denied/);return fauxAssistantMessage('Current permission respected; historical effect retained.');}
    return fauxAssistantMessage([fauxToolCall('effect',{}, {id:'new-permission-attempt'})],{stopReason:'toolUse'});
   }
   if(latest.includes('Cancel held child'))return fauxAssistantMessage([fauxToolCall('hold',{}, {id:'cancel-held'})],{stopReason:'toolUse'});
   if(!context.messages.some(m=>m.role==='toolResult'))return fauxAssistantMessage([fauxToolCall('effect',{}, {id:'completed-effect'})],{stopReason:'toolUse'});
   return fauxAssistantMessage([fauxToolCall('hold',{}, {id:'interrupted-held'})],{stopReason:'toolUse'});
  }));
  const models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});models.registerNativeProvider(faux.provider);
  const settings=SettingsManager.inMemory({defaultTools:['subagent','subagent_status','subagent_wait','subagent_cancel','subagent_followup']});const manager=SessionManager.inMemory(directory);
  async function open(){
   const ownEpoch=++epoch;
   const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[extension,pi=>{
    pi.on('tool_call',event=>{if(event.toolName==='effect'&&ownEpoch>1){denials++;return {block:true,reason:'Current host permission denied'};}});
    pi.registerTool({name:'effect',label:'Effect',exposure:'codemode',description:'Observable disposable workspace append',parameters:Type.Object({}),async execute(){assert.equal(ownEpoch,epoch,'Disposed adapter must not execute');effects++;await appendFile(join(directory,'effects.txt'),'completed before stop\n');return {content:[{type:'text',text:'effect committed'}],details:undefined};}});
    pi.registerTool({name:'hold',label:'Hold',exposure:'codemode',description:'Abortable host boundary',parameters:Type.Object({}),async execute(_id,_args,signal){assert.equal(ownEpoch,epoch);holds++;waiting();await new Promise<void>((_resolve,reject)=>{const stop=()=>reject(new Error('Owner stopped adapter'));signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});return {content:[],details:undefined};}});
   }]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
   ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:models,model:faux.getModel(),settingsManager:settings,resourceLoader:loader,sessionManager:manager,thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});return loader;
  }
  async function call(name:string,input:Record<string,unknown>){tool=name;args=input;answered=false;sequence++;await session!.prompt(`Perform ${name}.`);const result=session!.messages.findLast((m):m is ToolResultMessage=>m.role==='toolResult');assert.ok(result);if(result.usage)reported.push(result.usage);return result;}
  await open();const start=await call('subagent',{agent:'worker',task:'Complete a workspace effect then hold for inspection.',nonblocking:true});assert.equal(start.isError,false);const id=(start.details as unknown as Run).id;await ready;
  const live=await call('subagent_wait',{run:id,waitSeconds:0});assert.equal((live.details as unknown as Run).status,'running');assert.equal(effects,1);assert.equal(holds,1);
  await session!.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session!.dispose();session=undefined;
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Replacement recovery worker\ntools: effect, hold\n---\nReplacement recovery scope.');const loader=await open();
  const stopped=await call('subagent_status',{run:id});assert.equal((stopped.details as unknown as Run).status,'interrupted');assert.equal(effects,1);assert.equal(holds,1,'Reopen cannot restart interrupted work');
  const denied=await call('subagent',{resume:id});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied.content),/Explicit resume approval required/);assert.equal(denials,0,'Model recovery request cannot invoke adapters before operator approval');
  loader.getExtensions().runtime.flagValues.set('subagent-resume',id);
  recoveryActive=true;const approved=await call('subagent',{resume:id});assert.equal(approved.isError,false,JSON.stringify(approved.content));
  const recovered=await call('subagent_wait',{run:id,waitSeconds:5});assert.equal((recovered.details as unknown as Run).output,'Current permission respected; historical effect retained.');assert.match(JSON.stringify(recovered.content),/Current permission respected; historical effect retained\./);assert.equal((recovered.details as unknown as Run).status,'succeeded');assert.equal((recovered.details as unknown as Run).executionAttempt,1,JSON.stringify({run:recovered.details,denials,holds,effects}));assert.ok((recovered.details as unknown as Run).activityLog?.some(entry=>entry.name==='hold'&&entry.uncertain),JSON.stringify(recovered.details));assert.equal(effects,1);assert.equal(holds,1,'Approved recovery does not replay completed or uncertain tools');assert.equal(denials,1,'Recovery calls current host permission hooks');
  recoveryActive=false;const follow=await call('subagent_followup',{run:id,task:'Follow-up permission check',nonblocking:true});assert.equal(follow.isError,false);const next=(follow.details as unknown as Run).id;
  const followed=await call('subagent_wait',{run:next,waitSeconds:5});assert.equal((followed.details as unknown as Run).output,'Current permission respected; historical effect retained.');assert.match(JSON.stringify(followed.content),/Current permission respected; historical effect retained\./);assert.equal((followed.details as unknown as Run).status,'succeeded');assert.equal(denials,2,'Follow-up also reacquires current permission adapters');assert.equal(effects,1);
  for(const handle of [id,next,id,next])assert.equal((await call('subagent_status',{run:handle})).usage,undefined);
  const charged=reported.reduce((sum,u)=>sum+u.totalTokens,0);assert.equal(charged,(recovered.details as unknown as Run).usage!.totalTokens+(followed.details as unknown as Run).usage!.totalTokens,'Recovery usage includes only unreported new work and independent follow-up spend');
  ready=new Promise<void>(resolve=>waiting=resolve);
  const cancelStart=await call('subagent',{agent:'worker',task:'Cancel held child',nonblocking:true});assert.equal(cancelStart.isError,false);const cancelledId=(cancelStart.details as unknown as Run).id;await ready;
  const cancelled=await call('subagent_cancel',{run:cancelledId});assert.equal((cancelled.details as unknown as Run).status,'aborted');assert.equal(holds,2);
  await session!.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session!.dispose();session=undefined;await open();
  const retrieved=await call('subagent',{resume:cancelledId});assert.equal((retrieved.details as unknown as Run).status,'aborted');assert.equal(retrieved.usage,undefined);assert.equal(holds,2,'Cancelled work never restarts after session reopen or explicit retrieval');
  assert.equal(await readFile(join(directory,'effects.txt'),'utf8'),'completed before stop\n');
  const finals=session!.messages.filter(m=>m.role==='custom'&&m.customType==='durable-subagent-notification'&&(m.details as {kind:string}).kind==='succeeded').map(m=>m.role==='custom'?(m.details as {executionId:string}).executionId:'');assert.deepEqual(finals,[],'Both full final wait answers are retained, including the recovered execution attempt, so neither needs an automatic duplicate');
 }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const[key,value]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});}
});
