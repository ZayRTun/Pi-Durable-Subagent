// Explicit offline native-host acceptance; never loaded by the product.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
import type { Run } from '../../runtime.ts';
export default function followupAcceptance(pi:ExtensionAPI) {
 const directory=process.env.DURABLE_FOLLOWUP_ACCEPTANCE_DIR;if(!directory)throw new Error('Disposable acceptance directory required');
 const emit=(event:string,details:unknown)=>appendFileSync(join(directory,'events.jsonl'),JSON.stringify({event,details})+'\n');
 const faux=fauxProvider({provider:'followup-local',tokenSize:{min:100000,max:100000}});let step=0;let old:Run;let next:Run;
 faux.setResponses(Array.from({length:20},()=>context=>{
  if(!context.messages.some(m=>m.role==='system'&&m.toolsAdded?.some(t=>t.name==='subagent'))){
   const retained=context.messages.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('The secret is orchid.'));return fauxAssistantMessage(retained?'The secret is orchid.':'No retained secret.');
  }
  if(++step===1)return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'The secret is orchid. Remember it.'},{id:'native-original'})],{stopReason:'toolUse'});
  const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result?.role==='toolResult');
  if(step===2){old=result.details as Run;emit('original',old);return fauxAssistantMessage([fauxToolCall('subagent_followup',{run:old.id,task:'What is the secret?'},{id:'native-followup'})],{stopReason:'toolUse'});}
  if(step===3){next=result.details as Run;assert.notEqual(next.id,old.id);assert.equal(next.conversationId,old.id);assert.equal(next.output,'The secret is orchid.');emit('followup',next);return fauxAssistantMessage([fauxToolCall('subagent_status',{run:old.id},{id:'native-old'})],{stopReason:'toolUse'});}
  if(step===4){assert.equal((result.details as Run).task,old.task);assert.equal(result.usage,undefined);emit('old-retrieval',result.details);return fauxAssistantMessage([fauxToolCall('subagent_status',{run:next.id},{id:'native-new'})],{stopReason:'toolUse'});}
  assert.equal(result.usage,undefined);assert.equal((result.details as Run).task,next.task);emit('complete',{old:old.id,next:next.id});return fauxAssistantMessage('Retained orchid fact answered by a distinct follow-up execution. Both historical answers remain available without repeat billing.');
 }));pi.registerProvider(faux.provider);
}
