import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import extension from '../index.ts';

test('host Chain holds dependent across pause and reload, then hands off only the continued final answer', {timeout:10000}, async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-groups-'));const old={agents:process.env.PI_SUBAGENT_AGENTS,storage:process.env.PI_SUBAGENT_STORAGE};process.env.PI_SUBAGENT_AGENTS=directory;process.env.PI_SUBAGENT_STORAGE=join(directory,'runs');
 const timer=globalThis.setTimeout;globalThis.setTimeout=((fn: (...args: unknown[]) => void,delay?: number,...args: unknown[])=>timer(fn,delay===60000?40:delay===48000?30:delay,...args)) as typeof setTimeout;
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;let child='';let group='';let work=0;let phase='start';const seen:string[]=[];
 try{
  await writeFile(join(directory,'scout.md'),'---\nname: scout\ndescription: Original frozen role\ntools: hold\n---\nOriginal role.');const faux=fauxProvider();
  faux.setResponses(Array.from({length:50},()=>context=>{
   const parent=context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'));
   const last=context.messages.at(-1);
   if(parent){
    if(last?.role==='toolResult')return fauxAssistantMessage('Parent settled.');
    const args: Record<string, string | number | {task:string}[] | null> =phase==='start'?{agent:'scout',chain:[{task:'First'},{task:'Second'}],timeoutMinutes:1}:phase==='status'?{run:group}:{resume:child,reassessment:'Finish retained work',timeoutMinutes:null};
    return fauxAssistantMessage([fauxToolCall(phase==='status'?'subagent_status':'subagent',args,{id:phase})],{stopReason:'toolUse'});
   }
   const text=JSON.stringify(context.messages);seen.push(text);
   const latestUser=context.messages.findLast(m=>m.role==='user');const latest=JSON.stringify(latestUser);
   if(latest.includes('Produce a final tool-free handoff'))return fauxAssistantMessage('HANDOFF: unfinished');
   if(latest.includes('Parent reassessment: Finish retained work')){assert.match(text,/Original role/);assert.doesNotMatch(text,/Changed role/);return fauxAssistantMessage('FINAL: genuine answer');}
   if(text.includes('Second'))return fauxAssistantMessage('Dependent final answer');
   if(!context.messages.some(m=>m.role==='toolResult'))return fauxAssistantMessage([fauxToolCall('hold',{}, {id:'hold-first'})],{stopReason:'toolUse'});
   return fauxAssistantMessage('Attempt ended');
  }));
  const models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false});models.registerNativeProvider(faux.provider);const manager=SessionManager.inMemory(directory);const settings=SettingsManager.inMemory({defaultTools:['subagent','subagent_status']});
  async function open(){const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[extension,pi=>pi.registerTool({name:'hold',label:'Hold',exposure:'codemode',description:'Controlled tool boundary',parameters:Type.Object({}),async execute(){work++;await new Promise(resolve=>timer(resolve,120));return {content:[],details:undefined};}})]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:models,model:faux.getModel(),sessionManager:manager,settingsManager:settings,resourceLoader:loader,thinkingLevel:'off'}));await session.bindExtensions({mode:'print'});}
  await open();await session!.prompt('Start chain.');const result=session!.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='subagent');assert.ok(result?.role==='toolResult');const held=result.details as {id:string;steps:{id:string;status:string}[];presentation:{entries:{phase:string}[]}};
  assert.equal(held.steps.length,1,'Paused child must not start its dependent');assert.equal(held.steps[0].status,'paused');assert.deepEqual(held.presentation.entries.map(e=>e.phase),['run','pending']);assert.ok(held.id);child=held.steps[0].id;group=held.id;assert.equal(work,1);
  await session!.reload();phase='status';await session!.prompt('Inspect retained group.');const status=session!.messages.findLast(m=>m.role==='toolResult');assert.ok(status?.role==='toolResult');assert.deepEqual((status.details as typeof held).presentation.entries.map(e=>e.phase),['run','pending']);assert.equal(work,1);
  await writeFile(join(directory,'scout.md'),'---\nname: scout\ndescription: Changed role\ntools: hold\n---\nChanged role.');phase='continue';await session!.prompt('Continue held child.');const continued=session!.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='subagent');assert.ok(continued?.role==='toolResult');const final=continued.details as typeof held;assert.deepEqual(final.steps.map(r=>r.status),['succeeded','succeeded']);assert.equal(work,1,'Continuation must not replay completed side effect');const dependent=seen.find(t=>t.includes('Answer from the previous step in this chain:'));assert.ok(dependent);assert.match(dependent,/FINAL: genuine answer/);assert.doesNotMatch(dependent,/HANDOFF: unfinished/);
 }finally{globalThis.setTimeout=timer;if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}for(const[key,value]of Object.entries({PI_SUBAGENT_AGENTS:old.agents,PI_SUBAGENT_STORAGE:old.storage})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});}
});
