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
const NOTIFIED = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  /* بديل عن /api/notify: الدالة الحقيقية تحتاج رمز بوت حيّاً، والمقصود
     هنا فحص أن الواجهة تستدعيها بالمحتوى الصحيح لا فحص تلقرام نفسه. */
  if (u.pathname === '/api/notify') {
    let body = '';
    req.on('data', c => body += c);
    return req.on('end', () => {
      let msgs = [];
      try { const j = JSON.parse(body); msgs = j.messages || (j.text ? [j.text] : []); } catch (e) { }
      NOTIFIED.push(...msgs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: msgs.length }));
    });
  }
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
    const ctxt = await browser.newContext({ viewport: { width: 1500, height: 950 }, permissions: ['notifications'] });
    const pg = await ctxt.newPage();
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

    /* ── التنبيهات ───────────────────────────────────────────────────
       تُفحص في المتصفّح لأن ثلاثة أعطال منها ظهرت هنا ولم تظهر في
       الاختبارات النقيّة: اسم دالة غير معرّف، ومتجر منع التكرار لا
       يُحفظ بعد الفحص اليدوي، ونطاق ATR يُطلق تنبيهاً على أكثر من نصف
       الأسهم المحمّلة. */
    await pg.evaluate(async () => {
      const syms = STKS.slice(0, 25).map(s => s.sym);
      for (const s of syms) { try { await loadStock(s); calcInd(s); } catch (e) { } }
      window.__N = [];
      window.Notification = function (t, o) { window.__N.push({ t, b: o && o.body }); };
      window.Notification.permission = 'granted';
      window.Notification.requestPermission = async () => 'granted';
    });
    await pg.waitForTimeout(1200);

    const a1 = await pg.evaluate(async () => {
      AL.cfg.telegram = true; AL.cfg.browser = true; AL.cfg.sound = false;
      AL.cfg.kinds = ['ready', 'zone', 'approach']; AL.store = {}; AL.log = []; alSave();
      const r = await runAlertScan({ force: true });
      return { stats: r.stats, sent: r.sent.length, keys: r.sent.map(x => x.key), del: r.delivery, store: Object.keys(AL.store).length };
    });
    const a2 = await pg.evaluate(async () => {
      const r = await runAlertScan({ silent: true });
      return { sent: r.sent.length, keys: r.sent.map(x => x.key) };
    });
    const browserN = await pg.evaluate(() => window.__N.length);

    a1.stats.scanned > 10 ? ok(`فحص التنبيهات مرّ على ${a1.stats.scanned} سهماً محمّلاً`)
      : bad(`لم يُفحص إلا ${a1.stats.scanned} سهماً — الفحص لا يرى البيانات`);
    a1.sent > 0 ? ok(`أُطلق ${a1.sent} تنبيهاً (مكتملة ${a1.stats.ready} · منطقة ${a1.stats.zone} · اقتراب ${a1.stats.approach})`)
      : bad('لم يُطلق أي تنبيه رغم وجود أسهم محمّلة');
    a1.stats.skippedAtrZone > 0
      ? ok(`${a1.stats.skippedAtrZone} سهماً نطاقه مشتقّ من ATR ⇒ لا تنبيه (نطاق يحيط بالسعر بالتعريف)`)
      : ok('لا نطاقات ATR في هذه العيّنة');
    a1.del.browser === a1.sent ? ok('كل تنبيه وصل إشعار المتصفّح') : bad(`إشعارات المتصفّح ${a1.del.browser} ≠ ${a1.sent}`);
    a1.del.telegram === a1.sent && !a1.del.tgError ? ok('كل تنبيه وصل قناة تلقرام') : bad(`تلقرام ${a1.del.telegram}/${a1.sent} — ${a1.del.tgError || ''}`);
    /* __N تتراكم عبر الفحصين معاً، فالمقارنة مع مجموعهما لا مع الأول. */
    browserN === a1.sent + a2.sent ? ok(`عدد إشعارات المتصفّح مطابق لمجموع الفحصين (${browserN})`)
      : bad(`إشعارات ${browserN} ≠ ${a1.sent + a2.sent}`);
    a1.store === a1.sent ? ok('الفحص اليدوي سجّل ما أرسله في متجر منع التكرار')
      : bad(`المتجر يحوي ${a1.store} مفتاحاً بعد إرسال ${a1.sent} — منع التكرار معطَّل بعد الفحص اليدوي`);

    const repeat = a2.keys.filter(k => a1.keys.indexOf(k) >= 0);
    repeat.length === 0 ? ok(`الفحص التالي لم يُعد أي تنبيه سبق إرساله (أرسل ${a2.sent} من قائمة الانتظار)`)
      : bad(`تكرّر ${repeat.length} تنبيهاً: ${repeat.slice(0, 2).join(' , ')}`);

    const texts = NOTIFIED.join('\n---\n');
    /\u0645\u0646\u0637\u0642\u0629 \u0627\u0644\u062f\u062e\u0648\u0644/.test(texts) && /\u0627\u0644\u0648\u0642\u0641/.test(texts)
      ? ok('رسائل القناة تحمل منطقة الدخول والوقف')
      : bad('رسائل القناة بلا أرقام الخطة');
    /\u0644\u064a\u0633 \u062a\u0648\u0635\u064a\u0629/.test(texts) ? ok('كل رسالة تحمل تنويه المسؤولية') : bad('رسالة بلا تنويه المسؤولية');

    /* ── أهداف المدارس في بطاقة النشر ─────────────────────────────── */
    const sc = await pg.evaluate(async () => {
      const d = window.cardData(G.sel);
      if (d.err) return { err: d.err };
      const S = d.schools;
      if (!S || !S.ok) return { err: (S && S.reason) || 'لم تُحسب المدارس' };
      let cardW = 0;
      try { const cv = await window.makeCard(G.sel); cardW = (cv && cv.canvas && cv.canvas.width) || 0; } catch (e) { }
      return {
        price: S.price, total: S.stats.total, withTarget: S.stats.withTarget,
        rows: S.rows.map(r => ({ n: r.name, ok: !!r.ok, t: r.target, s: r.stop, b: (r.basis || '').length, why: (r.reason || '').length })),
        agreed: S.agreed.length, cardW
      };
    });

    if (sc.err) bad('بطاقة المدارس: ' + sc.err);
    else {
      sc.total === 13 ? ok(`جدول المدارس مكتمل (${sc.total} مدرسة · ${sc.withTarget} أعطت هدفاً)`)
        : bad(`عدد المدارس ${sc.total} بدل 13`);
      const bads = sc.rows.filter(r => (r.t != null && r.t <= sc.price) || (r.s != null && r.s >= sc.price));
      bads.length === 0 ? ok('كل هدف فوق السعر وكل وقف تحته في البطاقة')
        : bad(`${bads.length} صفّاً بأرقام مقلوبة: ${bads.map(r => r.n).join('، ')}`);
      const silent = sc.rows.filter(r => (r.ok && r.t != null) ? r.b < 8 : r.why < 8);
      silent.length === 0 ? ok('كل مدرسة تحمل أساسها أو سبب امتناعها')
        : bad(`${silent.length} مدرسة بلا أساس ولا سبب: ${silent.map(r => r.n).join('، ')}`);
      sc.cardW >= 1000 ? ok(`بطاقة النشر رُسمت (${sc.cardW}px عرضاً)`) : bad('تعذّر رسم بطاقة النشر');
    }

    errs.length ? bad('استثناءات في الصفحة: ' + errs.slice(0, 3).join(' | ')) : ok('لا استثناءات في المتصفّح');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${failures ? `✗ ${failures} مشكلة` : '✓ اختبار المتصفّح نجح بالكامل'}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('✗ ' + e.message); server.close(); process.exit(1); });
