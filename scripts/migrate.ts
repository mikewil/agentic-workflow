import pg from 'pg';
import {readFile} from 'node:fs/promises';
const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
if(!process.env.MIGRATION_DATABASE_URL||!process.env.DATABASE_URL)throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL are required');
await admin.connect();
try{
  await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock(831799)');
  await admin.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)');
  const applied=await admin.query("SELECT version FROM schema_migrations WHERE version='001_initial'");
  if(!applied.rowCount){await admin.query(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));await admin.query("INSERT INTO schema_migrations VALUES('001_initial')");}
  const runtime=new URL(process.env.DATABASE_URL);const username=decodeURIComponent(runtime.username),password=decodeURIComponent(runtime.password);
  if(!/^[a-z_][a-z0-9_]*$/.test(username)||username==='postgres'||password.length<20)throw new Error('Use a separate runtime database role and a password of at least 20 characters');
  if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[username])).rowCount)await admin.query(`CREATE ROLE "${username}" LOGIN PASSWORD '${password.replaceAll("'","''")}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT lifecycle_app TO "${username}"`);await admin.query('COMMIT');console.log('Migration complete; runtime role is non-owner and subject to RLS.');
}catch(e){await admin.query('ROLLBACK');throw e;}finally{await admin.end();}
