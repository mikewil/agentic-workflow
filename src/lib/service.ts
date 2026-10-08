import {randomUUID} from 'node:crypto';
import type {DB,Database} from './db';
import {one} from './db';
import {HttpError,authorize,decrypt,policyDenial,redact} from './security';
import type {Actor,Project,Run,StageResult,WorkItem} from './types';
import {terminal} from './types';
import {GitHub} from '../adapters/github';
export const id=()=>randomUUID();
export async function event(tx:DB,tenant:string,run:string,type:string,data:unknown){await tx.query('INSERT INTO events(tenant_id,run_id,type,data) VALUES($1,$2,$3,$4)',[tenant,run,type,JSON.stringify(data)]);}
export async function notify(tx:DB,tenant:string,run:string,text:string){await tx.query('INSERT INTO notifications(id,tenant_id,run_id,text) VALUES($1,$2,$3,$4)',[id(),tenant,run,text]);}
export async function getProject(tx:DB,projectId:string){const p=await one<Project>(tx,'SELECT * FROM projects WHERE id=$1',[projectId]);if(!p)throw new HttpError(404,'Project not found');return p;}
export async function getRun(tx:DB,runId:string,lock=false){const r=await one<Run>(tx,`SELECT * FROM runs WHERE id=$1${lock?' FOR UPDATE':''}`,[runId]);if(!r)throw new HttpError(404,'Run not found');return r;}
export async function github(database:Database,tenant:string,repo:string){return database.tenant(tenant,async tx=>{const i=await one(tx,"SELECT * FROM integrations WHERE provider='github'");if(!i)throw new Error('GitHub connection is not configured');const secret=decrypt<any>(i.encrypted_secret,tenant);return new GitHub(repo,{...i.config,...secret});});}
export async function ingestIssue(tx:DB,tenant:string,project:Project,issue:any,enqueue=true,force=false){
  if(issue.pull_request)return;
  const before=await one(tx,'SELECT ready_at FROM work_items WHERE project_id=$1 AND external_id=$2',[project.id,issue.number]);
  const ready=issue.state==='open'&&issue.labels?.some((x:any)=>(typeof x==='string'?x:x.name)==='agent:ready');
  const item=await one<WorkItem>(tx,`INSERT INTO work_items(id,tenant_id,project_id,external_id,title,body,ready_at,state) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END,$8)
    ON CONFLICT(tenant_id,project_id,external_id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,state=EXCLUDED.state,ready_at=CASE WHEN $7 THEN coalesce(work_items.ready_at,now()) ELSE NULL END RETURNING *`,[id(),tenant,project.id,issue.number,issue.title,issue.body??'',ready,issue.state]);
  if(ready&&enqueue&&item){
    // Do not repeat a completed request while its ready label remains on the issue.
    const old=await one(tx,'SELECT status FROM runs WHERE work_item_id=$1 ORDER BY created_at DESC LIMIT 1',[item.id]);if(old&&(!terminal.has(old.status)||(!force&&before?.ready_at)))return;
    const runId=id();await tx.query('INSERT INTO runs(id,tenant_id,project_id,work_item_id,policy_version,policy_snapshot) VALUES($1,$2,$3,$4,$5,$6)',[runId,tenant,project.id,item.id,project.policy_version,JSON.stringify(project.policy)]);await event(tx,tenant,runId,'queued',{issue:issue.number});await notify(tx,tenant,runId,`Queued #${issue.number}: ${issue.title}`);
  }
}
export async function pause(tx:DB,run:Run,reason:string){const current=await getRun(tx,run.id,true);if(terminal.has(current.status))return;await tx.query("UPDATE runs SET status='paused',updated_at=now() WHERE id=$1",[run.id]);await event(tx,run.tenant_id,run.id,'paused',{reason});await notify(tx,run.tenant_id,run.id,`Paused: ${reason}`);}
export async function transition(tx:DB,run:Run,stage:Run['stage'],context=run.context){await tx.query("UPDATE runs SET stage=$2,status='running',context=$3,updated_at=now() WHERE id=$1",[run.id,stage,JSON.stringify(context)]);await event(tx,run.tenant_id,run.id,'stage.started',{stage});}
export async function control(database:Database,actor:Actor,runId:string,action:'cancel'|'resume'|'answer'|'message',text?:string){authorize(actor,'operate');return database.tenant(actor.tenantId,async tx=>{
  const run=await getRun(tx,runId,true);if(terminal.has(run.status))throw new HttpError(409,'Run is already finished');
  if(action==='cancel'){await tx.query("UPDATE runs SET cancellation_requested=true,status='cancelled',updated_at=now() WHERE id=$1",[runId]);await tx.query("UPDATE jobs SET status='cancelled' WHERE run_id=$1 AND status='pending'",[runId]);}
  if(action==='resume'){if(!['paused','waiting'].includes(run.status))throw new HttpError(409,'Run is not paused');const q=await one(tx,'SELECT id FROM questions WHERE run_id=$1 AND answer IS NULL',[runId]);if(q)throw new HttpError(409,'Answer the outstanding question first');const p=await getProject(tx,run.project_id);await tx.query("UPDATE runs SET status='running',policy_version=$2,policy_snapshot=$3 WHERE id=$1",[runId,p.policy_version,JSON.stringify(p.policy)]);}
  if(action==='answer'){if(!text?.trim())throw new HttpError(400,'An answer is required');const q=await one(tx,'UPDATE questions SET answer=$2,answered_by=$3 WHERE id=(SELECT id FROM questions WHERE run_id=$1 AND answer IS NULL ORDER BY created_at LIMIT 1) RETURNING id',[runId,text,actor.userId]);if(!q)throw new HttpError(409,'No open question');run.context.answers=[...(run.context.answers??[]),text];await tx.query("UPDATE runs SET status='running',context=$2 WHERE id=$1",[runId,JSON.stringify(run.context)]);}
  if(action==='message'){if(!text?.trim())throw new HttpError(400,'Message is required');run.context.instructions=[...(run.context.instructions??[]),text];await tx.query('UPDATE runs SET context=$2 WHERE id=$1',[runId,JSON.stringify(run.context)]);}
  await event(tx,actor.tenantId,runId,`user.${action}`,{user:actor.userId,text:text??''});await notify(tx,actor.tenantId,runId,`${action}: ${text??actor.userId}`);return {ok:true};
});}
export async function stageCompleted(tx:DB,run:Run,project:Project,result:StageResult){
  await tx.query('INSERT INTO stage_results(id,tenant_id,run_id,stage,result) VALUES($1,$2,$3,$4,$5)',[id(),run.tenant_id,run.id,run.stage,JSON.stringify(result)]);
  await event(tx,run.tenant_id,run.id,'stage.completed',{stage:run.stage,summary:result.summary});
  run.context.outputs={...run.context.outputs,[run.stage]:result};if(result.sessionId)run.context.sessionId=result.sessionId;
  for(const artifact of result.artifacts??[])await tx.query('INSERT INTO artifacts(id,tenant_id,run_id,name,media_type,content) VALUES($1,$2,$3,$4,$5,$6)',[id(),run.tenant_id,run.id,artifact.name,artifact.mediaType,artifact.content]);
  if(result.question){await tx.query('INSERT INTO questions(id,tenant_id,run_id,question) VALUES($1,$2,$3,$4)',[id(),run.tenant_id,run.id,result.question]);await tx.query("UPDATE runs SET status='waiting',context=$2 WHERE id=$1",[run.id,JSON.stringify(run.context)]);await notify(tx,run.tenant_id,run.id,`Question: ${result.question}`);return;}
  if(run.stage==='discovery')await tx.query('INSERT INTO project_profiles(id,tenant_id,project_id,run_id,profile) VALUES($1,$2,$3,$4,$5)',[id(),run.tenant_id,project.id,run.id,JSON.stringify(result)]);
  if(run.stage==='engineering'){run.context.sha=result.sha;run.context.baseSha=result.baseSha;}
  if(run.stage==='testing'){
    if(!result.validation?.passed||result.validation.commit!==run.context.sha){
      if(run.repairs>=project.policy.maxRepairs){await pause(tx,run,'Validation failed; repair limit reached');return;}
      await tx.query('UPDATE runs SET repairs=repairs+1 WHERE id=$1',[run.id]);await transition(tx,run,'engineering',run.context);return;
    }
    run.context.validation=result.validation;
  }
  const order=['discovery','requirements','design','engineering','testing','merge','deployment','verification'] as const;
  const next=order[order.indexOf(run.stage)+1];if(next)await transition(tx,run,next,run.context);
}
