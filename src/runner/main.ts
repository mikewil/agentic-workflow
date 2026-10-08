import {mkdir,readFile,writeFile,rm,stat,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {command} from './process';
import {modelProxy} from './proxy';
import {redact} from '../lib/security';
import type {Job,StageResult} from '../lib/types';
const url=process.env.CONTROL_PLANE_URL??'http://localhost:3000',credential=process.env.RUNNER_TOKEN;
if(!credential)throw new Error('RUNNER_TOKEN is required');
const root=path.resolve(process.env.RUNNER_DATA_DIR??'.data/runner'),image=process.env.RUNNER_IMAGE??'lifecycle-agent:local';
await mkdir(root,{recursive:true,mode:0o700});let stop=false;process.on('SIGTERM',()=>stop=true);process.on('SIGINT',()=>stop=true);
async function api(route:string,body:unknown){const res=await fetch(`${url}/api/runner/${route}`,{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error(`Runner API ${route.split('/').pop()} failed (${res.status})`);return res.json();}
async function execute(job:Job){
  const dir=path.join(root,job.run_id),workspace=path.join(dir,'workspace'),gitdir=path.join(dir,'git'),home=path.join(dir,'codex'),input=path.join(dir,'input'),output=path.join(dir,'output');
  await Promise.all([workspace,home,input,output].map(d=>mkdir(d,{recursive:true,mode:0o700})));
  const container=`lifecycle-${job.id}`,controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),job.payload.remainingMs);
  let heartbeatBusy=false;
  const heartbeat=setInterval(async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{const h=await api(`${job.id}/heartbeat`,{leaseToken:job.lease_token});if(h.cancel)controller.abort();}catch{controller.abort();}finally{heartbeatBusy=false;}},10000);
  controller.signal.addEventListener('abort',()=>{void command('docker',['rm','-f',container]).catch(()=>{});});
  let proxy:Awaited<ReturnType<typeof modelProxy>>|undefined;
  const git=async(args:string[],token?:string)=>command('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never',...(token?['-c',`http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]:[]),'--git-dir',gitdir,'--work-tree',workspace,...args],{signal:controller.signal,env:{NODE_ENV:process.env.NODE_ENV??'production',PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
  try{
    let baseSha:string;
    try{baseSha=(await readFile(path.join(dir,'base-sha'),'utf8')).trim();}
    catch{
      const read=await api(`${job.id}/token`,{leaseToken:job.lease_token,permission:'read'});
      await command('git',['init','--bare',gitdir]);await git(['config','core.bare','false']);
      await git(['fetch','--depth=1',`https://github.com/${job.payload.project.repo}.git`,job.payload.project.config.baseBranch],read.token);
      baseSha=await git(['rev-parse','FETCH_HEAD']);await git(['checkout','-f','-B',`agent/${job.run_id}`,baseSha]);await writeFile(path.join(dir,'base-sha'),baseSha);
    }
    await writeFile(path.join(input,'job.json'),JSON.stringify(job));await rm(path.join(output,'result.json'),{force:true});
    // The agent container sees neither host Git metadata nor platform/GitHub/provider credentials.
    proxy=await modelProxy();
    const args=['run','--rm','--name',container,'--init','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=3g','--cpus=2','--add-host=host.docker.internal:host-gateway','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,
      '-v',`${workspace}:/workspace`,'-v',`${input}:/input:ro`,'-v',`${output}:/output`,'-v',`${home}:/codex`,'-e','CODEX_HOME=/codex','-e','HOME=/tmp','-e',`CODEX_API_KEY=${proxy.token}`,'-e',`CODEX_PROVIDER_URL=${proxy.url}`,...(process.env.CODEX_MODEL?['-e',`CODEX_MODEL=${process.env.CODEX_MODEL}`]:[]),image,'node','--import','tsx','/app/src/runner/stage.ts'];
    let pending='';await command('docker',args,{signal:controller.signal,onStdout:chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop()??'';const events=lines.flatMap(line=>{try{return [{type:JSON.parse(line).type}];}catch{return [];}});if(events.length)void api(`${job.id}/events`,{leaseToken:job.lease_token,events}).catch(()=>{});}});proxy.close();proxy=undefined;
    const result:StageResult=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));
    if(job.stage==='engineering'&&!result.question){
      // Git metadata lives outside the mount. Refuse CI changes and agent-created .git/config indirection.
      try{await lstat(path.join(workspace,'.git'));throw new Error('Agent created forbidden Git metadata');}catch(e:any){if(e.code!=='ENOENT')throw e;}
      await git(['add','--all']);const changed=await git(['diff','--cached','--name-only']);if(changed.split('\n').some(f=>f.startsWith('.github/workflows/')))throw new Error('CI workflow changes require a separate reviewed workflow');
      if(changed)await git(['-c','user.name=Lifecycle Agent','-c','user.email=agent@lifecycle.invalid','commit','-m',`Lifecycle ${job.run_id}`]);
      result.sha=await git(['rev-parse','HEAD']);result.baseSha=baseSha;
      const write=await api(`${job.id}/token`,{leaseToken:job.lease_token,permission:'write'});
      await git(['push',`https://github.com/${job.payload.project.repo}.git`,`HEAD:refs/heads/agent/${job.run_id}`],write.token);
    }
    if(job.stage==='testing'&&!result.question){
      const commands=[job.payload.project.config.setupCommand,job.payload.project.config.testCommand,job.payload.project.config.buildCommand,...(job.payload.project.config.ui?[job.payload.project.config.browserCommand]:[])].filter(Boolean);
      let passed=true,logs='';
      for(const script of commands){try{logs+=await command('docker',['run','--rm','--name',container,'--init','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=3g','--cpus=2','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'-e','HOME=/tmp','-v',`${workspace}:/workspace`,'-w','/workspace',image,'sh','-lc',script],{signal:controller.signal});}catch(e){passed=false;logs+=e instanceof Error?e.message:'Validation failed';break;}}
      const sha=await git(['rev-parse','HEAD']);const dirty=await git(['diff','--name-only','HEAD']);if(dirty)passed=false;
      result.validation={passed,commands,commit:sha};result.artifacts=[{name:'validation.log',mediaType:'text/plain',content:redact(logs).slice(-100000)}];
      const artifacts=path.join(workspace,'lifecycle-artifacts');try{for(const name of (await readdir(artifacts)).slice(0,18)){const file=path.join(artifacts,name),s=await lstat(file);if(!s.isFile()||s.size>1_400_000)continue;if(name.endsWith('.png'))result.artifacts.push({name,mediaType:'image/png',content:await readFile(file,'base64')});else if(name.endsWith('.json'))result.artifacts.push({name,mediaType:'application/json',content:redact(await readFile(file,'utf8'))});}}catch{}
      if(job.payload.project.config.ui&&!result.artifacts.some(a=>a.mediaType==='image/png')){result.validation.passed=false;result.details+=' Browser verification must produce a PNG in lifecycle-artifacts/.';}
    }
    await api(`${job.id}/complete`,{leaseToken:job.lease_token,result});
  }catch(e){await api(`${job.id}/complete`,{leaseToken:job.lease_token,error:redact(e instanceof Error?e.message:'Runner failed')}).catch(()=>{});}
  finally{proxy?.close();clearTimeout(timer);clearInterval(heartbeat);await command('docker',['rm','-f',container]).catch(()=>{});}
}
console.log('Tenant runner connected');
while(!stop){try{const job=await api('claim',{});if(job)await execute(job);else await new Promise(r=>setTimeout(r,3000));}catch(e){console.error(redact(e instanceof Error?e.message:'Runner unavailable'));await new Promise(r=>setTimeout(r,5000));}}
