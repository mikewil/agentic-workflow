import pg from 'pg';
export interface DB {query<T extends Record<string,any> = any>(sql:string,params?:any[]):Promise<{rows:T[];rowCount?:number|null}>;}
export interface Database extends DB {tenant<T>(id:string,fn:(tx:DB)=>Promise<T>):Promise<T>;}
let pool:pg.Pool|undefined;
function connection(){ return pool ??= new pg.Pool({connectionString:process.env.DATABASE_URL,max:12}); }
export const db:Database = {
  async query(sql,params){return connection().query(sql,params);},
  async tenant(id,fn){
    if(!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid tenant');
    const client=await connection().connect();
    try {await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[id]);const value=await fn(client);await client.query('COMMIT');return value;}
    catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
  },
};
export async function one<T extends Record<string,any>>(tx:DB,sql:string,params:any[]=[]):Promise<T|undefined>{return (await tx.query<T>(sql,params)).rows[0];}
export async function closeDB(){await pool?.end();pool=undefined;}
