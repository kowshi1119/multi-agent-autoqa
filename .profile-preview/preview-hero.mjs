import fs from 'node:fs';
import {chromium} from '../node_modules/playwright/index.mjs';
const root='file:///C:/Users/ADMIN/Desktop/multi%20auto%20QA/kowshi1119/assets/hero/source/index.html?export';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>{throw e});
await page.goto(root);await page.evaluate(()=>document.fonts.ready);
for(const t of [0,2.8,4.7,5.8,6.8,8.7,10]){await page.evaluate(t=>renderHero(t,false),t);await page.locator('canvas').screenshot({path:`.profile-preview/hero-${t}.png`})}
await page.evaluate(()=>renderHero(8.7,true));await page.locator('canvas').screenshot({path:'.profile-preview/hero-mobile.png'});
await browser.close();
