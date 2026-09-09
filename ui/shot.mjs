import { chromium } from 'playwright'
const routes = process.argv.slice(3)
const out = process.argv[2]
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0,200)) })
for (const r of routes) {
  const name = r.replace(/[^a-z0-9]+/gi, '_') || 'root'
  await p.goto(`http://127.0.0.1:7173/#/${r}`, { waitUntil: 'networkidle' }).catch(()=>{})
  await p.waitForTimeout(2200)
  await p.screenshot({ path: `${out}/${name}.png` })
  console.log('shot', name)
}
if (errs.length) console.log('CONSOLE ERRORS:\n' + [...new Set(errs)].join('\n'))
await b.close()
