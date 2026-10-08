import type {Database,DB} from '../lib/db';
import {one} from '../lib/db';
import type {Project,Run,WorkItem} from '../lib/types';
import {terminal} from '../lib/types';
import {policyDenial} from '../lib/security';
import {event,getProject,getRun,github,id,ingestIssue,notify,pause,transition} from '../lib/service';
import {GitHub} from '../adapters/github';
export class UncertainEffect extends Error{}
export class Engine {
  constructor(public db:Database,readonly connect:(tenant:string,repo:string)=>Promise<GitHub>=(t,r)=>github(db,t,r)){}
  async effect(run:Run,key:string,kind:string,request:unknown,execute:()=>Promise<any>,reconcile:()=>Promise<any|null>){
    const record=await this.db.tenant(run.tenant_id,async tx=>{
      await tx.query("INSERT INTO effects(id,tenant_id,run_id,key,kind,request) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[id(),run.tenant_id,run.id,key,kind,JSON.stringify(request)]);
      const e=(await one(tx,'SELECT * FROM effects WHERE run_id=$1 AND key=$2 FOR UPDATE',[run.id,key]))!;
      if(e.status==='prepared')await tx.query("UPDATE effects SET status='executing' WHERE id=$1",[e.id]);return e;
    });
    if(record.status==='done')return record.result;
    let result:any;
    if(record.status==='executing'){
      result=await reconcile();if(result===null)throw new UncertainEffect(`${kind} outcome is uncertain; reconcile the provider before resuming`);
    }else result=await execute();
    await this.db.tenant(run.tenant_id,tx=>tx.query("UPDATE effects SET status='done',result=$2 WHERE id=$1",[record.id,JSON.stringify(result??{})]));return result;
  }
  async permitted(run:Run,action:Project['policy']['actions'][number]){
    return this.db.tenant(run.tenant_id,async tx=>{
      const fresh=await getRun(tx,run.id,true),p=await getProject(tx,run.project_id);
      if(fresh.cancellation_requested||terminal.has(fresh.status))throw new Error('Run is cancelled or finished');
      if(p.policy_version!==fresh.policy_version)throw new Error('Policy changed; review and resume the run');
      const denial=policyDenial(p,action);if(denial)throw new Error(denial);return p;
    });
  }
  async tick(tenant:string){
    const pending=await this.db.tenant(tenant,async tx=>{
      // Agent leases are not automatically replayed: a lost runner may still be alive.
      const lost=await tx.query("UPDATE jobs SET status='lost' WHERE status='leased' AND kind='agent' AND lease_until<now() RETURNING run_id,leased_at");
      for(const j of lost.rows){const r=await getRun(tx,j.run_id);if(!terminal.has(r.status))await pause(tx,r,'Runner lease expired; verify the old container is stopped before resuming');}
      await tx.query("UPDATE jobs SET status='pending',lease_token=NULL WHERE status='leased' AND kind='control' AND lease_until<now()");
      const queued=await tx.query<Run>(`SELECT r.* FROM runs r JOIN work_items w ON w.id=r.work_item_id WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM runs a WHERE a.project_id=r.project_id AND a.status NOT IN ('queued','succeeded','failed','cancelled','rolled_back')) ORDER BY w.ready_at,r.created_at FOR UPDATE OF r SKIP LOCKED`);
      const started=new Set<string>();for(const r of queued.rows){if(started.has(r.project_id))continue;started.add(r.project_id);await transition(tx,r,'discovery');}
      const running=await tx.query<Run>("SELECT * FROM runs WHERE status='running' AND NOT cancellation_requested FOR UPDATE SKIP LOCKED");
      for(const run of running.rows){
        if(run.stage==='verification')continue;
        if(await one(tx,"SELECT id FROM jobs WHERE run_id=$1 AND status IN ('pending','leased')",[run.id]))continue;
        const p=await getProject(tx,run.project_id);
        if(Number(run.active_ms)>=p.policy.maxActiveMinutes*60000){await pause(tx,run,'Active execution limit reached');continue;}
        if(p.policy_version!==run.policy_version){await pause(tx,run,'Policy changed; review and resume');continue;}
        const agent=['discovery','requirements','design','engineering','testing'].includes(run.stage);
        if(agent){const denial=policyDenial(p,'agent');if(denial){await pause(tx,run,denial);continue;}}
        if(run.stage==='design'&&(!p.config.ui||run.context.outputs?.requirements?.uiRelevant===false)){
          await event(tx,tenant,run.id,'stage.skipped',{stage:'design',reason:'No user-facing change identified'});await transition(tx,run,'engineering');continue;
        }
        const item=await one<WorkItem>(tx,'SELECT * FROM work_items WHERE id=$1',[run.work_item_id]);
        await tx.query('INSERT INTO jobs(id,tenant_id,run_id,kind,stage,payload) VALUES($1,$2,$3,$4,$5,$6)',[id(),tenant,run.id,agent?'agent':'control',run.stage,JSON.stringify({project:p,item,context:run.context,remainingMs:p.policy.maxActiveMinutes*60000-Number(run.active_ms)})]);
      }
      return (await tx.query("SELECT * FROM jobs WHERE kind='control' AND status='pending' ORDER BY created_at LIMIT 10")).rows;
    });
    for(const job of pending){const claimed=await this.db.tenant(tenant,tx=>one(tx,"UPDATE jobs SET status='leased',lease_token=$2,lease_until=now()+interval '2 minutes' WHERE id=$1 AND status='pending' RETURNING *",[job.id,id()]));if(!claimed)continue;
      try {await this.controlStage(tenant,job.run_id);await this.db.tenant(tenant,tx=>tx.query("UPDATE jobs SET status='done' WHERE id=$1",[job.id]));}
      catch(e){await this.db.tenant(tenant,async tx=>{await tx.query("UPDATE jobs SET status='failed' WHERE id=$1",[job.id]);const r=await getRun(tx,job.run_id);if(!terminal.has(r.status))await pause(tx,r,e instanceof Error?e.message:'Stage failed');});}
    }
  }
  async controlStage(tenant:string,runId:string){
    const {run,p,item}=await this.db.tenant(tenant,async tx=>{const run=await getRun(tx,runId);return {run,p:await getProject(tx,run.project_id),item:(await one<WorkItem>(tx,'SELECT * FROM work_items WHERE id=$1',[run.work_item_id]))!};});
    if(run.cancellation_requested||run.status!=='running')return;
    const gh=await this.connect(tenant,p.repo),branch=`agent/${run.id}`;
    if(run.stage==='merge'){
      await this.permitted(run,'push');
      if(!run.context.sha||!run.context.validation?.passed||run.context.validation.commit!==run.context.sha)throw new Error('Missing validated commit');
      const pr=await this.effect(run,'pr','pull request',{branch},()=>gh.ensurePR(branch,p.config.baseBranch,item.title,`Closes #${item.external_id}\n\nLifecycle run: ${run.id}`),async()=>{const prs=await gh.request(gh.path(`/pulls?state=all&head=${encodeURIComponent(p.repo.split('/')[0]+':'+branch)}`));return prs[0]??null;});
      run.context.pr=pr.number;
      const latest=await gh.getPR(pr.number);
      if(latest.head.sha!==run.context.sha)throw new Error('PR head changed after validation');
      if(latest.merged){run.context.mergedSha=latest.merge_commit_sha;await this.db.tenant(tenant,tx=>transition(tx,run,'deployment',run.context));return;}
      if(latest.head.sha!==run.context.sha)throw new Error('PR head changed after validation');
      const base=await gh.branchSha(p.config.baseBranch);
      if(base!==run.context.baseSha)throw new Error('Base branch changed; create a new run after reconciling the branch and rerunning validation');
      const checks=await gh.checks(run.context.sha);
      if(!p.policy.requiredChecks.length)throw new Error('At least one required CI check must be configured for autonomous merge');
      if(!p.policy.requiredChecks.every(name=>checks.some(c=>c.name===name&&c.passed)))return;
      await this.permitted(run,'merge');
      const merged=await this.effect(run,'merge','merge',{pr:pr.number,sha:run.context.sha},()=>gh.merge(pr.number,run.context.sha),async()=>{const check=await gh.getPR(pr.number);return check.merged?{sha:check.merge_commit_sha}:null;});
      run.context.mergedSha=merged.sha;await this.db.tenant(tenant,tx=>transition(tx,run,'deployment',run.context));
    }
    if(run.stage==='deployment'){
      await this.permitted(run,'deploy');
      const key=`lifecycle-${run.id}-deploy`,inputs={lifecycle_run_id:key,sha:run.context.mergedSha,environment:p.config.environment};
      await this.effect(run,'deploy','deployment',inputs,async()=>{await gh.dispatch(p.config.deployWorkflow,p.config.baseBranch,inputs);return {dispatched:true};},async()=>{const found=await gh.findWorkflowRun(p.config.deployWorkflow,key);return found?{dispatched:true}:null;});
      const workflow=await gh.findWorkflowRun(p.config.deployWorkflow,key);if(!workflow||workflow.status!=='completed')return;
      if(workflow.conclusion!=='success')throw new Error('Deployment workflow failed');
      await this.db.tenant(tenant,async tx=>{const previous=await one(tx,"SELECT sha FROM releases WHERE project_id=$1 AND status IN ('healthy','verifying') ORDER BY deployed_at DESC LIMIT 1",[p.id]);
        await tx.query("UPDATE releases SET status='superseded' WHERE project_id=$1 AND status IN ('healthy','verifying')",[p.id]);
        await tx.query("INSERT INTO releases(id,tenant_id,project_id,run_id,sha,previous_sha,verify_until) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",[id(),tenant,p.id,run.id,run.context.mergedSha,previous?.sha??null]);await transition(tx,run,'verification',run.context);await notify(tx,tenant,run.id,'Deployed; verifying application health for five minutes');});
    }
    // Verification is advanced by the health monitor, without billing wait time as active execution.
  }
  async reconcile(tenant:string){
    const projects=await this.db.tenant(tenant,tx=>tx.query<Project>('SELECT * FROM projects'));
    for(const p of projects.rows){try{const gh=await this.connect(tenant,p.repo);const issues=await gh.listReady();await this.db.tenant(tenant,async tx=>{for(const issue of issues)await ingestIssue(tx,tenant,p,issue);});}catch(e){console.error('Backlog reconciliation failed',p.id,e instanceof Error?e.message:'error');}}
    await this.db.tenant(tenant,async tx=>{const inbox=await tx.query("SELECT * FROM inbox WHERE provider='github' AND processed_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED");for(const entry of inbox.rows){const payload=entry.payload;if(entry.provider==='github'&&payload.issue){const p=await one<Project>(tx,'SELECT * FROM projects WHERE repo=$1',[payload.repository?.full_name]);if(p)await ingestIssue(tx,tenant,p,payload.issue);}await tx.query('UPDATE inbox SET processed_at=now() WHERE id=$1',[entry.id]);}});
  }
}
