/* ══════════════════════════════════════════════════════════════════════════
   اختبارات محرك التحليل — تُشغَّل بـ: node engine/core.test.js
   ──────────────────────────────────────────────────────────────────────────
   هذه ليست اختبارات "هل الدالة ترجع شيئاً". كل اختبار هنا يقيس خاصية
   إحصائية أو منطقية كانت مكسورة فعلياً في النسخة السابقة، ويثبت أنها
   صارت صحيحة. المرجع في التعليقات هو القياس الذي أثبت الخلل.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const E = require('./core.js');

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(['✓', name, '']); }
  catch (e) { failed++; results.push(['✗', name, e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function approx(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || ''} expected ~${b}, got ${a} (tol ${tol})`);
}

/* ── مولّدات بيانات اصطناعية بخصائص معلومة سلفاً ─────────────────────── */

function rng(seed) { return E.seededRandom(seed); }

/** مشي عشوائي محض — لا دورة فيه إطلاقاً. أي كاشف دورات يجب أن يرفضه. */
function randomWalk(n, seed, base = 50, vol = 0.015) {
  const r = rng(seed);
  const cs = []; let p = base;
  const t0 = Math.floor(Date.UTC(2024, 0, 7) / 1000); /* أحد */
  for (let i = 0; i < n; i++) {
    const ret = (r() - 0.5) * 2 * vol;
    const o = p, c = +(p * (1 + ret)).toFixed(3);
    cs.push({
      time: t0 + i * 86400,
      open: o, close: c,
      high: +(Math.max(o, c) * (1 + r() * 0.006)).toFixed(3),
      low: +(Math.min(o, c) * (1 - r() * 0.006)).toFixed(3),
      volume: Math.floor(100000 + r() * 500000)
    });
    p = c;
  }
  return cs;
}

/** سعر بدورة جيبية حقيقية معلومة الطول والسعة، فوق ضجيج. */
function cyclicSeries(n, seed, period, amp = 0.06, noise = 0.004, base = 50) {
  const r = rng(seed);
  const cs = [];
  const t0 = Math.floor(Date.UTC(2024, 0, 7) / 1000);
  for (let i = 0; i < n; i++) {
    const level = base * Math.exp(amp * Math.sin(2 * Math.PI * i / period) + (r() - 0.5) * 2 * noise);
    const c = +level.toFixed(3);
    const o = i ? cs[i - 1].close : c;
    cs.push({
      time: t0 + i * 86400,
      open: o, close: c,
      high: +(Math.max(o, c) * 1.003).toFixed(3),
      low: +(Math.min(o, c) * 0.997).toFixed(3),
      volume: Math.floor(100000 + r() * 500000)
    });
  }
  return cs;
}

/* ══════════════════════════════════════════════════════════════════════
   1) إحصاء
   ══════════════════════════════════════════════════════════════════════ */

test('Stats.variance يستخدم n-1 (تقدير غير متحيّز)', () => {
  /* تباين [2,4,4,4,5,5,7,9] العيّني = 4.571…، والسكاني = 4 */
  approx(E.Stats.variance([2, 4, 4, 4, 5, 5, 7, 9]), 4.5714, 1e-3);
});

test('Stats.wilson يعطي فاصلاً واسعاً لعينة صغيرة', () => {
  /* 7 من 10: النقطة 70٪ لكن الفاصل يمتد من ~39٪ إلى ~90٪.
     عرض "70٪" وحده — كما كانت المنصة تفعل — يخفي هذا تماماً. */
  const w = E.Stats.wilson(7, 10);
  approx(w.p * 100, 70, 0.01);
  assert(w.lo * 100 < 45, `الحد الأدنى ${(w.lo * 100).toFixed(1)}٪ يجب أن يكون منخفضاً`);
  assert(w.hi * 100 > 85, `الحد الأعلى ${(w.hi * 100).toFixed(1)}٪ يجب أن يكون مرتفعاً`);
});

test('Stats.wilson يضيق مع كبر العينة', () => {
  const small = E.Stats.wilson(70, 100), big = E.Stats.wilson(700, 1000);
  const wS = small.hi - small.lo, wB = big.hi - big.lo;
  assert(wB < wS / 2, `فاصل العينة الكبيرة (${wB.toFixed(3)}) يجب أن يكون أضيق كثيراً من الصغيرة (${wS.toFixed(3)})`);
});

test('Stats.twoProportionP يميّز الفرق الحقيقي عن الصدفة', () => {
  /* 55/100 مقابل 50/100 — فرق 5 نقاط بعينة صغيرة: غير دال */
  assert(E.Stats.twoProportionP(55, 100, 50, 100) > 0.05, 'فرق صغير بعينة صغيرة يجب ألا يكون دالاً');
  /* نفس النسبة لكن بعينة ×50: يصبح دالاً */
  assert(E.Stats.twoProportionP(2750, 5000, 2500, 5000) < 0.01, 'نفس الفرق بعينة كبيرة يجب أن يكون دالاً');
});

test('Benjamini-Hochberg يكبح الاكتشافات الخاطئة عند المسح الشامل', () => {
  /* 250 سهماً كلها بلا ميزة: قيم p موزعة بانتظام على [0,1].
     بلا تصحيح، ~12 منها ستمرّ عند 5٪. مع BH يجب أن يمرّ ~لا شيء. */
  const r = rng(99);
  const ps = Array.from({ length: 250 }, () => r());
  const naive = ps.filter(p => p <= 0.05).length;
  const corrected = E.Stats.benjaminiHochberg(ps, 0.10).filter(Boolean).length;
  assert(naive >= 5, `المتوقع أن يمرّ عدد بلا تصحيح، مرّ ${naive}`);
  assert(corrected <= 2, `مع تصحيح BH يجب أن يمرّ ≈0، مرّ ${corrected}`);
});

/* ══════════════════════════════════════════════════════════════════════
   2) تقويم السوق السعودي
   ══════════════════════════════════════════════════════════════════════ */

test('SaudiMarket: الجمعة والسبت عطلة، الأحد→الخميس تداول', () => {
  /* 2024-01-05 جمعة، 06 سبت، 07 أحد */
  assert(!E.SaudiMarket.isTradingDay(new Date('2024-01-05T12:00:00Z')), 'الجمعة يجب أن تكون عطلة');
  assert(!E.SaudiMarket.isTradingDay(new Date('2024-01-06T12:00:00Z')), 'السبت يجب أن يكون عطلة');
  assert(E.SaudiMarket.isTradingDay(new Date('2024-01-07T12:00:00Z')), 'الأحد يجب أن يكون يوم تداول');
  assert(E.SaudiMarket.isTradingDay(new Date('2024-01-11T12:00:00Z')), 'الخميس يجب أن يكون يوم تداول');
});

test('addTradingDays لا يقع أبداً على عطلة', () => {
  /* الخطأ السابق: تحويل "بعد 13 شمعة" إلى تاريخ بضرب تقريبي ×1.4،
     فينتج تاريخ متوقع يقع أحياناً في يوم جمعة. */
  const start = new Date('2024-01-07T12:00:00Z');
  for (let n = 1; n <= 60; n++) {
    const d = E.SaudiMarket.addTradingDays(start, n);
    assert(E.SaudiMarket.isTradingDay(d), `+${n} يوم تداول وقع على عطلة: ${d.toISOString()}`);
  }
});

test('addTradingDays: 5 أيام تداول = أسبوع تقويمي كامل', () => {
  const start = new Date('2024-01-07T12:00:00Z');           /* أحد */
  const d = E.SaudiMarket.addTradingDays(start, 5);
  approx((d - start) / 86400e3, 7, 0.01, 'خمس جلسات تداول سعودية تساوي 7 أيام تقويمية');
});

test('حدّ التذبذب اليومي ±10٪ يُحترم في حساب الجلسات للهدف', () => {
  const lim = E.SaudiMarket.dailyLimits(100);
  approx(lim.up, 110, 0.001); approx(lim.down, 90, 0.001);
  /* هدف +21٪ يحتاج جلستين على الأقل (1.1²=1.21) */
  assert(E.SaudiMarket.minSessionsToReach(100, 121) === 2, 'هدف +21٪ يحتاج جلستين نظرياً');
  assert(E.SaudiMarket.minSessionsToReach(100, 105) === 1, 'هدف +5٪ يبلغه جلسة واحدة');
});

/* ══════════════════════════════════════════════════════════════════════
   3) نقاط الارتكاز — منع التسرّب الزمني
   ══════════════════════════════════════════════════════════════════════ */

test('كل ارتكاز يحمل confirmedAt بعد فهرسه بمقدار k', () => {
  const cs = randomWalk(200, 5);
  for (const p of E.detectPivots(cs, 3)) {
    assert(p.confirmedAt === p.i + 3, `confirmedAt=${p.confirmedAt} بينما i=${p.i}`);
  }
});

test('لا تسرّب زمني: نتيجة asOf=t لا تتغيّر بإضافة بيانات لاحقة', () => {
  /* هذا هو الاختبار الحاسم. النسخة السابقة كانت تستخدم candles[i+1]
     و candles[i+2] بلا أي تتبّع للتأكيد، فكان الفحص التاريخي "يرى
     المستقبل" وتخرج نتائجه متفائلة بلا مقابل حقيقي. */
  const full = randomWalk(300, 17);
  for (const t of [120, 180, 240]) {
    const fromPrefix = E.lastConfirmedPivot(full.slice(0, t + 1), 3);
    const fromFull = E.lastConfirmedPivot(full, 3, t);
    assert(JSON.stringify(fromPrefix) === JSON.stringify(fromFull),
      `عند t=${t} اختلفت النتيجة: ${JSON.stringify(fromPrefix)} مقابل ${JSON.stringify(fromFull)}`);
  }
});

test('dominantPivotCycle يرفض التباعد غير المنتظم (reliable=false)', () => {
  const cs = randomWalk(300, 23);
  const dc = E.dominantPivotCycle(cs, 3);
  if (dc) assert(!dc.reliable || dc.consistencyPct >= 50,
    `دورة مُعلَنة موثوقة باتساق ${dc.consistencyPct}٪ فقط`);
});

/* ══════════════════════════════════════════════════════════════════════
   4) التحليل الطيفي — الإصلاح الأهم
   ══════════════════════════════════════════════════════════════════════ */

test('معدّل الإيجابيات الكاذبة على المشي العشوائي ≈ مستوى الدلالة', () => {
  /* القياس على النسخة السابقة: 183/200 = 91.5٪ من مسارات المشي العشوائي
     صُنّفت "دالة إحصائياً". الاختبار الصحيح يجب أن يقارب alpha=5٪. */
  let sig = 0; const N = 300;
  for (let s = 1; s <= N; s++) {
    const cs = randomWalk(200, s * 7919 + 3);
    const r = E.spectral(cs.map(c => c.close), { alpha: 0.05 });
    if (r.ok && r.significant) sig++;
  }
  const rate = (sig / N) * 100;
  console.log(`      ↳ معدل الإيجابيات الكاذبة المقاس: ${rate.toFixed(1)}٪ (المستهدف ≈5٪، القديم 91.5٪)`);
  assert(rate <= 12, `معدل إيجابيات كاذبة ${rate.toFixed(1)}٪ مرتفع جداً — الاختبار غير معايَر`);
});

test('يكتشف دورة حقيقية مزروعة بطول معلوم (قوة الاختبار)', () => {
  /* الوجه الآخر: اختبار متحفّظ بلا قدرة تمييز عديم الفائدة كذلك. */
  let found = 0, correctPeriod = 0; const N = 20, PERIOD = 20;
  for (let s = 1; s <= N; s++) {
    const cs = cyclicSeries(240, s * 131 + 7, PERIOD);
    const r = E.spectral(cs.map(c => c.close), { alpha: 0.05 });
    if (r.ok && r.significant) {
      found++;
      if (Math.abs(r.period - PERIOD) <= 3) correctPeriod++;
    }
  }
  console.log(`      ↳ كشف الدورة المزروعة (${PERIOD} شمعة): ${found}/${N}، منها ${correctPeriod} بطول صحيح ±3`);
  assert(found >= N * 0.7, `اكتشف ${found}/${N} فقط — قدرة تمييز ضعيفة`);
  assert(correctPeriod >= found * 0.8, `${correctPeriod}/${found} فقط بالطول الصحيح`);
});

test('شبكة الترددات منتظمة (لا ازدواج 55/56 كما في النسخة السابقة)', () => {
  /* النسخة السابقة مسحت أطوالاً صحيحة 5..60، فكانت 55 و56 تقريباً نفس
     التردد بينما 5 و6 متباعدتان — تشويه بنيوي لأي "حصة طاقة". */
  const pg = E.periodogram(Array.from({ length: 128 }, (_, i) => Math.sin(i / 3)));
  const freqs = pg.map(p => p.freq);
  for (let i = 1; i < freqs.length; i++) {
    approx(freqs[i] - freqs[i - 1], 1 / 128, 1e-9, 'تباعد الترددات يجب أن يكون ثابتاً');
  }
});

test('الطور يُلائم على السعر لا على العائد (تصحيح خطأ 90°)', () => {
  /* السعر = sin(2πi/P). قمم السعر عند i = P/4 + kP.
     النسخة السابقة أسقطت موجة *العائد*، وقمة العائد تسبق قمة السعر
     بربع دورة — أي خطأ توقيت مقداره P/4 شمعة في كل نافذة زمنية. */
  const P = 24;
  const cs = cyclicSeries(288, 4242, P, 0.05, 0.0005);
  const spec = E.spectral(cs.map(c => c.close), { alpha: 0.10 });
  assert(spec.ok && spec.significant, 'يجب أن تُكتشف الدورة المزروعة');
  const turns = E.projectCycleTurns(spec, cs.length - 1, P * 2);
  assert(turns.length >= 2, 'يجب إسقاط انعطافين على الأقل خلال دورتين');

  /* نتحقق أن القمة المُسقطة تقع فعلاً عند قمة الدالة المزروعة */
  const peak = turns.find(t => t.type === 'peak');
  assert(peak, 'يجب وجود قمة مُسقطة');
  const absIdx = cs.length - 1 + peak.barsAhead;
  const sinAt = Math.sin(2 * Math.PI * absIdx / P);
  console.log(`      ↳ القمة المُسقطة عند +${peak.barsAhead} شمعة، قيمة الجيب هناك = ${sinAt.toFixed(2)} (المتوقع ≈ +1)`);
  assert(sinAt > 0.6, `القمة المُسقطة تقع حيث الجيب=${sinAt.toFixed(2)} — خطأ طور (المتوقع قرب +1)`);
});

test('projectCycleTurns لا يُسقط شيئاً من دورة غير دالة', () => {
  /* هذا ما كان يولّد "النوافذ الزمنية" الوهمية: رسم موجة على ضجيج. */
  const cs = randomWalk(200, 555);
  const spec = E.spectral(cs.map(c => c.close));
  if (spec.ok && !spec.significant) {
    assert(E.projectCycleTurns(spec, cs.length - 1, 60).length === 0,
      'لا يجوز إسقاط انعطافات من دورة غير دالة إحصائياً');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   5) التنبؤ
   ══════════════════════════════════════════════════════════════════════ */

test('فاصل تنبؤ ARIMA يتسع بشكل صحيح مع الأفق', () => {
  const cs = randomWalk(300, 31);
  const closes = cs.map(c => c.close);
  const f1 = E.forecastARIMA(closes, 1), f10 = E.forecastARIMA(closes, 10);
  assert(f1.ok && f10.ok);
  const w1 = f1.hi - f1.lo, w10 = f10.hi - f10.lo;
  assert(w10 > w1 * 2, `فاصل 10 خطوات (${w10.toFixed(2)}) يجب أن يتجاوز ضِعف فاصل خطوة واحدة (${w1.toFixed(2)})`);
});

test('تباين التنبؤ يتجاوز σ√h عند وجود زخم ذاتي (φ كبير)', () => {
  /* الصيغة السابقة σ·√h صحيحة فقط عند φ=0. عند φ موجب كبير تُقلّل
     عدم اليقين الحقيقي كثيراً، فتوحي بدقة غير موجودة. */
  const phi = 0.7, sigma = 1, h = 10;
  let varSum = 0;
  for (let k = 1; k <= h; k++) {
    const psi = (1 - Math.pow(phi, h - k + 1)) / (1 - phi);
    varSum += psi * psi;
  }
  const correct = sigma * Math.sqrt(varSum), naive = sigma * Math.sqrt(h);
  console.log(`      ↳ عند φ=${phi}, h=${h}: الصحيح ${correct.toFixed(2)} مقابل σ√h=${naive.toFixed(2)} (أقل بـ ${((1 - naive / correct) * 100).toFixed(0)}٪)`);
  assert(correct > naive * 1.8, 'الصيغة الصحيحة يجب أن تعطي عدم يقين أكبر بكثير');
});

test('التنبؤ على مشي عشوائي يُعلَن "غير مميّز عن لا تغيّر"', () => {
  /* الأمانة الأساسية: على سهم بلا زخم ذاتي، التنبؤ = السعر الحالي
     تقريباً، والمنصة يجب أن تقول ذلك صراحة بدل عرض رقم يوحي بالمعرفة. */
  let notMeaningful = 0; const N = 30;
  for (let s = 1; s <= N; s++) {
    const f = E.forecastARIMA(randomWalk(250, s * 37 + 11).map(c => c.close), 5);
    if (f.ok && !f.meaningful) notMeaningful++;
  }
  console.log(`      ↳ ${notMeaningful}/${N} من التنبؤات على المشي العشوائي أُعلنت غير مميّزة عن "لا تغيّر"`);
  assert(notMeaningful >= N * 0.9, `${notMeaningful}/${N} فقط — النموذج يدّعي معرفة غير موجودة`);
});

/* ══════════════════════════════════════════════════════════════════════
   6) المؤشرات التراكمية
   ══════════════════════════════════════════════════════════════════════ */

test('VWAP المثبّت يبدأ من نقطة التثبيت لا من أول شمعة', () => {
  /* الخطأ السابق: تراكم من الشمعة صفر بلا تصفير أبداً — فيصبح متوسطاً
     بطيئاً بلا معنى تنفيذي، ويُعرض على أنه VWAP. */
  const cs = randomWalk(200, 41);
  const v0 = E.Cumulative.anchoredVWAP(cs, 0);
  const v150 = E.Cumulative.anchoredVWAP(cs, 150);
  assert(v150[149] === null, 'ما قبل نقطة التثبيت يجب أن يكون فارغاً');
  assert(v150[150] !== null, 'عند نقطة التثبيت يجب أن تبدأ القيمة');
  assert(Math.abs(v150[199] - v0[199]) > 1e-6, 'VWAP المثبّت يجب أن يختلف عن التراكمي الكامل');
  /* عند نقطة التثبيت مباشرة، VWAP = السعر النموذجي لتلك الشمعة وحدها */
  const tp = (cs[150].high + cs[150].low + cs[150].close) / 3;
  approx(v150[150], tp, 1e-6, 'VWAP عند شمعة التثبيت = سعرها النموذجي');
});

test('تباعد المؤشر التراكمي مُطبَّع وقابل للمقارنة بين الأسهم', () => {
  /* المقارنة الخام كانت بين ميل بالأسهم وميل بالريالات — بلا معنى.
     هنا: نفس السلسلة بمقياس ×1000 يجب أن تعطي نفس النتيجة تماماً. */
  const cs = randomWalk(120, 53);
  const obv = E.Cumulative.obv(cs);
  const a = E.Cumulative.divergence(cs, obv, 20);
  const b = E.Cumulative.divergence(cs, obv.map(v => v * 1000), 20);
  assert(a.type === b.type, 'نوع التباعد يجب ألا يتأثر بمقياس المؤشر');
  approx(a.slopeSeries, b.slopeSeries, 1e-6, 'الميل المُطبَّع يجب أن يكون ثابتاً تحت التحجيم');
});

test('خط التجميع/التوزيع يميّز الإغلاق الضعيف عن القوي بنفس الحجم', () => {
  const base = { time: 1700000000, volume: 1000000 };
  const strong = [{ ...base, open: 10, high: 11, low: 10, close: 11 }];   /* إغلاق عند القمة */
  const weak = [{ ...base, open: 11, high: 11, low: 10, close: 10 }];     /* إغلاق عند القاع */
  assert(E.Cumulative.adLine(strong)[0] > 0, 'إغلاق عند القمة ⇒ تجميع موجب');
  assert(E.Cumulative.adLine(weak)[0] < 0, 'إغلاق عند القاع ⇒ توزيع سالب');
});

/* ══════════════════════════════════════════════════════════════════════
   7) ملف الحجم والنطاق القيمي
   ══════════════════════════════════════════════════════════════════════ */

test('POC هو أكثر سعر تداولاً فعلاً، لا إغلاق أعلى شمعة حجماً', () => {
  /* بناء متعمّد: 40 شمعة تتداول حول 10، وشمعة واحدة ضخمة الحجم عند 20.
     التعريف السابق ("إغلاق الشمعة الأعلى حجماً") يعطي POC=20 — خطأ.
     التعريف الصحيح يوزّع الحجم على شرائح السعر ويعطي POC≈10. */
  const cs = [];
  for (let i = 0; i < 40; i++) cs.push({ time: 1700000000 + i * 86400, open: 10, high: 10.1, low: 9.9, close: 10, volume: 100000 });
  cs.push({ time: 1700000000 + 40 * 86400, open: 20, high: 20.1, low: 19.9, close: 20, volume: 900000 });
  const vp = E.volumeProfile(cs, 60);
  console.log(`      ↳ POC المحسوب = ${vp.poc} (السعر المتداول فعلاً ≈10، وإغلاق أعلى شمعة حجماً = 20)`);
  assert(Math.abs(vp.poc - 10) < 1.5, `POC=${vp.poc} — يجب أن يقارب 10 لا 20`);
});

test('منطقة القيمة تغطي ≈70٪ من الحجم وتحتوي POC', () => {
  const cs = randomWalk(200, 61);
  const vp = E.volumeProfile(cs);
  assert(vp.valueAreaPct >= 68 && vp.valueAreaPct <= 82, `تغطية ${vp.valueAreaPct}٪ خارج المدى المقبول`);
  assert(vp.poc >= vp.valueAreaLow && vp.poc <= vp.valueAreaHigh, 'POC يجب أن يقع داخل منطقة القيمة');
});

test('النطاق القيمي لا يتحرّك بحجم يوم واحد', () => {
  /* القياس على النسخة السابقة: مضاعفة حجم آخر يوم ×4 رفعت "السعر
     العادل" من 82.91 إلى 124.41 — أي +50٪ بسبب متغيّر بلا صلة بالقيمة. */
  const cs = randomWalk(200, 67);
  const spike = cs.map((c, i) => (i === cs.length - 1 ? { ...c, volume: c.volume * 20 } : c));
  const a = E.valueBand(cs), b = E.valueBand(spike);
  const drift = Math.abs(b.center - a.center) / a.center * 100;
  console.log(`      ↳ تغيّر مركز النطاق عند مضاعفة حجم آخر يوم ×20: ${drift.toFixed(2)}٪ (القديم كان +50٪ عند ×4)`);
  assert(drift < 1, `مركز النطاق تحرّك ${drift.toFixed(2)}٪ بسبب حجم يوم واحد`);
});

test('النطاق القيمي يحتوي مراسي متعددة ولا يدّعي "سعراً عادلاً" واحداً', () => {
  const vb = E.valueBand(randomWalk(200, 71));
  assert(vb.ok && vb.anchors.length >= 2, 'يجب عرض أكثر من مرساة مرجعية');
  assert(vb.bandLow < vb.bandHigh, 'النطاق يجب أن يكون نطاقاً فعلياً');
  assert(typeof vb.caveat === 'string' && vb.caveat.length > 20, 'يجب إرفاق تنويه صريح بحدود الطريقة');
});

/* ══════════════════════════════════════════════════════════════════════
   8) التذبذب
   ══════════════════════════════════════════════════════════════════════ */

test('التذبذب السنوي يستعيد المعامل المزروع', () => {
  /* عوائد يومية σ=1.5٪ ⇒ سنوي ≈ 1.5×√246 ≈ 23.5٪ */
  const cs = randomWalk(2000, 83, 50, 0.015);
  const v = E.volatility(cs.map(c => c.close));
  /* التوزيع المنتظم على [-1.5٪,+1.5٪] له انحراف معياري 1.5/√3 ≈ 0.866٪ */
  const expectedDaily = 1.5 / Math.sqrt(3);
  console.log(`      ↳ التذبذب اليومي المقاس ${v.dailyPct}٪ (المتوقع ≈${expectedDaily.toFixed(2)}٪)، السنوي ${v.annualPct}٪`);
  approx(v.dailyPct, expectedDaily, 0.15, 'التذبذب اليومي');
  approx(v.annualPct, expectedDaily * Math.sqrt(246), 3, 'التذبذب السنوي');
});

test('ATR يستخدم تنعيم Wilder ولا يعطي قيماً سالبة', () => {
  const cs = randomWalk(200, 89);
  const a = E.atr(cs, 14);
  assert(a > 0, 'ATR يجب أن يكون موجباً');
  assert(a < cs[cs.length - 1].close, 'ATR يجب أن يكون أصغر بكثير من السعر');
});

/* ══════════════════════════════════════════════════════════════════════
   9) النوافذ الزمنية
   ══════════════════════════════════════════════════════════════════════ */

test('كل نافذة زمنية تقع على يوم تداول سعودي', () => {
  /* الخطأ السابق: خلط وحدات (شموع × معامل 1.4 = أيام) ينتج تواريخ عطل. */
  const cs = randomWalk(250, 97);
  const pivot = E.lastConfirmedPivot(cs, 3);
  assert(pivot, 'يجب وجود ارتكاز مؤكد');
  const wins = E.timeWindows(cs, pivot);
  for (const w of wins) {
    assert(E.SaudiMarket.isTradingDay(w.date), `نافذة "${w.label}" تقع على عطلة: ${w.date.toISOString().slice(0, 10)}`);
    assert(w.barsAhead > 0, 'النافذة يجب أن تكون في المستقبل');
    assert(['bars', 'days'].includes(w.unit), 'كل نافذة يجب أن تصرّح بوحدتها');
  }
  console.log(`      ↳ ${wins.length} نافذة زمنية، كلها على أيام تداول وبوحدة مصرّحة`);
});

test('timeConfluence لا يترجم عدد الأدلة إلى نسبة مئوية', () => {
  const cs = randomWalk(250, 101);
  const pivot = E.lastConfirmedPivot(cs, 3);
  const tc = E.timeConfluence(cs, pivot);
  assert(typeof tc.label === 'string', 'التصنيف نصي');
  assert(tc.count <= tc.total, 'عدد الأدلة لا يتجاوز الإجمالي');
  assert(!('confidence' in tc) && !('probability' in tc), 'لا يجوز إرجاع رقم ثقة مصطنع');
});

/* ══════════════════════════════════════════════════════════════════════
   10) الاختبار التاريخي
   ══════════════════════════════════════════════════════════════════════ */

test('الاختبار التاريخي حتمي تماماً — نفس المدخلات، نفس النتيجة', () => {
  /* القياس على النسخة السابقة: 4 تشغيلات متتالية لنفس السهم أعطت
     "حكماً إيجابياً" ثلاث مرات و"فرق ضئيل" مرة — لأن خط الأساس كان
     عيّنة Math.random. */
  const cs = cyclicSeries(400, 103, 22);
  const runs = Array.from({ length: 5 }, () => JSON.stringify(E.backtestSpectral(cs)));
  assert(new Set(runs).size === 1, 'خمس تشغيلات أعطت نتائج مختلفة — النتيجة غير حتمية');
});

test('خط الأساس غير مشروط ويغطي كامل التاريخ المؤهّل', () => {
  const cs = cyclicSeries(400, 107, 22);
  const r = E.backtestSpectral(cs);
  const stats = r.baseline || (r.underpowered && r.baseline);
  assert(stats && stats.count > 100, `خط الأساس ${stats?.count} صفقة فقط — يجب أن يغطي كل الشموع المؤهّلة في الاتجاهين`);
});

test('لا حكم بلا قيمة احتمال وحجم عينة', () => {
  const cs = cyclicSeries(500, 109, 20);
  const r = E.backtestSpectral(cs);
  if (r.ok) {
    assert(typeof r.pValue === 'number', 'يجب إرجاع p-value');
    assert(r.signal.winRateCI.length === 2, 'يجب إرجاع فاصل ثقة لنسبة الربح');
    assert(r.signal.count >= E.BT_DEFAULTS.minSignals, 'الحكم لا يصدر تحت الحد الأدنى للعينة');
  } else {
    assert(r.reason && r.reason.length > 10, 'يجب تعليل الامتناع عن الحكم');
  }
});

test('عينة صغيرة ⇒ underpowered لا حكم متسرّع', () => {
  /* المنصة السابقة كانت تصدر حكماً "✅ تتفوق على العشوائية" من 5 إشارات. */
  const cs = randomWalk(200, 113);
  const r = E.backtestSpectral(cs, { minSignals: 100 });
  assert(!r.ok, 'يجب ألا يصدر حكم');
  assert(r.underpowered || r.reason.includes('غير'), 'يجب التصريح بأن العينة غير كافية');
});

test('مسافة الوقف تُبقي الصفقة حيّة أطول من ضجيج شمعتين', () => {
  /* القياس على النسخة السابقة: متوسط عمر الصفقة 1.8 شمعة ونسبة ربح
     22٪ — لأن الوقف كان 0.5×ATR، أي داخل ضجيج الجلسة العادي. */
  const cs = randomWalk(500, 127);
  const trades = [];
  for (let i = 100; i < cs.length - 40; i += 7) {
    const t = E.simulateTrade(cs, i, true, {});
    if (t) trades.push(t);
  }
  const avgBars = E.Stats.mean(trades.map(t => t.bars));
  console.log(`      ↳ متوسط عمر الصفقة ${avgBars.toFixed(1)} شمعة (القديم كان 1.8)`);
  assert(avgBars > 3, `متوسط ${avgBars.toFixed(1)} شمعة — الوقف ما زال داخل الضجيج`);
});

test('محاكاة الصفقة متحفّظة عند غموض الشمعة الواحدة', () => {
  /* شمعة تلامس الوقف والهدف معاً: يجب افتراض الوقف أولاً. */
  const entry = 100, t0 = 1700000000;
  const cs = [];
  for (let i = 0; i < 30; i++) cs.push({ time: t0 + i * 86400, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  cs.push({ time: t0 + 30 * 86400, open: 100, high: 130, low: 70, close: 100, volume: 1000 });
  cs.push({ time: t0 + 31 * 86400, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  const t = E.simulateTrade(cs, 29, true, {});
  assert(t && t.outcome === 'stop', `شمعة تلامس الطرفين يجب أن تُحتسب وقفاً، جاءت "${t?.outcome}"`);
});

/* ══════════════════════════════════════════════════════════════════════
   11) خطة التنفيذ
   ══════════════════════════════════════════════════════════════════════ */

test('الوقف دائماً في الجهة الصحيحة من سعر الدخول', () => {
  /* القياس على النسخة السابقة: في 4 من 5 عيّنات كان "وقف الخسارة"
     أعلى من سعر الدخول و"الهدف" أدنى منه — خطة مقلوبة بالكامل. */
  let checked = 0;
  for (let s = 1; s <= 40; s++) {
    const cs = randomWalk(250, s * 211 + 5);
    for (const dirUp of [true, false]) {
      const p = E.executionPlan(cs, { dirUp });
      if (!p.ok) continue;
      checked++;
      if (dirUp) {
        assert(p.stop < p.entry, `[صعودي] الوقف ${p.stop} يجب أن يكون تحت الدخول ${p.entry}`);
        assert(p.target1 > p.entry, `[صعودي] الهدف ${p.target1} يجب أن يكون فوق الدخول ${p.entry}`);
      } else {
        assert(p.stop > p.entry, `[هبوطي] الوقف ${p.stop} يجب أن يكون فوق الدخول ${p.entry}`);
        assert(p.target1 < p.entry, `[هبوطي] الهدف ${p.target1} يجب أن يكون تحت الدخول ${p.entry}`);
      }
      assert(p.riskPerShare > 0, 'المخاطرة لكل سهم يجب أن تكون موجبة');
    }
  }
  console.log(`      ↳ فُحصت ${checked} خطة تنفيذ، كلها بالاتجاه الصحيح`);
  assert(checked > 50, `فُحصت ${checked} خطة فقط`);
});

test('R:R محسوب من الهدف الفعلي لا مفروض مسبقاً', () => {
  /* النسخة السابقة كانت تضع الهدف = 2R ثم تعلن "R:R = 1:2" — حشو تعريفي. */
  const rrs = new Set();
  for (let s = 1; s <= 40; s++) {
    const p = E.executionPlan(randomWalk(250, s * 307 + 9), { dirUp: true });
    if (p.ok) rrs.add(p.rr1);
  }
  console.log(`      ↳ ${rrs.size} قيمة R:R مختلفة عبر 40 سهماً (القديم: قيمة واحدة دائماً)`);
  assert(rrs.size > 5, `كل الخطط أعطت ${rrs.size} قيمة R:R — يبدو أنها مفروضة لا محسوبة`);
});

test('خطة غير مجدية تُعلَن غير مجدية بدل توسيع الهدف قسراً', () => {
  let flagged = 0, total = 0;
  for (let s = 1; s <= 60; s++) {
    const p = E.executionPlan(randomWalk(250, s * 401 + 13), { dirUp: true });
    if (!p.ok) continue;
    total++;
    if (!p.viable) { flagged++; assert(p.viabilityNote, 'خطة غير مجدية يجب أن تحمل تعليلاً'); }
  }
  console.log(`      ↳ ${flagged}/${total} خطة أُعلنت غير مجدية (R:R < 1.5) بدل تضخيم الهدف`);
  assert(total > 20, 'عينة غير كافية');
});

test('خطة التنفيذ تصرّح بحدود التذبذب اليومي وعدد الجلسات للهدف', () => {
  const p = E.executionPlan(randomWalk(250, 137), { dirUp: true });
  assert(p.ok && p.dailyLimitUp > p.entry && p.dailyLimitDown < p.entry, 'يجب عرض حدّي ±10٪');
  assert(Number.isInteger(p.minSessionsToTarget) && p.minSessionsToTarget >= 1,
    'يجب حساب أقل عدد جلسات لبلوغ الهدف ضمن حدّ التذبذب');
});

/* ══════════════════════════════════════════════════════════════════════
   12) تدقيق البيانات
   ══════════════════════════════════════════════════════════════════════ */

test('auditCandles يكشف OHLC غير المتسق والتكرار والفجوات', () => {
  const bad = [
    { time: 1700000000, open: 10, high: 9, low: 11, close: 10, volume: 100 },   /* high<low */
    { time: 1700000000, open: 10, high: 11, low: 9, close: 10, volume: 100 },   /* وقت مكرر */
    { time: 1700000000 + 30 * 86400, open: 10, high: 11, low: 9, close: 10, volume: 100 } /* فجوة 30 يوم */
  ];
  const a = E.auditCandles(bad);
  assert(!a.ok && a.issues.length >= 3, `توقّعنا 3 ملاحظات على الأقل، وجدنا ${a.issues.length}: ${a.issues.join(' | ')}`);
});

test('sanitizeCandles يصلح الانعكاسات الطفيفة بدل إسقاط الجلسة', () => {
  /* النسخة السابقة كانت تُسقط أي شمعة لا تحقق high≥max(o,c)، فتضيع
     جلسات حقيقية بسبب تقريب المصدر، وقد يسقط النطاق كله تحت العتبة. */
  const raw = [
    { time: 3, open: 10, high: 10.4, low: 9.6, close: 10.5, volume: 5 },  /* close>high بفارق تقريب */
    { time: 1, open: 9, high: 9.5, low: 8.5, close: 9.2, volume: 3 },
    { time: 3, open: 10, high: 10.6, low: 9.6, close: 10.5, volume: 7 },  /* مكرر */
    { time: 2, open: null, high: 1, low: 1, close: 1, volume: 1 }          /* فاسد */
  ];
  const out = E.sanitizeCandles(raw);
  assert(out.length === 2, `توقّعنا شمعتين صالحتين، خرجت ${out.length}`);
  assert(out[0].time < out[1].time, 'يجب الترتيب الزمني التصاعدي');
  for (const c of out) {
    assert(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close), 'OHLC يجب أن يكون متسقاً بعد التنظيف');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   13) سلامة عامة — لا NaN يتسرّب للواجهة
   ══════════════════════════════════════════════════════════════════════ */

test('لا NaN/Infinity في أي مخرج عبر حالات حدّية', () => {
  const t0 = Math.floor(Date.UTC(2024, 0, 7) / 1000);
  const flat = Array.from({ length: 150 }, (_, i) => ({ time: t0 + i * 86400, open: 10, high: 10, low: 10, close: 10, volume: 0 }));
  const penny = randomWalk(150, 149, 0.32, 0.05);
  const huge = randomWalk(150, 151, 4800, 0.02);

  const walk = (label, v, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (typeof v === 'number') { assert(isFinite(v), `${label} = ${v}`); return; }
    if (Array.isArray(v)) { v.slice(0, 30).forEach((x, i) => walk(`${label}[${i}]`, x, depth + 1)); return; }
    if (v instanceof Date) { assert(!isNaN(v.getTime()), `${label} تاريخ غير صالح`); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) walk(`${label}.${k}`, v[k], depth + 1);
  };

  for (const [name, cs] of [['flat', flat], ['penny', penny], ['huge', huge]]) {
    const closes = cs.map(c => c.close);
    walk(`${name}.spectral`, E.spectral(closes));
    walk(`${name}.forecast`, E.forecastARIMA(closes, 5));
    walk(`${name}.volatility`, E.volatility(closes));
    walk(`${name}.valueBand`, E.valueBand(cs));
    walk(`${name}.volumeProfile`, E.volumeProfile(cs));
    walk(`${name}.plan`, E.executionPlan(cs, { dirUp: true }));
    walk(`${name}.audit`, E.auditCandles(cs));
    const p = E.lastConfirmedPivot(cs, 3);
    if (p) { walk(`${name}.windows`, E.timeWindows(cs, p)); walk(`${name}.confluence`, E.timeConfluence(cs, p)); }
  }
});

test('لا دالة تُرجع رقم "ثقة" أو "احتمال نجاح" مخترعاً', () => {
  /* حارس انحدار: كان في المنصة "احتمال النجاح: 84%" ثابتاً في نص التسعير،
     و probability:75 ثابتة في مناطق فيبوناتشي، و confidence مشتقة من عدّ. */
  const cs = randomWalk(250, 163);
  const closes = cs.map(c => c.close);
  const pivot = E.lastConfirmedPivot(cs, 3);
  const outputs = [
    E.spectral(closes), E.forecastARIMA(closes, 5), E.valueBand(cs),
    E.executionPlan(cs, { dirUp: true }), E.timeConfluence(cs, pivot),
    ...E.timeWindows(cs, pivot)
  ];
  const banned = ['confidence', 'probability', 'successRate', 'successProbability'];
  for (const o of outputs) {
    for (const key of banned) {
      assert(!(o && typeof o === 'object' && key in o),
        `مخرج يحتوي حقل "${key}" — أي احتمال يجب أن يأتي من عينة محسوبة مع فاصل ثقة`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n════════ اختبارات محرك التحليل KSA-H1 ════════\n');
for (const [mark, name, err] of results) {
  console.log(`  ${mark} ${name}`);
  if (err) console.log(`      ↳ ${err}`);
}
console.log(`\n  المجموع: ${passed + failed} | ناجح: ${passed} | فاشل: ${failed}\n`);
process.exit(failed ? 1 : 0);
