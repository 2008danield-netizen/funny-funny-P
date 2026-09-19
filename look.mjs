import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:4173/funny-funny-P/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 30000 });
await page.waitForTimeout(4500);
console.log('orbit bake:', JSON.stringify(await page.evaluate(() => window.__bakeProbe())));

await page.evaluate(() => window.__aoProbe(true, 'interior'));
await page.waitForTimeout(1500);
let shot = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
fs.writeFileSync('/tmp/interior.png', Buffer.from(shot.split(',')[1], 'base64'));

await page.evaluate(() => window.__walkView('first'));
await page.waitForTimeout(2500);
console.log('walk bake:', JSON.stringify(await page.evaluate(() => window.__bakeProbe())));

await page.evaluate(() => window.__walkDrive({ forward: -1 }, 1.4));
await page.waitForTimeout(600);
await page.evaluate(() => window.__walkDrive({ turn: 2 }, 1.0));
await page.waitForTimeout(1600);
shot = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
fs.writeFileSync('/tmp/fpv1.png', Buffer.from(shot.split(',')[1], 'base64'));

await page.evaluate(() => window.__walkDrive({ turn: 1.4 }, 1.4));
await page.waitForTimeout(1600);
shot = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
fs.writeFileSync('/tmp/fpv2.png', Buffer.from(shot.split(',')[1], 'base64'));
console.log('wrote pics');
await browser.close();
