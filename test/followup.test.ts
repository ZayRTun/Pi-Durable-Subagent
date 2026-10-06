import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels, Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import { Runtime, runId, type Run } from '../runtime.ts';

async function fixture(body:(runtime:Runtime,models:ReturnType<typeof createModels>,faux:ReturnType<typeof fauxProvider>,seed:Run)=>Promise<void>,maxActive=8) {
 const directory=await mkdtemp(join(tmpdir(),'durable-followup-'));const runtime=new Runtime(join(directory,'runs'),{maxActive});const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 const now=Date.now();const seed:Run={version:1,id:runId('parent','original'),sessionId:'parent',agent:{name:'worker',description:'Read fact',instructions:'Work.',tools:['lookup']},task:'Remember the secret is orchid.',cwd:directory,model:{provider:'faux',modelId:'faux-1'},thinking:'off',timeoutMinutes:null,createdAt:now,updatedAt:now,status:'running',activity:'Starting',unavailable:[]};
 try {await body(runtime,models,faux,seed);}finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
}

test('nonblocking follow-up rejects concurrent task and compaction, preserves old result during cancellation',async()=>fixture(async(runtime,models,faux,seed)=>{
 let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const tool=defineTool({name:'lookup',description:'Wait',parameters:Type.Object({}),execute:async()=>{enter();await gate;return{content:[{type:'text',text:'Fact.'}]};}});
 faux.setResponses([fauxAssistantMessage('Original answer.')]);await runtime.execute(seed,{models,tools:[tool]});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('lookup',{}, {id:'new-call'})],{stopReason:'toolUse'}),fauxAssistantMessage('New answer.')]);
 const request={executionId:runId('parent','second'),sessionId:'parent',task:'Read another fact.',nonblocking:true};
 const second=await runtime.followUp(seed.id,request,{models,tools:[tool]});assert.equal(second.status,'running');await entered;
 try {
  await assert.rejects(runtime.followUp(seed.id,{...request,executionId:runId('parent','conflict')},{models,tools:[tool]}),/busy|unfinished/);
  await assert.rejects(runtime.compact(seed.id,{sessionId:'parent',models}),/busy|unfinished/);
  assert.equal((await runtime.inspect(seed.id,{sessionId:'parent',models})).output,'Original answer.');
  assert.equal((await runtime.followUp(seed.id,request,{models,tools:[tool]})).id,second.id,'repeated accepted request retrieves same execution');
 } finally {release();await runtime.cancel(second.id);}
 assert.equal((await runtime.status(second.id,'parent')).status,'aborted');
 assert.equal((await runtime.status(seed.id,'parent')).output,'Original answer.');
}));

test('retained follow-up reacquires capacity and workspace ownership before submitting a new task',async()=>fixture(async(runtime,models,faux,seed)=>{
 faux.setResponses([fauxAssistantMessage('Original answer.')]);await runtime.execute(seed,{models,tools:[]});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const tool=defineTool({name:'lookup',description:'Wait',parameters:Type.Object({}),execute:async()=>{await gate;return{content:[{type:'text',text:'Done.'}]};}});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('lookup',{}, {id:'busy-call'})],{stopReason:'toolUse'}),fauxAssistantMessage('Done.')]);
 const busy=await runtime.start({...seed,id:runId('parent','busy'),task:'Other conversation.'},{models,tools:[tool]});
 try {await assert.rejects(runtime.followUp(seed.id,{executionId:runId('parent','refused'),sessionId:'parent',task:'New task.'},{models,tools:[]}),/capacity|working directory|lock/i);assert.equal((await runtime.list('parent')).length,2);}
 finally{release();await runtime.cancel(busy.id);}
},1));

test('follow-up consumes retained tool result without replaying effects or inheriting prior tool counts',async()=>fixture(async(runtime,models,faux,seed)=>{
 let effects=0;const tool=defineTool({name:'lookup',description:'Read secret',parameters:Type.Object({}),replay:'unsafe',execute:async()=>{effects++;return{content:[{type:'text',text:'The secret is orchid.'}]};}});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('lookup',{}, {id:'original-effect'})],{stopReason:'toolUse'}),fauxAssistantMessage('Fact retained.')]);
 const original=await runtime.execute(seed,{models,tools:[tool]});assert.equal(original.toolCount,1);
 faux.setResponses([context=>{assert.ok(context.messages.some(m=>m.role==='toolResult'&&JSON.stringify(m.content).includes('orchid')));return fauxAssistantMessage('The secret is orchid.');}]);
 const next=await runtime.followUp(original.id,{executionId:runId('parent','retained-result'),sessionId:'parent',task:'Answer using the retained lookup.'},{models,tools:[tool]});assert.equal(next.output,'The secret is orchid.');assert.equal(effects,1);assert.equal(next.toolCount,0);assert.equal((await runtime.read(original.id)).toolCount,1);
}));

test('follow-up never adds a tool that was unavailable to the original execution',async()=>fixture(async(runtime,models,faux,seed)=>{
 faux.setResponses([fauxAssistantMessage('Original answer.')]);const original=await runtime.execute(seed,{models,tools:[]});assert.deepEqual(original.unavailable,['lookup']);
 let effects=0;const tool=defineTool({name:'lookup',description:'Newly exposed tool',parameters:Type.Object({}),execute:async()=>{effects++;return{content:[{type:'text',text:'Forbidden expansion.'}]};}});
 faux.setResponses([context=>{assert.ok(!context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='lookup')));return fauxAssistantMessage('Stayed within authority.');}]);
 const next=await runtime.followUp(original.id,{executionId:runId('parent','authority'),sessionId:'parent',task:'New task.'},{models,tools:[tool]});assert.equal(next.status,'succeeded');assert.equal(effects,0);assert.deepEqual(next.unavailable,['lookup']);
}));
