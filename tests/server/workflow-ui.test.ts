import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { startServer } from '../../src/server/app.js';

it('runs a selected workflow through the local UI and validates its outcome annotations',async()=>{
 const target=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Offline home</h1>');});
 await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(target.address() as AddressInfo).port}`;
 const root=mkdtempSync(join(tmpdir(),'autoqa-workflow-ui-'));const profiles=join(root,'profiles'),runs=join(root,'runs');mkdirSync(profiles);
 const profile={schemaVersion:1,id:'pilot',name:'Offline UI pilot',target:{url:origin+'/',environmentKind:'owned-sandbox'},navigation:{allowedOrigins:[origin],allowedPathPrefixes:['/']},resources:{allowedApiOrigins:[origin],allowedFormSubmitEndpoints:[]},workflows:{allowedWorkflowKinds:['navigate'],executionMode:'declared'},auth:{mode:'none'},provider:{explorer:{provider:'mock'},critic:{enabled:true,provider:'mock',requireIndependentProvider:false,maxCallsPerFinding:1},providerTimeoutMs:1000},limits:{maxActions:25,maxPages:5,maxModelCalls:20,maxFindings:5,maxCriticCalls:5,maxDurationMs:180000}};
 writeFileSync(join(profiles,'pilot.json'),JSON.stringify(profile));
 writeFileSync(join(profiles,'pilot.workflows.json'),JSON.stringify({schemaVersion:1,profileId:'pilot',pages:['/'],workflows:[{id:'home',page:'/',description:'View offline home',preconditions:'Home loaded',authorizedActions:'Wait',expectedOutcome:'Home remains visible',execution:{steps:[{pathname:'/',action:{type:'wait',milliseconds:1}}],completion:{urlPattern:'/$',visible:{role:'heading',name:'Offline home'}}}}]}));
 const ui=await startServer({port:0,profilesDir:profiles,runsDir:runs});const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${ui.port}`);await page.selectOption('#profile-select','pilot');
  await page.locator('#workflow-ids').fill('home');await page.getByRole('button',{name:'Start',exact:true}).click();
  await page.getByRole('heading',{name:'home: View offline home'}).waitFor({timeout:20000});
  expect(await page.getByLabel('Outcome for home').inputValue()).toBe('completed');
  await page.getByLabel('Outcome for home').selectOption('blocked');await page.getByLabel('Notes for home').fill('Human annotation, not independent verification');await page.getByRole('button',{name:'Save annotation'}).click();
  await page.getByText('Annotation saved; derived summary refreshed. Original runner evidence preserved.').waitFor();
  const summaries=await (await fetch(`http://127.0.0.1:${ui.port}/api/runs`)).json() as {runs:{runId:string}[]}; const id=summaries.runs[0]!.runId;
  const original=JSON.parse(readFileSync(join(runs,id,'workflows/home.json'),'utf8'));expect(original.status).toBe('completed');
  const derived=JSON.parse(readFileSync(join(runs,id,'pilot-summary.latest.json'),'utf8'));expect(derived.declaredWorkflows.blocked).toBe(1);
  const base=`http://127.0.0.1:${ui.port}/api/runs/${id}/workflows`;
  const send=(body:unknown,csrf=true)=>fetch(base,{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-csrf-token':ui.csrfToken}:{})},body:JSON.stringify(body)});
  expect((await send({workflowId:'home',status:'completed',evidenceRefs:[]},false)).status).toBe(403);
  expect((await send({workflowId:'unknown',status:'blocked',evidenceRefs:[]})).status).toBe(400);
  expect((await send({workflowId:'home',status:'invented',evidenceRefs:[]})).status).toBe(400);
  expect((await send({workflowId:'home',status:'completed',evidenceRefs:['../../outside.json']})).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:${ui.port}/api/runs/bad%2Fid/workflows`)).status).toBe(404);
 } finally {await browser.close();ui.server.closeAllConnections();await new Promise<void>(r=>ui.server.close(()=>r()));target.closeAllConnections();await new Promise<void>(r=>target.close(()=>r()));}
},30000);
