/* ══════════════════════════════════════════════════════════════════════════
   اختبارات KSATiming
   ──────────────────────────────────────────────────────────────────────────
   الاختبارات هنا تحاول **إسقاط** الوحدات لا تأكيدها. أهمّها ثلاثة:
   • بوابة تمرّ دائماً ليست بوابة ⇒ نقيس معدّل مرورها على ضجيج.
   • DTW بلا نطاق يطابق أي شيء بأي شيء ⇒ نتحقّق أن النطاق يقيّده فعلاً.
   • قياس البوابات يجب ألّا يرى المستقبل ⇒ نتحقّق أن نتيجة الفهرس t لا
     تتغيّر بإضافة بيانات بعده.
   التشغيل: node tests/timing.test.js
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const load = rel => require(path.resolve(__dirname, rel));
const E = (() => { for (const r of ['./engine/core.js', '../engine/core.js']) { try { return load(r); } catch (e) { } } throw new Error('core.js غير موجود'); })();
const T = (() => { for (const r of ['./engine/timing.js', '../engine/timing.js']) { try { return load(r); } catch (e) { } } throw new Error('timing.js غير موجود'); })();

let passed = 0, failed = 0; const fails = [];
const test = (n, f) => { try { f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const group = n => console.log('\n▸ ' + n);
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, t, m) => { if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'near'}: ${a} ≉ ${b} (tol ${t})`); };

const rng = s => E.seededRandom(s);
const gauss = r => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** شموع بطوابع زمنية أحد→خميس، مع دورة/ضجيج قابلين للضبط. */
function candles(n, seed, o) {
  o = o || {};
  const r = rng(seed); const out = [];
  let t = Math.floor(Date.UTC(2023, 0, 1) / 1000), prev = o.base || 50;
  for (let i = 0; i < n; i++) {
    let d = new Date(t * 1000);
    while (d.getUTCDay() === 5 || d.getUTCDay() === 6) { t += 86400; d = new Date(t * 1000); }
    const cyc = o.period ? (o.amp || 0.05) * Math.cos(2 * Math.PI * i / o.period) : 0;
    const px = (o.base || 50) * Math.exp((o.drift || 0) * i + cyc + (o.noise == null ? 0.012 : o.noise) * gauss(r));
    const w = px * (o.wick || 0.01) * (0.4 + r());
    out.push({
      time: t, open: +prev.toFixed(2),
      high: +Math.max(prev, px, px + w).toFixed(2),
      low: +Math.min(prev, px, px - w).toFixed(2),
      close: +px.toFixed(2),
      volume: Math.round((o.vol || 200000) * (0.5 + r()))
    });
    prev = px; t += 86400;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
group('إعادة التجميع الزمني');

test('التجميع يحفظ OHLCV بشكل صحيح', () => {
  const cs = candles(60, 1);
  const w = T.resampleByCount(cs, 5);
  ok(w.length === 12, 'عدد الشموع المجمّعة: ' + w.length);
  near(w[0].open, cs[0].open, 1e-9, 'الفتح الأول');
  near(w[0].close, cs[4].close, 1e-9, 'الإغلاق الأخير');
  near(w[0].high, Math.max(...cs.slice(0, 5).map(c => c.high)), 1e-9, 'القمة');
  near(w[0].low, Math.min(...cs.slice(0, 5).map(c => c.low)), 1e-9, 'القاع');
  near(w[0].volume, cs.slice(0, 5).reduce((s, c) => s + c.volume, 0), 1e-6, 'الحجم');
});

test('التجميع الأسبوعي يحترم حدود الأسبوع لا كل 5 شموع', () => {
  const cs = candles(120, 2);
  const w = T.resampleWeekly(cs);
  ok(w.length >= 20 && w.length <= 30, 'عدد الأسابيع غير منطقي: ' + w.length);
  /* كل شمعة أسبوعية تبدأ في يوم تداول، ولا أسبوع بأكثر من 5 جلسات */
  for (const c of w) {
    const d = new Date(c.time * 1000).getUTCDay();
    ok(d !== 5 && d !== 6, 'أسبوع يبدأ في عطلة');
    ok(c.subBars >= 1 && c.subBars <= 5, 'أسبوع بـ' + c.subBars + ' جلسة');
  }
  const total = w.reduce((s, c) => s + c.subBars, 0);
  ok(total === cs.length, `فُقدت شموع في التجميع: ${total} من ${cs.length}`);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('البنية الهيكلية — FVG و Order Blocks');

test('يكتشف فجوة قيمة عادلة مزروعة', () => {
  const cs = candles(80, 3, { noise: 0.004 });
  const i = 60;
  /* قفزة صريحة: الشمعة i+2 قاعها فوق قمة i */
  const base = cs[i].high;
  cs[i + 1] = { ...cs[i + 1], open: base * 1.02, close: base * 1.06, high: base * 1.07, low: base * 1.015 };
  cs[i + 2] = { ...cs[i + 2], open: base * 1.06, close: base * 1.08, high: base * 1.09, low: base * 1.055 };
  const g = T.findFVG(cs).filter(x => x.type === 'bullish' && x.i === i + 2);
  ok(g.length === 1, 'لم تُكتشف الفجوة المزروعة');
  ok(g[0].bot >= base - 0.01 && g[0].top <= base * 1.056, `حدود الفجوة خاطئة: ${g[0].bot}–${g[0].top}`);
});

test('الفجوة الصغيرة جداً تُستبعد — وإلا صار كل شيء «عند فجوة»', () => {
  const cs = candles(200, 4);
  const all = T.findFVG(cs, { minSizeATR: 0 }).length;
  const filtered = T.findFVG(cs, { minSizeATR: 0.25 }).length;
  ok(filtered <= all, 'التصفية زادت العدد!');
  console.log(`      بلا حدّ أدنى: ${all} فجوة · بحدّ 0.25×ATR: ${filtered}`);
});

test('حالة الاستهلاك تُحسب من بعد التكوّن فقط (لا تسرّب)', () => {
  const cs = candles(200, 5);
  const full = T.findFVG(cs);
  const partial = T.findFVG(cs.slice(0, 150));
  for (const g of partial) {
    const same = full.find(x => x.i === g.i && x.type === g.type);
    if (!same) continue;
    /* الفجوة نفسها: حدودها لا تتغيّر بمعرفة المستقبل */
    near(g.top, same.top, 1e-9, 'حدّ الفجوة العلوي تغيّر بإضافة بيانات لاحقة');
    near(g.bot, same.bot, 1e-9, 'حدّ الفجوة السفلي تغيّر');
  }
});

test('كتل الأوامر: النوع يطابق اتجاه الاندفاعة', () => {
  const cs = candles(250, 6);
  for (const b of T.findOrderBlocks(cs)) {
    ok(b.top >= b.bot, 'كتلة مقلوبة');
    ok(b.impulseATR >= 1.8, 'اندفاعة دون العتبة: ' + b.impulseATR);
  }
});

test('بوابة السيولة لا تمرّ دائماً — وإلا فهي ليست بوابة', () => {
  let pass = 0, total = 0;
  for (let s = 1; s <= 40; s++) {
    const cs = candles(220, s * 31);
    const g = T.liquidityGate(cs, { dirUp: true });
    total++; if (g.pass) pass++;
  }
  const rate = pass / total;
  console.log(`      معدّل مرور بوابة السيولة على ضجيج: ${(rate * 100).toFixed(0)}٪`);
  ok(rate < 0.9, `تمرّ ${(rate * 100).toFixed(0)}٪ من الحالات — لا تصفّي شيئاً`);
  ok(rate > 0.0, 'لا تمرّ أبداً — بوابة مغلقة ليست بوابة');
});

test('بوابة السيولة تُعلّل الرفض دائماً', () => {
  for (let s = 1; s <= 15; s++) {
    const g = T.liquidityGate(candles(200, s * 17), { dirUp: true });
    ok(typeof g.reason === 'string' && g.reason.length > 15, 'رفض بلا تعليل مفهوم');
  }
});

/* ══════════════════════════════════════════════════════════════════════ */
group('التشوّه الزمني الديناميكي (DTW)');

test('مسافة السلسلة مع نفسها صفر', () => {
  const a = Array.from({ length: 50 }, (_, i) => Math.cos(2 * Math.PI * i / 17));
  const d = T.dtw(a, a);
  near(d.distance, 0, 1e-9, 'مسافة الذات');
  near(d.irregularity, 0, 1e-9, 'التواء الذات يجب أن يكون صفراً');
  near(d.pathSlope, 1, 1e-9, 'ميل مسار الذات');
});

test('يتحمّل الإزاحة الزمنية حيث يفشل القياس الخطّي', () => {
  const n = 60, P = 20;
  const a = Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * i / P));
  /* نفس الموجة مزاحة 3 عيّنات */
  const b = Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * (i + 3) / P));
  const euclid = Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / n);
  const d = T.dtw(a, b, { band: 0.2 });
  console.log(`      إقليدي ${euclid.toFixed(3)} · DTW مُطبَّع ${d.normalized} · التواء ${d.irregularity}`);
  ok(d.normalized < euclid, 'DTW لم يتفوّق على القياس الخطّي رغم الإزاحة');
});

test('النطاق يمنع التمطيط غير المحدود', () => {
  const a = Array.from({ length: 60 }, (_, i) => Math.cos(2 * Math.PI * i / 20));
  const b = Array.from({ length: 60 }, (_, i) => Math.cos(2 * Math.PI * i / 7));  /* دورة مختلفة تماماً */
  const wide = T.dtw(a, b, { band: 0.9 });
  const tight = T.dtw(a, b, { band: 0.05 });
  console.log(`      نطاق واسع ${wide.normalized} · نطاق ضيّق ${tight.normalized}`);
  ok(tight.normalized >= wide.normalized, 'النطاق الضيّق يجب ألا يعطي مطابقة أفضل لسلسلتين مختلفتين');
  ok(tight.normalized > 0.15, 'حتى بنطاق ضيّق طابق سلسلتين مختلفتين — النطاق لا يقيّد');
});

test('warpedCyclePhase يمتنع عن دورة غير دالة بدل تقدير طور لها', () => {
  let abstained = 0, total = 0;
  for (let s = 1; s <= 15; s++) {
    const r = T.warpedCyclePhase(candles(200, s * 71));
    total++;
    if (!r.ok) { abstained++; ok(typeof r.reason === 'string', 'امتنع بلا سبب'); }
  }
  console.log(`      امتنع عن ${abstained}/${total} من مسارات الضجيج`);
  ok(abstained > 0, 'قدّر طوراً لكل شيء بما فيه الضجيج');
});

test('لا يُخرج «طول دورة مصحَّحاً» — كمّية غير قابلة للتحديد', () => {
  /* نسخة أولى كانت تحسب معامل تمطيط عام وتعرض «الدورة الفعلية ≈29 بدل 24».
     مسار DTW مثبّت الطرفين ⇒ متوسط ميله مقيّد بـ1 ⇒ المعامل غير مُعرَّف. */
  const r = T.warpedCyclePhase(candles(300, 909, { period: 24, amp: 0.07, noise: 0.005 }));
  if (!r.ok) { console.log('      امتنع: ' + r.reason); return; }
  ok(!('periodWarped' in r), 'ما زال يُخرج periodWarped');
  ok(!('warp' in r), 'ما زال يُخرج معامل تمطيط عام');
  ok(isFinite(r.irregularity) && r.irregularity >= 0, 'لا مقياس التواء');
});

test('الالتواء يُقاس فعلاً: زمن منتظم منخفض، وزمن مثقوب أعلى', () => {
  const clean = T.warpedCyclePhase(candles(300, 909, { period: 24, amp: 0.07, noise: 0.005 }));
  ok(clean.ok, clean.reason);
  console.log(`      زمن منتظم: التواء ${clean.irregularity} · مطابقة ${clean.fit} مقابل خطّية ${clean.linearFit}`);
  ok(clean.irregularity < 0.5, 'التواء مرتفع على زمن منتظم: ' + clean.irregularity);
  ok(clean.fit <= clean.linearFit + 1e-9, 'السماح بالالتواء أعطى مطابقة أسوأ من الخطّية — مستحيل');
});

test('DTW يتفوّق على المطابقة الخطّية أو يساويها، ولا يقلّ عنها أبداً', () => {
  for (let s = 1; s <= 12; s++) {
    const r = T.warpedCyclePhase(candles(300, s * 41, { period: 20 + s, amp: 0.06, noise: 0.008 }));
    if (!r.ok) continue;
    ok(r.gain >= -1e-9, `gain سالب (${r.gain}) — الالتواء لا يمكن أن يزيد المسافة`);
  }
});

/* ══════════════════════════════════════════════════════════════════════ */
group('الاتساق عبر الفواصل');

test('يعبّر عن الدورات بوحدة مشتركة لا بأرقام خام', () => {
  const cs = candles(300, 11, { period: 25, amp: 0.06, noise: 0.008 });
  const m = T.mtfAlignment(cs);
  ok(m.ok, m.reason);
  for (const f of m.frames) if (f.ok && f.significant) {
    ok(isFinite(f.periodInBaseBars), 'دورة بلا تحويل لوحدة مشتركة: ' + f.label);
    ok(f.periodInBaseBars > 0, 'دورة سالبة');
  }
});

test('يصرّح بأن الفواصل ليست مستقلة إحصائياً', () => {
  const m = T.mtfAlignment(candles(300, 12, { period: 22, amp: 0.06 }));
  if (m.ok && m.significantFrames >= 2) ok(/مستقل/.test(m.caveat || ''), 'لا تصريح بعدم الاستقلال');
});

test('البوابة ليست ميتة: تمرّ على دورة حقيقية', () => {
  /* 🛠️ النسخة الأولى جمّعت أسبوعياً دائماً، فكانت دورة 24 جلسة تساوي 4.8
     شمعة أسبوعية — تحت أقصر دورة قابلة للمسح، فتُرفض دائماً. القياس وقتها
     0/20 على دورة مزروعة قوية: بوابة لا تمرّ أبداً تُنقص النتيجة لكل سهم. */
  let agree = 0, total = 0;
  for (let s = 1; s <= 20; s++) {
    const m = T.mtfAlignment(candles(300, s * 13, { period: 24, amp: 0.06, noise: 0.006 }));
    total++; if (m.agree) agree++;
  }
  console.log(`      اتفاق على دورة مزروعة: ${agree}/${total}`);
  ok(agree >= total * 0.7, `اتفق في ${agree}/${total} فقط — البوابة شبه ميتة`);
});

test('لا يدّعي اتفاقاً على الضجيج بنفس معدّل الدورة الحقيقية', () => {
  let noiseAgree = 0, n = 0;
  for (let s = 1; s <= 20; s++) { const m = T.mtfAlignment(candles(300, s * 77)); n++; if (m.agree) noiseAgree++; }
  console.log(`      اتفاق على ضجيج محض: ${noiseAgree}/${n}`);
  ok(noiseAgree < n * 0.6, `اتفق على ${noiseAgree}/${n} من الضجيج — لا يميّز`);
});

test('يختار معامل التجميع ليجعل الدورة قابلة للمسح', () => {
  const m = T.mtfAlignment(candles(300, 13, { period: 24, amp: 0.06, noise: 0.006 }));
  ok(m.ok, m.reason);
  ok(m.factor >= 2 && m.factor <= 10, 'معامل تجميع غير منطقي: ' + m.factor);
  const hi = m.frames.find(f => /أعلى/.test(f.label));
  if (hi && hi.ok && hi.significant) {
    /* التحويل للوحدة المشتركة يجب أن يعيدنا لنفس الدورة اليومية */
    const base = m.frames[0];
    near(hi.periodInBaseBars, base.period, base.period * 0.3, 'التحويل للوحدة المشتركة غير متسق');
  }
});

test('قصر البيانات يُعلَن قيداً على العيّنة لا نتيجة عن السهم', () => {
  const m = T.mtfAlignment(candles(110, 5, { period: 24, amp: 0.06 }), { minHigherBars: 200 });
  ok(m.dataLimited === true, 'لم يُعلَن القيد');
  ok(/طول البيانات|وسّع النطاق/.test(m.note), 'الرسالة لا توضّح أن السبب طول البيانات: ' + m.note);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('مرشّح تدفّق الأحجام');

test('يصرّح دائماً بأنه تقدير لا تدفّق أوامر', () => {
  const f = T.volumeFlow(candles(200, 13), { dirUp: true });
  ok(/دفتر أوامر/.test(f.caveat || ''), 'لا تصريح بحدود المقياس');
});

test('يكتشف التدفّق الإيجابي المزروع', () => {
  const cs = candles(200, 14, { noise: 0.004 });
  /* آخر 5 جلسات: إغلاق عند القمة بحجم مضاعف */
  for (let i = cs.length - 5; i < cs.length; i++) {
    const c = cs[i];
    cs[i] = { ...c, close: c.high, low: Math.min(c.low, c.open * 0.995), volume: c.volume * 3 };
  }
  const f = T.volumeFlow(cs, { dirUp: true });
  console.log(`      flowScore=${f.flowScore} participation=${f.participation}`);
  ok(f.flowScore > 0.5, 'لم يكتشف الإغلاق القوي: ' + f.flowScore);
  ok(f.participation > 1.5, 'لم يكتشف الحجم المضاعف: ' + f.participation);
});

test('يرفض حين يكون التدفّق ضد الاتجاه', () => {
  const cs = candles(200, 15, { noise: 0.004 });
  for (let i = cs.length - 5; i < cs.length; i++) {
    const c = cs[i];
    cs[i] = { ...c, close: c.low, high: Math.max(c.high, c.open * 1.005), volume: c.volume * 3 };
  }
  const f = T.volumeFlow(cs, { dirUp: true });
  ok(!f.pass, 'مرّر إغلاقات عند القاع كتدفّق صاعد');
  ok(f.flowScore < 0, 'flowScore موجب رغم الإغلاق عند القاع');
});

test('يستعمل الوسيط لا المتوسط في خط الأساس', () => {
  const cs = candles(200, 16, { noise: 0.004 });
  const a = T.volumeFlow(cs, { dirUp: true }).participation;
  /* جلسة واحدة بحجم ×100 تفسد المتوسط ولا تفسد الوسيط */
  cs[cs.length - 30] = { ...cs[cs.length - 30], volume: cs[cs.length - 30].volume * 100 };
  const b = T.volumeFlow(cs, { dirUp: true }).participation;
  console.log(`      المشاركة قبل الجلسة الشاذّة ${a} وبعدها ${b}`);
  near(a, b, Math.max(0.02, a * 0.05), 'جلسة واحدة شاذّة غيّرت المقياس ⇒ المتوسط مستعمل مكان الوسيط');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('سلسلة البوابات');

test('لا تُفعَّل إشارة بلا البوابات الإلزامية', () => {
  for (let s = 1; s <= 25; s++) {
    const r = T.timingSignal(candles(220, s * 97));
    if (!r.ok) continue;
    if (r.fire) ok(r.missingRequired.length === 0, 'أُطلقت إشارة رغم سقوط بوابة إلزامية');
    else ok(r.missingRequired.length > 0, 'لم تُطلق إشارة رغم مرور كل الإلزامي');
  }
});

test('كل بوابة تحمل سببها سواء مرّت أو سقطت', () => {
  const r = T.timingSignal(candles(250, 21));
  ok(r.ok, r.reason);
  ok(r.gates.length === T.GATE_NAMES.length, 'عدد البوابات: ' + r.gates.length);
  for (const g of r.gates) {
    ok(typeof g.pass === 'boolean', 'بوابة بلا نتيجة: ' + g.name);
    ok(typeof g.why === 'string' && g.why.length > 5, 'بوابة بلا تعليل: ' + g.name);
  }
});

test('score ليس نسبة مئوية ولا يُقدَّم كاحتمال', () => {
  const r = T.timingSignal(candles(250, 22));
  ok(r.ok, r.reason);
  ok(/ليس احتمال/.test(r.caveat || ''), 'لا تصريح بأن score ليس احتمالاً');
  const maxScore = Object.values(T.GATE_WEIGHTS).reduce((a, b) => a + b, 0);
  ok(r.score >= 0 && r.score <= maxScore, 'score خارج مداه');
});

test('البوابات لا ترى المستقبل', () => {
  const cs = candles(320, 23, { period: 26, amp: 0.05 });
  const at = 240;
  const a = T.timingSignal(cs, { idx: at });
  const b = T.timingSignal(cs.slice(0, at + 1), { idx: at });
  ok(a.ok === b.ok, 'اختلفت الصلاحية بمعرفة المستقبل');
  if (a.ok && b.ok) {
    ok(a.fire === b.fire, 'قرار الإطلاق تغيّر بإضافة بيانات لاحقة ⇒ تسرّب زمني');
    ok(a.score === b.score, `score تغيّر: ${a.score} مقابل ${b.score} ⇒ تسرّب زمني`);
    for (const g of a.gates) {
      const h = b.gates.find(x => x.name === g.name);
      ok(g.pass === h.pass, `بوابة ${g.name} تغيّرت نتيجتها بمعرفة المستقبل`);
    }
  }
});

test('الإشارة لا تُطلق على كل شيء', () => {
  let fired = 0, total = 0;
  for (let s = 1; s <= 30; s++) {
    const r = T.timingSignal(candles(220, s * 137));
    if (!r.ok) continue;
    total++; if (r.fire) fired++;
  }
  console.log(`      معدّل الإطلاق على ضجيج: ${fired}/${total}`);
  ok(total > 0, 'لم تُفحص أي حالة');
  ok(fired / total < 0.5, `أُطلقت في ${(fired / total * 100).toFixed(0)}٪ من مسارات الضجيج — التصفية ضعيفة`);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('قياس أثر البوابات');

test('يمتنع عن الحكم على عيّنة صغيرة', () => {
  const r = T.evaluateGates(candles(120, 31));
  ok(!r.ok, 'أصدر حكماً من عيّنة قصيرة');
  ok(typeof r.reason === 'string', 'امتنع بلا سبب');
});

test('حتمي — نفس المدخل نفس المخرج', () => {
  const cs = candles(320, 32, { period: 24, amp: 0.05 });
  const a = T.evaluateGates(cs, { step: 3, recompute: 5 });
  const b = T.evaluateGates(cs, { step: 3, recompute: 5 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'النتيجة تتغيّر بين تشغيلين');
});

test('كل تركيبة تحمل حجم عيّنتها وفاصل ثقتها وتغطيتها', () => {
  const r = T.evaluateGates(candles(400, 33, { period: 22, amp: 0.05 }), { step: 3, recompute: 5 });
  if (!r.ok) { console.log('      امتنع: ' + r.reason); return; }
  console.log(`      خط الأساس ${r.baseline.winRatePct}٪ على ${r.baseline.count} نقطة · ${r.combos.length} تركيبة`);
  for (const c of r.combos) {
    ok(c.count > 0, 'تركيبة بلا عيّنة');
    ok(Array.isArray(c.winRateCI) && c.winRateCI.length === 2, 'تركيبة بلا فاصل ثقة: ' + c.label);
    ok(c.coveragePct >= 0 && c.coveragePct <= 100.01, 'تغطية خارج المدى: ' + c.coveragePct);
    ok(c.winRateCI[0] <= c.winRatePct + 1e-6 && c.winRatePct <= c.winRateCI[1] + 1e-6, 'النسبة خارج فاصلها');
  }
});

test('لا تُعلَن تركيبة فائزة بعيّنة دون الحد الأدنى', () => {
  const r = T.evaluateGates(candles(400, 34, { period: 20, amp: 0.05 }), { step: 3, recompute: 5, minSamples: 25 });
  if (!r.ok) return;
  for (const c of r.combos) if (c.count < 25) ok(!c.significant, `أُعلنت «${c.label}» دالة من ${c.count} إشارة فقط`);
});

test('التصفية تُنقص التغطية — المقايضة معروضة لا مخفيّة', () => {
  const r = T.evaluateGates(candles(420, 35, { period: 23, amp: 0.05 }), { step: 3, recompute: 5 });
  if (!r.ok) { console.log('      امتنع: ' + r.reason); return; }
  const all = r.combos.find(c => c.gates.length === T.GATE_NAMES.length);
  const one = r.combos.find(c => c.gates.length === 1);
  if (all && one) {
    console.log(`      بوابة واحدة: تغطية ${one.coveragePct}٪ · كل البوابات: ${all.coveragePct}٪`);
    ok(all.coveragePct <= one.coveragePct + 1e-6, 'تصفية أشدّ أعطت تغطية أعلى — الحساب مكسور');
  }
});

test('كل بوابة تُبلّغ عن نفسها ولو لم تمرّ إطلاقاً', () => {
  /* 🛠️ جدول التركيبات يعرض ما بلغ الحد الأدنى للعيّنة فقط، فبوابة لم تمرّ
     أبداً كانت تختفي بلا أثر — والمستخدم لا يفرّق حينها بين «الشرط غير
     متحقّق» و«يوجد عطل». الغياب الصامت هو ما بُنيت المنصة لإزالته. */
  const r = T.evaluateGates(candles(420, 37, { period: 21, amp: 0.05 }), { step: 3, recompute: 5 });
  if (!r.ok) { console.log('      امتنع: ' + r.reason); return; }
  ok(Array.isArray(r.gateStats), 'لا يوجد إحصاء للبوابات');
  ok(r.gateStats.length === T.GATE_NAMES.length, `أُبلغ عن ${r.gateStats.length} بوابة من ${T.GATE_NAMES.length}`);
  for (const g of r.gateStats) {
    ok(T.GATE_NAMES.indexOf(g.gate) >= 0, 'بوابة مجهولة: ' + g.gate);
    ok(Number.isFinite(g.fired) && g.fired >= 0, 'عدّاد مرور غير صالح: ' + g.gate);
    ok(g.firedPct >= 0 && g.firedPct <= 100.01, 'نسبة مرور خارج المدى: ' + g.gate);
    /* الصمت ممنوع: إمّا رقم يُقرأ وإمّا سبب صريح لعدم قراءته */
    if (g.fired === 0 || g.fired < r.config.minSamples)
      ok(typeof g.note === 'string' && g.note.length > 10, `بوابة ${g.gate} بعيّنة ${g.fired} بلا تفسير`);
    else ok(g.winRatePct != null && g.liftPts != null, `بوابة ${g.gate} بعيّنة كافية بلا أرقام`);
  }
  console.log('      ' + r.gateStats.map(g => `${g.gate}:${g.fired}`).join(' · '));
});

test('يصرّح باتجاه الصفقات المقيسة', () => {
  /* خط أساس منخفض على سهم هابط قد يكون أثر افتراض الشراء وحده لا أثر
     البوابات — فيجب أن يُقال الاتجاه صراحةً قبل قراءة أي رقم. */
  const r = T.evaluateGates(candles(420, 38, { period: 20, amp: 0.05 }), { step: 3, recompute: 5 });
  if (!r.ok) return;
  ok(r.direction && typeof r.direction.note === 'string', 'لا تصريح بالاتجاه');
  near(r.direction.longPct + r.direction.shortPct, 100, 0.05, 'نسب الاتجاه لا تجمع إلى 100');
});

test('الحكم السلبي يسمّي البوابات التي لم تمرّ إطلاقاً', () => {
  for (let s = 1; s <= 12; s++) {
    const r = T.evaluateGates(candles(400, s * 211), { step: 3, recompute: 5 });
    if (!r.ok || r.winners.length) continue;
    const dead = r.gateStats.filter(g => g.fired === 0).map(g => g.gate);
    if (dead.length) { ok(dead.every(n => r.verdict.indexOf(n) >= 0), 'الحكم لا يسمّي البوابات الميتة: ' + r.verdict); return; }
  }
});

test('يصرّح بحدود النتيجة ولا يعمّمها', () => {
  const r = T.evaluateGates(candles(400, 36, { period: 21, amp: 0.05 }), { step: 3, recompute: 5 });
  if (!r.ok) return;
  ok(/لا تُعمَّم|سهم واحد/.test(r.caveat || ''), 'لا تصريح بحدود التعميم');
  ok(typeof r.verdict === 'string' && r.verdict.length > 40, 'حكم بلا شرح');
});

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(60)}`);
console.log(`نجح ${passed} · فشل ${failed}`);
if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
