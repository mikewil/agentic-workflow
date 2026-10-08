import {db} from '@/lib/db';
import {handle} from '@/lib/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function route(request:Request,{params}:{params:Promise<{path:string[]}>}){return handle(db,request,(await params).path);}
export {route as GET,route as POST,route as PUT,route as DELETE};
