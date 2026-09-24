#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   scripts/plantest.js — هل لخطة الدخول/الوقف/الهدف أفضلية على السوق الحقيقي؟
   ──────────────────────────────────────────────────────────────────────────
   عند نقاط معايَنة يُحسب tradeLevels من البيانات المعروفة حتى تلك النقطة
   فقط. إن كان الحكم «ادخل» (enter_now / enter_at_market) والخطة مجدية،
   يُحاكى الدخول عند إغلاق الجلسة، ثم يُمشى إلى الأمام حتى MAXB جلسة: أيّهما
   يُلمس أولاً، الوقف أم الهدف الأول؟ (لمسهما في الجلسة نفسها يُحتسب وقفاً —
   ترتيبهما داخل الجلسة غير معلوم من بيانات يومية.)

   مقارنتان:
   • التعادل: خطة نسبتها r تربح فقط إن تجاوزت الإصابة 1/(1+r).
   • وضع عشوائي: المسافتان نفسهما (الوقف٪ والهدف٪) مطبّقتين على كل نقاط
     السهم نفسه. الفرق بينهما هو قيمة «وضع» المستويات بنيوياً، مفصولةً عن
     مجرّد نسبة المسافتين.
   الوحدة الإحصائية للدلالة: السهم (اختبار إشارة)، لا الصفقة.

     node scripts/plantest.js --from snapshot.json.gz
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const { createAppContext } = require('../engine/appvm.js');
const { loadInto } = require('./fetch.js');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = val('from', ''), JSON_OUT = val('json', '');
const LIMIT = parseInt(val('limit', '0'), 10) || 0;
const STEP = parseInt(val('step', '10'), 10);
const MAXB = parseInt(val('maxbars', '60'), 10);
const log = (...a) => console.log(...a);

/** يمشي إلى الأمام: 1 = الهدف أولاً، −1 = الوقف أولاً، 0 = لا هذا ولا ذاك. */
function walk(cs, t, stop, target, maxb) {
  for (let j = t + 1; j <= Math.min(cs.length - 1, t + maxb); j++) {
    const hitS = cs[j].low <= stop, hitT = cs[j].high >= target;
    if (hitS) return { r: -1, bars: j - t };          /* الاثنان معاً ⇒ وقف */
    if (hitT) return { r: 1, bars: j - t };
  }
  return { r: 0, bars: maxb };
}
function signTestP(k, n) {
  if (!n) return 1;
  const lnC = (a, b) => { let s = 0; for (let i = 1; i <= b; i++) s += Math.log((a - b + i) / i); return s; };
  const kk = Math.max(k, n - k); let tail = 0;
  for (let i = kk; i <= n; i++) tail += Math.exp(lnC(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}
const q = (arr, p) => { const v = arr.slice().sort((a, b) => a - b); if (!v.length) return null; return +v[Math.floor((v.length - 1) * p)].toFixed(2); };

(async () => {
  const { ctx } = createAppContext();
  const G = ctx.G;
  let syms = ctx.STKS.map(s => s.sym);
  if (LIMIT) syms = syms.slice(0, LIMIT);
  const L = await loadInto(ctx, syms, { range: '5y', minBars: 400, concurrency: 5, from: FROM });
  const live = Object.keys(G.cans).filter(s => !G.demo.has(s) && G.cans[s].length >= 400);
  log(`اختبار الخطط على ${live.length} سهماً · خطوة ${STEP} · أقصى ${MAXB} جلسة${L.takenAt ? ' · لقطة ' + L.takenAt : ''}`);

  const groups = {};                       /* key → {trades:[], perStock:{}} */
  const add = (key, sym, tr) => {
    const g = groups[key] || (groups[key] = { trades: [], perStock: {} });
    g.trades.push(tr);
    const s = g.perStock[sym] || (g.perStock[sym] = { R: 0, Rrand: 0, n: 0 });
    s.R += tr.R; s.Rrand += tr.Rrand; s.n++;
  };
  const t0 = Date.now(); let evald = 0;
  for (const sym of live) {
    const cs = G.cans[sym], n = cs.length;
    const lo = 260, hi = n - 2;
    for (let t = lo; t <= hi; t += STEP) {
      const past = cs.slice(0, t + 1);
      G.cans.__p = past; G.pr.__p = past[t].close; delete G.ind.__p;
      let Lv = null;
      try { ctx.calcInd('__p'); Lv = ctx.tradeLevels('__p'); } catch (e) { }
      evald++;
      if (!Lv || !Lv.viable || !Lv.riskOk || !Lv.targets || !Lv.targets.length) continue;
      if (Lv.verdict !== 'enter_now' && Lv.verdict !== 'enter_at_market') continue;
      const entry = past[t].close, stop = Lv.stop, T1 = Lv.targets[0].price;
      if (!(stop < entry && T1 > entry)) continue;
      if (t + 5 > n - 1) continue;
      const res = walk(cs, t, stop, T1, MAXB);
      const rr = (T1 - entry) / (entry - stop);
      /* الوضع العشوائي: المسافتان النسبيتان نفسهما من كل نقطة أخرى في السهم */
      const sp = (entry - stop) / entry, tp = (T1 - entry) / entry;
      let rw = 0, rl = 0, rn = 0;
      for (let u = lo; u <= n - 2; u += 5) {
        const e = cs[u].close, w = walk(cs, u, e * (1 - sp), e * (1 + tp), MAXB);
        if (w.r > 0) rw++; else if (w.r < 0) rl++; rn++;
      }
      const R = res.r > 0 ? rr : res.r < 0 ? -1 : ((cs[Math.min(n - 1, t + MAXB)].close - entry) / (entry - stop));
      const Rrand = rn ? (rw * rr - rl) / rn : 0;       /* المتوقَّع بوضع عشوائي (بلا المفتوحة) */
      const tr = { R, Rrand, win: res.r > 0, loss: res.r < 0, rr, bars: res.bars, randWin: rn ? rw / rn : 0 };
      add('الكل', sym, tr);
      add(Lv.verdict === 'enter_now' ? 'ادخل الآن (عند بنية)' : 'ادخل عند السعر (بلا بنية)', sym, tr);
      add('المنطقة: ' + (Lv.zoneKind || '?'), sym, tr);
    }
  }
  delete G.cans.__p; delete G.ind.__p; delete G.pr.__p;
  log(`(${evald} نقطة قُيّمت · ${((Date.now() - t0) / 1000).toFixed(0)} ث)\n`);

  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const T = g.trades, N = T.length;
    const wins = T.filter(x => x.win).length, losses = T.filter(x => x.loss).length;
    const meanR = T.reduce((a, x) => a + x.R, 0) / N, meanRand = T.reduce((a, x) => a + x.Rrand, 0) / N;
    const be = T.reduce((a, x) => a + 1 / (1 + x.rr), 0) / N;
    const randWin = T.reduce((a, x) => a + x.randWin, 0) / N;
    const S = Object.values(g.perStock).filter(s => s.n >= 2);
    const beat = S.filter(s => s.R > s.Rrand).length;
    const pos = S.filter(s => s.R > 0).length;
    out[k] = { N, winPct: +(100 * wins / N).toFixed(1), lossPct: +(100 * losses / N).toFixed(1), breakevenPct: +(100 * be).toFixed(1),
      randWinPct: +(100 * randWin).toFixed(1), meanR: +meanR.toFixed(3), meanRandR: +meanRand.toFixed(3), rrMed: q(T.map(x => x.rr), .5),
      barsMed: q(T.map(x => x.bars), .5), stocks: S.length, beatRandom: beat, pBeat: +signTestP(beat, S.length).toPrecision(2),
      positive: pos, pPos: +signTestP(pos, S.length).toPrecision(2) };
    const o = out[k];
    log(`━━ ${k} — ${N} صفقة من ${S.length} سهماً ━━`);
    log(`  إصابة الهدف الأول ${o.winPct}٪ · وقف ${o.lossPct}٪ · مفتوحة ${(100 - o.winPct - o.lossPct).toFixed(1)}٪ · وسيط النسبة 1:${o.rrMed} · وسيط المدة ${o.barsMed} جلسة`);
    log(`  نقطة التعادل ${o.breakevenPct}٪ · الوضع العشوائي بالمسافتين نفسيهما يصيب ${o.randWinPct}٪`);
    log(`  متوسط العائد ${o.meanR > 0 ? '+' : ''}${o.meanR}R مقابل ${o.meanRandR > 0 ? '+' : ''}${o.meanRandR}R للوضع العشوائي`);
    log(`  أسهم تفوّقت فيها على الوضع العشوائي: ${beat}/${S.length} (p=${o.pBeat}) · أسهم بعائد موجب: ${pos}/${S.length} (p=${o.pPos})\n`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  log('✓ انتهى اختبار الخطط');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
