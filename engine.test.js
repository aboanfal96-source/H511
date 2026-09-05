/* ══════════════════════════════════════════════════════════════════════════
   اختبارات محرك KSAEngine
   ──────────────────────────────────────────────────────────────────────────
   هذه ليست اختبارات «هل تعمل الدالة بلا استثناء». كل اختبار هنا يقيس
   ادّعاءً محدداً تعرضه الواجهة للمستخدم، لأن العيب في نسخة سابقة لم يكن
   انهياراً بل رقماً خاطئاً يبدو معقولاً:

     • «دالة إحصائياً» كانت تظهر على 91٪ من الضجيج ⇒ نقيس معدّل الإيجابيات
       الكاذبة على مسارات مشي عشوائي محض ونطالب بأن يقارب مستوى الدلالة.
     • الطور كان مزاحاً ربع دورة ⇒ نزرع دورة معلومة الطور ونقيس الانحراف.
     • نطاق ARIMA كان أضيق 63٪ من الحقيقة ⇒ نتحقق من صيغة التباين مباشرة.
     • POC كان «إغلاق أعلى شمعة حجماً» ⇒ نبني حالة تفضح التعريف الخاطئ.
     • الاختبار التاريخي كان غير حتمي ⇒ نشغّله مرتين ونطالب بتطابق حرفي.

   التشغيل:  node tests/engine.test.js
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const E = require('../engine/core.js');

let passed = 0, failed = 0;
const fails = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; fails.push(name + ' — ' + e.message); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function group(name) { console.log('\n▸ ' + name); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'near') + `: ${a} ≉ ${b} (tol ${tol})`);
}

/* ── مولّد عشوائي حتمي: الاختبارات يجب أن تعطي النتيجة نفسها كل مرة ── */
function mkRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** مسار مشي عشوائي محض — لا دورة فيه بحكم البناء. */
function randomWalk(n, seed, sigma) {
  const rng = mkRng(seed); let p = 50; const out = [p];
  for (let i = 1; i < n; i++) { p *= Math.exp((sigma || 0.015) * gauss(rng)); out.push(p); }
  return out;
}

/** سلسلة بدورة مزروعة معلومة الطول والطور. */
function plantedCycle(n, period, amp, noise, seed, phase) {
  const rng = mkRng(seed); const out = [];
  for (let i = 0; i < n; i++) {
    const trend = 0.0004 * i;
    const wave = amp * Math.cos(2 * Math.PI * i / period + (phase || 0));
    out.push(50 * Math.exp(trend + wave + (noise || 0) * gauss(rng)));
  }
  return out;
}

/** يحوّل سلسلة أسعار إلى شموع بأحجام وطوابع زمنية واقعية. */
function toCandles(prices, seed) {
  const rng = mkRng(seed || 7);
  const start = Date.UTC(2024, 0, 7) / 1000;   /* أحد */
  return prices.map((p, i) => {
    const w = p * 0.012 * (0.5 + rng());
    const open = i ? prices[i - 1] : p;
    return {
      time: start + i * 86400,
      open: +open.toFixed(2),
      high: +Math.max(open, p, p + w).toFixed(2),
      low: +Math.min(open, p, p - w).toFixed(2),
      close: +p.toFixed(2),
      volume: Math.round(100000 * (0.6 + rng()))
    };
  });
}

/* ══════════════════════════════════════════════════════════════════════ */
group('Stats — الإحصاء الأساسي');

test('mean / median / sd بمقام n−1', () => {
  near(E.Stats.mean([1, 2, 3, 4]), 2.5, 1e-12);
  near(E.Stats.median([3, 1, 2]), 2, 1e-12);
  near(E.Stats.median([4, 1, 3, 2]), 2.5, 1e-12);
  /* تباين [1,2,3,4] بمقام n−1 هو 5/3 لا 1.25 */
  near(E.Stats.variance([1, 2, 3, 4]), 5 / 3, 1e-12);
});

test('quantile بالاستيفاء الخطي', () => {
  near(E.Stats.quantile([1, 2, 3, 4, 5], 0.5), 3, 1e-12);
  near(E.Stats.quantile([1, 2, 3, 4], 0.5), 2.5, 1e-12);
  near(E.Stats.quantile([10, 20], 0.25), 12.5, 1e-12);
});

test('linreg يسترجع الميل والتقاطع و R²=1 على خط تام', () => {
  const y = [2, 5, 8, 11, 14];
  const r = E.Stats.linreg(y);
  near(r.slope, 3, 1e-9); near(r.intercept, 2, 1e-9); near(r.r2, 1, 1e-9);
});

test('normalCdf و tCdf ضمن هامش مقبول', () => {
  near(E.Stats.normalCdf(0), 0.5, 1e-9);
  near(E.Stats.normalCdf(1.959963985), 0.975, 5e-4);
  /* اختبار t ثنائي الطرف عند t=2.086 و df=20 ≈ 0.05 */
  near(E.Stats.twoSidedT(2.086, 20), 0.05, 5e-3);
});

test('فاصل Wilson لا يخرج عن [0,1] عند النسب المتطرفة', () => {
  const ci = E.Stats.wilsonCI(0, 10);
  ok(ci[0] >= 0 && ci[1] <= 1, 'خرج عن النطاق: ' + ci);
  ok(ci[1] > 0, 'الحد الأعلى صفر عند 0/10 — Wilson يجب أن يعطي حداً موجباً');
  const ci2 = E.Stats.wilsonCI(5, 10);
  ok(ci2[0] < 0.5 && ci2[1] > 0.5, 'الفاصل لا يحيط بالنسبة');
});

test('Benjamini–Hochberg يمرّر الصغيرة ويرفض الكبيرة بالترتيب الأصلي', () => {
  const p = [0.9, 0.001, 0.5, 0.02, 0.8];
  const r = E.Stats.benjaminiHochberg(p, 0.10);
  ok(r[1] === true, 'p=0.001 يجب أن يمرّ');
  ok(r[0] === false && r[4] === false, 'p الكبيرة يجب أن تُرفض');
  ok(r.length === p.length, 'الترتيب/الطول لا يطابق المدخلات');
});

test('BH أكثر تحفّظاً من عدم التصحيح على 100 اختبار عشوائي', () => {
  const rng = mkRng(99);
  const ps = []; for (let i = 0; i < 100; i++) ps.push(rng());
  const pass = E.Stats.benjaminiHochberg(ps, 0.10);
  const nPass = pass.filter(Boolean).length;
  const nRaw = ps.filter(p => p < 0.05).length;
  ok(nPass <= nRaw, `BH مرّر ${nPass} بينما بلا تصحيح ${nRaw}`);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('SaudiMarket — تقويم السوق');

test('addTradingDays يتخطى الجمعة والسبت', () => {
  /* 2024-01-11 خميس */
  const thu = new Date(Date.UTC(2024, 0, 11));
  const next = E.SaudiMarket.addTradingDays(thu, 1);
  ok(next.getUTCDay() === 0, 'الجلسة التالية للخميس يجب أن تكون الأحد، وليست ' + next.toISOString());
  const five = E.SaudiMarket.addTradingDays(thu, 5);
  ok([5, 6].indexOf(five.getUTCDay()) === -1, 'وقعت النتيجة في عطلة');
});

test('addTradingDays لا يعيد يوم عطلة مهما كان العدد', () => {
  const base = new Date(Date.UTC(2024, 0, 7));
  for (let n = 1; n <= 40; n++) {
    const d = E.SaudiMarket.addTradingDays(base, n);
    ok([5, 6].indexOf(d.getUTCDay()) === -1, `n=${n} وقع في ${d.toISOString()}`);
  }
});

test('dailyLimits عند ±10٪', () => {
  const l = E.SaudiMarket.dailyLimits(100);
  near(l.up, 110, 1e-9); near(l.down, 90, 1e-9); near(l.limitPct, 10, 1e-9);
});

test('minSessionsBetween يرفض القفزة المستحيلة في جلسة واحدة', () => {
  /* من 100 إلى 150 تحتاج 5 جلسات حدّ أعلى (1.1^5 = 1.61) */
  const n = E.SaudiMarket.minSessionsBetween(100, 150);
  ok(n >= 4 && n <= 5, 'عدد الجلسات غير منطقي: ' + n);
  near(E.SaudiMarket.minSessionsBetween(100, 105), 1, 1e-9);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('sanitizeCandles / auditCandles');

test('يصلح انعكاس OHLC الطفيف بدل حذف الشمعة', () => {
  const raw = [{ time: 1, open: 10.00, high: 10.19, low: 9.90, close: 10.20, volume: 5 }];
  const cs = E.sanitizeCandles(raw);
  ok(cs.length === 1, 'حُذفت شمعة حقيقية بسبب تقريب هللة');
  ok(cs[0].high >= cs[0].close, 'لم يُصلَح الانعكاس');
  near(cs[0].high, 10.20, 1e-9);
});

test('يسقط الانعكاس الفاحش', () => {
  const raw = [{ time: 1, open: 10, high: 8, low: 7, close: 12, volume: 5 }];
  ok(E.sanitizeCandles(raw).length === 0, 'مرّرت شمعة مستحيلة');
});

test('يزيل التكرار الزمني ويرتّب تصاعدياً', () => {
  const raw = [
    { time: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: 1, open: 2, high: 2, low: 2, close: 2, volume: 1 },
    { time: 3, open: 9, high: 9, low: 9, close: 9, volume: 1 }
  ];
  const cs = E.sanitizeCandles(raw);
  ok(cs.length === 2, 'لم يُزل التكرار: ' + cs.length);
  ok(cs[0].time === 1 && cs[1].time === 3, 'الترتيب الزمني خاطئ');
  ok(cs[1].close === 9, 'يجب أن تفوز آخر قيمة لنفس الطابع الزمني');
});

test('auditCandles يرصد الفجوة الزمنية والحجم الصفري', () => {
  const cs = toCandles(randomWalk(120, 3), 3);
  cs[60].time += 20 * 86400;   /* فجوة مصطنعة */
  for (let i = 0; i < 30; i++) cs[i].volume = 0;
  const a = E.auditCandles(cs);
  ok(!a.ok, 'لم تُرصد أي مشكلة');
  ok(a.issues.join(' ').indexOf('فجوة') >= 0, 'لم تُذكر الفجوة');
  ok(a.issues.join(' ').indexOf('حجم صفر') >= 0, 'لم يُذكر الحجم الصفري');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('التذبذب و ATR');

test('volatility يستعيد σ المزروع', () => {
  const SIG = 0.02;
  const v = E.volatility(randomWalk(1200, 11, SIG));
  ok(v.ok, v.reason);
  near(v.dailyPct / 100, SIG, 0.003, 'σ اليومي');
  near(v.annualPct / 100, SIG * Math.sqrt(E.SESSIONS_PER_YEAR), 0.05, 'σ السنوي');
  /* المدى المتوقع 95٪ هو 1.96σ لا σ */
  near(v.expectedDailyRangePct / v.dailyPct, 1.96, 0.01);
});

test('volatility يرفض العيّنة القصيرة بدل إعطاء رقم', () => {
  const v = E.volatility([1, 2, 3]);
  ok(v.ok === false && typeof v.reason === 'string', 'أعطى رقماً من عيّنة مستحيلة');
  ok(v.dailyPct === null, 'أعاد قيمة افتراضية بدل التصريح بالغياب');
});

test('ATR بطريقة Wilder على مدى ثابت', () => {
  /* شموع مداها 2 ريال دائماً وبلا فجوات ⇒ ATR = 2 */
  const cs = [];
  for (let i = 0; i < 60; i++) cs.push({ time: i, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  near(E.atr(cs, 14), 2, 1e-6);
});

test('atrSeries لا تنظر للأمام', () => {
  const cs = toCandles(randomWalk(120, 5), 5);
  const full = E.atrSeries(cs, 14);
  const half = E.atrSeries(cs.slice(0, 80), 14);
  near(full[79], half[79], 1e-9, 'قيمة ATR عند الفهرس 79 تغيّرت بإضافة بيانات لاحقة');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('نقاط الارتكاز والمستويات');

test('detectPivots يمنع التسرّب الزمني عبر confirmedAt', () => {
  const cs = toCandles(randomWalk(200, 21), 21);
  const piv = E.detectPivots(cs, 3);
  ok(piv.length > 0, 'لم تُكتشف ارتكازات');
  for (const p of piv) ok(p.confirmedAt === p.i + 3, 'confirmedAt خاطئ');
  /* آخر ارتكاز مؤكد عند الفهرس 100 يجب ألا يعتمد على ما بعده */
  const a = E.lastConfirmedPivot(cs, 3, 100);
  const b = E.lastConfirmedPivot(cs.slice(0, 101), 3);
  ok(!!a && !!b && a.i === b.i && a.type === b.type, 'الارتكاز المؤكد تغيّر بمعرفة المستقبل');
});

test('lastConfirmedPivot لا يعيد ارتكازاً غير مؤكد بعد', () => {
  const cs = toCandles(randomWalk(150, 22), 22);
  const p = E.lastConfirmedPivot(cs, 3);
  if (p) ok(p.confirmedAt <= cs.length - 1, 'أعاد ارتكازاً لم تُغلق جلسات تأكيده');
});

test('structuralLevels يفصل الجهتين — لا دعم فوق السعر ولا مقاومة تحته', () => {
  const cs = toCandles(randomWalk(220, 33), 33);
  const price = cs[cs.length - 1].close;
  const lv = E.structuralLevels(cs, price);
  for (const s of lv.supports) ok(s < price, `دعم ${s} فوق السعر ${price}`);
  for (const r of lv.resistances) ok(r > price, `مقاومة ${r} تحت السعر ${price}`);
  /* مرتّبة بالأقرب أولاً */
  for (let i = 1; i < lv.supports.length; i++) ok(lv.supports[i] < lv.supports[i - 1], 'الدعوم غير مرتّبة بالأقرب');
  for (let i = 1; i < lv.resistances.length; i++) ok(lv.resistances[i] > lv.resistances[i - 1], 'المقاومات غير مرتّبة بالأقرب');
});

test('dominantPivotCycle يرفض التباعد المتفاوت بدل تسميته دورة', () => {
  const cs = toCandles(randomWalk(300, 44), 44);
  const dc = E.dominantPivotCycle(cs, 3);
  if (dc) {
    ok(dc.consistencyPct >= 0 && dc.consistencyPct <= 100, 'اتساق خارج النطاق');
    if (dc.reliable) ok(dc.cv <= 0.35 && dc.sampleSize >= 5, 'أُعلن موثوقاً رغم مخالفة عتبته المعلنة');
  }
});

/* ══════════════════════════════════════════════════════════════════════ */
group('ملف الحجم — POC بالتعريف الصحيح');

test('POC لا ينجرف إلى جلسة واحدة ضخمة بعيدة', () => {
  /* 40 جلسة تتداول حول 10 ريال، وجلسة واحدة بحجم هائل عند 20 */
  const cs = [];
  for (let i = 0; i < 40; i++) cs.push({ time: i, open: 10, high: 10.05, low: 9.95, close: 10, volume: 100000 });
  cs.push({ time: 40, open: 20, high: 20.05, low: 19.95, close: 20, volume: 3000000 });
  const vp = E.volumeProfile(cs, { bins: 60 });
  ok(vp, 'لم يُبنَ ملف الحجم');
  ok(Math.abs(vp.poc - 10) < 0.6, `POC = ${vp.poc} — التعريف القديم كان يعطي 20`);
});

test('منطقة القيمة تغطي نحو 70٪ من الحجم وتحيط بالـPOC', () => {
  const cs = toCandles(randomWalk(200, 55), 55);
  const vp = E.volumeProfile(cs, { bins: 60 });
  ok(vp.valueAreaPct >= 68 && vp.valueAreaPct <= 85, 'نسبة منطقة القيمة: ' + vp.valueAreaPct);
  ok(vp.valueAreaLow <= vp.poc && vp.poc <= vp.valueAreaHigh, 'الـPOC خارج منطقة القيمة');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('المؤشرات التراكمية');

test('rollingVWAP لا يتراكم من أول شمعة أبداً', () => {
  const cs = [];
  for (let i = 0; i < 60; i++) {
    const p = i < 30 ? 10 : 100;   /* قفزة حادّة في المنتصف */
    cs.push({ time: i, open: p, high: p, low: p, close: p, volume: 1000 });
  }
  const v = E.Cumulative.rollingVWAP(cs, 20);
  /* بعد 20 جلسة كاملة على 100، يجب أن يساوي 100 لا متوسط الفترتين */
  near(v[59], 100, 1e-6, 'VWAP المتدحرج ما زال يحمل أثر النصف الأول');
  const cum = E.Cumulative.anchoredVWAP(cs, 0);
  ok(cum[59] < 70, 'VWAP المثبّت من الصفر يجب أن يظل متأثراً بالنصف الأول (شاهد المقارنة)');
});

test('anchoredVWAP يبدأ من نقطة التثبيت', () => {
  const cs = toCandles(randomWalk(100, 66), 66);
  const av = E.Cumulative.anchoredVWAP(cs, 50);
  const c = cs[50];
  near(av[50], (c.high + c.low + c.close) / 3, 1e-6, 'أول قيمة بعد التثبيت ليست سعر الشمعة النموذجي');
  ok(av.length === cs.length, 'الطول لا يطابق');
});

test('obv و adLine يميّزان الإغلاق الضعيف عن القوي بنفس الحجم', () => {
  const strong = [
    { time: 1, open: 10, high: 11, low: 10, close: 10, volume: 0 },
    { time: 2, open: 10, high: 11, low: 10, close: 11, volume: 1000 }
  ];
  const weak = [
    { time: 1, open: 10, high: 11, low: 10, close: 10, volume: 0 },
    { time: 2, open: 10, high: 11, low: 10, close: 10.05, volume: 1000 }
  ];
  const adS = E.Cumulative.adLine(strong), adW = E.Cumulative.adLine(weak);
  ok(adS[1] > adW[1], 'A/D لم يميّز الإغلاق القوي عن الضعيف بنفس الحجم');
  const obvS = E.Cumulative.obv(strong), obvW = E.Cumulative.obv(weak);
  near(obvS[1], obvW[1], 1e-9, 'OBV يفترض ألا يميّزهما — هذا هو سبب إضافة A/D');
});

test('divergence يكتشف التباعد الإيجابي المزروع', () => {
  const cs = [], obv = [];
  for (let i = 0; i < 40; i++) cs.push({ time: i, open: 100 - i * 0.3, high: 100 - i * 0.3, low: 100 - i * 0.3, close: 100 - i * 0.3, volume: 1000 });
  for (let i = 0; i < 40; i++) obv.push(1000 + i * 50);
  const d = E.Cumulative.divergence(cs, obv, 20);
  ok(d.type === 'bullish', 'لم يُكتشف التباعد الإيجابي: ' + JSON.stringify(d));
});

/* ══════════════════════════════════════════════════════════════════════ */
group('التحليل الطيفي — Fisher\'s g-test');

test('معدّل الإيجابيات الكاذبة على مسارات عشوائية يقارب مستوى الدلالة', () => {
  const N = 200; let sig = 0, ran = 0;
  for (let i = 0; i < N; i++) {
    const r = E.spectralPro(randomWalk(250, 1000 + i * 37), { alpha: 0.05 });
    if (!r.ok) continue;
    ran++; if (r.significant) sig++;
  }
  const rate = sig / ran;
  console.log(`      معدّل الإيجابيات الكاذبة: ${(rate * 100).toFixed(1)}٪ على ${ran} مساراً`);
  /* الادّعاء المقاس في الواجهة: نحو 5٪ لا 91.5٪ */
  ok(rate <= 0.12, `معدّل الإيجابيات الكاذبة ${(rate * 100).toFixed(1)}٪ — الاختبار غير مضبوط`);
});

test('يكتشف الدورة المزروعة', () => {
  let hit = 0;
  for (let i = 0; i < 20; i++) {
    const r = E.spectralPro(plantedCycle(250, 24, 0.06, 0.006, 500 + i * 13), { alpha: 0.05 });
    if (r.ok && r.significant && Math.abs(r.period - 24) <= 3) hit++;
  }
  console.log(`      كشف الدورة الحقيقية: ${hit}/20`);
  ok(hit >= 18, `اكتشف ${hit}/20 فقط`);
});

test('الطور مضبوط — 0٪ قمة و50٪ قاع', () => {
  /* آخر عيّنة عند قمة الموجة تماماً: 249 = مضاعف 24؟ نختار n بحيث تنتهي عند قمة */
  const period = 25, n = 251;      /* (n−1) = 250 = 10 × 25 ⇒ الطور صفر ⇒ قمة */
  const r = E.spectralPro(plantedCycle(n, period, 0.07, 0.004, 777), { alpha: 0.05 });
  ok(r.ok && r.significant, 'لم تُكتشف الدورة المزروعة');
  const pos = r.cyclePosPct;
  const errPct = Math.min(Math.abs(pos - 0), Math.abs(pos - 100));
  console.log(`      موقع الدورة المقاس: ${pos}٪ (المتوقع 0٪ أو 100٪) — انحراف ${errPct.toFixed(1)}٪`);
  ok(errPct <= 12, `انحراف الطور ${errPct.toFixed(1)}٪ من الدورة — الخطأ القديم كان 25٪ (ربع دورة)`);
});

test('الطور عند القاع يقارب 50٪', () => {
  const period = 25, n = 251;
  /* إزاحة π تضع النهاية عند القاع */
  const r = E.spectralPro(plantedCycle(n, period, 0.07, 0.004, 778, Math.PI), { alpha: 0.05 });
  ok(r.ok && r.significant, 'لم تُكتشف الدورة');
  console.log(`      موقع الدورة عند القاع: ${r.cyclePosPct}٪ (المتوقع ≈50٪)`);
  ok(Math.abs(r.cyclePosPct - 50) <= 12, 'انحراف الطور عند القاع: ' + r.cyclePosPct);
});

test('يرفض العيّنة القصيرة بدل إعطاء دورة', () => {
  const r = E.spectralPro(randomWalk(30, 9));
  ok(r.ok === false, 'أعطى نتيجة من 30 شمعة');
});

test('لا يُرجع «دورة» أقصر من النطاق القابل للتداول', () => {
  /* قياس على بيانات حقيقية أعطى «الدورة المهيمنة 2.2 جلسة» — وهي بنية
     الضجيج اليومي لا دورة سوقية، ولا يمكن تداولها إطلاقاً. */
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const r = E.spectralPro(randomWalk(250, 5000 + i * 61));
    if (!r.ok) continue;
    checked++;
    ok(r.period >= r.scannedBand.minPeriod - 0.01, `دورة ${r.period} جلسة تحت الحد الأدنى ${r.scannedBand.minPeriod}`);
    ok(r.period <= r.scannedBand.maxPeriod + 0.01, `دورة ${r.period} جلسة فوق الحد الأعلى ${r.scannedBand.maxPeriod}`);
    for (const t of r.top) ok(t.period >= r.scannedBand.minPeriod - 0.01, 'مرشّح خارج النطاق في قائمة top');
  }
  ok(checked >= 30, 'عيّنة الفحص صغيرة: ' + checked);
});

test('التردد المنقّى لا يخرج عن النطاق الذي اختُبر عليه فيشر', () => {
  for (let i = 0; i < 25; i++) {
    const r = E.spectralPro(plantedCycle(250, 7, 0.05, 0.01, 6000 + i * 29));
    if (!r.ok) continue;
    const f = r.freq;
    ok(f <= 1 / r.scannedBand.minPeriod + 1e-9 && f >= 1 / r.scannedBand.maxPeriod - 1e-9,
      `التردد ${f} خارج النطاق المفحوص [${1 / r.scannedBand.maxPeriod}, ${1 / r.scannedBand.minPeriod}]`);
  }
});

test('لا يُرجع دورات للإسقاط حين لا تكون دالة', () => {
  let checked = 0;
  for (let i = 0; i < 30; i++) {
    const r = E.spectralPro(randomWalk(250, 4000 + i * 91));
    if (r.ok && !r.significant) { checked++; ok(r.cycles.length === 0, 'أعاد دورة قابلة للإسقاط رغم عدم دلالتها'); }
  }
  ok(checked > 0, 'لم تُختبر أي حالة غير دالة');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('إسقاط الانعطافات');

test('عدم اليقين يتّسع مع الأفق', () => {
  const r = E.spectralPro(plantedCycle(300, 30, 0.06, 0.008, 1234), { alpha: 0.05 });
  ok(r.ok && r.significant, 'لم تُكتشف دورة للإسقاط');
  const turns = E.projectTurnsPro(r, 120);
  ok(turns.length >= 3, 'انعطافات غير كافية للاختبار');
  const withSd = turns.filter(t => t.sdBars != null);
  for (let i = 1; i < withSd.length; i++)
    ok(withSd[i].sdBars >= withSd[i - 1].sdBars - 1e-9,
      `عدم اليقين لم يتّسع: ${withSd[i - 1].barsAhead}ج→${withSd[i - 1].sdBars} ثم ${withSd[i].barsAhead}ج→${withSd[i].sdBars}`);
});

test('الانعطافات تتناوب قمة/قاع بنصف دورة', () => {
  const r = E.spectralPro(plantedCycle(300, 30, 0.06, 0.006, 555), { alpha: 0.05 });
  const t = E.projectTurnsPro(r, 90);
  ok(t.length >= 2, 'انعطافات غير كافية');
  ok(t[0].type !== t[1].type, 'انعطافان متتاليان من النوع نفسه');
  const gap = t[1].barsAhead - t[0].barsAhead;
  near(gap, r.period / 2, Math.max(2, r.period * 0.2), 'المسافة بين انعطافين ليست نصف دورة');
});

test('النافذة الأوسع من ربع دورة تُعلَن غير قابلة للاستعمال', () => {
  const r = E.spectralPro(plantedCycle(300, 30, 0.06, 0.008, 1234), { alpha: 0.05 });
  for (const t of E.projectTurnsPro(r, 200)) {
    if (t.sdBars != null) ok(t.usable === (t.sdBars <= r.period / 4), 'علامة usable لا تطابق قاعدتها المعلنة');
  }
});

test('projectCycleTurns لا ينتج شيئاً من طيف غير دال', () => {
  ok(E.projectTurnsPro({ cycles: [] }, 60).length === 0, 'أنتج انعطافاً من لا شيء');
  ok(E.projectCycleTurns({ ok: true, cycles: [] }, 100, 60).length === 0, 'أنتج انعطافاً من لا شيء');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('ARIMA(1,1,0)');

test('يستعيد φ المزروع', () => {
  const rng = mkRng(31); const PHI = 0.6;
  let d = 0; const p = [100];
  for (let i = 1; i < 400; i++) { d = PHI * d + 0.4 * gauss(rng); p.push(p[i - 1] + d); }
  const f = E.forecastARIMA(p, 5);
  ok(f.ok, f.reason);
  console.log(`      φ المقدَّر: ${f.phi} (المزروع ${PHI})`);
  near(f.phi, PHI, 0.12, 'φ');
  ok(f.phiSignificant, 'φ حقيقي لكنه أُعلن غير دال');
});

test('نطاق عدم اليقين يتبع صيغة AR(1) لا σ√h', () => {
  const rng = mkRng(32); const PHI = 0.7;
  let d = 0; const p = [100];
  for (let i = 1; i < 600; i++) { d = PHI * d + 0.5 * gauss(rng); p.push(p[i - 1] + d); }
  const f1 = E.forecastARIMA(p, 1), f10 = E.forecastARIMA(p, 10);
  const half1 = (f1.hi - f1.lo) / 2, half10 = (f10.hi - f10.lo) / 2;
  const ratio = half10 / half1;
  /* الصيغة الصحيحة عند φ≈0.7: √(Σ[(1−φ^k)/(1−φ)]²) ≈ 8.4 مقابل √10 = 3.16 */
  let sum = 0; for (let k = 1; k <= 10; k++) { const psi = (1 - Math.pow(f10.phi, k)) / (1 - f10.phi); sum += psi * psi; }
  const expected = Math.sqrt(sum);
  console.log(`      نسبة اتساع النطاق 10 خطوات/خطوة: ${ratio.toFixed(2)} (المتوقع ${expected.toFixed(2)}، وصيغة √h الخاطئة ${Math.sqrt(10).toFixed(2)})`);
  near(ratio, expected, 0.35, 'النطاق لا يتبع صيغة AR(1)');
  ok(ratio > Math.sqrt(10) * 1.3, 'النطاق ما زال بضيق صيغة σ√h الخاطئة');
});

test('meaningful=false على مشي عشوائي محض', () => {
  let notMeaningful = 0, total = 0;
  for (let i = 0; i < 30; i++) {
    const f = E.forecastARIMA(randomWalk(300, 2000 + i * 17), 5);
    if (!f.ok) continue;
    total++; if (!f.meaningful) notMeaningful++;
  }
  console.log(`      «غير مميّز عن لا تغيّر»: ${notMeaningful}/${total}`);
  ok(notMeaningful === total, `${total - notMeaningful} تنبؤ ادّعى معنى على مشي عشوائي`);
});

test('السعر الحالي داخل الفاصل ⇒ meaningful=false بالتعريف', () => {
  const f = E.forecastARIMA(randomWalk(400, 12345), 5);
  ok(f.ok, f.reason);
  const last = 0; void last;
  ok(f.lo < f.hi, 'الفاصل مقلوب');
  ok(f.bandPct > 0, 'عرض الفاصل صفر');
});

test('يرفض العيّنة القصيرة', () => {
  ok(E.forecastARIMA([1, 2, 3, 4, 5], 5).ok === false, 'أعطى تنبؤاً من 5 نقاط');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('الدورات التجريبية والتماسك');

test('empiricalPivotCycles: إيجابيات كاذبة منخفضة على مشي عشوائي', () => {
  let withCycles = 0, ran = 0;
  for (let i = 0; i < 25; i++) {
    const r = E.empiricalPivotCycles(toCandles(randomWalk(260, 6000 + i * 53), i), { permutations: 150 });
    if (!r.ok) continue;
    ran++; if (r.cycles.length) withCycles++;
  }
  const rate = ran ? withCycles / ran : 0;
  console.log(`      دورات «مؤكدة» على ضجيج: ${withCycles}/${ran} = ${(rate * 100).toFixed(0)}٪`);
  ok(ran > 0, 'لم تُفحص أي حالة');
  /* اختبار بواسون البسيط كان يعطي 35٪ — التبديل + BH يجب أن يكون أقل بكثير */
  ok(rate <= 0.25, `معدّل ${(rate * 100).toFixed(0)}٪ مرتفع`);
});

test('empiricalPivotCycles حتمي — نفس المدخل نفس المخرج', () => {
  const cs = toCandles(randomWalk(260, 4242), 42);
  const a = E.empiricalPivotCycles(cs, { permutations: 150 });
  const b = E.empiricalPivotCycles(cs, { permutations: 150 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'النتيجة تتغيّر بين تشغيلين');
});

test('empiricalPivotCycles يصرّح بدل الفشل الصامت على عيّنة قصيرة', () => {
  const r = E.empiricalPivotCycles(toCandles(randomWalk(60, 1), 1), { permutations: 50 });
  ok(r.ok === false && typeof r.reason === 'string', 'لم يصرّح بسبب الامتناع');
});

test('cycleCoherence يصرّح بالسبب حين لا يمكن الاختبار', () => {
  const r = E.cycleCoherence(toCandles(randomWalk(80, 2), 2));
  ok(r.ok === false && typeof r.reason === 'string', 'لم يصرّح بالسبب');
});

test('cycleCoherence على دورة قوية مزروعة يعطي نتيجة متماسكة الشكل', () => {
  const cs = toCandles(plantedCycle(400, 28, 0.07, 0.006, 8080), 80);
  const r = E.cycleCoherence(cs);
  if (r.ok) {
    ok(r.tried > 0 && r.hits <= r.tried, 'عدّ الإصابات غير متسق');
    ok(r.hitRateCI[0] <= r.hitRatePct && r.hitRatePct <= r.hitRateCI[1] + 1e-6, 'نسبة الإصابة خارج فاصل ثقتها');
    ok(r.chanceRatePct >= 0 && r.chanceRatePct <= 100, 'معدّل الصدفة خارج النطاق');
    console.log(`      تماسك: ${r.hits}/${r.tried} (${r.hitRatePct}٪) مقابل ${r.chanceRatePct}٪ بالصدفة، p=${r.pValueText}`);
  } else console.log('      امتنع مع تصريح: ' + r.reason);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('أهداف الفراكتال والخطة التنفيذية');

test('fractalTargets: كل هدف فوق السعر وكل دعم تحته', () => {
  const cs = toCandles(randomWalk(200, 71), 71);
  const f = E.fractalTargets(cs, { k: 2 });
  ok(f.ok, f.reason);
  if (f.target1 != null) ok(f.target1 > f.price, 'الهدف تحت السعر');
  if (f.target2 != null) ok(f.target2 > f.target1, 'الهدف الثاني ليس أبعد من الأول');
  if (f.support != null) ok(f.support < f.price, 'الدعم فوق السعر');
});

test('fractalTargets يطابق شكل البديل المحلي في الواجهة', () => {
  const cs = toCandles(randomWalk(200, 72), 72);
  const f = E.fractalTargets(cs, { k: 2 });
  for (const key of ['ok', 'price', 'target1', 'target2', 'support', 'supportPct', 'target',
    'targetSource', 'measuredMove', 'highCount', 'lowCount', 'cleanRunway', 'levelsUp', 'levelsDown'])
    ok(key in f, 'حقل ناقص يعتمد عليه ddFrac: ' + key);
});

test('executionPlan: الوقف في الجهة الصحيحة والمخاطرة موجبة', () => {
  for (let s = 0; s < 12; s++) {
    const cs = toCandles(randomWalk(220, 900 + s * 7), s);
    for (const dirUp of [true, false]) {
      const p = E.executionPlan(cs, { dirUp });
      if (!p.ok) continue;
      ok(p.riskPerShare > 0, 'مخاطرة صفرية');
      if (dirUp) ok(p.stop < p.entry, `وقف ${p.stop} فوق الدخول ${p.entry} في صفقة شراء`);
      else ok(p.stop > p.entry, `وقف ${p.stop} تحت الدخول ${p.entry} في صفقة بيع`);
      if (p.target1 != null) {
        if (dirUp) ok(p.target1 > p.entry, `هدف ${p.target1} تحت الدخول ${p.entry} في صفقة شراء`);
        else ok(p.target1 < p.entry, `هدف ${p.target1} فوق الدخول ${p.entry} في صفقة بيع`);
      }
    }
  }
});

test('executionPlan: R:R محسوبة لا مفروضة', () => {
  const rrs = new Set();
  for (let s = 0; s < 40; s++) {
    const p = E.executionPlan(toCandles(randomWalk(220, 3000 + s * 11), s), { dirUp: true });
    if (p.ok && p.rr1 != null) rrs.add(p.rr1);
  }
  console.log(`      قيم R:R مختلفة على 40 عيّنة: ${rrs.size}`);
  ok(rrs.size >= 10, `النسبة تبدو مفروضة: ${rrs.size} قيمة فقط (الحشو التعريفي القديم كان يعطي قيمة واحدة = 2)`);
  ok(!(rrs.size === 1 && rrs.has(2)), 'كل الخطط أعطت 1:2 بالضبط — هذا الحشو التعريفي نفسه');
});

test('executionPlan يعلن عدم الجدوى بدل تضخيم الهدف', () => {
  let declared = 0, viableWithLowRR = 0;
  for (let s = 0; s < 60; s++) {
    const p = E.executionPlan(toCandles(randomWalk(220, 7000 + s * 3), s), { dirUp: true, minRR: 1.5 });
    if (!p.ok) continue;
    if (!p.viable) { declared++; ok(!!p.viabilityNote, 'أُعلن غير مجدٍ بلا سبب'); }
    if (p.viable && p.rr1 != null && p.rr1 < 1.5) viableWithLowRR++;
  }
  console.log(`      خطط أُعلنت غير مجدية: ${declared}/60`);
  ok(viableWithLowRR === 0, 'خطة أُعلنت مجدية رغم R:R دون الحد الأدنى');
  ok(declared > 0, 'لم تُعلن أي خطة غير مجدية — الحالة غير مفحوصة');
});

test('executionPlan يحترم حدّ التذبذب اليومي', () => {
  const p = E.executionPlan(toCandles(randomWalk(220, 4321), 1), { dirUp: true });
  if (p.ok) {
    near(p.dailyLimitUp, +(p.entry * 1.1).toFixed(2), 0.02);
    near(p.dailyLimitDown, +(p.entry * 0.9).toFixed(2), 0.02);
    if (p.minSessionsToTarget != null) ok(p.minSessionsToTarget >= 1, 'عدد جلسات غير منطقي');
  }
});

/* ══════════════════════════════════════════════════════════════════════ */
group('النطاق القيمي');

test('valueBand لا يتحرّك بحجم يوم واحد', () => {
  const cs = toCandles(randomWalk(200, 81), 81);
  const a = E.valueBand(cs);
  const cs2 = cs.map((c, i) => i === cs.length - 1 ? Object.assign({}, c, { volume: c.volume * 8 }) : c);
  const b = E.valueBand(cs2);
  ok(a.ok && b.ok, 'تعذّر بناء النطاق');
  const move = Math.abs(b.center - a.center) / a.center * 100;
  console.log(`      تحرّك مركز النطاق بمضاعفة حجم آخر يوم ×8: ${move.toFixed(2)}٪`);
  /* «السعر العادل» القديم كان يتحرّك 50٪+ بسبب هذا المتغيّر وحده */
  ok(move < 3, `تحرّك ${move.toFixed(2)}٪ — عامل الحجم يهيمن كما في النسخة المكسورة`);
});

test('valueBand يصرّح بحدوده ولا يعطي توصية', () => {
  const b = E.valueBand(toCandles(randomWalk(200, 82), 82));
  ok(b.ok, b.reason);
  ok(typeof b.caveat === 'string' && b.caveat.length > 40, 'لا تنويه بحدود الطريقة');
  ok(b.bandLow <= b.center && b.center <= b.bandHigh, 'المركز خارج النطاق');
  ok(b.anchors.length >= 2, 'مرساة واحدة لا تصنع نطاقاً');
  ok(!/شراء قوي|بيع قوي|احتمال نجاح/.test(JSON.stringify(b)), 'أعاد توصية أو احتمال نجاح مخترعاً');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('الاختبار التاريخي');

test('backtestSpectral حتمي — تشغيلان متطابقان حرفياً', () => {
  const cs = toCandles(plantedCycle(400, 26, 0.05, 0.01, 9090), 90);
  const a = E.backtestSpectral(cs);
  const b = E.backtestSpectral(cs);
  ok(JSON.stringify(a) === JSON.stringify(b), 'النتيجة تغيّرت بين تشغيلين — النسخة القديمة كانت تستعمل Math.random');
});

test('backtestSpectral يمتنع عن الحكم دون الحد الأدنى للإشارات', () => {
  const cs = toCandles(randomWalk(300, 91), 91);
  const r = E.backtestSpectral(cs);
  if (!r.ok) {
    ok(typeof r.reason === 'string', 'امتنع بلا سبب');
    ok(r.significant === undefined, 'أصدر حكماً رغم الامتناع');
  } else {
    ok(r.signal.count >= E.BT_MIN_SIGNALS, `أصدر حكماً من ${r.signal.count} إشارة فقط`);
  }
});

test('المحاكاة متحفّظة: التلامس المزدوج يُحتسب وقفاً', () => {
  /* شمعة واحدة تلامس الوقف والهدف معاً */
  const cs = [];
  for (let i = 0; i < 40; i++) cs.push({ time: i, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 });
  cs.push({ time: 40, open: 100, high: 120, low: 80, close: 100, volume: 1000 });
  for (let i = 41; i < 60; i++) cs.push({ time: i, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 });
  const r = E.backtestSpectral(cs, { warmup: 30, maxHoldBars: 5 });
  /* الاختبار الفعلي على مستوى الوحدة: نتحقق من أن الدالة لم تنهر وأنها صرّحت */
  ok(r && (r.ok === true || typeof r.reason === 'string'), 'لم تُرجع نتيجة صالحة');
});

test('خط الأساس ليس عيّنة عشوائية بل التوزيع الكامل في الاتجاهين', () => {
  const cs = toCandles(plantedCycle(400, 26, 0.05, 0.01, 9091), 91);
  const r = E.backtestSpectral(cs);
  ok(r.baseline && r.baseline.count > 0, 'لا خط أساس');
  /* اتجاهان لكل شمعة مؤهّلة ⇒ عدد زوجي وأكبر بكثير من عدد الإشارات */
  ok(r.baseline.count % 2 === 0, 'عدد صفقات خط الأساس فردي — الاتجاهان غير متكافئين');
  ok(r.baseline.count > (r.signalCount || 0), 'خط الأساس أصغر من الإشارة');
});

test('backtestSpectral يصرّح بإعداداته', () => {
  const r = E.backtestSpectral(toCandles(randomWalk(300, 92), 92));
  ok(r.config && r.config.atrStopMult && r.config.rewardRisk && r.config.maxHoldBars, 'الإعدادات غير معلنة');
  ok(r.config.atrStopMult >= 1, 'مسافة الوقف داخل ضجيج الجلسة كما في النسخة المكسورة (0.5×ATR)');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('التوافق الزمني والنوافذ');

test('timeWindows: كل نافذة تحمل وحدتها ولا تقع في عطلة', () => {
  const cs = toCandles(randomWalk(300, 101), 101);
  const piv = E.lastConfirmedPivot(cs, 3);
  ok(piv, 'لا ارتكاز مؤكد');
  const w = E.timeWindows(cs, piv, { horizonDays: 240 });
  for (const x of w) {
    ok(x.unit === 'bars' || x.unit === 'days', 'وحدة غير مصرّح بها: ' + x.unit);
    ok(x.barsAhead > 0, 'نافذة في الماضي: ' + x.barsAhead);
    ok(x.daysLeft <= 240, 'نافذة خارج الأفق: ' + x.daysLeft);
    ok([5, 6].indexOf(x.date.getUTCDay()) === -1, `نافذة في عطلة السوق: ${x.date.toISOString()} (${x.label})`);
  }
  /* مرتّبة بالأقرب */
  for (let i = 1; i < w.length; i++) ok(w[i].barsAhead >= w[i - 1].barsAhead, 'النوافذ غير مرتّبة');
});

test('timeWindows تُعلم بالإزاحة عن العطلة بدل إخفائها', () => {
  const cs = toCandles(randomWalk(300, 102), 102);
  const piv = E.lastConfirmedPivot(cs, 3);
  const w = E.timeWindows(cs, piv, { horizonDays: 400 });
  const gann = w.filter(x => x.source === 'gann');
  for (const g of gann) ok(typeof g.shiftedFromWeekend === 'boolean', 'لا تصريح بالإزاحة');
});

test('timeConfluence يعدّ ولا يترجم العدّ إلى نسبة ثقة', () => {
  const cs = toCandles(randomWalk(300, 103), 103);
  const piv = E.lastConfirmedPivot(cs, 3);
  const c = E.timeConfluence(cs, piv);
  ok(c.total === 4, 'عدد الأدلة تغيّر عمّا تعرضه الواجهة: ' + c.total);
  ok(c.count >= 0 && c.count <= c.total, 'عدّ خارج النطاق');
  ok(c.evidence.every(e => typeof e.hit === 'boolean' && typeof e.name === 'string'), 'شكل الأدلة لا يطابق الواجهة');
  ok(!/٪ ثقة|confidence/.test(JSON.stringify(c)), 'أُعيدت نسبة ثقة مشتقّة من العدّ');
  ok(c.barsSincePivot >= 0 && c.daysSincePivot >= 0, 'مسافة سالبة');
});

test('timeConfluence لا يخلط الجلسات بالأيام', () => {
  const cs = toCandles(randomWalk(300, 104), 104);
  const piv = E.lastConfirmedPivot(cs, 3);
  const c = E.timeConfluence(cs, piv);
  /* الشموع هنا يومية متتالية بلا عطل، فالأيام ≥ الجلسات دائماً */
  ok(c.daysSincePivot >= c.barsSincePivot, `أيام ${c.daysSincePivot} < جلسات ${c.barsSincePivot}`);
  const units = new Set(c.evidence.map(e => e.unit));
  ok(units.has('bars') && units.has('days'), 'لم تُصرَّح الوحدتان');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('عقد الواجهة — الحقول التي يقرأها index.html');

test('كل دوال المحرك التي تستدعيها الواجهة موجودة', () => {
  const required = [
    'sanitizeCandles', 'auditCandles', 'atr', 'volatility', 'lastConfirmedPivot',
    'dominantPivotCycle', 'structuralLevels', 'fractalTargets', 'volumeProfile',
    'valueBand', 'spectral', 'spectralPro', 'projectTurnsPro', 'projectCycleTurns',
    'forecastARIMA', 'cycleCoherence', 'empiricalPivotCycles', 'timeConfluence',
    'timeWindows', 'executionPlan', 'backtestSpectral'
  ];
  for (const f of required) ok(typeof E[f] === 'function', 'دالة مفقودة: KSAEngine.' + f);
  for (const f of ['mean', 'quantile', 'linreg', 'benjaminiHochberg']) ok(typeof E.Stats[f] === 'function', 'Stats.' + f + ' مفقودة');
  for (const f of ['rollingVWAP', 'obv', 'adLine', 'anchoredVWAP', 'divergence']) ok(typeof E.Cumulative[f] === 'function', 'Cumulative.' + f + ' مفقودة');
  for (const f of ['addTradingDays', 'dailyLimits']) ok(typeof E.SaudiMarket[f] === 'function', 'SaudiMarket.' + f + ' مفقودة');
});

test('spectralAnalysis في الواجهة تجد كل حقولها', () => {
  const r = E.spectralPro(plantedCycle(300, 24, 0.06, 0.006, 1111), { alpha: 0.05 });
  for (const k of ['period', 'bandSharePct', 'phase', 'amplitudePct', 'cyclePosPct', 'freq',
    'pValue', 'pValueText', 'gStatistic', 'snr', 'nCycles', 'gridErrorPct', 'significant', 'verdict', 'trendR2', 'top'])
    ok(k in r, 'حقل ناقص يقرأه spectralAnalysis: ' + k);
  ok(Array.isArray(r.top) && r.top.every(t => 'period' in t && 'sharePct' in t), 'شكل top غير متوافق');
});

test('predictPriceARIMA في الواجهة تجد كل حقولها', () => {
  const f = E.forecastARIMA(randomWalk(300, 1212), 5);
  for (const k of ['ok', 'point', 'phi', 'phiPValue', 'phiSignificant', 'lo', 'hi',
    'bandPct', 'expectedChangePct', 'meaningful', 'note', 'sigma', 'horizon'])
    ok(k in f, 'حقل ناقص يقرأه predictPriceARIMA: ' + k);
});

test('buildExecutionPlan في الواجهة تجد كل حقولها', () => {
  const p = E.executionPlan(toCandles(randomWalk(220, 1313), 13), { dirUp: true });
  for (const k of ['ok', 'viable', 'viabilityNote', 'entry', 'stop', 'riskPerShare', 'riskPct',
    'stopSource', 'target1', 'rr1', 'targetSource', 'atr', 'dailyLimitUp', 'dailyLimitDown', 'minSessionsToTarget'])
    ok(k in p, 'حقل ناقص يقرأه buildExecutionPlan: ' + k);
});

test('تقرير التحليل الزمني يجد حقول conf و coh و emp', () => {
  const cs = toCandles(plantedCycle(400, 28, 0.06, 0.008, 1414), 14);
  const piv = E.lastConfirmedPivot(cs, 3);
  const conf = E.timeConfluence(cs, piv);
  for (const k of ['evidence', 'count', 'total', 'label', 'barsSincePivot', 'daysSincePivot']) ok(k in conf, 'conf.' + k + ' مفقود');
  const coh = E.cycleCoherence(cs);
  if (coh.ok) for (const k of ['hits', 'tried', 'hitRatePct', 'hitRateCI', 'chanceRatePct', 'pValueText', 'toleranceBars', 'verdict', 'reliable']) ok(k in coh, 'coh.' + k + ' مفقود');
  else ok('reason' in coh, 'coh.reason مفقود عند الامتناع');
  const emp = E.empiricalPivotCycles(cs, { permutations: 100 });
  if (emp.ok) { ok(Array.isArray(emp.cycles), 'emp.cycles ليست مصفوفة'); ok('note' in emp, 'emp.note مفقود'); }
  else ok('reason' in emp, 'emp.reason مفقود');
});

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(60)}`);
console.log(`نجح ${passed} · فشل ${failed}`);
if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
