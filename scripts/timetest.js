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
const STEP = parseInt(val('step', '20'), 10);
/* timeWindows يعيد حساب دورة السهم الذاتية على السلسلة كاملة في كل نداء
   (~0.1 ث)، فتُعايَن الأسهم: كل سهم رقم k من EVERY. عيّنة 128 سهماً × 50
   نقطة × ~15 موعداً ≈ 100 ألف مشاهدة — أكثر من كافٍ لقياس الرفع. */
const EVERY = parseInt(val('every', '2'), 10);
const DEPTH = parseInt(val('depth', '10'), 10);     /* نصف عرض الانعطاف الحقيقي */
const TOL = parseInt(val('tol', '1'), 10);          /* ± جلسات حول الموعد */
const TAT = args.indexOf('--no-tat') < 0;
const CLASSIC = args.indexOf('--tat-only') < 0;
/* الفلتر يعيد حساب المؤشرات على كل سلسلة مقطوعة (~0.1 ث للنقطة)، فيُعايَن
   على عيّنة: كل سهم رقم k من TAT_EVERY، وكل TAT_STEP جلسة. */
const TAT_EVERY = parseInt(val('tat-every', '2'), 10);
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
  const report = (label) => {
    const b = acc.base[0] / Math.max(1, acc.base[1]);
    const f = k => acc[k][1] ? `${(100 * acc[k][0] / acc[k][1]).toFixed(1)}٪ (رفع ${(acc[k][0] / acc[k][1] / b).toFixed(2)}, n=${acc[k][1]})` : '—';
    log(`  [${label}] أساس ${(100 * b).toFixed(1)}٪ · فيبو ${f('fib')} · غان ${f('gann')} · أقرب ${f('nearest')} · تلاقٍ ${f('confl')}`);
  };
  let done = 0;
  for (let si = 0; si < live.length; si++) {
    if (si % EVERY) continue;
    const sym = live[si];
    const cs = G.cans[sym], n = cs.length;
    const isT = trueTurns(cs, DEPTH);
    const lo = 260, hi = n - Math.max(DEPTH, 12) - 1;
    for (let j = lo; j <= hi; j++) { acc.base[1]++; if (near(isT, j, TOL)) acc.base[0]++; }
    /* نسبة الصعود الأساسية لهذا السهم نفسه: الاتجاه المعلن يُقاس على
       الاتجاه نفسه في السهم نفسه، لا على متوسط سوق هبط خلال الفترة */
    let upN = 0, upK = 0;
    for (let j = lo; j <= hi - 10; j++) { upN++; if (cs[j + 10].close > cs[j].close) upK++; }
    const pUp = upN ? upK / upN : 0.5;

    for (let t = lo; t <= hi - 5; t += STEP) {
      const past = cs.slice(0, t + 1);
      let anchors = [];
      if (CLASSIC) try { anchors = ctx._timeAnchors(past); } catch (e) { }
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

      if (TAT && done % TAT_EVERY === 0 && (t - lo) % TAT_STEP < STEP) {
        /* فلتر «⏱ توافق زمني»: هل يقع الانعطاف حول «الآن» حين يقول ذلك؟ */
        G.cans.__t = past; delete G.ind.__t;
        let tat = null;
        try { ctx.calcInd('__t'); tat = ctx.timeAlignmentTrigger(past, G.ind.__t); } catch (e) { }
        if (tat) {
          const hit = near(isT, t, 2);
          const up = cs[t + 10] && cs[t + 10].close > cs[t].close;
          /* المتوقَّع بالصدفة لاتجاهٍ معلن = نسبة ذلك الاتجاه في السهم نفسه */
          const expect = d => d ? pUp : 1 - pUp;
          const kind = tat.sniperBonus ? 'snip' : (tat.penalty ? 'pen' : (tat.active ? 'oth' : 'off'));
          const H = acc['turn_' + kind] || (acc['turn_' + kind] = [0, 0]);
          H[1]++; if (hit) H[0]++;
          if (kind !== 'off' && tat.dirUp != null) {
            const D = acc['dir_' + kind] || (acc['dir_' + kind] = [0, 0, 0]);
            D[1]++; if (up === !!tat.dirUp) D[0]++; D[2] += expect(!!tat.dirUp);
          }
        }
      }
    }
    /* نتيجة جزئية دورياً: لو انتهت مهلة التشغيل لا يضيع كل شيء */
    if (++done % 16 === 0) report(`${done} سهماً · ${((Date.now() - t0) / 1000).toFixed(0)} ث`);
  }
  delete G.cans.__t; delete G.ind.__t;
  log(`(${((Date.now() - t0) / 1000).toFixed(0)} ث)\n`);

  const base = acc.base[0] / acc.base[1];
  const out = {};
  if (CLASSIC) {
  log('━━ النوافذ الكلاسيكية: هل يقع الانعطاف عند الموعد؟ ━━');
  out.base = row('خط الأساس (أي جلسة)', acc.base[0], acc.base[1], base);
  out.fib = row('فيبوناتشي زمني (جلسات)', acc.fib[0], acc.fib[1], base);
  out.gann = row('غان تقويمي (أيام)', acc.gann[0], acc.gann[1], base);
  out.self = row('دورة السهم الذاتية', acc.self[0], acc.self[1], base);
  out.nearest = row('أقرب نافذة (ما يعرضه العمود)', acc.nearest[0], acc.nearest[1], base);
  out.confl = row('تلاقي مرساتين (±1)', acc.confl[0], acc.confl[1], base);
  const nb = nearestBars.sort((a, b) => a - b);
  log(`بُعد أقرب نافذة بالجلسات: وسيط ${nb[Math.floor(nb.length / 2)]} · ربع أعلى ${nb[Math.floor(nb.length * .75)]} · 90٪ ${nb[Math.floor(nb.length * .9)]}`);
  }

  if (TAT) {
    const T = k => acc['turn_' + k] || [0, 0];
    const tot = ['off', 'snip', 'pen', 'oth'].reduce((a, k) => [a[0] + T(k)[0], a[1] + T(k)[1]], [0, 0]);
    const b2 = tot[0] / Math.max(1, tot[1]);
    log('\n━━ فلتر «⏱ توافق زمني»: انعطاف خلال ±2 من الآن ━━');
    out.turnOff = row('الفلتر صامت', T('off')[0], T('off')[1], b2);
    out.turnSnip = row('قنّاص زمني (مكافأة +20)', T('snip')[0], T('snip')[1], b2);
    out.turnPen = row('كسر دورة (عقوبة −10)', T('pen')[0], T('pen')[1], b2);
    log('\n━━ الاتجاه المعلن بعد 10 جلسات — مقابل نسبة ذلك الاتجاه في السهم نفسه ━━');
    for (const [k, name] of [['snip', 'قنّاص زمني'], ['pen', 'كسر دورة']]) {
      const D = acc['dir_' + k] || [0, 0, 0];
      const obs = D[1] ? D[0] / D[1] : 0, exp = D[1] ? D[2] / D[1] : 0, ci = wilson(D[0], D[1]);
      log(`${name.padEnd(38)} صدق ${D[0]}/${D[1]} = ${(100 * obs).toFixed(1)}٪ [${ci[0]}–${ci[1]}] · المتوقَّع بالصدفة ${(100 * exp).toFixed(1)}٪ · رفع ${exp ? (obs / exp).toFixed(2) : '—'}`);
      out['dir_' + k] = { k: D[0], n: D[1], obs: +(100 * obs).toFixed(2), expected: +(100 * exp).toFixed(2), ci, lift: exp ? +(obs / exp).toFixed(3) : null };
    }
  }
  const fs = require('fs'); const jp = val('json', '');
  if (jp) fs.writeFileSync(jp, JSON.stringify(out, null, 1));
  log('\n✓ انتهت الدراسة');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
