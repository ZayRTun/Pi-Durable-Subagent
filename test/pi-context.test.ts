import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import extension from '../index.ts';

async function host(window:number, tokens:number, action:'inspect'|'compact'|'compact-short'|'compact-busy'='inspect', summary='Compact summary') {
 const directory=await mkdtemp(join(tmpdir(),'pi-context-'));const old={storage:process.env.PI_SUBAGENT_STORAGE,agents:process.env.PI_SUBAGENT_AGENTS};
 process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');process.env.PI_SUBAGENT_AGENTS=directory;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 try {
  await writeFile(join(directory,'worker.md'),'---\nname: worker\ndescription: Context fixture\ntools: read\n---\nWork.');
  const answer=action==='compact'?'Historical answer'+ 'B'.repeat(85000):'Historical answer'+'B'.repeat(Math.max(0,tokens-49000)*4);
  const faux=fauxProvider({models:[{id:"faux-1",contextWindow:window}],tokenSize:{min:1000000,max:1000000}});let handle='';
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',nonblocking:action==='compact-busy',task:action==='compact'?'A'.repeat(110000):'A'.repeat(Math.min(tokens,49000)*4)},{id:'start'})],{stopReason:'toolUse'}),
   ...(action==='compact-busy'?[async()=>{await new Promise(resolve=>setTimeout(resolve,200));return fauxAssistantMessage(answer);}]:[{...fauxAssistantMessage(answer),usage:{...fauxAssistantMessage('').usage,input:tokens,output:0,totalTokens:tokens}}]),
   context=>{const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');handle=(result.details as {id:string}).id;return fauxAssistantMessage('Started.');},
   fauxAssistantMessage([fauxToolCall(action.startsWith('compact')?'subagent_compact':'subagent_status',{run:'PLACEHOLDER'},{id:'inspect'})],{stopReason:'toolUse'}),
   ...(action==='compact'?[fauxAssistantMessage(summary)]:[]),
   fauxAssistantMessage('Inspected.')
  ]);
  if(action==='compact-busy') { let parent=0; faux.setResponses(Array.from({length:5},()=>async context=>{
   const isParent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
   if(!isParent){await new Promise(resolve=>setTimeout(resolve,200));return fauxAssistantMessage('Retained work.');}
   if(++parent===1)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'Busy work',nonblocking:true},{id:'start'})],{stopReason:'toolUse'});
   const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');handle=(result.details as {id:string}).id;return fauxAssistantMessage('Started.');
  })); }
  const models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});models.registerNativeProvider(faux.provider);
  const settings=SettingsManager.inMemory({defaultTools:['subagent','subagent_status','subagent_compact']});const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:models,model:models.getModel('faux','faux-1')!,settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.inMemory(directory),thinkingLevel:'off'}));
  await session.prompt('Start.');
  faux.setResponses([fauxAssistantMessage([fauxToolCall(action.startsWith('compact')?'subagent_compact':'subagent_status',{run:handle},{id:'inspect'})],{stopReason:'toolUse'}),...(action==='compact'?[fauxAssistantMessage(summary)]:[]),fauxAssistantMessage('Inspected.')]);
  await session.prompt('Inspect.');const result=session.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');assert.equal(result.isError,action==='compact-busy'||(action==='compact'&&summary===''),String(result.content[0]?.type==='text'?result.content[0].text.slice(0,200):''));return {...result.details as any, inspectionText:result.content};
 } finally {if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const [key,val]of Object.entries({PI_SUBAGENT_STORAGE:old.storage,PI_SUBAGENT_AGENTS:old.agents})){if(val===undefined)delete process.env[key];else process.env[key]=val;}await rm(directory,{recursive:true,force:true});}
}

test('host inspection measures retained context rather than billed total and requires an explicit warning decision',async()=>{
 const run=await host(10000,8000);assert.ok(run.contextHealth.estimatedTokens>=8000 && run.contextHealth.estimatedTokens<8500,JSON.stringify(run.contextHealth));assert.equal(run.contextHealth.warningThreshold,8000);assert.equal(run.contextHealth.freshThreshold,9500);assert.equal(run.contextHealth.warning,true);assert.equal(run.contextHealth.requiresReuseDecision,true);assert.equal(run.contextHealth.compaction,'none');
});

test('host status reports both sides of warning and fresh thresholds for small and large windows',async()=>{
 for(const [window,tokens,warning,fresh] of [[10000,7000,false,false],[10000,9000,true,false],[10000,9500,true,true],[200000,119000,false,false],[200000,120000,true,false],[200000,149000,true,false],[200000,150000,true,true]] as const){
  const run=await host(window,tokens);assert.equal(run.contextHealth.warning,warning);assert.equal(run.contextHealth.recommendFresh,fresh);
 }
 const unknown=await host(0,10);assert.equal(unknown.contextHealth.modelCapacity,null);
});

test('explicit host compaction preserves historical result and accounting and reports actual summary placement',async()=>{
 const run=await host(200000,1,'compact');assert.equal(run.compactions.at(-1).outcome,'applied');assert.equal(run.contextHealth.compaction,'applied');assert.ok(run.output.startsWith('Historical answer'));assert.equal(run.output.length,85017);assert.ok(run.compactions.at(-1).usage.totalTokens>0);assert.ok(run.contextHealth.estimatedTokens<28000);
});

test('host reports unsuccessful paid compaction and preserves historical answer',async()=>{
 const run=await host(200000,1,'compact','');assert.equal(run.compactions.at(-1).outcome,'failed');assert.match(run.compactions.at(-1).error,/failed/);assert.ok(run.compactions.at(-1).usage.totalTokens>0);assert.equal(run.contextHealth.compaction,'none');assert.ok(run.output.startsWith('Historical answer'));
});

test('explicit host compaction reports no-op for short retained context',async()=>{
 const run=await host(200000,1,'compact-short');assert.equal(run.compactions.at(-1).outcome,'noop');assert.equal(run.compactions.at(-1).usage.totalTokens,0);assert.equal(run.contextHealth.compaction,'none');assert.ok(run.output.startsWith('Historical answer'));
});

test('host refuses compaction during active work without resetting the conversation',async()=>{
 const result=await host(200000,1,'compact-busy');assert.match(JSON.stringify(result.inspectionText),/eligible idle/);
});
