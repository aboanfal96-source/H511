/* ══════════════════════════════════════════════════════════════════════════
   KSASchools — هدف ووقف لكل مدرسة تحليل، كلٌّ بقاعدتها هي
   ──────────────────────────────────────────────────────────────────────────
   الغرض ليس جمع أرقام كثيرة، بل عكس ذلك تماماً: أن يرى القارئ **أين تتفق
   المدارس وأين تختلف**. اتفاق خمس مدارس على مستوى واحد معلومة قوية، واتفاق
   واحدة فقط معلومة أيضاً — والفرق بينهما لا يظهر إلا حين تُعرض كلها بجانب
   بعضها بقواعدها المعلنة.

   ثلاث قواعد حاكمة:
   ① لا هدف مخترع. كل رقم يخرج من قاعدة المدرسة نفسها، ومصدره مكتوب في
     الحقل `basis`. المدرسة التي لا تُنتج هدفاً تقول ذلك صراحةً بسبب —
     ولا يُملأ الفراغ بمضاعف ثابت.
   ② لا مدرسة تُقدَّم على أخرى بلا دليل. لا وزن ولا «درجة ثقة»: الترتيب
     بقرب الهدف من السعر، والقارئ يرى الإجماع بعينه.
   ③ ما يُشتقّ من كاشف موجود في المنصة يُستدعى لا يُعاد كتابته، كي لا
     تتباعد نسختان من إليوت أو الهارمونيك.

   ⚠️ وحدّ يجب أن يُقال: هذه مدارس **وصفية**. لم تُقس نسبة إصابة أيٍّ منها
   على السوق السعودي هنا، وعرضها بجانب بعضها لا يعني أنها متساوية في
   الجدارة. الرقم الاحتمالي الوحيد في المنصة يخرج من «قياس أثر البوابات».
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KSASchools = api;
})(this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const isNum = v => typeof v === 'number' && isFinite(v);
  const r2 = v => (isNum(v) ? Math.round(v * 100) / 100 : null);
  const last = a => (a && a.length ? a[a.length - 1] : null);

  /* ── أدوات مشتركة ───────────────────────────────────────────────────── */
  function atr(cs, p) {
    p = p || 14;
    if (!cs || cs.length < p + 1) return null;
    let s = 0;
    for (let i = cs.length - p; i < cs.length; i++) {
      const pc = cs[i - 1].close;
      s += Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - pc), Math.abs(cs[i].low - pc));
    }
    return s / p;
  }

  /** محاور مؤكَّدة: تتطلّب k شمعة على كل جانب، فلا محور «حيّ» ينقلب لاحقاً. */
  function pivots(cs, k) {
    k = k || 3;
    const H = [], L = [];
    for (let i = k; i < cs.length - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (cs[j].high >= cs[i].high) isH = false;
        if (cs[j].low <= cs[i].low) isL = false;
      }
      if (isH) H.push({ i, p: cs[i].high });
      if (isL) L.push({ i, p: cs[i].low });
    }
    return { H, L };
  }

  function ema(vals, p) {
    const k = 2 / (p + 1); let e = vals[0]; const out = [e];
    for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
    return out;
  }

  const mk = (key, name, o) => Object.assign({
    key, name, ok: false, target: null, target2: null, stop: null,
    basis: '', reason: '', dir: 'up'
  }, o || {});

  /* ════════════════════════════════════════════════════════════════════
     المدارس
     ══════════════════════════════════════════════════════════════════ */

  /** ① البنية السعرية — أقرب مقاومة هدفاً وأقرب دعم وقفاً. */
  function structure(cs, o) {
    const sr = o.sr;
    if (!sr || !sr.resistances) return mk('structure', 'البنية السعرية', { reason: 'لم تُحسب مستويات الدعم والمقاومة' });
    const above = sr.resistances.filter(r => r.price > o.price).sort((a, b) => a.price - b.price);
    const below = sr.supports.filter(r => r.price < o.price).sort((a, b) => b.price - a.price);
    if (!above.length) return mk('structure', 'البنية السعرية', { reason: 'لا مقاومة فوق السعر ضمن التاريخ المحمّل — اكتشاف سعري' });
    return mk('structure', 'البنية السعرية', {
      ok: true, target: r2(above[0].price), target2: above[1] ? r2(above[1].price) : null,
      stop: below[0] ? r2(below[0].price * 0.995) : null,
      basis: `أقرب مقاومة (${(above[0].sources || []).join(' + ') || 'مستوى بنيوي'})${below[0] ? ` · الوقف تحت أقرب دعم ${r2(below[0].price)}` : ''}`
    });
  }

  /** ② الفراكتال (بيل ويليامز) — أقرب قمة فراكتالية حيّة لم تُكسر. */
  function fractal(cs, o) {
    const fr = o.fractalTargets;
    if (!fr || !fr.ok) return mk('fractal', 'الفراكتال', { reason: (fr && fr.reason) || 'تعذّر حساب الفراكتلات' });
    if (fr.target1 == null) return mk('fractal', 'الفراكتال', { reason: 'لا قمة فراكتالية غير مكسورة فوق السعر' });
    return mk('fractal', 'الفراكتال', {
      ok: true, target: r2(fr.target1), target2: r2(fr.target2),
      stop: fr.support != null ? r2(fr.support * 0.995) : null,
      basis: 'أقرب قمة فراكتالية لم تُكسر بإغلاق' + (fr.support != null ? ` · الوقف تحت آخر قاع فراكتالي ${r2(fr.support)}` : '')
    });
  }

  /** ③ فيبوناتشي — امتدادات آخر موجة مؤكَّدة. */
  function fibonacci(cs, o) {
    const pv = pivots(cs, 3);
    /* 🛠️ الموجة المقيسة هي آخر ضلع صاعد مكتمل: قمة مؤكَّدة وقبلها قاع
       مؤكَّد. النسخة الأولى كانت تشترط قمة **بعد** آخر قاع، فترفض أشيع
       حالة يُستعمل فيها فيبوناتشي أصلاً — ارتداد جارٍ بعد قمة. */
    const H = last(pv.H);
    if (!H) return mk('fibonacci', 'فيبوناتشي', { reason: 'لا قمة مؤكَّدة في التاريخ المحمّل — لا موجة تُقاس' });
    const L = last(pv.L.filter(l => l.i < H.i));
    if (!L) return mk('fibonacci', 'فيبوناتشي', { reason: 'لا قاع مؤكَّد قبل القمة — لا موجة تُقاس' });
    const leg = H.p - L.p;
    if (!(leg > 0)) return mk('fibonacci', 'فيبوناتشي', { reason: 'طول الموجة صفري' });
    const t1 = L.p + leg * 1.272, t2 = L.p + leg * 1.618;
    const r786 = H.p - leg * 0.786;
    /* ارتداد أعمق من 78.6٪ يُبطل الموجة بمعيار فيبوناتشي نفسه — ووضع
       ذلك المستوى «وقفاً» حينها يعطي وقفاً فوق السعر. */
    if (o.price < r786) return mk('fibonacci', 'فيبوناتشي', {
      reason: `السعر ${r2(o.price)} تحت ارتداد 78.6٪ (${r2(r786)}) من موجة ${r2(L.p)} ← ${r2(H.p)} — الموجة باطلة بمعيار فيبوناتشي`
    });
    const targets = [H.p, t1, t2].filter(v => v > o.price).sort((a, b) => a - b);
    if (!targets.length) return mk('fibonacci', 'فيبوناتشي', { reason: `السعر تجاوز امتداد 1.618 (${r2(t2)}) — لا هدف فيبوناتشي أعلى ضمن هذه الموجة` });
    return mk('fibonacci', 'فيبوناتشي', {
      ok: true, target: r2(targets[0]), target2: targets[1] != null ? r2(targets[1]) : null,
      stop: r2(r786),
      basis: `موجة ${r2(L.p)} ← ${r2(H.p)} · الأهداف: القمة ${r2(H.p)} ثم امتداد 1.272 (${r2(t1)}) و1.618 (${r2(t2)}) · الوقف تحت ارتداد 78.6٪`
    });
  }

  /** ④ إليوت — من كاشف المنصة نفسه. */
  function elliott(cs, o) {
    const ew = o.elliott;
    if (!ew || ew.wave === 0) return mk('elliott', 'إليوت', { reason: (ew && ew.why) || 'لا عدّ إليوت صالح' });
    const t = ew.target && ew.target.price, t2 = ew.target2 && ew.target2.price;
    if (!isNum(t)) return mk('elliott', 'إليوت', { reason: 'العدّ صالح لكنه بلا هدف سعري' });
    return mk('elliott', 'إليوت', {
      ok: true, target: r2(t), target2: isNum(t2) ? r2(t2) : null,
      stop: ew.stop && isNum(ew.stop.price) ? r2(ew.stop.price) : null,
      dir: ew.bullBias ? 'up' : 'down',
      basis: `${ew.desc || 'عدّ إليوت'} · ${(ew.target && ew.target.label) || ''}${ew.stop ? ` · ${ew.stop.label}` : ''}`
    });
  }

  /** ⑤ الهارمونيك — أهداف D القياسية. */
  function harmonic(cs, o) {
    const h = o.harmonic;
    if (!h || !h.targets) return mk('harmonic', 'الهارمونيك', { reason: 'لا نموذج هارمونيك مكتمل' });
    const tg = h.targets;
    const cands = [tg.t1, tg.t2, tg.t3].filter(v => isNum(v) && v > o.price).sort((a, b) => a - b);
    if (!cands.length) return mk('harmonic', 'الهارمونيك', { reason: `السعر تجاوز كل أهداف النموذج (أبعدها ${r2(Math.max(tg.t1, tg.t2, tg.t3))})` });
    return mk('harmonic', 'الهارمونيك', {
      ok: true, target: r2(cands[0]), target2: cands[1] != null ? r2(cands[1]) : null,
      stop: isNum(tg.sl) ? r2(tg.sl) : null,
      basis: `نموذج ${h.name || ''} · أهداف ارتداد 38.2٪ و61.8٪ من الضلع AD ثم النقطة A${h.stale ? ' · ⚠ النموذج قديم' : ''}`
    });
  }

  /** ⑥ موجة الذئب — خط 1-4 الممتد (EPA). */
  function wolfe(cs, o) {
    const w = o.wolfe;
    if (!w || !w.valid) return mk('wolfe', 'موجة الذئب', { reason: 'لا موجة ذئب صالحة' });
    if (!w.target || !isNum(w.target.price)) return mk('wolfe', 'موجة الذئب', { reason: 'النموذج بلا هدف محسوب' });
    if (w.reached) return mk('wolfe', 'موجة الذئب', { reason: `السعر بلغ خط EPA (${r2(w.target.price)}) — الحركة تحقّقت` });
    return mk('wolfe', 'موجة الذئب', {
      ok: true, target: r2(w.target.price), stop: w.stop && isNum(w.stop.price) ? r2(w.stop.price) : null,
      dir: w.bullish ? 'up' : 'down',
      basis: 'خط 1-4 الممتد (EPA) · الوقف خلف النقطة 5'
    });
  }

  /** ⑦ القناة السعرية — حدّ القناة ثم عرضها عند الاختراق. */
  function channel(cs, o) {
    const c = o.channel;
    if (!c || !c.valid) return mk('channel', 'القناة السعرية', { reason: 'لم تتكوّن قناة من محاور مؤكَّدة' });
    const t = c.resAtLast > o.price ? c.resAtLast : c.breakoutUpTarget;
    if (!isNum(t) || t <= o.price) return mk('channel', 'القناة السعرية', { reason: 'السعر فوق حدّ القناة وهدف الاختراق معاً' });
    return mk('channel', 'القناة السعرية', {
      ok: true, target: r2(t),
      target2: c.resAtLast > o.price && isNum(c.breakoutUpTarget) ? r2(c.breakoutUpTarget) : null,
      stop: isNum(c.supAtLast) ? r2(c.supAtLast) : null,
      basis: `قناة ${c.shape || ''} · ${c.resAtLast > o.price ? `الهدف حدّ القناة العلوي ${r2(c.resAtLast)}` : `الهدف عرض القناة فوق الاختراق (${r2(c.width)})`} · الوقف عند الحدّ السفلي`
    });
  }

  /** ⑧ وايكوف — الحركة المقيسة لنطاق التجميع.
      ⚠️ تبسيط معلن: وايكوف الأصلي يقيس «السبب» بعدّ نقطة ورقم على شبكة
      P&F. هنا يُقاس ارتفاع النطاق ويُسقط فوق حدّه — وهي الصيغة المقيسة
      الشائعة، لا العدّ الكامل. والفرق مذكور كي لا يُنسب إلينا ما لم نفعله. */
  function wyckoff(cs, o) {
    const A = o.atr;
    if (!cs || cs.length < 60 || !isNum(A) || A <= 0) return mk('wyckoff', 'وايكوف', { reason: 'شموع غير كافية لتحديد نطاق' });
    /* أطول نطاق عرضي حديث: نوسّع النافذة إلى الوراء ما دام الارتفاع محدوداً */
    const n = cs.length;
    let best = null;
    for (const win of [40, 60, 90, 120]) {
      if (n < win + 5) continue;
      const seg = cs.slice(n - win);
      const hi = Math.max.apply(null, seg.map(c => c.high));
      const lo = Math.min.apply(null, seg.map(c => c.low));
      const height = hi - lo;
      if (!(height > 0)) continue;
      /* «عرضي» = الارتفاع لا يتجاوز 6×ATR، وإلا فهو اتجاه لا نطاق */
      if (height > 6 * A) continue;
      /* التذبذب داخل النطاق: نصف الشموع على الأقل داخل الثلثين الأوسطين */
      const inner = seg.filter(c => c.close > lo + height * 0.15 && c.close < hi - height * 0.15).length;
      if (inner / seg.length < 0.45) continue;
      if (!best || win > best.win) best = { win, hi, lo, height };
    }
    if (!best) return mk('wyckoff', 'وايكوف', { reason: 'لا نطاق تجميع/توزيع واضح — السهم في اتجاه لا في نطاق، ولا سبب يُقاس' });
    const target = best.hi + best.height;
    if (o.price > best.hi + best.height) return mk('wyckoff', 'وايكوف', { reason: `الحركة المقيسة (${r2(target)}) تحقّقت — السعر تجاوزها` });
    return mk('wyckoff', 'وايكوف', {
      ok: true, target: r2(target), target2: null, stop: r2(best.lo * 0.995),
      basis: `نطاق ${best.win} جلسة بين ${r2(best.lo)} و${r2(best.hi)} · الحركة المقيسة = ارتفاع النطاق (${r2(best.height)}) فوق حدّه · الوقف تحت قاع النطاق`
        + ' · تبسيط: ارتفاع النطاق بدل عدّ نقطة ورقم'
    });
  }

  /** ⑨ سوبرترند — نظام وقف متحرّك، وهو صريح في أنه بلا هدف ثابت.
      🛠️ النسخة الأولى كانت تُصفّر الحدّين داخل الحلقة فتفقد الحالة
      السابقة، والصيغة القياسية تعتمد عليها صراحةً. والأسوأ أنها كانت
      تُعيد الخط وقفاً حتى في الاتجاه الهابط — والخط حينها **فوق** السعر،
      أي مقاومة لا وقف شراء. كشفه اختبار «الوقف دائماً تحت السعر». */
  function supertrend(cs, o) {
    const P = 10, M = 3;
    if (!cs || cs.length < P + 5) return mk('supertrend', 'سوبرترند', { reason: 'شموع غير كافية' });
    let fUp = null, fLo = null, up = true;
    for (let i = P; i < cs.length; i++) {
      let tr = 0;
      for (let j = i - P + 1; j <= i; j++) {
        const pc = cs[j - 1].close;
        tr += Math.max(cs[j].high - cs[j].low, Math.abs(cs[j].high - pc), Math.abs(cs[j].low - pc));
      }
      const a = tr / P, mid = (cs[i].high + cs[i].low) / 2;
      const bUp = mid + M * a, bLo = mid - M * a, pc = cs[i - 1].close;
      fUp = (fUp == null || bUp < fUp || pc > fUp) ? bUp : fUp;
      fLo = (fLo == null || bLo > fLo || pc < fLo) ? bLo : fLo;
      if (up && cs[i].close < fLo) up = false;
      else if (!up && cs[i].close > fUp) up = true;
    }
    const line = up ? fLo : fUp;
    if (!isNum(line)) return mk('supertrend', 'سوبرترند', { reason: 'تعذّر حساب الخط' });
    if (!up) return mk('supertrend', 'سوبرترند', {
      dir: 'down',
      reason: `الاتجاه هابط والخط عند ${r2(line)} فوق السعر — هذا مستوى انعكاس لا وقف شراء. المدرسة لا تعطي إشارة صعودية قبل إغلاق فوقه.`
    });
    return mk('supertrend', 'سوبرترند', {
      ok: true, target: null, stop: r2(line), dir: 'up',
      basis: `الخط الصاعد عند ${r2(line)} (ATR 10 × 3)`,
      reason: 'مدرسة وقف متحرّك بلا هدف ثابت: الخروج عند انعكاس الخط لا عند سعر محدّد. عرضُ هدف لها اختراع لا تحليل.'
    });
  }

  /** ⑩ إيتشيموكو — كيجن وقفاً، والهدف حساب E الكلاسيكي. */
  function ichimoku(cs, o) {
    if (!cs || cs.length < 60) return mk('ichimoku', 'إيتشيموكو', { reason: 'يتطلّب 60 جلسة فأكثر' });
    const hh = (a, p, i) => Math.max.apply(null, a.slice(i - p + 1, i + 1).map(c => c.high));
    const ll = (a, p, i) => Math.min.apply(null, a.slice(i - p + 1, i + 1).map(c => c.low));
    const i = cs.length - 1;
    const tenkan = (hh(cs, 9, i) + ll(cs, 9, i)) / 2;
    const kijun = (hh(cs, 26, i) + ll(cs, 26, i)) / 2;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (hh(cs, 52, i) + ll(cs, 52, i)) / 2;
    const cloudTop = Math.max(spanA, spanB), cloudBot = Math.min(spanA, spanB);
    const above = o.price > cloudTop;
    if (!above) return mk('ichimoku', 'إيتشيموكو', {
      reason: `السعر ${o.price > cloudBot ? 'داخل السحابة' : 'تحت السحابة'} (${r2(cloudBot)}–${r2(cloudTop)}) — المدرسة لا تعطي هدفاً صعودياً قبل الخروج فوقها`
    });
    /* حساب E: ضعف القمة ناقص القاع للموجة الأخيرة */
    const pv = pivots(cs, 3);
    const H = last(pv.H), L = last(pv.L);
    let target = null, how = '';
    if (H && L && H.p > L.p) { target = 2 * H.p - L.p; how = `حساب E = 2×${r2(H.p)} − ${r2(L.p)}`; }
    if (!isNum(target) || target <= o.price) { target = o.price + (cloudTop - cloudBot); how = `سُمك السحابة (${r2(cloudTop - cloudBot)}) فوق السعر`; }
    return mk('ichimoku', 'إيتشيموكو', {
      ok: true, target: r2(target), stop: r2(Math.max(kijun, cloudTop)),
      basis: `السعر فوق السحابة · ${how} · الوقف عند كيجن-سِن ${r2(kijun)} أو قمة السحابة${r2(cloudTop) !== r2(kijun) ? ` (${r2(cloudTop)})` : ''} أيّهما أعلى`
    });
  }

  /** ⑪ ملف الحجم — حدّ منطقة القيمة العليا ثم أعلى تكتّل فوقه. */
  function volumeProfile(cs, o) {
    const vp = o.volumeProfile;
    /* أسماء الحقول في KSAEngine.volumeProfile هي valueAreaLow/High لا
       val/vah، والدالة تُرجع null لا كائناً فيه ok. قراءتها بأسماء أخرى
       كانت تُظهر «تعذّر بناء ملف الحجم» على بيانات سليمة تماماً. */
    if (!vp) return mk('volumeProfile', 'ملف الحجم', { reason: 'تعذّر بناء ملف الحجم (شموع غير كافية أو بلا أحجام)' });
    const poc = vp.poc, vah = vp.valueAreaHigh != null ? vp.valueAreaHigh : vp.vah, val = vp.valueAreaLow != null ? vp.valueAreaLow : vp.val;
    const cands = [vah, poc].filter(v => isNum(v) && v > o.price).sort((a, b) => a - b);
    if (!cands.length) return mk('volumeProfile', 'ملف الحجم', { reason: `السعر فوق منطقة القيمة (قمتها ${r2(vah)}) — لا عائق حجمي أعلى ضمن التاريخ المحمّل` });
    return mk('volumeProfile', 'ملف الحجم', {
      ok: true, target: r2(cands[0]), target2: cands[1] != null ? r2(cands[1]) : null,
      stop: isNum(val) ? r2(val * 0.995) : null,
      basis: `نقطة التحكّم ${r2(poc)} · منطقة القيمة ${r2(val)}–${r2(vah)} (${vp.valueAreaPct != null ? vp.valueAreaPct + '٪ من الحجم' : ''}) · الوقف تحت حدّها الأدنى`
    });
  }

  /** ⑫ داو — القمة السابقة هدفاً، وآخر قاع أعلى وقفاً. */
  function dow(cs, o) {
    const pv = pivots(cs, 3);
    if (pv.H.length < 2 || pv.L.length < 2) return mk('dow', 'داو (هيكل الاتجاه)', { reason: 'محاور مؤكَّدة غير كافية لقراءة الهيكل' });
    const H = pv.H.slice(-2), L = pv.L.slice(-2);
    const hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
    if (!(hh && hl)) return mk('dow', 'داو (هيكل الاتجاه)', {
      reason: `الهيكل ليس صاعداً (${hh ? 'قمم صاعدة' : 'قمم هابطة'} · ${hl ? 'قيعان صاعدة' : 'قيعان هابطة'}) — داو لا يعطي هدفاً صعودياً`
    });
    /* 🛠️ داو نفسها تقول إن الاتجاه الصاعد ينكسر بإغلاق تحت آخر قاع أعلى.
       فإن كان السعر تحته فالهيكل المرصود تاريخ لا حاضر، ووضع ذلك القاع
       «وقفاً» يعطي وقفاً فوق السعر — أي صفقة مخسِرة قبل أن تبدأ. */
    if (!(o.price > L[1].p)) return mk('dow', 'داو (هيكل الاتجاه)', {
      reason: `السعر ${r2(o.price)} تحت آخر قاع أعلى (${r2(L[1].p)}) — الهيكل الصاعد انكسر بمعيار داو نفسه`
    });
    const above = pv.H.map(h => h.p).filter(p => p > o.price).sort((a, b) => a - b);
    const t = above.length ? above[0] : H[1].p + (H[1].p - L[1].p);
    return mk('dow', 'داو (هيكل الاتجاه)', {
      ok: true, target: r2(t), stop: r2(L[1].p * 0.995),
      basis: `اتجاه صاعد: قمم وقيعان صاعدة · ${above.length ? 'الهدف أقرب قمة سابقة لم تُكسر' : 'الهدف امتداد الموجة الأخيرة فوق القمة'} · الوقف تحت آخر قاع أعلى ${r2(L[1].p)}`
    });
  }

  /** ⑬ مناطق السيولة (SMC) — أقرب تجمّع سيولة فوق السعر. */
  function smc(cs, o) {
    const lq = o.liquidity;
    if (!lq) return mk('smc', 'مناطق السيولة', { reason: 'لم تُحسب بنية السيولة' });
    const pv = pivots(cs, 3);
    const above = pv.H.map(h => h.p).filter(p => p > o.price * 1.002).sort((a, b) => a - b);
    if (!above.length) return mk('smc', 'مناطق السيولة', { reason: 'لا تجمّع سيولة (قمة مؤكَّدة) فوق السعر' });
    const zone = lq.zone || (lq.zones || []).filter(z => z.top <= o.price * 1.02).sort((a, b) => b.top - a.top)[0];
    return mk('smc', 'مناطق السيولة', {
      ok: true, target: r2(above[0]), target2: above[1] != null ? r2(above[1]) : null,
      stop: zone ? r2(zone.bot * 0.995) : null,
      basis: `السيولة المستهدفة فوق قمة ${r2(above[0])}${zone ? ` · الوقف تحت ${zone.kind === 'FVG' ? 'فجوة القيمة العادلة' : 'كتلة الأوامر'} ${r2(zone.bot)}–${r2(zone.top)}` : ' · لا بنية سيولة حيّة لاشتقاق وقف'}`
    });
  }

  const SCHOOLS = [structure, fractal, fibonacci, elliott, harmonic, wolfe,
    channel, wyckoff, supertrend, ichimoku, volumeProfile, dow, smc];

  /**
   * @param {Array} cs شموع يومية
   * @param {{price?:number, sr?:object, elliott?:object, harmonic?:object,
   *          wolfe?:object, channel?:object, fractalTargets?:object,
   *          volumeProfile?:object, liquidity?:object}} [ext]
   * @returns {{ok, price, rows:Array, agreed:Array, nearest:object|null, stats:object}}
   */
  function schoolTargets(cs, ext) {
    ext = ext || {};
    if (!cs || cs.length < 30) return { ok: false, reason: `عيّنة ${cs ? cs.length : 0} جلسة — تحتاج 30+`, rows: [] };
    const price = isNum(ext.price) ? ext.price : cs[cs.length - 1].close;
    const o = Object.assign({}, ext, { price, atr: atr(cs, 14) });

    const rows = SCHOOLS.map(fn => {
      let row;
      try { row = fn(cs, o); }
      catch (e) { return mk(fn.name, fn.name, { reason: 'خطأ في الحساب: ' + e.message }); }

      /* ══ حارس مركزي على عقد الصفّ ══════════════════════════════════
         🛠️ تكرّر العطل نفسه في ثلاث مدارس مستقلّة: مستوى مرجعي يُعاد
         «وقفاً» وهو فوق السعر — قاع داو بعد كسره، وارتداد 78.6٪ بعد
         تجاوزه، وحدّ منطقة القيمة حين يهبط السعر تحتها. ووقف فوق السعر
         ليس رقماً خاطئاً فحسب: هو صفقة خاسرة قبل أن تبدأ، ويُفسد أي
         حساب لحجم المركز يُبنى عليه.

         عولجت كل حالة في مدرستها بقاعدتها الخاصة، ويبقى هذا الحارس
         شبكةَ أمان للعقد نفسه: مدرسة جديدة تُضاف لاحقاً لن تكسره. */
      if (isNum(row.target) && row.target <= price) {
        row.ok = false;
        row.reason = row.reason || `الهدف المحسوب (${r2(row.target)}) عند السعر أو تحته — لا هدف صعودي`;
        row.target = null; row.target2 = null;
      }
      if (isNum(row.target2) && row.target2 <= price) row.target2 = null;
      if (isNum(row.stop) && row.stop >= price) {
        row.stopDropped = r2(row.stop);
        row.stop = null;
        row.basis = (row.basis ? row.basis + ' · ' : '')
          + `⚠ المستوى المرجعي للوقف (${row.stopDropped}) فوق السعر الآن فلا يصلح وقفاً — استُبعد`;
      }
      return row;
    });

    const withTarget = rows.filter(r => r.ok && isNum(r.target) && r.target > price);
    withTarget.sort((a, b) => a.target - b.target);
    const ordered = withTarget.concat(rows.filter(r => withTarget.indexOf(r) < 0));

    /* التجمّع: أهداف ضمن 1.5٪ من بعضها تُعدّ إجماعاً على منطقة واحدة.
       هذا أهمّ ما في اللوحة — اتفاق أربع مدارس على مستوى أقوى بكثير من
       أبعد هدف تعطيه واحدة. */
    const clusters = [];
    for (const r of withTarget) {
      const c = clusters.find(c => Math.abs(c.center - r.target) / c.center <= 0.015);
      if (c) { c.members.push(r); c.center = c.members.reduce((s, m) => s + m.target, 0) / c.members.length; }
      else clusters.push({ center: r.target, members: [r] });
    }
    clusters.sort((a, b) => b.members.length - a.members.length || a.center - b.center);
    const agreed = clusters.filter(c => c.members.length >= 2).map(c => ({
      price: r2(c.center), count: c.members.length,
      schools: c.members.map(m => m.name),
      lo: r2(Math.min.apply(null, c.members.map(m => m.target))),
      hi: r2(Math.max.apply(null, c.members.map(m => m.target)))
    }));

    const stops = rows.filter(r => isNum(r.stop) && r.stop < price).map(r => r.stop);

    return {
      ok: true, price: r2(price), rows: ordered,
      nearest: withTarget[0] || null,
      agreed,
      stats: {
        total: rows.length,
        withTarget: withTarget.length,
        noTarget: rows.length - withTarget.length,
        stopHigh: stops.length ? r2(Math.max.apply(null, stops)) : null,
        stopLow: stops.length ? r2(Math.min.apply(null, stops)) : null
      },
      caveat: 'هذه مدارس وصفية لم تُقس نسبة إصابتها على هذا السوق. عرضها معاً يُظهر الإجماع والاختلاف، ولا يعني تساويها في الجدارة.'
    };
  }

  return { VERSION, version: VERSION, schoolTargets, pivots, atr };
});
