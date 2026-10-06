// Explicit offline native-host acceptance fixture; never loaded by the product.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
import type { Run } from '../../runtime.ts';
export default function contextAcceptance(pi:ExtensionAPI) {
 const directory=process.env.DURABLE_CONTEXT_ACCEPTANCE_DIR;
 if(!directory) throw new Error('Disposable acceptance directory required');
 const emit=(event:string,details:unknown)=>appendFileSync(join(directory,'events.jsonl'),JSON.stringify({event,details})+'\n');
 const faux=fauxProvider({provider:'context-local',models:[{id:'faux-1',contextWindow:10000}],tokenSize:{min:100000,max:100000}});
 let parent=0;let handle='';
 faux.setResponses(Array.from({length:10},()=>context=>{
  if(!context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'))) return fauxAssistantMessage('Historical result.');
  if(++parent===1)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'A'.repeat(32000)},{id:'native-start'})],{stopReason:'toolUse'});
  if(parent===2){const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');handle=(result.details as Run).id;return fauxAssistantMessage([fauxToolCall('subagent_status',{run:handle},{id:'native-status'})],{stopReason:'toolUse'});}
  if(parent===3)return fauxAssistantMessage([fauxToolCall('subagent_compact',{run:handle},{id:'native-compact'})],{stopReason:'toolUse'});
  emit('complete',{handle});return fauxAssistantMessage('Context warning inspected; explicit compaction reported no-op. Historical answer retained.');
 }));
 pi.registerProvider(faux.provider);
 pi.on('tool_result',event=>{
  if(event.toolName==='subagent_status'){const run=event.details as Run;assert.equal(run.contextHealth?.warning,true);assert.equal(run.contextHealth?.modelCapacity,10000);emit('status',run.contextHealth);}
  if(event.toolName==='subagent_compact'){const run=event.details as Run;assert.equal(run.compactions?.at(-1)?.outcome,'noop');assert.equal(run.output,'Historical result.');emit('compact',run.compactions);}
 });
}
