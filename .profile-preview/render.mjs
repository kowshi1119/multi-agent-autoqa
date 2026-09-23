import fs from 'node:fs';
import path from 'node:path';
import { marked } from './node_modules/marked/lib/marked.esm.js';
import { chromium } from '../node_modules/playwright/index.mjs';
const root = path.resolve('kowshi1119');
const out = path.resolve('.profile-preview');
const file = path.join(root,'README.md');
let md = fs.readFileSync(file,'utf8').replace(/  \r?\n/g,'<br/>\n');
fs.writeFileSync(file,md);
const css = fs.readFileSync(path.join(out,'node_modules/github-markdown-css/github-markdown.css'),'utf8');
const renderer = new marked.Renderer();
renderer.heading = function({tokens,depth}) { const text = this.parser.parseInline(tokens); const id=text.toLowerCase().replace(/[^a-z0-9 -]/g,'').replace(/ /g,'-'); return `<h${depth} id="${id}">${text}</h${depth}>`; };
const html = marked.parse(md,{renderer}).replaceAll('src="assets/','src="../kowshi1119/assets/').replaceAll('srcset="assets/','srcset="../kowshi1119/assets/').replaceAll('https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/','snake-output/');
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kowshikan — GitHub profile preview</title><style>${css}\nbody{margin:0;background:var(--bgColor-default,#fff)}.markdown-body{box-sizing:border-box;max-width:980px;margin:32px auto;padding:40px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:12px}.markdown-body img{max-width:100%;box-sizing:border-box}.markdown-body img[width="100%"]{height:auto} @media(max-width:767px){.markdown-body{margin:0;border:0;border-radius:0;padding:20px 16px}}</style></head><body><article class="markdown-body">${html}</article></body></html>`);
const browser = await chromium.launch({headless:true});
const results=[];
for (const [name,width,colorScheme] of [['desktop-light',1440,'light'],['desktop-dark',1440,'dark'],['mobile-light',390,'light'],['mobile-dark',390,'dark'],['mobile-small',320,'light']]) {
 const page = await browser.newPage({viewport:{width,height:1000},colorScheme});
 await page.goto('file:///'+path.join(out,'index.html').replaceAll('\\','/'));
 await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
 const result=await page.evaluate(()=>({pageOverflow:document.documentElement.scrollWidth>innerWidth,images:[...document.images].map(i=>({src:i.getAttribute('src'),loaded:i.complete&&i.naturalWidth>0,alt:!!i.alt})),badAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.querySelector(a.getAttribute('href'))).map(a=>a.href),headings:[...document.querySelectorAll('h1,h2')].map(h=>h.textContent)}));
 if(result.pageOverflow||result.badAnchors.length||result.images.some(i=>!i.loaded||!i.alt))throw new Error(name+': '+JSON.stringify(result));
 await page.getByText('Earlier education',{exact:true}).click();
 if(!await page.locator('details').evaluate(e=>e.open))throw new Error('Disclosure failed');
 results.push({name,...result});
 await page.close();
}
await browser.close();
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({name,pageOverflow,images,badAnchors})=>({name,pageOverflow,loadedImages:images.length,badAnchors})),null,2));

