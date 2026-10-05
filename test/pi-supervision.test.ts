import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import extension from '../index.ts';

test('installed host lets parent reason across wait expiry while detached tools keep live permissions and durable identity', {timeout:10000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-supervision-')); const oldStorage=process.env.PI_SUBAGENT_STORAGE, oldAgents=process.env.PI_SUBAGENT_AGENTS;
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=fileURLToPath(new URL('./fixtures/agents/',import.meta.url));
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 let secondRelease!:()=>void;const gate2=new Promise<void>(resolve=>secondRelease=resolve);let firstTool!:()=>void;const firstDone=new Promise<void>(resolve=>firstTool=resolve);let denied=false; const nestedIds:string[]=[];let executed=0;let handle='';
 try{
  await writeFile(join(directory,'evidence.txt'),'useful real evidence');const faux=fauxProvider();
  let parentStep=0, childStep=0;
  faux.setResponses(Array.from({length:30},()=>async context=>{
   const parent=context.messages.some(message=>message.role==='system' && message.toolsAdded?.some(tool=>tool.name==='subagent'));
   if(parent){
    parentStep++;
    if(parentStep===1)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'scout',task:'Continue after start.',nonblocking:true},{id:'detached-start'})],{stopReason:'toolUse'});
    if(parentStep===2){const result=context.messages.findLast(message=>message.role==='toolResult');assert.ok(result?.role==='toolResult');handle=(result.details as {id:string}).id;return fauxAssistantMessage([fauxToolCall('subagent_wait',{run:handle,waitSeconds:0.01},{id:'parent-wait'})],{stopReason:'toolUse'});}
    if(parentStep===3)return fauxAssistantMessage('Parent can reason while the scout runs.');
    if(parentStep===4)return fauxAssistantMessage('Another independent parent turn.');
    if(parentStep===5)return fauxAssistantMessage('Parent still reasons between child calls.');
    if(parentStep===6)return fauxAssistantMessage([fauxToolCall('subagent_wait',{run:handle,waitSeconds:1},{id:'final-wait'})],{stopReason:'toolUse'});
    return fauxAssistantMessage('Inspected retained answer.');
   }
   childStep++;
   if(childStep===1){await gate;return fauxAssistantMessage([fauxToolCall('fffind',{path:'evidence.txt'},{id:'durable-child-1'})],{stopReason:'toolUse'});}
   if(childStep===2){await gate2;return fauxAssistantMessage([fauxToolCall('fffind',{path:'evidence.txt'},{id:'durable-child-2'})],{stopReason:'toolUse'});}
   assert.match(JSON.stringify(context.messages.at(-1)),/Permission revoked/);return fauxAssistantMessage('Useful evidence retained; second access denied.');
  }));
  const modelRuntime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager=SettingsManager.inMemory({defaultTools:['subagent','subagent_wait','write']});
  const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension,pi=>{
   pi.registerTool({name:'fffind',label:'Lookup',exposure:'codemode',description:'Real fixture lookup',parameters:Type.Object({path:Type.String()}),async execute(_id,args){executed++;const text=await readFile(join(directory,args.path),'utf8');firstTool();return {content:[{type:'text',text}],details:undefined};}});
   pi.on('tool_call',event=>{if(event.toolName==='fffind'){nestedIds.push(event.toolCallId);if(denied)return {block:true,reason:'Permission revoked by live host hook'};}});
  }]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime,model:modelRuntime.getModel('faux','faux-1')!,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(directory),thinkingLevel:'off'}));
  await session.prompt('Start background work.');assert.equal(session.getLastAssistantText(),'Parent can reason while the scout runs.');
  await session.prompt('Continue parent reasoning.');assert.equal(session.getLastAssistantText(),'Another independent parent turn.');release();await firstDone;await session.prompt('Reason between child calls.');assert.equal(session.getLastAssistantText(),'Parent still reasons between child calls.');denied=true;secondRelease();
  await session.prompt('Inspect the result.');const result=session.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='subagent_wait');assert.ok(result?.role==='toolResult');const run=result.details as {status:string;output:string;toolCount:number;activityLog:{callId:string}[]};assert.equal(run.status,'succeeded');assert.equal(run.toolCount,2);assert.deepEqual(run.activityLog.map(call=>call.callId),['durable-child-1','durable-child-2']);assert.equal(executed,1);assert.equal(nestedIds.length,2);
  // Installed SDK resets late nested numbering after parent settlement; Durable identity does not.
  assert.deepEqual(nestedIds,['detached-start/1','detached-start/1']);
 }finally{release();secondRelease();if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}if(oldStorage===undefined)delete process.env.PI_SUBAGENT_STORAGE;else process.env.PI_SUBAGENT_STORAGE=oldStorage;if(oldAgents===undefined)delete process.env.PI_SUBAGENT_AGENTS;else process.env.PI_SUBAGENT_AGENTS=oldAgents;await rm(directory,{recursive:true,force:true});}
});

test('host capacity refuses busy without queue, blocks parent writes, cancels and cleans owner replacement without restart', {timeout:10000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-supervision-owner-')); const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS,capacity:process.env.PI_SUBAGENT_MAX_ACTIVE};
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;process.env.PI_SUBAGENT_MAX_ACTIVE='1';
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined; let calls=0;let stopCount=0;const handles:string[]=[];let parentStep=0;let started!:()=>void;let ready=new Promise<void>(resolve=>started=resolve);
 try{
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Controlled worker\ntools: wait_work\n---\nWork.');const faux=fauxProvider();faux.setResponses(Array.from({length:40},()=>context=>{
   const parent=context.messages.some(message=>message.role==='system'&&message.toolsAdded?.some(tool=>tool.name==='subagent'));
   if(!parent)return fauxAssistantMessage([fauxToolCall('wait_work',{}, {id:`child-${calls}`})],{stopReason:'toolUse'});
   parentStep++;const result=context.messages.findLast(message=>message.role==='toolResult');
   if(parentStep===1||parentStep===8)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:`Task ${parentStep}`,nonblocking:true},{id:`start-${parentStep}`})],{stopReason:'toolUse'});
   if(parentStep===2){assert.ok(result?.role==='toolResult');handles.push((result.details as {id:string}).id);return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'Busy should never start',nonblocking:true},{id:'busy'})],{stopReason:'toolUse'});}
   if(parentStep===3){assert.ok(result?.role==='toolResult'&&result.isError);assert.match(JSON.stringify(result.content),/capacity.*busy/i);return fauxAssistantMessage([fauxToolCall('write',{path:'parent.txt',content:'Unsafe concurrent parent change'},{id:'parent-write'})],{stopReason:'toolUse'});}
   if(parentStep===4){assert.ok(result?.role==='toolResult'&&result.isError);assert.match(JSON.stringify(result.content),/owns this workspace/);return fauxAssistantMessage([fauxToolCall('subagent_wait',{run:handles[0],waitSeconds:0.01},{id:'bounded-wait'})],{stopReason:'toolUse'});}
   if(parentStep===5){assert.match(JSON.stringify(result),/running/);return fauxAssistantMessage('Capacity and workspace protected.');}
   if(parentStep===6)return fauxAssistantMessage([fauxToolCall('subagent_cancel',{run:handles[0]},{id:'cancel'})],{stopReason:'toolUse'});
   if(parentStep===7){assert.ok(result?.role==='toolResult');assert.equal((result.details as {status:string}).status,'aborted');return fauxAssistantMessage('Cancelled and released.');}
   if(parentStep===9){assert.ok(result?.role==='toolResult');handles.push((result.details as {id:string}).id);return fauxAssistantMessage('New execution admitted.');}
   return fauxAssistantMessage([fauxToolCall('subagent_status',{run:handles[1]},{id:'inspect-reopened'})],{stopReason:'toolUse'});
  }));
  const modelRuntime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});modelRuntime.registerNativeProvider(faux.provider);const manager=SessionManager.inMemory(directory);const settingsManager=SettingsManager.inMemory({defaultTools:['subagent','subagent_wait','subagent_cancel','subagent_status','write']});
  async function open(){const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension,pi=>{
   pi.registerTool({name:'wait_work',label:'Wait',exposure:'codemode',description:'Interruptible owned work',parameters:Type.Object({}),async execute(_id,_args,signal){calls++;started();await new Promise<void>((resolve)=>{const stop=()=>{stopCount++;resolve();};signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});return {content:[],details:undefined};}});
  }]});await loader.reload();({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime,model:faux.getModel(),sessionManager:manager,settingsManager,resourceLoader:loader,thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});}
  await open();await session!.prompt('Start work and test controls.');await ready;assert.equal(calls,1);assert.equal(session!.getLastAssistantText(),'Capacity and workspace protected.');await assert.rejects(readFile(join(directory,'parent.txt')),{code:'ENOENT'});
  await session!.prompt('Cancel the first execution.');assert.equal(stopCount,1);ready=new Promise<void>(resolve=>started=resolve);await session!.prompt('Start another execution.');await ready;assert.equal(calls,2);
  // Actual SDK reload awaits shutdown before replacing/invalidation of the old extension runner.
  await session!.reload();assert.equal(stopCount,2);const record=JSON.parse(await readFile(join(directory,'runs',handles[1],'run.json'),'utf8'));assert.equal(record.status,'interrupted');assert.equal(calls,2);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('subagent_status',{run:handles[1]},{id:'inspect'})],{stopReason:'toolUse'}),fauxAssistantMessage('Interrupted execution requires explicit recovery.')]);await session!.prompt('Inspect after reload.');const inspected=session!.messages.findLast(message=>message.role==='toolResult');assert.ok(inspected?.role==='toolResult');assert.equal((inspected.details as {status:string}).status,'interrupted');assert.equal(calls,2);
 }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const [key,value]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents,PI_SUBAGENT_MAX_ACTIVE:old.capacity})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});}
});
