/* ══════════════════════════════════════════════════════════════════════════
   اختبار دخان للتطبيق — node engine/app.smoke.js
   ──────────────────────────────────────────────────────────────────────────
   يستخرج السكربت الداخلي من index.html ويشغّله في بيئة DOM وهمية، ثم
   يستدعي كل تقرير تحليلي على بيانات اصطناعية متنوّعة.

   الغرض: التقاط انفصال الأسلاك بين index.html ومحرّك التحليل — دالة
   حُذفت وبقي نداؤها، أو حقل أُعيدت تسميته في المحرك ولم يُحدَّث في الواجهة
   (وهو ما حدث فعلاً مع radar.estDate ← date). هذه أخطاء لا يلتقطها
   `node --check` لأنها صحيحة نحوياً، ولا تلتقطها اختبارات المحرك لأنها
   في طبقة الربط.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine', 'core.js'), 'utf8');

/* استخراج السكربت الرئيسي: آخر كتلة <script> بلا src */
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const appSrc = blocks.map(m => m[1]).sort((a, b) => b.length - a.length)[0];
if (!appSrc || appSrc.length < 50000) {
  console.error('✗ تعذّر استخراج سكربت التطبيق من index.html');
  process.exit(1);
}

/* ── بيئة DOM وهمية ────────────────────────────────────────────────── */
const el = () => ({
  style: {}, dataset: {}, children: [], parentElement: null,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  textContent: '', innerHTML: '', value: '', disabled: false,
  offsetWidth: 100, offsetHeight: 100,
  appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {},
  setAttribute() {}, getAttribute: () => null, insertAdjacentHTML() {},
  querySelector: () => el(), querySelectorAll: () => [],
  scrollIntoView() {}, focus() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
});
const alerts = [];
const ctx = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Symbol,
  Error, TypeError, RangeError, Promise, Intl, isNaN, isFinite, parseFloat, parseInt,
  Infinity, NaN, encodeURIComponent, decodeURIComponent,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: (f) => setTimeout(f, 0),
  performance: { now: () => Date.now() },
  navigator: { userAgent: 'node' },
  location: { href: 'http://localhost/', search: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), body: el(), documentElement: el(), head: el(), addEventListener() {}
  },
  alert: (m) => alerts.push(String(m)),
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  AbortSignal: { timeout: () => null },
  CustomEvent: function () {}, Event: function () {},
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  innerWidth: 1400, innerHeight: 900,
  LightweightCharts: undefined
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };

/* ── تحميل المحرك ثم التطبيق ───────────────────────────────────────── */
vm.runInContext(engineSrc, ctx, { filename: 'engine/core.js' });
if (!ctx.KSAEngine) { bad('KSAEngine لم يُسجَّل على window'); process.exit(1); }
ok(`تحميل المحرك (v${ctx.KSAEngine.version})`);

try {
  vm.runInContext(appSrc + '\n;globalThis.G=G;globalThis.STKS=STKS;', ctx, { filename: 'index.html:script' });
  ok('تحميل سكربت التطبيق بلا استثناء');
} catch (e) {
  bad('سكربت التطبيق رمى استثناءً عند التحميل: ' + e.message);
  process.exit(1);
}

/* ── 1) الدوال الحيّة موجودة ───────────────────────────────────────── */
const required = [
  'spectralAnalysis', 'projectSpectralTurningPoints', 'predictPriceARIMA',
  'analyzeVolumeProfile', 'calculateValueBand', 'calculateVolatility',
  'smartTimingAnalysis', 'smartPredictionAdvanced', 'smartPricingAdvanced',
  'backtestSpectralSignal', 'runSpectralBacktestReport', 'runSpectralScanAll',
  'buildExecutionPlan', 'buildUpcomingTimeWindows', 'calc52WeekRange',
  'requireRealData', 'loadStock', 'calcAllFilters', 'calcTradePlan',
  'timeAlignmentTrigger', 'calcInd', 'runAI'
];
const missing = required.filter(f => typeof ctx[f] !== 'function');
missing.length ? bad('دوال مفقودة: ' + missing.join(', ')) : ok(`كل الدوال المطلوبة موجودة (${required.length})`);

/* ── 2) الكود الميت المكسور أُزيل فعلاً ────────────────────────────── */
const mustBeGone = [
  'detectPeaksAndValleys', 'analyzeGannCycles', 'analyzeFrequencySpectrum',
  'calculateFibonacciTimeZones', 'analyzeVolumeCycles',
  'calculateDynamicFairPrice', 'calculateFractalFactor', 'calculateMomentumFactor'
];
const zombies = mustBeGone.filter(f => typeof ctx[f] === 'function');
zombies.length ? bad('كود ميت ما زال موجوداً: ' + zombies.join(', ')) : ok('الكود الميت المكسور أُزيل بالكامل');

/* ── 3) لا أرقام ثقة مخترعة ولا وسطاء خارجيون في الكود التنفيذي ─────
   نفحص الكود بعد تجريده من التعليقات: التوثيق يذكر هذه الأنماط عمداً
   لشرح ما حُذف ولماذا، وحظرها في التعليقات يمنع توثيق الإصلاح نفسه. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => {
    /* إزالة تعليق // مع تجنّب ما يقع داخل نص أو داخل رابط مثل https:// */
    let inS = null;
    for (let i = 0; i < l.length - 1; i++) {
      const ch = l[i];
      if (inS) { if (ch === '\\') i++; else if (ch === inS) inS = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue; }
      if (ch === '/' && l[i + 1] === '/') return l.slice(0, i);
    }
    return l;
  }).join('\n');

const codeOnly = stripComments(appSrc);
const bannedText = [
  ['احتمال النجاح', 'رقم احتمال نجاح مكتوب حرفياً في المخرجات'],
  ['probability: 75', 'احتمال فيبوناتشي ثابت'],
  ['api.allorigins.win', 'وسيط CORS طرف ثالث'],
  ['corsproxy.io', 'وسيط CORS طرف ثالث'],
  ['Math.random()', 'عشوائية غير مُبذّرة (تجعل التقارير غير قابلة لإعادة الإنتاج)']
];
const found = bannedText.filter(([t]) => codeOnly.includes(t));
found.length ? bad('أنماط محظورة باقية في الكود التنفيذي: ' + found.map(f => f[1]).join(', '))
             : ok('لا أرقام ثقة مخترعة، ولا وسطاء CORS خارجيين، ولا عشوائية غير مُبذّرة');

/* ── 4) كل تقرير يعمل على بيانات متنوّعة ───────────────────────────── */
const E = ctx.KSAEngine, G = ctx.G;
function gen(n, seed, base, vol, cyc) {
  const r = E.seededRandom(seed); const cs = []; let p = base;
  const t0 = Math.floor(Date.UTC(2024, 0, 7) / 1000);
  for (let i = 0; i < n; i++) {
    const ct = cyc ? Math.sin(2 * Math.PI * i / cyc) * vol * 1.5 : 0;
    const o = p, c = +(p * (1 + (r() - 0.5) * 2 * vol + ct)).toFixed(2);
    cs.push({
      time: t0 + i * 86400, open: o, close: c,
      high: +(Math.max(o, c) * (1 + r() * 0.007)).toFixed(2),
      low: +(Math.min(o, c) * (1 - r() * 0.007)).toFixed(2),
      volume: Math.floor(80000 + r() * 700000)
    });
    p = c;
  }
  return cs;
}

let rendered = null;
ctx.openTimeReport = (title, body) => { rendered = { title, body }; };

const scenarios = [
  ['سهم عادي 250 جلسة', gen(250, 7, 73.25, 0.015, 0)],
  ['سهم بدورة 300 جلسة', gen(300, 11, 73.25, 0.012, 21)],
  ['سهم بسعر منخفض', gen(200, 5, 1.24, 0.035, 0)],
  ['سهم بسعر مرتفع', gen(200, 9, 412, 0.02, 0)],
  ['تاريخ قصير (45)', gen(45, 13, 18, 0.02, 0)],
  ['سهم بلا حركة', Array.from({ length: 150 }, (_, i) => ({
    time: Math.floor(Date.UTC(2024, 0, 7) / 1000) + i * 86400,
    open: 10, high: 10, low: 10, close: 10, volume: 0
  }))]
];
const reports = ['smartTimingAnalysis', 'smartPredictionAdvanced', 'smartPricingAdvanced', 'runSpectralBacktestReport'];
const BAD_OUTPUT = /NaN|undefined|Infinity|\[object Object\]|Invalid Date/;

let renderedCount = 0, declinedCount = 0;
for (const [name, cs] of scenarios) {
  const sym = 'SMOKE_' + renderedCount;
  G.cans[sym] = cs; G.pr[sym] = cs[cs.length - 1].close; G.sel = sym;
  G.ch[sym] = +(cs[cs.length - 1].close - cs[cs.length - 2].close).toFixed(2);
  G.pc[sym] = +(G.ch[sym] / cs[cs.length - 2].close * 100).toFixed(2);
  G.demo.delete(sym);
  try { ctx.calcInd(sym); } catch (e) { bad(`[${name}] calcInd: ${e.message}`); }

  for (const fn of reports) {
    rendered = null; alerts.length = 0;
    try {
      ctx[fn]();
      if (rendered) {
        const m = BAD_OUTPUT.exec(rendered.body);
        if (m) bad(`[${name}] ${fn}: أخرج "${m[0]}" في التقرير`);
        else renderedCount++;
      } else if (alerts.length) {
        declinedCount++;   /* رفض مبرَّر — سلوك صحيح عند بيانات غير كافية */
      } else {
        bad(`[${name}] ${fn}: بلا مخرَج وبلا تنبيه`);
      }
    } catch (e) {
      bad(`[${name}] ${fn} رمى استثناءً: ${e.message}`);
    }
  }
}
ok(`تقارير مبنيّة بلا قيم فاسدة: ${renderedCount} | حالات رُفضت بتبرير: ${declinedCount}`);

/* ── 5) حارس البيانات التجريبية يمنع كل تقرير ──────────────────────── */
const d = 'SMOKE_DEMO';
G.cans[d] = gen(200, 77, 50, 0.015, 0); G.pr[d] = 50; G.sel = d;
G.demo.add(d); G.failed.set(d, 'اختبار');
ctx.calcInd(d);
let blocked = 0;
for (const fn of ['smartTimingAnalysis', 'smartPredictionAdvanced', 'smartPricingAdvanced']) {
  rendered = null; alerts.length = 0;
  ctx[fn]();
  if (!rendered && alerts.some(a => a.includes('تجريبية'))) blocked++;
}
blocked === 3 ? ok('حارس البيانات التجريبية يمنع كل التقارير التحليلية')
              : bad(`الحارس منع ${blocked}/3 تقارير فقط — تحليل على أرقام عشوائية ممكن`);

/* ── 6) الاختبار التاريخي حتمي عبر طبقة التطبيق ────────────────────── */
G.cans['SMOKE_DET'] = gen(400, 103, 60, 0.012, 22);
G.pr['SMOKE_DET'] = 60; G.demo.delete('SMOKE_DET');
const runs = new Set(Array.from({ length: 4 }, () => JSON.stringify(ctx.backtestSpectralSignal('SMOKE_DET'))));
runs.size === 1 ? ok('الاختبار التاريخي حتمي عبر طبقة التطبيق')
                : bad(`أربع تشغيلات أعطت ${runs.size} نتائج مختلفة`);

console.log(`\n${failures ? `✗ ${failures} مشكلة` : '✓ اختبار الدخان نجح بالكامل'}\n`);
process.exit(failures ? 1 : 0);
