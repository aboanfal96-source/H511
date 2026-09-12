/* ══════════════════════════════════════════════════════════════════════════
   engine/appvm.js — تشغيل سكربت index.html خارج المتصفّح
   ──────────────────────────────────────────────────────────────────────────
   المنطق التنفيذي للمنصة (tradeLevels، calcTradePlan، ddTiming، _timeEntry)
   يعيش داخل index.html لا في وحدات المحرّك. ونسخُه إلى ملف ثانٍ ليعمل على
   الخادم يعني نسختين تتباعدان، فيصل إلى هاتفك تنبيه بأرقام لا تطابق ما
   يراه الشارت — وهو أسوأ من غياب التنبيه.

   الحلّ: استخراج السكربت نفسه وتشغيله في بيئة DOM وهمية. هذا ما يفعله
   اختبار الدخان منذ البداية، وهذه الوحدة تُخرج تلك التهيئة من الاختبار
   ليشاركها فاحص التنبيهات — فمصدر الأرقام واحد حرفياً.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** عنصر DOM وهمي: يبتلع كل ما يُطلب منه ولا يرمي. */
function el() {
  const e = {
    style: {}, dataset: {}, children: [], parentElement: null,
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    textContent: '', innerHTML: '', value: '', disabled: false, hidden: false,
    offsetWidth: 100, offsetHeight: 100, clientWidth: 100, clientHeight: 100,
    appendChild() { }, addEventListener() { }, removeEventListener() { }, remove() { },
    setAttribute() { }, getAttribute: () => null, insertAdjacentHTML() { },
    querySelector: () => el(), querySelectorAll: () => [],
    scrollIntoView() { }, focus() { }, click() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  };
  return e;
}

/**
 * يبني بيئة تشغيل كاملة ويحمّل فيها وحدات المحرّك ثم سكربت التطبيق.
 * @param {{engines?:string[], onAlert?:Function}} [opt]
 * @returns {{ctx:Object, alerts:string[], appSrc:string}}
 */
function createAppContext(opt) {
  opt = opt || {};
  const engines = opt.engines || ['core.js', 'timing.js', 'market.js', 'alerts.js'];
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  /* أكبر كتلة <script> بلا src هي سكربت التطبيق */
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const appSrc = blocks.map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  if (!appSrc || appSrc.length < 50000) throw new Error('تعذّر استخراج سكربت التطبيق من index.html');

  const alerts = [];
  const ctx = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Symbol, BigInt,
    Error, TypeError, RangeError, Promise, Intl, RegExp, Boolean, Function,
    isNaN, isFinite, parseFloat, parseInt, Infinity, NaN,
    encodeURIComponent, decodeURIComponent, escape: encodeURIComponent,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() { },
    requestAnimationFrame: (f) => setTimeout(f, 0),
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => { } } },
    location: { href: 'http://localhost/', search: '', origin: 'http://localhost' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; })(),
    document: {
      getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
      createElement: () => el(), body: el(), documentElement: el(), head: el(),
      addEventListener() { }, removeEventListener() { }
    },
    alert: (m) => alerts.push(String(m)),
    fetch: opt.fetch || (async () => ({ ok: false, status: 503, json: async () => ({}) })),
    AbortSignal: { timeout: () => null },
    AbortController: typeof AbortController !== 'undefined' ? AbortController : function () { this.signal = null; this.abort = () => { }; },
    CustomEvent: function () { }, Event: function () { },
    addEventListener() { }, removeEventListener() { },
    matchMedia: () => ({ matches: false, addListener() { }, addEventListener() { } }),
    innerWidth: 1400, innerHeight: 900,
    LightweightCharts: undefined,
    Notification: undefined
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);

  for (const f of engines) {
    const p = path.join(ROOT, 'engine', f);
    if (!fs.existsSync(p)) continue;
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: 'engine/' + f });
  }
  /* تصدير المتغيّرات المعرّفة بـ const/let في أعلى السكربت: لا تصير
     خصائص على الكائن العام، فلا تُرى من خارج الكتلة بدون هذا السطر. */
  vm.runInContext(appSrc + '\n;globalThis.G=G;globalThis.STKS=STKS;globalThis.NAMES=NAMES;',
    ctx, { filename: 'index.html:script' });

  return { ctx, alerts, appSrc };
}

module.exports = { createAppContext, el, ROOT };
