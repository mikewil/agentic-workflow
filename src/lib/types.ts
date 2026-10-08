import { z } from 'zod';
export const stages = ['discovery','requirements','design','engineering','testing','merge','deployment','verification'] as const;
export type Stage = typeof stages[number];
export type Role = 'admin'|'operator'|'viewer';
export type Action = 'read'|'operate'|'admin';
export type Status = 'queued'|'running'|'waiting'|'paused'|'succeeded'|'failed'|'cancelled'|'rolled_back';
export const terminal = new Set<Status>(['succeeded','failed','cancelled','rolled_back']);
export const policySchema = z.object({
  actions: z.array(z.enum(['agent','push','merge','deploy','rollback','issue'])).default([]),
  branches: z.array(z.string().min(1)).default([]), environments: z.array(z.string()).default([]),
  requiredChecks: z.array(z.string().min(1)).default([]), maxActiveMinutes: z.number().int().min(1).max(240).default(60),
  maxRepairs: z.number().int().min(0).max(10).default(2),
});
export type Policy = z.infer<typeof policySchema>;
export const projectConfigSchema = z.object({
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default('main'),
  environment: z.string().min(1), deployWorkflow: z.string().regex(/^[\w.-]+\.ya?ml$/), rollbackWorkflow: z.string().regex(/^[\w.-]+\.ya?ml$/),
  healthUrl: z.url().refine(v=>v.startsWith('https://') || v.startsWith('http://'),'HTTP(S) required'),
  setupCommand: z.string().max(2000).default('npm ci'), testCommand: z.string().min(1).max(2000),
  buildCommand: z.string().max(2000).default('npm run build'), ui: z.boolean().default(true),
  browserCommand: z.string().max(2000).default('npm run test:ui'), slackChannel: z.string().default(''),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export interface Project {id:string;tenant_id:string;name:string;repo:string;config:ProjectConfig;policy:Policy;policy_version:number;}
export interface Run {id:string;tenant_id:string;project_id:string;work_item_id:string;status:Status;stage:Stage;policy_version:number;policy_snapshot:Policy;context:Record<string,any>;active_ms:number;repairs:number;cancellation_requested:boolean;}
export interface WorkItem {id:string;external_id:number;title:string;body:string;}
export interface Job {id:string;run_id:string;tenant_id:string;stage:Stage;kind:string;lease_token:string;payload:Record<string,any>;}
export const resultSchema = z.object({
  summary:z.string().min(1).max(50000), question:z.string().nullable(), uiRelevant:z.boolean(),
  suggestions:z.array(z.string()), details:z.string(),
});
export type AgentResult = z.infer<typeof resultSchema>;
export interface StageResult extends AgentResult {sessionId?:string;sha?:string;baseSha?:string;usage?:Record<string,number>;validation?:{passed:boolean;commands:string[];commit:string};artifacts?:{name:string;mediaType:string;content:string}[];}
export interface AgentInput {runId:string;stage:Stage;prompt:string;workspace:string;sessionId?:string;signal:AbortSignal;}
export interface AgentEvent {type:string;data:Record<string,unknown>;}
export interface AgentAdapter {capabilities:{streaming:boolean;cancellation:boolean;resume:boolean;structuredOutput:boolean};execute(input:AgentInput,onEvent:(event:AgentEvent)=>Promise<void>):Promise<StageResult>;}
export interface BacklogAdapter {getIssue(number:number):Promise<any>;listReady():Promise<any[]>;createIssue(title:string,body:string):Promise<any>;markReady(number:number):Promise<void>;}
export interface SourceAdapter {branchSha(branch:string):Promise<string>;ensurePR(branch:string,base:string,title:string,body:string):Promise<any>;checks(sha:string):Promise<{name:string;passed:boolean}[]>;merge(number:number,sha:string):Promise<any>;}
export interface DeploymentAdapter {dispatch(workflow:string,ref:string,inputs:Record<string,string>):Promise<void>;findWorkflowRun(workflow:string,key:string):Promise<any|null>;}
export interface MessagingAdapter {post(channel:string,text:string,thread?:string):Promise<string>;}
export interface MonitoringAdapter {check(url:string):Promise<boolean>;}
export interface Tenant {id:string;slug:string;name:string;branding:Record<string,string>;role:Role;}
export interface Actor {userId:string;tenantId:string;role:Role;}
