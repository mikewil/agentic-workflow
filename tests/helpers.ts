import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import type {Database,DB} from '../src/lib/db';
import {id} from '../src/lib/service';
import {hash} from '../src/lib/security';
export async function setup(){
  const pg=new PGlite();await pg.exec(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
  const a=id(),b=id(),uid=id();await pg.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)',[a,'alpha','Alpha',b,'beta','Beta']);await pg.query('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)',[uid,'123','tester']);await pg.query("INSERT INTO memberships VALUES($1,$2,'admin')",[a,uid]);await pg.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 day')",[hash('session'),uid]);
  const query:DB['query']=async(sql,params)=>{const r=await pg.query<any>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};};
  let tail:Promise<any>=Promise.resolve();
  const exclusive=async<T>(f:()=>Promise<T>)=>{const previous=tail;let unlock!:()=>void;tail=new Promise<void>(r=>unlock=r);await previous;try{return await f();}finally{unlock();}};
  const db:Database={query:async(sql,params)=>exclusive(async()=>{await pg.exec('SET ROLE lifecycle_app');try{return await query(sql,params);}finally{await pg.exec('RESET ROLE');}}),tenant:async(t,f)=>exclusive(async()=>{await pg.exec('BEGIN; SET LOCAL ROLE lifecycle_app;');try{await pg.query("SELECT set_config('app.tenant_id',$1,true)",[t]);const r=await f({query});await pg.exec('COMMIT');return r;}catch(e){await pg.exec('ROLLBACK');throw e;}})};
  return {pg,db,a,b,uid,close:()=>pg.close()};
}
export const config={baseBranch:'main',environment:'staging',deployWorkflow:'deploy.yml',rollbackWorkflow:'rollback.yml',healthUrl:'https://example.com/health',setupCommand:'npm ci',testCommand:'npm test',buildCommand:'npm run build',ui:true,browserCommand:'npm run test:ui',slackChannel:''};
export const policy={actions:['agent','push','merge','deploy','rollback','issue'],branches:['main'],environments:['staging'],requiredChecks:['test'],maxActiveMinutes:60,maxRepairs:2};
export async function project(db:Database,tenant:string){const pid=id();await db.tenant(tenant,tx=>tx.query('INSERT INTO projects(id,tenant_id,name,repo,config,policy) VALUES($1,$2,$3,$4,$5,$6)',[pid,tenant,'Test app','test/app',JSON.stringify(config),JSON.stringify(policy)]));return pid;}
export const request=(path:string,method='GET',body?:unknown)=>new Request(`http://localhost:3000/api/${path}`,{method,headers:{Cookie:'lifecycle_session=session',Origin:'http://localhost:3000','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
