#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   scripts/filtertest.js — بطاقة أداء كل فلتر على السوق الحقيقي
   ──────────────────────────────────────────────────────────────────────────
   عند نقاط معايَنة من تاريخ كل سهم يُحسب كل فلتر من البيانات المعروفة حتى
   تلك النقطة فقط (calcAllFilters على سلسلة مقطوعة)، ثم يُسأل التاريخ اللاحق:
   ماذا فعل السعر خلال H جلسة، في الاتجاه الذي أعلنه الفلتر؟

   مقياسان لأن كلاً منهما يخدع وحده:
   • العائد الزائد: متوسط عائد H جلسة حين يطلق الفلتر، ناقص متوسط عائد
     السهم نفسه في كل النقاط (فلا يُحسب ارتفاع السوق كلّه ميزةً للفلتر).
   • الاتساق عبر الأسهم: في كم سهماً تفوّق الفلتر على خط أساس ذلك السهم؟
     وحدة القياس السهم لا الصفقة — لأن إشارات السهم الواحد متكتّلة
     ومتداخلة زمنياً، وعدّها مستقلة يضخّم الدلالة. ويُختبر بإشارة ثنائية
     (sign test) مقابل 50٪.

     node scripts/filtertest.js --from snapshot.json.gz [--h 10] [--step 10]
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const { createAppContext } = require('../engine/appvm.js');
const { loadInto } = require('./fetch.js');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = val('from', ''), JSON_OUT = val('json', '');
const LIMIT = parseInt(val('limit', '0'), 10) || 0;
const H = parseInt(val('h', '10'), 10);
const STEP = parseInt(val('step', '10'), 10);
const EVERY = parseInt(val('every', '1'), 10);
const MIN_EVENTS_PER_STOCK = 2;
const log = (...a) => console.log(...a);

/* كل فلتر: دالة تعيد +1 (صاعد) أو −1 (هابط) أو 0 (صامت). */
const FILTERS = {
  'حجم شاذ vz': r => r.vz && r.vz.alert ? (r.vz.bullish ? 1 : -1) : 0,
  'تسارع زخم ma': r => r.ma && r.ma.alert ? (r.ma.accel > 0 ? 1 : -1) : 0,
  'قوة نسبية rs': r => r.rs && r.rs.alert ? (r.rs.rs > 1 ? 1 : -1) : 0,
  'انضغاط/انطلاق بولنجر sq': r => r.sq && r.sq.alert ? (r.sq.hist > 0 ? 1 : -1) : 0,
  'امتصاص ab': r => r.ab && r.ab.alert ? (r.ab.score > 0 ? 1 : -1) : 0,
  'فجوة FVG fg': r => r.fg && r.fg.alert ? ((r.fg.nearest && r.fg.nearest.type === 'bu') ? 1 : -1) : 0,
  'سيولة خفية hidden': r => r.hidden && r.hidden.alert ? 1 : 0,
  'ما قبل الفجوة pregap': r => r.pregap && r.pregap.alert ? 1 : 0,
  'إعادة توازن fvgr': r => r.fvgr && r.fvgr.alert ? ((r.fvgr.rebalance && r.fvgr.rebalance.type === 'bu') ? 1 : -1) : 0,
  'إليوت ew (وصفي)': r => r.ew && r.ew.sig === 'شراء' ? 1 : (r.ew && r.ew.sig === 'بيع' ? -1 : 0),
  'توافقي harm': r => r.harm && r.harm.sig === 'شراء' ? 1 : (r.harm && r.harm.sig === 'بيع' ? -1 : 0),
  'صائد النسبة hunter': r => r.hunter && r.hunter.alert ? 1 : 0,
  'فيبو 61.8 مؤكد': r => r.fib618 && r.fib618.confirmed ? 1 : 0,
  'اختراق كاذب': r => r.falseBreak && r.falseBreak.active ? (r.falseBreak.bullish ? 1 : -1) : 0,
  'تقاطع ماكد': r => r.macdX && r.macdX.active ? (r.macdX.bullish ? 1 : -1) : 0,
  'حجم مؤسسي': r => r.instVol && r.instVol.active ? (r.instVol.bullish ? 1 : -1) : 0,
  'شمعة انعكاس': r => r.revCandle && r.revCandle.active ? (r.revCandle.bullish ? 1 : -1) : 0,
  'قاع الحيتان sb': r => r.sb && r.sb.alert ? 1 : 0,
  'قنّاص ما قبل الاختراق': r => r.snp && r.snp.level === 'high' ? (r.snp.dirUp ? 1 : -1) : 0,
  '⏱ قنّاص زمني (وصفي)': r => r.tat && r.tat.sniperBonus ? (r.tat.dirUp ? 1 : -1) : 0,
  'الإشارة: شراء فأقوى': r => /شراء/.test(r.sig || '') ? 1 : 0,
  'الإشارة: بيع فأقوى': r => /بيع/.test(r.sig || '') ? -1 : 0,
  'السكور الموحّد ≥ 65': r => r.masterScore >= 65 ? 1 : 0,
  'السكور الموحّد ≤ 35': r => r.masterScore <= 35 ? -1 : 0
};

/** اختبار الإشارة الثنائي: احتمال k نجاحاً أو أكثر من n عند 0.5 (ذيلان). */
function signTestP(k, n) {
  if (!n) return 1;
  const lnC = (a, b) => { let s = 0; for (let i = 1; i <= b; i++) s += Math.log((a - b + i) / i); return s; };
  const kk = Math.max(k, n - k);
  let tail = 0;
  for (let i = kk; i <= n; i++) tail += Math.exp(lnC(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

(async () => {
  const { ctx } = createAppContext();
  const G = ctx.G;
  let syms = ctx.STKS.map(s => s.sym);
  if (LIMIT) syms = syms.slice(0, LIMIT);
  const L = await loadInto(ctx, syms, { range: '5y', minBars: 400, concurrency: 5, from: FROM });
  const live = Object.keys(G.cans).filter(s => !G.demo.has(s) && G.cans[s].length >= 400);

  /* عائد السوق لـ20 جلسة عند كل تاريخ — كما يحسبه المسح الشامل، لكن
     من البيانات المعروفة حتى ذلك التاريخ فقط */
  const rocBy = new Map();
  for (const s of live) {
    const c = G.cans[s];
    for (let i = 20; i < c.length; i++) {
      const k = c[i].time, r = (c[i].close - c[i - 20].close) / c[i - 20].close * 100;
      const e = rocBy.get(k) || [0, 0]; e[0] += r; e[1]++; rocBy.set(k, e);
    }
  }
  const mROC = t => { const e = rocBy.get(t); return e && e[1] ? e[0] / e[1] : 0; };

  log(`بطاقة الفلاتر على ${Math.ceil(live.length / EVERY)} سهماً · أفق ${H} جلسة · خطوة ${STEP}${L.takenAt ? ' · لقطة ' + L.takenAt : ''}`);
  /* per[filter][sym] = {sum, n, hits, expHits} */
  const per = {}; for (const f of Object.keys(FILTERS)) per[f] = {};
  const t0 = Date.now(); let pts = 0;
  for (let si = 0; si < live.length; si += EVERY) {
    const sym = live[si], cs = G.cans[sym], n = cs.length;
    const lo = 260, hi = n - H - 1;
    const rows = [];
    for (let t = lo; t <= hi; t += STEP) {
      const past = cs.slice(0, t + 1);
      G.cans.__f = past; delete G.ind.__f;
      let r = null;
      try { ctx.calcInd('__f'); r = ctx.calcAllFilters('__f', mROC(cs[t].time)); } catch (e) { }
      if (!r) continue;
      rows.push({ r, fwd: (cs[t + H].close - cs[t].close) / cs[t].close * 100 });
      pts++;
    }
    if (!rows.length) continue;
    const base = rows.reduce((a, x) => a + x.fwd, 0) / rows.length;
    const pUp = rows.filter(x => x.fwd > 0).length / rows.length;
    for (const [f, fn] of Object.entries(FILTERS)) {
      for (const x of rows) {
        let d = 0; try { d = fn(x.r) || 0; } catch (e) { }
        if (!d) continue;
        const P = per[f][sym] || (per[f][sym] = { sum: 0, n: 0, hits: 0, exp: 0 });
        P.sum += d * (x.fwd - base);           /* العائد الزائد في الاتجاه المعلن */
        P.n++;
        if (d * x.fwd > 0) P.hits++;
        P.exp += d > 0 ? pUp : 1 - pUp;
      }
    }
    if (((si / EVERY) + 1) % 40 === 0) log(`  … ${(si / EVERY) + 1} سهماً · ${pts} نقطة · ${((Date.now() - t0) / 1000).toFixed(0)} ث`);
  }
  delete G.cans.__f; delete G.ind.__f;
  log(`(${pts} نقطة · ${((Date.now() - t0) / 1000).toFixed(0)} ث)\n`);

  const out = [];
  for (const f of Object.keys(FILTERS)) {
    const S = Object.values(per[f]);
    const N = S.reduce((a, x) => a + x.n, 0);
    if (!N) { out.push({ f, N: 0 }); continue; }
    const ex = S.reduce((a, x) => a + x.sum, 0) / N;
    const hit = S.reduce((a, x) => a + x.hits, 0) / N, exp = S.reduce((a, x) => a + x.exp, 0) / N;
    const qual = S.filter(x => x.n >= MIN_EVENTS_PER_STOCK);
    const win = qual.filter(x => x.sum > 0).length;
    out.push({ f, N, stocks: S.length, excessPct: +ex.toFixed(3), hit: +(100 * hit).toFixed(1), expected: +(100 * exp).toFixed(1),
      stockN: qual.length, stockWins: win, stockWinPct: qual.length ? +(100 * win / qual.length).toFixed(1) : null,
      p: +signTestP(win, qual.length).toPrecision(2) });
  }
  out.sort((a, b) => (b.stockWinPct == null ? -1 : 0) - (a.stockWinPct == null ? -1 : 0) || (b.stockWinPct || 0) - (a.stockWinPct || 0));

  log(`${'الفلتر'.padEnd(26)} ${'إشارات'.padStart(7)}  ${'عائد زائد٪'.padStart(10)}  ${'إصابة/متوقَّع'.padStart(14)}  أسهم تفوّق فيها (p)`);
  for (const o of out) {
    if (!o.N) { log(`${o.f.padEnd(26)}       0  —  لم يطلق`); continue; }
    const tag = o.p < 0.01 && o.stockWinPct > 50 ? '  ✅' : o.p < 0.01 && o.stockWinPct < 50 ? '  ⛔ عكسي' : (o.p < 0.05 ? '  ·' : '');
    log(`${o.f.padEnd(26)} ${String(o.N).padStart(7)}  ${(o.excessPct > 0 ? '+' : '') + o.excessPct.toFixed(2).padStart(9)}  ${(o.hit + '/' + o.expected).padStart(14)}  ${o.stockWins}/${o.stockN} = ${o.stockWinPct}٪ (p=${o.p})${tag}`);
  }
  log('\n✅ = تفوّق في أغلبية الأسهم بدلالة p<0.01 · ⛔ = عكس اتجاهه المعلن بدلالة · بلا علامة = لا يختلف عن الصدفة');
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  log('\n✓ انتهت البطاقة');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
