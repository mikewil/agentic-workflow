import type {Database} from './db';
import {one} from './db';
import {hash,HttpError,policyDenial,redact} from './security';
import {event,getProject,getRun,github,id,pause,stageCompleted} from './service';
import {resultSchema,terminal,type Job,type StageResult} from './types';
export async function runnerRoute(database:Database,req:Request,path:string[]){
  const bearer=req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(!bearer)throw new HttpError(401,'Runner credential required');
  const runner=await one(database,'SELECT * FROM runner_identity($1)',[hash(bearer)]);if(!runner)throw new HttpError(401,'Runner credential revoked or invalid');
  const tenant=runner.tenant_id,body=await req.json();
  if(path[0]==='claim')return database.tenant(tenant,async tx=>{
    await tx.query('UPDATE runners SET last_seen=now() WHERE id=$1',[runner.id]);
    const j=await one<Job>(tx,`SELECT j.* FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.kind='agent' AND j.status='pending' AND r.status='running' AND NOT r.cancellation_requested AND (r.context->>'runnerId' IS NULL OR r.context->>'runnerId'=$1) ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[runner.id]);
    if(!j)return null;
    const lease=id();await tx.query("UPDATE runs SET context=jsonb_set(context,'{runnerId}',$2::jsonb) WHERE id=$1",[j.run_id,JSON.stringify(runner.id)]);await tx.query("UPDATE jobs SET status='leased',runner_id=$2,lease_token=$3,leased_at=now(),lease_until=now()+interval '45 seconds' WHERE id=$1",[j.id,runner.id,lease]);return {...j,lease_token:lease};
  });
  const jobId=path[0],operation=path[1];
  const job=await database.tenant(tenant,async tx=>{
    const j=await one(tx,"SELECT * FROM jobs WHERE id=$1 AND runner_id=$2 AND lease_token=$3 AND status='leased' AND lease_until>now() FOR UPDATE",[jobId,runner.id,body.leaseToken]);if(!j)throw new HttpError(409,'Job lease is no longer valid');return j;
  });
  if(operation==='token'){
    const {run,p}=await database.tenant(tenant,async tx=>{const run=await getRun(tx,job.run_id);return {run,p:await getProject(tx,run.project_id)};});
    if(run.cancellation_requested||run.status!=='running'||p.policy_version!==run.policy_version)throw new HttpError(409,'Run authorization changed');
    const write=body.permission==='write';if(write&&job.stage!=='engineering')throw new HttpError(403,'Only engineering can publish a branch');
    const denial=policyDenial(p,write?'push':'agent');if(denial)throw new HttpError(403,denial);
    const gh=await github(database,tenant,p.repo);return {token:await gh.scopedToken(write?'write':'read')};
  }
  return database.tenant(tenant,async tx=>{
    const freshJob=await one(tx,"SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 AND status='leased' AND lease_until>now() FOR UPDATE",[job.id,body.leaseToken]);if(!freshJob)throw new HttpError(409,'Job lease expired');
    const run=await getRun(tx,job.run_id,true),p=await getProject(tx,run.project_id);
    const elapsed=Math.max(0,Date.now()-new Date(freshJob.leased_at).getTime()),charged=Number(freshJob.payload.chargedMs??0),delta=Math.max(0,elapsed-charged);
    await tx.query('UPDATE runs SET active_ms=active_ms+$2 WHERE id=$1',[run.id,delta]);await tx.query("UPDATE jobs SET payload=jsonb_set(payload,'{chargedMs}',$2::jsonb) WHERE id=$1",[job.id,JSON.stringify(elapsed)]);
    const cancelled=run.cancellation_requested||terminal.has(run.status)||p.policy_version!==run.policy_version||Number(run.active_ms)+delta>=p.policy.maxActiveMinutes*60000;
    if(operation==='heartbeat'){
      if(cancelled&&!terminal.has(run.status))await pause(tx,run,'Execution limit or policy change; runner cancellation requested');
      await tx.query("UPDATE jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1",[job.id]);await tx.query('UPDATE runners SET last_seen=now() WHERE id=$1',[runner.id]);return {cancel:cancelled};
    }
    if(operation==='events'){
      if(cancelled)return {cancel:true};
      // Command bodies and raw agent transcripts can contain source secrets. Persist safe progress metadata only.
      for(const e of (body.events??[]).slice(0,50))await event(tx,tenant,run.id,'agent.progress',{stage:job.stage,type:String(e.type).slice(0,100)});return {ok:true};
    }
    if(operation==='complete'){
      await tx.query("UPDATE jobs SET status=$2,result=$3 WHERE id=$1",[job.id,cancelled?'cancelled':'done',JSON.stringify({ok:!body.error})]);
      if(cancelled){if(!terminal.has(run.status))await pause(tx,run,'Execution limit or policy changed');return {ok:true};}
      if(body.error){await pause(tx,run,redact(String(body.error)).slice(0,1000));return {ok:true};}
      const parsed=resultSchema.parse(body.result),result:StageResult={...parsed};
      for(const k of ['sessionId','sha','baseSha','usage','validation'] as const)if(body.result[k]!==undefined)(result as any)[k]=body.result[k];
      const allowed=new Set(['text/plain','text/markdown','application/json','image/png']);
      result.artifacts=(body.result.artifacts??[]).slice(0,20).map((a:any)=>{if(!allowed.has(a.mediaType)||typeof a.content!=='string'||a.content.length>2_000_000)throw new HttpError(400,'Invalid artifact');return {name:String(a.name).slice(0,200),mediaType:a.mediaType,content:redact(a.content)};});
      result.summary=redact(result.summary);result.details=redact(result.details);
      await stageCompleted(tx,run,p,result);return {ok:true};
    }
    throw new HttpError(404,'Unknown runner operation');
  });
}
