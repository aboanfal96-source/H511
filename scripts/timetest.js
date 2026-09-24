#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   scripts/timetest.js — هل للفلتر الزمني قيمة على السوق الحقيقي؟
   ──────────────────────────────────────────────────────────────────────────
   دراسة حدث بلا تسرّب زمني: نمشي عبر تاريخ كل سهم، وعند كل نقطة t نبني
   المواعيد من البيانات المعروفة حتى t فقط، ثم نسأل التاريخ اللاحق: هل وقع
   انعطاف حقيقي عند الموعد أكثر مما يقع في أي جلسة عشوائية؟

   الانعطاف الحقيقي = أعلى قمة أو أدنى قاع في ±DEPTH جلسة (يُعرف بعد
   وقوعه فقط — وهو «الحقيقة» التي يُقاس عليها التنبؤ، لا مدخل له).

   الرفع (lift) = نسبة الإصابة عند المواعيد ÷ نسبة الإصابة الأساسية.
   رفع ≈ 1 يعني أن الموعد لا يحمل معلومة: الانعطاف يقع عنده بنفس تواتر
   وقوعه في أي يوم.

     node scripts/timetest.js --from snapshot.json.gz
     node scripts/timetest.js                (من الشبكة)
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const { createAppContext } = require('../engine/appvm.js');
const { loadInto } = require('./fetch.js');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = val('from', '');
const LIMIT = parseInt(val('limit', '0'), 10) || 0;
const STEP = parseInt(val('step', '10'), 10);
const DEPTH = parseInt(val('depth', '10'), 10);     /* نصف عرض الانعطاف الحقيقي */
const TOL = parseInt(val('tol', '1'), 10);          /* ± جلسات حول الموعد */
const TAT = args.indexOf('--no-tat') < 0;
/* الفلتر يعيد حساب المؤشرات على كل سلسلة مقطوعة (~0.1 ث للنقطة)، فيُعايَن
   على عيّنة: كل سهم رقم k من TAT_EVERY، وكل TAT_STEP جلسة. */
const TAT_EVERY = parseInt(val('tat-every', '3'), 10);
const TAT_STEP = parseInt(val('tat-step', '20'), 10);

const log = (...a) => console.log(...a);

/** انعطافات حقيقية: أعلى قمة/أدنى قاع في ±d — تُحسب على السلسلة كاملة. */
function trueTurns(cs, d) {
  const isT = new Uint8Array(cs.length);
  for (let i = d; i < cs.length - d; i++) {
    let H = true, L = true;
    for (let j = i - d; j <= i + d; j++) {
      if (j === i) continue;
      if (cs[j].high >= cs[i].high) H = false;
      if (cs[j].low <= cs[i].low) L = false;
      if (!H && !L) break;
    }
    if (H || L) isT[i] = 1;
  }
  return isT;
}
const near = (isT, j, tol) => { for (let k = j - tol; k <= j + tol; k++) if (isT[k]) return true; return false; };

/** فاصل Wilson 95٪ لنسبة. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [+(100 * (c - h)).toFixed(1), +(100 * (c + h)).toFixed(1)];
}
const row = (name, k, n, base) => {
  const r = n ? k / n : 0, ci = wilson(k, n);
  log(`${name.padEnd(38)} ${String(k).padStart(6)}/${String(n).padEnd(7)} ${(100 * r).toFixed(1).padStart(5)}٪ [${ci[0]}–${ci[1]}]  رفع ${base ? (r / base).toFixed(2) : '—'}`);
  return { k, n, rate: +(100 * r).toFixed(2), ci, lift: base ? +(r / base).toFixed(3) : null };
};

(async () => {
  const { ctx } = createAppContext();
  const G = ctx.G, E = ctx.KSAEngine;
  let syms = ctx.STKS.map(s => s.sym);
  if (LIMIT) syms = syms.slice(0, LIMIT);
  const L = await loadInto(ctx, syms, { range: '5y', minBars: 400, concurrency: 5, from: FROM });
  const live = Object.keys(G.cans).filter(s => !G.demo.has(s) && G.cans[s].length >= 400);
  log(`دراسة حدث على ${live.length} سهماً · خطوة ${STEP} · انعطاف ±${DEPTH} · تسامح ±${TOL}${L.takenAt ? ' · لقطة ' + L.takenAt : ''}`);

  const acc = {
    base: [0, 0],
    fib: [0, 0], gann: [0, 0], self: [0, 0], nearest: [0, 0], confl: [0, 0],
    tatOn: [0, 0], tatOff: [0, 0], snipOn: [0, 0],
    fwdUpOn: [0, 0], fwdUpOff: [0, 0], fwdUpSnip: [0, 0]
  };
  const nearestBars = [];
  const t0 = Date.now();
  for (let si = 0; si < live.length; si++) {
    const sym = live[si];
    const cs = G.cans[sym], n = cs.length;
    const isT = trueTurns(cs, DEPTH);
    const lo = 260, hi = n - Math.max(DEPTH, 12) - 1;
    for (let j = lo; j <= hi; j++) { acc.base[1]++; if (near(isT, j, TOL)) acc.base[0]++; }

    for (let t = lo; t <= hi - 5; t += STEP) {
      const past = cs.slice(0, t + 1);
      let anchors = [];
      try { anchors = ctx._timeAnchors(past); } catch (e) { }
      const dates = [];
      for (const a of anchors) {
        let w = [];
        try { w = E.timeWindows(past, { i: a.i, price: a.p, type: a.type }, { horizonDays: 240 }); } catch (e) { }
        for (const x of w) {
          const j = t + x.barsAhead;
          if (j > hi) continue;
          dates.push({ j, src: x.source, a: a.i });
          const key = x.source === 'fib' ? 'fib' : x.source === 'gann' ? 'gann' : 'self';
          acc[key][1]++; if (near(isT, j, TOL)) acc[key][0]++;
        }
      }
      if (dates.length) {
        /* ما يعرضه العمود فعلاً: أقرب نافذة قادمة عبر كل المراسي */
        const nd = dates.reduce((m, d) => d.j < m.j ? d : m);
        nearestBars.push(nd.j - t);
        acc.nearest[1]++; if (near(isT, nd.j, TOL)) acc.nearest[0]++;
        /* تلاقٍ: موعدان من مرساتين مختلفتين خلال ±1 جلسة */
        const seenJ = new Set();
        for (const d of dates) {
          if (seenJ.has(d.j)) continue;
          if (dates.some(e => e.a !== d.a && Math.abs(e.j - d.j) <= 1)) {
            seenJ.add(d.j);
            acc.confl[1]++; if (near(isT, d.j, TOL)) acc.confl[0]++;
          }
        }
      }

      if (TAT && si % TAT_EVERY === 0 && (t - lo) % TAT_STEP < STEP) {
        /* فلتر «⏱ توافق زمني»: هل يقع الانعطاف حول «الآن» حين يقول ذلك؟ */
        G.cans.__t = past; delete G.ind.__t;
        let tat = null;
        try { ctx.calcInd('__t'); tat = ctx.timeAlignmentTrigger(past, G.ind.__t); } catch (e) { }
        if (tat) {
          const hit = near(isT, t, 2);
          const up = cs[t + 10] && cs[t + 10].close > cs[t].close;
          if (tat.active) {
            acc.tatOn[1]++; if (hit) acc.tatOn[0]++;
            if (tat.dirUp != null) { acc.fwdUpOn[1]++; if (up === !!tat.dirUp) acc.fwdUpOn[0]++; }
          } else {
            acc.tatOff[1]++; if (hit) acc.tatOff[0]++;
            acc.fwdUpOff[1]++; if (up) acc.fwdUpOff[0]++;
          }
          if (tat.sniperBonus) {
            acc.snipOn[1]++; if (hit) acc.snipOn[0]++;
            acc.fwdUpSnip[1]++; if (up === !!tat.dirUp) acc.fwdUpSnip[0]++;
          }
        }
      }
    }
  }
  delete G.cans.__t; delete G.ind.__t;
  log(`(${((Date.now() - t0) / 1000).toFixed(0)} ث)\n`);

  const base = acc.base[0] / acc.base[1];
  const out = {};
  log('━━ النوافذ الكلاسيكية: هل يقع الانعطاف عند الموعد؟ ━━');
  out.base = row('خط الأساس (أي جلسة)', acc.base[0], acc.base[1], base);
  out.fib = row('فيبوناتشي زمني (جلسات)', acc.fib[0], acc.fib[1], base);
  out.gann = row('غان تقويمي (أيام)', acc.gann[0], acc.gann[1], base);
  out.self = row('دورة السهم الذاتية', acc.self[0], acc.self[1], base);
  out.nearest = row('أقرب نافذة (ما يعرضه العمود)', acc.nearest[0], acc.nearest[1], base);
  out.confl = row('تلاقي مرساتين (±1)', acc.confl[0], acc.confl[1], base);
  const nb = nearestBars.sort((a, b) => a - b);
  log(`بُعد أقرب نافذة بالجلسات: وسيط ${nb[Math.floor(nb.length / 2)]} · ربع أعلى ${nb[Math.floor(nb.length * .75)]} · 90٪ ${nb[Math.floor(nb.length * .9)]}`);

  if (TAT) {
    const b2 = (acc.tatOn[0] + acc.tatOff[0]) / Math.max(1, acc.tatOn[1] + acc.tatOff[1]);
    log('\n━━ فلتر «⏱ توافق زمني»: انعطاف خلال ±2 من الآن ━━');
    out.tatOff = row('الفلتر صامت', acc.tatOff[0], acc.tatOff[1], b2);
    out.tatOn = row('الفلتر نشط', acc.tatOn[0], acc.tatOn[1], b2);
    out.snipOn = row('قنّاص زمني', acc.snipOn[0], acc.snipOn[1], b2);
    const bu = acc.fwdUpOff[0] / Math.max(1, acc.fwdUpOff[1]);
    log('\n━━ الاتجاه: صعود بعد 10 جلسات في الاتجاه المعلن ━━');
    out.fwdOff = row('صامت: نسبة الصعود الأساسية', acc.fwdUpOff[0], acc.fwdUpOff[1], bu);
    out.fwdOn = row('نشط: الاتجاه المعلن صدق', acc.fwdUpOn[0], acc.fwdUpOn[1], bu);
    out.fwdSnip = row('قنّاص: الاتجاه المعلن صدق', acc.fwdUpSnip[0], acc.fwdUpSnip[1], bu);
  }
  const fs = require('fs'); const jp = val('json', '');
  if (jp) fs.writeFileSync(jp, JSON.stringify(out, null, 1));
  log('\n✓ انتهت الدراسة');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
