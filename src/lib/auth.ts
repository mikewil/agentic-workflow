import type {Database} from './db';
import {one} from './db';
import {hash,HttpError,token} from './security';
import type {Actor,Role} from './types';
import {id} from './service';
export function cookie(req:Request,name:string){return req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
export async function user(database:Database,req:Request){const value=cookie(req,'lifecycle_session');if(!value)throw new HttpError(401,'Sign in required');const u=await one(database,'SELECT u.id,u.login,u.avatar FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(value)]);if(!u)throw new HttpError(401,'Session expired');return u;}
export async function actor(database:Database,req:Request,tenant:string):Promise<Actor>{const u=await user(database,req);return database.tenant(tenant,async tx=>{const m=await one<{role:Role}>(tx,'SELECT role FROM memberships WHERE user_id=$1',[u.id]);if(!m)throw new HttpError(403,'Organization access denied');return {userId:u.id,tenantId:tenant,role:m.role};});}
function setCookie(name:string,value:string,maxAge:number){return `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${process.env.APP_URL?.startsWith('https:')?'; Secure':''}`;}
export async function authRoute(database:Database,req:Request,action:string){
  const base=process.env.APP_URL??'http://localhost:3000';
  if(action==='login'){
    if(!process.env.GITHUB_CLIENT_ID)throw new HttpError(503,'GitHub sign-in is not configured');
    const state=token();await database.query("INSERT INTO oauth_states(token_hash,expires_at) VALUES($1,now()+interval '10 minutes')",[hash(state)]);
    const url=new URL('https://github.com/login/oauth/authorize');url.searchParams.set('client_id',process.env.GITHUB_CLIENT_ID);url.searchParams.set('redirect_uri',`${base}/api/auth/callback`);url.searchParams.set('state',state);
    return new Response(null,{status:302,headers:{Location:url.toString(),'Set-Cookie':setCookie('lifecycle_oauth',state,600)}});
  }
  if(action==='callback'){
    const url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
    if(!state||!code||cookie(req,'lifecycle_oauth')!==state)throw new HttpError(400,'Invalid OAuth state');
    const valid=await one(database,'DELETE FROM oauth_states WHERE token_hash=$1 AND expires_at>now() RETURNING token_hash',[hash(state)]);if(!valid)throw new HttpError(400,'OAuth state expired');
    const res=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code,redirect_uri:`${base}/api/auth/callback`}),signal:AbortSignal.timeout(15000)});
    const credentials=await res.json();if(!res.ok||!credentials.access_token)throw new HttpError(401,'GitHub authorization failed');
    const profileRes=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${credentials.access_token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});if(!profileRes.ok)throw new HttpError(401,'Unable to verify GitHub identity');const profile=await profileRes.json();
    const u=(await one(database,'INSERT INTO users(id,github_id,login,avatar) VALUES($1,$2,$3,$4) ON CONFLICT(github_id) DO UPDATE SET login=EXCLUDED.login,avatar=EXCLUDED.avatar RETURNING id',[id(),String(profile.id),profile.login,profile.avatar_url]))!;
    await database.query('SELECT accept_invitations($1,$2)',[u.id,profile.login]);
    const session=token();await database.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[hash(session),u.id]);
    const headers=new Headers({Location:base});headers.append('Set-Cookie',setCookie('lifecycle_session',session,604800));headers.append('Set-Cookie',setCookie('lifecycle_oauth','',0));return new Response(null,{status:302,headers});
  }
  if(action==='logout'){await database.query('DELETE FROM sessions WHERE token_hash=$1',[hash(cookie(req,'lifecycle_session')??'')]);return Response.json({ok:true},{headers:{'Set-Cookie':setCookie('lifecycle_session','',0)}});}
  throw new HttpError(404,'Unknown authentication route');
}
