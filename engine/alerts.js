/* ══════════════════════════════════════════════════════════════════════════
   KSAAlerts — منطق التنبيهات
   ──────────────────────────────────────────────────────────────────────────
   ملف منفصل عن الواجهة عمداً: «متى يستحق الأمر أن يوقظك» قرار يجب أن
   يكون مقروءاً ومُختبَراً، لا مدفوناً في معالج ضغطة زرّ.

   ثلاث مسؤوليات، وكل واحدة دالة نقيّة:
     ① evaluate  — يحوّل حالة الأسهم إلى قائمة تنبيهات مرشّحة.
     ② dedupe    — يمنع تكرار التنبيه نفسه، وهو الفرق بين أداة تُستعمل
                   وأداة تُكتم إشعاراتها بعد يومين.
     ③ format    — نصّ عربي يحمل الأرقام التي يُتصرَّف بها.

   ⚠️ قاعدة حاكمة: لا ينطلق تنبيه على «دورة طيفية» وحدها.
   القياس على السوق أعطى عدد الأسهم المجتازة لاختبار الدلالة ≈ ما تنتجه
   الصدفة عند العتبة 0.05. فتنبيهٌ مبني عليها وحدها يوقظك على ضجيج. الشرط
   الأول دائماً بنيوي: خطة قابلة للتنفيذ بوقف خارج ضجيج الجلسة.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KSAAlerts = api;
})(this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /* أنواع التنبيهات مرتّبة بالأولوية: الأصغر أهمّ. الترتيب ليس تجميلاً —
     حين تتزاحم التنبيهات يُرسل الأهمّ أولاً وتُقصّ البقية عند سقف الرسائل. */
  const KIND = {
    READY: 'ready',       /* كل الشروط مكتملة — أعلى ما تصل إليه المنصة */
    ZONE: 'zone',         /* السعر دخل منطقة الدخول لخطة مجدية */
    APPROACH: 'approach', /* السعر يقترب من المنطقة ولم يدخلها */
    RADAR: 'radar'        /* دورة مقاسة ثابتة وأمامها انعطاف قريب */
  };
  const PRIORITY = { ready: 1, zone: 2, approach: 3, radar: 4 };
  const LABEL = {
    ready: 'الشروط مكتملة',
    zone: 'السعر داخل منطقة الدخول',
    approach: 'السعر يقترب من منطقة الدخول',
    radar: 'دخل الرادار الزمني'
  };
  const ICON = { ready: '✅', zone: '🎯', approach: '📍', radar: '🕒' };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const r2 = v => (isNum(v) ? Math.round(v * 100) / 100 : null);

  /* ════════════════════════════════════════════════════════════════════
     ① التقييم
     ──────────────────────────────────────────────────────────────────
     المدخل صفّ لكل سهم جُمع في الواجهة، فلا تعرف هذه الوحدة شيئاً عن
     الـDOM ولا عن مصدر البيانات، وتُختبر بمدخلات مكتوبة يدوياً.

     @param {Array<{sym,name,price,levels,time,action}>} items
     @param {{kinds?:string[], radarHorizon?:number, approachPct?:number,
              requireUsableTurn?:boolean}} [opt]
     ════════════════════════════════════════════════════════════════════ */
  function evaluate(items, opt) {
    opt = opt || {};
    /* الرادار ليس في الافتراضي: القياس أعطى عدد الأسهم المجتازة لاختبار
       الدلالة ≈ ما تنتجه الصدفة عند 0.05، فإدراجه افتراضياً يوقظ على ضجيج.
       يُطلب صراحةً حين يريده المستخدم، والواجهة تقول له ذلك. */
    const kinds = opt.kinds || [KIND.READY, KIND.ZONE];
    const on = k => kinds.indexOf(k) >= 0;
    const horizon = opt.radarHorizon == null ? 10 : opt.radarHorizon;
    const approachPct = opt.approachPct == null ? 1.5 : opt.approachPct;
    const requireUsable = opt.requireUsableTurn !== false;

    const out = [];
    const stats = { scanned: 0, ready: 0, zone: 0, approach: 0, radar: 0, skippedNoPlan: 0, skippedNoisyStop: 0, skippedAtrZone: 0 };

    for (const it of (items || [])) {
      if (!it || !it.sym) continue;
      stats.scanned++;
      const L = it.levels, T = it.time, A = it.action;
      const base = { sym: it.sym, name: it.name || it.sym, price: r2(it.price) };

      /* الخطة البنيوية شرط لكل تنبيه تنفيذي. وقفٌ داخل ضجيج الجلسة يُنتج
         نسبة عائد/مخاطرة مضخّمة، والتنبيه عليه أسوأ من عدمه. */
      const planOk = !!(L && L.viable && L.riskOk && isNum(L.entryLo) && isNum(L.entryHi) && isNum(L.stop));
      if (L && !planOk) { if (!L.riskOk) stats.skippedNoisyStop++; else stats.skippedNoPlan++; }

      /* ⚠️ منطقة الدخول المشتقّة من ATR تُبنى حول السعر الحالي بالتعريف،
         فالسعر «داخلها» دائماً. تنبيهٌ على ذلك حشو: يقول لك إن السعر داخل
         نطاق رسمناه حول السعر. القياس على 68 سهماً حيّاً أعطى 37 تنبيه
         «منطقة» — أي أكثر من نصف المحمّل، وهذا ما يجعل المستخدم يكتم
         الإشعارات بعد يومين. الحدث الحقيقي هو وصول السعر إلى بنية مرصودة:
         فجوة قيمة عادلة أو كتلة أوامر أو نطاق تأكيد اختراق. */
      const structuralZone = !!(L && L.zoneKind && L.zoneKind !== 'atr');
      if (planOk && !structuralZone && (L.rel === 'inside' || L.rel === 'above')) stats.skippedAtrZone++;

      if (on(KIND.READY) && A && A.action === 'ready' && planOk) {
        out.push(Object.assign({}, base, { kind: KIND.READY, levels: L, time: T || null, action: A }));
        stats.ready++;
        continue;                     /* «مكتملة» تُغني عن «داخل المنطقة» */
      }

      if (on(KIND.ZONE) && planOk && structuralZone && L.rel === 'inside') {
        out.push(Object.assign({}, base, { kind: KIND.ZONE, levels: L, time: T || null }));
        stats.zone++;
        continue;
      }

      if (on(KIND.APPROACH) && planOk && structuralZone && L.rel === 'above' && isNum(L.price) && L.entryHi > 0) {
        const gap = (L.price - L.entryHi) / L.entryHi * 100;
        if (gap > 0 && gap <= approachPct) {
          out.push(Object.assign({}, base, { kind: KIND.APPROACH, levels: L, time: T || null, gapPct: r2(gap) }));
          stats.approach++;
          continue;
        }
      }

      /* الرادار يُبلَّغ وحده حتى بلا خطة، لأنه إخبار عن نافذة زمنية لا دعوة
         تنفيذ — ونصّه يقول ذلك صراحةً. لكنه يشترط دورة فُحص ثباتها. */
      if (on(KIND.RADAR) && T && T.state === 'ok' && T.tier === 'cycle'
        && isNum(T.bars) && T.bars <= horizon
        && T.stabilityTested !== false
        && (!requireUsable || T.usable)) {
        out.push(Object.assign({}, base, { kind: KIND.RADAR, time: T, levels: L || null }));
        stats.radar++;
      }
    }

    out.sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || String(a.sym).localeCompare(String(b.sym)));
    return { ok: true, alerts: out, stats };
  }

  /* ════════════════════════════════════════════════════════════════════
     ② منع التكرار
     ──────────────────────────────────────────────────────────────────
     سهم يبقى داخل منطقة الدخول خمس جلسات لا يستحق خمسة تنبيهات. والمفتاح
     لا يحمل الوقت وحده بل **بصمة الحالة**: حدود المنطقة والوقف مقرّبة.
     فإن تحرّكت الخطة فعلاً (منطقة جديدة، وقف جديد) فهذا حدث جديد يستحق
     تنبيهاً، وإن بقيت كما هي فهو نفس الحدث مهما طال.
     ════════════════════════════════════════════════════════════════════ */
  function signature(a) {
    const L = a.levels;
    if (a.kind === KIND.RADAR) {
      const t = a.time || {};
      return [a.sym, a.kind, t.type || '', Math.round(t.period || 0)].join(':');
    }
    if (!L) return [a.sym, a.kind].join(':');
    /* تقريب إلى ثلاثة أرقام معنوية: تذبذب هللة في حدّ المنطقة ليس خطة
       جديدة، وبلا التقريب يصير كل تحديث حدثاً جديداً فينهمر التنبيه.

       🛠️ الصيغة الأولى كانت `v*1000/|v|` وهي تساوي 1000 لأي عدد موجب —
       أي أن بصمة كل الخطط كانت واحدة، فخطة جديدة تماماً (منطقة ووقف
       مختلفان) تُكتم باعتبارها مكرّرة. كشفه اختبار «تغيّر الخطة حدث
       جديد»، ولولاه لظهر العطل عند المستخدم على هيئة تنبيه لا يصل أبداً
       بعد أول مرة — وهو أسوأ أنواع الأعطال: صامت ويبدو كأن السوق هادئ. */
    const q = v => (isNum(v) && v !== 0 ? Number(v.toPrecision(3)) : 0);
    return [a.sym, a.kind, q(L.entryLo), q(L.entryHi), q(L.stop)].join(':');
  }

  /**
   * @param {Array} alerts
   * @param {Object} store  خريطة {مفتاح: آخر إرسال بالمللي ثانية}
   * @param {{now?:number, cooldownHours?:number, max?:number}} [opt]
   * @returns {{send:Array, suppressed:Array, store:Object}}
   */
  function dedupe(alerts, store, opt) {
    opt = opt || {};
    const now = opt.now == null ? Date.now() : opt.now;
    const cool = (opt.cooldownHours == null ? 20 : opt.cooldownHours) * 3600000;
    const max = opt.max == null ? 8 : opt.max;
    const next = Object.assign({}, store || {});
    const send = [], suppressed = [];

    for (const a of (alerts || [])) {
      const key = signature(a);
      const last = next[key];
      if (isNum(last) && now - last < cool) {
        suppressed.push(Object.assign({}, a, { key, reason: 'أُرسل قبل ' + Math.round((now - last) / 3600000) + ' ساعة' }));
        continue;
      }
      if (send.length >= max) {
        suppressed.push(Object.assign({}, a, { key, reason: 'تجاوز سقف ' + max + ' تنبيهات في الدفعة' }));
        continue;
      }
      send.push(Object.assign({}, a, { key }));
      next[key] = now;
    }

    /* تنظيف المفاتيح القديمة كي لا ينتفخ التخزين بلا حدّ */
    const keep = 14 * 86400000;
    for (const k of Object.keys(next)) if (now - next[k] > keep) delete next[k];

    return { send, suppressed, store: next };
  }

  /* ════════════════════════════════════════════════════════════════════
     ③ الصياغة — نصّ يُتصرَّف به لا نصّ يُقرأ
     ════════════════════════════════════════════════════════════════════ */
  function format(a, opt) {
    opt = opt || {};
    const L = a.levels, T = a.time;
    const lines = [];
    lines.push(`${ICON[a.kind] || '🔔'} ${a.sym} — ${a.name}`);
    lines.push(LABEL[a.kind] || a.kind);
    if (isNum(a.price)) lines.push(`السعر ${a.price}`);

    if (L && L.viable && L.riskOk) {
      lines.push(`منطقة الدخول ${L.entryLo} – ${L.entryHi}`);
      lines.push(`الوقف ${L.stop} (مخاطرة ${L.risk} = ${L.riskATR}×ATR)`);
      const tg = (L.targets || []).filter(t => isNum(t.price));
      if (tg.length) lines.push('الأهداف ' + tg.map((t, i) => `${i + 1}) ${t.price}${t.rr != null ? ` — 1:${t.rr}` : ''}${t.kind === 'fractal' ? ' (فراكتالي)' : ''}`).join(' · '));
      if (a.kind === KIND.APPROACH && a.gapPct != null) lines.push(`السعر أعلى من المنطقة بـ${a.gapPct}٪ — لم يدخلها بعد`);
    }

    if (a.kind === KIND.RADAR && T) {
      lines.push(`دورة ${T.period} جلسة (p = ${T.p})`);
      lines.push(`${T.type === 'valley' ? 'قاع متوقَّع' : 'قمة متوقَّعة'} بعد ${T.bars} جلسة${T.sd != null ? ` ± ${T.sd}` : ''}`);
      lines.push('نافذة زمنية للمراقبة — ليست دعوة دخول، والدخول يفتحه السعر لا التاريخ.');
    }

    if (a.kind === KIND.READY && a.action) {
      if (a.action.action_ar) lines.push(a.action.action_ar);
      const st = (a.action.steps || [])[0];
      if (st) lines.push('شرط التأكيد: ' + String(st).replace(/^شرط التأكيد الإلزامي:\s*/, ''));
    }

    lines.push('— تحليل آلي، ليس توصية. القرار ومسؤوليته عليك.');
    if (opt.url) lines.push(opt.url);
    return lines.join('\n');
  }

  /** عنوان قصير لإشعار المتصفّح (سطر واحد). */
  function shortText(a) {
    const L = a.levels;
    if (a.kind === KIND.RADAR && a.time)
      return `${a.sym} · ${a.time.type === 'valley' ? 'قاع' : 'قمة'} بعد ${a.time.bars} جلسة`;
    if (L && L.viable && L.riskOk)
      return `${a.sym} · ${L.entryLo}–${L.entryHi} · وقف ${L.stop}${L.rr1 != null ? ` · 1:${L.rr1}` : ''}`;
    return `${a.sym} · ${LABEL[a.kind] || a.kind}`;
  }

  return { VERSION, version: VERSION, KIND, PRIORITY, LABEL, ICON, evaluate, dedupe, signature, format, shortText };
});
