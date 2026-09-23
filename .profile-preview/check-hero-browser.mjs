import fs from 'node:fs';
import {chromium} from '../node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true});
const results=[];
for(const width of [1200,390])for(const reducedMotion of ['no-preference','reduce']){
 const p=await browser.newPage({viewport:{width,height:1000},reducedMotion});
 await p.goto('file:///C:/Users/ADMIN/Desktop/multi%20auto%20QA/.profile-preview/index.html');
 const im=p.locator('img[src$="ai-qa-dev-flow.gif"]');
 const actual=await im.evaluate(e=>({src:e.currentSrc,loaded:e.complete&&e.naturalWidth>0}));
 const expected=`ai-qa-dev-flow${width<600?'-mobile':''}.${reducedMotion==='reduce'?'png':'gif'}`;
 if(!actual.loaded||!actual.src.endsWith(expected))throw Error(JSON.stringify(actual));
 results.push({width,reducedMotion,selected:expected});await p.close();
}
const p=await browser.newPage();
await p.goto('file:///C:/Users/ADMIN/Desktop/multi%20auto%20QA/kowshi1119/assets/hero/source/index.html');
await p.getByRole('button',{name:'Pause animation'}).click();
await p.getByRole('button',{name:'Play animation'}).waitFor();
await browser.close();
fs.writeFileSync('.profile-preview/hero-browser-validation.json',JSON.stringify(results,null,2));
console.log('PASS: desktop/mobile animated and static image selection; source pause/play control.');
