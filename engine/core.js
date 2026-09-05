/* ══════════════════════════════════════════════════════════════════════════
   KSAEngine — محرك التحليل الكمي لمنصة TADAWUL FILTERS PRO
   ──────────────────────────────────────────────────────────────────────────
   هذا الملف هو الطبقة الحسابية الوحيدة في المنصة. الواجهة (index.html) لا
   تحسب إحصاءً ولا دورةً ولا هدفاً بنفسها — تفوّض كل ذلك إلى هنا، ثم تعرض
   ما رجع كما هو. الفائدة: أي رقم يظهر للمستخدم له مصدر واحد قابل للاختبار.

   المبادئ الحاكمة (ومخالفتها عيب لا خيار):
   ① لا رقم ثقة مخترع. كل حكم يحمل قيمة احتمال أو حجم عينة أو كليهما.
   ② لا تسرّب زمني. أي دالة تُستعمل في اختبار تاريخي لا ترى إلا ما كان
      متاحاً في لحظتها؛ نقاط الارتكاز لا تُعتبر مؤكدة إلا بعد k جلسة تأكيد.
   ③ الوحدات مصرَّح بها. الجلسات (bars) والأيام التقويمية (days) لا تُخلطان،
      والتحويل بينهما يمرّ على تقويم تداول سعودي فعلي (أحد→خميس).
   ④ عند غياب الدليل تُقال الحقيقة: { ok:false, reason } — لا قيمة افتراضية
      تُمرَّر بصمت إلى واجهة تعرضها كأنها نتيجة قياس.

   لا اعتماديات خارجية. يعمل في المتصفح (window.KSAEngine) وفي Node
   (module.exports) للاختبارات.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KSAEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2.0.0';

  /* عدد جلسات التداول في السنة السعودية تقريباً (أحد→خميس ناقص العطل) */
  const SESSIONS_PER_YEAR = 246;

  /* ════════════════════════════════════════════════════════════════════
     0) أدوات عددية أساسية
     ════════════════════════════════════════════════════════════════════ */
  const isNum = v => typeof v === 'number' && isFinite(v);
  const r2 = v => (isNum(v) ? +v.toFixed(2) : null);
  const r3 = v => (isNum(v) ? +v.toFixed(3) : null);
  const r4 = v => (isNum(v) ? +v.toFixed(4) : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ════════════════════════════════════════════════════════════════════
     1) Stats — الإحصاء
     ──────────────────────────────────────────────────────────────────
     كل اختبار دلالة في المنصة يمرّ من هنا. لا تُستعمل أي «درجة ثقة»
     مشتقّة من عدّ الأدلة: العدّ مقياس توافق، والاحتمال شيء آخر.
     ════════════════════════════════════════════════════════════════════ */
  const Stats = {
    clean(a) { return (a || []).filter(isNum); },

    mean(a) {
      const x = Stats.clean(a);
      if (!x.length) return 0;
      let s = 0; for (const v of x) s += v;
      return s / x.length;
    },

    /** التباين بمقام (n−1) — تقدير غير متحيّز، وهو الصحيح لعيّنة لا لمجتمع. */
    variance(a) {
      const x = Stats.clean(a);
      if (x.length < 2) return 0;
      const m = Stats.mean(x);
      let s = 0; for (const v of x) s += (v - m) * (v - m);
      return s / (x.length - 1);
    },

    sd(a) { return Math.sqrt(Stats.variance(a)); },

    median(a) {
      const x = Stats.clean(a).slice().sort((p, q) => p - q);
      if (!x.length) return 0;
      const h = x.length >> 1;
      return x.length % 2 ? x[h] : (x[h - 1] + x[h]) / 2;
    },

    /** المئين بالاستيفاء الخطي (تعريف R type-7). */
    quantile(a, q) {
      const x = Stats.clean(a).slice().sort((p, r) => p - r);
      if (!x.length) return 0;
      if (x.length === 1) return x[0];
      const pos = clamp(q, 0, 1) * (x.length - 1);
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? x[lo] : x[lo] + (x[hi] - x[lo]) * (pos - lo);
    },

    /** المئين الذي تقع فيه v داخل a (0..1). */
    percentRank(a, v) {
      const x = Stats.clean(a);
      if (!x.length) return 0.5;
      let below = 0; for (const t of x) if (t < v) below++;
      return below / x.length;
    },

    /** انحدار خطي على الفهرس: y = slope·i + intercept، مع R². */
    linreg(y) {
      const a = Stats.clean(y), n = a.length;
      if (n < 2) return { slope: 0, intercept: n ? a[0] : 0, r2: 0, n };
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sx += i; sy += a[i]; sxy += i * a[i]; sxx += i * i; }
      const d = n * sxx - sx * sx;
      const slope = d === 0 ? 0 : (n * sxy - sx * sy) / d;
      const intercept = (sy - slope * sx) / n;
      let ssRes = 0, ssTot = 0; const my = sy / n;
      for (let i = 0; i < n; i++) {
        const f = slope * i + intercept;
        ssRes += (a[i] - f) * (a[i] - f);
        ssTot += (a[i] - my) * (a[i] - my);
      }
      return { slope, intercept, r2: ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1), n };
    },

    /** دالة التوزيع التراكمي المعياري — تقريب Abramowitz & Stegun 7.1.26. */
    normalCdf(z) {
      if (!isNum(z)) return 0.5;
      const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
      const t = 1 / (1 + 0.3275911 * x);
      const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
      return 0.5 * (1 + s * y);
    },

    /** اختبار z ثنائي الطرف. */
    twoSidedZ(z) { return clamp(2 * (1 - Stats.normalCdf(Math.abs(z))), 0, 1); },

    /** توزيع t بدرجتي حرية df — عبر تقريب متسلسل لدالة بيتا الناقصة. */
    tCdf(t, df) {
      if (!isNum(t) || !isNum(df) || df <= 0) return 0.5;
      const x = df / (df + t * t);
      const ib = Stats._incBeta(x, df / 2, 0.5);
      const p = 0.5 * ib;
      return t > 0 ? 1 - p : p;
    },

    twoSidedT(t, df) { return clamp(2 * (1 - Stats.tCdf(Math.abs(t), df)), 0, 1); },

    _lnGamma(z) {
      const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      let x = z, y = z, tmp = x + 5.5;
      tmp -= (x + 0.5) * Math.log(tmp);
      let ser = 1.000000000190015;
      for (let j = 0; j < 6; j++) ser += g[j] / ++y;
      return -tmp + Math.log(2.5066282746310005 * ser / x);
    },

    /** الكسر المستمر لدالة بيتا الناقصة (خوارزمية Lentz المعدَّلة). */
    _betacf(a, b, x) {
      const FPMIN = 1e-300, EPS = 3e-14, MAXIT = 300;
      const qab = a + b, qap = a + 1, qam = a - 1;
      let c = 1, d = 1 - qab * x / qap;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      d = 1 / d;
      let h = d;
      for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c; h *= del;
        if (Math.abs(del - 1) < EPS) break;
      }
      return h;
    },

    /** دالة بيتا الناقصة المنظَّمة I_x(a,b) — أساس توزيعي t و F. */
    _incBeta(x, a, b) {
      if (!(x > 0)) return 0;
      if (x >= 1) return 1;
      const lbt = Stats._lnGamma(a + b) - Stats._lnGamma(a) - Stats._lnGamma(b)
        + a * Math.log(x) + b * Math.log(1 - x);
      const bt = Math.exp(lbt);
      if (x < (a + 1) / (a + b + 2)) return clamp(bt * Stats._betacf(a, b, x) / a, 0, 1);
      return clamp(1 - bt * Stats._betacf(b, a, 1 - x) / b, 0, 1);
    },

    /** لوغاريتم معامل التوافيق — يمنع الفيض عند m كبيرة في اختبار فيشر. */
    lnChoose(n, k) {
      if (k < 0 || k > n) return -Infinity;
      return Stats._lnGamma(n + 1) - Stats._lnGamma(k + 1) - Stats._lnGamma(n - k + 1);
    },

    /** فاصل Wilson لنسبة — أمتن من فاصل Wald عند العينات الصغيرة أو
     *  النسب القريبة من 0/1، حيث يعطي Wald حدوداً خارج [0,1]. */
    wilsonCI(successes, n, z) {
      z = z || 1.959963985;
      if (!n) return [0, 0];
      const p = successes / n, z2 = z * z;
      const den = 1 + z2 / n;
      const centre = (p + z2 / (2 * n)) / den;
      const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
      return [clamp(centre - half, 0, 1), clamp(centre + half, 0, 1)];
    },

    /** اختبار نسبتين مستقلتين (تقريب طبيعي بنسبة مجمّعة). */
    twoProportionP(x1, n1, x2, n2) {
      if (!n1 || !n2) return 1;
      const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
      const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
      if (!se) return 1;
      return Stats.twoSidedZ((p1 - p2) / se);
    },

    /** اختبار ذيل أيمن ذو حدّين: P(X ≥ k) عند n محاولة واحتمال p. */
    binomTailP(k, n, p) {
      if (!n) return 1;
      if (k <= 0) return 1;
      let sum = 0;
      for (let i = k; i <= n; i++) {
        sum += Math.exp(Stats.lnChoose(n, i) + i * Math.log(p || 1e-12) + (n - i) * Math.log(1 - p || 1e-12));
      }
      return clamp(sum, 0, 1);
    },

    /** تصحيح Benjamini–Hochberg للاختبارات المتعددة عند معدّل اكتشاف زائف q.
     *  يُرجع مصفوفة منطقية بترتيب المدخلات نفسه. */
    benjaminiHochberg(pvals, q) {
      q = q == null ? 0.10 : q;
      const n = (pvals || []).length;
      const out = new Array(n).fill(false);
      if (!n) return out;
      const idx = pvals.map((p, i) => ({ p: isNum(p) ? p : 1, i }))
        .sort((a, b) => a.p - b.p);
      let kMax = -1;
      for (let r = 0; r < n; r++) if (idx[r].p <= ((r + 1) / n) * q) kMax = r;
      for (let r = 0; r <= kMax; r++) out[idx[r].i] = true;
      return out;
    },

    /** صياغة قيمة الاحتمال للعرض — لا تُكتب 0 أبداً. */
    pText(p) {
      if (!isNum(p)) return '—';
      if (p < 0.0001) return '< 0.0001';
      if (p < 0.001) return p.toFixed(5);
      if (p < 0.01) return p.toFixed(4);
      return p.toFixed(3);
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     2) SaudiMarket — تقويم السوق وحدوده
     ──────────────────────────────────────────────────────────────────
     السوق السعودي يعمل الأحد→الخميس. الجمعة والسبت عطلة. خلط اليوم
     التقويمي بالجلسة كان يُنتج «نوافذ حرجة» في أيام لا يفتح فيها السوق.
     ════════════════════════════════════════════════════════════════════ */
  const SaudiMarket = {
    /* getDay(): 0=أحد … 4=خميس، 5=جمعة، 6=سبت */
    WEEKEND: [5, 6],
    DAILY_LIMIT_PCT: 10,

    isTradingDay(d) { return SaudiMarket.WEEKEND.indexOf(d.getDay()) === -1; },

    /** يضيف n جلسة تداول (لا أيام تقويمية) إلى تاريخ. n سالبة تعود للخلف. */
    addTradingDays(date, n) {
      const d = new Date(date.getTime());
      let left = Math.round(n || 0);
      if (left === 0) {
        while (!SaudiMarket.isTradingDay(d)) d.setDate(d.getDate() + 1);
        return d;
      }
      const step = left > 0 ? 1 : -1;
      left = Math.abs(left);
      let guard = 0;
      while (left > 0 && guard++ < 20000) {
        d.setDate(d.getDate() + step);
        if (SaudiMarket.isTradingDay(d)) left--;
      }
      return d;
    },

    /** يزيح تاريخاً تقويمياً إلى أول جلسة تداول عنده أو بعده. */
    nextTradingDay(date) {
      const d = new Date(date.getTime());
      let guard = 0;
      while (!SaudiMarket.isTradingDay(d) && guard++ < 30) d.setDate(d.getDate() + 1);
      return d;
    },

    /** عدد جلسات التداول بين تاريخين (تقدير تقويمي، بلا عطل رسمية). */
    tradingDaysBetween(a, b) {
      let d = new Date(a.getTime()), n = 0, guard = 0;
      const end = new Date(b.getTime());
      while (d < end && guard++ < 20000) {
        d.setDate(d.getDate() + 1);
        if (SaudiMarket.isTradingDay(d)) n++;
      }
      return n;
    },

    /** حدّ التذبذب اليومي في السوق الرئيسية ±10٪. */
    dailyLimits(price, pct) {
      const p = pct == null ? SaudiMarket.DAILY_LIMIT_PCT : pct;
      return {
        limitPct: p,
        up: r2(price * (1 + p / 100)),
        down: r2(price * (1 - p / 100))
      };
    },

    /** أقل عدد جلسات ممكن نظرياً للانتقال من سعر إلى آخر تحت حدّ التذبذب.
     *  يمنع عرض هدف يتطلب قفزة مستحيلة في الأفق المذكور. */
    minSessionsBetween(from, to, pct) {
      const p = (pct == null ? SaudiMarket.DAILY_LIMIT_PCT : pct) / 100;
      if (!isNum(from) || !isNum(to) || from <= 0 || to <= 0) return null;
      if (from === to) return 0;
      const ratio = to / from;
      const step = ratio > 1 ? Math.log(1 + p) : Math.log(1 - p);
      const n = Math.log(ratio) / step;
      return n > 0 ? Math.max(1, Math.ceil(n)) : null;
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     3) الشموع — تنظيف وتدقيق
     ──────────────────────────────────────────────────────────────────
     مصدر البيانات يقرّب الأسعار لخانتين، فينتج أحياناً high أقل من
     max(open,close) بمقدار هللة واحدة في جلسة حقيقية تماماً. النسخة
     السابقة كانت تحذف هذه الشموع بصمت، وإذا نزل العدد تحت الحد يُرفض
     النطاق كله ويبقى السهم على بيانات عشوائية. هنا تُصلَح الانعكاسات
     الطفيفة بدل حذفها، ويُصرَّح بما أُصلح في auditCandles.
     ════════════════════════════════════════════════════════════════════ */

  /* حد التسامح مع انعكاس OHLC: نصف هللة نسبةً إلى السعر. */
  const OHLC_TOL = 0.0015;

  function sanitizeCandles(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Map();
    for (const c of raw) {
      if (!c) continue;
      const o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
      const t = +c.time;
      if (!isNum(o) || !isNum(h) || !isNum(l) || !isNum(cl) || !isNum(t)) continue;
      if (o <= 0 || h <= 0 || l <= 0 || cl <= 0) continue;
      const v = isNum(+c.volume) && +c.volume >= 0 ? +c.volume : 0;

      const hiWant = Math.max(o, cl, h), loWant = Math.min(o, cl, l);
      /* انعكاس فاحش (أكثر من نصف بالمئة) ليس تقريباً — تُسقط الشمعة */
      const span = Math.max(1e-9, hiWant);
      if ((hiWant - h) / span > OHLC_TOL || (l - loWant) / span > OHLC_TOL) continue;

      /* آخر قيمة لنفس الطابع الزمني تفوز (تحديثات داخل الجلسة) */
      seen.set(t, { time: t, open: o, high: hiWant, low: loWant, close: cl, volume: v });
    }
    return Array.from(seen.values()).sort((a, b) => a.time - b.time);
  }

  /** تدقيق جودة البيانات — يُعرض للمستخدم قبل أي تقرير مبني عليها. */
  function auditCandles(cs) {
    const issues = [];
    if (!Array.isArray(cs) || !cs.length) return { ok: false, issues: ['لا توجد شموع'], count: 0 };
    const n = cs.length;

    let zeroVol = 0, flat = 0, dupTime = 0, badOrder = 0;
    const gaps = [];
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      if (!c.volume) zeroVol++;
      if (c.high === c.low) flat++;
      if (i > 0) {
        if (cs[i].time === cs[i - 1].time) dupTime++;
        if (cs[i].time < cs[i - 1].time) badOrder++;
        const days = Math.round((cs[i].time - cs[i - 1].time) / 86400);
        if (days > 5) gaps.push({ at: i, days });
      }
    }

    /* قفزة سعرية تتجاوز حدّ التذبذب اليومي مرتين = غالباً تجزئة سهم أو
       توزيع رأسمالي لم يُعدَّل، وهو ما يفسد كل حساب دورة أو عائد. */
    let splitSuspect = 0;
    for (let i = 1; i < n; i++) {
      const ch = Math.abs(cs[i].close / cs[i - 1].close - 1);
      if (ch > 0.25) splitSuspect++;
    }

    if (dupTime) issues.push(`${dupTime} شمعة مكرّرة الطابع الزمني`);
    if (badOrder) issues.push(`${badOrder} شمعة خارج الترتيب الزمني`);
    if (gaps.length) issues.push(`${gaps.length} فجوة زمنية تتجاوز 5 أيام (أطولها ${Math.max.apply(null, gaps.map(g => g.days))} يوماً) — تؤثر على الدورات التقويمية`);
    if (zeroVol > n * 0.1) issues.push(`${zeroVol} جلسة بحجم صفر (${(zeroVol / n * 100).toFixed(0)}٪) — سيولة ضعيفة أو تعليق تداول`);
    if (flat > n * 0.1) issues.push(`${flat} جلسة بلا مدى سعري (high = low)`);
    if (splitSuspect) issues.push(`${splitSuspect} قفزة تتجاوز 25٪ — يُحتمل تجزئة سهم غير معدَّلة`);
    if (n < 80) issues.push(`العينة ${n} جلسة فقط — أقصر مما تتطلبه الدورات الطويلة`);

    return { ok: issues.length === 0, issues, count: n, gaps, zeroVolume: zeroVol };
  }

  /* ════════════════════════════════════════════════════════════════════
     4) المدى والتذبذب
     ════════════════════════════════════════════════════════════════════ */

  /** ATR بطريقة Wilder (تنعيم أسّي بمعامل 1/p) لا بمتوسط بسيط. */
  function atr(cs, p) {
    p = p || 14;
    if (!cs || cs.length < p + 1) return null;
    const tr = [];
    for (let i = 1; i < cs.length; i++) {
      tr.push(Math.max(
        cs[i].high - cs[i].low,
        Math.abs(cs[i].high - cs[i - 1].close),
        Math.abs(cs[i].low - cs[i - 1].close)
      ));
    }
    let a = 0;
    for (let i = 0; i < p; i++) a += tr[i];
    a /= p;
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return r3(a);
  }

  /** سلسلة ATR كاملة — يحتاجها الاختبار التاريخي بلا تسرّب زمني. */
  function atrSeries(cs, p) {
    p = p || 14;
    const out = new Array(cs.length).fill(null);
    if (!cs || cs.length < p + 1) return out;
    const tr = [0];
    for (let i = 1; i < cs.length; i++) {
      tr.push(Math.max(
        cs[i].high - cs[i].low,
        Math.abs(cs[i].high - cs[i - 1].close),
        Math.abs(cs[i].low - cs[i - 1].close)
      ));
    }
    let a = 0;
    for (let i = 1; i <= p; i++) a += tr[i];
    a /= p; out[p] = a;
    for (let i = p + 1; i < cs.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
    return out;
  }

  /**
   * التذبذب من العوائد اللوغاريتمية:
   *   • يُطرح المتوسط (النسخة السابقة لم تطرحه)،
   *   • المقام n−1 لا n،
   *   • ويُسنَّن سنوياً بجذر عدد جلسات السنة السعودية.
   */
  function volatility(prices) {
    const p = Stats.clean(prices);
    if (p.length < 21) return { ok: false, reason: `عيّنة ${p.length} سعر — مطلوب 21 على الأقل`, dailyPct: null, annualPct: null };
    const r = [];
    for (let i = 1; i < p.length; i++) {
      if (p[i] > 0 && p[i - 1] > 0) r.push(Math.log(p[i] / p[i - 1]));
    }
    if (r.length < 20) return { ok: false, reason: 'عوائد غير كافية', dailyPct: null, annualPct: null };
    const sd = Stats.sd(r);
    return {
      ok: true,
      sigma: sd,
      dailyPct: r4(sd * 100),
      annualPct: r2(sd * Math.sqrt(SESSIONS_PER_YEAR) * 100),
      /* المدى اليومي المتوقع بثقة 95٪ — ±1.96σ، لا σ وحدها */
      expectedDailyRangePct: r2(1.959963985 * sd * 100),
      sampleSize: r.length
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     5) نقاط الارتكاز — بمنع تسرّب زمني صريح
     ──────────────────────────────────────────────────────────────────
     ارتكاز عند i لا يُعتبر معروفاً إلا بعد إغلاق k جلسة بعده. الحقل
     confirmedAt هو أول فهرس كان فيه هذا الارتكاز قابلاً للاستعمال؛
     الاختبار التاريخي لا يستعمل ارتكازاً قبل confirmedAt إطلاقاً.
     ════════════════════════════════════════════════════════════════════ */
  function detectPivots(cs, k) {
    k = k || 3;
    const out = [];
    if (!cs || cs.length < 2 * k + 1) return out;
    for (let i = k; i < cs.length - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (cs[j].high >= cs[i].high) isH = false;
        if (cs[j].low <= cs[i].low) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) out.push({ i, price: r2(cs[i].high), p: r2(cs[i].high), type: 'H', time: cs[i].time, confirmedAt: i + k });
      if (isL) out.push({ i, price: r2(cs[i].low), p: r2(cs[i].low), type: 'L', time: cs[i].time, confirmedAt: i + k });
    }
    return out.sort((a, b) => a.i - b.i);
  }

  /** آخر ارتكاز مؤكَّد حتى الفهرس endIdx (افتراضياً آخر شمعة). */
  function lastConfirmedPivot(cs, k, endIdx) {
    k = k || 3;
    const end = endIdx == null ? cs.length - 1 : endIdx;
    const piv = detectPivots(cs.slice(0, end + 1), k).filter(p => p.confirmedAt <= end);
    return piv.length ? piv[piv.length - 1] : null;
  }

  /**
   * الدورة الذاتية للسهم = وسيط المسافة بين ارتكازات متجانسة النوع.
   * `reliable` ليست رأياً: هي شرط على معامل الاختلاف (تشتّت/وسيط) وعلى
   * حجم العيّنة. تباعد متفاوت ليس دورة — هو ضجيج.
   */
  function dominantPivotCycle(cs, k) {
    const piv = detectPivots(cs, k || 3);
    if (piv.length < 4) return null;
    const gaps = [];
    for (const type of ['H', 'L']) {
      const s = piv.filter(p => p.type === type);
      for (let i = 1; i < s.length; i++) gaps.push(s[i].i - s[i - 1].i);
    }
    const g = gaps.filter(x => x >= 3);
    if (g.length < 3) return null;
    const med = Stats.median(g), sd = Stats.sd(g);
    const cv = med > 0 ? sd / med : 9;
    return {
      cycle: Math.round(med),
      sampleSize: g.length,
      sdBars: r2(sd),
      cv: r2(cv),
      /* معامل اختلاف ≤ 0.35 على 5 مسافات فأكثر — عتبة معلنة لا مخفية */
      consistencyPct: r2(clamp(100 * (1 - cv), 0, 100)),
      reliable: g.length >= 5 && cv <= 0.35
    };
  }

  /**
   * المستويات البنيوية: ارتكازات مؤكدة في الجهة الصحيحة من السعر فقط.
   * كان الخلل السابق أن «الدعم» يُؤخذ من أعلى قاع تاريخي أياً كان موقعه من
   * السعر، فينتج وقف فوق الدخول وهدف تحته — خطة مقلوبة تماماً.
   */
  function structuralLevels(cs, price, opt) {
    opt = opt || {};
    const k = opt.k || 3;
    const tolPct = opt.tolPct == null ? 0.4 : opt.tolPct;   /* دمج المستويات المتقاربة */
    const piv = detectPivots(cs, k);
    const above = [], below = [];
    for (const p of piv) {
      if (p.type === 'H' && p.price > price) above.push(p.price);
      if (p.type === 'L' && p.price < price) below.push(p.price);
    }
    /* المقاومة الحقيقية قمة لم يُغلق فوقها بعد؛ والدعم قاع لم يُغلق تحته */
    const cluster = (arr, asc) => {
      const s = arr.slice().sort((a, b) => asc ? a - b : b - a);
      const out = [];
      for (const v of s) {
        if (!out.length || Math.abs(v - out[out.length - 1]) / price * 100 > tolPct) out.push(v);
      }
      return out;
    };
    return {
      resistances: cluster(above, true),
      supports: cluster(below, false),
      price: r2(price),
      pivotCount: piv.length
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     6) أهداف الفراكتال — هدف من البنية لا من مضاعف
     ──────────────────────────────────────────────────────────────────
     «هدف = دخول + 2×المخاطرة» حشو تعريفي: النسبة 2 لأننا كتبنا 2. الهدف
     هنا مستوى فعلي ينتظر عنده أمر بيع: قمة فراكتالية لم يُغلق فوقها بعد.
     ════════════════════════════════════════════════════════════════════ */
  function fractalTargets(cs, opt) {
    const k = (opt && opt.k) || 2;
    if (!cs || cs.length < k * 2 + 10) return { ok: false, reason: 'شموع غير كافية' };
    const n = cs.length, price = r2(cs[n - 1].close);
    const His = [], Los = [];
    for (let i = k; i < n - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (cs[j].high >= cs[i].high) isH = false;
        if (cs[j].low <= cs[i].low) isL = false;
      }
      if (isH) His.push({ i, p: r2(cs[i].high) });
      if (isL) Los.push({ i, p: r2(cs[i].low) });
    }
    /* «حيّة» = لم تُكسر بإغلاق بعد تكوّنها */
    const liveHi = His.filter(f => {
      for (let j = f.i + k + 1; j < n; j++) if (cs[j].close > f.p) return false;
      return f.p > price;
    }).sort((a, b) => a.p - b.p);
    const liveLo = Los.filter(f => {
      for (let j = f.i + k + 1; j < n; j++) if (cs[j].close < f.p) return false;
      return f.p < price;
    }).sort((a, b) => b.p - a.p);

    const target1 = liveHi[0] ? liveHi[0].p : null;
    const target2 = liveHi[1] ? liveHi[1].p : null;
    const support = liveLo[0] ? liveLo[0].p : null;

    /* الحركة المقيسة تُعاد كمستوى سعري جاهز، لا كمسافة تُجمع — الخلط بين
       الاثنين كان يضاعف الأهداف. */
    let measuredMove = null;
    if (liveLo.length && His.length) {
      const baseLow = liveLo[0];
      const legHigh = His.filter(h => h.i > baseLow.i).sort((a, b) => b.p - a.p)[0] || His[His.length - 1];
      if (legHigh && legHigh.p > baseLow.p) measuredMove = r2(baseLow.p + (legHigh.p - baseLow.p) * 2);
    }
    const supportPct = support ? r2((price - support) / price * 100) : null;
    const t1Pct = target1 ? r2((target1 - price) / price * 100) : null;

    return {
      ok: true, price, target1, target2, support, supportPct, t1Pct,
      target: target1, targetSource: 'أقرب قمة فراكتالية غير مكسورة',
      measuredMove, highCount: liveHi.length, lowCount: liveLo.length,
      /* مدرج إقلاع نظيف = مسافة 3٪ فأكثر قبل أول عائق */
      cleanRunway: t1Pct == null ? true : t1Pct >= 3,
      levelsUp: liveHi.slice(0, 4), levelsDown: liveLo.slice(0, 4),
      engine: 'core'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     7) ملف الحجم — POC بالتعريف الصحيح
     ──────────────────────────────────────────────────────────────────
     POC ليس «إغلاق الشمعة الأعلى حجماً»، بل مستوى السعر الذي تداول عنده
     أكبر حجم تراكمي عبر الفترة. يُحسب بتوزيع حجم كل شمعة على شرائح السعر
     التي غطّاها مداها. الفرق ليس أكاديمياً: 40 جلسة حول 10 ريال وجلسة
     ضخمة عند 20 تعطي بالتعريف القديم POC = 20 (سعر تداول يوماً واحداً).
     ════════════════════════════════════════════════════════════════════ */
  function volumeProfile(cs, opt) {
    opt = opt || {};
    const bins = opt.bins || 60;
    if (!cs || cs.length < 5) return null;
    let lo = Infinity, hi = -Infinity;
    for (const c of cs) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
    if (!isNum(lo) || !isNum(hi) || hi <= lo) return null;
    const w = (hi - lo) / bins;
    const hist = new Array(bins).fill(0);

    for (const c of cs) {
      const v = c.volume || 0;
      if (v <= 0) continue;
      const a = Math.max(0, Math.min(bins - 1, Math.floor((c.low - lo) / w)));
      const b = Math.max(0, Math.min(bins - 1, Math.floor((c.high - lo) / w)));
      const span = b - a + 1;
      /* توزيع منتظم للحجم على الشرائح التي غطّاها مدى الشمعة */
      for (let i = a; i <= b; i++) hist[i] += v / span;
    }

    let total = 0, pocIdx = 0;
    for (let i = 0; i < bins; i++) { total += hist[i]; if (hist[i] > hist[pocIdx]) pocIdx = i; }
    if (total <= 0) return null;

    /* منطقة القيمة: توسّع من الـPOC للجهة الأكثر حجماً حتى بلوغ 70٪ */
    let acc = hist[pocIdx], loI = pocIdx, hiI = pocIdx;
    const targetVol = total * 0.70;
    while (acc < targetVol && (loI > 0 || hiI < bins - 1)) {
      const dn = loI > 0 ? hist[loI - 1] : -1;
      const up = hiI < bins - 1 ? hist[hiI + 1] : -1;
      if (up >= dn) { hiI++; acc += hist[hiI]; } else { loI--; acc += hist[loI]; }
    }
    const mid = i => lo + w * (i + 0.5);
    return {
      poc: r2(mid(pocIdx)),
      valueAreaLow: r2(lo + w * loI),
      valueAreaHigh: r2(lo + w * (hiI + 1)),
      valueAreaPct: r2(acc / total * 100),
      binWidth: r4(w),
      bins, low: r2(lo), high: r2(hi),
      histogram: hist
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     8) Cumulative — المؤشرات التراكمية
     ──────────────────────────────────────────────────────────────────
     VWAP تراكمي من أول شمعة في النطاق المحمّل ليس VWAP: إنه متوسط بطيء
     لكامل الفترة. VWAP يحتاج نقطة تثبيت — جلسة، أو ارتكاز مؤكد.
     ════════════════════════════════════════════════════════════════════ */
  const Cumulative = {
    /** VWAP متدحرج على نافذة — يجيب عن سؤال ذي معنى بلا نقطة تثبيت. */
    rollingVWAP(cs, win) {
      win = win || 20;
      const out = new Array(cs.length).fill(null);
      let pv = 0, vv = 0;
      const q = [];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], tp = (c.high + c.low + c.close) / 3, v = c.volume || 0;
        q.push({ tp, v }); pv += tp * v; vv += v;
        if (q.length > win) { const o = q.shift(); pv -= o.tp * o.v; vv -= o.v; }
        if (q.length === win) out[i] = vv > 0 ? pv / vv : c.close;
      }
      return out;
    },

    /** VWAP مثبّت على فهرس ارتكاز — «هل من اشترى منذ الانعكاس في ربح؟» */
    anchoredVWAP(cs, anchorIdx) {
      const out = new Array(cs.length).fill(null);
      const a = clamp(anchorIdx | 0, 0, cs.length - 1);
      let pv = 0, vv = 0;
      for (let i = a; i < cs.length; i++) {
        const c = cs[i], tp = (c.high + c.low + c.close) / 3, v = c.volume || 0;
        pv += tp * v; vv += v;
        out[i] = vv > 0 ? pv / vv : c.close;
      }
      /* قبل نقطة التثبيت لا يوجد VWAP مثبّت — تُملأ بالإغلاق لا بالصفر */
      for (let i = 0; i < a; i++) out[i] = cs[i].close;
      return out;
    },

    /** On-Balance Volume. */
    obv(cs) {
      const out = [0];
      for (let i = 1; i < cs.length; i++) {
        const v = cs[i].volume || 0;
        out.push(out[i - 1] + (cs[i].close > cs[i - 1].close ? v : cs[i].close < cs[i - 1].close ? -v : 0));
      }
      return out;
    },

    /**
     * خط التجميع/التوزيع — يزن الحجم بموقع الإغلاق داخل مدى الجلسة،
     * فيميّز «حجم عالٍ بإغلاق ضعيف» عن «حجم عالٍ بإغلاق قوي». وهو تمييز
     * يعجز عنه OBV لاعتماده على إشارة التغيّر وحدها.
     */
    adLine(cs) {
      const out = []; let acc = 0;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], range = c.high - c.low;
        const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0;
        acc += mfm * (c.volume || 0);
        out.push(acc);
      }
      return out;
    },

    /**
     * تباعد بين السعر ومؤشر تراكمي على نافذة — بمقارنة ميلين مُطبّعين.
     * التطبيع ضروري: ميل OBV بالأسهم وميل السعر بالريالات، ومقارنتهما
     * خاماً تقارن وحدتين مختلفتين.
     */
    divergence(cs, series, win) {
      win = Math.min(win || 20, cs.length - 1, series.length - 1);
      if (win < 5) return { type: null, why: 'نافذة قصيرة جداً لقياس التباعد' };
      const pseg = cs.slice(-win).map(c => c.close);
      const sseg = series.slice(-win);
      const pR = Stats.linreg(pseg), sR = Stats.linreg(sseg);
      const pNorm = pseg[pseg.length - 1] ? pR.slope / Math.abs(pseg[pseg.length - 1]) * 100 : 0;
      const scale = Math.max(1e-9, Stats.median(sseg.map(Math.abs)) || Stats.sd(sseg) || 1);
      const sNorm = sR.slope / scale * 100;
      const EPS = 0.02;   /* عتبة «مسطّح» — تحت هذا لا ميل يُعتدّ به */
      if (pNorm < -EPS && sNorm > EPS)
        return { type: 'bullish', why: `السعر ينزل (${pNorm.toFixed(2)}٪/جلسة) بينما المؤشر التراكمي يصعد — تجميع تحت ضغط سعري` };
      if (pNorm > EPS && sNorm < -EPS)
        return { type: 'bearish', why: `السعر يصعد (${pNorm.toFixed(2)}٪/جلسة) بينما المؤشر التراكمي ينزل — توزيع خلف ارتفاع` };
      return { type: null, why: `لا تباعد على آخر ${win} جلسة (ميل السعر ${pNorm.toFixed(2)}٪ والمؤشر ${sNorm.toFixed(2)} بنفس الاتجاه)` };
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     9) التحليل الطيفي — Fisher's g-test
     ──────────────────────────────────────────────────────────────────
     ثلاثة عيوب كانت في النسخة السابقة، وكلها مُصلَحة هنا:

     (1) اختبار الدلالة كان z-score على طاقات الطيف نفسه. تشغيله على مسارات
         مشي عشوائي محض يصنّف الأغلبية الساحقة «دالة إحصائياً» — أي أن
         العلامة الخضراء لم تكن تعني شيئاً. البديل: اختبار Fisher's g، وهو
         الاختبار المضبوط لأكبر ذرة في الطيف الدوري تحت فرضية الضجيج
         الأبيض الغاوسي، بقيمة احتمال حقيقية.

     (2) المسح كان على أطوال دورات صحيحة 5..60، وهي شبكة غير منتظمة في
         التردد: 55 و56 تكادان تكونان نفس التردد بينما 5 و6 متباعدتان جداً.
         البديل: ترددات فورييه المنتظمة k/N، وهي أيضاً شرط استقلال الذرات
         الذي يقوم عليه اختبار فيشر أصلاً.

     (3) الإسقاط الأمامي عامل موجة *العوائد* كأنها موجة *السعر* — خطأ طور
         مقداره ربع دورة. الصحيح: الدلالة تُختبر على العوائد (وهي أقرب
         للاستقرارية)، والطور يُلائم على لوغاريتم السعر منزوع الاتجاه عند
         التردد نفسه. تردد الموجة واحد في السلسلتين، والطور وحده يختلف.
     ════════════════════════════════════════════════════════════════════ */

  /** طاقة الدورية عند تردد اعتباطي f (دورة/عيّنة) — أساس التنقية خارج الشبكة. */
  function _powerAt(x, f) {
    const N = x.length; let re = 0, im = 0;
    const w = 2 * Math.PI * f;
    for (let t = 0; t < N; t++) { const a = w * t; re += x[t] * Math.cos(a); im -= x[t] * Math.sin(a); }
    return (re * re + im * im) / N;
  }

  /**
   * الدورية عند ترددات فورييه k/N، مقصورةً على النطاق القابل للتداول.
   *
   * 🛠️ لماذا نقصر النطاق: بلا قيد يمتدّ المسح حتى تردد نايكويست (دورة
   * جلستين). قياسنا على بيانات حقيقية أعطى «الدورة المهيمنة: 2.2 جلسة»
   * تُعرض للمستخدم كنافذة توقيت. دورة بطول جلستين أو ثلاث ليست دورة سوقية
   * بل بنية الضجيج اليومي نفسه (ارتداد الفارق السعري)، ولا يمكن تداولها:
   * نافذة عدم اليقين حولها أوسع من الدورة كلها.
   * والحدّ الأعلى N/3 لأن دورة لم تكتمل ثلاث مرات داخل العيّنة لا يمكن
   * تمييزها عن الاتجاه — وهي أصلاً مطروحة مع الاتجاه الخطي.
   *
   * القصر مشروع إحصائياً: اختبار فيشر يبقى مضبوطاً على أي مجموعة جزئية من
   * ذرات فورييه المستقلة، بشرط أن يكون m عدد الذرات المفحوصة فعلاً — وهو
   * ما تفعله هذه الدالة. (ولهذا تسمّي الواجهة النسبة «من طاقة النطاق
   * المفحوص» لا «من الطاقة الكلية».)
   */
  function _periodogram(x, minPeriod, maxPeriod) {
    const N = x.length;
    const kMax = Math.min(Math.floor((N - 1) / 2), Math.floor(N / Math.max(2, minPeriod)));
    const kMin = Math.max(1, Math.ceil(N / Math.max(minPeriod + 1, maxPeriod)));
    const I = [], freqs = [], ks = [];
    for (let k = kMin; k <= kMax; k++) {
      const f = k / N;
      I.push(_powerAt(x, f)); freqs.push(f); ks.push(k);
    }
    return { I, freqs, ks, m: I.length, N, kMin, kMax };
  }

  /**
   * قيمة احتمال Fisher's g الدقيقة:
   *   P(g ≥ gObs) = Σ_{j=1}^{J} (−1)^(j−1) C(m,j) (1 − j·g)^(m−1)
   * تُحسب في فضاء اللوغاريتم لأن C(m,j) يفيض عند m كبيرة.
   */
  function _fisherG_p(g, m) {
    if (!isNum(g) || g <= 0) return 1;
    if (g >= 1) return 0;
    const J = Math.min(m, Math.floor(1 / g));
    let p = 0;
    for (let j = 1; j <= J; j++) {
      const base = 1 - j * g;
      if (base <= 0) break;
      const lnTerm = Stats.lnChoose(m, j) + (m - 1) * Math.log(base);
      const term = Math.exp(lnTerm);
      if (!isFinite(term)) break;
      p += (j % 2 === 1 ? term : -term);
      if (term < 1e-18 && j > 2) break;
    }
    return clamp(p, 0, 1);
  }

  /** يزيل الاتجاه الخطي ويعيد {y, r2}. */
  function _detrend(series) {
    const reg = Stats.linreg(series);
    const y = series.map((v, i) => v - (reg.slope * i + reg.intercept));
    return { y, r2: reg.r2, slope: reg.slope };
  }

  /** ملاءمة جيبية بالمربعات الصغرى عند تردد معلوم: y ≈ a·cos(ωt) + b·sin(ωt). */
  function _fitSinusoid(y, f) {
    const N = y.length, w = 2 * Math.PI * f;
    let scc = 0, sss = 0, scs = 0, syc = 0, sys = 0;
    for (let t = 0; t < N; t++) {
      const c = Math.cos(w * t), s = Math.sin(w * t);
      scc += c * c; sss += s * s; scs += c * s; syc += y[t] * c; sys += y[t] * s;
    }
    const det = scc * sss - scs * scs;
    let a, b;
    if (Math.abs(det) < 1e-12) { a = 2 * syc / N; b = 2 * sys / N; }
    else { a = (syc * sss - sys * scs) / det; b = (sys * scc - syc * scs) / det; }
    const amp = Math.hypot(a, b);
    /* y = A·cos(ωt + φ) حيث φ = −atan2(b, a). عند φ الطور صفر ⇒ قمة. */
    const phi = -Math.atan2(b, a);
    let ssRes = 0;
    for (let t = 0; t < N; t++) {
      const fit = a * Math.cos(w * t) + b * Math.sin(w * t);
      ssRes += (y[t] - fit) * (y[t] - fit);
    }
    const sigma = Math.sqrt(ssRes / Math.max(1, N - 3));
    return { a, b, amp, phi, sigma, N };
  }

  const TAU = 2 * Math.PI;
  const wrap = th => ((th % TAU) + TAU) % TAU;

  /**
   * @param {number[]} prices سلسلة أسعار الإغلاق
   * @param {{alpha?:number, refine?:boolean, minLen?:number}} opt
   */
  function spectral(prices, opt) {
    opt = opt || {};
    const alpha = opt.alpha == null ? 0.05 : opt.alpha;
    const refine = opt.refine !== false;
    const MIN = opt.minLen || 60;

    const p = Stats.clean(prices).filter(v => v > 0);
    if (p.length < MIN) return { ok: false, reason: `عيّنة ${p.length} جلسة — التحليل الطيفي يتطلب ${MIN}+` };

    /* ① الدلالة تُختبر على العوائد اللوغاريتمية (أقرب للاستقرارية) */
    const rets = [];
    for (let i = 1; i < p.length; i++) rets.push(Math.log(p[i] / p[i - 1]));
    const mr = Stats.mean(rets);
    const x = rets.map(v => v - mr);

    /* النطاق القابل للتداول: من 6 جلسات (أقصر دورة يمكن تنفيذها فعلاً)
       إلى ثلث العيّنة (أطول دورة تكرّرت ثلاث مرات على الأقل). */
    const minPeriod = opt.minPeriod == null ? 6 : opt.minPeriod;
    const maxPeriod = opt.maxPeriod == null ? Math.max(minPeriod + 2, Math.floor(x.length / 3)) : opt.maxPeriod;

    const pg = _periodogram(x, minPeriod, maxPeriod);
    if (pg.m < 8) return { ok: false, reason: `عدد ترددات فورييه داخل النطاق ${minPeriod}–${maxPeriod} جلسة غير كافٍ (${pg.m})` };

    let total = 0, peak = 0;
    for (let i = 0; i < pg.m; i++) { total += pg.I[i]; if (pg.I[i] > pg.I[peak]) peak = i; }
    if (total <= 0) return { ok: false, reason: 'طاقة طيفية صفرية — السلسلة ثابتة' };

    const g = pg.I[peak] / total;
    const pValue = _fisherG_p(g, pg.m);
    const significant = pValue < alpha;

    /* عدد الذرات الدالة (دورات متراكبة) — نفس اختبار فيشر مطبّقاً ذرّة ذرّة */
    let nCycles = 0;
    for (let i = 0; i < pg.m; i++) if (_fisherG_p(pg.I[i] / total, pg.m) < alpha) nCycles++;

    /* ② تنقية التردد خارج شبكة فورييه — بلاها ينجرف الطور تراكمياً */
    const fGrid = pg.freqs[peak];
    let fBest = fGrid;
    if (refine) {
      const step = 1 / pg.N;
      /* التنقية محصورة داخل النطاق المفحوص: خروجها منه يعيد تردداً لم
         يُختبر عليه فيشر، فتصبح قيمة الاحتمال المعروضة لتردد آخر. */
      const fLo = 1 / maxPeriod, fHi = 1 / minPeriod;
      let lo = Math.max(fLo, fGrid - step), hi = Math.min(fHi, fGrid + step);
      if (!(hi > lo)) { lo = fGrid; hi = fGrid; }
      /* بحث ذهبي على الطاقة المستمرة */
      const gr = (Math.sqrt(5) - 1) / 2;
      let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
      let fc = _powerAt(x, c), fd = _powerAt(x, d);
      for (let it = 0; it < 60 && (hi - lo) > 1e-9; it++) {
        if (fc > fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = _powerAt(x, c); }
        else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = _powerAt(x, d); }
      }
      fBest = (lo + hi) / 2;
      if (_powerAt(x, fBest) < _powerAt(x, fGrid)) fBest = fGrid;
    }
    const period = 1 / fBest;
    const gridErrorPct = r2(Math.abs(fBest - fGrid) / fGrid * 100);

    /* ③ الطور يُلائم على لوغاريتم السعر منزوع الاتجاه، على نافذة حديثة
       طولها أربع دورات (وبحد أدنى 60 جلسة) حتى يعبّر الطور عن الحاضر
       لا عن متوسط تاريخ طويل. */
    const logP = p.map(v => Math.log(v));
    const W = clamp(Math.round(Math.max(4 * period, 60)), 40, logP.length);
    const win = logP.slice(logP.length - W);
    const det = _detrend(win);
    const fit = _fitSinusoid(det.y, fBest);

    const thetaLast = wrap(TAU * fBest * (W - 1) + fit.phi);
    const cyclePosPct = r2(thetaLast / TAU * 100);
    const amplitudePct = r2(fit.amp * 100);
    const snr = fit.sigma > 0 ? r2((fit.amp / Math.SQRT2) / fit.sigma) : null;
    const bandSharePct = r2(g * 100);

    const order = pg.I.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v).slice(0, 5);
    const top = order.map(o => ({
      period: r2(1 / pg.freqs[o.i]),
      sharePct: r2(o.v / total * 100)
    }));

    const verdict = significant
      ? `ذروة طاقة عند دورة ${r2(period)} جلسة لا تفسّرها الصدفة (p = ${Stats.pText(pValue)}). الدورة صالحة لاشتقاق نافذة زمنية، بشرط تأكيد التماسك خارج العيّنة.`
      : `الطيف لا يختلف عن ضجيج عشوائي (p = ${Stats.pText(pValue)} عند عتبة ${alpha}). لا تُشتق نافذة زمنية من دورة غير دالة: رسم موجة جيبية على ضجيج ينتج تواريخ دقيقة المظهر بلا أساس.`;

    return {
      ok: true,
      significant,
      pValue: r4(pValue), pValueText: Stats.pText(pValue),
      gStatistic: r4(g),
      freq: r4(fBest),
      period: r2(period),
      periodBars: Math.round(period),
      phase: r4(thetaLast),
      cyclePosPct,
      amplitudePct,
      bandSharePct,
      snr,
      nCycles,
      gridErrorPct,
      trendR2: r3(det.r2),
      alpha,
      sampleSize: p.length,
      m: pg.m,
      scannedBand: { minPeriod, maxPeriod: Math.round(maxPeriod) },
      top,
      verdict,
      /* ما تحتاجه دوال الإسقاط: الدورة الدالة بمعاملاتها الكاملة */
      cycles: significant ? [{
        freq: fBest, period, amp: fit.amp, phase: thetaLast,
        sigma: fit.sigma, N: W, snr
      }] : []
    };
  }

  /* spectralPro هو نفسه مع التنقية خارج الشبكة مفعّلة صراحةً. */
  function spectralPro(prices, opt) {
    return spectral(prices, Object.assign({ refine: true }, opt || {}));
  }

  /* ════════════════════════════════════════════════════════════════════
     10) إسقاط الانعطافات — بعدم يقين معلن
     ──────────────────────────────────────────────────────────────────
     عرض تاريخ واحد بلا نطاق ادّعاء دقة غير موجودة: انعطاف بعد 5 جلسات
     أدقّ بكثير من انعطاف بعد 50، وعرضهما بنفس الثقة تضليل.

     النطاق مشتقّ من حدّ كرامر-راو الأدنى لمقدّري التردد والطور لموجة
     جيبية في ضجيج أبيض (Rife & Boorstyn):
        var(ω̂) ≥ 12σ² / (A²·N·(N²−1))
        var(φ̂) ≥ 2σ²(2N−1) / (A²·N·(N+1))
     وخطأ توقيت انعطاف يبعد h جلسة:  sd_θ(h) = √(var(φ̂) + h²·var(ω̂))
     ثم يُحوَّل إلى جلسات بالقسمة على ω. لذلك يتّسع النطاق كلما بَعُد
     الأفق — لأنه كذلك فعلاً.
     ════════════════════════════════════════════════════════════════════ */
  function projectTurnsPro(spec, horizon) {
    horizon = horizon || 60;
    if (!spec || !spec.cycles || !spec.cycles.length) return [];
    const c = spec.cycles[0];
    const w = TAU * c.freq;
    if (!(w > 0)) return [];
    const A = c.amp, sg = c.sigma, N = c.N;
    const snr2 = (A > 0 && sg > 0) ? (A * A) / (sg * sg) : 0;
    const varOmega = snr2 > 0 ? 12 / (snr2 * N * (N * N - 1)) : Infinity;
    const varPhi = snr2 > 0 ? 2 * (2 * N - 1) / (snr2 * N * (N + 1)) : Infinity;

    const out = [];
    const th = wrap(c.phase);
    /* قمة عند θ ≡ 0 (mod 2π)، وقاع عند θ ≡ π. تُحسب أول واحدة من كل نوع
       ثم تتكرّر كل دورة كاملة. */
    const firstPeak = (TAU - th) / w;
    const firstValley = (th <= Math.PI ? (Math.PI - th) : (TAU + Math.PI - th)) / w;
    const halfPeriod = Math.PI / w;
    const push = (t0, type) => {
      for (let h = t0; h <= horizon + 1e-9; h += 2 * halfPeriod) {
        if (h <= 0.5) continue;
        const sdTheta = Math.sqrt(varPhi + h * h * varOmega);
        const sdBars = isFinite(sdTheta) ? sdTheta / w : null;
        const barsAhead = Math.round(h);
        out.push({
          type,
          barsAhead,
          sdBars: sdBars == null ? null : r2(sdBars),
          loBars: sdBars == null ? null : Math.max(0, Math.round(h - 1.959963985 * sdBars)),
          hiBars: sdBars == null ? null : Math.round(h + 1.959963985 * sdBars),
          /* «قابل للاستعمال» = عدم اليقين أضيق من ربع دورة. أوسع من ذلك
             يعني أن النافذة تغطي القمة والقاع معاً فلا تميّز بينهما. */
          usable: sdBars != null && sdBars <= c.period / 4
        });
      }
    };
    push(firstPeak, 'peak');
    push(firstValley, 'valley');
    return out.sort((a, b) => a.barsAhead - b.barsAhead);
  }

  /** نسخة مبسّطة بلا نطاق عدم يقين — للتوافق مع المستهلكين القدامى. */
  function projectCycleTurns(spec, currentIndex, horizon) {
    return projectTurnsPro(spec, horizon || 60).map(t => ({ type: t.type, barsAhead: t.barsAhead }));
  }

  /* ════════════════════════════════════════════════════════════════════
     11) ARIMA(1,1,0) — تنبؤ بنطاق صحيح، وتصريح حين لا يعني شيئاً
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري السابق: نطاق عدم اليقين حُسب كـ σ·√h. هذه الصيغة صحيحة
     فقط عند φ=0 (مشي عشوائي محض). للنموذج AR(1) على الفروق يكون التباين
     التراكمي بعد h خطوة:
        Var(h) = σ² · Σ_{k=1..h} [(1 − φ^k)/(1 − φ)]²
     عند φ=0.7 و h=10 تعطي الصيغة الصحيحة 8.45 بينما σ√h تعطي 3.16، أي أن
     النطاق المعروض كان أضيق بـ 63٪ من الحقيقة — إيحاء بدقة غير موجودة.

     والحقل `meaningful` هو الإضافة الأهم: على سهم بلا زخم ذاتي يكون
     التنبؤ مساوياً للسعر الحالي عملياً، والسعر الحالي يقع داخل فاصل
     الثقة 95٪. عرض رقم تنبؤ في هذه الحالة بلا تصريح ادّعاء معرفة.
     ════════════════════════════════════════════════════════════════════ */
  function forecastARIMA(prices, horizon) {
    const h = Math.max(1, Math.round(horizon || 5));
    const p = Stats.clean(prices).filter(v => v > 0);
    if (p.length < 40) return { ok: false, reason: `عيّنة ${p.length} سعر — تقدير φ يتطلب 40+ لتكون له دلالة` };

    const d = [];
    for (let i = 1; i < p.length; i++) d.push(p[i] - p[i - 1]);
    const n = d.length - 1;
    if (n < 20) return { ok: false, reason: 'فروق غير كافية لتقدير النموذج' };

    /* انحدار OLS:  d_t = c + φ·d_{t−1} + ε_t */
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 1; i < d.length; i++) { const X = d[i - 1], Y = d[i]; sx += X; sy += Y; sxy += X * Y; sxx += X * X; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return { ok: false, reason: 'الفروق ثابتة — لا يمكن تقدير النموذج' };
    const phi = (n * sxy - sx * sy) / den;
    const c = (sy - phi * sx) / n;

    let ss = 0;
    for (let i = 1; i < d.length; i++) { const e = d[i] - (c + phi * d[i - 1]); ss += e * e; }
    const sigma2 = ss / Math.max(1, n - 2);
    const sigma = Math.sqrt(sigma2);
    const seSlope = Math.sqrt(sigma2 * n / den);
    const tStat = seSlope > 0 ? phi / seSlope : 0;
    const phiP = Stats.twoSidedT(tStat, Math.max(1, n - 2));

    /* تنبؤ تكراري للفروق ثم جمعها على آخر سعر */
    let last = p[p.length - 1], dLast = d[d.length - 1], acc = 0;
    for (let k = 0; k < h; k++) { dLast = c + phi * dLast; acc += dLast; }
    const point = last + acc;

    /* التباين التراكمي الصحيح لمجموع h فرقاً من AR(1) */
    let varSum = 0;
    const oneMinus = 1 - phi;
    for (let k = 1; k <= h; k++) {
      const psi = Math.abs(oneMinus) < 1e-9 ? k : (1 - Math.pow(phi, k)) / oneMinus;
      varSum += psi * psi;
    }
    const sdH = sigma * Math.sqrt(varSum);
    const z = 1.959963985;
    const lo = point - z * sdH, hi = point + z * sdH;
    const meaningful = last < lo || last > hi;

    return {
      ok: true,
      point: r2(point), lo: r2(lo), hi: r2(hi),
      bandPct: r2(z * sdH / point * 100),
      expectedChangePct: r2((point - last) / last * 100),
      phi: r3(phi), phiSe: r4(seSlope), phiT: r3(tStat),
      phiPValue: Stats.pText(phiP), phiSignificant: phiP < 0.05,
      sigma: r3(sigma), horizon: h, sampleSize: p.length,
      meaningful,
      note: meaningful
        ? `السعر الحالي (${r2(last)}) يقع خارج فاصل الثقة 95٪ للتنبؤ ⇒ النموذج يميّز توقّعه عن «بلا تغيّر». هذا شرط ضروري لا كافٍ: النموذج خطّي ولا يرى أخباراً ولا أرباحاً.`
        : `السعر الحالي (${r2(last)}) يقع داخل فاصل الثقة 95٪ [${r2(lo)} — ${r2(hi)}] ⇒ التنبؤ لا يختلف إحصائياً عن «بلا تغيّر». الرقم المعروض أعلاه صحيح حسابياً لكنه بلا مضمون توقّعي.`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     12) تماسك الدورة خارج العيّنة
     ──────────────────────────────────────────────────────────────────
     اختبار فيشر يجيب عن سؤال وصفي: «هل هذه الذروة تفسّرها الصدفة في
     العيّنة الماضية؟». وهذا الاختبار يجيب عن السؤال التنفيذي: «لو
     استعملتُ الدورة للتنبؤ بموعد انعطاف لم أره، هل كانت ستصيب؟».

     الطريقة: تُبنى الدورة من أول 60٪ من التاريخ فقط، وتُسقط انعطافاتها
     على الـ40٪ المحجوزة، ثم يُقاس كم منها وقع قرب ارتكاز حقيقي مؤكد.
     ومعدّل الصدفة ليس مفترضاً: يُقاس فعلياً كنسبة جلسات المنطقة المحجوزة
     الواقعة داخل نافذة تسامح من ارتكاز مطابق النوع.
     ════════════════════════════════════════════════════════════════════ */
  function cycleCoherence(cs, opt) {
    opt = opt || {};
    const k = opt.k || 3;
    if (!cs || cs.length < 120) return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — اختبار التماسك يتطلب 120+ (60٪ تدريب و40٪ حجز)` };

    const split = Math.floor(cs.length * 0.6);
    const train = cs.slice(0, split);
    const spec = spectralPro(train.map(c => c.close), { alpha: 0.05 });
    if (!spec.ok) return { ok: false, reason: 'تعذّر بناء الطيف على فترة التدريب: ' + spec.reason };
    if (!spec.significant) return { ok: false, reason: `لا دورة دالة في فترة التدريب (p = ${spec.pValueText}) — لا شيء يُختبر تماسكه` };

    const testLen = cs.length - split;
    const turns = projectTurnsPro(spec, testLen).filter(t => t.barsAhead >= 1 && t.barsAhead <= testLen);
    if (!turns.length) return { ok: false, reason: 'الدورة لا تُنتج انعطافاً داخل الفترة المحجوزة' };

    /* الارتكازات الحقيقية داخل الفترة المحجوزة (بفهارس نسبية) */
    const piv = detectPivots(cs, k)
      .filter(p => p.i >= split && p.confirmedAt <= cs.length - 1)
      .map(p => ({ rel: p.i - split + 1, type: p.type }));
    if (piv.length < 3) return { ok: false, reason: `${piv.length} ارتكاز مؤكد فقط في الفترة المحجوزة — عيّنة أصغر من أن تُختبر` };

    const tol = Math.max(2, Math.round(spec.period / 8));
    const match = (bars, type) => piv.some(p =>
      p.type === (type === 'valley' ? 'L' : 'H') && Math.abs(p.rel - bars) <= tol);

    let hits = 0; const offs = [];
    for (const t of turns) {
      const want = t.type === 'valley' ? 'L' : 'H';
      let best = null;
      for (const p of piv) if (p.type === want) {
        const off = Math.abs(p.rel - t.barsAhead);
        if (best == null || off < best) best = off;
      }
      if (best != null && best <= tol) { hits++; offs.push(best); }
    }
    void match;

    /* معدّل الصدفة مقاس لا مفترض: نسبة جلسات الفترة المحجوزة الواقعة
       داخل ±tol من ارتكاز مطابق النوع، بمتوسط النوعين بوزن الانعطافات. */
    const covered = type => {
      const set = new Set();
      for (const p of piv) if (p.type === type)
        for (let b = p.rel - tol; b <= p.rel + tol; b++) if (b >= 1 && b <= testLen) set.add(b);
      return set.size / testLen;
    };
    const cV = covered('L'), cH = covered('H');
    const nV = turns.filter(t => t.type === 'valley').length;
    const chance = turns.length ? (cV * nV + cH * (turns.length - nV)) / turns.length : 0;

    const pValue = Stats.binomTailP(hits, turns.length, Math.max(1e-6, Math.min(0.999, chance)));
    const ci = Stats.wilsonCI(hits, turns.length);
    const hitRate = hits / turns.length;
    const reliable = turns.length >= 5 && hitRate > chance && pValue < 0.05;

    return {
      ok: true,
      reliable,
      hits, tried: turns.length,
      hitRatePct: r2(hitRate * 100),
      hitRateCI: [r2(ci[0] * 100), r2(ci[1] * 100)],
      chanceRatePct: r2(chance * 100),
      pValue: r4(pValue), pValueText: Stats.pText(pValue),
      toleranceBars: tol,
      medianOffBars: offs.length ? r2(Stats.median(offs)) : null,
      trainBars: split, testBars: testLen,
      period: spec.period,
      verdict: reliable
        ? `الدورة تماسكت خارج العيّنة: ${hits} من ${turns.length} انعطافاً وقع قرب ارتكاز حقيقي مؤكد (${r2(hitRate * 100)}٪ مقابل ${r2(chance * 100)}٪ بالصدفة، p = ${Stats.pText(pValue)}). هذه أقوى شهادة تقدّمها المنصة لتوقيت سهم.`
        : `الدورة لم تتماسك خارج العيّنة: ${hits} من ${turns.length} (${r2(hitRate * 100)}٪) مقابل ${r2(chance * 100)}٪ متوقعة بالصدفة، p = ${Stats.pText(pValue)}. دورة دالة إحصائياً لكنها غير متماسكة = نمط في الماضي بلا قيمة توقيتية للمستقبل.`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     13) دورات الارتكاز التجريبية — بديل عدّ غان/فيبوناتشي الأعمى
     ──────────────────────────────────────────────────────────────────
     التحليل الزمني التقليدي يسأل: «هل المسافة منذ الارتكاز تساوي 34 أو 55
     أو 90؟» — أرقام مفروضة من خارج السهم، ولم يُسأل قط هل لهذا السهم فعلاً
     ميل لانعطافات عندها. هنا يُقلب السؤال: تؤخذ كل المسافات بين ارتكازات
     هذا السهم المؤكدة، وتُقارن بفرضية عدم مبنية على خلط تباعد الارتكازات
     نفسه — خلط يحفظ عدد الارتكازات وتوزيع تباعدها ويهدم البنية الدورية
     وحدها.

     لماذا التبديل لا بواسون: أزواج الارتكازات ليست مستقلة (إن كان
     a→b و b→c مسافتين، فـ a→c مقيّدة بهما)، واختبار بواسون البسيط يعطي
     إيجابيات كاذبة كثيرة على مسارات مشي عشوائي لهذا السبب بالذات.
     ════════════════════════════════════════════════════════════════════ */
  const CLASSIC_CYCLES = [13, 21, 34, 45, 55, 89, 90, 120, 144, 180];

  function empiricalPivotCycles(cs, opt) {
    opt = opt || {};
    const perms = opt.permutations || 300;
    const k = opt.k || 3;
    const q = opt.fdr == null ? 0.10 : opt.fdr;

    if (!cs || cs.length < 120) return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — اختبار الدورات التجريبية يتطلب 120+` };
    const piv = detectPivots(cs, k);
    if (piv.length < 8) return { ok: false, reason: `${piv.length} ارتكاز مؤكد فقط — مطلوب 8+ لبناء توزيع مسافات` };

    const pos = piv.map(p => p.i);
    const maxC = Math.min(120, Math.floor(cs.length / 3));
    if (maxC < 10) return { ok: false, reason: 'الأفق الزمني أقصر من أن يحمل دورة' };

    /* توزيع المسافات كمدرّج تكراري، ثم مجاميع تراكمية للاستعلام السريع */
    const histOf = positions => {
      const h = new Uint32Array(maxC + 2);
      for (let a = 0; a < positions.length; a++)
        for (let b = a + 1; b < positions.length; b++) {
          const dd = positions[b] - positions[a];
          if (dd >= 1 && dd <= maxC) h[dd]++;
        }
      const pre = new Uint32Array(maxC + 2);
      for (let i = 1; i <= maxC; i++) pre[i] = pre[i - 1] + h[i];
      return pre;
    };
    const win = (pre, c, tol) => pre[Math.min(maxC, c + tol)] - pre[Math.max(0, c - tol - 1)];

    const obsPre = histOf(pos);

    /* فرضية العدم: خلط تباعد الارتكازات (يحفظ العدد والتوزيع، يهدم الدورية) */
    const gaps = [];
    for (let i = 1; i < pos.length; i++) gaps.push(pos[i] - pos[i - 1]);
    const cands = [];
    for (let c = 5; c <= maxC; c++) cands.push({ c, tol: Math.max(1, Math.round(c * 0.08)) });

    const ge = new Uint32Array(cands.length);
    const sums = new Float64Array(cands.length);
    let seed = 20240917;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let it = 0; it < perms; it++) {
      const g2 = gaps.slice();
      for (let i = g2.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = g2[i]; g2[i] = g2[j]; g2[j] = t; }
      const pp = [pos[0]];
      for (const gg of g2) pp.push(pp[pp.length - 1] + gg);
      const pre = histOf(pp);
      for (let ci = 0; ci < cands.length; ci++) {
        const v = win(pre, cands[ci].c, cands[ci].tol);
        sums[ci] += v;
        if (v >= win(obsPre, cands[ci].c, cands[ci].tol)) ge[ci]++;
      }
    }

    const rows = cands.map((cd, ci) => {
      const observed = win(obsPre, cd.c, cd.tol);
      const expected = sums[ci] / perms;
      return {
        cycle: cd.c, tolerance: cd.tol, observed,
        expected: r2(expected),
        lift: expected > 0 ? r2(observed / expected) : null,
        pRaw: (1 + ge[ci]) / (1 + perms)
      };
    }).filter(r => r.observed >= 3);

    if (!rows.length) return { ok: true, cycles: [], pivotCount: piv.length, permutations: perms, note: 'لا مسافة تكرّرت ثلاث مرات فأكثر — لا شيء يُختبر' };

    const pass = Stats.benjaminiHochberg(rows.map(r => r.pRaw), q);
    let kept = rows.filter((r, i) => pass[i] && r.lift != null && r.lift > 1);

    /* دمج الدورات المتجاورة: 34 و35 و36 دورة واحدة لا ثلاث */
    kept.sort((a, b) => a.pRaw - b.pRaw || b.lift - a.lift);
    const merged = [];
    for (const r of kept) {
      if (merged.some(m => Math.abs(m.cycle - r.cycle) <= Math.max(m.tolerance, r.tolerance))) continue;
      merged.push(r);
    }
    const cycles = merged.slice(0, 5).map(r => ({
      cycle: r.cycle, observed: r.observed, expected: r.expected,
      lift: r.lift, tolerance: r.tolerance,
      pValue: Stats.pText(r.pRaw),
      pValueRaw: r4(r.pRaw),
      classic: CLASSIC_CYCLES.some(x => Math.abs(x - r.cycle) <= r.tolerance)
    })).sort((a, b) => a.cycle - b.cycle);

    return {
      ok: true,
      cycles,
      pivotCount: piv.length,
      permutations: perms,
      candidatesTested: rows.length,
      note: cycles.length
        ? `${cycles.length} دورة اجتازت اختبار التبديل وتصحيح Benjamini-Hochberg من ${rows.length} مسافة مرشّحة — هذه أرقام هذا السهم، لا أرقام مفروضة عليه.`
        : `لا مسافة زمنية على هذا السهم تتكرّر أكثر مما ينتجه الخلط العشوائي (${rows.length} مرشّحاً فُحص). النتيجة صحيحة لا عطل: عدّ 34 و55 و90 على هذا السهم بلا أساس تجريبي.`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     14) التوافق الزمني والنوافذ — بوحدات مصرَّح بها
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري السابق كان خلط الوحدات: دورات غان بالأيام التقويمية،
     ومناطق فيبوناتشي بالشموع مضروبة في «معدّل تقريبي» 1.4 يوم/شمعة. نتيجة
     ذلك تاريخ مزاح بأيام، وقد يقع في جمعة أو سبت — وهما عطلة السوق
     السعودي، فيُعرض «نافذة حرجة» في يوم لا يفتح فيه السوق أصلاً.
     هنا: كل نافذة تحمل وحدتها صراحةً، والتحويل يمرّ على تقويم تداول فعلي.
     ════════════════════════════════════════════════════════════════════ */
  const FIB_BARS = [13, 21, 34, 55, 89, 144, 233];
  const GANN_DAYS = [45, 90, 120, 144, 180, 270, 360];

  function _pivotDate(cs, idx) {
    const t = cs[idx] && cs[idx].time;
    return isNum(t) ? new Date(t * 1000) : null;
  }

  function timeConfluence(cs, pivot) {
    const n = cs.length;
    const pi = pivot && isNum(pivot.i) ? pivot.i : n - 1;
    const barsSince = n - 1 - pi;
    const pd = _pivotDate(cs, pi), nowD = _pivotDate(cs, n - 1);
    const daysSince = (pd && nowD) ? Math.round((nowD - pd) / 86400000) : barsSince;

    const evidence = [];
    const tolBars = Math.max(2, Math.round(barsSince * 0.06));

    const fibHit = FIB_BARS.find(f => Math.abs(f - barsSince) <= tolBars);
    evidence.push({
      name: `فيبوناتشي زمني (جلسات): ${barsSince} جلسة منذ الارتكاز${fibHit ? ` — عند ${fibHit} ±${tolBars}` : ''}`,
      hit: !!fibHit, unit: 'bars', value: fibHit || null
    });

    const tolDays = Math.max(3, Math.round(daysSince * 0.06));
    const gannHit = GANN_DAYS.find(g => Math.abs(g - daysSince) <= tolDays);
    evidence.push({
      name: `غان تقويمي (أيام): ${daysSince} يوماً منذ الارتكاز${gannHit ? ` — عند ${gannHit} ±${tolDays}` : ''}`,
      hit: !!gannHit, unit: 'days', value: gannHit || null
    });

    const dc = dominantPivotCycle(cs, 3);
    let dcHit = false, dcLabel = 'دورة السهم الذاتية: لم تُكتشف';
    if (dc) {
      if (!dc.reliable) dcLabel = `دورة السهم الذاتية: ${dc.cycle} جلسة لكن اتساقها ${dc.consistencyPct}٪ — غير منتظمة فلا تُحتسب`;
      else {
        const mult = Math.round(barsSince / dc.cycle);
        const off = Math.abs(barsSince - mult * dc.cycle);
        dcHit = mult >= 1 && off <= Math.max(2, Math.round(dc.cycle * 0.12));
        dcLabel = `دورة السهم الذاتية: ${dc.cycle} جلسة — المسافة الحالية ${dcHit ? `عند المضاعف ${mult}` : `بين المضاعفات (انحراف ${off} جلسة)`}`;
      }
    }
    evidence.push({ name: dcLabel, hit: dcHit, unit: 'bars', value: dc ? dc.cycle : null });

    let spHit = false, spLabel = 'انعطاف طيفي: لا دورة دالة على هذا السهم';
    try {
      const sp = spectralPro(cs.map(c => c.close), { alpha: 0.05 });
      if (sp.ok && sp.significant) {
        const turns = projectTurnsPro(sp, Math.max(10, Math.round(sp.period / 2)));
        const near = turns.filter(t => t.barsAhead <= Math.max(2, Math.round(sp.period / 12)) && t.usable);
        spHit = near.length > 0;
        spLabel = spHit
          ? `انعطاف طيفي: ${near[0].type === 'valley' ? 'قاع' : 'قمة'} متوقع خلال ${near[0].barsAhead} جلسة (دورة ${sp.period}، p = ${sp.pValueText})`
          : `انعطاف طيفي: دورة ${sp.period} جلسة دالة (p = ${sp.pValueText}) لكن لا انعطاف وشيك`;
      } else if (sp.ok) spLabel = `انعطاف طيفي: الطيف غير دال (p = ${sp.pValueText})`;
    } catch (e) { /* الطيف اختياري هنا — غيابه لا يُسقط بقية الأدلة */ }
    evidence.push({ name: spLabel, hit: spHit, unit: 'bars', value: null });

    const count = evidence.filter(e => e.hit).length;
    const total = evidence.length;
    const label = count >= 3 ? 'توافق زمني قوي' : count === 2 ? 'توافق زمني جزئي'
      : count === 1 ? 'دليل زمني واحد' : 'لا توافق زمني عند المسافة الحالية';

    return { barsSincePivot: barsSince, daysSincePivot: daysSince, evidence, count, total, label, pivotIndex: pi };
  }

  function timeWindows(cs, pivot, opt) {
    opt = opt || {};
    const horizonDays = opt.horizonDays || 240;
    const n = cs.length;
    if (!cs.length || !pivot || !isNum(pivot.i)) return [];
    const pi = clamp(pivot.i, 0, n - 1);
    const barsSince = n - 1 - pi;
    const pd = _pivotDate(cs, pi);
    const today = _pivotDate(cs, n - 1) || new Date();
    const daysSince = pd ? Math.round((today - pd) / 86400000) : barsSince;
    const out = [];

    const calDaysAhead = d => Math.round((d - today) / 86400000);

    /* ① فيبوناتشي زمني — وحدته جلسات تداول */
    for (const f of FIB_BARS) {
      const ahead = f - barsSince;
      if (ahead <= 0) continue;
      const date = SaudiMarket.addTradingDays(today, ahead);
      const daysLeft = calDaysAhead(date);
      if (daysLeft > horizonDays) continue;
      out.push({
        label: `فيبوناتشي زمني — ${f} جلسة من الارتكاز`,
        unit: 'bars', barsAhead: ahead, daysLeft, date, shiftedFromWeekend: false, source: 'fib'
      });
    }

    /* ② غان تقويمي — وحدته أيام تقويمية، وقد تقع في عطلة فتُزاح صراحةً */
    if (pd) {
      for (const g of GANN_DAYS) {
        const ahead = g - daysSince;
        if (ahead <= 0 || ahead > horizonDays) continue;
        const raw = new Date(pd.getTime() + g * 86400000);
        const shifted = SaudiMarket.nextTradingDay(raw);
        const wasShifted = shifted.getTime() !== raw.getTime();
        const bars = Math.max(1, SaudiMarket.tradingDaysBetween(today, shifted));
        out.push({
          label: `دورة غان التقويمية — ${g} يوماً من الارتكاز`,
          unit: 'days', barsAhead: bars, daysLeft: calDaysAhead(shifted), date: shifted,
          shiftedFromWeekend: wasShifted, source: 'gann'
        });
      }
    }

    /* ③ الدورة الذاتية — لا تُدرَج إلا إن كانت منتظمة فعلاً */
    const dc = dominantPivotCycle(cs, 3);
    if (dc && dc.reliable) {
      for (let m = 1; m <= 4; m++) {
        const ahead = dc.cycle * m - barsSince;
        if (ahead <= 0) continue;
        const date = SaudiMarket.addTradingDays(today, ahead);
        const daysLeft = calDaysAhead(date);
        if (daysLeft > horizonDays) continue;
        out.push({
          label: `دورة السهم الذاتية ×${m} — ${dc.cycle * m} جلسة (اتساق ${dc.consistencyPct}٪)`,
          unit: 'bars', barsAhead: ahead, daysLeft, date, shiftedFromWeekend: false, source: 'own'
        });
      }
    }

    /* ④ الانعطافات الطيفية — الوحيدة التي تحمل نطاق عدم يقين مقاساً */
    try {
      const sp = spectralPro(cs.map(c => c.close), { alpha: 0.05 });
      if (sp.ok && sp.significant) {
        for (const t of projectTurnsPro(sp, 120).slice(0, 4)) {
          const date = SaudiMarket.addTradingDays(today, t.barsAhead);
          const daysLeft = calDaysAhead(date);
          if (daysLeft > horizonDays) continue;
          out.push({
            label: `انعطاف طيفي — ${t.type === 'valley' ? 'قاع' : 'قمة'} متوقع (دورة ${sp.period} جلسة، p = ${sp.pValueText})${t.sdBars != null ? ` ± ${t.sdBars} جلسة` : ''}`,
            unit: 'bars', barsAhead: t.barsAhead, daysLeft, date,
            shiftedFromWeekend: false, source: 'spectral',
            sdBars: t.sdBars, loBars: t.loBars, hiBars: t.hiBars, usable: t.usable
          });
        }
      }
    } catch (e) { /* اختياري */ }

    return out.sort((a, b) => a.barsAhead - b.barsAhead);
  }

  /* ════════════════════════════════════════════════════════════════════
     15) النطاق القيمي المرجعي
     ──────────────────────────────────────────────────────────────────
     لا يدّعي معرفة «القيمة الحقيقية» — وهي لا تُشتق من الشارت أصلاً بل من
     الأرباح والميزانية والقطاع. ما يعرضه نطاق مرجعي إحصائي من ثلاث مراسٍ
     قابلة للتحقق: POC الحجمي، وVWAP مثبّت على آخر ارتكاز مؤكد، ووسط قناة
     الانحدار — مع تنويه صريح بحدود الطريقة.
     ════════════════════════════════════════════════════════════════════ */
  function valueBand(cs) {
    if (!cs || cs.length < 60) return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — النطاق القيمي يتطلب 60+` };
    const n = cs.length, price = r2(cs[n - 1].close);
    const closes = cs.map(c => c.close);

    const vp = volumeProfile(cs, { bins: 60 });
    const piv = lastConfirmedPivot(cs, 3);
    const av = piv ? Cumulative.anchoredVWAP(cs, piv.i)[n - 1] : null;

    const reg = Stats.linreg(closes);
    const fitted = closes.map((_, i) => reg.slope * i + reg.intercept);
    const resid = closes.map((v, i) => v - fitted[i]);
    const rsd = Stats.sd(resid);
    const regMid = fitted[n - 1];

    const anchors = [];
    if (vp) anchors.push({ label: 'نقطة التحكّم الحجمية (POC)', value: vp.poc, key: 'poc' });
    if (isNum(av)) anchors.push({ label: `VWAP مثبّت على آخر ارتكاز مؤكد (${piv.type === 'L' ? 'قاع' : 'قمة'} ${piv.price})`, value: r2(av), key: 'avwap' });
    anchors.push({ label: 'وسط قناة الانحدار الخطي', value: r2(regMid), key: 'reg' });

    if (anchors.length < 2) return { ok: false, reason: 'تعذّر بناء مرساتين مستقلتين على هذه البيانات' };

    const vals = anchors.map(a => a.value);
    const center = Stats.mean(vals);
    const spread = Stats.sd(vals);
    const bandLow = Math.min.apply(null, vals), bandHigh = Math.max.apply(null, vals);
    const z = spread > 0 ? (price - center) / spread : 0;
    const devPct = (price - center) / center * 100;

    const position = Math.abs(z) < 1
      ? 'داخل نطاق المراسي — السعر متسق مع مرجعيّاته'
      : z >= 1
        ? 'فوق نطاق المراسي — السعر متقدّم على مرجعيّاته'
        : 'تحت نطاق المراسي — السعر متأخّر عن مرجعيّاته';

    return {
      ok: true,
      price, anchors,
      bandLow: r2(bandLow), bandHigh: r2(bandHigh), center: r2(center),
      spread: r2(spread),
      deviationPct: r2(devPct),
      zVsAnchors: r2(z),
      position,
      valueArea: vp ? { low: vp.valueAreaLow, high: vp.valueAreaHigh, poc: vp.poc } : null,
      regressionLow: r2(regMid - 2 * rsd),
      regressionHigh: r2(regMid + 2 * rsd),
      regressionR2: r3(reg.r2),
      caveat: 'هذا نطاق مرجعي إحصائي من سلوك السعر والحجم فقط. ليس تقييماً أساسياً: لا يدخل فيه ربح الشركة ولا ميزانيتها ولا توزيعاتها ولا وضع قطاعها، وهي المحدّدات الفعلية للقيمة. تباعد السعر عن هذا النطاق ليس بذاته سبباً للشراء أو البيع.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     16) الخطة التنفيذية — هدف من البنية، ووقف خارج الضجيج
     ──────────────────────────────────────────────────────────────────
     ثلاثة عيوب في النسخة السابقة:

     (1) الهدف كان يُعرَّف بأنه entry + 2×المخاطرة، ثم يُعرض «R:R = 1:2»
         كأنه نتيجة تحليل. هذا حشو تعريفي: النسبة 2 لأننا كتبنا 2، لا لأن
         السوق يعرض فرصة بهذه النسبة. هنا الهدف أقرب مستوى بنيوي فعلي،
         والنسبة تُحسب منه — فتختلف من سهم لآخر لأنها تقيس شيئاً حقيقياً.

     (2) مسافة الوقف كانت max(0.5×ATR, 0.5٪) — أي داخل ضجيج الجلسة
         العادي، فيُضرب الوقف قبل أن تتاح للفكرة فرصة. الافتراضي هنا
         1.5×ATR أو خلف أقرب مستوى بنيوي، أيّهما أبعد.

     (3) لم يكن هناك مفهوم «صفقة غير مجدية» إطلاقاً: كل حالة تُنتج خطة.
         الآن إن أعطى أقرب مستوى بنيوي عائداً/مخاطرة أقل من الحد الأدنى،
         تُعلَن الخطة غير مجدية صراحةً بدل تضخيم الهدف قسراً لتجميل النسبة.
     ════════════════════════════════════════════════════════════════════ */
  function executionPlan(cs, opt) {
    opt = opt || {};
    const dirUp = opt.dirUp !== false;
    const atrMult = opt.atrStopMult == null ? 1.5 : opt.atrStopMult;
    const minRR = opt.minRR == null ? 1.5 : opt.minRR;
    if (!cs || cs.length < 30) return { ok: false, reason: 'شموع غير كافية لبناء خطة' };

    const n = cs.length, entry = r2(cs[n - 1].close);
    const a = atr(cs, 14);
    if (!isNum(a) || a <= 0) return { ok: false, reason: 'تعذّر حساب ATR' };

    const lv = structuralLevels(cs, entry);
    const atrStop = dirUp ? entry - atrMult * a : entry + atrMult * a;

    /* الوقف: خلف أقرب مستوى بنيوي أو 1.5×ATR — أيّهما أبعد عن الدخول.
       «خلف» تعني بهامش ربع ATR حتى لا يقع الوقف على المستوى نفسه، حيث
       تتكدّس الأوامر وتُلتقط السيولة. */
    const pad = 0.25 * a;
    let stop, stopSource;
    if (dirUp) {
      const sup = lv.supports.length ? lv.supports[0] : null;
      const structStop = sup != null ? sup - pad : null;
      if (structStop != null && structStop < atrStop) { stop = structStop; stopSource = `خلف أقرب دعم بنيوي (${r2(sup)}) بهامش ربع ATR`; }
      else { stop = atrStop; stopSource = `${atrMult}×ATR تحت الدخول — لا دعم بنيوي أبعد من ذلك`; }
    } else {
      const res = lv.resistances.length ? lv.resistances[0] : null;
      const structStop = res != null ? res + pad : null;
      if (structStop != null && structStop > atrStop) { stop = structStop; stopSource = `فوق أقرب مقاومة بنيوية (${r2(res)}) بهامش ربع ATR`; }
      else { stop = atrStop; stopSource = `${atrMult}×ATR فوق الدخول — لا مقاومة بنيوية أبعد من ذلك`; }
    }
    stop = r2(stop);
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return { ok: false, reason: 'مسافة مخاطرة صفرية' };

    /* الهدف: أقرب مستوى بنيوي في اتجاه الصفقة. إن لم يوجد، تُستعمل القمة
       الفراكتالية الحيّة، وإن غابت أيضاً يُصرَّح بغياب هدف بنيوي. */
    const ft = fractalTargets(cs, { k: 2 });
    let target = null, targetSource = null;
    if (dirUp) {
      if (lv.resistances.length) { target = lv.resistances[0]; targetSource = 'أقرب مقاومة بنيوية (ارتكاز مؤكد فوق السعر)'; }
      else if (ft.ok && ft.target1) { target = ft.target1; targetSource = 'أقرب قمة فراكتالية غير مكسورة'; }
    } else {
      if (lv.supports.length) { target = lv.supports[0]; targetSource = 'أقرب دعم بنيوي (ارتكاز مؤكد تحت السعر)'; }
      else if (ft.ok && ft.support) { target = ft.support; targetSource = 'أقرب قاع فراكتالي غير مكسور'; }
    }

    let viable = true, viabilityNote = '';
    let rr1 = null;
    if (target == null) {
      viable = false;
      viabilityNote = dirUp
        ? 'لا يوجد أي مستوى بنيوي فوق السعر ضمن التاريخ المحمّل — السهم في اكتشاف سعري. لا يمكن اشتقاق هدف من البنية، ووضع هدف بمضاعف ثابت هنا اختراع لا تحليل. وسّع النطاق الزمني أو تعامل معه بوقف متحرّك بلا هدف ثابت.'
        : 'لا يوجد أي مستوى بنيوي تحت السعر ضمن التاريخ المحمّل — لا يمكن اشتقاق هدف من البنية.';
      target = null;
    } else {
      const reward = Math.abs(target - entry);
      rr1 = r2(reward / risk);
      if (rr1 < minRR) {
        viable = false;
        viabilityNote = `أقرب مستوى بنيوي (${target}) يبعد ${r2(reward)} ر.س بينما المخاطرة ${r2(risk)} ر.س ⇒ العائد/المخاطرة 1:${rr1}، دون الحد الأدنى 1:${minRR}. الهدف لم يُضخَّم للوصول إلى النسبة: تضخيمه يجعل الرقم جميلاً والصفقة كما هي.`;
      }
    }

    const lim = SaudiMarket.dailyLimits(entry);
    const minSessions = target != null ? SaudiMarket.minSessionsBetween(entry, target) : null;

    return {
      ok: true,
      dirUp, viable, viabilityNote,
      entry, stop,
      riskPerShare: r2(risk), riskPct: r2(risk / entry * 100), stopSource,
      target1: target, rr1, targetSource,
      target2: dirUp ? (lv.resistances[1] != null ? lv.resistances[1] : null) : (lv.supports[1] != null ? lv.supports[1] : null),
      atr: a, atrStopMult: atrMult, minRR,
      dailyLimitUp: lim.up, dailyLimitDown: lim.down, dailyLimitPct: lim.limitPct,
      minSessionsToTarget: minSessions,
      supports: lv.supports.slice(0, 3), resistances: lv.resistances.slice(0, 3)
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     17) الاختبار التاريخي للإشارة الطيفية
     ──────────────────────────────────────────────────────────────────
     • بلا تسرّب زمني: عند كل شمعة يُعاد بناء الطيف من البيانات المتاحة
       حتى تلك اللحظة فقط.
     • خط الأساس ليس عيّنة عشوائية بل التوزيع غير المشروط الكامل — كل شمعة
       مؤهّلة في الاتجاهين. لذلك النتيجة حتمية: خمس تشغيلات تعطي رقماً
       متطابقاً حرفياً. النسخة السابقة كانت تستعمل Math.random فتغيّر حكمها
       بين ضغطتي زر.
     • المحاكاة متحفّظة: إن لامست شمعة واحدة الوقف والهدف معاً تُحتسب وقفاً،
       لأن ترتيبهما داخل الجلسة غير معلوم من بيانات يومية.
     • لا حكم دون 20 إشارة: فارق 5 نقاط بعيّنة 5 صفقات ضجيج بحت.
     ════════════════════════════════════════════════════════════════════ */
  const BT_MIN_SIGNALS = 20;

  function _simulateTrade(cs, entryIdx, dirUp, stopDist, rewardRisk, maxHold) {
    const entry = cs[entryIdx].close;
    const stop = dirUp ? entry - stopDist : entry + stopDist;
    const target = dirUp ? entry + rewardRisk * stopDist : entry - rewardRisk * stopDist;
    const end = Math.min(cs.length - 1, entryIdx + maxHold);
    for (let i = entryIdx + 1; i <= end; i++) {
      const c = cs[i];
      const hitStop = dirUp ? c.low <= stop : c.high >= stop;
      const hitTgt = dirUp ? c.high >= target : c.low <= target;
      /* متحفّظ: التلامس المزدوج يُحتسب وقفاً */
      if (hitStop) return { r: -1, pnlPct: (dirUp ? stop - entry : entry - stop) / entry * 100, bars: i - entryIdx, exit: 'stop' };
      if (hitTgt) return { r: rewardRisk, pnlPct: (dirUp ? target - entry : entry - target) / entry * 100, bars: i - entryIdx, exit: 'target' };
    }
    const out = cs[end].close;
    const pnl = dirUp ? out - entry : entry - out;
    return { r: pnl / stopDist, pnlPct: pnl / entry * 100, bars: end - entryIdx, exit: 'time' };
  }

  function _summarize(trades) {
    const count = trades.length;
    if (!count) return null;
    const wins = trades.filter(t => t.r > 0).length;
    const rs = trades.map(t => t.r);
    const grossWin = trades.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
    const grossLoss = Math.abs(trades.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
    const meanR = Stats.mean(rs), sdR = Stats.sd(rs);
    let eq = 0, peak = 0, dd = 0;
    for (const t of trades) { eq += t.r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    const ci = Stats.wilsonCI(wins, count);
    return {
      count, wins,
      winRatePct: r2(wins / count * 100),
      winRateCI: [r2(ci[0] * 100), r2(ci[1] * 100)],
      expectancyR: r3(meanR),
      avgPnlPct: r2(Stats.mean(trades.map(t => t.pnlPct))),
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
      sharpePerTrade: sdR > 0 ? r3(meanR / sdR) : null,
      maxDrawdownR: r2(dd),
      avgBarsHeld: r2(Stats.mean(trades.map(t => t.bars)))
    };
  }

  function backtestSpectral(cs, opt) {
    opt = opt || {};
    const cfg = {
      atrStopMult: opt.atrStopMult == null ? 1.5 : opt.atrStopMult,
      rewardRisk: opt.rewardRisk == null ? 2 : opt.rewardRisk,
      maxHoldBars: opt.maxHoldBars == null ? 20 : opt.maxHoldBars,
      alpha: opt.alpha == null ? 0.05 : opt.alpha,
      warmup: opt.warmup == null ? 100 : opt.warmup,
      refitEvery: opt.refitEvery == null ? 5 : opt.refitEvery,
      triggerBars: opt.triggerBars == null ? 2 : opt.triggerBars
    };
    if (!cs || cs.length < cfg.warmup + cfg.maxHoldBars + 20)
      return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — الاختبار يتطلب ${cfg.warmup + cfg.maxHoldBars + 20}+ (إحماء ${cfg.warmup} جلسة ثم فترة اختبار)`, config: cfg };

    const closes = cs.map(c => c.close);
    const atrA = atrSeries(cs, 14);
    const lastEntry = cs.length - 1 - cfg.maxHoldBars;

    const sigTrades = [], baseTrades = [];
    let spec = null, specAt = -1;

    for (let t = cfg.warmup; t <= lastEntry; t++) {
      const a = atrA[t];
      if (!isNum(a) || a <= 0) continue;
      const stopDist = cfg.atrStopMult * a;

      /* خط الأساس: كل شمعة مؤهّلة في الاتجاهين — توزيع كامل بلا عشوائية */
      baseTrades.push(_simulateTrade(cs, t, true, stopDist, cfg.rewardRisk, cfg.maxHoldBars));
      baseTrades.push(_simulateTrade(cs, t, false, stopDist, cfg.rewardRisk, cfg.maxHoldBars));

      /* الطيف يُعاد بناؤه من البيانات المتاحة حتى t فقط */
      if (specAt < 0 || t - specAt >= cfg.refitEvery) {
        spec = spectralPro(closes.slice(0, t + 1), { alpha: cfg.alpha });
        specAt = t;
      }
      if (!spec || !spec.ok || !spec.significant) continue;

      /* الطور يُقدَّم بعدد الجلسات المنقضية منذ آخر ملاءمة، فلا نعيد
         الحساب كل شمعة دون أن نفقد صحة التوقيت. */
      const drift = t - specAt;
      const shifted = {
        cycles: spec.cycles.map(c => Object.assign({}, c, { phase: wrap(c.phase + TAU * c.freq * drift) }))
      };
      const turns = projectTurnsPro(shifted, Math.max(6, cfg.triggerBars * 3));
      const nv = turns.find(x => x.type === 'valley');
      const np = turns.find(x => x.type === 'peak');
      if (nv && nv.barsAhead <= cfg.triggerBars && nv.usable)
        sigTrades.push(_simulateTrade(cs, t, true, stopDist, cfg.rewardRisk, cfg.maxHoldBars));
      else if (np && np.barsAhead <= cfg.triggerBars && np.usable)
        sigTrades.push(_simulateTrade(cs, t, false, stopDist, cfg.rewardRisk, cfg.maxHoldBars));
    }

    const S = _summarize(sigTrades), B = _summarize(baseTrades);
    const base = { config: cfg, signalCount: sigTrades.length, baselineCount: baseTrades.length, signal: S, baseline: B };

    if (!S || !B) return Object.assign({ ok: false, reason: 'لم تصدر أي إشارة طيفية على هذا السهم — لا شيء يُقارن' }, base);
    if (S.count < BT_MIN_SIGNALS)
      return Object.assign({
        ok: false,
        reason: `${S.count} إشارة فقط — الحد الأدنى ${BT_MIN_SIGNALS} قبل إصدار أي حكم إحصائي. النسخة السابقة كانت تصدر حكماً «✅ تتفوّق» من 5 صفقات، وفارق 5 نقاط بهذه العيّنة ضجيج بحت.`
      }, base);

    const pValue = Stats.twoProportionP(S.wins, S.count, B.wins, B.count);
    const edgeWin = r2(S.winRatePct - B.winRatePct);
    const edgeExp = r3(S.expectancyR - B.expectancyR);
    const significant = pValue < cfg.alpha && edgeWin > 0;

    return Object.assign({
      ok: true,
      edgeWinRatePct: edgeWin,
      edgeExpectancyR: edgeExp,
      pValue: r4(pValue), pValueText: Stats.pText(pValue),
      significant,
      verdict: significant
        ? `الإشارة الطيفية تتفوّق على خط الأساس بفارق ${edgeWin} نقطة في نسبة الربح و${edgeExp} R في التوقّع الرياضي، بقيمة احتمال ${Stats.pText(pValue)} على ${S.count} صفقة. النتيجة تخصّ هذا السهم وهذا التاريخ ولا تُعمَّم.`
        : `الفارق عن خط الأساس (${edgeWin} نقطة، ${edgeExp} R) لا يُميَّز عن الصدفة عند مستوى ${cfg.alpha} (p = ${Stats.pText(pValue)}). على هذا السهم لا تُقدّم الإشارة الطيفية أفضلية مقاسة، والامتناع عن الحكم الإيجابي هو النتيجة الأمينة.`
    }, base);
  }

  /* ════════════════════════════════════════════════════════════════════
     18) الواجهة المصدَّرة
     ════════════════════════════════════════════════════════════════════ */
  return {
    VERSION, SESSIONS_PER_YEAR,
    Stats, SaudiMarket, Cumulative,

    /* بيانات */
    sanitizeCandles, auditCandles,

    /* مدى وتذبذب */
    atr, atrSeries, volatility,

    /* بنية */
    detectPivots, lastConfirmedPivot, dominantPivotCycle, structuralLevels,
    fractalTargets, volumeProfile, valueBand,

    /* دورات وتنبؤ */
    spectral, spectralPro, projectTurnsPro, projectCycleTurns,
    forecastARIMA, cycleCoherence, empiricalPivotCycles,

    /* زمن */
    timeConfluence, timeWindows,

    /* تنفيذ واختبار */
    executionPlan, backtestSpectral, BT_MIN_SIGNALS
  };
});
