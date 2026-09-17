import { writeFileSync } from 'node:fs';
import { ProfileStore } from '../src/profiles/store.js';
import { profileToAppConfig } from '../src/profiles/to-app-config.js';
import { BrowserManager } from '../src/browser/browser.js';
import { ActionPolicy } from '../src/safety/action-policy.js';
import { createLogger } from '../src/logger.js';
const profile = new ProfileStore('profiles').load('ajeer');
const browser = new BrowserManager(profileToAppConfig(profile), createLogger(), true);
await browser.launch();
try {
 const session = await browser.newPageSession(undefined, new ActionPolicy(profile));
 const requests: {method:string; origin:string; pathname:string}[] = [];
 session.page.on('request', r => { const u=new URL(r.url()); if(!/\.(js|css|png|svg|woff2?)$/.test(u.pathname)) requests.push({method:r.method(),origin:u.origin,pathname:u.pathname}); });
 await session.page.goto(profile.target.url,{timeout:15000,waitUntil:'domcontentloaded'});
 await session.page.getByRole('button',{name:'Login',exact:true}).waitFor({timeout:10000});
 const controls=await session.page.locator('input,button').evaluateAll(es=>es.map(e=>({tag:e.tagName,type:e.getAttribute('type'),placeholder:e.getAttribute('placeholder'),label:e.getAttribute('aria-label'),text:e.tagName==='BUTTON'?e.textContent?.trim():undefined})));
 const result={kind:'browser-assisted-discovery-not-AutoQA-acceptance',observedAt:new Date().toISOString(),url:session.page.url(),controls,requests,credentialsUsed:false,mutationsAllowed:false};
 writeFileSync('docs/AJEER_DISCOVERY.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}

