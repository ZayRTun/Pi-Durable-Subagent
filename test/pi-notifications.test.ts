import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import extension from '../index.ts';

for (const retrieval of ['deferred', 'status', 'wait', 'early-status', 'child-status', 'child-wait', 'failed-deferred', 'failed-status', 'failed-wait'] as const) {
const reportedBeforeDelivery = retrieval.endsWith('status') && retrieval !== 'early-status' || retrieval.endsWith('wait');
const failed = retrieval.startsWith('failed-');
const childHandle = retrieval.startsWith('child-');
const earlyStatus = retrieval === 'early-status';
test(`busy parent completion with ${retrieval} retrieval retains full answers and usage across reload`, {timeout:15000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-delivery-'));const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 let childRelease!:()=>void,parentRelease!:()=>void;const childGate=new Promise<void>(r=>childRelease=r),parentGate=new Promise<void>(r=>parentRelease=r);
 let childDone!:()=>void,parentBusy!:()=>void;const childReady=new Promise<void>(r=>childDone=r),busy=new Promise<void>(r=>parentBusy=r);let handle='',sibling='';let step=0;
 const answer=failed?'Delegation unanswered: model_error\nProvider error: 400 Concrete permanent failure':'Final useful answer. '+ 'retained detail '.repeat(700);
 const answerField=failed?'error':'output';
 try{
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: worker\ntools: []\n---\nWork.');
  const faux=fauxProvider();faux.setResponses(Array.from({length:40},()=>async context=>{
   const parent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
   if(!parent){await childGate;childDone();return failed?fauxAssistantMessage([],{stopReason:'error',errorMessage:'400 Concrete permanent failure'}):fauxAssistantMessage(answer);}
   step++;
   if(step===1)return fauxAssistantMessage([fauxToolCall('subagent',childHandle?{agent:'worker',tasks:[{task:'Return the retained answer.'},{task:'Return another retained answer.'}],nonblocking:true}:{agent:'worker',task:'Return the retained answer.',nonblocking:true},{id:'start-delivery'})],{stopReason:'toolUse'});
   if(step===2){const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');if(childHandle){const entries=(result.details as {presentation:{entries:{runId:string}[]}}).presentation.entries;handle=entries[0]!.runId;sibling=entries[1]!.runId;}else handle=(result.details as {id:string}).id;return fauxAssistantMessage('Parent start settled.');}
   if(earlyStatus&&step===3)return fauxAssistantMessage([fauxToolCall('subagent_status',{run:handle},{id:'inspect-running'})],{stopReason:'toolUse'});
   if(step===(earlyStatus?4:3)){parentBusy();await parentGate;return reportedBeforeDelivery ? fauxAssistantMessage([handle,...(childHandle?[sibling]:[])].map((run,index)=>fauxToolCall(retrieval.endsWith('wait')?'subagent_wait':'subagent_status',{run},{id:`report-before-delivery-${index}`})),{stopReason:'toolUse'}) : fauxAssistantMessage('Parent busy turn settled.');}
   if(reportedBeforeDelivery&&step===4)return fauxAssistantMessage('Reported before delivery.');
   if(step===(reportedBeforeDelivery||earlyStatus?5:4)||step===(reportedBeforeDelivery||earlyStatus?7:6)||step===(reportedBeforeDelivery||earlyStatus?9:8))return fauxAssistantMessage([fauxToolCall('subagent_status',{run:handle},{id:`inspect-${step}`})],{stopReason:'toolUse'});
   return fauxAssistantMessage('Inspected full retained answer.');
  }));
  const modelRuntime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager=SettingsManager.inMemory({defaultTools:['subagent','subagent_status','subagent_wait']});const manager=SessionManager.inMemory(directory);
  const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();
  ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime,model:faux.getModel(),settingsManager,resourceLoader:loader,sessionManager:manager,thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});
  await session.prompt('Start background.');const pending=session.prompt('Keep parent busy.');await busy;childRelease();await childReady;
  // Wait through the public session inspection seam for child completion, while the parent remains busy.
  await new Promise(r=>setTimeout(r,200));
  const notifications=()=>session!.messages.filter(m=>m.role==='custom'&&m.customType==='durable-subagent-notification');
  assert.equal(notifications().length,0);
  if(earlyStatus){const running=session.messages.findLast((m):m is ToolResultMessage=>m.role==='toolResult');assert.equal((running!.details as {status:string}).status,'running');assert.doesNotMatch(JSON.stringify(running!.content),/Final useful answer/);}
  parentRelease();await pending;
  const expectedNotices=reportedBeforeDelivery?0:1;
  assert.equal(notifications().length,expectedNotices);
  const prior=session.messages.findLast((m):m is ToolResultMessage=>m.role==='toolResult');
  if(childHandle){const child=session.messages.find((m):m is ToolResultMessage=>m.role==='toolResult'&&m.toolCallId==='report-before-delivery-0');assert.equal((child!.details as {id:string}).id,handle);assert.equal((child!.details as {output:string}).output,answer);assert.deepEqual(child!.usage,(child!.details as {usage:unknown}).usage);}
  if(reportedBeforeDelivery){assert.equal((prior!.details as {output?:string;error?:string})[answerField],answer);assert.ok(prior!.content.some(part=>part.type==='text'&&part.text.includes(answer)));assert.deepEqual(prior!.usage,(prior!.details as {usage:unknown}).usage);}
  const delivered=notifications()[0];
  if(delivered){assert.ok(delivered.role==='custom');assert.ok(JSON.stringify(delivered.content).length<4500);assert.match(JSON.stringify(delivered.content),/subagent_status/);
   assert.equal((delivered.details as {executionId:string}).executionId,`${handle}:0`);
   assert.ok((delivered.details as {usageDelta:{totalTokens:number}}).usageDelta.totalTokens > 0);}
  for(let i=0;i<2;i++){await session.prompt('Retrieve again.');const result: ToolResultMessage | undefined=session.messages.findLast((m): m is ToolResultMessage=>m.role==='toolResult');assert.ok(result?.role==='toolResult');assert.equal((result.details as {output?:string;error?:string})[answerField],answer);assert.ok(result.content.some(part=>part.type==='text'&&part.text.includes(answer)));if(i===0&&!reportedBeforeDelivery)assert.deepEqual(result.usage,(delivered!.details as {usage:unknown}).usage);else assert.equal(result.usage,undefined);}
  const deliveryPath=join(directory,'runs',handle,'deliveries.json');
  const ledger=JSON.parse(await readFile(deliveryPath,'utf8')) as {deliveredAt?:number}[];
  for(const item of ledger)delete item.deliveredAt;
  await writeFile(deliveryPath,JSON.stringify(ledger));
  await session.reload();await session.prompt('Inspect after reload.');assert.equal(notifications().length,expectedNotices);
  const reloaded=session.messages.findLast((m):m is ToolResultMessage=>m.role==='toolResult');assert.equal((reloaded!.details as {output?:string;error?:string})[answerField],answer);assert.ok(reloaded!.content.some(part=>part.type==='text'&&part.text.includes(answer)));assert.equal(reloaded!.usage,undefined);
 }finally{childRelease();parentRelease();if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const[key,value]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});}
});
}

// Exercise lifecycle facts through the installed session, including the clock system boundary.
for (const outcome of ['failed', 'paused', 'blocker-stall'] as const) {
 test(`parent receives deduplicated ${outcome} attention while ordinary progress stays silent`, {timeout:15000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pi-attention-'));
  const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};
  process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
  let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
  const timer=globalThis.setTimeout, now=Date.now;let offset=0;
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  let parentRelease!:()=>void;const parentGate=new Promise<void>(resolve=>parentRelease=resolve);
  let busy!:()=>void;const busyGate=new Promise<void>(resolve=>busy=resolve);
  let waiting!:()=>void;const waitingGate=new Promise<void>(resolve=>waiting=resolve);
  let handle='',parentStep=0,childStep=0,recovering=false,recoveryIssued=false;
  try{
   await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: worker\ntools: attention_work\n---\nWork.');
   const faux=fauxProvider();faux.setResponses(Array.from({length:60},()=>async context=>{
    const parent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
    if(parent){
     if(recovering){if(!recoveryIssued){recoveryIssued=true;return fauxAssistantMessage([fauxToolCall('subagent',{resume:handle},{id:'approved-recovery'})],{stopReason:'toolUse'});}return fauxAssistantMessage('Recovered execution admitted.');}
     parentStep++;
     if(parentStep===1)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'Meaningful attention.',nonblocking:true,...(outcome==='paused'?{timeoutMinutes:1}:{})},{id:'start'})],{stopReason:'toolUse'});
     if(parentStep===2){const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');handle=(result.details as {id:string}).id;return fauxAssistantMessage('Parent settled.');}
     if(parentStep===3){busy();await parentGate;return fauxAssistantMessage('Parent usable.');}
     if(parentStep%2===0)return fauxAssistantMessage([fauxToolCall('subagent_status',{run:handle},{id:`inspect-${parentStep}`})],{stopReason:'toolUse'});
     return fauxAssistantMessage('Inspected.');
    }
    childStep++;
    if(outcome==='failed'){await gate;return recovering ? fauxAssistantMessage('Recovered useful answer without replay.') : fauxAssistantMessage([],{stopReason:'error',errorMessage:'400 Concrete permanent failure'});}
    if(childStep===1)return fauxAssistantMessage([fauxToolCall('attention_work',{},{id:'concrete-tool'})],{stopReason:'toolUse'});
    if(outcome==='paused')return fauxAssistantMessage('Checkpoint: first work unfinished. Next: reassess remaining work.');
    waiting();await gate;return fauxAssistantMessage('Recovered from the concrete tool error.');
   }));
   const modelRuntime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});modelRuntime.registerNativeProvider(faux.provider);
   const settingsManager=SettingsManager.inMemory({defaultTools:['subagent','subagent_status']});
   const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension,pi=>pi.registerTool({name:'attention_work',label:'Attention work',description:'Controlled host boundary',exposure:'codemode',parameters:{type:'object',properties:{}},async execute(_id,_args,signal){
    if(outcome==='blocker-stall')return {content:[{type:'text',text:'Permission denied: concrete blocker'}],details:undefined,isError:true};
    waiting();await new Promise<void>((resolve,reject)=>{const abort=()=>reject(new Error('Stopped at allowance'));signal?.addEventListener('abort',abort,{once:true});gate.then(()=>{signal?.removeEventListener('abort',abort);resolve();});});
    return {content:[{type:'text',text:'Work done'}],details:undefined};
   }})]});await loader.reload();
   ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime,model:faux.getModel(),settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(directory),thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});
   if(outcome==='paused')globalThis.setTimeout=((callback:(...args:unknown[])=>void,delay?:number,...args:unknown[])=>timer(callback,delay===60000?100:delay===48000?50:delay,...args)) as typeof setTimeout;
   await session.prompt('Start.');const pending=session.prompt('Busy.');await busyGate;
   const notifications=()=>session!.messages.filter(m=>m.role==='custom'&&m.customType==='durable-subagent-notification');
   if(outcome==='failed')release();else await waitingGate;
   if(outcome==='blocker-stall'){
    // Leave model waiting; two runtime snapshots with no changed activity cross the stall threshold.
    await new Promise(r=>timer(r,1100));Date.now=()=>now()+offset;offset=125000;
    await new Promise(r=>timer(r,1100));
   }else {if(outcome==='paused'){await new Promise(r=>timer(r,150));release();}await new Promise(r=>timer(r,200));}
   assert.equal(notifications().length,0);parentRelease();await pending;
   const kinds=()=>notifications().map(m=>{assert.ok(m.role==='custom');return (m.details as {kind:string}).kind;});
   if(outcome==='blocker-stall')assert.deepEqual(kinds(),['blocker','stall']);else assert.deepEqual(kinds(),[outcome]);
   for(let i=0;i<2;i++)await session.prompt('Inspect again.');
   assert.equal(notifications().length,outcome==='blocker-stall'?2:1);
   if(outcome==='paused'){const result: ToolResultMessage | undefined=session.messages.findLast((m): m is ToolResultMessage=>m.role==='toolResult');assert.ok(result?.role==='toolResult');assert.equal((result.details as {status:string}).status,'paused');assert.match((result.details as {handoff:string}).handoff,/Checkpoint/);}
   if(outcome==='blocker-stall'){release();await new Promise(r=>timer(r,200));assert.deepEqual(kinds(),['blocker','stall','succeeded']);}
   await session.reload();await session.prompt('Inspect after reload.');assert.equal(notifications().length,outcome==='blocker-stall'?3:1);
   if(outcome==='failed'){
    loader.getExtensions().runtime.flagValues.set('subagent-resume',handle);recovering=true;
    await session.prompt('Operator approves recovery.');await new Promise(r=>timer(r,200));
    assert.deepEqual(kinds(),['failed','succeeded']);
    const recovered=notifications().at(-1)!;assert.ok(recovered.role==='custom');
    assert.equal((recovered.details as {executionId:string}).executionId,`${handle}:1`);
    assert.ok((recovered.details as {usageDelta:{totalTokens:number};usage:{totalTokens:number}}).usageDelta.totalTokens < (recovered.details as {usage:{totalTokens:number}}).usage.totalTokens);
    recovering=false;for(let i=0;i<2;i++)await session.prompt('Inspect recovery.');
    assert.equal(notifications().length,2);
   }
  }finally{
   Date.now=now;globalThis.setTimeout=timer;release();parentRelease();if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
   for(const[key,value]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});
  }
 });
}
