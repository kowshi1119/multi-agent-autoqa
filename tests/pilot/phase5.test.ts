import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { parseProfile, type ProjectProfile } from '../../src/profiles/schema.js';
import { profileToAppConfig } from '../../src/profiles/to-app-config.js';
import { ActionPolicy } from '../../src/safety/action-policy.js';
import { FormLoginBootstrap } from '../../src/auth/session-bootstrap.js';
import { runPipeline } from '../../src/run-pipeline.js';
import { createLogger } from '../../src/logger.js';
import { loadWorkflowStatus, workflowManifestSchema, type WorkflowManifest } from '../../src/pilot/workflow-manifest.js';
import { snapshotManifest, annotateWorkflow, refreshPilotSummary } from '../../src/pilot/workflow-runtime.js';
import { Planner } from '../../src/qa/planner.js';
import { createRunContext } from '../../src/orchestrator/run-context.js';
import type { Observation } from '../../src/types.js';
import { allHeuristics } from '../../src/qa/heuristics.js';

let server: Server; let origin: string; let mutations = 0; let logins = 0;
const temp = () => mkdtempSync(join(tmpdir(), 'autoqa-phase5-'));
beforeAll(async () => {
 server = createServer((req,res) => {
  const url = new URL(req.url!, 'http://localhost');
  if(req.method === 'POST') { if(url.pathname === '/auth') logins++; else mutations++; res.end('{}'); return; }
  res.setHeader('content-type','text/html');
  if(url.pathname === '/login') { res.end(`<form onsubmit="event.preventDefault();fetch('/auth',{method:'POST',body:JSON.stringify({password:document.querySelector('#p').value})}).then(()=>location.href='/home')"><input aria-label="Email"><input id="p" type="password" aria-label="Password"><button>Login</button></form>`); return; }
  res.end(`<h1>Home</h1><button type="button" onclick="history.pushState({},'', '/list');document.querySelector('h1').textContent='Records'">Records</button><input aria-label="Search" oninput="document.querySelector('output').textContent=this.value"><output></output><button type="button" onclick="fetch('/payments',{method:'POST'}).catch(()=>{});document.querySelector('h1').textContent='Blocked'">Unsafe</button><button type="button" onclick="location.href='/login'">Expire</button>`);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{ server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); });
function profile(): ProjectProfile {
 return parseProfile({schemaVersion:1,id:'pilot',name:'Offline pilot',target:{url:origin+'/home',environmentKind:'owned-sandbox'},navigation:{allowedOrigins:[origin],allowedPathPrefixes:['/']},resources:{allowedApiOrigins:[origin],allowedFormSubmitEndpoints:[]},workflows:{allowedWorkflowKinds:['navigate','search'],executionMode:'declared'},auth:{mode:'none'},provider:{explorer:{provider:'mock'},critic:{enabled:true,provider:'mock',requireIndependentProvider:false,maxCallsPerFinding:1},providerTimeoutMs:1000},limits:{maxActions:25,maxPages:5,maxModelCalls:20,maxFindings:5,maxCriticCalls:5,maxDurationMs:180000}});
}
function manifest(): WorkflowManifest {
 return workflowManifestSchema.parse({schemaVersion:1,profileId:'pilot',pages:['/home','/list'],workflows:[{id:'records',page:'/home',description:'Open records',preconditions:'Home',authorizedActions:'Records button',expectedOutcome:'Records visible',execution:{steps:[{pathname:'/home',action:{type:'click',target:{role:'button',name:'Records'}}}],completion:{urlPattern:'/list$',visible:{role:'heading',name:'Records'}}}}]});
}
async function run(p = profile(), m = manifest(), extra: Partial<Parameters<typeof runPipeline>[0]> = {}) {
 const dir=temp(); snapshotManifest(dir,m);
 const config=profileToAppConfig(p);
 const result=await runPipeline({config,runId:'RUN-offline',runDir:dir,logger:createLogger(join(dir,'run.log')),headless:true,actionPolicy:new ActionPolicy(p,m),workflowManifest:m,...extra});
 return {result,dir,status:loadWorkflowStatus(dir)};
}

describe('Phase 5 constrained workflow integration',()=>{
 it('executes declared SPA controls through AutoQA and saves deterministic completion evidence',async()=>{
  const {result,dir,status}=await run();
  expect(status.entries[0]?.status).toBe('completed');
  expect(result.finalCtx.heuristicsExecuted).toBe(0);
  expect(result.finalCtx.recordedSteps).toHaveLength(1);
  expect(result.budget.snapshot().actionOutcomes).toEqual({attempted:2,successful:2,blocked:0,failed:0});
  expect(result.usageTracker.summary().explorer.requests).toBe(0);
  const proof=JSON.parse(readFileSync(join(dir,'workflows/records.json'),'utf8'));
  expect(proof.evidence.assertion).toEqual({passed:true,urlMatched:true,signalVisible:true});
 });
 it('checks the action budget within a multi-action workflow',async()=>{
  const p=profile(); p.limits.maxActions=2;
  const m=manifest(); m.workflows[0]!.execution!.steps=[{pathname:'/home',action:{type:'wait',milliseconds:1}},{pathname:'/home',action:{type:'click',target:{role:'button',name:'Records'}}}];
  const {result,status}=await run(p,m);
  expect(result.budget.actionsPerformed).toBe(2); expect(result.finalCtx.recordedSteps).toHaveLength(1); expect(status.entries[0]?.status).toBe('blocked');
 });
 it('does not repeatedly offer a failed workflow or call it an application defect',async()=>{
  const m=manifest();m.workflows[0]!.execution!.steps[0]!.action={type:'click',target:{role:'button',name:'Missing'}};
  const {result,status}=await run(profile(),m);
  expect(status.entries[0]?.status).toBe('failed');expect(result.finalCtx.recordedSteps).toHaveLength(1);expect(result.finalCtx.findings).toHaveLength(0);expect(result.budget.modelCalls).toBeLessThan(4);
 });
 it('blocks an undeclared mutation at the network boundary and never credits workflow completion',async()=>{
  const before=mutations;const m=manifest();m.workflows[0]!.execution!.steps[0]!.action={type:'click',target:{role:'button',name:'Unsafe'}};m.workflows[0]!.execution!.completion={urlPattern:'/home$',visible:{role:'heading',name:'Blocked'}};
  const {status}=await run(profile(),m);expect(mutations).toBe(before);expect(status.entries[0]?.status).toBe('blocked');
 });
 it('enforces cancellation during a workflow and prevents its next action',async()=>{
  const p=profile(),m=manifest(),controller=new AbortController();m.workflows[0]!.execution!.steps=[{pathname:'/home',action:{type:'wait',milliseconds:10000}},{pathname:'/home',action:{type:'click',target:{role:'button',name:'Records'}}}];
  const start=Date.now();const {result,status}=await run(p,m,{abortSignal:controller.signal,onProgress:e=>{if(e.detail.startsWith('→')) setTimeout(()=>controller.abort(),100);}});
  expect(Date.now()-start).toBeLessThan(7000);expect(result.finalCtx.state).toBe('CANCELLED');expect(result.finalCtx.recordedSteps).toHaveLength(1);expect(status.entries[0]?.status).toBe('blocked');
 });
 it('authenticates through the existing bootstrap, with narrowly scoped POST and no persisted credentials',async()=>{
  const p=profile();p.auth={mode:'form-login',loginUrl:origin+'/login',usernameField:{label:'Email'},passwordField:{label:'Password'},submitControl:{role:'button',name:'Login'},successUrlPattern:'/home$',authenticatedSignal:{role:'heading',name:'Home'},checksVerified:true,allowedRequests:[{method:'POST',origin,pathname:'/auth'}]};
  const before=logins; const secret='fake-transient-phase5-secret';const {result,dir}=await run(p,{...manifest(),workflows:[]},{authenticationOnly:true,sessionAuth:{profile:p,sessionBootstrap:new FormLoginBootstrap(),credentials:{username:'fake-test-user',password:secret}}});
  expect(logins-before).toBe(1);expect(result.finalCtx.state).toBe('COMPLETE');expect(result.finalCtx.recordedSteps).toHaveLength(0);expect(result.budget.snapshot().actionsByPhase?.authentication).toBe(4);expect(result.budget.modelCalls).toBe(0);
  for(const file of ['authentication.json','application-map.json','run.log']) expect(readFileSync(join(dir,file),'utf8')).not.toContain(secret);
  expect(JSON.parse(readFileSync(join(dir,'authentication.json'),'utf8')).status).toBe('success');
 });
 it('fails completion when the action works but its declared visible signal is absent',async()=>{
  const m=manifest();m.workflows[0]!.execution!.completion.visible={role:'heading',name:'Wrong result'};
  const {status,result,dir}=await run(profile(),m);expect(status.entries[0]?.status).toBe('failed');expect(result.finalCtx.findings).toHaveLength(0);
  expect(()=>annotateWorkflow(dir,'records','completed',['workflows/records.json'])).toThrow('has not passed');
 });
 it('stops a long in-flight action at the run deadline even without a user Stop signal',async()=>{
  const p=profile();p.limits.maxDurationMs=1700;const m=manifest();m.workflows[0]!.execution!.steps=[{pathname:'/home',action:{type:'wait',milliseconds:10000}}];
  const started=Date.now();const {result,status}=await run(p,m);expect(Date.now()-started).toBeLessThan(6500);expect(result.finalCtx.stopReason).toContain('maxDurationMs');expect(status.entries[0]?.status).toBe('blocked');
 });
 it('reports session expiry without treating it as an application defect',async()=>{
  const p=profile();p.auth={mode:'form-login',loginUrl:origin+'/login',usernameField:{label:'Email'},passwordField:{label:'Password'},submitControl:{role:'button',name:'Login'},successUrlPattern:'/home$',authenticatedSignal:{role:'heading',name:'Home'},allowedRequests:[{origin,method:'POST',pathname:'/auth'}]};
  const m=manifest();m.workflows[0]!.execution!.steps=[{pathname:'/home',action:{type:'click',target:{role:'button',name:'Expire'}}}];
  const {result,status}=await run(p,m,{sessionAuth:{profile:p,sessionBootstrap:new FormLoginBootstrap(),credentials:{username:'fake',password:'fake'}}});
  expect(result.finalCtx.stopReason).toContain('SESSION_EXPIRED');expect(status.entries[0]?.status).toBe('blocked');expect(result.finalCtx.findings).toHaveLength(0);
 });
 it('rejects a second navigation inside a sequence when its page budget is exhausted',async()=>{
  const p=profile();p.limits.maxPages=2;const m=manifest();m.workflows[0]!.execution!.steps=[{pathname:'/home',action:{type:'navigate',url:origin+'/list'}},{pathname:'/list',action:{type:'navigate',url:origin+'/third'}}];
  const {result,status}=await run(p,m);expect(result.budget.pagesVisited).toBe(2);expect(result.finalCtx.recordedSteps).toHaveLength(1);expect(status.entries[0]?.status).toBe('blocked');
 });
 it('does not invent a failed action when login consumes the last allowed action',async()=>{
  const p=profile();p.limits.maxActions=4;p.auth={mode:'form-login',loginUrl:origin+'/login',usernameField:{label:'Email'},passwordField:{label:'Password'},submitControl:{role:'button',name:'Login'},successUrlPattern:'/home$',authenticatedSignal:{role:'heading',name:'Home'},allowedRequests:[{origin,method:'POST',pathname:'/auth'}]};
  const {result,status}=await run(p,manifest(),{sessionAuth:{profile:p,sessionBootstrap:new FormLoginBootstrap(),credentials:{username:'fake',password:'fake'}}});
  expect(result.budget.snapshot().actionOutcomes).toEqual({attempted:4,successful:4,blocked:0,failed:0});expect(result.finalCtx.stopReason).toContain('BUDGET_EXHAUSTED');expect(status.entries[0]?.status).toBe('blocked');
 });
 it('records unsupported legacy declarations without fabricating execution',async()=>{
  const m=manifest();delete m.workflows[0]!.execution;const {status,result}=await run(profile(),m);expect(status.entries[0]?.status).toBe('unsupported');expect(result.finalCtx.recordedSteps).toHaveLength(0);
 });
 it('refreshes derived coverage without changing assertion evidence or the original summary',async()=>{
  const {dir}=await run();const original=readFileSync(join(dir,'workflows/records.json'),'utf8');const baseline='{"runId":"RUN-offline"}';writeFileSync(join(dir,'pilot-summary.json'),baseline);
  annotateWorkflow(dir,'records','blocked',['workflows/records.json'],'Needs environment review');
  expect(readFileSync(join(dir,'pilot-summary.json'),'utf8')).toBe(baseline);expect(readFileSync(join(dir,'workflows/records.json'),'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(join(dir,'pilot-summary.latest.json'),'utf8')).declaredWorkflows.blocked).toBe(1);
  expect(loadWorkflowStatus(dir).entries[0]?.humanReviewStatus).toBe('not-reviewed');
  expect(()=>annotateWorkflow(dir,'not-declared','completed',[])).toThrow();expect(()=>annotateWorkflow(dir,'records','completed',['../../secret'])).toThrow();expect(()=>annotateWorkflow(dir,'records','completed',[])).toThrow();
  writeFileSync(join(dir,'triage.json'),'{"schemaVersion":1,"labels":[]}');refreshPilotSummary(dir);expect(JSON.parse(readFileSync(join(dir,'pilot-summary.latest.json'),'utf8')).ordinaryTriage).toBeTruthy();
 });
});

describe('Phase 5 policy and schema',()=>{
 it('allows an auth exception only for its exact origin, method, path and lifecycle',()=>{
  const p=profile();p.auth.allowedRequests=[{origin,method:'POST',pathname:'/auth'}];const policy=new ActionPolicy(p);
  expect(policy.classifyResourceRequest('POST','/auth',origin,'fetch',true).decision).toBe('allowed');
  for(const [method,pathname,site,active] of [['POST','/auth',origin,false],['POST','/auth/extra',origin,true],['PUT','/auth',origin,true],['POST','/auth','https://other.test',true]] as const) expect(policy.classifyResourceRequest(method,pathname,site,'fetch',active).decision).toBe('denied');
 });
 it('does not permit undeclared fills, values or a scoped SPA click on another route',()=>{
  const p=profile(),m=manifest(),policy=new ActionPolicy(p,m);expect(policy.classifyAction({type:'fill',target:{label:'Search'},value:'x'},{routePathname:'/home'}).decision).toBe('denied');expect(policy.classifyAction(m.workflows[0]!.execution!.steps[0]!.action,{routePathname:'/other'}).decision).toBe('denied');
 });
 it('rejects duplicate workflow IDs and invalid regex patterns; maps optional requirements and oracle settings',()=>{
  const m=manifest();expect(()=>workflowManifestSchema.parse({...m,workflows:[...m.workflows,...m.workflows]})).toThrow();m.workflows[0]!.execution!.completion.urlPattern='[';expect(()=>workflowManifestSchema.parse(m)).toThrow();
  const p=profile();p.requirements={enabled:false,path:'observed.yaml'};p.oracles=profileToAppConfig(p).oracles;p.oracles.httpFailure.enabled=false;expect(profileToAppConfig(parseProfile(p)).oracles.httpFailure.enabled).toBe(false);expect(profileToAppConfig(p).requirements.path).toBe('observed.yaml');
 });
 it('keeps unique candidate IDs when displayed URLs redact identically, and suppresses an unchanged failure',async()=>{
  const p=profile();delete p.workflows.executionMode;const config=profileToAppConfig(p);const planner=new Planner(allHeuristics(config),config,['secretA','secretB']);
  const observation:Observation={timestamp:'now',page:{url:origin+'/home',pathname:'/home',title:'Home'},viewport:{width:800,height:600},visibleText:'',interactiveElements:[],forms:[],links:[{href:origin+'/records?token=secretA',sameOrigin:true,text:'A'},{href:origin+'/records?token=secretB',sameOrigin:true,text:'B'}],consoleMessages:[],pageErrors:[],networkRequests:[],dialogs:[],stateSignature:'same'};
  const ctx=createRunContext('test',new Date(),origin+'/home'),candidates=await planner.plan(observation,ctx);expect(new Set(candidates.map(c=>c.id)).size).toBe(3);expect(JSON.stringify(candidates.map(c=>c.id))).not.toMatch(/secretA|secretB/);
  planner.markUnsuccessful('same',candidates[0]!);expect((await planner.plan(observation,ctx)).map(c=>c.id)).not.toContain(candidates[0]!.id);
 });
});
