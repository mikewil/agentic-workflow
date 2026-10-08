import {db,closeDB} from '../lib/db';
import {Engine} from './engine';
import {monitor} from './monitor';
import {SlackConnections} from './slack';
const engine=new Engine(db),slack=new SlackConnections(db);let stopping=false,lastReconcile=0;
process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);
console.log('Lifecycle worker starting');
while(!stopping){try{
  const tenants=await db.query('SELECT * FROM tenant_directory()');
  for(const t of tenants.rows){
    await engine.tick(t.id);
    if(Date.now()-lastReconcile>30000)await engine.reconcile(t.id);
    await monitor(engine,t.id);
    try{await slack.refresh(t.id);await slack.drain(t.id);}catch(e){console.error('Slack unavailable',t.id,e instanceof Error?e.message:'error');}
  }
  if(Date.now()-lastReconcile>30000)lastReconcile=Date.now();
}catch(e){console.error('Worker iteration failed',e instanceof Error?e.message:'error');}
await new Promise(r=>setTimeout(r,2000));}
await slack.stop();await closeDB();
