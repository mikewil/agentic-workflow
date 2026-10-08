import {App} from '@slack/bolt';
import type {Database} from '../lib/db';
import {one} from '../lib/db';
import {authorize,decrypt,hash,policyDenial,token} from '../lib/security';
import {control,getRun,github,id,ingestIssue} from '../lib/service';
import type {Actor,Project,Role} from '../lib/types';
export class SlackConnections {
  private apps=new Map<string,{app:App;updated:string;workspace:string}>();
  constructor(private db:Database){}
  async refresh(tenant:string){
    const i=await this.db.tenant(tenant,tx=>one(tx,"SELECT * FROM integrations WHERE provider='slack'"));if(!i)return;
    const current=this.apps.get(tenant);if(current?.updated===String(i.updated_at))return;
    if(current)await current.app.stop();const secret=decrypt<any>(i.encrypted_secret,tenant);
    const app=new App({token:secret.botToken,appToken:secret.appToken,socketMode:true});
    const enqueue=async(delivery:string,payload:unknown)=>this.db.tenant(tenant,tx=>tx.query("INSERT INTO inbox(id,tenant_id,provider,delivery_id,payload) VALUES($1,$2,'slack',$3,$4) ON CONFLICT DO NOTHING",[id(),tenant,delivery,JSON.stringify(payload)]));
    app.command('/lifecycle',async({command,ack})=>{await enqueue(command.trigger_id,{workspace:command.team_id,user:command.user_id,channel:command.channel_id,text:command.text});await ack('Request received.');});
    app.event('app_mention',async({event,body})=>{const e=event as any;await enqueue((body as any).event_id,{workspace:(body as any).team_id,user:e.user,channel:e.channel,text:e.text.replace(/<@[A-Z0-9]+>/g,'').trim(),thread:e.thread_ts??e.ts});});
    await app.start();this.apps.set(tenant,{app,updated:String(i.updated_at),workspace:i.config.workspaceId});
  }
  async drain(tenant:string){const connection=this.apps.get(tenant);if(!connection)return;
    const entries=await this.db.tenant(tenant,tx=>tx.query("SELECT * FROM inbox WHERE provider='slack' AND processed_at IS NULL ORDER BY created_at LIMIT 20"));
    for(const entry of entries.rows){const e=entry.payload;try{
      if(e.workspace!==connection.workspace)throw new Error('Workspace mismatch');
      const linked=await this.db.tenant(tenant,tx=>one(tx,'SELECT l.user_id,m.role FROM slack_links l JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id WHERE l.workspace_id=$1 AND l.slack_user_id=$2',[e.workspace,e.user]));
      if(!linked){const nonce=token();await this.db.tenant(tenant,tx=>tx.query("INSERT INTO link_nonces(token_hash,tenant_id,workspace_id,slack_user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",[hash(nonce),tenant,e.workspace,e.user]));await connection.app.client.chat.postEphemeral({channel:e.channel,user:e.user,text:`Link your account: ${process.env.APP_URL}/?tenant=${tenant}&link=${nonce}`});}
      else {const actor:Actor={userId:linked.user_id,tenantId:tenant,role:linked.role as Role};authorize(actor,'operate');const text=await this.command(actor,e,entry.delivery_id);await connection.app.client.chat.postMessage({channel:e.channel,thread_ts:e.thread,text});}
    }catch(error){await connection.app.client.chat.postEphemeral({channel:e.channel,user:e.user,text:error instanceof Error?error.message:'Command failed'}).catch(()=>{});}
      await this.db.tenant(tenant,tx=>tx.query('UPDATE inbox SET processed_at=now() WHERE id=$1',[entry.id]));
    }
    const pending=await this.db.tenant(tenant,tx=>tx.query('SELECT * FROM notifications WHERE sent_at IS NULL ORDER BY id LIMIT 30'));
    for(const n of pending.rows){const {run,p}=await this.db.tenant(tenant,async tx=>{const run=await getRun(tx,n.run_id);return {run,p:await one<Project>(tx,'SELECT * FROM projects WHERE id=$1',[run.project_id])};});if(!p?.config.slackChannel)continue;
      const result=await connection.app.client.chat.postMessage({channel:p.config.slackChannel,thread_ts:run.context.slackThread,text:`${n.text}\n${process.env.APP_URL}/?tenant=${tenant}&run=${run.id}`,client_msg_id:n.id} as any);
      await this.db.tenant(tenant,async tx=>{await tx.query('UPDATE notifications SET sent_at=now() WHERE id=$1',[n.id]);if(!run.context.slackThread&&result.ts)await tx.query("UPDATE runs SET context=jsonb_set(context,'{slackThread}',$2::jsonb) WHERE id=$1",[run.id,JSON.stringify(result.ts)]);});
    }
  }
  private async command(actor:Actor,e:any,delivery:string){
    const [command,...args]=String(e.text).split(/\s+/),argument=args[0],rest=args.slice(1).join(' ');
    if(['cancel','resume','answer','message'].includes(command)){const run=await this.db.tenant(actor.tenantId,tx=>getRun(tx,argument));const project=await this.db.tenant(actor.tenantId,tx=>one<Project>(tx,'SELECT * FROM projects WHERE id=$1',[run.project_id]));if(project?.config.slackChannel!==e.channel)throw new Error('Use the project’s configured channel');await control(this.db,actor,argument,command as any,rest);return `${command} recorded for ${argument}`;}
    if(command==='request'||command==='start'){
      const p=await this.db.tenant(actor.tenantId,tx=>one<Project>(tx,"SELECT * FROM projects WHERE config->>'slackChannel'=$1",[e.channel]));if(!p)throw new Error('No project is configured for this channel');const deny=policyDenial(p,'issue');if(deny)throw new Error(deny);const gh=await github(this.db,actor.tenantId,p.repo);
      let issue:any;
      if(command==='request'){const [title,...body]=args.join(' ').split('|');if(!title?.trim())throw new Error('Usage: request Title | description');const marker=`Slack request: ${delivery}`;issue=(await gh.paginate('/issues?state=all')).find((x:any)=>x.body?.includes(marker))??await gh.createIssue(title.trim(),`${body.join('|').trim()}\n\n${marker}`);}
      else {const number=Number(argument?.replace('#',''));if(!Number.isInteger(number)||number<1)throw new Error('Usage: start #issue-number');await gh.markReady(number);issue=await gh.getIssue(number);}
      await this.db.tenant(actor.tenantId,tx=>ingestIssue(tx,actor.tenantId,p,issue,true,command==='start'));return `${command==='request'?'Created':'Queued'} #${issue.number}: ${issue.html_url}`;
    }
    return 'Commands: request Title | description · start #issue · cancel RUN_ID · resume RUN_ID · answer RUN_ID response · message RUN_ID note';
  }
  async stop(){await Promise.all([...this.apps.values()].map(c=>c.app.stop()));}
}
