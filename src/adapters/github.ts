import {createSign} from 'node:crypto';
import type {BacklogAdapter,SourceAdapter,DeploymentAdapter} from '../lib/types';
export class GitHub implements BacklogAdapter,SourceAdapter,DeploymentAdapter {
  private cached?:{token:string;expires:number};
  constructor(public repo:string,private config:{appId:string;installationId:string;privateKey:string},private fetcher:typeof fetch=fetch){}
  private async installationToken(){
    if(this.cached&&this.cached.expires>Date.now()+60000)return this.cached.token;
    const enc=(x:object)=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const now=Math.floor(Date.now()/1000),payload=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iat:now-60,exp:now+540,iss:this.config.appId});
    const sign=createSign('RSA-SHA256');sign.update(payload);const jwt=payload+'.'+sign.sign(this.config.privateKey,'base64url');
    const response=await this.fetcher(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`GitHub installation authentication failed (${response.status})`);
    const data=await response.json();this.cached={token:data.token,expires:Date.parse(data.expires_at)};return data.token as string;
  }
  async request(path:string,method='GET',body?:unknown):Promise<any>{
    const token=await this.installationToken();const response=await this.fetcher(`https://api.github.com${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    if(response.status===401)this.cached=undefined;
    if(!response.ok)throw new Error(`GitHub ${method} ${path.split('?')[0]} failed (${response.status})`);
    return response.status===204?null:response.json();
  }
  path(p:string){return `/repos/${this.repo}${p}`;}
  async getIssue(number:number){return this.request(this.path(`/issues/${number}`));}
  async listReady(){return this.paginate('/issues?state=open&labels=agent%3Aready');}
  async paginate(path:string){const out:any[]=[];for(let page=1;page<=100;page++){const batch=await this.request(this.path(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`));out.push(...batch);if(batch.length<100)return out;}throw new Error('Pagination exceeded 100 pages');}
  async createIssue(title:string,body:string){return this.request(this.path('/issues'),'POST',{title,body});}
  async markReady(number:number){await this.request(this.path(`/issues/${number}/labels`),'POST',{labels:['agent:ready']});}
  async comment(number:number,body:string){return this.request(this.path(`/issues/${number}/comments`),'POST',{body});}
  async branchSha(branch:string){return (await this.request(this.path(`/commits/${encodeURIComponent(branch)}`))).sha as string;}
  async ensurePR(branch:string,base:string,title:string,body:string){
    const prs=await this.request(this.path(`/pulls?state=all&head=${encodeURIComponent(this.repo.split('/')[0]+':'+branch)}`));
    const existing=prs.find((p:any)=>p.base.ref===base);if(existing)return existing;
    return this.request(this.path('/pulls'),'POST',{head:branch,base,title,body});
  }
  async getPR(number:number){return this.request(this.path(`/pulls/${number}`));}
  async checks(sha:string){
    const checks:any[]=[];for(let page=1;page<=100;page++){const c=await this.request(this.path(`/commits/${sha}/check-runs?per_page=100&page=${page}`));checks.push(...c.check_runs);if(c.check_runs.length<100)break;}
    const s=await this.request(this.path(`/commits/${sha}/status`));
    return [...checks.map(c=>({name:c.name,passed:c.status==='completed'&&c.conclusion==='success'})),...s.statuses.map((c:any)=>({name:c.context,passed:c.state==='success'}))];
  }
  async merge(number:number,sha:string){const result=await this.request(this.path(`/pulls/${number}/merge`),'PUT',{sha,merge_method:'squash'});if(!result.merged)throw new Error('GitHub declined merge');return result;}
  async dispatch(workflow:string,ref:string,inputs:Record<string,string>){await this.request(this.path(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`),'POST',{ref,inputs});}
  async findWorkflowRun(workflow:string,key:string){for(let page=1;page<=10;page++){const r=await this.request(this.path(`/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100&page=${page}`));const found=r.workflow_runs.find((x:any)=>x.display_title===key);if(found)return found;if(r.workflow_runs.length<100)break;}return null;}
  async workflowRun(id:number){return this.request(this.path(`/actions/runs/${id}`));}
  async scopedToken(permission:'read'|'write'){
    const auth=await this.installationToken();
    // Exchange again with narrowed repository + permissions; the broad installation token never reaches a runner.
    const enc=(x:object)=>Buffer.from(JSON.stringify(x)).toString('base64url');const now=Math.floor(Date.now()/1000);
    const payload=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iat:now-60,exp:now+540,iss:this.config.appId});const sign=createSign('RSA-SHA256');sign.update(payload);
    void auth;
    const res=await this.fetcher(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,{method:'POST',headers:{Authorization:`Bearer ${payload}.${sign.sign(this.config.privateKey,'base64url')}`,Accept:'application/vnd.github+json'},body:JSON.stringify({repositories:[this.repo.split('/')[1]],permissions:{contents:permission}}),signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw new Error('Unable to issue scoped checkout token');return (await res.json()).token as string;
  }
}
