import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from '../node_modules/playwright/index.mjs';
import YAML from '../node_modules/yaml/dist/index.js';
const workflow=YAML.parse(fs.readFileSync('kowshi1119/.github/workflows/snake.yml','utf8'));
if(!workflow.on.push||!workflow.on.schedule||workflow.jobs.generate.steps.length!==4)throw Error('Workflow structure');
const browser=await chromium.launch({headless:true});
const checks=[];
for(const reducedMotion of ['no-preference','reduce']){
 const page=await browser.newPage({viewport:{width:1200,height:1000},reducedMotion});
 await page.goto('file:///C:/Users/ADMIN/Desktop/multi%20auto%20QA/.profile-preview/index.html');
 await page.evaluate(()=>document.fonts.ready);
 for(const name of ['profile-hero','tech-stack','project-autoqa','project-medvision','project-cse']){
  const el=page.locator(`img[src$="${name}.svg"]`);
  await el.scrollIntoViewIfNeeded();
  const a=await el.screenshot({animations:'allow'});await page.waitForTimeout(900);const b=await el.screenshot({animations:'allow'});
  const changed=createHash('sha256').update(a).digest('hex')!==createHash('sha256').update(b).digest('hex');
  if(changed!==(reducedMotion==='no-preference'))throw Error(`${name}: unexpected motion in ${reducedMotion}`);
  checks.push({asset:name,reducedMotion,changed});
 }
 const snake=page.locator('img[src$="contribution-snake.svg"]');
 const current=await snake.evaluate(e=>e.currentSrc);
 if(reducedMotion==='reduce'&&!current.endsWith('contribution-snake-static.svg'))throw Error('Static snake not selected');
 await page.locator('img[src$="tech-stack.svg"]').screenshot({path:'.profile-preview/tech-review.jpg',type:'jpeg',quality:90});
 await snake.screenshot({path:'.profile-preview/snake-review.jpg',type:'jpeg',quality:90});
 await page.close();
}
await browser.close();
fs.writeFileSync('.profile-preview/motion-validation.json',JSON.stringify(checks,null,2));
console.log('PASS: all 5 custom graphics animate as embedded images and freeze for reduced motion; static snake selected; workflow YAML valid.');

