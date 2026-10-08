import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Lifecycle · Agentic engineering',description:'An observable, policy-governed software lifecycle.'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
