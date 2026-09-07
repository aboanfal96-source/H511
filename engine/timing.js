/* ══════════════════════════════════════════════════════════════════════════
   KSATiming — طبقة تصفية النوافذ الزمنية
   ──────────────────────────────────────────────────────────────────────────
   تُحمَّل بعد engine/core.js وتعتمد عليه. وظيفتها واحدة: أن تُحوِّل «نافذة
   زمنية» من تاريخ مرشَّح إلى إشارة مشروطة بأربعة شروط مستقلة، ثم تقيس أثر
   كل شرط بدل ادّعائه.

   ⚠️ اقرأ هذا قبل استعمال المخرجات:

   هذه الطبقة **تُقلّل عدد الإشارات وترفع دقّتها** — وهما وجهان لمقايضة
   واحدة لا مكسب مجاني. مرشّح يرفع نسبة الإصابة من 45٪ إلى 60٪ سيُسقط معها
   ثلثَي الإشارات. هذا مطلوب ومقصود، لكنه يعني أن «دقّة أعلى» و«إشارات على
   كل الأسهم» هدفان متعارضان بنيوياً، ولا تُصدّق أداة تَعِد بهما معاً.

   ولا يوجد في هذا الملف رقم دقّة مكتوب مسبقاً. الأرقام كلها تخرج من
   `evaluateGates()` على بياناتك أنت، بحجم عيّنة وفاصل ثقة — وهي وحدها
   التي تقول إن كان المرشّح يعمل على سهم بعينه أم لا.

   حدود معلومة، تُذكر لأن إخفاءها يحوّل التقدير إلى ادّعاء:
   • لا يوجد دفتر أوامر ولا بيانات تِك. «تدفّق السيولة» هنا تقدير مشتقّ من
     OHLCV، لا تدفّق أوامر حقيقي. الفرق جوهري ومذكور في كل مخرَج.
   • كتل الأوامر وفجوات القيمة العادلة تعريفات هندسية على الشموع، لا رصد
     فعلي لأوامر مؤسسية. تعمل لأنها تصف مناطق يتكرّر التفاعل عندها، لا
     لأنها «ترى» المؤسسات.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : (root && root.KSAEngine);
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KSATiming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  if (!E) throw new Error('KSATiming يتطلب تحميل engine/core.js أولاً');

  const VERSION = '1.0.0';
  const S = E.Stats;
  const isNum = v => typeof v === 'number' && isFinite(v);
  const r2 = v => (isNum(v) ? +v.toFixed(2) : null);
  const r3 = v => (isNum(v) ? +v.toFixed(3) : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ════════════════════════════════════════════════════════════════════
     1) إعادة التجميع الزمني (Resampling)
     ──────────────────────────────────────────────────────────────────
     تحليل الفواصل المتعددة يحتاج فاصلاً أعلى. بناؤه من الفاصل الأدنى
     المتاح أدقّ من جلبه من مصدر ثانٍ: المصدران قد يختلفان في تعديلات
     التجزئة والتوزيعات، فتقارن دورةً على سلسلتين ليستا نفس السلسلة.

     التجميع يحترم حدود الأسبوع الفعلية للسوق السعودي (الأحد بداية
     الأسبوع) بدل تقطيع أعمى كل n شمعة — التقطيع الأعمى يزيح حدود
     الشموع مع كل عطلة، فتتغيّر «الشمعة الأسبوعية» بحسب نقطة البداية.
     ════════════════════════════════════════════════════════════════════ */

  /** يجمع مصفوفة شموع إلى شمعة واحدة (OHLCV صحيح: أول فتح، آخر إغلاق). */
  function _mergeBucket(bucket) {
    if (!bucket.length) return null;
    let high = -Infinity, low = Infinity, vol = 0;
    for (const c of bucket) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      vol += (c.volume || 0);
    }
    return {
      time: bucket[0].time,
      open: bucket[0].open,
      high, low,
      close: bucket[bucket.length - 1].close,
      volume: vol,
      /* عدد الشموع الأصلية داخل هذه الشمعة — أسبوع مقطوع بعطلة يحمل 3 لا 5،
         وهي معلومة يحتاجها DTW لتصحيح الزمن غير المنتظم. */
      subBars: bucket.length
    };
  }

  /**
   * إعادة تجميع بعدد شموع ثابت (مثلاً 5 يومية ⇒ أسبوعية تقريبية).
   * تُستعمل حين لا تتوفّر طوابع زمنية موثوقة.
   */
  function resampleByCount(cs, n) {
    if (!Array.isArray(cs) || !cs.length || !(n > 1)) return (cs || []).slice();
    const out = [];
    for (let i = 0; i < cs.length; i += n) out.push(_mergeBucket(cs.slice(i, i + n)));
    return out.filter(Boolean);
  }

  /**
   * إعادة تجميع أسبوعية بحدود التقويم الفعلية (أسبوع السوق يبدأ الأحد).
   * شمعة الأسبوع المقطوع بعطلة تبقى شمعة واحدة، لكنها تحمل subBars=3
   * فيعرف المحلّل أن هذا الأسبوع ليس كامل الوزن.
   */
  function resampleWeekly(cs) {
    if (!Array.isArray(cs) || !cs.length) return [];
    const out = [];
    let bucket = [], key = null;
    for (const c of cs) {
      const d = new Date(c.time * 1000);
      /* مفتاح الأسبوع: التاريخ مطروحاً منه رقم اليوم (0=الأحد) */
      const wk = Math.floor((c.time - d.getUTCDay() * 86400) / 604800);
      if (key === null) key = wk;
      if (wk !== key) { const m = _mergeBucket(bucket); if (m) out.push(m); bucket = []; key = wk; }
      bucket.push(c);
    }
    const last = _mergeBucket(bucket); if (last) out.push(last);
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════
     2) البنية الهيكلية — FVG و Order Blocks
     ──────────────────────────────────────────────────────────────────
     فجوة القيمة العادلة (FVG): ثلاث شموع لا يتداخل فيها مدى الأولى مع مدى
     الثالثة، فتبقى منطقة سعرية عبرها السعر بلا تداول متوازن. تُعتبر
     «مُستهلَكة» حين يعود السعر ويغطّيها.

     كتلة الأوامر (Order Block): آخر شمعة معاكسة الاتجاه قبل حركة اندفاعية
     تكسر البنية. المنطق: الحركة الاندفاعية بدأت من مكان تجمّعت فيه أوامر،
     فالعودة إليه تلقى ردّ فعل.

     ⚠️ كلاهما تعريف هندسي على الشموع. لا يرى أياً منهما أوامر حقيقية، ولا
     يدّعي ذلك. قيمتهما أنهما يصفان مناطق يتكرّر التفاعل السعري عندها —
     وهذا قابل للقياس، وهو ما يقيسه evaluateGates.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * @param {Array} cs شموع OHLCV
   * @param {{minSizeATR?:number, lookback?:number, atrPeriod?:number}} [opt]
   *        minSizeATR: أصغر فجوة تُعتدّ بها، كنسبة من ATR. الفجوات الأصغر من
   *        ثُمن ATR ضجيج تقريب لا بنية، وإدراجها يجعل كل شمعة «عند فجوة».
   */
  function findFVG(cs, opt) {
    opt = opt || {};
    const minSizeATR = opt.minSizeATR == null ? 0.25 : opt.minSizeATR;
    const atrP = opt.atrPeriod || 14;
    if (!cs || cs.length < atrP + 4) return [];
    const atrA = E.atrSeries(cs, atrP);
    const out = [];
    const start = Math.max(2, opt.lookback ? cs.length - opt.lookback : 2);

    for (let i = start; i < cs.length; i++) {
      const a = cs[i - 2], c = cs[i];
      const atr = atrA[i];
      if (!isNum(atr) || atr <= 0) continue;

      /* فجوة صاعدة: قاع الشمعة الثالثة فوق قمة الأولى */
      if (c.low > a.high) {
        const size = c.low - a.high;
        if (size >= minSizeATR * atr) out.push({ i, type: 'bullish', top: r2(c.low), bot: r2(a.high), size: r2(size), sizeATR: r3(size / atr), createdAt: cs[i].time });
      }
      /* فجوة هابطة: قمة الشمعة الثالثة تحت قاع الأولى */
      if (c.high < a.low) {
        const size = a.low - c.high;
        if (size >= minSizeATR * atr) out.push({ i, type: 'bearish', top: r2(a.low), bot: r2(c.high), size: r2(size), sizeATR: r3(size / atr), createdAt: cs[i].time });
      }
    }

    /* حالة الاستهلاك: كم غُطّي من الفجوة بعد تكوّنها. 100٪ = مُستهلَكة كلياً.
       الحساب من الشمعة التالية للتكوّن فقط — منع تسرّب زمني صريح. */
    for (const g of out) {
      let deepest = 0;
      for (let j = g.i + 1; j < cs.length; j++) {
        const c = cs[j];
        const pen = g.type === 'bullish'
          ? (g.top - Math.min(c.low, g.top))   /* الاختراق من الأعلى نزولاً */
          : (Math.max(c.high, g.bot) - g.bot);
        if (pen > deepest) deepest = pen;
      }
      const span = Math.max(1e-9, g.top - g.bot);
      g.filledPct = r2(clamp(deepest / span * 100, 0, 100));
      g.mitigated = g.filledPct >= 100;
      g.mid = r2((g.top + g.bot) / 2);          /* نقطة الانغماس 50٪ */
      g.barsSince = cs.length - 1 - g.i;
    }
    return out;
  }

  /**
   * كتل الأوامر: آخر شمعة معاكسة قبل اندفاعة تتجاوز impulseATR من ATR
   * خلال impulseBars شمعة.
   */
  function findOrderBlocks(cs, opt) {
    opt = opt || {};
    const impulseATR = opt.impulseATR == null ? 1.8 : opt.impulseATR;
    const impulseBars = opt.impulseBars || 3;
    const atrP = opt.atrPeriod || 14;
    if (!cs || cs.length < atrP + impulseBars + 2) return [];
    const atrA = E.atrSeries(cs, atrP);
    const out = [];

    for (let i = atrP + 1; i < cs.length - impulseBars; i++) {
      const atr = atrA[i];
      if (!isNum(atr) || atr <= 0) continue;
      const base = cs[i];
      const isDown = base.close < base.open;   /* شمعة هابطة قبل اندفاعة صاعدة */
      const isUp = base.close > base.open;

      /* الاندفاعة تُقاس من إغلاق شمعة الأساس */
      let maxUp = 0, maxDn = 0;
      for (let j = i + 1; j <= i + impulseBars; j++) {
        maxUp = Math.max(maxUp, cs[j].high - base.close);
        maxDn = Math.max(maxDn, base.close - cs[j].low);
      }

      if (isDown && maxUp >= impulseATR * atr)
        out.push({ i, type: 'bullish', top: r2(Math.max(base.open, base.close)), bot: r2(base.low), impulseATR: r3(maxUp / atr), createdAt: base.time });
      else if (isUp && maxDn >= impulseATR * atr)
        out.push({ i, type: 'bearish', top: r2(base.high), bot: r2(Math.min(base.open, base.close)), impulseATR: r3(maxDn / atr), createdAt: base.time });
    }

    /* كتلة «مُستهلَكة» = أُغلق السعر خلفها بالكامل، فلم تعد منطقة دفاع */
    for (const b of out) {
      let touched = false, broken = false;
      for (let j = b.i + 1; j < cs.length; j++) {
        const c = cs[j];
        if (c.low <= b.top && c.high >= b.bot) touched = true;
        if (b.type === 'bullish' && c.close < b.bot) { broken = true; break; }
        if (b.type === 'bearish' && c.close > b.top) { broken = true; break; }
      }
      b.touched = touched; b.mitigated = broken;
      b.mid = r2((b.top + b.bot) / 2);
      b.barsSince = cs.length - 1 - b.i;
    }
    return out;
  }

  /**
   * ① بوابة السيولة: هل السعر الآن داخل منطقة بنيوية حيّة في اتجاه الصفقة؟
   *
   * الشرط الذي طلبتَه: لا تُفعَّل إشارة المراقبة الزمنية إلا إذا تزامنت مع
   * وصول السعر إلى FVG أو Order Block لم يُستهلَك بعد.
   *
   * `tolATR` يسمح بهامش قرب: السعر عند حافة المنطقة بمقدار عُشر ATR يُعدّ
   * واصلاً إليها. بلا هامش تصبح البوابة شرطاً على المطابقة التامة فتُسقط
   * كل شيء تقريباً — وبوابة لا تمرّ أبداً ليست بوابة.
   */
  function liquidityGate(cs, opt) {
    opt = opt || {};
    const dirUp = opt.dirUp !== false;
    const tolATR = opt.tolATR == null ? 0.15 : opt.tolATR;
    const idx = opt.idx == null ? cs.length - 1 : opt.idx;
    const maxAge = opt.maxAgeBars == null ? 120 : opt.maxAgeBars;

    const view = cs.slice(0, idx + 1);          /* لا نظر للأمام إطلاقاً */
    if (view.length < 30) return { pass: false, reason: 'شموع غير كافية لقياس البنية', zones: [] };

    const atr = E.atr(view, 14);
    if (!isNum(atr) || atr <= 0) return { pass: false, reason: 'تعذّر حساب ATR', zones: [] };
    const price = view[view.length - 1].close;
    const tol = tolATR * atr;

    const want = dirUp ? 'bullish' : 'bearish';
    const zones = [];
    for (const g of findFVG(view, opt)) {
      if (g.type !== want || g.mitigated || g.barsSince > maxAge) continue;
      zones.push({ kind: 'FVG', type: g.type, top: g.top, bot: g.bot, mid: g.mid, filledPct: g.filledPct, barsSince: g.barsSince, sizeATR: g.sizeATR });
    }
    for (const b of findOrderBlocks(view, opt)) {
      if (b.type !== want || b.mitigated || b.barsSince > maxAge) continue;
      zones.push({ kind: 'OB', type: b.type, top: b.top, bot: b.bot, mid: b.mid, impulseATR: b.impulseATR, barsSince: b.barsSince });
    }

    const inside = zones.filter(z => price >= z.bot - tol && price <= z.top + tol)
      .sort((a, b) => Math.abs(price - a.mid) - Math.abs(price - b.mid));

    if (!inside.length) {
      const nearest = zones
        .map(z => ({ z, d: Math.min(Math.abs(price - z.top), Math.abs(price - z.bot)) }))
        .sort((a, b) => a.d - b.d)[0];
      return {
        pass: false, zones, price: r2(price),
        reason: nearest
          ? `السعر ${r2(price)} خارج كل المناطق البنيوية الحيّة — أقربها ${nearest.z.kind} عند ${nearest.z.bot}–${nearest.z.top} على بعد ${r3(nearest.d / atr)}×ATR`
          : `لا توجد فجوة قيمة عادلة ولا كتلة أوامر ${dirUp ? 'صاعدة' : 'هابطة'} غير مُستهلَكة خلال آخر ${maxAge} جلسة`
      };
    }

    const z = inside[0];
    return {
      pass: true, zone: z, zones, price: r2(price),
      /* كلما كانت المنطقة أطزج وأقلّ استهلاكاً كان التفاعل عندها أرجح */
      quality: r3(clamp((1 - (z.filledPct || 0) / 100) * 0.6 + clamp(1 - z.barsSince / maxAge, 0, 1) * 0.4, 0, 1)),
      reason: `السعر ${r2(price)} داخل ${z.kind} ${dirUp ? 'صاعدة' : 'هابطة'} عند ${z.bot}–${z.top} (عمرها ${z.barsSince} جلسة${z.filledPct != null ? `، مُغطّاة ${z.filledPct}٪` : ''})`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     3) التشوّه الزمني الديناميكي (DTW)
     ──────────────────────────────────────────────────────────────────
     المشكلة التي يحلّها: قياس الدورة في المحرك خطّي — يفترض أن كل جلسة
     تساوي كل جلسة. الواقع غير ذلك: أسبوع فيه عطلة رسمية يمرّ فيه وقت
     تقويمي أطول بجلسات أقل، وفترات السيولة المنخفضة (الصيف، رمضان) تمطّ
     الحركة نفسها على جلسات أكثر. النتيجة أن دورة 34 جلسة تصبح 30 مرة و38
     مرة، فيُحسب ذلك «عدم انتظام» ويُرفض، بينما هي الدورة نفسها بزمن ممطوط.

     DTW يقيس التشابه بين سلسلتين مع السماح بتمطيط محلي في محور الزمن،
     فيعطي مسافة تشابه لا تنهار بسبب إزاحة بضع جلسات. النطاق (Sakoe-Chiba)
     يمنع التمطيط غير المحدود: بلا نطاق يمكن لأي سلسلة أن تُطابق أي سلسلة
     بتمطيط كافٍ، وتصبح المسافة بلا معنى.

     ⚠️ DTW أداة قياس تشابه، لا إثبات وجود دورة. الدلالة الإحصائية تبقى من
     اختبار فيشر في core.js؛ DTW يحسّن *قياس الطور* لدورة أثبتت دلالتها.

     ⚠️ وما لا يفعله DTW هنا، ولا يصحّ ادّعاؤه: **لا يُخرج معامل تمطيط
     عام يصحّح طول الدورة.** السبب بنيوي لا تنفيذي: هذه الصيغة تثبّت
     طرفَي المسار عند (0,0) و(n,m)، فمتوسط ميل المسار مقيّد بـ1 مهما كان
     التمطيط الحقيقي — أي أن «معامل التمطيط العام» غير قابل للتحديد من
     هذه الصيغة أصلاً. نسخة أولى من هذا الملف كانت تحسبه وتعرض «الدورة
     الفعلية ≈ 29 جلسة بدل 24»، وذلك رقم غير مُعرَّف رياضياً وإن بدا
     معقولاً. المُخرَج الصادق: جودة المطابقة، وإزاحة الطور، ومقدار
     الالتواء المحلي اللازم — وهذا الأخير هو أثر العطل والسيولة فعلاً.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * DTW بنطاق Sakoe-Chiba.
   * @param {number[]} a سلسلة مرجعية (قالب الدورة)
   * @param {number[]} b سلسلة مرصودة
   * @param {{band?:number}} [opt] عرض النطاق كنسبة من الطول (0.15 = ±15٪)
   * @returns {{distance, normalized, path, pathSlope, irregularity, ok}}
   *          normalized: متوسط الفارق لكل خطوة — مقياس التشابه القابل للمقارنة.
   *          pathSlope:  ميل مسار الالتواء (تشخيصي؛ مقيّد بـ1 لتثبيت الطرفين).
   *          irregularity: طول المسار مقابل القطر − 1. صفر = محاذاة قطرية
   *                      تامة، وكلما كبر لزم التواء محلي أكثر لمطابقة
   *                      الشكلين. هذا هو أثر العطل والسيولة القابل للقياس.
   */
  function dtw(a, b, opt) {
    opt = opt || {};
    const n = a.length, m = b.length;
    if (!n || !m) return { distance: Infinity, normalized: Infinity, path: [], warp: 1, ok: false };
    const band = Math.max(2, Math.round((opt.band == null ? 0.15 : opt.band) * Math.max(n, m)));

    const INF = Infinity;
    /* مصفوفة التكلفة — صفّان فقط لا يكفيان لأننا نحتاج المسار، لكن حجم
       السلاسل هنا عشرات لا آلاف، فالمصفوفة الكاملة مقبولة وأوضح. */
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
    D[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      const lo = Math.max(1, i - band), hi = Math.min(m, i + band);
      for (let j = lo; j <= hi; j++) {
        const cost = Math.abs(a[i - 1] - b[j - 1]);
        const best = Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
        D[i][j] = cost + best;
      }
    }
    const distance = D[n][m];
    if (!isFinite(distance)) return { distance: INF, normalized: INF, path: [], warp: 1, ok: false };

    /* تتبّع المسار عكسياً لاستخراج معامل التمطيط */
    const path = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      path.push([i - 1, j - 1]);
      const c = [D[i - 1][j - 1], D[i - 1][j], D[i][j - 1]];
      const k = c.indexOf(Math.min.apply(null, c));
      if (k === 0) { i--; j--; } else if (k === 1) i--; else j--;
    }
    path.reverse();

    /* ══ معامل التمطيط ══════════════════════════════════════════════════
       🛠️ الصيغة الأولى كانت `path.length / min(n,m)`، وهي **مكسورة**:
       أي ضجيج يدفع المسار لخطوات غير قطرية فيطول، فيخرج التمطيط > 1 حتى
       على زمن منتظم تماماً. القياس: سلسلة بدورة مزروعة على زمن منتظم
       أعطت تمطيط 1.22 — أي أن الدالة كانت تُعلن «الزمن غير خطّي» لكل
       سلسلة فيها ضجيج، وهو كل سلسلة حقيقية.

       الصحيح: التمطيط هو **ميل** مسار الالتواء (كم وحدة في b مقابل وحدة
       في a)، لا طول المسار. ميل 1 = زمن خطّي مهما كان الضجيج؛ ميل 1.3 =
       تمطيط حقيقي. ويُقاس بانحدار j على i عبر نقاط المسار.
       ويبقى `pathRatio` مُخرَجاً منفصلاً كمؤشّر على تعرّج المسار (الضجيج). */
    let sx = 0, sy = 0, sxy = 0, sxx = 0; const L = path.length;
    for (const [i2, j2] of path) { sx += i2; sy += j2; sxy += i2 * j2; sxx += i2 * i2; }
    const den = L * sxx - sx * sx;
    const slope = Math.abs(den) < 1e-9 ? 1 : (L * sxy - sx * sy) / den;

    return {
      ok: true,
      distance: r3(distance),
      normalized: r3(distance / path.length),   /* قابل للمقارنة بين أطوال مختلفة */
      path,
      pathSlope: r3(slope > 0 ? slope : 1),
      irregularity: r3(Math.max(0, L / Math.max(1, Math.min(n, m)) - 1))
    };
  }

  /**
   * ③ قياس الطور مع تحمّل الالتواء الزمني.
   *
   * يبني قالباً جيبياً بطول الدورة المُثبتة، ويطابقه على السعر منزوع
   * الاتجاه عبر DTW، فيستخرج ثلاثة أرقام كلها قابلة للتحديد:
   *   • `phaseShiftBars` — إزاحة الطور بالجلسات (الإزاحة التي تعطي أفضل
   *     مطابقة). أمتن من الطور الخطّي حين يكون التاريخ مثقوباً بعطل.
   *   • `fit` — جودة المطابقة (أصغر = أفضل)، بوحدة انحرافات معيارية.
   *   • `irregularity` — كم التواءً محلياً لزم لمطابقة الشكلين. صفر يعني
   *     أن الدورة تتقدّم بانتظام تام؛ والارتفاع يعني أن الحركة نفسها
   *     امتدّت على جلسات أكثر في فترات وأقلّ في أخرى — وهو أثر العطل
   *     وتذبذب السيولة الذي طُلب قياسه.
   *
   * لا يُرجع «طول دورة مصحَّحاً»: انظر التحذير في رأس القسم — الكمّية
   * غير قابلة للتحديد من DTW مثبّت الطرفين.
   */
  function warpedCyclePhase(cs, opt) {
    opt = opt || {};
    if (!cs || cs.length < 60) return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — قياس الطور يتطلب 60+` };

    const closes = cs.map(c => c.close);
    const spec = opt.spectral || E.spectralPro(closes, { alpha: 0.05 });
    if (!spec.ok) return { ok: false, reason: spec.reason };
    if (!spec.significant) return { ok: false, reason: `الدورة غير دالة (p=${spec.pValueText}) — لا طور يُقاس لدورة غير مُثبتة` };

    const P = spec.period;
    const win = Math.min(closes.length, Math.round(P * 3));
    if (win < 20) return { ok: false, reason: 'نافذة القياس أقصر من أن تحمل ثلاث دورات' };

    /* السعر منزوع الاتجاه ومُعاير — DTW يقارن أشكالاً لا مستويات */
    const seg = closes.slice(closes.length - win).map(v => Math.log(v));
    const reg = S.linreg(seg);
    const det = seg.map((v, i) => v - (reg.slope * i + reg.intercept));
    const sd = S.sd(det) || 1;
    const obs = det.map(v => v / sd);

    /* نجرّب إزاحات طور ونأخذ أقلّها مسافة — الإزاحة الفائزة هي الطور */
    let best = null;
    const steps = Math.max(8, Math.round(P));
    for (let k = 0; k < steps; k++) {
      const phi = (2 * Math.PI * k) / steps;
      const tmpl = obs.map((_, i) => Math.cos(2 * Math.PI * i / P + phi));
      const d = dtw(tmpl, obs, { band: opt.band == null ? 0.15 : opt.band });
      if (!d.ok) continue;
      if (!best || d.normalized < best.d.normalized) best = { k, phi, d };
    }
    if (!best) return { ok: false, reason: 'تعذّرت مطابقة القالب' };

    /* مرجع المقارنة: أفضل مطابقة **خطّية** (بلا التواء) لنفس القالب.
       بدونه لا معنى لقول «المطابقة جيدة»: جيدة مقابل ماذا؟ */
    let bestLinear = Infinity;
    for (let k = 0; k < steps; k++) {
      const phi = (2 * Math.PI * k) / steps;
      let e = 0;
      for (let i = 0; i < obs.length; i++) e += Math.abs(Math.cos(2 * Math.PI * i / P + phi) - obs[i]);
      bestLinear = Math.min(bestLinear, e / obs.length);
    }

    const irregular = best.d.irregularity;
    const phaseShiftBars = r2((best.phi / (2 * Math.PI)) * P);

    return {
      ok: true,
      period: P,
      phaseShiftBars,
      fit: best.d.normalized,          /* أصغر = مطابقة أفضل */
      linearFit: r3(bestLinear),       /* المطابقة بلا التواء — للمقارنة */
      gain: r3(bestLinear - best.d.normalized),  /* ما أضافه السماح بالالتواء */
      irregularity: irregular,
      /* المطابقة مقبولة حين يقلّ متوسط الفارق عن انحراف معياري واحد */
      good: best.d.normalized < 1.0,
      note: irregular <= 0.15
        ? `الدورة تتقدّم بانتظام (التواء ${irregular}) — تقويم التداول منتظم في هذه الفترة، فالقياس الخطّي كافٍ ولا يضيف التصحيح شيئاً.`
        : `الدورة لا تتقدّم بانتظام (التواء ${irregular}): لزم مدّ الزمن محلياً لمطابقة الشكل، أي أن نفس الحركة استغرقت جلسات أكثر في فترات وأقلّ في أخرى — أثر العطل أو تذبذب السيولة. النافذة الزمنية هنا أوسع مما يوحي به الرقم الخطّي، فتعامل معها كمدى لا كتاريخ.`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     4) تزامن الفراكتلز عبر الفواصل (Multi-Timeframe Alignment)
     ──────────────────────────────────────────────────────────────────
     الفكرة: دورة على فاصل واحد قد تكون صدفة إحصائية. الدورة نفسها ظاهرةً
     على فاصلين مستقلين أقلّ احتمالاً بكثير أن تكون صدفة.

     ⚠️ نقطة منهجية تُغفل كثيراً: الفاصل الأعلى **مشتقّ** من الأدنى، فليسا
     مستقلّين إحصائياً. لا يصحّ ضرب قيمتَي الاحتمال ببعضهما ولا معاملتهما
     كاختبارين منفصلين — هذا يضخّم الدلالة بلا وجه حق. ما نقيسه هنا هو
     **الاتساق** لا دلالة مضاعفة: هل الدورة الأسبوعية تساوي الدورة اليومية
     مقسومة على 5 ضمن هامش؟ إن كانت كذلك فالبنية متماسكة عبر المقاييس؛
     وإن اختلفتا فإحداهما أثر تجميع لا دورة.

     التطابق يُقاس بنسبة الدورتين بعد التطبيع لعدد الجلسات، لا بالمساواة
     العددية — دورة 34 جلسة يومية تقابل 6.8 شمعة أسبوعية لا 34.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * @param {Array} daily شموع الفاصل الأساسي
   * @param {{factor?:number, tolPct?:number, intraday?:Array, intradayFactor?:number, minHigherBars?:number}} [opt]
   *        factor: عدد شموع الفاصل الأساسي في شمعة الفاصل الأعلى. يُختار
   *        تلقائياً إن غاب (انظر أدناه).
   *        intraday: شموع فاصل أدنى (ساعة مثلاً) — الفاصل الأدنى وحده
   *        يجب أن يأتي من المصدر لأنه لا يُشتقّ بالتجميع.
   */
  function mtfAlignment(daily, opt) {
    opt = opt || {};
    const tolPct = opt.tolPct == null ? 25 : opt.tolPct;
    const minHigherBars = opt.minHigherBars == null ? 70 : opt.minHigherBars;
    const out = { ok: false, frames: [], agree: false, note: '' };

    if (!daily || daily.length < 80) { out.reason = `عيّنة ${daily ? daily.length : 0} جلسة — التحليل متعدّد الفواصل يتطلب 80+`; return out; }

    const measure = (cs, label, barsPerUnit, minPeriod) => {
      if (!cs || cs.length < 40) return { label, ok: false, reason: `${cs ? cs.length : 0} شمعة — أقلّ من 40` };
      const sp = E.spectralPro(cs.map(c => c.close), { alpha: 0.05, minPeriod: minPeriod });
      if (!sp.ok) return { label, ok: false, reason: sp.reason, bars: cs.length };
      return {
        label, ok: true, significant: sp.significant, period: sp.period,
        /* الدورة معبَّراً عنها بجلسات الفاصل الأساسي — وحدة مشتركة للمقارنة */
        periodInBaseBars: r2(sp.period * barsPerUnit),
        pValue: sp.pValue, pValueText: sp.pValueText,
        snr: sp.snr, cyclePosPct: sp.cyclePosPct, bars: cs.length
      };
    };

    const base = measure(daily, 'يومي', 1);
    out.frames = [base];

    /* ══ اختيار معامل التجميع ══════════════════════════════════════════
       🛠️ نسخة أولى كانت تجمّع أسبوعياً دائماً (×5). النتيجة أن البوابة
       كانت **ميتة بنيوياً**: دورة 24 جلسة تساوي 4.8 شمعة أسبوعية، وهي
       تحت أقصر دورة قابلة للمسح، فتُرفض دائماً. القياس: 0 من 20 حالة
       بدورة مزروعة قوية اجتازت البوابة — أي أنها كانت تُنقص النتيجة
       لكل سهم بلا استثناء وتعرض «لا تأكيد عبر المقاييس» كأنها نتيجة
       سوقية، وهي في الحقيقة قيد على المعامل.

       الصحيح: يُختار المعامل ليجعل الدورة تشغل ~8 شمعات في الفاصل
       الأعلى — فوق حدّ نايكويست بمسافة مريحة وداخل نطاق المسح. */
    const P = (base.ok && base.significant) ? base.period : null;
    const factor = opt.factor || (P ? clamp(Math.round(P / 8), 2, 10) : 5);

    const higher = opt.higher || (factor === 5 && !opt.factor && !P ? resampleWeekly(daily) : resampleByCount(daily, factor));
    const avgSub = S.mean(higher.map(c => c.subBars || factor)) || factor;

    if (higher.length < minHigherBars) {
      out.ok = true; out.agree = false;
      out.frames.push({ label: `أعلى (×${factor})`, ok: false, bars: higher.length, reason: `${higher.length} شمعة — مطلوب ${minHigherBars}` });
      out.dataLimited = true;
      out.note = `العيّنة لا تكفي لفاصل ثانٍ: تجميع ×${factor} على ${daily.length} جلسة يعطي ${higher.length} شمعة فقط، والمطلوب ${minHigherBars}. `
        + `هذا **قيد على طول البيانات لا نتيجة عن السهم** — وسّع النطاق الزمني إلى سنتين ليصبح التأكيد عبر الفواصل ممكناً أصلاً.`;
      return out;
    }

    out.frames.push(measure(higher, `أعلى (×${factor} ≈ ${r2(avgSub)} جلسة/شمعة)`, avgSub, 4));
    if (opt.intraday) out.frames.push(measure(opt.intraday, 'داخل اليوم', opt.intradayFactor == null ? (1 / 7) : opt.intradayFactor, 4));

    const frames = out.frames;
    const sig = frames.filter(f => f.ok && f.significant);
    out.ok = true; out.factor = factor;
    out.significantFrames = sig.length;
    out.totalFrames = frames.filter(f => f.ok).length;

    if (sig.length < 2) {
      out.agree = false;
      out.note = sig.length === 1
        ? `دورة دالة على فاصل واحد فقط (${sig[0].label}: ${sig[0].period}) — لا تأكيد عبر المقاييس. دورة على فاصل واحد أضعف إسناداً، وقد تكون أثر تجميع.`
        : 'لا دورة دالة على أي فاصل — لا شيء يُطابَق.';
      return out;
    }

    /* الاتساق: تشتّت الدورات بعد تحويلها لوحدة مشتركة */
    const vals = sig.map(f => f.periodInBaseBars);
    const med = S.median(vals);
    const spread = med > 0 ? Math.max.apply(null, vals.map(v => Math.abs(v - med))) / med * 100 : 999;
    out.medianPeriodBars = r2(med);
    out.spreadPct = r2(spread);
    out.agree = spread <= tolPct;
    out.note = out.agree
      ? `الدورة متّسقة عبر ${sig.length} فواصل: ${sig.map(f => `${f.label} ${f.period}`).join(' · ')} ⇒ كلها ≈ ${r2(med)} جلسة أساسية (تشتّت ${r2(spread)}٪). البنية نفسها ظاهرة على أكثر من مقياس.`
      : `الدورات لا تتّسق عبر الفواصل (تشتّت ${r2(spread)}٪ > ${tolPct}٪): ${sig.map(f => `${f.label} ⇒ ${f.periodInBaseBars} جلسة`).join(' · ')}. اختلاف بهذا الحجم يعني أن إحداها أثر تجميع لا دورة مشتركة.`;
    out.caveat = 'الفاصل الأعلى مُشتقّ من الأدنى بالتجميع، فليسا مستقلّين إحصائياً. هذا مقياس اتساق بنيوي، لا دلالة مضاعفة — ولا تُضرب قيمتا الاحتمال ببعضهما.';
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════
     5) مرشّح تدفّق الأحجام
     ──────────────────────────────────────────────────────────────────
     ⚠️ تصريح لازم قبل أي رقم هنا: المنصة لا تملك دفتر أوامر ولا بيانات
     تِك، فلا يمكنها قياس تدفّق الأوامر الحقيقي (Order Flow). كل ما تحت
     هو **تقدير مشتقّ من OHLCV**، وأسميناه تدفّقاً تقديرياً لا تدفّقاً.

     ثلاثة مقاييس مستقلة، كلٌّ يجيب عن سؤال مختلف:
     ① موقع الإغلاق داخل المدى (CLV) موزوناً بالحجم — «هل الحجم جاء مع قوة
       إغلاق أم ضدّها؟». حجم ضخم بإغلاق عند القاع توزيع لا تجميع.
     ② نسبة المشاركة مقابل وسيط السهم نفسه — لا مقابل متوسطه: جلسة واحدة
       استثنائية تضخّم المتوسط فيصبح المقياس مشوّهاً بما يفترض أن يقيسه.
     ③ اتجاه التراكم على النافذة — ميل مُطبَّع لخط التجميع/التوزيع.

     البوابة تُمرّر حين يكون التدفّق **في اتجاه الصفقة** وبمشاركة كافية.
     ════════════════════════════════════════════════════════════════════ */

  function volumeFlow(cs, opt) {
    opt = opt || {};
    const idx = opt.idx == null ? cs.length - 1 : opt.idx;
    const win = opt.window || 5;
    const baseWin = opt.baselineWindow || 50;
    const dirUp = opt.dirUp !== false;
    const minParticipation = opt.minParticipation == null ? 0.8 : opt.minParticipation;

    const view = cs.slice(0, idx + 1);
    if (view.length < baseWin + win) return { pass: false, reason: `شموع غير كافية لقياس التدفّق (${view.length}، مطلوب ${baseWin + win})` };

    const recent = view.slice(-win);
    const vols = view.map(c => c.volume || 0);
    const medBase = S.median(vols.slice(-baseWin));
    const medRecent = S.median(recent.map(c => c.volume || 0));
    const participation = medBase > 0 ? medRecent / medBase : 0;

    /* ① CLV موزوناً بالحجم على النافذة: [-1, +1] */
    let signed = 0, totalVol = 0;
    for (const c of recent) {
      const range = c.high - c.low;
      const clv = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0;
      signed += clv * (c.volume || 0);
      totalVol += (c.volume || 0);
    }
    const flowScore = totalVol > 0 ? signed / totalVol : 0;

    /* ③ ميل خط التجميع/التوزيع مُطبَّعاً — قابل للمقارنة بين الأسهم */
    const ad = E.Cumulative.adLine(view);
    const seg = ad.slice(-Math.min(20, view.length));
    const adReg = S.linreg(seg);
    const scale = Math.max(1e-9, S.median(seg.map(Math.abs)) || S.sd(seg) || 1);
    const adSlope = adReg.slope / scale;

    const withDirection = dirUp ? (flowScore > 0 && adSlope > 0) : (flowScore < 0 && adSlope < 0);
    const enoughParticipation = participation >= minParticipation;
    const pass = withDirection && enoughParticipation;

    return {
      pass,
      flowScore: r3(flowScore),
      adSlopeNorm: r3(adSlope),
      participation: r3(participation),
      medianVolumeRecent: Math.round(medRecent),
      medianVolumeBaseline: Math.round(medBase),
      /* جودة التدفّق: تُستعمل ترجيحاً لا شرطاً */
      quality: r3(clamp((Math.abs(flowScore) * 0.5 + clamp(participation - 0.8, 0, 1.2) / 1.2 * 0.5), 0, 1)),
      reason: pass
        ? `التدفّق التقديري في اتجاه الصفقة: موقع الإغلاق الموزون ${r3(flowScore)} وميل التجميع ${r3(adSlope)}، بمشاركة ${r2(participation * 100)}٪ من وسيط ${baseWin} جلسة.`
        : !enoughParticipation
          ? `المشاركة ${r2(participation * 100)}٪ من وسيط ${baseWin} جلسة — دون العتبة ${r2(minParticipation * 100)}٪. حركة بحجم أقلّ من المعتاد لا يدعمها تدفّق، ويسهل ارتدادها.`
          : `التدفّق التقديري ضدّ اتجاه الصفقة أو محايد (إغلاق موزون ${r3(flowScore)}، ميل تجميع ${r3(adSlope)}) — الحجم لا يؤيّد ${dirUp ? 'الصعود' : 'الهبوط'}.`,
      caveat: 'تقدير مشتقّ من OHLCV — لا دفتر أوامر ولا بيانات تِك، فهو ليس تدفّق أوامر حقيقياً.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     6) سلسلة البوابات — من نافذة مرشَّحة إلى إشارة مشروطة
     ──────────────────────────────────────────────────────────────────
     الترتيب مقصود، والأرخص حسابياً أولاً حتى لا نحسب طيفاً لسهم سيسقط على
     بوابة بيانات. كل بوابة تُرجع سببها سواء مرّت أو لا، فيظهر للمستخدم
     **لماذا** سقطت الإشارة — وهذا أهم من الإشارة نفسها عملياً.

     ملاحظة على الترجيح: `score` هنا **ليس احتمالاً ولا نسبة نجاح**. هو
     مجموع أوزان معلنة لبوابات مرّت، ولا معنى له إلا بالمقارنة مع أرقام
     evaluateGates المقاسة على بياناتك. لا تعرضه للمستخدم كنسبة ثقة.
     ════════════════════════════════════════════════════════════════════ */

  const GATE_WEIGHTS = { cycle: 30, liquidity: 25, mtf: 20, flow: 15, warp: 10 };

  /**
   * @param {Array} cs شموع الفاصل اليومي
   * @param {{idx?:number, dirUp?:boolean, require?:string[], intraday?:Array}} [opt]
   *        require: البوابات الإلزامية. الافتراضي ['cycle','liquidity'] —
   *        الدورة والسيولة شرطان، والباقي ترجيح. غيّرها بعد أن تقيس.
   */
  function timingSignal(cs, opt) {
    opt = opt || {};
    const idx = opt.idx == null ? cs.length - 1 : opt.idx;
    const required = opt.require || ['cycle', 'liquidity'];
    const view = cs.slice(0, idx + 1);          /* لا نظر للأمام */
    const gates = [];
    const add = (name, pass, why, extra) => { gates.push(Object.assign({ name, pass, why, weight: GATE_WEIGHTS[name] || 0 }, extra || {})); return pass; };

    if (view.length < 80)
      return { ok: false, reason: `عيّنة ${view.length} جلسة — سلسلة البوابات تتطلب 80+`, gates, score: 0, fire: false };

    /* ① الدورة الطيفية — الشرط الأول: لا توقيت بلا دورة دالة */
    const spec = E.spectralPro(view.map(c => c.close), { alpha: 0.05 });
    if (!spec.ok) return { ok: false, reason: spec.reason, gates, score: 0, fire: false };

    let turns = [], nextTurn = null, dirUp = opt.dirUp;
    if (spec.significant) {
      turns = E.projectTurnsPro(spec, 30) || [];
      nextTurn = turns.find(t => t.usable) || turns[0] || null;
      if (dirUp == null) dirUp = nextTurn ? nextTurn.type === 'valley' : spec.cyclePosPct >= 48;
    } else if (dirUp == null) dirUp = true;

    const nearWindow = !!(nextTurn && nextTurn.barsAhead <= (opt.windowBars == null ? 3 : opt.windowBars) && nextTurn.usable);
    add('cycle', spec.significant && nearWindow,
      spec.significant
        ? (nearWindow
          ? `دورة ${spec.period} جلسة دالة (p=${spec.pValueText})، و${turnAr(nextTurn.type)} خلال ${nextTurn.barsAhead}±${nextTurn.sdBars} جلسة`
          : `دورة ${spec.period} جلسة دالة لكن لا انعطاف قابل للاستعمال خلال النافذة${nextTurn ? ` (أقربه بعد ${barsAr(nextTurn.barsAhead)}${nextTurn.usable ? '' : ' وعدم يقينه أوسع من ربع دورة'})` : ''}`)
        : `الطيف لا يختلف عن ضجيج عشوائي (p=${spec.pValueText}) — لا نافذة زمنية تُشتقّ منه`,
      { period: spec.period, pValue: spec.pValue, nextTurn });

    /* ② السيولة — FVG / Order Block */
    const liq = liquidityGate(view, { idx: view.length - 1, dirUp, tolATR: opt.tolATR, maxAgeBars: opt.maxAgeBars });
    add('liquidity', liq.pass, liq.reason, { zone: liq.zone || null, quality: liq.quality || 0 });

    /* ③ الاتساق عبر الفواصل */
    const mtf = mtfAlignment(view, { intraday: opt.intraday, tolPct: opt.mtfTolPct });
    add('mtf', !!(mtf.ok && mtf.agree), mtf.note || mtf.reason || '—',
      { spreadPct: mtf.spreadPct == null ? null : mtf.spreadPct, frames: mtf.frames });

    /* ④ تدفّق الأحجام التقديري */
    const flow = volumeFlow(view, { idx: view.length - 1, dirUp, window: opt.flowWindow, minParticipation: opt.minParticipation });
    add('flow', flow.pass, flow.reason, { flowScore: flow.flowScore, participation: flow.participation, quality: flow.quality || 0 });

    /* ⑤ استقامة الزمن (DTW) — ترجيح فقط: زمن غير خطّي لا يُبطل الإشارة، لكنه
       يوسّع نافذتها، فمروره يعني أن التاريخ المستعمل يحتمل قياساً خطّياً. */
    const wp = warpedCyclePhase(view, { spectral: spec });
    add('warp', !!(wp.ok && wp.good && wp.irregularity <= 0.25),
      wp.ok ? wp.note : (wp.reason || '—'),
      { fit: wp.fit == null ? null : wp.fit, irregularity: wp.irregularity == null ? null : wp.irregularity });

    const passed = gates.filter(g => g.pass);
    const score = passed.reduce((s, g) => s + g.weight, 0);
    const missingRequired = required.filter(n => !gates.find(g => g.name === n && g.pass));
    const fire = missingRequired.length === 0;

    return {
      ok: true, fire, dirUp,
      score,                                   /* مجموع أوزان لا احتمال */
      passedCount: passed.length, totalGates: gates.length,
      gates, required, missingRequired,
      spectral: { period: spec.period, pValue: spec.pValue, pValueText: spec.pValueText, significant: spec.significant, cyclePosPct: spec.cyclePosPct, snr: spec.snr },
      nextTurn, mtf, flow, liquidity: liq, warp: wp,
      summary: fire
        ? `إشارة مفعّلة (${passed.length}/${gates.length} بوابات) — ${gates.filter(g => g.pass).map(g => g.name).join(' + ')}`
        : `لا إشارة — لم تمرّ: ${missingRequired.join('، ')}`,
      caveat: 'score مجموع أوزان معلنة لبوابات مرّت، وليس احتمال نجاح. الرقم الوحيد ذو المعنى الاحتمالي يخرج من evaluateGates على بياناتك.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     6.5) «ماذا أفعل الآن؟» — تحويل حالة البوابات إلى جملة تنفيذية واحدة
     ──────────────────────────────────────────────────────────────────
     المستخدم كان مضطراً لقراءة أربعة أقسام (البوابات، النافذة الزمنية،
     السيناريو التنفيذي، غرفة القرار) ليستنتج بنفسه: هل أشتري اليوم أم لا؟
     وأغلب من يقرأ لوحة فيها أرقام خضراء يستنتج «نعم» بلا مبرّر.

     هذه الدالة تفعل شيئاً واحداً: تمرّ على سُلّم قرار صريح وتتوقّف عند أول
     شرط غير متحقّق، فتُخرج فعلاً واحداً وسببه. وقواعد السُّلّم معلنة في
     الكود لا مخفيّة، فيمكن مراجعتها وتعديلها — وهذا ما يميّز «قاعدة قرار»
     عن «توصية».

     ⚠️ لا تُخرج هذه الدالة رقم ثقة ولا احتمال نجاح، ولا تقول «اشترِ» بلا
     شرط تأكيد سعري. أعلى ما تصل إليه: «الشروط مكتملة — الدخول عند س بعد
     تحقّق ص، والوقف ع». والتنفيذ قرارك أنت.

     @param {Array} cs شموع يومية
     @param {{signal?:object, measured?:object, dirUp?:boolean}} [opt]
            measured: نتيجة evaluateGates إن سبق حسابها — بها يرتقي الحكم
            من «قاعدة معلنة» إلى «قاعدة مقاسة على هذا السهم».
     ════════════════════════════════════════════════════════════════════ */
  /* تمييز العدد في العربية: 1 مفرد · 2 مثنّى · 3–10 جمع · 11+ مفرد منصوب.
     «بعد 9 جلسة» و«قمة متوقع» أخطاء تُضعف الثقة بمنتج عربي بقدر ما يُضعفها
     رقم خاطئ — القارئ يقرأ الاثنين معاً. */
  function barsAr(n) {
    n = Math.round(n);
    if (n === 1) return 'جلسة واحدة';
    if (n === 2) return 'جلستين';
    if (n >= 3 && n <= 10) return `${n} جلسات`;
    return `${n} جلسة`;
  }
  const turnAr = t => (t === 'valley' ? 'قاع متوقَّع' : 'قمة متوقَّعة');

  const ACTION = {
    NONE: 'no_trade',      /* لا صفقة، ولا انتظار: الأداة لا تنطبق */
    WATCH: 'watch',        /* راقب — النافذة لم تُفتح بعد */
    APPROACH: 'approach',  /* النافذة مفتوحة لكن السعر ليس عند البنية */
    READY: 'ready'         /* الشروط مكتملة — تنفيذ مشروط بتأكيد سعري */
  };

  function actionPlan(cs, opt) {
    opt = opt || {};
    const out = { ok: false, action: ACTION.NONE, title: '', action_ar: '', why: [], steps: [] };

    if (!cs || cs.length < 80) {
      out.title = 'لا يمكن الحكم';
      out.action_ar = 'وسّع النطاق الزمني';
      out.why.push(`العيّنة ${cs ? cs.length : 0} جلسة، والحد الأدنى 80.`);
      out.steps.push('وسّع النطاق من أزرار الفريم أعلى الشارت إلى سنة أو سنتين، ثم أعد فتح التقرير.');
      return out;
    }

    const sig = opt.signal || timingSignal(cs, { dirUp: opt.dirUp });
    if (!sig.ok) {
      out.title = 'لا يمكن الحكم';
      out.action_ar = 'لا تحليل زمني على هذه البيانات';
      out.why.push(sig.reason || 'تعذّر بناء سلسلة البوابات.');
      return out;
    }
    out.ok = true;
    out.signal = sig;

    const gate = n => sig.gates.find(g => g.name === n) || { pass: false, why: '—' };
    const cyc = gate('cycle'), liq = gate('liquidity');
    const spec = sig.spectral || {};
    const turn = sig.nextTurn;

    /* الدليل المقاس، إن وُجد — يُغيّر مستوى الثقة في القاعدة لا القاعدة نفسها */
    const m = opt.measured;
    let measuredNote = null, measuredBlocks = false;
    if (m && m.ok) {
      const cycStat = (m.gateStats || []).find(g => g.gate === 'cycle');
      if (!m.winners || !m.winners.length) {
        measuredBlocks = true;
        measuredNote = `القياس على هذا السهم: لا تركيبة بوابات تفوّقت على الدخول غير المشروط بدلالة إحصائية (${m.samples} نقطة قياس). فالنافذة — إن فُتحت — للمراقبة لا للتنفيذ.`;
      } else {
        measuredNote = `القياس على هذا السهم: «${m.winners[0].label}» تعطي ${m.winners[0].winRatePct}٪ إصابة (فاصل ${m.winners[0].winRateCI[0]}–${m.winners[0].winRateCI[1]}٪) مقابل ${m.baseline.winRatePct}٪ لخط الأساس، بتغطية ${m.winners[0].coveragePct}٪ من الفرص.`;
      }
      if (cycStat && cycStat.fired === 0)
        measuredNote += ' وبوابة الدورة لم تمرّ ولا مرّة خلال فترة القياس كلها.';
    }

    /* ① لا دورة دالة ⇒ التوقيت الزمني لا ينطبق على هذا السهم إطلاقاً */
    if (!spec.significant) {
      out.action = ACTION.NONE;
      out.title = 'هذا السهم لا يُتداول بالتوقيت الزمني';
      out.action_ar = 'لا تنتظر تاريخاً — تعامل معه بالبنية السعرية وحدها';
      out.why.push(`الطيف لا يختلف عن ضجيج عشوائي (p = ${spec.pValueText || '—'}) ⇒ لا دورة تُشتقّ منها نافذة.`);
      out.why.push('هذه نتيجة صحيحة لا عطل، وهي حال أغلب الأسهم.');
      out.steps.push('افتح تبويب «🧭 غرفة القرار» واضغط «احسب القرارات» — القرار هناك مبني على الدعوم والمقاومات والسيولة، ولا يحتاج دورة.');
      out.steps.push('أو استعمل القسم «7️⃣ السيناريو التنفيذي» في هذا التقرير: دخول ووقف وهدف مشتقّة من البنية السعرية.');
      if (measuredNote) out.measured = measuredNote;
      return out;
    }

    /* ② دورة دالة لكن النافذة لم تُفتح بعد ⇒ مراقبة بتاريخ */
    if (!cyc.pass) {
      out.action = ACTION.WATCH;
      out.title = 'دورة قائمة، والنافذة لم تُفتح بعد';
      out.why.push(cyc.why);
      if (turn && turn.barsAhead != null) {
        let date = null;
        try { date = E.SaudiMarket.addTradingDays(new Date(), turn.barsAhead); } catch (e) { }
        out.action_ar = `راقب — ${turnAr(turn.type)} بعد ${barsAr(turn.barsAhead)}`
          + (turn.sdBars != null ? ` ± ${turn.sdBars}` : '')
          + (date ? ` (${date.toLocaleDateString('ar-SA')})` : '');
        out.window = { type: turn.type, barsAhead: turn.barsAhead, sdBars: turn.sdBars, loBars: turn.loBars, hiBars: turn.hiBars, usable: turn.usable, date };
        out.steps.push('ضع تنبيهاً قبل النافذة بجلستين، ولا تدخل عند بلوغ التاريخ وحده: التاريخ يفتح المراقبة، والدخول يفتحه السعر.');
        if (turn.usable === false) out.why.push('وعدم يقين هذا الانعطاف أوسع من ربع دورة، أي أن النافذة تغطّي القمة والقاع معاً فلا تميّز بينهما.');
      } else {
        out.action_ar = 'راقب — لا انعطاف قابل للاستعمال ضمن الأفق القريب';
        out.steps.push('أعد فتح التقرير بعد بضع جلسات؛ النافذة تتقدّم مع الزمن.');
      }
      if (measuredNote) out.measured = measuredNote;
      return out;
    }

    /* ③ النافذة مفتوحة لكن السعر ليس عند بنية سيولة ⇒ انتظار وصول السعر */
    if (!liq.pass) {
      out.action = ACTION.APPROACH;
      out.title = 'النافذة الزمنية مفتوحة — والسعر ليس عند بنية';
      out.action_ar = 'انتظر وصول السعر إلى منطقة بنيوية قبل أي دخول';
      out.why.push(cyc.why);
      out.why.push(liq.why);
      const zones = (sig.liquidity && sig.liquidity.zones) || [];
      const price = sig.liquidity && sig.liquidity.price;
      if (zones.length && price != null) {
        const near = zones.map(z => ({ z, d: Math.min(Math.abs(price - z.top), Math.abs(price - z.bot)) }))
          .sort((a, b) => a.d - b.d).slice(0, 2);
        out.zones = near.map(x => x.z);
        out.steps.push(`أقرب المناطق: ${near.map(x => `${x.z.kind} ${x.z.bot}–${x.z.top}`).join(' · ')}. الدخول يُدرس عند وصول السعر إليها، لا قبله.`);
      } else {
        out.steps.push('لا توجد فجوة قيمة عادلة ولا كتلة أوامر حيّة في اتجاه الصفقة — والدخول بلا بنية دخول بلا مرجع للوقف.');
      }
      if (measuredNote) out.measured = measuredNote;
      return out;
    }

    /* ④ الشرطان الإلزاميان تحقّقا ⇒ نطلب الأسعار من المحرك */
    const plan = E.executionPlan(cs, { dirUp: sig.dirUp });
    if (!plan.ok) {
      out.action = ACTION.NONE;
      out.title = 'التوقيت جاهز — ولا خطة تنفيذية';
      out.action_ar = 'لا صفقة: لا يوجد هدف يُشتقّ من البنية';
      out.why.push(cyc.why); out.why.push(liq.why);
      out.why.push(plan.reason || 'تعذّر بناء خطة.');
      out.steps.push('وسّع النطاق الزمني ليظهر مستوى بنيوي أبعد، أو تعامل مع السهم بوقف متحرّك بلا هدف ثابت.');
      if (measuredNote) out.measured = measuredNote;
      return out;
    }
    out.plan = plan;

    if (!plan.viable) {
      out.action = ACTION.NONE;
      out.title = 'التوقيت جاهز — والصفقة غير مجدية';
      out.action_ar = `لا صفقة: العائد/المخاطرة 1:${plan.rr1} دون الحد الأدنى 1:${plan.minRR}`;
      out.why.push(cyc.why); out.why.push(liq.why);
      out.why.push(plan.viabilityNote);
      out.steps.push('انتظر سعراً أفضل: كلما اقترب الدخول من الوقف تحسّنت النسبة. أو اتركه — ليست كل نافذة صفقة.');
      if (measuredNote) out.measured = measuredNote;
      return out;
    }

    /* ⑤ كل الشروط مكتملة */
    out.action = ACTION.READY;
    out.title = measuredBlocks ? 'الشروط مكتملة — لكن القياس لا يدعمها على هذا السهم' : 'الشروط مكتملة';
    out.action_ar = measuredBlocks
      ? `مراقبة مشدّدة لا تنفيذ — الدخول المرجعي ${plan.entry} والوقف ${plan.stop}`
      : `${sig.dirUp ? 'شراء' : 'بيع'} عند ${plan.entry} · وقف ${plan.stop} · هدف ${plan.target1} (1:${plan.rr1}) — بعد تحقّق شرط التأكيد`;
    out.why.push(cyc.why); out.why.push(liq.why);
    const extra = sig.gates.filter(g => g.pass && g.name !== 'cycle' && g.name !== 'liquidity');
    if (extra.length) out.why.push(`وبوابات مؤيّدة إضافية: ${extra.map(g => g.name).join('، ')}.`);
    out.steps.push(`شرط التأكيد الإلزامي: ${plan.confirmCondition || 'إغلاق جلسة في اتجاه الصفقة بحجم أعلى من الوسيط'}.`);
    out.steps.push(`الوقف ${plan.stop} مصدره: ${plan.stopSource}. لا تدخل صفقة لا تحتمل هذا الوقف.`);
    out.steps.push('احسب الكمية من «🧭 غرفة القرار» — الدخول بلا حجم مركز محسوب مخاطرة غير معلومة.');
    if (measuredBlocks) out.steps.unshift('⚠️ لم تجتز أي تركيبة بوابات التصحيح الإحصائي على هذا السهم، فتعامل مع هذه الإشارة كمراقبة حتى تتحسّن العيّنة.');
    if (measuredNote) out.measured = measuredNote;
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════
     7) قياس أثر البوابات — الجزء الذي يجعل كل ما سبق قابلاً للتصديق
     ──────────────────────────────────────────────────────────────────
     كل مرشّح يبدو معقولاً على الورق. السؤال الوحيد الذي يهمّ: هل يرفع نسبة
     الإصابة فعلاً على هذا السهم، وبكم إشارة يدفع الثمن؟

     تمشي هذه الدالة على التاريخ شمعةً شمعة، وعند كل شمعة تعيد بناء كل شيء
     من البيانات المتاحة حتى تلك اللحظة فقط، ثم تسجّل أي البوابات مرّت وما
     نتيجة الصفقة. ثم تُخرج لكل تركيبة بوابات: عدد الإشارات، نسبة الإصابة،
     فاصل Wilson، والرفع مقابل خط الأساس غير المشروط.

     ثلاث قواعد تحكم القراءة:
     ① تركيبة بأقلّ من `minSamples` إشارة لا يُقرأ رقمها إطلاقاً — نسبة 80٪
       من خمس صفقات ليست 80٪، هي لا شيء.
     ② الرفع المقاس على السهم نفسه لا يُعمَّم على غيره.
     ③ فحص عدة تركيبات على نفس البيانات يُنتج فائزاً بالصدفة وحدها، لذلك
       يُطبَّق تصحيح Benjamini-Hochberg على قيم الاحتمال.
     ════════════════════════════════════════════════════════════════════ */

  const GATE_NAMES = ['cycle', 'liquidity', 'mtf', 'flow', 'warp'];

  function evaluateGates(cs, opt) {
    opt = opt || {};
    const cfg = {
      warmup: opt.warmup == null ? 120 : opt.warmup,
      step: opt.step == null ? 1 : opt.step,
      horizon: opt.horizon == null ? 20 : opt.horizon,
      atrStopMult: opt.atrStopMult == null ? 1.5 : opt.atrStopMult,
      rewardRisk: opt.rewardRisk == null ? 2 : opt.rewardRisk,
      minSamples: opt.minSamples == null ? 20 : opt.minSamples,
      fdr: opt.fdr == null ? 0.10 : opt.fdr,
      recompute: opt.recompute == null ? 3 : opt.recompute
    };
    if (!cs || cs.length < cfg.warmup + cfg.horizon + 30)
      return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — القياس يتطلب ${cfg.warmup + cfg.horizon + 30}+` };

    const atrA = E.atrSeries(cs, 14);
    const last = cs.length - 1 - cfg.horizon;
    const rows = [];
    let cached = null, cachedAt = -1;

    for (let t = cfg.warmup; t <= last; t += cfg.step) {
      const a = atrA[t];
      if (!isNum(a) || a <= 0) continue;

      /* البوابات ثقيلة الحساب — تُعاد كل `recompute` شمعة، والطور يُزاح
         بينها. إعادة الحساب كل شمعة أدقّ لكنها تجعل مسح السوق كله دقائق. */
      let sig;
      if (cached && t - cachedAt < cfg.recompute) sig = cached;
      else { sig = timingSignal(cs, { idx: t }); cached = sig; cachedAt = t; }
      if (!sig.ok) continue;

      const trade = E.simulateTrade(cs, t, sig.dirUp !== false, {
        atrStopMult: cfg.atrStopMult, rewardRisk: cfg.rewardRisk,
        maxHoldBars: cfg.horizon, atrSeries: atrA
      });
      if (!trade) continue;

      const flags = {};
      for (const n of GATE_NAMES) { const g = sig.gates.find(x => x.name === n); flags[n] = !!(g && g.pass); }
      rows.push({ t, flags, dirUp: sig.dirUp !== false, win: trade.r > 0, r: trade.r, bars: trade.bars });
    }

    if (rows.length < cfg.minSamples)
      return { ok: false, reason: `${rows.length} نقطة قياس فقط — دون الحد الأدنى ${cfg.minSamples}`, samples: rows.length, config: cfg };

    const summarize = subset => {
      if (!subset.length) return null;
      const wins = subset.filter(x => x.win).length;
      const ci = S.wilson(wins, subset.length);
      return {
        count: subset.length, wins,
        winRatePct: r2(ci.p * 100),
        winRateCI: [r2(ci.lo * 100), r2(ci.hi * 100)],
        expectancyR: r3(S.mean(subset.map(x => x.r))),
        avgBars: r2(S.mean(subset.map(x => x.bars)))
      };
    };

    const baseline = summarize(rows);

    /* ══ إحصاء كل بوابة على حدة ══════════════════════════════════════
       🛠️ بلا هذا القسم كان الجدول يعرض التركيبات التي بلغت الحد الأدنى
       للعيّنة فقط، ويُسقط الباقي **بصمت**. النتيجة أن المستخدم يرى جدولاً
       بصفّين ولا يعرف: هل بوابة الدورة لم تمرّ أبداً؟ أم مرّت مرّتين؟ أم
       أن في الحساب عطلاً؟ الغياب الصامت هو بالضبط ما بُنيت هذه المنصة
       لإزالته — فصار كل بوابة تُبلّغ عن عدد مرور صريح ولو كان صفراً. */
    const gateStats = GATE_NAMES.map(n => {
      const hit = rows.filter(r => r.flags[n]);
      const st = summarize(hit);
      const readable = hit.length >= cfg.minSamples;
      return {
        gate: n,
        fired: hit.length,
        firedPct: r2(hit.length / rows.length * 100),
        /* 🛠️ الرقم يُحجب حين لا تكفي العيّنة، ولا يُعرض بجواره تحذيرٌ يُقرأ
           بعده. نسخة أولى كانت تُخرج «إصابة 0٪ · رفع −20.69» من 12 صفقة ثم
           تُلحقها بملاحظة «فلا يُقرأ رقمها» — والعين تقرأ الرقم الأحمر لا
           الملاحظة. إن كان الرقم غير صالح للقراءة فمكانه null لا الشاشة. */
        winRatePct: readable ? st.winRatePct : null,
        liftPts: readable ? r2(st.winRatePct - baseline.winRatePct) : null,
        winRateCI: readable ? st.winRateCI : null,
        /* القيم الخام متاحة برمجياً لمن يريد تجميعها عبر عدة أسهم — حيث
           تصبح العيّنات المجمّعة كافية — لكنها لا تُعرض صفاً مفرداً. */
        winRatePctRaw: st ? st.winRatePct : null,
        liftPtsRaw: st ? r2(st.winRatePct - baseline.winRatePct) : null,
        readable,
        note: hit.length === 0
          ? 'لم تمرّ ولا مرّة واحدة على هذا السهم — لا شيء يُقاس، وليس هذا عطلاً'
          : !readable
            ? `مرّت ${hit.length} مرة فقط — دون الحد الأدنى ${cfg.minSamples}، فالرقم محجوب لا مخفيّ`
            : null
      };
    });

    /* الاتجاه المفترض: حين لا توجد دورة دالة يُفترض الصعود، فتصير كل نقاط
       القياس صفقات شراء. على سهم هابط يفسّر ذلك انخفاض خط الأساس وحده،
       قبل أي كلام عن البوابات. */
    const longCount = rows.filter(r => r.dirUp !== false).length;

    /* كل تركيبة غير فارغة من البوابات الخمس */
    const combos = [];
    for (let mask = 1; mask < (1 << GATE_NAMES.length); mask++) {
      const names = GATE_NAMES.filter((_, i) => mask & (1 << i));
      const subset = rows.filter(r => names.every(n => r.flags[n]));
      const stat = summarize(subset);
      if (!stat) continue;
      const p = S.twoProportionP(stat.wins, stat.count, baseline.wins, baseline.count);
      combos.push({
        gates: names,
        label: names.join(' + '),
        ...stat,
        /* التغطية: كم من الفرص يبقى بعد التصفية — الثمن المدفوع مقابل الدقة */
        coveragePct: r2(stat.count / baseline.count * 100),
        liftPts: r2(stat.winRatePct - baseline.winRatePct),
        pValueRaw: p,
        underpowered: stat.count < cfg.minSamples
      });
    }

    /* تصحيح الاختبارات المتعددة: 31 تركيبة على نفس البيانات تُنتج فائزاً
       بالصدفة وحدها ما لم يُصحَّح */
    const testable = combos.filter(c => !c.underpowered);
    const pass = S.benjaminiHochberg(testable.map(c => c.pValueRaw), cfg.fdr);
    testable.forEach((c, i) => { c.significant = pass[i] && c.liftPts > 0; c.pValue = S.pText(c.pValueRaw); });
    combos.forEach(c => { if (c.underpowered) { c.significant = false; c.pValue = S.pText(c.pValueRaw); } });

    const winners = testable.filter(c => c.significant).sort((a, b) => b.liftPts - a.liftPts);
    const ranked = combos.slice().sort((a, b) => b.liftPts - a.liftPts);

    return {
      ok: true,
      samples: rows.length,
      baseline,
      gateStats,
      direction: {
        longPct: r2(longCount / rows.length * 100),
        shortPct: r2((rows.length - longCount) / rows.length * 100),
        note: longCount === rows.length
          ? 'كل نقاط القياس صفقات شراء: لم تُكتشف دورة دالة تحدّد الاتجاه، فافتُرض الصعود. على سهم هابط يفسّر هذا وحده انخفاض خط الأساس — قبل أي حكم على البوابات.'
          : `${r2(longCount / rows.length * 100)}٪ شراء و${r2((rows.length - longCount) / rows.length * 100)}٪ بيع، والاتجاه مستمدّ من طور الدورة عند كل نقطة.`
      },
      combos: ranked,
      winners,
      testedCombos: combos.length,
      testableCombos: testable.length,
      config: cfg,
      verdict: winners.length
        ? `${winners.length} تركيبة تفوّقت على خط الأساس بعد تصحيح Benjamini-Hochberg. أفضلها «${winners[0].label}»: نسبة إصابة ${winners[0].winRatePct}٪ (فاصل ${winners[0].winRateCI[0]}–${winners[0].winRateCI[1]}٪) مقابل ${baseline.winRatePct}٪ لخط الأساس، برفع ${winners[0].liftPts} نقطة — والثمن أن الإشارات تنخفض إلى ${winners[0].coveragePct}٪ من الفرص.`
        : (() => {
          const dead = gateStats.filter(g => g.fired === 0).map(g => g.gate);
          const thin = gateStats.filter(g => g.fired > 0 && g.fired < cfg.minSamples).map(g => g.gate);
          return `لا تركيبة بوابات تتفوّق على خط الأساس بدلالة إحصائية على هذا السهم (${testable.length} تركيبة قابلة للاختبار من ${combos.length}). هذه نتيجة صحيحة لا عطل: المرشّحات لا تعمل على كل سهم، والامتناع أصدق من عرض رقم لم يجتز التصحيح.`
            + (dead.length ? ` ولم تمرّ هذه البوابات ولا مرّة واحدة: ${dead.join('، ')} — أي أن شرطها غير متحقّق على هذا السهم أصلاً.` : '')
            + (thin.length ? ` ومرّت هذه بعيّنة أصغر من أن تُقرأ: ${thin.join('، ')}.` : '');
        })(),
      caveat: 'سهم واحد وتاريخ واحد. نتيجة إيجابية هنا لا تُعمَّم على أسهم أخرى ولا على المستقبل، ولا تحسم العمولات ولا الانزلاق السعري.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     8) الواجهة المصدَّرة
     ════════════════════════════════════════════════════════════════════ */
  return {
    VERSION, version: VERSION, GATE_WEIGHTS, GATE_NAMES,

    /* إعادة التجميع */
    resampleByCount, resampleWeekly,

    /* البنية الهيكلية */
    findFVG, findOrderBlocks, liquidityGate,

    /* الزمن */
    dtw, warpedCyclePhase, mtfAlignment,

    /* التدفّق */
    volumeFlow,

    /* التركيب والقياس */
    timingSignal, actionPlan, ACTION, evaluateGates
  };
});
