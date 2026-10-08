import {z} from 'zod';
import type {Database} from './db';
import {one} from './db';
import {actor,authRoute,user} from './auth';
import {authorize,decrypt,encrypt,hash,HttpError,sameOrigin,token,verifyGitHub,policyDenial} from './security';
import {control,event,getProject,getRun,github,id,ingestIssue} from './service';
import {policySchema,projectConfigSchema} from './types';
import {runnerRoute} from './runner-api';
const json=(x:unknown,status=200)=>Response.json(x,{status,headers:{'Cache-Control':'no-store'}});
const uuid=z.uuid();
export async function handle(database:Database,req:Request,path:string[]):Promise<Response>{try{
  const method=req.method;
  if(path[0]==='health')return json({service:'agentic-lifecycle',status:'ok'});
  if(path[0]==='auth'){if(path[1]==='logout'){if(method!=='POST')throw new HttpError(405,'POST required');sameOrigin(req);}return authRoute(database,req,path[1]);}
  if(path[0]==='runner'){if(method!=='POST')throw new HttpError(405,'POST required');return json(await runnerRoute(database,req,path.slice(1)));}
  if(path[0]==='webhooks'&&path[1]==='github'){
    if(method!=='POST')throw new HttpError(405,'POST required');const tenant=uuid.parse(path[2]);
    const raw=await req.text();if(raw.length>2_000_000)throw new HttpError(413,'Payload too large');const delivery=req.headers.get('x-github-delivery');if(!delivery)throw new HttpError(400,'Delivery ID required');
    return database.tenant(tenant,async tx=>{const i=await one(tx,"SELECT * FROM integrations WHERE provider='github'");if(!i)throw new HttpError(404,'Connection not found');const secret=decrypt<any>(i.encrypted_secret,tenant);if(!verifyGitHub(raw,req.headers.get('x-hub-signature-256'),secret.webhookSecret))throw new HttpError(401,'Invalid webhook signature');const payload=JSON.parse(raw);if(payload.installation&&String(payload.installation.id)!==String(i.config.installationId))throw new HttpError(403,'Installation mismatch');await tx.query('INSERT INTO inbox(id,tenant_id,provider,delivery_id,payload) VALUES($1,$2,\'github\',$3,$4) ON CONFLICT DO NOTHING',[id(),tenant,delivery,JSON.stringify(payload)]);return json({accepted:true},202);});
  }
  if(path[0]==='me'){const u=await user(database,req);return json({user:u,tenants:(await database.query('SELECT * FROM user_tenants($1)',[u.id])).rows});}
  if(path[0]!=='tenants')throw new HttpError(404,'Not found');
  const tenant=uuid.parse(path[1]),a=await actor(database,req,tenant),resource=path[2];
  if(method!=='GET'){sameOrigin(req);authorize(a,['runs','requests','slack-link'].includes(resource)?'operate':'admin');}
  if(resource==='events'){
    const runId=uuid.parse(new URL(req.url).searchParams.get('run'));await database.tenant(tenant,tx=>getRun(tx,runId));let after=Number(req.headers.get('last-event-id')??new URL(req.url).searchParams.get('after')??0)||0;
    const encoder=new TextEncoder();const stream=new ReadableStream({async start(controller){try{for(let tick=0;tick<25&&!req.signal.aborted;tick++){await actor(database,req,tenant);const events=await database.tenant(tenant,tx=>tx.query('SELECT * FROM events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 100',[runId,after]));for(const e of events.rows){after=Number(e.id);controller.enqueue(encoder.encode(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));}controller.enqueue(encoder.encode(': heartbeat\n\n'));await new Promise(r=>setTimeout(r,1000));}}catch{ /* closed or access revoked */ }finally{try{controller.close();}catch{}}}});return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
  }
  if(resource==='requests'&&method==='POST'){
    const b=z.object({projectId:uuid,title:z.string().min(1).max(200),body:z.string().max(50000).default(''),ready:z.boolean().default(false)}).parse(await req.json());
    const p=await database.tenant(tenant,tx=>getProject(tx,b.projectId));const denial=policyDenial(p,'issue');if(denial)throw new HttpError(409,denial);const gh=await github(database,tenant,p.repo);const issue=await gh.createIssue(b.title,b.body);if(b.ready)await gh.markReady(issue.number);const refreshed=await gh.getIssue(issue.number);await database.tenant(tenant,tx=>ingestIssue(tx,tenant,p,refreshed));return json({number:issue.number,url:issue.html_url},201);
  }
  if(resource==='projects'&&path[4]==='diagnostics'){
    authorize(a,'admin');const p=await database.tenant(tenant,tx=>getProject(tx,uuid.parse(path[3]))),gh=await github(database,tenant,p.repo);
    const [repo,deploy,rollback]=await Promise.all([gh.request(gh.path('')),gh.request(gh.path(`/actions/workflows/${encodeURIComponent(p.config.deployWorkflow)}`)),gh.request(gh.path(`/actions/workflows/${encodeURIComponent(p.config.rollbackWorkflow)}`))]);return json({repository:repo.full_name,defaultBranch:repo.default_branch,deploy:deploy.state,rollback:rollback.state});
  }
  if(resource==='runs'&&path[4]&&method==='POST'){const action=z.enum(['cancel','resume','answer','message']).parse(path[4]);const b=z.object({text:z.string().max(50000).optional()}).parse(await req.json());return json(await control(database,a,uuid.parse(path[3]),action,b.text));}
  return await database.tenant(tenant,async tx=>{
    if(resource==='dashboard'&&method==='GET'){
      const [t,projects,runs,runners,incidents]=await Promise.all([one(tx,'SELECT * FROM tenants WHERE id=$1',[tenant]),tx.query('SELECT * FROM projects ORDER BY name'),tx.query('SELECT r.*,w.title,w.external_id,p.name project_name FROM runs r JOIN work_items w ON w.id=r.work_item_id JOIN projects p ON p.id=r.project_id ORDER BY r.created_at DESC LIMIT 100'),tx.query('SELECT id,name,last_seen,revoked FROM runners ORDER BY name'),tx.query('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 30')]);return json({tenant:t,role:a.role,projects:projects.rows,runs:runs.rows,runners:runners.rows,incidents:incidents.rows});
    }
    if(resource==='branding'&&method==='PUT'){const b=z.object({name:z.string().min(1).max(100),logo:z.union([z.literal(''),z.url().refine(x=>x.startsWith('https://'))]),primary:z.string().regex(/^#[0-9a-fA-F]{6}$/),accent:z.string().regex(/^#[0-9a-fA-F]{6}$/),theme:z.enum(['light','dark'])}).parse(await req.json());await tx.query('UPDATE tenants SET name=$2,branding=$3 WHERE id=$1',[tenant,b.name,JSON.stringify(b)]);return json({ok:true});}
    if(resource==='projects'&&(method==='POST'||method==='PUT')){
      const b=z.object({name:z.string().min(1).max(100),repo:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),config:projectConfigSchema,policy:policySchema}).parse(await req.json());const projectId=method==='PUT'?uuid.parse(path[3]):id();if(method==='PUT')await getProject(tx,projectId);
      await tx.query(`INSERT INTO projects(id,tenant_id,name,repo,config,policy) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,repo=EXCLUDED.repo,config=EXCLUDED.config,policy=EXCLUDED.policy,policy_version=projects.policy_version+1`,[projectId,tenant,b.name,b.repo,JSON.stringify(b.config),JSON.stringify(b.policy)]);return json({id:projectId},method==='POST'?201:200);
    }
    if(resource==='integrations'){
      authorize(a,'admin');if(method==='GET')return json((await tx.query('SELECT id,provider,config,updated_at FROM integrations')).rows);
      if(method==='PUT'){const b=z.discriminatedUnion('provider',[
        z.object({provider:z.literal('github'),config:z.object({appId:z.string().regex(/^\d+$/),installationId:z.string().regex(/^\d+$/)}),secret:z.object({privateKey:z.string().min(100),webhookSecret:z.string().min(20)})}),
        z.object({provider:z.literal('slack'),config:z.object({workspaceId:z.string().min(1)}),secret:z.object({botToken:z.string().startsWith('xoxb-'),appToken:z.string().startsWith('xapp-')})})]).parse(await req.json());await tx.query('INSERT INTO integrations(id,tenant_id,provider,config,encrypted_secret) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,provider) DO UPDATE SET config=EXCLUDED.config,encrypted_secret=EXCLUDED.encrypted_secret,updated_at=now()',[id(),tenant,b.provider,JSON.stringify(b.config),encrypt(b.secret,tenant)]);return json({ok:true});}
    }
    if(resource==='members'){
      authorize(a,'admin');if(method==='GET')return json({members:(await tx.query('SELECT m.user_id,m.role,u.login FROM memberships m JOIN users u ON u.id=m.user_id')).rows,invitations:(await tx.query('SELECT id,github_login,role,expires_at FROM invitations')).rows});
      if(method==='POST'){const b=z.object({login:z.string().regex(/^[A-Za-z0-9-]{1,39}$/),role:z.enum(['admin','operator','viewer'])}).parse(await req.json());await tx.query("INSERT INTO invitations(id,tenant_id,github_login,role,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') ON CONFLICT(tenant_id,github_login) DO UPDATE SET role=EXCLUDED.role,expires_at=EXCLUDED.expires_at",[id(),tenant,b.login.toLowerCase(),b.role]);return json({ok:true});}
      if(method==='DELETE'){const uid=uuid.parse(path[3]);if(uid===a.userId)throw new HttpError(409,'Cannot revoke your own membership');await tx.query('DELETE FROM memberships WHERE user_id=$1',[uid]);return json({ok:true});}
      if(method==='PUT'){const uid=uuid.parse(path[3]),b=z.object({role:z.enum(['admin','operator','viewer'])}).parse(await req.json());if(uid===a.userId)throw new HttpError(409,'Cannot change your own role');await tx.query('UPDATE memberships SET role=$2 WHERE user_id=$1',[uid,b.role]);return json({ok:true});}
    }
    if(resource==='runners'){
      authorize(a,'admin');if(method==='POST'){const b=z.object({name:z.string().min(1).max(100)}).parse(await req.json()),secret=token(),runnerId=id();await tx.query('INSERT INTO runners(id,tenant_id,name,token_hash) VALUES($1,$2,$3,$4)',[runnerId,tenant,b.name,hash(secret)]);return json({id:runnerId,token:secret},201);}
      if(method==='DELETE'){await tx.query('UPDATE runners SET revoked=true WHERE id=$1',[uuid.parse(path[3])]);return json({ok:true});}
    }
    if(resource==='runs'&&method==='GET'){
      const run=await getRun(tx,uuid.parse(path[3]));const [events,results,artifacts,questions,effects]=await Promise.all([tx.query('SELECT * FROM events WHERE run_id=$1 ORDER BY id DESC LIMIT 200',[run.id]),tx.query('SELECT * FROM stage_results WHERE run_id=$1 ORDER BY created_at',[run.id]),tx.query('SELECT id,name,media_type,created_at FROM artifacts WHERE run_id=$1',[run.id]),tx.query('SELECT * FROM questions WHERE run_id=$1 ORDER BY created_at',[run.id]),tx.query('SELECT id,key,kind,status,result FROM effects WHERE run_id=$1',[run.id])]);return json({run,events:events.rows.reverse(),results:results.rows,artifacts:artifacts.rows,questions:questions.rows,effects:effects.rows});
    }
    if(resource==='artifacts'&&method==='GET'){const artifact=await one(tx,'SELECT * FROM artifacts WHERE id=$1',[uuid.parse(path[3])]);if(!artifact)throw new HttpError(404,'Artifact not found');return new Response(artifact.media_type==='image/png'?Buffer.from(artifact.content,'base64'):artifact.content,{headers:{'Content-Type':artifact.media_type,'Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
    if(resource==='slack-link'&&method==='POST'){const b=z.object({nonce:z.string().min(20)}).parse(await req.json());const link=await one(tx,'DELETE FROM link_nonces WHERE token_hash=$1 AND expires_at>now() RETURNING *',[hash(b.nonce)]);if(!link)throw new HttpError(400,'Link expired or belongs to another organization');await tx.query('INSERT INTO slack_links(tenant_id,workspace_id,slack_user_id,user_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,workspace_id,slack_user_id) DO UPDATE SET user_id=EXCLUDED.user_id',[tenant,link.workspace_id,link.slack_user_id,a.userId]);return json({ok:true});}
    throw new HttpError(404,'Not found');
  });
}catch(e){if(e instanceof HttpError)return json({error:e.message},e.status);if(e instanceof z.ZodError)return json({error:'Invalid input',details:e.issues.map(i=>({path:i.path,message:i.message}))},400);console.error('API failure',e instanceof Error?e.message:'unknown');return json({error:'Request failed; inspect server diagnostics'},500);}}
