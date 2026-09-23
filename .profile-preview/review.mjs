import { chromium } from '../node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true});
for (const [name,width,height] of [['desktop',1200,1150],['mobile',390,1600]]) {
 const page=await browser.newPage({viewport:{width,height},colorScheme:'light'});
 await page.goto('file:///C:/Users/ADMIN/Desktop/multi%20auto%20QA/.profile-preview/index.html');
 await page.screenshot({path:'.profile-preview/'+name+'-review.jpg',quality:85});
 await page.close();
}
await browser.close();
