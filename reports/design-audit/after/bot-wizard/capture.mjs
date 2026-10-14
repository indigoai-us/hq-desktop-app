// usage: node capture.mjs <before|after> <port>
import { chromium } from '@playwright/test';
const [tag, port] = process.argv.slice(2);
const OUT = new URL('.', import.meta.url).pathname;
const b = await chromium.launch();
const metrics = () => document.querySelector('[role=dialog]') ? (() => {
  const d=[...document.querySelectorAll('[role=dialog]')].pop(); const fs=new Set(), ctl=new Set();
  d.querySelectorAll('*').forEach(e=>{const s=getComputedStyle(e); const r=e.getBoundingClientRect(); if(!r.width) return;
    if([...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(s.fontSize)!==13) fs.add(`${s.fontSize}/${s.fontWeight} "${e.textContent.trim().slice(0,24)}"`);
    if(/^(BUTTON|INPUT|SELECT)$/.test(e.tagName)||e.getAttribute('role')==='radio') {const h=Math.round(r.height); if(h!==28) ctl.add(`${h}h bw${s.borderTopWidth} "${(e.textContent||e.placeholder||'').trim().slice(0,20)}"`);}
    if(e.scrollWidth>e.clientWidth+1&&s.overflowX!=='visible'&&s.overflowX!=='hidden') fs.add('HSCROLL '+e.className);});
  return {w:Math.round(d.getBoundingClientRect().width),h:Math.round(d.getBoundingClientRect().height),nonFont13:[...fs],non28:[...ctl]};})() : 'NO DIALOG';
async function run(theme) {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(`http://localhost:${port}/?view=shell&persona=indigo${theme==='light'?'&theme=light':''}`); await p.waitForTimeout(2000);
  if (theme==='light') await p.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.classList.remove('dark');document.documentElement.classList.add('light');});
  await p.click('[aria-label="New message, channel, or agent"]'); await p.waitForTimeout(500);
  await p.getByRole('menuitem', { name: /New (agent|bot)/ }).click(); await p.waitForTimeout(1200);
  const shot = async n => { await p.screenshot({ path: `${OUT}${tag}-${n}.png` }); console.log(n, JSON.stringify(await p.evaluate(metrics))); };
  const next = async () => { await p.getByRole('button', { name: /^Next$/ }).click(); await p.waitForTimeout(1000); };
  if (theme==='dark') await shot('step1-kind');
  await p.getByRole('radio').first().click().catch(()=>{}); await next();
  if (theme==='dark') {
    await shot('step2-home-local');
    const cloud = p.getByRole('radio', { name: /Cloud/ });
    if (await cloud.count() && await cloud.isEnabled()) { await cloud.click(); await p.waitForTimeout(800); await shot('step2-home-cloud');
      await p.getByRole('radio', { name: /Local/ }).click(); await p.waitForTimeout(500); }
  }
  await next(); await p.waitForTimeout(500);
  await shot(theme==='dark' ? 'step3-details' : 'step3-details-light');
  await p.close();
}
await run('dark'); await run('light'); await b.close();
