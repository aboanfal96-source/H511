/* ══════════════════════════════════════════════════════════════════════════
   engine/filters.test.js — عيوب كشفها القياس على السوق الحقيقي
   ──────────────────────────────────────────────────────────────────────────
   كل اختبار هنا يثبّت عيباً وُجد بتشغيل المنصّة على 257 سهماً حقيقياً
   (scripts/diag.js)، لا بقراءة الكود وحدها. ولكلٍّ الرقم الذي كشفه.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const { createAppContext } = require('./appvm.js');
const { ctx } = createAppContext();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '\n      ' + extra : '')); }
};
const H = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/** شموع من مسار إغلاقات مُعطى، بمدى ثابت حول كل إغلاق. */
function fromCloses(cl, spread) {
  spread = spread == null ? 0.004 : spread;
  let t = Math.floor(Date.UTC(2024, 0, 7) / 1000);
  return cl.map((c, i) => {
    const o = i ? cl[i - 1] : c;
    const bar = { time: t, open: o, close: c, high: Math.max(o, c) * (1 + spread), low: Math.min(o, c) * (1 - spread), volume: 1e5 };
    t += 86400; return bar;
  });
}
function walk(n, seed, drift, vol) {
  let s = seed || 1; const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const out = []; let p = 50;
  for (let i = 0; i < n; i++) { p *= 1 + (drift || 0) + (r() - 0.5) * 2 * (vol || 0.015); out.push(+p.toFixed(2)); }
  return out;
}

H('الزخم — تعريف التسارع');
{
  /* هبط 3٪ ثم ثبت: الزخم لم يتسارع صعوداً. كان يُوسَم «تسارع قوي ↑». */
  const cl = walk(60, 3, 0, 0.002);
  const base = cl[cl.length - 1];
  for (let k = 0; k < 5; k++) cl.push(+(base * (1 - 0.006 * (k + 1))).toFixed(2));
  const last = cl[cl.length - 1];
  for (let k = 0; k < 5; k++) cl.push(last);
  const m = ctx.calcMomentumAccel(fromCloses(cl));
  ok('هبوط ثم ثبات لا يُسمّى تسارعاً صعودياً', !/تسارع/.test(m.sig) || m.accel <= 0, `sig=${m.sig} accel=${m.accel}`);
  ok('العتبة بوحدات تذبذب السهم (z معلن)', typeof m.z === 'number');
}

H('القوة النسبية — الإشارة والقسمة');
{
  const cl = walk(40, 5, 0, 0.001);
  const cs = fromCloses(cl);
  const n = cl.length, stock = (cl[n - 1] - cl[n - 21]) / cl[n - 21] * 100;
  /* السوق أسوأ من السهم ⇒ السهم أقوى، مهما كانت إشارتا العائدين */
  const r = ctx.calcRelativeStrength(cs, stock - 0.7);
  ok('سهم تفوّق على سوق هابط ليس «أضعف»', r.rs > 1 && !/أضعف/.test(r.sig), `rs=${r.rs} sig=${r.sig}`);
  const flat = ctx.calcRelativeStrength(cs, 0.01);
  ok('سوق شبه ثابت لا يجعل كل حركة صغيرة «أقوى بكثير»', !(Math.abs(stock) < 1 && flat.alert), `stock=${stock.toFixed(2)} alert=${flat.alert}`);
}

H('الضغط — «انطلق» انتقالٌ لا حالة');
{
  const cs = fromCloses(walk(120, 9, 0.004, 0.03), 0.02);   /* متقلّب، بلا ضغط */
  const q = ctx.calcBBSqueeze(cs);
  ok('سهم متقلّب بلا ضغط سابق لا يُعدّ «انطلق من ضغط»', !q.fired, `squeeze=${q.squeeze} fired=${q.fired}`);
}

H('فجوة القيمة العادلة — معنى الامتلاء');
{
  const cl = [];
  for (let i = 0; i < 20; i++) cl.push(20);
  const cs = fromCloses(cl, 0.002);
  /* فجوة صعودية: شمعة i−2 قمتها 20.04، وشمعة i قاعها 21 */
  cs.push({ time: cs[19].time + 86400, open: 20.1, close: 20.9, high: 21, low: 20.05, volume: 1e5 });
  cs.push({ time: cs[19].time + 2 * 86400, open: 21.1, close: 21.5, high: 21.6, low: 21, volume: 1e5 });
  /* السعر يعود ويختبر داخل الفجوة الآن */
  cs.push({ time: cs[19].time + 3 * 86400, open: 21.2, close: 20.6, high: 21.2, low: 20.5, volume: 1e5 });
  const f = ctx.calcFVG(cs);
  ok('فجوة يختبرها السعر الآن تبقى نشطة', f.gaps.some(g => g.type === 'bu'), `gaps=${f.gaps.length}`);
  cs.push({ time: cs[19].time + 4 * 86400, open: 20.5, close: 19.8, high: 20.5, low: 19.7, volume: 1e5 });
  const g = ctx.calcFVG(cs);
  ok('فجوة عبرها السعر كلياً لم تعد نشطة', !g.gaps.some(x => x.type === 'bu' && x.bot > 19.9 && x.bot < 20.1), `gaps=${JSON.stringify(g.gaps.map(x => [x.bot, x.top]))}`);
}

H('المستويات — لا تسلسل ولا عبور للسعر');
{
  /* سلّم كثيف من المستويات بفارق 0.4٪ فوق السعر: التجميع المتسلسل كان يضمّها
     عنقوداً واحداً وينجرف سعره إلى طرفه البعيد. */
  const cur = 20;
  const ind = { ma20: 20.08, ma50: 20.16, vwap: 20.24, boll: { u: 20.32, l: 19.6 }, sma200: [20.4] };
  const cs = fromCloses(walk(60, 11, 0, 0.001).map(x => +(x / 50 * 20).toFixed(2)));
  const sr = ctx.calcSupportResistance(cs, ind, cur);
  const r0 = sr.resistances[0];
  ok('أقرب مقاومة لا تنجرف إلى الطرف البعيد', r0 && r0.price <= 20.2, `r0=${r0 && r0.price} (${r0 && r0.sources.join(' + ')})`);
  ok('امتداد العنقود ضمن التسامح', sr.resistances.every(r => (r.hi - r.lo) / r.lo < 0.0061), JSON.stringify(sr.resistances.map(r => [r.lo, r.hi])));
  ok('لا مستوى تحت السعر داخل مقاومة', sr.resistances.every(r => r.lo >= cur) && sr.supports.every(s => s.hi < cur));
}

H('تصحيح الاختبارات المتعددة على خريطة المواعيد');
{
  /* 200 سهم كلها ضجيج: قيم p موزّعة بانتظام ⇒ نحو 10 تحت 0.05 بالصدفة */
  const map = {};
  for (let i = 0; i < 200; i++) {
    const p = (i + 0.5) / 200;
    map['S' + i] = p < 0.05 ? { state: 'ok', tier: 'cycle', p: p.toFixed(3), pNum: p, period: 20, bars: 3 } : { state: 'none', pNum: p };
  }
  const raw = Object.values(map).filter(e => e.tier === 'cycle').length;
  const r = ctx.applyTimeMapFDR(map);
  const after = Object.values(map).filter(e => e.tier === 'cycle').length;
  ok(`ضجيج خالص: ${raw} «دورة» بالصدفة ⇒ ${after} بعد التصحيح`, raw >= 8 && after === 0, JSON.stringify(r));
  ok('المُسقَط يحمل سببه ولا تاريخ فيه', Object.values(map).some(e => e.wasCycle && /Benjamini-Hochberg/.test(e.why) && e.bars == null));
  /* دورات حقيقية قوية تبقى */
  const m2 = {};
  for (let i = 0; i < 200; i++) m2['S' + i] = i < 5 ? { state: 'ok', tier: 'cycle', pNum: 1e-6, period: 30 } : { state: 'none', pNum: (i + 0.5) / 200 };
  ctx.applyTimeMapFDR(m2);
  ok('دورات قوية فعلاً تجتاز التصحيح', Object.values(m2).filter(e => e.tier === 'cycle').length === 5);
}

H('الهدف الفراكتالي — سقف الوصول');
{
  /* قمة حيّة قديمة جداً ثم هبوط طويل: التكملة لا تتجاوز أعلى سعر في 250 جلسة */
  const cl = [];
  for (let i = 0; i < 30; i++) cl.push(100 + i);
  for (let i = 0; i < 30; i++) cl.push(130 - i * 2);
  let p = 70; const w = walk(700, 13, 0, 0.004);
  for (const x of w) { p = +(70 * x / 50).toFixed(2); cl.push(Math.min(p, 95)); }
  ctx.G.cans.__f = fromCloses(cl); ctx.calcInd('__f');
  let L = null; try { L = ctx.tradeLevels('__f'); } catch (e) { }
  const reach = Math.max(...ctx.G.cans.__f.slice(-250).map(c => c.high));
  const bad = L && (L.targets || []).filter(t => t.kind === 'fractal' && t.price > reach + 1e-9);
  ok('لا هدف فراكتالي فوق المدى السنوي', !bad || !bad.length, bad && JSON.stringify(bad));
  delete ctx.G.cans.__f; delete ctx.G.ind.__f;
}

H('التكملة الفراكتالية — للهدف الثاني فقط');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  ok('لا هدف أول فراكتالي في خطة بلا هدف بنيوي', /if\(targets\.length===1&&window\.KSAEngine\)\{/.test(src) && !/if\(targets\.length<2&&window\.KSAEngine\)/.test(src));
}

H('التوافقي — القديم لا يُعدّ إشارة حيّة');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  ok('calcAllFilters يستبعد النموذج الموسوم stale', /const harm=\(harmAny&&!harmAny\.stale\)\?harmAny:null;/.test(src));
}

console.log('\n' + '═'.repeat(60));
console.log(`نجح ${pass} · فشل ${fail}`);
console.log('═'.repeat(60) + '\n');
process.exit(fail ? 1 : 0);
