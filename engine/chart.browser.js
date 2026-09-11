/* ══════════════════════════════════════════════════════════════════════════
   اختبار المتصفّح — node engine/chart.browser.js
   ──────────────────────────────────────────────────────────────────────────
   الاختبارات الأخرى تشغّل الكود في DOM وهمي، فلا يمرّ منها شيء على مكتبة
   الرسم الحقيقية. وهذا الاختبار يفتح الصفحة في متصفّح فعلي ويتحقّق من
   الادّعاء المركزي الذي أبلغ المستخدم بكسره:

     «تبديل زرّ الفريم يغيّر العرض ولا يغيّر أي مخرَج تحليلي.»

   يُقاس ذلك بمقارنة منطقة الدخول والوقف والمخاطرة والأهداف ونتيجة الدورة
   عبر خمسة فريمات، مع التأكّد أن النافذة المرئية نفسها تتغيّر فعلاً —
   فتساوي القيم مع ثبات العرض ليس دليلاً على شيء.

   يتطلّب playwright ومكتبة الرسم محليّاً. إن لم يكونا مثبّتين يتخطّى
   الاختبار بنجاح بدل أن يكسر `npm test` على جهاز بلا متصفّح:
     npm i -D playwright lightweight-charts@4.1.0
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');

let chromium = null, LWC = null;
try { chromium = require('playwright').chromium; } catch (e) { }
/* حزمة lightweight-charts تمنع الوصول المباشر لمسارات dist عبر حقل
   exports، فيُحلّ مسار الحزمة نفسها ثم يُبنى المسار على القرص. */
try {
  const base = path.dirname(require.resolve('lightweight-charts/package.json'));
  const f = path.join(base, 'dist', 'lightweight-charts.standalone.production.js');
  if (fs.existsSync(f)) LWC = f;
} catch (e) { }
if (!chromium || !LWC) {
  console.log('⊘ تخطٍّ: playwright أو lightweight-charts غير مثبّتين محليّاً.');
  console.log('  التثبيت: npm i -D playwright lightweight-charts@4.1.0');
  process.exit(0);
}
/* مسار المتصفّح: المتغيّر البيئي أولاً، ثم أي بناء كروميوم موجود في
   مجلّد متصفّحات playwright. بدون هذا يفشل الاختبار لمجرّد أن نسخة
   playwright المثبّتة تتوقّع رقم بناء غير الموجود على الجهاز — وهو فشل
   في البيئة لا في الكود، ويجب أن يُقرأ كتخطٍّ لا كعطل. */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(root)) {
      if (!/^chromium-/.test(d)) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const f = path.join(root, d, rel);
        if (fs.existsSync(f)) return f;
      }
    }
  } catch (e) { }
  return undefined;
}
const EXEC = findChrome();

/* ── خادم محلّي: يخدم الصفحة والمحرّك، ويزوّد شموعاً اصطناعية ثابتة ── */
function synth(sym) {
  let x = (parseInt(sym, 10) || 1) * 7919 % 2147483647;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const ts = [], o = [], h = [], l = [], c = [], v = [];
  let p = 15.5, t = Math.floor(Date.UTC(2021, 8, 1) / 1000);
  for (let i = 0; i < 1250; i++) {
    const d = new Date(t * 1000);
    if (d.getUTCDay() === 5 || d.getUTCDay() === 6) { t += 86400; i--; continue; }
    const op = p;
    p = p * (1 + (rnd() - 0.5) * 0.028 + Math.sin(2 * Math.PI * i / 34) * 0.002);
    const cl = +p.toFixed(2);
    ts.push(t); o.push(+op.toFixed(2));
    h.push(+(Math.max(op, cl) * (1 + rnd() * 0.009)).toFixed(2));
    l.push(+(Math.min(op, cl) * (1 - rnd() * 0.009)).toFixed(2));
    c.push(cl); v.push(Math.round(2e5 * (0.4 + rnd())));
    t += 86400;
  }
  return { chart: { result: [{ meta: { regularMarketPrice: c[c.length - 1], previousClose: c[c.length - 2], symbol: sym }, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }], error: null } };
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stock') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(synth(u.searchParams.get('symbol') || '2222')));
  }
  if (u.pathname === '/lwc.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(fs.readFileSync(LWC));
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    /* المكتبة تُخدم محليّاً: بيئة الاختبار قد لا تصل إلى شبكة التوزيع،
       وسقوطها هناك يُظهر الاختبار فاشلاً لسبب لا علاقة له بالكود. */
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .replace(/<script src="https:\/\/cdnjs[^"]*lightweight-charts[^"]*"><\/script>/, '<script src="/lwc.js"></script>')
      .replace(/<script>if\(typeof LightweightCharts[\s\S]*?<\/script>/, '')
      .replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  const fp = path.join(ROOT, u.pathname);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': path.extname(fp) === '.js' ? 'application/javascript' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(fp));
});

let failures = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failures++; };

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  let browser;
  try { browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] }); }
  catch (e) {
    console.log('⊘ تخطٍّ: تعذّر تشغيل متصفّح — ' + e.message.split('\n')[0]);
    console.log('  حدّد المسار بـ CHROME_PATH أو ثبّت المتصفّح: npx playwright install chromium');
    server.close(); process.exit(0);
  }
  try {
    const pg = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 60000 });
    await pg.waitForTimeout(5000);

    const snap = () => pg.evaluate(() => {
      const L = window.tradeLevels ? window.tradeLevels(G.sel) : null;
      const tm = window.ddTiming ? window.ddTiming(G.sel) : null;
      let months = null;
      try { const r = G.lwChart.timeScale().getVisibleRange(); if (r) months = Math.round((r.to - r.from) / 86400 / 30.44); } catch (e) { }
      return {
        tf: G.tf, bars: (G.cans[G.sel] || []).length, months,
        levels: L && [L.entryLo, L.entryHi, L.stop, L.risk].concat(L.targets.map(t => t.price)).join('/'),
        riskATR: L && L.riskATR, riskOk: L && L.riskOk, atr: L && L.atr,
        cycle: tm && tm.ok ? (tm.significant ? `${tm.pText}|${tm.period}|${(tm.turns || []).length}|${!!tm.unstable}` : `none|${tm.pText}`) : '-'
      };
    });

    const rows = [await snap()];
    for (const tf of ['1y', '2y', '5y', '6mo']) {
      await pg.evaluate(t => {
        const b = [...document.querySelectorAll('.tfs .tf')].find(x => (x.getAttribute('onclick') || '').includes(`'${t}','1d'`));
        if (b) b.click();
      }, tf);
      await pg.waitForTimeout(2500);
      rows.push(await snap());
    }
    rows.forEach(r => console.log(`      ${String(r.tf).padEnd(4)} · شموع ${r.bars} · عرض ${r.months} شهر · ${r.levels}`));

    if (new Set(rows.map(r => r.months)).size < 3)
      bad('النافذة المرئية لم تتغيّر بتغيّر الفريم — الاختبار لا يثبت شيئاً');
    else ok(`النافذة المرئية تتبع الزرّ: ${rows.map(r => r.months).join(' · ')} شهراً`);

    if (new Set(rows.map(r => r.bars)).size !== 1) bad('عدد الشموع المحمّلة يتغيّر بتغيّر الفريم');
    else ok(`تاريخ التحليل ثابت عبر كل الفريمات (${rows[0].bars} شمعة)`);

    const lv = new Set(rows.map(r => r.levels));
    lv.size === 1 ? ok('منطقة الدخول والوقف والمخاطرة والأهداف متطابقة عبر خمسة فريمات')
      : bad(`المستويات تتغيّر بتغيّر الفريم (${lv.size} قيم مختلفة): ${[...lv].join(' ≠ ')}`);

    const cy = new Set(rows.map(r => r.cycle));
    cy.size === 1 ? ok(`نتيجة الدورة متطابقة عبر كل الفريمات (${rows[0].cycle})`)
      : bad(`نتيجة الدورة تتغيّر بتغيّر الفريم: ${[...cy].join(' ≠ ')}`);

    const r0 = rows[0];
    if (r0.riskOk && r0.atr > 0 && r0.riskATR < 0.5) bad(`مسافة المخاطرة ${r0.riskATR}×ATR داخل ضجيج الجلسة مع إعلانها سليمة`);
    else ok(`مسافة المخاطرة ${r0.riskATR}×ATR — خارج ضجيج الجلسة`);

    const drawn = await pg.evaluate(() => {
      const el = document.getElementById('tl-info');
      return { info: el ? el.textContent.trim() : '', hasCanvas: !!document.querySelector('#lw-chart canvas') };
    });
    drawn.hasCanvas ? ok('الشارت مرسوم فعلاً في المتصفّح') : bad('لا لوحة رسم — الشارت لم يُبنَ');
    drawn.info.length > 40 ? ok('سطر مستويات الصفقة معروض تحت الشارت') : bad('سطر المستويات فارغ');

    errs.length ? bad('استثناءات في الصفحة: ' + errs.slice(0, 3).join(' | ')) : ok('لا استثناءات في المتصفّح');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${failures ? `✗ ${failures} مشكلة` : '✓ اختبار المتصفّح نجح بالكامل'}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('✗ ' + e.message); server.close(); process.exit(1); });
