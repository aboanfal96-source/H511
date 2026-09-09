/* ══════════════════════════════════════════════════════════════════════════
   اختبارات KSAMarket — الطبقة المقطعية
   ──────────────────────────────────────────────────────────────────────────
   أهم اختبار هنا هو الأول: التمهيد بالسهم يجب أن **يرصد التكتّل حين يوجد
   ولا يخترعه حين يغيب**. لو فشل هذا لكان القياس المقطعي كله يعطي أرقاماً
   جميلة كاذبة — وهي أخطر من غياب القياس.
   التشغيل: node tests/market.test.js
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const load = rel => require(path.resolve(__dirname, rel));
const pick = names => { for (const r of names) { try { return load(r); } catch (e) { } } throw new Error('وحدة مفقودة: ' + names[0]); };
const E = pick(['./engine/core.js', '../engine/core.js']);
const T = pick(['./engine/timing.js', '../engine/timing.js']);
const M = pick(['./engine/market.js', '../engine/market.js']);

let passed = 0, failed = 0; const fails = [];
const test = (n, f) => { try { f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const atest = async (n, f) => { try { await f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const group = n => console.log('\n▸ ' + n);
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const rng = s => E.seededRandom(s);
const gauss = r => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** سوق بعامل مشترك — الارتباط الذي يجعل التجميع الساذج يكذب. */
function synthMarket(nSym, n, seed, o) {
  o = o || {};
  const rm = rng(seed); const mkt = [0];
  for (let i = 1; i < n; i++) mkt.push((o.mktVol == null ? 0.011 : o.mktVol) * gauss(rm) + (o.drift || 0));
  const out = [];
  for (let k = 0; k < nSym; k++) {
    const r = rng(seed + k * 97 + 1), beta = 0.6 + r() * 0.8;
    let t = Math.floor(Date.UTC(2022, 0, 2) / 1000), p = 50, prev = 50; const cs = [];
    for (let i = 0; i < n; i++) {
      let d = new Date(t * 1000);
      while (d.getUTCDay() === 5 || d.getUTCDay() === 6) { t += 86400; d = new Date(t * 1000); }
      const cyc = o.period ? (o.amp || 0.05) * Math.cos(2 * Math.PI * i / o.period) : 0;
      p *= Math.exp(beta * mkt[i] + cyc / Math.max(1, n / 60) + 0.010 * gauss(r));
      const w = p * 0.011 * (0.4 + r());
      cs.push({ time: t, open: +prev.toFixed(2), high: +Math.max(prev, p, p + w).toFixed(2), low: +Math.min(prev, p, p - w).toFixed(2), close: +p.toFixed(2), volume: Math.round(300000 * (0.5 + r())) });
      prev = p; t += 86400;
    }
    out.push({ sym: 'S' + k, name: 'سهم ' + k, sec: 'قطاع ' + (k % 5), cs });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
group('التمهيد بالسهم — الادّعاء المركزي');

test('يرصد التكتّل حين يوجد، ولا يخترعه حين يغيب', () => {
  /* نفس عدد الصفقات ونفس نسبة الفوز تقريباً، والفرق التكتّل وحده. */
  const clusterBoot = (bySym, iters, seed) => {
    const syms = Object.keys(bySym); const rnd = E.seededRandom(seed); const st = [];
    for (let b = 0; b < iters; b++) {
      let w = 0, n = 0;
      for (let i = 0; i < syms.length; i++) {
        const s = syms[Math.floor(rnd() * syms.length)];
        for (const r of bySym[s]) { n++; if (r.win) w++; }
      }
      if (n) st.push(w / n);
    }
    st.sort((a, b) => a - b);
    const q = p => st[Math.max(0, Math.min(st.length - 1, Math.floor(p * (st.length - 1))))];
    return (q(0.975) - q(0.025)) * 100;
  };
  const rnd = E.seededRandom(42);
  const A = {}, B = {};
  for (let s = 0; s < 40; s++) { const win = rnd() < 0.5; A['S' + s] = Array.from({ length: 50 }, () => ({ win })); }
  for (let s = 0; s < 40; s++) B['S' + s] = Array.from({ length: 50 }, () => ({ win: rnd() < 0.5 }));

  const widthOf = d => {
    const all = [].concat.apply([], Object.values(d));
    const ci = E.Stats.wilson(all.filter(r => r.win).length, all.length);
    return { naive: (ci.hi - ci.lo) * 100, boot: clusterBoot(d, 600, 99) };
  };
  const a = widthOf(A), b = widthOf(B);
  console.log(`      تكتّل تام: ساذج ${a.naive.toFixed(1)} → تمهيد ${a.boot.toFixed(1)} (×${(a.boot / a.naive).toFixed(1)})`);
  console.log(`      بلا تكتّل: ساذج ${b.naive.toFixed(1)} → تمهيد ${b.boot.toFixed(1)} (×${(b.boot / b.naive).toFixed(1)})`);
  ok(a.boot / a.naive > 3, `لم يرصد التكتّل التام (×${(a.boot / a.naive).toFixed(1)}) — الفاصل المجمّع سيكذب`);
  ok(b.boot / b.naive < 1.6, `وسّع الفاصل بلا تكتّل (×${(b.boot / b.naive).toFixed(1)}) — يخترع عدم يقين`);
});

/* ══════════════════════════════════════════════════════════════════════ */
group('نظام السوق');

test('يصنّف النظام باتفاق المدى القصير والمتوسط لا بأحدهما', () => {
  /* 🛠️ اختبار أول كان يفترض أن هبوطاً طويلاً يعني نظاماً هابطاً الآن —
     وهو استنتاج خاطئ: النظام حالة راهنة. لكنه كشف عيباً حقيقياً: التصنيف
     كان بميل 20 جلسة وحده، فصُنّف سوق هبط 54٪ «صاعداً» لأن آخر 20 جلسة
     ارتداد. الآن يلزم اتفاق 20 و60 جلسة مع الاتساع. */
  const mono = (n, dir) => {   /* اتجاه لا لبس فيه: ضجيج ضئيل */
    const ds = synthMarket(30, n, 5, { drift: dir * 0.002, mktVol: 0.002 });
    return M.marketBreadth(ds);
  };
  const up = mono(300, +1), dn = mono(300, -1);
  ok(up.ok && dn.ok, 'تعذّر بناء المؤشر');
  console.log(`      صاعد → ${up.regime} (20ج ${up.indexSlope20} · 60ج ${up.indexSlope60} · اتساع ${up.breadthPct}٪)`);
  console.log(`      هابط → ${dn.regime} (20ج ${dn.indexSlope20} · 60ج ${dn.indexSlope60} · اتساع ${dn.breadthPct}٪)`);
  ok(up.regime === 'risk_on', 'لم يصنّف الصعود الواضح صاعداً: ' + up.regime);
  ok(dn.regime === 'risk_off', 'لم يصنّف الهبوط الواضح هابطاً: ' + dn.regime);
  ok(dn.sizeMultiplier < up.sizeMultiplier, 'لم يخفض الحجم في السوق الهابط');
});

test('الارتفاع داخل تراجع أكبر: النظام صاعد والسياق يُقال بجواره', () => {
  /* 🛠️ اختبار أول طالب بخفض التصنيف إلى «تحوّل». وكان مخطئاً: 60 جلسة
     صعوداً باتساع 90٪ نظامٌ صاعد بأي تعريف، مهما كان ما قبلها. لكن
     التاجر يحتاج السياق أيضاً، فيُعرض بجوار النظام لا يُدسّ فيه —
     ويُخفَّض حجم المخاطرة المعقول. */
  const r = M.marketBreadth(synthMarket(30, 300, 5, { drift: -0.0015 }));
  ok(r.ok, r.reason);
  console.log(`      ${r.regime} · تراجع عن القمة ${r.context.drawdownPct}٪ · حجم ×${r.sizeMultiplier}`);
  ok(r.context && isFinite(r.context.drawdownPct), 'لا سياق طويل المدى');
  ok(r.context.insideLargerDecline === true, 'لم يُرصد أن الارتفاع داخل تراجع أكبر');
  ok(/تحت أعلى قمة/.test(r.note), 'السياق غير مذكور في النص');
  ok(r.sizeMultiplier <= 0.7, 'لم يُخفَّض الحجم رغم التراجع الكبير غير المستردّ');
});

test('يمتنع عن الحكم على عدد أسهم غير كافٍ', () => {
  const r = M.marketBreadth(synthMarket(4, 300, 1));
  ok(!r.ok && typeof r.reason === 'string', 'أصدر حكماً من 4 أسهم');
});

test('يصرّح بأن المؤشر ليس تاسي الرسمي', () => {
  const r = M.marketBreadth(synthMarket(30, 300, 3));
  ok(/تاسي/.test(r.caveat || ''), 'لا تصريح بالفرق عن المؤشر الرسمي');
});

test('القوة النسبية تُقاس بالفارق لا بالقسمة', () => {
  const ds = synthMarket(20, 300, 9);
  const b = M.marketBreadth(ds);
  const rs = M.relativeStrength(ds[0].cs, b.indexSeries, 60);
  ok(rs && isFinite(rs.excessPct), 'لا فارق محسوب');
  ok(!('ratio' in rs), 'أُعيدت قسمة — تنفجر حين يقارب المؤشر الصفر');
  ok(rs.outperforming === (rs.stockROCPct > rs.marketROCPct), 'علامة التفوّق لا تطابق الفارق');
});

/* ══════════════════════════════════════════════════════════════════════ */
group('القياس المقطعي المجمّع');

(async () => {
  await atest('يمتنع عن الحكم على أسهم غير كافية', async () => {
    const r = await M.poolEvaluate(synthMarket(5, 400, 2), { step: 8, recompute: 8, bootstrap: 50 });
    ok(!r.ok && /سهم/.test(r.reason), 'أصدر حكماً من 5 أسهم');
  });

  await atest('يجمع عبر الأسهم ويعطي عيّنة أكبر بمراحل من سهم واحد', async () => {
    const ds = synthMarket(30, 400, 7);
    const pooled = await M.poolEvaluate(ds, { step: 8, recompute: 8, bootstrap: 150 });
    ok(pooled.ok, pooled.reason);
    const single = T.evaluateGates(ds[0].cs, { step: 8, recompute: 8 });
    const singleN = single.ok ? single.samples : 0;
    console.log(`      سهم واحد: ${singleN} نقطة · السوق: ${pooled.trades} صفقة من ${pooled.symbols} سهماً`);
    ok(pooled.trades > singleN * 5, 'التجميع لم يزد العيّنة معنوياً');
  });

  await atest('كل تركيبة تحمل اتساق الأسهم لا نسبة الصفقات وحدها', async () => {
    const r = await M.poolEvaluate(synthMarket(30, 400, 11), { step: 8, recompute: 8, bootstrap: 150 });
    ok(r.ok, r.reason);
    for (const c of r.combos) {
      ok(Number.isFinite(c.trades) && Number.isFinite(c.symbolsTested), 'تركيبة بلا عدّادات');
      ok(c.symbolsBetter <= c.symbolsTested, 'اتساق مستحيل');
      if (c.symbolsTested >= 5) ok(c.consistencyPct != null, 'لا مقياس اتساق رغم كفاية الأسهم');
      ok(typeof c.pConsistency === 'string', 'لا قيمة احتمال');
    }
  });

  await atest('«صامدة» تتطلب الشروط الثلاثة مجتمعة', async () => {
    const r = await M.poolEvaluate(synthMarket(30, 400, 13), { step: 8, recompute: 8, bootstrap: 150 });
    ok(r.ok, r.reason);
    for (const c of r.combos) {
      if (!c.robust) continue;
      ok(c.liftPts > 0, 'صامدة برفع غير موجب');
      ok(c.consistencyPct > 50, 'صامدة بتفوّق في أقل من نصف الأسهم');
      ok(c.winRateCI && c.winRateCI[0] > r.baseline.winRatePct, 'صامدة وفاصلها يشمل خط الأساس');
    }
  });

  await atest('حتمي — نفس المدخل نفس المخرج', async () => {
    const ds = synthMarket(20, 400, 17);
    const a = await M.poolEvaluate(ds, { step: 10, recompute: 10, bootstrap: 100 });
    const b = await M.poolEvaluate(ds, { step: 10, recompute: 10, bootstrap: 100 });
    ok(JSON.stringify(a) === JSON.stringify(b), 'النتيجة تتغيّر بين تشغيلين');
  });

  await atest('يصرّح بحدود التعميم', async () => {
    const r = await M.poolEvaluate(synthMarket(25, 400, 19), { step: 10, recompute: 10, bootstrap: 100 });
    if (!r.ok) return;
    ok(/لا يعني تفوّقاً على سهم بعينه/.test(r.caveat || ''), 'لا تحذير من تعميم نتيجة السوق على سهم');
    ok(/تمهيد/.test(r.method || ''), 'لا شرح للطريقة');
  });

  /* ══════════════════════════════════════════════════════════════════ */
  group('المعايرة بفصل تدريب/اختبار');

  await atest('التقسيم متوازن وحتمي مهما كان نمط الرموز', async () => {
    /* 🛠️ النسخة الأولى قارنت التجزئة بعتبة 0.5 مباشرةً فأعطت 10/50 على
       رموز متشابهة البنية — نصفٌ لا يكفي للقياس أصلاً. */
    for (const [name, n, pre] of [['C', 60, 'C'], ['S', 100, 'S'], ['أرقام', 40, '10']]) {
      const ds = [];
      for (let i = 0; i < n; i++) ds.push({ sym: pre + i, cs: synthMarket(1, 200, 100 + i)[0].cs });
      const r = await M.calibrate(ds, { step: 20, recompute: 20, maxSymbols: n, warmup: 120 });
      if (!r.ok && /التقسيم أعطى/.test(r.reason)) throw new Error(`${name}: تقسيم غير متوازن — ${r.reason}`);
      if (r.ok) {
        const ratio = r.trainSymbols / (r.trainSymbols + r.testSymbols);
        ok(ratio > 0.35 && ratio < 0.65, `${name}: نسبة ${ratio.toFixed(2)} غير متوازنة`);
      }
    }
  });

  await atest('لا يعلن صموداً على سوق بلا أفضلية حقيقية', async () => {
    const r = await M.calibrate(synthMarket(60, 400, 7), { step: 12, recompute: 12, maxSymbols: 60 });
    if (!r.ok) { console.log('      امتنع: ' + r.reason.slice(0, 70)); return; }
    console.log(`      «${r.chosen.label}» تدريب ${r.chosen.trainLiftPts} → اختبار ${r.test.liftPts} (انكماش ${r.shrinkPts})`);
    ok(r.held === false, `أعلن صموداً على سوق بُني بلا أفضلية — رفع اختبار ${r.test.liftPts}`);
    ok(/لم يصمد|لم يُنتج/.test(r.verdict), 'الحكم لا يوضّح عدم الصمود');
  });

  await atest('يرصد الأفضلية الحقيقية ولا يكتفي بالرفض', async () => {
    /* أداة تقول «لا» دائماً عديمة الفائدة. هنا دورة نقية قوية بالبناء. */
    const cyc = [];
    for (let k = 0; k < 60; k++) {
      const r = rng(31 + k * 131), P = 18 + (k % 14);
      let t = Math.floor(Date.UTC(2022, 0, 2) / 1000), prev = 50; const cs = [];
      for (let i = 0; i < 400; i++) {
        let d = new Date(t * 1000);
        while (d.getUTCDay() === 5 || d.getUTCDay() === 6) { t += 86400; d = new Date(t * 1000); }
        const p = 50 * Math.exp(0.0003 * i + 0.075 * Math.cos(2 * Math.PI * i / P) + 0.004 * gauss(r));
        const w = p * 0.008 * (0.4 + r());
        cs.push({ time: t, open: +prev.toFixed(2), high: +Math.max(prev, p, p + w).toFixed(2), low: +Math.min(prev, p, p - w).toFixed(2), close: +p.toFixed(2), volume: 300000 });
        prev = p; t += 86400;
      }
      cyc.push({ sym: 'C' + k, cs });
    }
    const r = await M.calibrate(cyc, { step: 12, recompute: 12, maxSymbols: 60 });
    ok(r.ok, r.reason);
    console.log(`      «${r.chosen.label}» تدريب ${r.chosen.trainLiftPts} → اختبار ${r.test.liftPts} (انكماش ${r.shrinkPts})`);
    ok(r.held === true, `لم يرصد أفضلية مزروعة بالبناء — رفع اختبار ${r.test.liftPts}`);
    ok(r.test.liftPts > 10, 'الرفع خارج العيّنة ضئيل رغم دورة نقية');
  });

  await atest('يقيس إعداداً واحداً فقط على الاختبار', async () => {
    const r = await M.calibrate(synthMarket(50, 400, 23), { step: 14, recompute: 14, maxSymbols: 50 });
    if (!r.ok) return;
    ok(r.chosen && r.chosen.gate, 'لا إعداد مختار');
    ok(r.trialsRun > 1, 'لم تُجرَّب إعدادات متعددة على التدريب');
    /* الاختبار يحمل رقماً واحداً لا جدول محاولات — وهذا شرط سلامته */
    ok(!Array.isArray(r.test), 'الاختبار أعاد عدة نتائج — يُبطل الحماية من الاختبارات المتعددة');
    ok(typeof r.test.liftPts === 'number' || r.test.liftPts === null, 'شكل نتيجة الاختبار غير متوقع');
  });

  await atest('يعرض الانكماش صراحةً — وهو الدرس لا الرقم', async () => {
    const r = await M.calibrate(synthMarket(50, 400, 29), { step: 14, recompute: 14, maxSymbols: 50 });
    if (!r.ok) return;
    ok('shrinkPts' in r, 'لا مقياس للانكماش');
    ok(/تفرض عتبة|التدريب|الاختبار/.test(r.method), 'لا شرح للطريقة');
    ok(/نصف اختبار واحد/.test(r.caveat || ''), 'لا تصريح بحدود القياس');
  });

  /* ══════════════════════════════════════════════════════════════════ */
  group('القائمة الاستباقية');

  await atest('ترتّب بحسب القرب من الجاهزية', async () => {
    const ds = synthMarket(40, 300, 23, { period: 24, amp: 0.06 });
    const w = M.watchlist(ds);
    ok(w.ok, 'تعذّر بناء القائمة');
    console.log(`      ${w.total} سهماً · جاهز ${w.counts.ready} · ينتظر السعر ${w.counts.approach} · نافذة قريبة ${w.counts.watch}`);
    for (let i = 1; i < w.rows.length; i++) {
      const a = w.rows[i - 1], b = w.rows[i];
      if (a.improving === b.improving) ok(a.urgency >= b.urgency, `الترتيب مكسور: ${a.sym}(${a.urgency}) قبل ${b.sym}(${b.urgency})`);
    }
  });

  await atest('ترصد التحوّل بين لقطتين ولا تعيد نفس القائمة كل يوم', async () => {
    const ds = synthMarket(30, 300, 29, { period: 22, amp: 0.06 });
    const first = M.watchlist(ds);
    /* لقطة مصطنعة مختلفة: نجعل كل الأسهم كانت "no_trade" بالأمس */
    const fake = { states: {} };
    for (const d of ds) fake.states[d.sym] = 'no_trade';
    const second = M.watchlist(ds, { previous: fake });
    ok(second.transitions >= first.transitions, 'لم تُرصد أي تحوّلات رغم اختلاف اللقطة');
    const improved = second.rows.filter(r => r.improving);
    if (improved.length) ok(second.rows[0].improving, 'التحوّل نحو الأفضل ليس في المقدمة');
    console.log(`      تحوّلات مرصودة: ${second.transitions} · منها نحو الأفضل: ${improved.length}`);
  });

  await atest('لا سهم يُدرَج بلا قرب ولا تحوّل', async () => {
    const w = M.watchlist(synthMarket(30, 300, 31));
    for (const r of w.rows) ok(r.urgency > 0 || r.changed, `أُدرج ${r.sym} بلا إلحاح ولا تحوّل`);
  });

  await atest('تصرّح بأن «استباقي» ليست تنبؤاً بالسعر', async () => {
    const w = M.watchlist(synthMarket(20, 300, 37));
    ok(/لا تنبؤ بالسعر/.test(w.caveat || ''), 'لا تصريح بحدود المعنى');
    ok(/ليس أمر شراء/.test(w.caveat || ''), 'لا تصريح بأن الإدراج ليس أمر شراء');
  });

  await atest('كل صف جاهز يحمل أسعاره', async () => {
    const w = M.watchlist(synthMarket(40, 300, 41, { period: 20, amp: 0.06 }));
    for (const r of w.rows) if (r.action === 'ready') {
      ok(r.plan && isFinite(r.plan.entry) && isFinite(r.plan.stop), `صف جاهز بلا أسعار: ${r.sym}`);
    }
  });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`نجح ${passed} · فشل ${failed}`);
  if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
  console.log('═'.repeat(60));
  process.exit(failed ? 1 : 0);
})();
