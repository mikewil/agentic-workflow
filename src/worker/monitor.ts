import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import type {MonitoringAdapter,Project,Run} from '../lib/types';
import {policyDenial} from '../lib/security';
import {one} from '../lib/db';
import {Engine} from './engine';
import {event,getProject,getRun,github,id,notify,pause} from '../lib/service';
export function privateAddress(address:string){return address==='::1'||address.startsWith('fc')||address.startsWith('fd')||address.startsWith('fe80:')||address.startsWith('::ffff:')||/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);}
export class HttpMonitor implements MonitoringAdapter {
  async check(url:string){
    const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid health URL');
    const host=u.hostname.replace(/^\[|\]$/g,'');const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
    const allow=(process.env.HEALTH_ALLOWED_HOSTS??'').split(',').includes(host);
    if(!allow&&addresses.some(x=>privateAddress(x.address)))throw new Error('Private health destination requires operator HEALTH_ALLOWED_HOSTS configuration');
    const address=addresses[0];if(!address)throw new Error('No health address');
    // Pin the validated DNS answer; never follow redirects to a different destination.
    return new Promise<boolean>(resolve=>{const req=(u.protocol==='https:'?httpsRequest:httpRequest)(u,{method:'GET',timeout:10000,lookup:((_host:any,_options:any,cb:any)=>cb(null,address.address,address.family)) as any},res=>{res.resume();resolve((res.statusCode??500)>=200&&(res.statusCode??500)<300);});req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));req.end();});
  }
}
export async function monitor(engine:Engine,tenant:string,adapter:MonitoringAdapter=new HttpMonitor()){
  const releases=await engine.db.tenant(tenant,tx=>tx.query("UPDATE releases SET next_check=now()+interval '60 seconds' WHERE id IN (SELECT id FROM releases WHERE status IN ('verifying','healthy','rolling_back') AND next_check<=now() FOR UPDATE SKIP LOCKED) RETURNING *"));
  for(const release of releases.rows){
    const {run,p}=await engine.db.tenant(tenant,async tx=>({run:await getRun(tx,release.run_id),p:await getProject(tx,release.project_id)}));
    if(release.status==='rolling_back'){await rollback(engine,run,p,release);continue;}
    let healthy=false;try{healthy=await adapter.check(p.config.healthUrl);}catch{healthy=false;}
    const now=Date.now(),inWindow=now<=new Date(release.verify_until).getTime(),failures=healthy?0:release.failures+1;
    await engine.db.tenant(tenant,async tx=>{await tx.query('UPDATE releases SET failures=$2,healthy_samples=healthy_samples+$3 WHERE id=$1',[release.id,failures,healthy?1:0]);await event(tx,tenant,run.id,'health.checked',{healthy,failures});});
    if(failures>=3){
      await engine.db.tenant(tenant,async tx=>{const exists=await one(tx,'SELECT id FROM incidents WHERE release_id=$1',[release.id]);if(!exists){await tx.query('INSERT INTO incidents(id,tenant_id,run_id,release_id,detail) VALUES($1,$2,$3,$4,$5)',[id(),tenant,run.id,release.id,'Three consecutive health checks failed']);await notify(tx,tenant,run.id,'Incident: three consecutive health checks failed');}});
      if(inWindow&&!release.rollback_started){await engine.db.tenant(tenant,tx=>tx.query("UPDATE releases SET rollback_started=true,status='rolling_back' WHERE id=$1",[release.id]));await rollback(engine,run,p,release);}
    }else if(!inWindow&&release.status==='verifying'&&healthy){await engine.db.tenant(tenant,async tx=>{await tx.query("UPDATE releases SET status='healthy' WHERE id=$1",[release.id]);if(!run.cancellation_requested){await tx.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);await event(tx,tenant,run.id,'succeeded',{});await notify(tx,tenant,run.id,'Release verified. Lifecycle complete.');}});}
    // Incident issue creation is reconciled by a marker; policy still applies after the run completes.
    const incident=await engine.db.tenant(tenant,tx=>one(tx,'SELECT * FROM incidents WHERE release_id=$1 AND external_issue IS NULL',[release.id]));
    if(incident&&!policyDenial(p,'issue')){try{const gh=await engine.connect(tenant,p.repo),marker=`Lifecycle incident: ${incident.id}`;const existing=(await gh.paginate('/issues?state=all')).find((x:any)=>x.body?.includes(marker));const issue=existing??await gh.createIssue(`Health incident: ${p.name}`,`${marker}\n\nRelease ${release.sha}: three health checks failed.`);await engine.db.tenant(tenant,tx=>tx.query('UPDATE incidents SET external_issue=$2 WHERE id=$1',[incident.id,issue.number]));}catch{ /* retry via reconciliation next check */ }}
  }
}
async function rollback(engine:Engine,run:Run,p:Project,release:any){try{
  await engine.permitted(run,'rollback');if(!release.previous_sha)throw new Error('No previous healthy release is recorded; manual recovery required');
  const gh=await engine.connect(run.tenant_id,p.repo),key=`lifecycle-${run.id}-rollback`,inputs={lifecycle_run_id:key,sha:release.previous_sha,environment:p.config.environment};
  await engine.effect(run,'rollback','rollback',inputs,async()=>{await gh.dispatch(p.config.rollbackWorkflow,p.config.baseBranch,inputs);return {dispatched:true};},async()=>await gh.findWorkflowRun(p.config.rollbackWorkflow,key));
  const workflow=await gh.findWorkflowRun(p.config.rollbackWorkflow,key);if(!workflow||workflow.status!=='completed')return;if(workflow.conclusion!=='success')throw new Error('Rollback workflow failed');
  await engine.db.tenant(run.tenant_id,async tx=>{await tx.query("UPDATE releases SET status='rolled_back' WHERE id=$1",[release.id]);await tx.query("UPDATE runs SET status='rolled_back' WHERE id=$1",[run.id]);await tx.query("UPDATE releases SET status='healthy',next_check=now(),failures=0 WHERE project_id=$1 AND sha=$2 AND status='superseded'",[p.id,release.previous_sha]);await event(tx,run.tenant_id,run.id,'rolled_back',{sha:release.previous_sha});await notify(tx,run.tenant_id,run.id,'Rollback workflow completed; incident remains open for review');});
}catch(e){await engine.db.tenant(run.tenant_id,async tx=>{await tx.query("UPDATE releases SET status='recovery_failed' WHERE id=$1",[release.id]);await pause(tx,run,e instanceof Error?e.message:'Recovery failed');});}}
