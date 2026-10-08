import {spawn} from 'node:child_process';
export async function command(bin:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;input?:string;onStdout?:(text:string)=>void}={}){
  return new Promise<string>((resolve,reject)=>{let out='',err='';const p=spawn(bin,args,{cwd:options.cwd,env:options.env??process.env,signal:options.signal,stdio:['pipe','pipe','pipe']});p.stdin.end(options.input);p.stdout.on('data',b=>{out=(out+b).slice(-2_000_000);options.onStdout?.(String(b));});p.stderr.on('data',b=>{err=(err+b).slice(-10000);});p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(`${bin} exited ${code}: ${err.slice(-500)}`)));});
}
