/* ══════════════════════════════════════════════════════════════════════════
   KSA-H1 — محرك التحليل الكمي (Core Analytics Engine)
   ──────────────────────────────────────────────────────────────────────────
   وحدة مستقلة، قابلة للاختبار في Node وفي المتصفح على حد سواء.
   كل دالة هنا لا تعتمد على DOM ولا على حالة عامة (G) — مدخلات ← مخرجات فقط.

   مبادئ التصميم (وهي أساس تصحيح الأخطاء الجذرية):
   1) لا رقم "ثقة" مصطنع. أي احتمال يُعرض يجب أن يأتي من عينة محسوبة،
      ومعه حجم العينة وفاصل ثقة (Wilson) — أو لا يُعرض إطلاقاً.
   2) لا تسرّب زمني (look-ahead). كل نقطة ارتكاز لها فهرس "تأكيد" لا يجوز
      استخدامها قبله، وكل اختبار تاريخي يعيد الحساب من البيانات المتاحة
      حتى تلك اللحظة فقط.
   3) لا عشوائية غير مُبذّرة. كل مولّد أرقام عشوائية هنا ببذرة ثابتة، فتكون
      كل النتائج قابلة لإعادة الإنتاج بالضبط.
   4) الوحدات صريحة. أيام تداول ≠ أيام تقويمية، والعائد ≠ السعر.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KSAEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     0) أدوات عامة — عشوائية ببذرة، وحماية من القيم غير المنتهية
     ════════════════════════════════════════════════════════════════════ */

  /** مولّد عشوائي حتمي (mulberry32). نفس البذرة ⇒ نفس السلسلة دائماً.
   *  السبب: تقارير الاختبار التاريخي كانت تتغيّر بين تشغيل وآخر لأنها
   *  استخدمت Math.random — فيخرج "حكم" مختلف لنفس السهم بنفس البيانات. */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** بذرة مستقرة مشتقة من نص (رمز السهم) — حتى يكون لكل سهم سلسلة ثابتة. */
  function seedFromString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  /** يرجع القيمة إن كانت رقماً منتهياً، وإلا القيمة البديلة. يمنع تسرّب
   *  NaN/Infinity إلى الواجهة (كان يظهر "NaN ر.س" في عدة مسارات). */
  const num = (v, fallback = null) => (isNum(v) ? v : fallback);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => (isNum(v) ? +v.toFixed(d) : null);

  /* ════════════════════════════════════════════════════════════════════
     1) إحصاء — الأساس الذي تُبنى عليه كل "الاحتمالات" المعروضة
     ════════════════════════════════════════════════════════════════════ */

  const Stats = {
    mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; },

    /** تباين العينة (قسمة على n-1) — التقدير غير المتحيّز.
     *  النسخة السابقة في المنصة كانت تقسم على n وتُهمل طرح المتوسط. */
    variance(a) {
      const n = a.length;
      if (n < 2) return 0;
      const m = Stats.mean(a);
      return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
    },
    std(a) { return Math.sqrt(Stats.variance(a)); },

    quantile(a, q) {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      const pos = (s.length - 1) * q;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
    },

    /** انحدار خطي بسيط بأقل المربعات. يرجع الميل والمقطع و R². */
    linreg(y, x) {
      const n = y.length;
      if (n < 2) return { slope: 0, intercept: y[0] ?? 0, r2: 0 };
      const xs = x || y.map((_, i) => i);
      const mx = Stats.mean(xs), my = Stats.mean(y);
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = y[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
      }
      const slope = sxx ? sxy / sxx : 0;
      return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
    },

    /** فاصل ثقة Wilson لنسبة نجاح — الطريقة الصحيحة لعينة صغيرة.
     *  هذا ما يجعل عرض "نسبة نجاح 70%" أمينًا: 7 من 10 نجاحات تعطي
     *  فاصلاً [39%, 90%] — أي أن الرقم وحده بلا معنى بدون هذا الفاصل. */
    wilson(successes, n, z = 1.959964) {
      if (!n) return { p: null, lo: null, hi: null, n: 0 };
      const p = successes / n;
      const z2 = z * z;
      const denom = 1 + z2 / n;
      const centre = (p + z2 / (2 * n)) / denom;
      const half = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
      return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
    },

    /** دالة التوزيع التراكمي للتوزيع الطبيعي القياسي (تقريب Abramowitz-Stegun). */
    normalCdf(x) {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const d = 0.3989422804014327 * Math.exp(-x * x / 2);
      let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      return x > 0 ? 1 - p : p;
    },

    /** اختبار z لفرق نسبتين (طرفان). يرجع p-value.
     *  يُستخدم للحكم: هل نسبة نجاح الإشارة تختلف فعلاً عن خط الأساس،
     *  أم أن الفرق يقع ضمن التذبذب العشوائي المتوقع لحجم العينة هذا؟ */
    twoProportionP(s1, n1, s2, n2) {
      if (!n1 || !n2) return 1;
      const p1 = s1 / n1, p2 = s2 / n2;
      const pPool = (s1 + s2) / (n1 + n2);
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
      if (!se) return 1;
      const z = (p1 - p2) / se;
      return 2 * (1 - Stats.normalCdf(Math.abs(z)));
    },

    /** تصحيح Benjamini-Hochberg لمعدل الاكتشاف الخاطئ (FDR).
     *  ضروري عند مسح ~250 سهماً: عند مستوى 5٪ ستظهر ~12 نتيجة "دالة"
     *  بمحض الصدفة وحدها. بدون هذا التصحيح تكون قائمة "الأسهم المؤهلة"
     *  في المسح الشامل ضجيجاً بالكامل. */
    benjaminiHochberg(pValues, alpha = 0.10) {
      const m = pValues.length;
      if (!m) return [];
      const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
      let kMax = -1;
      for (let k = 0; k < m; k++) if (idx[k].p <= ((k + 1) / m) * alpha) kMax = k;
      const pass = new Array(m).fill(false);
      for (let k = 0; k <= kMax; k++) pass[idx[k].i] = true;
      return pass;
    },

    /** لوغاريتم دالة غاما (Lanczos) — لازم لمعامل ذي الحدين في اختبار Fisher. */
    lnGamma(x) {
      const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      let xx = x, y = x, tmp = x + 5.5;
      tmp -= (xx + 0.5) * Math.log(tmp);
      let ser = 1.000000000190015;
      for (let j = 0; j < 6; j++) ser += g[j] / ++y;
      return -tmp + Math.log(2.5066282746310005 * ser / xx);
    },
    lnChoose(n, k) {
      if (k < 0 || k > n) return -Infinity;
      return Stats.lnGamma(n + 1) - Stats.lnGamma(k + 1) - Stats.lnGamma(n - k + 1);
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     2) تقويم السوق السعودي (تداول)
     ──────────────────────────────────────────────────────────────────
     تداول يعمل الأحد→الخميس. الجمعة والسبت عطلة أسبوعية.
     كل حساب "أيام متبقية" في المنصة كان يخلط أيام التداول بالأيام
     التقويمية، فينتج تاريخ متوقع يقع في عطلة أو يزيح بأسبوع كامل.
     ════════════════════════════════════════════════════════════════════ */

  const SaudiMarket = {
    TZ_OFFSET_HOURS: 3,               /* توقيت السعودية UTC+3 (بلا توقيت صيفي) */
    SESSION: { open: '10:00', close: '15:00' },
    DAILY_LIMIT_MAIN: 0.10,           /* حد التذبذب اليومي للسوق الرئيسية ±10٪ */
    DAILY_LIMIT_NOMU: 0.30,           /* السوق الموازية (نمو) ±30٪ */

    /** يوم الأسبوع بتوقيت الرياض (0=الأحد … 6=السبت). */
    riyadhDayOfWeek(date) {
      const ms = date.getTime() + SaudiMarket.TZ_OFFSET_HOURS * 3600e3;
      return new Date(ms).getUTCDay();
    },
    /** الجمعة (5) والسبت (6) عطلة أسبوعية في السوق السعودي. */
    isWeekend(date) {
      const d = SaudiMarket.riyadhDayOfWeek(date);
      return d === 5 || d === 6;
    },
    isTradingDay(date) { return !SaudiMarket.isWeekend(date); },

    /** يضيف عدداً من *أيام التداول* إلى تاريخ، متجاوزاً العطل الأسبوعية.
     *  هذا هو التحويل الصحيح من "بعد 13 شمعة" إلى تاريخ تقويمي فعلي. */
    addTradingDays(date, n) {
      const d = new Date(date.getTime());
      let left = Math.max(0, Math.round(n));
      while (left > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (SaudiMarket.isTradingDay(d)) left--;
      }
      return d;
    },

    /** يعدّ أيام التداول بين تاريخين (حصري للبداية، شامل للنهاية). */
    tradingDaysBetween(from, to) {
      if (to <= from) return 0;
      let n = 0;
      const d = new Date(from.getTime());
      while (d < to) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (SaudiMarket.isTradingDay(d)) n++;
      }
      return n;
    },

    /** حدّ التذبذب اليومي: أعلى/أدنى سعر مسموح غداً بناءً على إغلاق اليوم.
     *  أي هدف سعري خارج هذا النطاق لا يمكن بلوغه في جلسة واحدة — والمنصة
     *  كانت تعرض أهدافاً تتجاوزه دون أي تنويه. */
    dailyLimits(prevClose, market = 'main') {
      const lim = market === 'nomu' ? SaudiMarket.DAILY_LIMIT_NOMU : SaudiMarket.DAILY_LIMIT_MAIN;
      return { up: round(prevClose * (1 + lim)), down: round(prevClose * (1 - lim)), limitPct: lim * 100 };
    },

    /** أقل عدد جلسات لازمة نظرياً لبلوغ سعر هدف مع احترام حدّ التذبذب. */
    minSessionsToReach(fromPrice, toPrice, market = 'main') {
      if (!isNum(fromPrice) || !isNum(toPrice) || fromPrice <= 0 || toPrice <= 0) return null;
      const lim = market === 'nomu' ? SaudiMarket.DAILY_LIMIT_NOMU : SaudiMarket.DAILY_LIMIT_MAIN;
      const ratio = toPrice / fromPrice;
      if (ratio === 1) return 0;
      const step = ratio > 1 ? Math.log(1 + lim) : Math.log(1 - lim);
      return Math.ceil(Math.log(ratio) / step);
    },

    /** هل السوق مفتوح الآن (تقريبي: بلا العطل الرسمية المتغيّرة سنوياً). */
    isOpenNow(now = new Date()) {
      if (!SaudiMarket.isTradingDay(now)) return false;
      const ms = now.getTime() + SaudiMarket.TZ_OFFSET_HOURS * 3600e3;
      const d = new Date(ms);
      const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      return mins >= 10 * 60 && mins < 15 * 60;
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     3) نقاط الارتكاز المؤكدة — بلا تسرّب زمني
     ──────────────────────────────────────────────────────────────────
     المشكلة الجذرية في النسخة السابقة: كشف القمم/القيعان استعمل
     lows[i+1] و lows[i+2]، أي بيانات لاحقة للشمعة i. عند الفحص التاريخي
     كان هذا يعني أن النموذج "يعرف المستقبل" — فتخرج نتائج اختبار
     متفائلة بلا أي مقابل في التداول الحقيقي.

     الحل: لكل ارتكاز نسجّل `confirmedAt = i + k`. لا يجوز لأي حساب يجري
     عند الشمعة t أن يستخدم ارتكازاً confirmedAt > t. الدوال هنا تفرض ذلك.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * يكشف نقاط الارتكاز بعرض k شمعة على كل جانب.
   * @param {Array} candles  شموع {time,open,high,low,close,volume}
   * @param {number} k       عدد الشموع المطلوبة على كل جانب (افتراضي 3)
   * @param {number} asOf    آخر فهرس مرئي (محاكاة "الآن" في الاختبار التاريخي)
   * @returns {Array} [{i, price, type:'H'|'L', confirmedAt}]  مرتّبة زمنياً
   */
  function detectPivots(candles, k = 3, asOf = null) {
    const n = candles.length;
    const limit = asOf == null ? n - 1 : Math.min(asOf, n - 1);
    const out = [];
    for (let i = k; i + k <= limit; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= k; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      /* confirmedAt = i+k: الشمعة التي عندها اكتملت أدلة الارتكاز فعلياً */
      if (isHigh) out.push({ i, price: candles[i].high, type: 'H', confirmedAt: i + k });
      if (isLow) out.push({ i, price: candles[i].low, type: 'L', confirmedAt: i + k });
    }
    return out;
  }

  /** آخر ارتكاز *مؤكّد* عند الشمعة asOf — لا شيء من المستقبل. */
  function lastConfirmedPivot(candles, k = 3, asOf = null) {
    const limit = asOf == null ? candles.length - 1 : asOf;
    const pivots = detectPivots(candles, k, limit);
    for (let idx = pivots.length - 1; idx >= 0; idx--) {
      if (pivots[idx].confirmedAt <= limit) return pivots[idx];
    }
    return null;
  }

  /** الدورة الذاتية للسهم = متوسط المسافة بين ارتكازات متعاقبة من نفس النوع،
   *  مع مقياس اتساق = 1 - (معامل الاختلاف). اتساق منخفض ⇒ لا دورة حقيقية. */
  function dominantPivotCycle(candles, k = 3, asOf = null) {
    const pivots = detectPivots(candles, k, asOf);
    if (pivots.length < 4) return null;
    const gaps = [];
    for (const type of ['H', 'L']) {
      const sub = pivots.filter(p => p.type === type);
      for (let i = 1; i < sub.length; i++) gaps.push(sub[i].i - sub[i - 1].i);
    }
    if (gaps.length < 3) return null;
    const m = Stats.mean(gaps), sd = Stats.std(gaps);
    const cv = m ? sd / m : 1;
    return {
      cycle: Math.round(m),
      consistencyPct: round(clamp((1 - cv) * 100, 0, 100), 0),
      sampleSize: gaps.length,
      /* اتساق أقل من 50٪ يعني تباعداً غير منتظم — ضجيج، لا دورة */
      reliable: (1 - cv) >= 0.5 && gaps.length >= 5
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     4) التحليل الطيفي — النسخة الصحيحة
     ──────────────────────────────────────────────────────────────────
     ثلاثة أخطاء جذرية في النسخة السابقة، كلها مُصلَحة هنا:

     (أ) اختبار الدلالة كان z-score على طاقات الطيف نفسه. القياس التجريبي
         أظهر أنه يصنّف 91.5٪ من مسارات المشي العشوائي المحض على أنها
         "دالة إحصائياً" — أي أنه بلا قيمة تمييزية. البديل: اختبار Fisher's g
         بقيمة احتمال مضبوطة (exact p-value) تحت فرضية الضجيج الأبيض.

     (ب) المسح كان على "أطوال دورات صحيحة" 5..60، وهي شبكة غير منتظمة في
         التردد: الدورتان 55 و56 تكادان تكونان نفس التردد، بينما 5 و6
         متباعدتان جداً. هذا يضخّم الدورات الطويلة ويشوّه أي "حصة طاقة".
         البديل: ترددات فورييه المنتظمة k/N.

     (ج) الإسقاط الأمامي كان يعامل موجة *العوائد* كأنها موجة *السعر* —
         خطأ طور مقداره 90°: قمة السعر تقع حيث يعبر العائد الصفر هبوطاً،
         لا حيث يبلغ العائد قمته. البديل: نثبت الدلالة على العوائد (حيث
         فرضية الضجيج الأبيض معقولة)، ثم نلائم الجيبية على *لوغاريتم
         السعر منزوع الاتجاه* عند نفس التردد ونُسقط تلك الموجة.
     ════════════════════════════════════════════════════════════════════ */

  /** الدورية (periodogram) على ترددات فورييه المنتظمة k/N. */
  function periodogram(series) {
    const N = series.length;
    const m = Math.floor((N - 1) / 2);
    const mean = Stats.mean(series);
    const x = series.map(v => v - mean);
    const out = [];
    for (let k = 1; k <= m; k++) {
      const w = (2 * Math.PI * k) / N;
      let re = 0, im = 0;
      for (let t = 0; t < N; t++) { re += x[t] * Math.cos(w * t); im += x[t] * Math.sin(w * t); }
      out.push({ k, freq: k / N, period: N / k, power: (re * re + im * im) / N });
    }
    return out;
  }

  /**
   * اختبار Fisher's g للدورية.
   * تحت فرضية العدم (ضجيج أبيض غاوسي) تكون إحداثيات الدورية مستقلة
   * وموزّعة أسّياً، فتكون g = max(I) / Σ(I) لها توزيع معلوم بالضبط:
   *   P(g > x) = Σ_{j=1..⌊1/x⌋} (-1)^(j-1) · C(m,j) · (1 - j·x)^(m-1)
   * هذه قيمة احتمال حقيقية — لا "درجة ثقة" مخترعة.
   */
  function fisherGTest(powers) {
    const m = powers.length;
    if (m < 4) return { g: null, p: 1, m };
    const total = powers.reduce((s, v) => s + v, 0);
    if (!total) return { g: 0, p: 1, m };
    const g = Math.max(...powers) / total;
    const jMax = Math.min(Math.floor(1 / g), m);
    let p = 0;
    for (let j = 1; j <= jMax; j++) {
      const lnTerm = Stats.lnChoose(m, j) + (m - 1) * Math.log(1 - j * g);
      if (!isFinite(lnTerm)) continue;
      p += (j % 2 === 1 ? 1 : -1) * Math.exp(lnTerm);
      /* الحدود تتناقص بسرعة؛ نتوقف عند بلوغ دقة تفوق ما نعرضه */
      if (Math.abs(Math.exp(lnTerm)) < 1e-12) break;
    }
    return { g: round(g, 5), p: clamp(p, 0, 1), m };
  }

  /** ملاءمة جيبية بأقل المربعات عند تردد محدّد: y ≈ A·cos(ωt) + B·sin(ωt).
   *  يرجع السعة والطور بصيغة R·cos(ωt + φ). */
  function fitSinusoid(y, freq) {
    const n = y.length, w = 2 * Math.PI * freq;
    let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0;
    for (let t = 0; t < n; t++) {
      const c = Math.cos(w * t), s = Math.sin(w * t);
      cc += c * c; ss += s * s; cs += c * s; yc += y[t] * c; ys += y[t] * s;
    }
    const det = cc * ss - cs * cs;
    if (!det) return { amplitude: 0, phase: 0, A: 0, B: 0 };
    const A = (yc * ss - ys * cs) / det;
    const B = (ys * cc - yc * cs) / det;
    return { A, B, amplitude: Math.hypot(A, B), phase: Math.atan2(-B, A) };
  }

  /**
   * التحليل الطيفي الكامل.
   * @param {number[]} closes أسعار الإغلاق
   * @param {object} opts { alpha: مستوى الدلالة (افتراضي 0.05) }
   */
  function spectral(closes, opts = {}) {
    const alpha = opts.alpha ?? 0.05;
    const n = closes.length;
    if (n < 40) return { ok: false, reason: `يتطلب 40 شمعة على الأقل (متوفر ${n})` };

    /* (1) الدلالة تُختبر على العوائد اللوغاريتمية: تحت فرضية "لا دورة"
       تكون العوائد اليومية قريبة جداً من ضجيج أبيض، وهي بالضبط الفرضية
       التي بُني عليها اختبار Fisher. اختباره على السعر مباشرة كان سيرفض
       فرضية العدم دائماً لمجرد أن السعر متسلسل زمنياً (I(1)). */
    const rets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i] <= 0 || closes[i - 1] <= 0) return { ok: false, reason: 'أسعار غير صالحة (صفر أو سالبة)' };
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const pg = periodogram(rets);
    /* نحصر النطاق العملي: دورات من 4 شمعات حتى ثلث طول العينة. دورة أطول
       من ذلك لا تتكرّر بما يكفي في العينة لتُقاس أصلاً. */
    const band = pg.filter(p => p.period >= 4 && p.period <= rets.length / 3);
    if (band.length < 4) return { ok: false, reason: 'نطاق ترددي ضيّق جداً لهذا الطول' };

    const test = fisherGTest(band.map(p => p.power));
    const peak = band.reduce((a, b) => (b.power > a.power ? b : a));
    const totalBand = band.reduce((s, p) => s + p.power, 0) || 1;
    const significant = test.p <= alpha;

    /* (2) الطور والسعة تُستخرجان من *لوغاريتم السعر منزوع الاتجاه الخطي*
       عند نفس التردد، لأن ما نريد إسقاطه للأمام هو قمم/قيعان السعر،
       لا قمم العائد. هذا يصحّح خطأ طور مقداره 90° في النسخة السابقة. */
    const logP = closes.map(v => Math.log(v));
    const trend = Stats.linreg(logP);
    const detrended = logP.map((v, i) => v - (trend.intercept + trend.slope * i));
    const fit = fitSinusoid(detrended, peak.freq);

    /* موقع الطور الحالي داخل الدورة: 0° = قمة، 180° = قاع */
    const wNow = 2 * Math.PI * peak.freq * (n - 1) + fit.phase;
    const phaseNow = ((wNow % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const cyclePosPct = round((phaseNow / (2 * Math.PI)) * 100, 1);

    return {
      ok: true,
      period: round(peak.period, 1),
      freq: peak.freq,
      /* حصة الطاقة داخل النطاق المفحوص — تُعرض كوصف، لا كدليل دلالة */
      bandSharePct: round((peak.power / totalBand) * 100, 1),
      amplitudePct: round((Math.exp(fit.amplitude) - 1) * 100, 2), /* سعة الدورة كنسبة سعرية */
      phase: round(fit.phase, 4),
      cyclePosPct,                       /* 0٪=قمة الدورة، 50٪=قاع الدورة */
      gStatistic: test.g,
      pValue: test.p,
      pValueText: test.p < 0.001 ? '<0.001' : test.p.toFixed(3),
      alpha,
      significant,
      /* تفسير صريح بدل رقم ثقة: إما رفضنا فرضية العدم أو لم نرفضها */
      verdict: significant
        ? `دورة دالة إحصائياً (p=${test.p < 0.001 ? '<0.001' : test.p.toFixed(3)} ≤ ${alpha})`
        : `لا دليل على دورة — الطيف لا يختلف عن ضجيج عشوائي (p=${test.p.toFixed(3)} > ${alpha})`,
      trendSlopePerBar: round(trend.slope, 6),
      trendR2: round(trend.r2, 3),
      top: band.slice().sort((a, b) => b.power - a.power).slice(0, 5)
        .map(p => ({ period: round(p.period, 1), sharePct: round((p.power / totalBand) * 100, 1) }))
    };
  }

  /**
   * إسقاط نقاط انعطاف السعر المتوقعة من الدورة الطيفية.
   * يعمل *فقط* على دورة اجتازت اختبار الدلالة — الإسقاط من دورة غير دالة
   * هو رسم لموجة على ضجيج، وكان هذا مصدر "النوافذ الزمنية" الوهمية.
   */
  function projectCycleTurns(spec, lastIndex, horizonBars = 60) {
    if (!spec || !spec.ok || !spec.significant) return [];
    const w = 2 * Math.PI * spec.freq;
    const turns = [];
    const val = (t) => Math.cos(w * t + spec.phase);
    let prev = val(lastIndex), prevSlope = prev - val(lastIndex - 1);
    for (let t = lastIndex + 1; t <= lastIndex + horizonBars; t++) {
      const v = val(t), slope = v - prev;
      if (prevSlope > 0 && slope <= 0) turns.push({ type: 'peak', barsAhead: t - 1 - lastIndex });
      else if (prevSlope < 0 && slope >= 0) turns.push({ type: 'valley', barsAhead: t - 1 - lastIndex });
      prev = v; prevSlope = slope;
    }
    return turns.filter(t => t.barsAhead > 0);
  }

  /* ════════════════════════════════════════════════════════════════════
     5) التنبؤ — ARIMA(1,1,0) بفترة تنبؤ صحيحة
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة حسبت نطاق عدم اليقين كـ σ·√h. هذا صحيح فقط لمشي
     عشوائي محض (φ=0). للنموذج AR(1) على الفروق، التباين التراكمي بعد h
     خطوة هو:
        Var(h) = σ² · Σ_{k=1..h} [ (1 - φ^(h-k+1)) / (1 - φ) ]²
     الفرق جوهري: عند φ=0.68 (سهم ذو زخم) تكون σ·√h أقل من الصحيح
     بأكثر من الضعف — أي أن النطاق المعروض كان يوحي بيقين غير موجود.
     ════════════════════════════════════════════════════════════════════ */

  function forecastARIMA(closes, horizon = 5, opts = {}) {
    const z = opts.z ?? 1.959964;                    /* 95٪ */
    const n = closes.length;
    if (n < 30) return { ok: false, reason: `يتطلب 30 شمعة على الأقل (متوفر ${n})` };

    const d = [];
    for (let i = 1; i < n; i++) d.push(closes[i] - closes[i - 1]);

    /* تقدير φ بأقل المربعات على d[t] = φ·d[t-1] + ε */
    const x = d.slice(0, -1), y = d.slice(1), m = x.length;
    const mx = Stats.mean(x), my = Stats.mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    let phi = sxx ? sxy / sxx : 0;
    phi = clamp(phi, -0.95, 0.95);                   /* شرط الاستقرارية */

    /* الخطأ المعياري لـ φ — يحدّد إن كان الزخم الذاتي مميّزاً عن الصفر */
    let sse = 0;
    for (let i = 0; i < m; i++) sse += (y[i] - phi * x[i]) ** 2;
    const sigma2 = sse / Math.max(1, m - 1);
    const sigma = Math.sqrt(sigma2);
    const sePhi = sxx ? Math.sqrt(sigma2 / sxx) : Infinity;
    const tPhi = sePhi ? phi / sePhi : 0;
    const phiPValue = 2 * (1 - Stats.normalCdf(Math.abs(tPhi)));

    /* التنبؤ النقطي */
    let lastDiff = d[d.length - 1], price = closes[n - 1], point = price;
    for (let h = 1; h <= horizon; h++) { lastDiff = phi * lastDiff; point += lastDiff; }

    /* تباين التنبؤ التراكمي الصحيح لـ ARIMA(1,1,0) */
    let varSum = 0;
    for (let k = 1; k <= horizon; k++) {
      const psi = phi === 1 ? (horizon - k + 1) : (1 - Math.pow(phi, horizon - k + 1)) / (1 - phi);
      varSum += psi * psi;
    }
    const seForecast = sigma * Math.sqrt(varSum);
    const lo = point - z * seForecast, hi = point + z * seForecast;

    /* هل يختلف التنبؤ فعلاً عن "لا تغيّر"؟ إن كان السعر الحالي داخل
       فاصل التنبؤ فالجواب لا — وهذا هو الوضع الطبيعي لمعظم الأسهم.
       عرض رقم تنبؤ بلا هذه الجملة هو إيحاء زائف بالدقة. */
    const meaningful = price < lo || price > hi;

    return {
      ok: true, horizon,
      phi: round(phi, 3), phiPValue: round(phiPValue, 4),
      phiSignificant: phiPValue <= 0.05,
      sigma: round(sigma, 4),
      point: round(point), lo: round(lo), hi: round(hi),
      bandPct: round((z * seForecast) / price * 100, 2),
      expectedChangePct: round((point - price) / price * 100, 2),
      meaningful,
      note: meaningful
        ? 'التنبؤ يقع خارج نطاق "لا تغيّر" — فرق قابل للتمييز إحصائياً'
        : 'السعر الحالي يقع داخل فاصل التنبؤ 95٪ — أي أن النموذج لا يميّز هذا التوقع عن "بلا تغيّر". لا تبنِ قراراً على الفرق.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     6) المؤشرات التراكمية — VWAP مثبّت، OBV، وخط التجميع/التوزيع
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري: VWAP في المنصة كان يتراكم من أول شمعة في النطاق
     المحمّل ولا يُصفَّر أبداً. VWAP بمعناه الحقيقي يُثبَّت على نقطة بداية
     (جلسة، أو قاع/قمة مؤكدة). تراكمه عبر ٣ أشهر يجعله متوسطاً بطيئاً
     بلا معنى تنفيذي — وكان يُعرض للمستخدم على أنه VWAP.
     ════════════════════════════════════════════════════════════════════ */

  const Cumulative = {
    /**
     * VWAP مثبّت على فهرس بداية محدّد (anchor).
     *
     * @param {boolean} opts.capOutliers  يحدّ وزن أي شمعة عند 3× الوسيط.
     *   السبب: VWAP التنفيذي يجب أن يعكس الحجم كما وقع فعلاً (بلا حدّ).
     *   أما حين يُستخدم كـ *مرساة مرجعية* لنطاق القيمة، فصفقة تبادلية
     *   ضخمة في يوم واحد تزيح المرساة بنسبة معتبرة رغم أنها لا تقول شيئاً
     *   عن القيمة — وهو بالضبط العيب الذي أسقط "السعر العادل" السابق.
     *   الوسيط هنا مقياس متين (robust) لا يتأثر بالقيم الشاذة.
     */
    anchoredVWAP(candles, anchorIdx = 0, opts = {}) {
      const out = new Array(candles.length).fill(null);
      let cap = Infinity;
      if (opts.capOutliers) {
        const vols = candles.slice(anchorIdx).map(c => c.volume || 0).filter(v => v > 0);
        const med = vols.length ? Stats.quantile(vols, 0.5) : 0;
        if (med > 0) cap = med * 3;
      }
      let pv = 0, vol = 0;
      for (let i = anchorIdx; i < candles.length; i++) {
        const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
        const v = Math.min(candles[i].volume || 0, cap);
        pv += tp * v; vol += v;
        out[i] = vol > 0 ? pv / vol : candles[i].close;
      }
      return out;
    },

    /** VWAP متدحرج على نافذة ثابتة — البديل العملي حين لا توجد نقطة تثبيت. */
    rollingVWAP(candles, window = 20) {
      const out = new Array(candles.length).fill(null);
      for (let i = 0; i < candles.length; i++) {
        if (i < window - 1) continue;
        let pv = 0, vol = 0;
        for (let j = i - window + 1; j <= i; j++) {
          const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
          pv += tp * (candles[j].volume || 0); vol += candles[j].volume || 0;
        }
        out[i] = vol > 0 ? pv / vol : candles[i].close;
      }
      return out;
    },

    /** On-Balance Volume. */
    obv(candles) {
      const out = [0];
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i].close, p = candles[i - 1].close, v = candles[i].volume || 0;
        out.push(out[i - 1] + (c > p ? v : c < p ? -v : 0));
      }
      return out;
    },

    /** خط التجميع/التوزيع (Accumulation/Distribution) — يزن الحجم بموقع
     *  الإغلاق داخل مدى الشمعة، فيميّز "حجم عالٍ بإغلاق ضعيف" عن العكس،
     *  وهو ما يعجز OBV عن رؤيته لأنه يعتمد إشارة التغيّر فقط. */
    adLine(candles) {
      const out = [];
      let acc = 0;
      for (const c of candles) {
        const range = c.high - c.low;
        const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0;
        acc += mfm * (c.volume || 0);
        out.push(acc);
      }
      return out;
    },

    /**
     * تباعد مؤشر تراكمي عن السعر، مُطبَّع بحيث يكون قابلاً للمقارنة بين
     * الأسهم: ميل كل سلسلة يُقسَم على مداها في النافذة نفسها، فيصبح
     * الرقمان بلا وحدة. المقارنة الخام (أسهم مقابل ريالات) كانت بلا معنى.
     */
    divergence(candles, series, window = 20) {
      const n = candles.length;
      if (n < window + 2) return { type: null, why: 'نافذة غير كافية', strength: 0 };
      const segS = series.slice(-window), segP = candles.slice(-window).map(c => c.close);
      const rangeS = Math.max(...segS) - Math.min(...segS) || 1;
      const rangeP = Math.max(...segP) - Math.min(...segP) || 1;
      const slopeS = (Stats.linreg(segS).slope * window) / rangeS;
      const slopeP = (Stats.linreg(segP).slope * window) / rangeP;
      const gap = slopeS - slopeP;
      let type = null;
      if (slopeS > 0.15 && slopeP < 0.05) type = 'bullish';
      else if (slopeS < -0.15 && slopeP > -0.05) type = 'bearish';
      return {
        type,
        slopeSeries: round(slopeS, 3), slopePrice: round(slopeP, 3),
        strength: round(Math.abs(gap), 3),
        why: type === 'bullish' ? 'المؤشر التراكمي يصعد بينما السعر ثابت/هابط ← تجميع خفي'
          : type === 'bearish' ? 'المؤشر التراكمي يهبط بينما السعر ثابت/صاعد ← تصريف خفي'
            : 'لا تباعد واضح بين المؤشر التراكمي والسعر'
      };
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     7) ملف الحجم الحقيقي (Volume Profile) والنطاق القيمي
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة عرّفت POC بأنه "إغلاق الشمعة الأعلى حجماً" — وهذا ليس
     POC. الـPOC هو مستوى السعر الذي تداول عنده أكبر حجم تراكمي عبر
     الفترة كلها، ويُحسب بتوزيع حجم كل شمعة على شرائح السعر التي غطّتها.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * @param {object} opts
   *   bins        عدد شرائح السعر (افتراضي 60)
   *   capOutliers يحدّ مساهمة أي جلسة عند 3× وسيط الحجم.
   *
   * ملاحظة منهجية مهمة: ملف الحجم الحقيقي يُبنى من بيانات التِك، حيث
   * يتوزّع حجم اليوم الواحد على عشرات مستويات السعر خلال الجلسة. نحن هنا
   * نملك شموعاً يومية فقط، فيهبط حجم اليوم كله داخل شريحة ضيّقة. النتيجة:
   * جلسة واحدة بحجم استثنائي (صفقة تبادلية مثلاً) تُعيد كتابة الـPOC
   * بالكامل — قياسنا: ×20 حجم في يوم واحد أزاح الـPOC بنسبة 25.6٪.
   * هذا أثر تقريب البيانات لا حقيقة سوقية، لذا يُفعَّل الحدّ افتراضياً
   * عند استخدام الملف كمرساة قيمة (valueBand)، ويُترك مطفأً حين يُعرض
   * الحجم كما وقع فعلاً.
   */
  function volumeProfile(candles, binsOrOpts = 60, maybeOpts = {}) {
    const opts = typeof binsOrOpts === 'object' ? binsOrOpts : { bins: binsOrOpts, ...maybeOpts };
    const bins = opts.bins ?? 60;
    if (!candles.length) return null;
    const hi = Math.max(...candles.map(c => c.high));
    const lo = Math.min(...candles.map(c => c.low));
    if (!(hi > lo)) return null;
    const width = (hi - lo) / bins;
    const hist = new Array(bins).fill(0);

    let cap = Infinity;
    if (opts.capOutliers) {
      const vols = candles.map(c => c.volume || 0).filter(v => v > 0);
      const med = vols.length ? Stats.quantile(vols, 0.5) : 0;
      if (med > 0) cap = med * 3;
    }

    for (const c of candles) {
      const v = Math.min(c.volume || 0, cap);
      if (!v) continue;
      /* توزيع حجم الشمعة بالتساوي على الشرائح التي غطّاها مدى high-low */
      const b0 = clamp(Math.floor((c.low - lo) / width), 0, bins - 1);
      const b1 = clamp(Math.floor((c.high - lo) / width), 0, bins - 1);
      const span = b1 - b0 + 1;
      for (let b = b0; b <= b1; b++) hist[b] += v / span;
    }

    const total = hist.reduce((s, v) => s + v, 0) || 1;
    let pocBin = 0;
    for (let b = 1; b < bins; b++) if (hist[b] > hist[pocBin]) pocBin = b;

    /* منطقة القيمة: نتوسّع من الـPOC للجانبين حتى نغطّي 70٪ من الحجم */
    let acc = hist[pocBin], lowBin = pocBin, highBin = pocBin;
    while (acc / total < 0.70 && (lowBin > 0 || highBin < bins - 1)) {
      const below = lowBin > 0 ? hist[lowBin - 1] : -1;
      const above = highBin < bins - 1 ? hist[highBin + 1] : -1;
      if (above >= below) { highBin++; acc += hist[highBin]; }
      else { lowBin--; acc += hist[lowBin]; }
    }

    const binPrice = (b) => lo + (b + 0.5) * width;
    return {
      poc: round(binPrice(pocBin)),
      valueAreaLow: round(binPrice(lowBin) - width / 2),
      valueAreaHigh: round(binPrice(highBin) + width / 2),
      valueAreaPct: round((acc / total) * 100, 1),
      rangeLow: round(lo), rangeHigh: round(hi),
      bins: hist.map((v, b) => ({ price: round(binPrice(b)), volPct: round((v / total) * 100, 2) }))
    };
  }

  /**
   * النطاق القيمي المرجعي — بديل "السعر العادل" السابق.
   *
   * لماذا حُذف السعر العادل القديم: كان حاصل ضرب أربعة عوامل مخترعة،
   * أحدها (عامل الحجم) يعتمد على حجم *يوم واحد*. القياس أظهر أن مضاعفة
   * حجم آخر يوم ×4 ترفع "السعر العادل" من 82.91 إلى 124.41 — أي أن
   * الرقم كان يتحرك 50٪ بسبب متغيّر لا علاقة له بالقيمة إطلاقاً.
   *
   * البديل هنا لا يدّعي معرفة "القيمة الحقيقية" (وهي لا تُشتق من الشارت
   * أصلاً)، بل يعرض **نطاقاً مرجعياً إحصائياً** مبنياً على ثلاثة مراسٍ
   * قابلة للتحقق: POC الحجمي، وVWAP المثبّت، وقناة الانحدار.
   */
  function valueBand(candles, opts = {}) {
    const n = candles.length;
    if (n < 30) return { ok: false, reason: `يتطلب 30 شمعة (متوفر ${n})` };
    const closes = candles.map(c => c.close);
    const price = closes[n - 1];

    const vp = volumeProfile(candles, { bins: 60, capOutliers: true });
    const pivot = lastConfirmedPivot(candles, 3);
    /* نضمن نافذة تثبيت لا تقل عن 20 جلسة: ارتكاز حديث جداً يجعل الـVWAP
       محسوباً من شمعتين أو ثلاث، فتهيمن جلسة واحدة على المرساة بالكامل. */
    const MIN_ANCHOR_BARS = 20;
    const rawAnchor = pivot ? pivot.i : Math.max(0, n - 60);
    const anchorIdx = Math.min(rawAnchor, Math.max(0, n - MIN_ANCHOR_BARS));
    const avwapArr = Cumulative.anchoredVWAP(candles, anchorIdx, { capOutliers: true });
    const avwap = avwapArr[n - 1];

    /* قناة انحدار على لوغاريتم السعر — الانحراف المعياري للبواقي يعطي
       عرض القناة، وهو مقياس تجريبي لا افتراضي */
    const logP = closes.map(v => Math.log(v));
    const reg = Stats.linreg(logP);
    const resid = logP.map((v, i) => v - (reg.intercept + reg.slope * i));
    const rStd = Stats.std(resid);
    const fitNow = reg.intercept + reg.slope * (n - 1);
    const regMid = Math.exp(fitNow);
    const regLow = Math.exp(fitNow - 2 * rStd);
    const regHigh = Math.exp(fitNow + 2 * rStd);

    const anchors = [
      { label: 'POC الحجمي (أكثر سعر تداولاً)', value: vp ? vp.poc : null },
      { label: `VWAP مثبّت على ${pivot ? (pivot.type === 'L' ? 'آخر قاع مؤكد' : 'آخر قمة مؤكدة') : 'آخر 60 شمعة'}`, value: round(avwap) },
      { label: 'وسط قناة الانحدار', value: round(regMid) }
    ].filter(a => isNum(a.value));

    const vals = anchors.map(a => a.value);
    const center = Stats.mean(vals);
    const spread = vals.length > 1 ? Stats.std(vals) : Math.abs(regHigh - regLow) / 4;

    const devPct = round(((price - center) / center) * 100, 2);
    /* التصنيف نسبةً إلى تشتّت المراسي نفسها، لا إلى عتبات ثابتة مخترعة */
    const zVsAnchors = spread > 0 ? (price - center) / spread : 0;

    return {
      ok: true,
      price: round(price),
      anchors,
      center: round(center),
      bandLow: round(Math.max(regLow, center - 2 * spread)),
      bandHigh: round(Math.min(regHigh, center + 2 * spread)),
      regressionLow: round(regLow), regressionHigh: round(regHigh), regressionR2: round(reg.r2, 3),
      valueArea: vp ? { low: vp.valueAreaLow, high: vp.valueAreaHigh, poc: vp.poc } : null,
      deviationPct: devPct,
      zVsAnchors: round(zVsAnchors, 2),
      /* لا "شراء قوي / بيع قوي" — وصف موقع فقط، والقرار للمستخدم */
      position: Math.abs(zVsAnchors) < 1 ? 'داخل نطاق المراسي المرجعية'
        : zVsAnchors >= 1 ? 'أعلى من كل المراسي المرجعية (امتداد سعري)'
          : 'أدنى من كل المراسي المرجعية (انضغاط سعري)',
      caveat: 'هذا نطاق مرجعي إحصائي مشتق من الشارت والحجم فقط. ليس تقييماً للشركة، ولا يتضمن أرباحاً أو ميزانية أو أخباراً.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     8) التذبذب — بوحدات صريحة
     ════════════════════════════════════════════════════════════════════ */

  /** تذبذب سنوي بالنسبة المئوية من العوائد اللوغاريتمية اليومية.
   *  252 غير مناسبة لتداول: السنة فيه ≈ 246 جلسة (٥ أيام أسبوعياً ناقص
   *  العطل الرسمية). النسخة السابقة لم تكن تُسنّن أصلاً وكانت تعرض
   *  جذر متوسط مربّع العوائد على أنه "٪ تذبذب". */
  function volatility(closes, opts = {}) {
    const sessionsPerYear = opts.sessionsPerYear ?? 246;
    const n = closes.length;
    if (n < 3) return { ok: false, reason: 'بيانات غير كافية' };
    const rets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    if (rets.length < 2) return { ok: false, reason: 'بيانات غير كافية' };
    const daily = Stats.std(rets);
    return {
      ok: true,
      dailyPct: round(daily * 100, 2),
      annualPct: round(daily * Math.sqrt(sessionsPerYear) * 100, 1),
      /* المدى اليومي المتوقع بثقة 95٪ — رقم قابل للاستخدام في تحديد الوقف */
      expectedDailyRangePct: round(1.96 * daily * 100, 2),
      sampleSize: rets.length
    };
  }

  function atr(candles, period = 14) {
    const n = candles.length;
    if (n < period + 1) return null;
    const tr = [];
    for (let i = 1; i < n; i++) {
      tr.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      ));
    }
    /* Wilder smoothing — المتوسط البسيط الذي كان مستخدماً يعطي قيماً
       أعلى تذبذباً ويجعل مسافة الوقف تقفز بلا سبب */
    let a = Stats.mean(tr.slice(0, period));
    for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
    return round(a, 4);
  }

  /* ════════════════════════════════════════════════════════════════════
     9) النوافذ الزمنية — غان وفيبوناتشي، بوحدات صحيحة
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري السابق: خلط الوحدات. مناطق فيبوناتشي الزمنية تُقاس
     بالشموع (جلسات)، ودورات غان التقويمية تُقاس بالأيام التقويمية، وكانت
     تُجمَع في قائمة واحدة بعد ضربها في "معدّل تقريبي" مخترع (1.4).
     هنا كل نافذة تحمل وحدتها، والتحويل إلى تاريخ يمرّ عبر تقويم تداول
     الفعلي (أحد→خميس)، فلا يقع تاريخ متوقع في يوم عطلة.
     ════════════════════════════════════════════════════════════════════ */

  const FIB_BARS = [13, 21, 34, 55, 89, 144];
  const GANN_CALENDAR_DAYS = [30, 45, 60, 90, 120, 180, 270, 360];
  const BAR_TOLERANCE = 2;
  const DAY_TOLERANCE = 4;

  /**
   * يبني النوافذ الزمنية القادمة من ارتكاز مؤكد.
   * @returns {Array} [{label, unit:'bars'|'days', barsAhead, date, source}]
   */
  function timeWindows(candles, pivot, opts = {}) {
    const horizonDays = opts.horizonDays ?? 240;
    const n = candles.length;
    if (!pivot || pivot.i >= n) return [];

    const lastDate = new Date(candles[n - 1].time * 1000);
    const pivotDate = new Date(candles[pivot.i].time * 1000);
    const barsSince = (n - 1) - pivot.i;
    const daysSince = Math.round((lastDate - pivotDate) / 86400e3);

    const out = [];

    /* (أ) مناطق فيبوناتشي الزمنية — تُقاس بالشموع، وتُحوَّل لتاريخ عبر
       تقويم التداول الفعلي بدل أي معامل تحويل تقريبي */
    for (const f of FIB_BARS) {
      const ahead = f - barsSince;
      if (ahead <= 0) continue;
      const date = SaudiMarket.addTradingDays(lastDate, ahead);
      const daysLeft = Math.round((date - lastDate) / 86400e3);
      if (daysLeft > horizonDays) continue;
      out.push({ label: `منطقة فيبوناتشي الزمنية ${f} جلسة`, unit: 'bars', barsAhead: ahead, daysLeft, date, source: 'fib' });
    }

    /* (ب) دورات غان التقويمية — تُقاس بالأيام التقويمية مباشرة.
       تاريخ الدورة نفسه تقويمي بحت وقد يقع في جمعة أو سبت. النافذة
       *القابلة للتداول* هي أول جلسة تالية له، ونعرض الاثنين صراحة بدل
       إعطاء المستخدم تاريخاً لا يفتح فيه السوق أصلاً. */
    for (const g of GANN_CALENDAR_DAYS) {
      const daysLeft = g - daysSince;
      if (daysLeft <= 0 || daysLeft > horizonDays) continue;
      const cycleDate = new Date(lastDate.getTime() + daysLeft * 86400e3);
      const date = new Date(cycleDate.getTime());
      let shifted = 0;
      while (!SaudiMarket.isTradingDay(date)) { date.setUTCDate(date.getUTCDate() + 1); shifted++; }
      const barsAhead = Math.max(1, SaudiMarket.tradingDaysBetween(lastDate, date));
      out.push({
        label: `دورة غان ${g} يوم تقويمي` + (shifted ? ` (تقع في عطلة — أول جلسة بعدها)` : ''),
        unit: 'days', barsAhead, daysLeft: daysLeft + shifted,
        date, cycleDate, shiftedFromWeekend: shifted > 0, source: 'gann'
      });
    }

    /* (ج) الدورة الذاتية للسهم — فقط إن كانت منتظمة فعلاً */
    const dc = dominantPivotCycle(candles, 3);
    if (dc && dc.reliable) {
      for (let k = 1; k <= 2; k++) {
        const ahead = dc.cycle * k - barsSince;
        if (ahead <= 0) continue;
        const date = SaudiMarket.addTradingDays(lastDate, ahead);
        const daysLeft = Math.round((date - lastDate) / 86400e3);
        if (daysLeft > horizonDays) continue;
        out.push({
          label: `دورة السهم الذاتية ×${k} (${dc.cycle} جلسة، اتساق ${dc.consistencyPct}٪)`,
          unit: 'bars', barsAhead: ahead, daysLeft, date, source: 'cycle'
        });
      }
    }

    /* (د) الانعطافات الطيفية — فقط من دورة اجتازت اختبار الدلالة */
    const spec = spectral(candles.map(c => c.close));
    if (spec.ok && spec.significant) {
      for (const t of projectCycleTurns(spec, n - 1, 60)) {
        const date = SaudiMarket.addTradingDays(lastDate, t.barsAhead);
        const daysLeft = Math.round((date - lastDate) / 86400e3);
        if (daysLeft > horizonDays) continue;
        out.push({
          label: `انعطاف طيفي (دورة ${spec.period} جلسة، p=${spec.pValueText}) — ${t.type === 'peak' ? 'قمة متوقعة' : 'قاع متوقع'}`,
          unit: 'bars', barsAhead: t.barsAhead, daysLeft, date, source: 'spectral', turnType: t.type
        });
      }
    }

    out.sort((a, b) => a.barsAhead - b.barsAhead);
    return out;
  }

  /** توافق زمني: كم دليلاً زمنياً *مستقلاً* يشير إلى نفس النافذة القريبة. */
  function timeConfluence(candles, pivot) {
    const n = candles.length;
    const barsSince = (n - 1) - pivot.i;
    const lastDate = new Date(candles[n - 1].time * 1000);
    const daysSince = Math.round((lastDate - new Date(candles[pivot.i].time * 1000)) / 86400e3);

    const fib = FIB_BARS.find(f => Math.abs(barsSince - f) <= BAR_TOLERANCE) || null;
    const gann = GANN_CALENDAR_DAYS.find(g => Math.abs(daysSince - g) <= DAY_TOLERANCE) || null;
    const dc = dominantPivotCycle(candles, 3);
    let cycle = null;
    if (dc && dc.reliable) {
      for (let k = 1; k <= 3; k++) if (Math.abs(barsSince - dc.cycle * k) <= BAR_TOLERANCE) { cycle = dc.cycle * k; break; }
    }
    const spec = spectral(candles.map(c => c.close));
    const specHit = spec.ok && spec.significant &&
      projectCycleTurns(spec, n - 1, 3).some(t => t.barsAhead <= 2);

    const evidence = [
      fib ? { name: `فيبوناتشي ${fib} جلسة`, hit: true } : { name: 'فيبوناتشي زمني', hit: false },
      gann ? { name: `غان ${gann} يوم`, hit: true } : { name: 'غان تقويمي', hit: false },
      cycle ? { name: `دورة السهم ${cycle} جلسة`, hit: true } : { name: 'دورة السهم الذاتية', hit: false },
      specHit ? { name: `انعطاف طيفي (p=${spec.pValueText})`, hit: true } : { name: 'انعطاف طيفي دال', hit: false }
    ];
    const count = evidence.filter(e => e.hit).length;

    return {
      barsSincePivot: barsSince, daysSincePivot: daysSince,
      evidence, count, total: evidence.length,
      /* تصنيف نصي فقط — ولا يُترجم أبداً إلى نسبة مئوية */
      label: count >= 3 ? 'توافق قوي' : count === 2 ? 'توافق متوسط' : count === 1 ? 'دليل منفرد' : 'لا توافق زمني'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     10) محرك الاختبار التاريخي — walk-forward، حتمي، بقيمة احتمال
     ──────────────────────────────────────────────────────────────────
     ثلاثة إصلاحات جذرية مقارنة بالنسخة السابقة:
     (أ) خط الأساس كان عيّنة عشوائية بحجم n باستخدام Math.random، فكان
         "الحكم" يتغيّر بين تشغيل وآخر لنفس السهم (تحقّقنا: نفس المدخلات
         أعطت حكماً إيجابياً مرة و"ضئيل" مرة). الآن: خط الأساس هو التوزيع
         غير المشروط الكامل — كل شمعة مؤهّلة، بلا عشوائية إطلاقاً.
     (ب) لا يوجد حكم بلا قيمة احتمال. الفرق في نسبة الربح يُختبر باختبار
         نسبتين، ويُعرض p-value وحجم العينة وفاصل Wilson.
     (ج) مسافة الوقف كانت 0.5×ATR، فكان متوسط عمر الصفقة أقل من شمعتين
         (قياس فعلي) — أي أن الضجيج وحده كان يُغلق الصفقات. الافتراضي
         الآن 1.5×ATR، وهو قابل للضبط.
     ════════════════════════════════════════════════════════════════════ */

  const BT_DEFAULTS = {
    atrStopMult: 1.5,
    rewardRisk: 2.0,
    maxHoldBars: 30,
    minSignals: 20,        /* أقل من ذلك لا يسمح بأي استنتاج إحصائي */
    minHistory: 80,
    stepBars: 5,
    alpha: 0.05
  };

  /**
   * يحاكي صفقة واحدة على البيانات اللاحقة فقط.
   * ملاحظة على غموض الشمعة الواحدة: إن لامست الشمعة الوقف والهدف معاً،
   * نفترض الوقف أولاً (الافتراض المتحفّظ). أي محاكاة تفترض العكس تُنتج
   * نتائج متفائلة زائفة.
   */
  function simulateTrade(candles, entryIdx, dirUp, cfg) {
    const c = { ...BT_DEFAULTS, ...cfg };
    if (entryIdx >= candles.length - 1) return null;
    const entry = candles[entryIdx].close;
    const a = atr(candles.slice(0, entryIdx + 1), 14) || entry * 0.02;
    const risk = a * c.atrStopMult;
    if (!(risk > 0)) return null;
    const stop = dirUp ? entry - risk : entry + risk;
    const target = dirUp ? entry + risk * c.rewardRisk : entry - risk * c.rewardRisk;
    if (stop <= 0) return null;

    const last = Math.min(candles.length - 1, entryIdx + c.maxHoldBars);
    for (let i = entryIdx + 1; i <= last; i++) {
      const { high, low } = candles[i];
      if (dirUp) {
        if (low <= stop) return { outcome: 'stop', rMultiple: -1, pnlPct: (stop - entry) / entry * 100, bars: i - entryIdx };
        if (high >= target) return { outcome: 'target', rMultiple: c.rewardRisk, pnlPct: (target - entry) / entry * 100, bars: i - entryIdx };
      } else {
        if (high >= stop) return { outcome: 'stop', rMultiple: -1, pnlPct: (entry - stop) / entry * 100, bars: i - entryIdx };
        if (low <= target) return { outcome: 'target', rMultiple: c.rewardRisk, pnlPct: (entry - target) / entry * 100, bars: i - entryIdx };
      }
    }
    const exit = candles[last].close;
    const pnl = dirUp ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    return { outcome: 'timeout', rMultiple: (dirUp ? exit - entry : entry - exit) / risk, pnlPct: pnl, bars: last - entryIdx };
  }

  function summarize(trades) {
    if (!trades.length) return null;
    const wins = trades.filter(t => t.pnlPct > 0).length;
    const pnls = trades.map(t => t.pnlPct);
    const rs = trades.map(t => t.rMultiple);
    const grossWin = pnls.filter(p => p > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(pnls.filter(p => p <= 0).reduce((s, v) => s + v, 0));
    const w = Stats.wilson(wins, trades.length);
    const mR = Stats.mean(rs), sdR = Stats.std(rs);
    /* أقصى تراجع على منحنى المضاعفات المتراكمة */
    let peak = 0, cum = 0, maxDD = 0;
    for (const r of rs) { cum += r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
    return {
      count: trades.length,
      wins,
      winRatePct: round(w.p * 100, 1),
      winRateCI: [round(w.lo * 100, 1), round(w.hi * 100, 1)],
      avgPnlPct: round(Stats.mean(pnls), 2),
      expectancyR: round(mR, 3),
      /* نسبة شارب للصفقة (ليست سنوية) — عائد متوسط لكل وحدة تشتّت */
      sharpePerTrade: sdR ? round(mR / sdR, 2) : null,
      profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : (grossWin ? null : 0),
      maxDrawdownR: round(maxDD, 2),
      avgBarsHeld: round(Stats.mean(trades.map(t => t.bars)), 1)
    };
  }

  /**
   * اختبار walk-forward لإشارة الدورة الطيفية على سهم واحد.
   * في كل خطوة يُعاد بناء الطيف من candles.slice(0, i+1) فقط.
   */
  function backtestSpectral(candles, cfg = {}) {
    const c = { ...BT_DEFAULTS, ...cfg };
    const n = candles.length;
    if (n < c.minHistory + c.maxHoldBars + 20) {
      return { ok: false, reason: `تاريخ غير كافٍ (متوفر ${n} شمعة، مطلوب ${c.minHistory + c.maxHoldBars + 20}+)` };
    }

    const signals = [];
    for (let i = c.minHistory; i < n - c.maxHoldBars; i += c.stepBars) {
      const hist = candles.slice(0, i + 1);
      const spec = spectral(hist.map(x => x.close), { alpha: c.alpha });
      if (!spec.ok || !spec.significant) continue;
      const turns = projectCycleTurns(spec, i, 10);
      const soon = turns.find(t => t.barsAhead <= 3);
      if (!soon) continue;
      const dirUp = soon.type === 'valley';
      const trade = simulateTrade(candles, i, dirUp, c);
      if (trade) signals.push({ ...trade, idx: i, dirUp });
    }

    /* خط الأساس: التوزيع غير المشروط الكامل — كل شمعة مؤهّلة، في كلا
       الاتجاهين. حتمي تماماً، ويمثّل "ماذا لو دخلت بلا إشارة إطلاقاً". */
    const baseline = [];
    for (let i = c.minHistory; i < n - c.maxHoldBars; i++) {
      for (const dir of [true, false]) {
        const t = simulateTrade(candles, i, dir, c);
        if (t) baseline.push(t);
      }
    }

    const sig = summarize(signals);
    const base = summarize(baseline);
    if (!base) return { ok: false, reason: 'تعذّر بناء خط أساس صالح من تاريخ هذا السهم' };
    if (!sig) {
      /* صفر إشارة ليس عطلاً — هو النتيجة الصحيحة لسهم بلا دورة دالة.
         النسخة السابقة كانت تعيد رسالة عطل عامة تُقرأ كخلل تقني. */
      return {
        ok: false, underpowered: true, signalCount: 0, signal: null, baseline: base,
        reason: 'لم تُصدر الإشارة الطيفية أي دخول على تاريخ هذا السهم — لا توجد دورة دالة إحصائياً تُبنى عليها. هذه نتيجة صحيحة، لا خلل.'
      };
    }

    if (signals.length < c.minSignals) {
      return {
        ok: false, underpowered: true, signalCount: signals.length,
        signal: sig, baseline: base,
        reason: `عدد الإشارات ${signals.length} أقل من الحد الأدنى ${c.minSignals} — العينة لا تسمح باستنتاج إحصائي. النتائج معروضة للاطلاع فقط ولا يجوز البناء عليها.`
      };
    }

    const p = Stats.twoProportionP(sig.wins, sig.count, base.wins, base.count);
    const edge = round(sig.winRatePct - base.winRatePct, 1);
    const significant = p <= c.alpha && edge > 0;

    return {
      ok: true,
      signalCount: signals.length,
      signal: sig, baseline: base,
      edgeWinRatePct: edge,
      edgeExpectancyR: round(sig.expectancyR - base.expectancyR, 3),
      pValue: round(p, 4),
      pValueText: p < 0.001 ? '<0.001' : p.toFixed(3),
      significant,
      verdict: significant
        ? `الإشارة تتفوّق على الدخول العشوائي على هذا السهم: فارق ${edge}+ نقطة في نسبة الربح (p=${p < 0.001 ? '<0.001' : p.toFixed(3)}، عينة ${sig.count} صفقة)`
        : `لا يوجد دليل إحصائي على تفوّق الإشارة على هذا السهم (فارق ${edge} نقطة، p=${p.toFixed(3)} > ${c.alpha}) — الفرق ضمن ما تفسّره الصدفة عند حجم العينة هذا`,
      config: { atrStopMult: c.atrStopMult, rewardRisk: c.rewardRisk, maxHoldBars: c.maxHoldBars, alpha: c.alpha }
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     11) خطة التنفيذ — مبنية على بنية حقيقية، وعلى حدود السوق السعودي
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة كانت تضع الهدف عند 2R دائماً ثم تعرض "R:R = 1:2"
     كأنه نتيجة تحليل — وهي حشو تعريفي (الهدف عُرِّف بأنه 2R). كما كانت
     تشتق الوقف والهدف من امتدادات فراكتالية قد تقع في الجهة الخاطئة:
     القياس أظهر وقفاً *فوق* سعر الدخول في 4 من 5 عيّنات.
     ════════════════════════════════════════════════════════════════════ */

  function structuralLevels(candles, price, lookback = 120) {
    const seg = candles.slice(-lookback);
    const pivots = detectPivots(seg, 3);
    const supports = pivots.filter(p => p.type === 'L' && p.price < price).map(p => p.price).sort((a, b) => b - a);
    const resistances = pivots.filter(p => p.type === 'H' && p.price > price).map(p => p.price).sort((a, b) => a - b);
    return { supports, resistances };
  }

  function executionPlan(candles, opts = {}) {
    const n = candles.length;
    if (n < 40) return { ok: false, reason: 'بيانات غير كافية لبناء خطة' };
    const price = candles[n - 1].close;
    const dirUp = opts.dirUp !== false;
    const a = atr(candles, 14) || price * 0.02;
    const atrMult = opts.atrStopMult ?? BT_DEFAULTS.atrStopMult;
    const { supports, resistances } = structuralLevels(candles, price);

    /* الوقف: خلف أقرب مستوى بنيوي في الجهة الصحيحة، أو مسافة ATR —
       أيّهما أبعد، حتى لا يقع الوقف داخل ضجيج الجلسة العادي. */
    const atrStop = dirUp ? price - a * atrMult : price + a * atrMult;
    const structStop = dirUp
      ? (supports.length ? supports[0] - a * 0.25 : null)
      : (resistances.length ? resistances[0] + a * 0.25 : null);
    let stop = atrStop, stopSource = `مسافة ${atrMult}×ATR من سعر الدخول`;
    if (isNum(structStop) && ((dirUp && structStop < atrStop) || (!dirUp && structStop > atrStop))) {
      stop = structStop;
      stopSource = `خلف أقرب ${dirUp ? 'دعم' : 'مقاومة'} بنيوي (${round(dirUp ? supports[0] : resistances[0])}) بهامش ربع ATR`;
    }
    if (dirUp && stop <= 0) return { ok: false, reason: 'وقف غير صالح' };

    const risk = Math.abs(price - stop);
    if (!(risk > 0)) return { ok: false, reason: 'مسافة مخاطرة صفرية' };

    /* الهدف: أقرب مستوى بنيوي مقابل — إن وُجد. وإلا امتداد ATR.
       نحسب R:R من الهدف الفعلي بدل فرضه مسبقاً. */
    const structTarget = dirUp ? (resistances.length ? resistances[0] : null)
      : (supports.length ? supports[0] : null);
    const fallbackTarget = dirUp ? price + risk * 2 : price - risk * 2;
    const target1 = isNum(structTarget) ? structTarget : fallbackTarget;
    const targetSource = isNum(structTarget)
      ? `أقرب ${dirUp ? 'مقاومة' : 'دعم'} بنيوي فعلي` : 'امتداد 2R (لا يوجد مستوى بنيوي مقابل ضمن النطاق)';
    const rr1 = round(Math.abs(target1 - price) / risk, 2);

    /* حدود السوق السعودي: كم جلسة يلزم نظرياً لبلوغ الهدف مع ±10٪ يومياً */
    const sessionsToTarget = SaudiMarket.minSessionsToReach(price, target1);
    const limits = SaudiMarket.dailyLimits(price);

    return {
      ok: true, dirUp,
      entry: round(price), stop: round(stop), stopSource,
      riskPerShare: round(risk), riskPct: round((risk / price) * 100, 2),
      target1: round(target1), targetSource, rr1,
      /* تحذير صريح حين لا يستحق الوضع الدخول أصلاً */
      viable: rr1 >= 1.5,
      viabilityNote: rr1 >= 1.5 ? null
        : `أقرب مستوى بنيوي مقابل يعطي عائداً/مخاطرة ${rr1} فقط — أقل من 1.5. الدخول هنا غير مجدٍ بالبنية الحالية، والانتظار أفضل من توسيع الهدف قسراً.`,
      atr: round(a),
      dailyLimitUp: limits.up, dailyLimitDown: limits.down,
      minSessionsToTarget: sessionsToTarget,
      resistances: resistances.slice(0, 3).map(v => round(v)),
      supports: supports.slice(0, 3).map(v => round(v))
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     12) تدقيق جودة البيانات — يمنع بناء تحليل على مدخلات فاسدة
     ════════════════════════════════════════════════════════════════════ */

  function auditCandles(candles) {
    const issues = [];
    if (!Array.isArray(candles) || !candles.length) return { ok: false, issues: ['لا توجد شموع'], count: 0 };
    let badOHLC = 0, nonPositive = 0, zeroVol = 0, dupTime = 0, outOfOrder = 0, gaps = 0;
    const seen = new Set();
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!isNum(c.open) || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)) { badOHLC++; continue; }
      if (c.close <= 0 || c.open <= 0) nonPositive++;
      if (c.high < Math.max(c.open, c.close) - 1e-9 || c.low > Math.min(c.open, c.close) + 1e-9) badOHLC++;
      if (!c.volume) zeroVol++;
      if (seen.has(c.time)) dupTime++; else seen.add(c.time);
      if (i > 0 && c.time <= candles[i - 1].time) outOfOrder++;
      /* فجوة تتجاوز 10 أيام تقويمية بين شمعتين يوميتين متتاليتين = تعليق
         تداول أو عطلة طويلة — تُبطل حسابات الدورات التقويمية إن أُهملت */
      if (i > 0 && (c.time - candles[i - 1].time) > 10 * 86400) gaps++;
    }
    if (badOHLC) issues.push(`${badOHLC} شمعة بقيم OHLC غير متسقة`);
    if (nonPositive) issues.push(`${nonPositive} شمعة بسعر غير موجب`);
    if (dupTime) issues.push(`${dupTime} طابع زمني مكرر`);
    if (outOfOrder) issues.push(`${outOfOrder} شمعة خارج الترتيب الزمني`);
    if (gaps) issues.push(`${gaps} فجوة زمنية تتجاوز 10 أيام (تعليق تداول أو عطلة ممتدة)`);
    if (zeroVol > candles.length * 0.2) issues.push(`${zeroVol} شمعة بحجم صفري (سيولة ضعيفة جداً)`);
    return { ok: issues.length === 0, issues, count: candles.length, zeroVolumeBars: zeroVol };
  }

  /** ينظّف الشموع: يزيل المكرّرات، يرتّب زمنياً، ويسقط الفاسدة. */
  function sanitizeCandles(raw) {
    if (!Array.isArray(raw)) return [];
    const byTime = new Map();
    for (const c of raw) {
      if (!c || !isNum(c.time)) continue;
      const o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
      if (![o, h, l, cl].every(isNum)) continue;
      if (cl <= 0 || o <= 0 || h <= 0 || l <= 0) continue;
      /* نصحّح انعكاسات high/low الطفيفة بدل إسقاط الشمعة بالكامل —
         النسخة السابقة كانت تُسقطها، فتفقد جلسات حقيقية بلا إشعار */
      const high = Math.max(o, h, l, cl), low = Math.min(o, h, l, cl);
      byTime.set(c.time, { time: c.time, open: o, high, low, close: cl, volume: Math.max(0, +c.volume || 0) });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  /* ════════════════════════════════════════════════════════════════════ */

  return {
    version: '2.0.0',
    Stats, SaudiMarket, Cumulative,
    seededRandom, seedFromString,
    detectPivots, lastConfirmedPivot, dominantPivotCycle,
    periodogram, fisherGTest, fitSinusoid, spectral, projectCycleTurns,
    forecastARIMA,
    volumeProfile, valueBand, volatility, atr,
    timeWindows, timeConfluence, FIB_BARS, GANN_CALENDAR_DAYS,
    simulateTrade, summarize, backtestSpectral, BT_DEFAULTS,
    structuralLevels, executionPlan,
    auditCandles, sanitizeCandles,
    _internal: { num, clamp, round, isNum }
  };
});
