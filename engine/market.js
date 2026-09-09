/* ══════════════════════════════════════════════════════════════════════════
   KSAMarket — الطبقة المقطعية: قياس على السوق كله، لا على سهم واحد
   ──────────────────────────────────────────────────────────────────────────
   تُحمَّل بعد engine/core.js و engine/timing.js.

   لماذا وُجدت هذه الطبقة، وهي أهم إضافة في المنصة منذ المحرك نفسه:

   كل قياس أُجري حتى الآن فشل لسبب واحد متكرّر — **حجم العيّنة**. سهم واحد
   بسنتين تاريخ يعطي نحو 200 نقطة قياس، وبعد التصفية تبقى 20 أو 30، وفاصل
   الثقة عليها يمتدّ 20 نقطة مئوية. لا يوجد تحسين في المرشّحات يصلح هذا:
   العيب في العيّنة لا في الفكرة.

   الحل المقطعي: تُقاس البوابة على **السوق كله دفعةً واحدة**. 250 سهماً ×
   200 نقطة = 50,000 نقطة. عندها يضيق الفاصل ويصير الحكم ممكناً.

   ⚠️ لكنّ التجميع الساذج **خطأ فادح** يعطي أرقاماً جميلة كاذبة، ولهذا كُتب
   هذا الملف بعناية. صفقات السهم الواحد ليست مستقلة عن بعضها (نفس الشركة،
   فترات متداخلة)، وصفقات اليوم الواحد عبر الأسهم ليست مستقلة (السوق يتحرّك
   معاً). حساب فاصل ثقة على 50,000 نقطة كأنها مستقلة يعطي فاصلاً أضيق
   بمرّات من الحقيقة — أي ادّعاء دقّة غير موجودة، وهو نفس العيب الذي بُنيت
   هذه المنصة لإزالته، لكن بلبوس أفخم.

   العلاج هنا ثلاثي:
   ① **تمهيد بالسهم (bootstrap على مستوى السهم):** تُعاد المعاينة بسحب
     *الأسهم* لا الصفقات، فيُحفَظ الارتباط داخل السهم ويظهر في اتساع الفاصل.
   ② **الاتساق عبر الأسهم:** في كم سهماً تفوّقت التركيبة على خط أساس ذلك
     السهم نفسه؟ تفوّق في 60٪ من الأسهم أقوى دلالةً من فارق مجمّع كبير
     ناتج عن ثلاثة أسهم شاذّة.
   ③ **حجم عيّنة فعّال:** يُعرض عدد الأسهم لا عدد الصفقات فقط، لأن الأول هو
     ما يحكم الدقّة فعلاً.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const core = isNode ? require('./core.js') : (root && root.KSAEngine);
  const timing = isNode ? require('./timing.js') : (root && root.KSATiming);
  const api = factory(core, timing);
  if (isNode) module.exports = api;
  if (root) root.KSAMarket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, T) {
  'use strict';

  if (!E || !T) throw new Error('KSAMarket يتطلب engine/core.js و engine/timing.js');

  const VERSION = '1.0.0';
  const S = E.Stats;
  const isNum = v => typeof v === 'number' && isFinite(v);
  const r2 = v => (isNum(v) ? +v.toFixed(2) : null);
  const r3 = v => (isNum(v) ? +v.toFixed(3) : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ════════════════════════════════════════════════════════════════════
     1) نظام السوق — السياق الذي كان غائباً تماماً
     ──────────────────────────────────────────────────────────────────
     أغلب الأسهم السعودية تتحرّك مع السوق. إشارة على مستوى السهم تتجاهل
     نظام السوق تقيس شيئاً مختلطاً: جزء منها السهم وجزء منها المؤشر. وفي
     سوق هابط تفشل إشارات الشراء كلها تقريباً مهما كانت جودتها — وهذا
     يُنسب خطأً إلى المرشّح بينما سببه النظام.

     يُبنى المؤشر هنا من الأسهم المحمّلة نفسها (متساوي الوزن) لا من مصدر
     خارجي: الفائدة أن السلسلتين من نفس المصدر وبنفس التعديلات، فمقارنتهما
     مشروعة. والاتساع (breadth) يُقاس كنسبة الأسهم فوق متوسطها الطويل —
     وهو أصدق من حركة المؤشر وحدها لأن مؤشراً ترفعه ثلاثة أسهم ثقيلة ليس
     سوقاً صاعداً.
     ══════════════════════════════════════════════════════════════════ */
  function marketBreadth(datasets, opt) {
    opt = opt || {};
    const maLen = opt.maLen || 50;
    const sets = (datasets || []).filter(d => d && d.cs && d.cs.length >= maLen + 20);
    if (sets.length < 10) return { ok: false, reason: `${sets.length} سهم فقط بتاريخ كافٍ — قياس نظام السوق يتطلب 10+` };

    /* مؤشر متساوي الوزن: متوسط العوائد اليومية، تراكمياً */
    const minLen = Math.min.apply(null, sets.map(d => d.cs.length));
    const idx = [100];
    for (let i = 1; i < minLen; i++) {
      let sum = 0, n = 0;
      for (const d of sets) {
        const cs = d.cs, off = cs.length - minLen;
        const a = cs[off + i - 1].close, b = cs[off + i].close;
        if (a > 0 && b > 0) { sum += Math.log(b / a); n++; }
      }
      idx.push(idx[i - 1] * Math.exp(n ? sum / n : 0));
    }

    /* الاتساع: نسبة الأسهم فوق متوسطها المتحرك الطويل */
    let above = 0, counted = 0;
    for (const d of sets) {
      const cl = d.cs.map(c => c.close);
      if (cl.length < maLen) continue;
      let m = 0; for (let i = cl.length - maLen; i < cl.length; i++) m += cl[i];
      m /= maLen;
      counted++; if (cl[cl.length - 1] > m) above++;
    }
    const breadthPct = counted ? above / counted * 100 : 0;

    /* ميل المؤشر على 20 و60 جلسة، مُطبَّعاً */
    const slope = win => {
      const seg = idx.slice(-Math.min(win, idx.length));
      const r = S.linreg(seg);
      return seg[seg.length - 1] ? r.slope / seg[seg.length - 1] * 100 : 0;
    };
    const s20 = slope(20), s60 = slope(60);
    const vol = E.volatility(idx);

    /* ══ السياق الأطول ══════════════════════════════════════════════════
       النظام حالة راهنة، والسياق شيء آخر — وخلطهما يفسد الاثنين. مؤشر
       صاعد 60 جلسة باتساع 90٪ هو نظام صاعد بأي تعريف، حتى لو كان ما زال
       50٪ تحت قمته. لكن التاجر يحتاج أن يعرف الاثنين: «صاعد» تقول له
       اتجاه اليوم، و«ما زال 50٪ تحت القمة» تقول له أين هو من الصورة
       الكبرى. لذلك يُعرض السياق بجوار النظام ولا يُدسّ فيه. */
    let peak = idx[0];
    for (const v of idx) if (v > peak) peak = v;
    const drawdownPct = peak > 0 ? (idx[idx.length - 1] / peak - 1) * 100 : 0;
    const lookback = Math.min(200, idx.length - 1);
    const longPct = lookback > 0 ? (idx[idx.length - 1] / idx[idx.length - 1 - lookback] - 1) * 100 : 0;
    const insideLargerDecline = drawdownPct < -15;

    /* ══ التصنيف ══════════════════════════════════════════════════════
       🛠️ نسخة أولى صنّفت بميل 20 جلسة والاتساع فقط، وحسبت ميل 60 جلسة ثم
       لم تستعمله. القياس فضحها: سوق هبط مؤشره من 100 إلى 45.7 (‏−54٪)
       صُنّف «صاعداً» لأن آخر 20 جلسة كانت ارتداداً. النظام حالة مستمرّة لا
       تموّج عشرين يوماً، وارتداد داخل هبوط ليس سوقاً صاعداً.

       القاعدة الآن: الاتجاه لا يُعلَن إلا باتفاق المديين القصير والمتوسط
       **مع** الاتساع. واختلافهما حالة قائمة بذاتها تُسمّى باسمها — تحوّل
       محتمل — لا تُدسّ في «محايد»، لأن التمييز بينهما يغيّر القرار. */
    let regime, mult, note;
    const upShort = s20 > 0.05, upMed = s60 > 0.02;
    const dnShort = s20 < -0.05, dnMed = s60 < -0.02;

    if (upShort && upMed && breadthPct >= 55) {
      regime = 'risk_on'; mult = 1;
      note = `سوق صاعد متّسع: ميل 20 جلسة ${r3(s20)}٪ و60 جلسة ${r3(s60)}٪، و${r2(breadthPct)}٪ من الأسهم فوق متوسطها ${maLen}. إشارات الشراء تعمل في مثل هذا النظام أكثر مما تعمل في غيره.`;
    } else if (dnShort && dnMed && breadthPct <= 45) {
      regime = 'risk_off'; mult = 0.35;
      note = `سوق هابط متّسع: ميل 20 جلسة ${r3(s20)}٪ و60 جلسة ${r3(s60)}٪، و${r2(breadthPct)}٪ فقط فوق متوسطها ${maLen}. في هذا النظام تفشل أغلب إشارات الشراء مهما كانت جودتها — والسبب النظام لا المرشّح. قلّل الحجم أو انتظر.`;
    } else if ((upShort && dnMed) || (dnShort && upMed)) {
      regime = 'transition'; mult = 0.5;
      note = `تحوّل محتمل: المدى القصير (${r3(s20)}٪) والمتوسط (${r3(s60)}٪) متعارضان، والاتساع ${r2(breadthPct)}٪. `
        + (upShort
          ? 'ارتداد داخل هبوط أو بداية انعكاس — والفرق بينهما لا يُعرف إلا بعد وقوعه. أخطر نظام على إشارات الشراء: يبدو صاعداً ثم يستأنف الهبوط.'
          : 'تراجع داخل صعود أو بداية انعكاس. لا تزد الحجم حتى يتّفق المديان.');
    } else {
      regime = 'neutral'; mult = 0.7;
      note = `سوق بلا اتجاه متّسع: ميل 20 جلسة ${r3(s20)}٪ و60 جلسة ${r3(s60)}٪، اتساع ${r2(breadthPct)}٪. الإشارات الانتقائية فقط، وبحجم أقل.`;
    }

    if (insideLargerDecline)
      note += ` ⚠️ وللسياق: المؤشر ما زال ${r2(drawdownPct)}٪ تحت أعلى قمة في الفترة المقاسة (${r2(longPct)}٪ عن ${lookback} جلسة مضت) — أي أن ما نراه ارتفاع داخل تراجع أكبر لم يُستردّ بعد. لا يُغيّر هذا نظام اليوم، لكنه يُغيّر حجم المخاطرة المعقول.`;

    return {
      ok: true, regime, sizeMultiplier: insideLargerDecline ? Math.min(mult, 0.7) : mult, note,
      context: {
        drawdownPct: r2(drawdownPct),
        longTermPct: r2(longPct),
        lookbackBars: lookback,
        insideLargerDecline
      },
      indexSeries: idx,
      indexSlope20: r3(s20), indexSlope60: r3(s60),
      breadthPct: r2(breadthPct),
      symbolsUsed: sets.length,
      volatilityPct: vol.ok ? vol.dailyPct : null,
      caveat: 'المؤشر متساوي الوزن مبنيّ من الأسهم المحمّلة نفسها، فهو ليس تاسي الرسمي (مرجّح بالقيمة السوقية). الفارق مقصود: متساوي الوزن يصف السهم الوسيط، وهو الأقرب لما تتداوله فعلاً.'
    };
  }

  /** القوة النسبية مقابل المؤشر المبني أعلاه — لا مقابل رقم مفروض. */
  function relativeStrength(cs, index, win) {
    win = win || 60;
    if (!cs || !index || cs.length < win + 1 || index.length < win + 1) return null;
    const roc = a => { const n = a.length; return (a[n - 1] / a[n - 1 - win] - 1) * 100; };
    const stock = roc(cs.map(c => c.close)), mkt = roc(index);
    return {
      stockROCPct: r2(stock), marketROCPct: r2(mkt),
      excessPct: r2(stock - mkt),
      /* التفوّق يُقاس بالفارق لا بالنسبة: القسمة تنفجر حين يقارب المؤشر الصفر */
      outperforming: stock > mkt,
      window: win
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     2) القياس المقطعي المجمّع
     ──────────────────────────────────────────────────────────────────
     الفكرة بسيطة والتنفيذ هو الصعب: بدل «هل تعمل البوابة على 2040؟»
     (عيّنة 58، فاصل 20 نقطة، لا حكم) نسأل «هل تعمل على السوق؟» (عيّنة
     عشرات الآلاف). لكن التجميع الساذج يكذب، فانظر رأس الملف.
     ══════════════════════════════════════════════════════════════════ */

  const GATES = T.GATE_NAMES;

  /** يجمع صفوف القياس لسهم واحد، موسومة برمزه — دون تلخيص.
   *  `cfg.gate` يُمرَّر إلى timingSignal، فتصير إعدادات البوابات نفسها
   *  قابلة للمعايرة بدل أن تكون أرقاماً مثبّتة اخترناها بلا قياس. */
  function _rowsFor(cs, cfg) {
    const atrA = E.atrSeries(cs, 14);
    const last = cs.length - 1 - cfg.horizon;
    const rows = [];
    let cached = null, cachedAt = -1;
    for (let t = cfg.warmup; t <= last; t += cfg.step) {
      const a = atrA[t];
      if (!isNum(a) || a <= 0) continue;
      let sig;
      if (cached && t - cachedAt < cfg.recompute) sig = cached;
      else { sig = T.timingSignal(cs, Object.assign({ idx: t }, cfg.gate || {})); cached = sig; cachedAt = t; }
      if (!sig.ok) continue;
      const tr = E.simulateTrade(cs, t, sig.dirUp !== false, {
        atrStopMult: cfg.atrStopMult, rewardRisk: cfg.rewardRisk,
        maxHoldBars: cfg.horizon, atrSeries: atrA
      });
      if (!tr) continue;
      const flags = {};
      for (const n of GATES) { const g = sig.gates.find(x => x.name === n); flags[n] = !!(g && g.pass); }
      rows.push({ t, time: cs[t].time, flags, win: tr.r > 0, r: tr.r });
    }
    return rows;
  }

  /**
   * تمهيد على مستوى السهم: تُسحب **الأسهم** بالإعادة لا الصفقات.
   * هذا ما يحفظ الارتباط داخل السهم فيظهر في اتساع الفاصل بدل أن يُخفى.
   *
   * حسّاسية الدالة مقاسة ومثبتة باختبار: على تكتّل تام داخل السهم تُخرج
   * فاصلاً أوسع ×6.9 من فاصل Wilson الساذج، وعلى صفقات مستقلة تماماً
   * تتطابق معه (×0.7). أي أنها ترصد التكتّل حين يوجد ولا تخترعه حين يغيب.
   */
  function _bootstrapCI(bySymbol, pick, iters, seed) {
    const syms = Object.keys(bySymbol);
    if (syms.length < 3) return null;
    const rnd = E.seededRandom(seed || 20260101);
    const stats = [];
    for (let b = 0; b < iters; b++) {
      let w = 0, n = 0;
      for (let i = 0; i < syms.length; i++) {
        const s = syms[Math.floor(rnd() * syms.length)];
        for (const row of bySymbol[s]) if (pick(row)) { n++; if (row.win) w++; }
      }
      if (n > 0) stats.push(w / n);
    }
    if (stats.length < iters * 0.5) return null;
    stats.sort((a, b) => a - b);
    const q = p => stats[clamp(Math.floor(p * (stats.length - 1)), 0, stats.length - 1)];
    return { lo: r2(q(0.025) * 100), hi: r2(q(0.975) * 100), iters: stats.length };
  }

  /**
   * @param {Array<{sym:string, cs:Array}>} datasets
   * @param {{step?,recompute?,horizon?,warmup?,minSymbols?,bootstrap?,onProgress?}} [opt]
   * @returns Promise — يفسح للواجهة بين الأسهم حتى لا تتجمّد
   */
  async function poolEvaluate(datasets, opt) {
    opt = opt || {};
    const cfg = {
      warmup: opt.warmup == null ? 120 : opt.warmup,
      step: opt.step == null ? 5 : opt.step,
      recompute: opt.recompute == null ? 5 : opt.recompute,
      horizon: opt.horizon == null ? 20 : opt.horizon,
      atrStopMult: opt.atrStopMult == null ? 1.5 : opt.atrStopMult,
      rewardRisk: opt.rewardRisk == null ? 2 : opt.rewardRisk,
      minSymbols: opt.minSymbols == null ? 15 : opt.minSymbols,
      minTrades: opt.minTrades == null ? 200 : opt.minTrades,
      bootstrap: opt.bootstrap == null ? 400 : opt.bootstrap,
      fdr: opt.fdr == null ? 0.10 : opt.fdr
    };

    const usable = (datasets || []).filter(d => d && d.cs && d.cs.length >= cfg.warmup + cfg.horizon + 30);
    if (usable.length < cfg.minSymbols)
      return { ok: false, reason: `${usable.length} سهم بتاريخ كافٍ فقط — القياس المقطعي يتطلب ${cfg.minSymbols}+ سهماً بـ${cfg.warmup + cfg.horizon + 30}+ جلسة. وسّع النطاق الزمني إلى سنتين ثم أعد المسح.`, config: cfg };

    const bySymbol = {};
    let done = 0;
    for (const d of usable) {
      try { const rows = _rowsFor(d.cs, cfg); if (rows.length) bySymbol[d.sym] = rows; }
      catch (e) { /* سهم واحد لا يُسقط القياس كله */ }
      done++;
      if (opt.onProgress) opt.onProgress(done, usable.length, d.sym);
      /* إفساح للواجهة — القياس ثقيل والتجميد تجربة سيئة لا عطل */
      if (done % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const syms = Object.keys(bySymbol);
    const all = [];
    for (const s of syms) for (const r of bySymbol[s]) all.push(r);
    if (syms.length < cfg.minSymbols || all.length < cfg.minTrades)
      return { ok: false, reason: `نتج ${all.length} صفقة من ${syms.length} سهم — دون الحد الأدنى (${cfg.minTrades} صفقة و${cfg.minSymbols} سهماً).`, config: cfg };

    const rate = rows => rows.length ? rows.filter(r => r.win).length / rows.length : null;
    const baseRate = rate(all);
    const baseWins = all.filter(r => r.win).length;

    /* خط الأساس لكل سهم على حدة — أساس مقياس الاتساق */
    const baseBySym = {};
    for (const s of syms) baseBySym[s] = rate(bySymbol[s]);

    const combos = [];
    for (let mask = 1; mask < (1 << GATES.length); mask++) {
      const names = GATES.filter((_, i) => mask & (1 << i));
      const pick = r => names.every(n => r.flags[n]);
      const sub = all.filter(pick);
      if (sub.length < 30) continue;

      const wins = sub.filter(r => r.win).length;
      const p = wins / sub.length;

      /* في كم سهماً تفوّقت التركيبة على خط أساس ذلك السهم نفسه؟ */
      let better = 0, tested = 0;
      for (const s of syms) {
        const ss = bySymbol[s].filter(pick);
        if (ss.length < 5) continue;
        tested++;
        if (rate(ss) > baseBySym[s]) better++;
      }

      const ci = _bootstrapCI(bySymbol, pick, cfg.bootstrap, 20260101 + mask);
      /* اختبار ذيل واحد على اتساق الأسهم: تحت فرضية العدم يتفوّق السهم
         بنسبة 50٪. هذا الاختبار وحداته الأسهم لا الصفقات، فهو محصّن ضد
         الارتباط داخل السهم — وهو الاختبار الذي أثق به هنا. */
      const pConsistency = tested >= 5 ? S.binomTailP(better, tested, 0.5) : 1;

      combos.push({
        gates: names, label: names.join(' + '),
        trades: sub.length, symbols: tested,
        winRatePct: r2(p * 100),
        winRateCI: ci ? [ci.lo, ci.hi] : null,
        liftPts: r2((p - baseRate) * 100),
        expectancyR: r3(S.mean(sub.map(r => r.r))),
        coveragePct: r2(sub.length / all.length * 100),
        symbolsBetter: better, symbolsTested: tested,
        consistencyPct: tested ? r2(better / tested * 100) : null,
        pConsistencyRaw: pConsistency
      });
    }

    if (!combos.length) return { ok: false, reason: 'لم تُنتج أي تركيبة 30 صفقة على الأقل عبر السوق كله.', config: cfg, symbols: syms.length, trades: all.length };

    const pass = S.benjaminiHochberg(combos.map(c => c.pConsistencyRaw), cfg.fdr);
    combos.forEach((c, i) => {
      c.pConsistency = S.pText(c.pConsistencyRaw);
      /* شرط ثلاثي: تفوّق مجمّع، واتساق عبر الأسهم، واجتياز تصحيح BH.
         أيّ واحد وحده يُنتج فائزين بالصدفة. */
      c.robust = !!(pass[i] && c.liftPts > 0 && c.consistencyPct > 50
        && c.winRateCI && c.winRateCI[0] > baseRate * 100);
    });

    const robust = combos.filter(c => c.robust).sort((a, b) => b.liftPts - a.liftPts);
    const ranked = combos.slice().sort((a, b) => b.liftPts - a.liftPts);

    return {
      ok: true,
      symbols: syms.length, trades: all.length,
      baseline: {
        winRatePct: r2(baseRate * 100), wins: baseWins, count: all.length,
        expectancyR: r3(S.mean(all.map(r => r.r)))
      },
      combos: ranked, robust,
      config: cfg,
      verdict: robust.length
        ? `${robust.length} تركيبة صمدت للشروط الثلاثة على مستوى السوق. أقواها «${robust[0].label}»: ${robust[0].winRatePct}٪ إصابة (فاصل تمهيد بالسهم ${robust[0].winRateCI[0]}–${robust[0].winRateCI[1]}٪) مقابل ${r2(baseRate * 100)}٪ لخط الأساس، برفع ${robust[0].liftPts} نقطة، وتفوّقت في ${robust[0].symbolsBetter} من ${robust[0].symbolsTested} سهماً (${robust[0].consistencyPct}٪). التغطية ${robust[0].coveragePct}٪ من الفرص.`
        : `لا تركيبة صمدت للشروط الثلاثة على مستوى السوق (${combos.length} تركيبة فُحصت على ${syms.length} سهماً و${all.length} صفقة). هذه أقوى نتيجة سلبية تنتجها المنصة: العيّنة هنا كبيرة بما يكفي، فالامتناع ليس نقص بيانات بل غياب أفضلية قابلة للقياس بهذه الطريقة على هذا السوق.`,
      method: 'الفاصل من تمهيد بسحب الأسهم بالإعادة (لا الصفقات)، فيحفظ الارتباط داخل السهم — ويتّسع بقدر التكتّل الفعلي في بياناتك لا بمقدار ثابت. والحكم لا يُمنح إلا لتركيبة اجتمع فيها ثلاثة: رفع موجب، وتفوّق في أكثر من نصف الأسهم، واجتياز تصحيح Benjamini-Hochberg على اختبار اتساق وحداته الأسهم لا الصفقات — لأن اختباراً وحداته الصفقات يتأثّر بالتكتّل، واختباراً وحداته الأسهم لا يتأثّر.',
      caveat: 'سوق واحد وفترة واحدة. لا تحسم العمولات ولا الانزلاق. وتفوّق على مستوى السوق لا يعني تفوّقاً على سهم بعينه — راجع عمود «اتساق الأسهم».'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     3) القائمة الاستباقية
     ──────────────────────────────────────────────────────────────────
     المنصة كلها كانت تجيب عن «ما حال هذا السهم الآن؟» — سؤال رجعي. وهذا
     القسم يجيب عن سؤال استباقي: **أي الأسهم على وشك أن تصير جاهزة، ومتى؟**

     الفرق عملي لا لفظي: حين تصير الإشارة «جاهزة» يكون السعر قد تحرّك
     غالباً. القيمة في رصد السهم وهو على بُعد جلستين أو ثلاث من اكتمال
     شروطه، فتراقبه قبل الحركة لا بعدها.

     ⚠️ «استباقي» هنا لا تعني تنبؤاً بالسعر. تعني ترتيب الأسهم بحسب قربها
     من حالة معرّفة سلفاً، وهذا قابل للحساب. أما التنبؤ بالحركة نفسها فليس
     كذلك، ولا يدّعيه هذا القسم.

     وأهمّ ما فيه **رصد التحوّل**: سهم انتقل اليوم من «مراقبة» إلى «انتظار
     وصول السعر» خبرٌ، وسهم ثابت على حاله منذ أسبوع ليس خبراً. المقارنة مع
     لقطة الأمس تُميّز بينهما، وبدونها تقرأ نفس القائمة كل يوم.
     ══════════════════════════════════════════════════════════════════ */

  const STATE_RANK = { ready: 0, approach: 1, watch: 2, no_trade: 3 };

  /**
   * @param {Array<{sym:string,name?:string,sec?:string,cs:Array}>} datasets
   * @param {{previous?:object, regime?:object, maxWindowBars?:number, limit?:number}} [opt]
   *        previous: لقطة سابقة من نفس الدالة (`snapshot`) لرصد التحوّلات.
   */
  function watchlist(datasets, opt) {
    opt = opt || {};
    const maxWin = opt.maxWindowBars == null ? 8 : opt.maxWindowBars;
    const prev = (opt.previous && opt.previous.states) || {};
    const rows = [], snapshot = { at: Date.now(), states: {} };

    for (const d of (datasets || [])) {
      if (!d || !d.cs || d.cs.length < 80) continue;
      let ap;
      try { ap = T.actionPlan(d.cs, { measured: (opt.measured || {})[d.sym] }); }
      catch (e) { continue; }
      if (!ap.ok) continue;

      snapshot.states[d.sym] = ap.action;
      const before = prev[d.sym];
      const changed = before && before !== ap.action;
      /* تحوّل نحو الجاهزية خبر؛ والابتعاد عنها خبر أيضاً لمن يملك المركز */
      const improving = changed && STATE_RANK[ap.action] < STATE_RANK[before];

      const w = ap.window || null;
      const bars = w && isNum(w.barsAhead) ? w.barsAhead : null;
      /* الإلحاح: قرب النافذة زمنياً. الجاهز الآن إلحاحه أقصى. */
      const urgency = ap.action === 'ready' ? 100
        : ap.action === 'approach' ? 80
          : (bars != null && bars <= maxWin) ? clamp(70 - bars * 6, 20, 70)
            : 0;
      if (urgency <= 0 && !changed) continue;   /* لا خبر ولا قرب ⇒ لا يُدرَج */

      rows.push({
        sym: d.sym, name: d.name || '', sec: d.sec || '',
        action: ap.action, title: ap.title, actionText: ap.action_ar,
        barsAhead: bars, windowType: w ? w.type : null,
        windowDate: w && w.date ? w.date : null,
        sdBars: w ? w.sdBars : null,
        urgency,
        changed: !!changed, previousAction: before || null, improving: !!improving,
        plan: ap.plan ? { entry: ap.plan.entry, stop: ap.plan.stop, target: ap.plan.target1, rr: ap.plan.rr1 } : null,
        why: (ap.why && ap.why[0]) || ''
      });
    }

    /* الترتيب: التحوّل نحو الأفضل أولاً، ثم الإلحاح، ثم قرب النافذة */
    rows.sort((a, b) =>
      (b.improving - a.improving) || (b.urgency - a.urgency) ||
      ((a.barsAhead == null ? 999 : a.barsAhead) - (b.barsAhead == null ? 999 : b.barsAhead)));

    const counts = { ready: 0, approach: 0, watch: 0, no_trade: 0 };
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;

    const reg = opt.regime;
    return {
      ok: true,
      rows: opt.limit ? rows.slice(0, opt.limit) : rows,
      total: rows.length, counts,
      transitions: rows.filter(r => r.changed).length,
      snapshot,
      regime: reg || null,
      note: rows.length
        ? `${rows.length} سهماً على القائمة: ${counts.ready} مكتمل الشروط · ${counts.approach} ينتظر وصول السعر · ${counts.watch} داخل نافذة قريبة.`
          + (reg && reg.ok ? ` ونظام السوق ${reg.regime === 'risk_on' ? 'صاعد متّسع' : reg.regime === 'risk_off' ? 'هابط متّسع — قلّل الحجم أو انتظر' : 'متذبذب — انتقائية وحجم أقل'}.` : '')
        : 'لا سهم قريب من نافذة زمنية الآن. هذه نتيجة معتادة لا عطل: النوافذ نادرة بحكم التعريف، ولو ظهرت كل يوم لما كانت نافذة.',
      caveat: '«استباقي» هنا = ترتيب بحسب القرب من حالة معرّفة سلفاً، لا تنبؤ بالسعر. والإدراج في القائمة ليس أمر شراء: شرط التأكيد السعري يبقى لازماً.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     3.5) المعايرة بفصل تدريب/اختبار — الرد المنهجي على «لا شيء يعمل»
     ──────────────────────────────────────────────────────────────────
     القياس المقطعي أعطى نتيجة سلبية واضحة على السوق الحقيقي، وكشف معها
     ثلاثة أسباب بنيوية لا تُعالَج بتحسين المرشّحات:

     ① **بوابات لا تُطلق أصلاً.** الدورة أطلقت على 1.6٪ من الفرص فقط،
       والالتواء 0.5٪، والفواصل 0.8٪. بوابة بهذه الندرة لا يمكن التحقّق
       منها ولو قِست على السوق كله عشر سنوات — لأنها لا تُنتج عيّنة.
       والسبب إعداداتها: نافذة 3 جلسات حول الانعطاف شرط قاسٍ جداً.
     ② **أرقام مثبّتة لم تُقس قط.** نافذة الانعطاف 3، وهامش السيولة
       0.15×ATR، وعتبة المشاركة 0.8 — كلها اخترناها بالحدس. الاختيار
       بالحدس ثم القياس عليه يقيس الحدس لا الفكرة.
     ③ **ولا يجوز اختيار الإعدادات على نفس البيانات التي نحكم بها.** لو
       جرّبنا عشرين إعداداً واخترنا أفضلها ثم أعلنّا نتيجته، لأعلنّا حظاً.

     العلاج هو الطريقة القياسية الوحيدة الصحيحة: **تُقسَّم الأسهم** إلى
     نصفين (لا الأزمنة — تقسيم زمني يجعل التدريب والاختبار في نظامَي سوق
     مختلفين فيختلط أثر الإعداد بأثر النظام). تُجرَّب كل الإعدادات على نصف
     التدريب، ويُختار **واحد**، ثم يُقاس ذلك الواحد وحده على نصف الاختبار
     الذي لم يُمسّ. الفرق بين الرقمين هو مقدار ما كان وهماً.

     ⚠️ والرقم الوحيد الذي يُعتدّ به هو رقم الاختبار. ورقم التدريب يُعرض
     بجواره لسبب واحد: أن ترى بعينك كم يتضخّم الرقم حين يُختار على نفس
     البيانات — وهو الدرس الأهم في هذا التقرير كله.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * تقسيم حتمي بالرمز: نفس الأسهم في نفس النصف عبر كل التشغيلات.
   *
   * 🛠️ النسخة الأولى قارنت قيمة التجزئة بعتبة 0.5 مباشرةً، فأعطت على رموز
   * متشابهة البنية (C0…C59) تقسيماً 10/50 — نصفٌ لا يكفي للقياس أصلاً.
   * دالة تجزئة جيدة تُوزّع جيداً في المتوسط، لكن على 60 عنصراً قد ينحرف
   * التوزيع كثيراً بالصدفة وحدها، ولا يصحّ ترك التوازن للصدفة.
   * الصحيح: تُرتَّب الرموز بقيمة التجزئة ويُقصّ عند الوسيط — فيبقى
   * التقسيم حتمياً ومستقلاً عن ترتيب الإدخال، ويكون متوازناً بالضبط.
   */
  function _splitSymbols(syms, frac) {
    const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
    const ordered = syms.slice().map(s => ({ s, h: hash(String(s)) })).sort((a, b) => a.h - b.h || (a.s < b.s ? -1 : 1));
    const cut = Math.round(ordered.length * (frac == null ? 0.5 : frac));
    return { train: ordered.slice(0, cut).map(x => x.s), test: ordered.slice(cut).map(x => x.s) };
  }

  /** الشبكة المفحوصة — معلنة لا مخفيّة، فيمكن مراجعتها وتوسيعها. */
  const CALIB_GRID = [
    { windowBars: 3, tolATR: 0.15 }, { windowBars: 3, tolATR: 0.40 },
    { windowBars: 6, tolATR: 0.15 }, { windowBars: 6, tolATR: 0.40 },
    { windowBars: 10, tolATR: 0.40 }, { windowBars: 10, tolATR: 0.80 },
    { windowBars: 15, tolATR: 0.80 }
  ];

  async function calibrate(datasets, opt) {
    opt = opt || {};
    const cfg = {
      warmup: opt.warmup == null ? 120 : opt.warmup,
      step: opt.step == null ? 8 : opt.step,
      recompute: opt.recompute == null ? 8 : opt.recompute,
      horizon: opt.horizon == null ? 20 : opt.horizon,
      atrStopMult: opt.atrStopMult == null ? 1.5 : opt.atrStopMult,
      rewardRisk: opt.rewardRisk == null ? 2 : opt.rewardRisk,
      minCoveragePct: opt.minCoveragePct == null ? 5 : opt.minCoveragePct,
      minTrades: opt.minTrades == null ? 120 : opt.minTrades,
      maxSymbols: opt.maxSymbols == null ? 120 : opt.maxSymbols,
      grid: opt.grid || CALIB_GRID
    };

    let usable = (datasets || []).filter(d => d && d.cs && d.cs.length >= cfg.warmup + cfg.horizon + 30);
    if (usable.length < 30) return { ok: false, reason: `${usable.length} سهم بتاريخ كافٍ — المعايرة تتطلب 30+ لتقسيمها نصفين ذوَي معنى.`, config: cfg };
    if (usable.length > cfg.maxSymbols) usable = usable.slice(0, cfg.maxSymbols);

    const split = _splitSymbols(usable.map(d => d.sym));
    const trainSet = usable.filter(d => split.train.indexOf(d.sym) >= 0);
    const testSet = usable.filter(d => split.test.indexOf(d.sym) >= 0);
    if (trainSet.length < 12 || testSet.length < 12)
      return { ok: false, reason: `التقسيم أعطى ${trainSet.length}/${testSet.length} — كل نصف يحتاج 12 سهماً على الأقل.`, config: cfg };

    /* يقيس تركيبة واحدة بإعداد واحد على مجموعة أسهم */
    const measure = async (sets, gate, label) => {
      const bySym = {};
      let i = 0;
      for (const d of sets) {
        try { const rows = _rowsFor(d.cs, Object.assign({}, cfg, { gate })); if (rows.length) bySym[d.sym] = rows; }
        catch (e) { }
        if (++i % 3 === 0) await new Promise(r => setTimeout(r, 0));
        if (opt.onProgress) opt.onProgress(label, i, sets.length);
      }
      const all = [];
      for (const k in bySym) for (const r of bySym[k]) all.push(r);
      return { bySym, all };
    };

    const rate = rows => rows.length ? rows.filter(r => r.win).length / rows.length : null;

    /* ── مرحلة التدريب: كل الإعدادات × كل التركيبات ── */
    const trials = [];
    for (const gate of cfg.grid) {
      const { bySym, all } = await measure(trainSet, gate, 'تدريب');
      if (all.length < cfg.minTrades) continue;
      const base = rate(all);
      for (let mask = 1; mask < (1 << GATES.length); mask++) {
        const names = GATES.filter((_, i) => mask & (1 << i));
        const pick = r => names.every(n => r.flags[n]);
        const sub = all.filter(pick);
        const cov = sub.length / all.length * 100;
        if (cov < cfg.minCoveragePct || sub.length < 40) continue;
        let better = 0, tested = 0;
        for (const k in bySym) { const ss = bySym[k].filter(pick); if (ss.length < 5) continue; tested++; if (rate(ss) > rate(bySym[k])) better++; }
        trials.push({
          gate, gates: names, label: names.join(' + '),
          winRatePct: r2(rate(sub) * 100), baselinePct: r2(base * 100),
          liftPts: r2((rate(sub) - base) * 100),
          trades: sub.length, coveragePct: r2(cov),
          consistencyPct: tested ? r2(better / tested * 100) : null, symbolsTested: tested
        });
      }
    }

    if (!trials.length)
      return { ok: false, reason: `لا إعداد أنتج تركيبة تتجاوز عتبة التغطية ${cfg.minCoveragePct}٪ على نصف التدريب. هذه نتيجة بذاتها: البوابات بإعداداتها الحالية نادرة الإطلاق إلى حدّ يمنع التحقّق منها أصلاً.`, config: cfg, trainSymbols: trainSet.length, testSymbols: testSet.length };

    /* الاختيار: أعلى رفع، بشرط اتساق فوق النصف — لا الرفع وحده.
       🛠️ وحين لا يجتاز أي إعداد شرط الاتساق يقع الاختيار على أعلى رفع
       كبديل، وهذا **يُصرَّح به**: نسخة أولى كانت تسقط إلى البديل بصمت،
       فيقرأ المستخدم «الإعداد المختار» ولا يعرف أنه اختير بمعيار أضعف. */
    trials.sort((a, b) => (b.liftPts) - (a.liftPts));
    const eligible = trials.filter(t => t.consistencyPct != null && t.consistencyPct > 50);
    const chosen = eligible[0] || trials[0];
    const fallbackChoice = eligible.length === 0;

    /* ── مرحلة الاختبار: الإعداد المختار وحده، على أسهم لم تُمسّ ── */
    const { bySym: tSym, all: tAll } = await measure(testSet, chosen.gate, 'اختبار');
    const testBase = rate(tAll);
    const pick = r => chosen.gates.every(n => r.flags[n]);
    const tSub = tAll.filter(pick);
    let better = 0, tested = 0;
    for (const k in tSym) { const ss = tSym[k].filter(pick); if (ss.length < 5) continue; tested++; if (rate(ss) > rate(tSym[k])) better++; }
    const tCI = tSub.length ? _bootstrapCI(tSym, pick, 400, 777) : null;
    const testLift = tSub.length ? r2((rate(tSub) - testBase) * 100) : null;

    const shrink = (chosen.liftPts != null && testLift != null) ? r2(chosen.liftPts - testLift) : null;
    const held = testLift != null && testLift > 0 && tCI && tCI.lo > testBase * 100;

    /* ══ تمييز سببَي عدم التأكيد ══════════════════════════════════════
       🛠️ نسخة أولى أعلنت «لم يصمد ⇒ تفوّقه كان اختياراً على الضجيج» لكل
       حالة غير مؤكَّدة. وهذا خطأ فادح حين يكون رفع الاختبار **أعلى** من
       رفع التدريب: القياس الفعلي أعطى تدريب +2.08 واختبار +2.49، فكُتب
       «لم يصمد» و«اختيار على الضجيج» بجوار رقمين يقولان العكس.

       السببان مختلفان، وفعلهما مختلف:
       • **انكماش**: رفع الاختبار صفر أو أقلّ بكثير من التدريب ⇒ الإعداد
         اختير على الضجيج. العلاج: إعداد آخر، أو التخلّي عن الفكرة.
       • **ضعف قوة إحصائية**: الرفع صمد اتجاهاً لكنه أصغر من أن يُميَّز
         عن الصفر بهذه العيّنة. العلاج: **عيّنة أكبر لا إعداد أفضل** —
         وهذه نصيحة معاكسة تماماً للأولى. */
    const shrankAway = testLift == null || testLift <= 0
      || (chosen.liftPts > 0 && testLift < chosen.liftPts * 0.4);

    /* حجم العيّنة اللازم لتمييز أثر بهذا الحجم بقوة 80٪ */
    let requiredTrades = null;
    if (testLift != null && testLift > 0 && tSub.length) {
      const p1 = rate(tSub), d = Math.abs(testLift) / 100;
      if (d > 0) requiredTrades = Math.ceil(2 * Math.pow(1.959963985 + 0.8416, 2) * p1 * (1 - p1) / (d * d));
    }

    return {
      ok: true,
      trainSymbols: trainSet.length, testSymbols: testSet.length,
      trialsRun: trials.length, gridSize: cfg.grid.length,
      chosen: {
        gate: chosen.gate, label: chosen.label,
        trainWinRatePct: chosen.winRatePct, trainLiftPts: chosen.liftPts,
        trainCoveragePct: chosen.coveragePct, trainConsistencyPct: chosen.consistencyPct
      },
      test: {
        baselinePct: r2(testBase * 100),
        winRatePct: tSub.length ? r2(rate(tSub) * 100) : null,
        winRateCI: tCI ? [tCI.lo, tCI.hi] : null,
        liftPts: testLift, trades: tSub.length,
        coveragePct: tAll.length ? r2(tSub.length / tAll.length * 100) : null,
        consistencyPct: tested ? r2(better / tested * 100) : null, symbolsTested: tested
      },
      shrinkPts: shrink, held,
      outcome: held ? 'confirmed' : (shrankAway ? 'shrank' : 'underpowered'),
      fallbackChoice,
      requiredTradesPerGroup: requiredTrades,
      topTrials: trials.slice(0, 8),
      verdict: held
        ? `الإعداد المختار صمد خارج العيّنة: رفع ${testLift} نقطة على ${testSet.length} سهماً لم تدخل الاختيار (${tSub.length} صفقة)، وفاصله ${tCI.lo}–${tCI.hi}٪ فوق خط أساسها ${r2(testBase * 100)}٪. الرقم الذي يُعتدّ به هو رقم الاختبار وحده.`
        : shrankAway
          ? `**انكماش**: الإعداد الذي بدا الأفضل على نصف التدريب (رفع ${chosen.liftPts} نقطة) لم يصمد على نصف الاختبار (${testLift == null ? 'لم يُنتج صفقات كافية' : 'رفع ' + testLift + ' نقطة'}). أي أن تفوّقه كان اختياراً على الضجيج لا أفضلية حقيقية. وهذه هي الفائدة الكاملة من فصل التدريب عن الاختبار: بدونه كنت ستقرأ «رفع ${chosen.liftPts} نقطة» وتبني عليه قراراً.`
          : `**ضعف قوة إحصائية — لا انكماش**: الرفع صمد اتجاهاً (تدريب ${chosen.liftPts} نقطة، واختبار ${testLift} نقطة على أسهم لم تدخل الاختيار)، لكنه أصغر من أن يُميَّز عن الصفر بهذه العيّنة: فاصله ${tCI.lo}–${tCI.hi}٪ يشمل خط الأساس ${r2(testBase * 100)}٪ لأن عرضه ${r2(tCI.hi - tCI.lo)} نقطة والأثر ${testLift} نقطة فقط.`
            + (requiredTrades ? ` ولتمييز أثر بهذا الحجم بقوة 80٪ يلزم نحو ${requiredTrades.toLocaleString('en-US')} صفقة في كل مجموعة، والمتاح ${tSub.length} — أي أقلّ بنحو ${Math.round(requiredTrades / Math.max(1, tSub.length))} أضعاف.` : '')
            + ` **والعلاج هنا عيّنة أكبر لا إعداد أفضل** — وهي نصيحة معاكسة تماماً لحالة الانكماش، ولهذا فُصلت الحالتان.`,
      method: 'الأسهم تُقسَّم نصفين بدالة تجزئة حتمية (لا الأزمنة — التقسيم الزمني يخلط أثر الإعداد بأثر نظام السوق). تُجرَّب كل الإعدادات على نصف التدريب ويُختار واحد بأعلى رفع بشرط اتساق فوق 50٪، ثم يُقاس ذلك الواحد وحده على نصف الاختبار. تقييم إعداد واحد على الاختبار يعني ألّا تضخّم اختبارات متعددة رقمَه.',
      caveat: 'نصف اختبار واحد وفترة واحدة. والانكماش بين التدريب والاختبار يقيس مقدار الاختيار على الضجيج، وهو موجود دائماً — والسؤال حجمه لا وجوده.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     4) الواجهة المصدَّرة
     ════════════════════════════════════════════════════════════════════ */
  return {
    VERSION, version: VERSION,
    marketBreadth, relativeStrength,
    poolEvaluate, watchlist, calibrate, CALIB_GRID,
    STATE_RANK
  };
});
