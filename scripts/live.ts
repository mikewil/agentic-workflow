import {db,closeDB} from '../src/lib/db';
import {getProject,github,ingestIssue} from '../src/lib/service';
import {one} from '../src/lib/db';
if(process.env.LIVE_ACCEPT_EXTERNAL_WRITES!=='yes')throw new Error('Opt-in required: LIVE_ACCEPT_EXTERNAL_WRITES=yes. This creates a GitHub issue and may merge/deploy through the configured policy.');
const tenant=process.env.LIVE_TENANT_ID,projectId=process.env.LIVE_PROJECT_ID;
if(!tenant||!projectId)throw new Error('LIVE_TENANT_ID and LIVE_PROJECT_ID are required');
try{
  const p=await db.tenant(tenant,tx=>getProject(tx,projectId)),gh=await github(db,tenant,p.repo);
  const issue=await gh.createIssue(`Lifecycle acceptance ${new Date().toISOString()}`,process.env.LIVE_REQUEST??'Add a small accessible release information section to the reference homepage. Keep existing functionality. Include meaningful automated tests and desktop/mobile browser evidence.');
  await gh.markReady(issue.number);await db.tenant(tenant,tx=>ingestIssue(tx,tenant,p,{...issue,labels:[{name:'agent:ready'}]}));
  console.log(`Created ${issue.html_url}. Waiting for the configured worker and runner.`);
  const deadline=Date.now()+45*60000;let last='';
  while(Date.now()<deadline){const run=await db.tenant(tenant,tx=>one(tx,'SELECT r.* FROM runs r JOIN work_items w ON w.id=r.work_item_id WHERE w.project_id=$1 AND w.external_id=$2 ORDER BY r.created_at DESC LIMIT 1',[projectId,issue.number]));if(run){const state=`${run.id}: ${run.stage}/${run.status}`;if(state!==last){console.log(state);last=state;}
    if(run.status==='succeeded'){const evidence=await db.tenant(tenant,tx=>tx.query('SELECT name FROM artifacts WHERE run_id=$1',[run.id]));if(!evidence.rows.length)throw new Error('Run succeeded without persisted evidence');console.log('LIVE ACCEPTANCE PASSED: issue → validated merge → deployment → five-minute verification');break;}
    if(['waiting','paused'].includes(run.status))throw new Error(`Run requires operator input: ${process.env.APP_URL}/?tenant=${tenant}&run=${run.id}`);
    if(['failed','cancelled','rolled_back'].includes(run.status))throw new Error(`Run ended as ${run.status}`);
  }await new Promise(r=>setTimeout(r,10000));if(Date.now()>=deadline)throw new Error('Acceptance timed out; inspect the run before retrying');}
}finally{await closeDB();}
