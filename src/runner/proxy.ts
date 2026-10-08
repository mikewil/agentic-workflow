import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {token} from '../lib/security';
// A per-stage model gateway keeps the provider API key off the agent filesystem and process environment.
export async function modelProxy(){
  if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is required on the runner host');
  const secret=token();const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${secret}`||req.method!=='POST'||!['/v1/responses','/v1/responses/compact'].includes(req.url??'')){res.writeHead(403).end();return;}
    let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>20_000_000){res.writeHead(413).end();return;}chunks.push(chunk);}
    try{const response=await fetch(`https://api.openai.com${req.url}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json',...(req.headers['openai-beta']?{'OpenAI-Beta':String(req.headers['openai-beta'])}:{})},body:Buffer.concat(chunks),signal:AbortSignal.timeout(600000)});res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});if(response.body)Readable.fromWeb(response.body as any).pipe(res);else res.end();}catch{res.writeHead(502).end('Model gateway unavailable');}
  });
  await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));const port=(server.address() as any).port;
  return {token:secret,url:`http://host.docker.internal:${port}/v1`,close:()=>{server.closeAllConnections();server.close();}};
}
