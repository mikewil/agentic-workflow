import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {resultSchema,type AgentAdapter,type AgentEvent,type AgentInput,type StageResult} from '../lib/types';
import {z} from 'zod';
export const CODEX_VERSION='0.161.0';
export class CodexCLI implements AgentAdapter {
  capabilities={streaming:true,cancellation:true,resume:true,structuredOutput:true};
  async execute(input:AgentInput,onEvent:(event:AgentEvent)=>Promise<void>):Promise<StageResult>{
    const schema=path.join('/tmp',`result-${input.runId}.schema.json`),output=path.join('/tmp',`result-${input.runId}.json`);
    await writeFile(schema,JSON.stringify(z.toJSONSchema(resultSchema)));
    const provider=process.env.CODEX_PROVIDER_URL;
    const common=['--ask-for-approval','never','-c','sandbox_mode="workspace-write"','-c','shell_environment_policy.inherit="none"'];
    if(provider)common.push('-c','model_provider="runner"','-c','model_providers.runner.name="Runner proxy"','-c',`model_providers.runner.base_url=${JSON.stringify(provider)}`,'-c','model_providers.runner.env_key="CODEX_API_KEY"','-c','model_providers.runner.wire_api="responses"');
    if(process.env.CODEX_MODEL)common.push('-c',`model=${JSON.stringify(process.env.CODEX_MODEL)}`);
    const args=[...common,'exec',...(input.sessionId?['resume']:[]),'--json','--skip-git-repo-check','--output-schema',schema,'--output-last-message',output,...(input.sessionId?[input.sessionId]:[]),'-'];
    let sessionId:string|undefined,usage:Record<string,number>|undefined;
    await new Promise<void>((resolve,reject)=>{
      const child=spawn('codex',args,{cwd:input.workspace,env:process.env,signal:input.signal,stdio:['pipe','pipe','pipe']});
      child.stdin.end(input.prompt);const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{try{const e=JSON.parse(line);if(e.type==='thread.started')sessionId=e.thread_id;if(e.type==='turn.completed')usage=e.usage;void onEvent({type:e.type,data:{}}).catch(()=>{});}catch{}});
      child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`Codex exited with status ${code}`)));
    });
    const result=resultSchema.parse(JSON.parse(await readFile(output,'utf8')));return {...result,sessionId,usage};
  }
}
