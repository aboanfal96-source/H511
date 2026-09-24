#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   scripts/diag.js — تشخيص المنصّة على بيانات السوق الحقيقية
   ──────────────────────────────────────────────────────────────────────────
   كل قياس سابق كان على بيانات اصطناعية، لأن بيئة التطوير لا تصل إلى مصدر
   الأسعار. هذه الأداة تشغّل المنصّة كاملةً (سكربت index.html نفسه) على
   السوق الحقيقي، وتطبع لكل طبقة: كم سهماً مرّ، وكم سقط، ولماذا.

   الغاية كشف ما لا تكشفه الاختبارات: فلتر لا يطلق أبداً على سوق حقيقي،
   أو يطلق على كل شيء، أو نسبة عائد/مخاطرة غير معقولة، أو فرق بين سعر
   المصدر وسعر الشمعة.

     node scripts/diag.js                     (من الشبكة)
     node scripts/diag.js --snapshot s.json.gz (ويحفظ البيانات الخام)
     node scripts/diag.js --from s.json.gz     (على لقطة، بلا شبكة)
     node scripts/diag.js --json out.json      (والنتائج آلياً)
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const { createAppContext } = require('../engine/appvm.js');
const { loadInto, writeSnapshot } = require('./fetch.js');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = val('from', ''), SNAPSHOT = val('snapshot', ''), JSON_OUT = val('json', '');
const LIMIT = parseInt(val('limit', '0'), 10) || 0;
const NO_TIME = args.indexOf('--no-time') >= 0;

const log = (...a) => console.log(...a);
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '٪' : '—';
function q(arr, p) {
  const v = arr.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return +(v[lo] + (v[hi] - v[lo]) * (i - lo)).toFixed(2);
}
const dist = arr => arr.length ? `n=${arr.filter(x => x != null && isFinite(x)).length} · وسيط ${q(arr, .5)} · ربع أعلى ${q(arr, .75)} · 90٪ ${q(arr, .9)} · أقصى ${q(arr, 1)}` : '—';
const tally = (arr) => { const o = {}; for (const k of arr) o[k] = (o[k] || 0) + 1; return o; };
const fmtTally = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' · ');
const H = t => log('\n\x1b[1m━━ ' + t + ' ━━\x1b[0m');

(async () => {
  const out = {};
  const { ctx } = createAppContext();
  const G = ctx.G;
  let syms = ctx.STKS.map(s => s.sym);
  if (LIMIT) syms = syms.slice(0, LIMIT);

  const t0 = Date.now();
  const L = await loadInto(ctx, syms, { range: '5y', minBars: 120, concurrency: 5, from: FROM });
  log(`حُمّل ${L.ok} من ${syms.length} · فشل ${L.failed.length} · ${((Date.now() - t0) / 1000).toFixed(1)} ث${L.takenAt ? ' · لقطة ' + L.takenAt : ''}`);
  L.failed.slice(0, 10).forEach(f => log('  ⚠ ' + f));
  if (SNAPSHOT) { writeSnapshot(SNAPSHOT, L.raw, { range: '5y' }); log('حُفظت اللقطة: ' + SNAPSHOT); }
  const live = Object.keys(G.cans).filter(s => !G.demo.has(s) && G.cans[s] && G.cans[s].length >= 120);
  const N = live.length;
  out.loaded = N; out.marketOpen = ctx.marketOpen();

  /* ── ١. البيانات: الحداثة وتطابق السعر ─────────────────────────────── */
  H('١. البيانات');
  const lastDay = live.map(s => { const c = G.cans[s]; return new Date(c[c.length - 1].time * 1000).toISOString().slice(0, 10); });
  log('تاريخ آخر شمعة: ' + fmtTally(tally(lastDay)));
  const bars = live.map(s => G.cans[s].length);
  log('طول السلسلة: ' + dist(bars));
  const gaps = live.map(s => G.prGap[s]).filter(Boolean);
  const gapPct = live.filter(s => G.prGap[s]).map(s => Math.abs(G.prGap[s].quote - G.pr[s]) / G.pr[s] * 100);
  log(`السوق ${out.marketOpen ? 'مفتوح' : 'مغلق'} · مصدر السعر: ${fmtTally(tally(live.map(s => G.prSrc[s] || '?')))}`);
  log(`فرق المصدر عن الشمعة: ${gaps.length} سهماً (${pct(gaps.length, N)}) · من الجلسة نفسها ${gaps.filter(g => g.sameSession).length} · حجم الفرق ٪: ${dist(gapPct)}`);
  const big = live.filter(s => G.prGap[s] && Math.abs(G.prGap[s].quote - G.pr[s]) / G.pr[s] > 0.01).slice(0, 6);
  big.forEach(s => log(`  ${s}: شمعة ${G.pr[s]} · مصدر ${G.prGap[s].quote}`));
  out.data = { lastDay: tally(lastDay), gaps: gaps.length, gapPct: { med: q(gapPct, .5), max: q(gapPct, 1) } };

  /* ── ٢. الفلاتر: كم سهماً يطلق كل فلتر ─────────────────────────────── */
  H('٢. الفلاتر (تبويبات القائمة)');
  /* كما في runFullScan: متوسط عائد 20 جلسة على كل الأسهم المحمّلة */
  let tot = 0, cnt = 0;
  for (const s of live) { const c = G.cans[s], n = c.length; if (n > 20) { tot += (c[n - 1].close - c[n - 21].close) / c[n - 21].close * 100; cnt++; } }
  const marketROC = cnt ? tot / cnt : 0;
  const F = {};
  for (const s of live) { try { F[s] = ctx.calcAllFilters(s, marketROC); } catch (e) { F[s] = null; } }
  const fired = {
    'حجم شاذ vz': r => r.vz && r.vz.alert, 'تسارع زخم ma': r => r.ma && r.ma.alert, 'قوة نسبية rs': r => r.rs && r.rs.alert,
    'انضغاط بولنجر sq': r => r.sq && r.sq.alert, 'امتصاص ab': r => r.ab && r.ab.alert, 'فجوة FVG fg': r => r.fg && r.fg.alert,
    'سيولة خفية hidden': r => r.hidden && r.hidden.alert, 'ما قبل الفجوة pregap': r => r.pregap && r.pregap.alert,
    'إعادة توازن fvgr': r => r.fvgr && r.fvgr.alert, 'إليوت ew': r => r.ew && (r.ew.sig === 'شراء' || r.ew.sig === 'بيع'),
    'توافقي harm': r => r.harm && (r.harm.sig === 'شراء' || r.harm.sig === 'بيع'), 'صائد النسبة hunter': r => r.hunter && r.hunter.alert,
    'فيبو 61.8 مؤكد': r => r.fib618 && r.fib618.confirmed, 'اختراق كاذب': r => r.falseBreak && r.falseBreak.active,
    'تقاطع ماكد': r => r.macdX && r.macdX.active, 'حجم مؤسسي': r => r.instVol && r.instVol.active,
    'شمعة انعكاس': r => r.revCandle && r.revCandle.active, 'قاع الحيتان sb': r => r.sb && r.sb.alert,
    '⏱ توافق زمني (active)': r => r.tat && r.tat.active, '⏱ قنّاص زمني (sniperBonus)': r => r.tat && r.tat.sniperBonus,
    '⏱ كسر دورة (penalty)': r => r.tat && r.tat.penalty, '🎯 قنّاص ما قبل الاختراق high': r => r.snp && r.snp.level === 'high'
  };
  out.filters = {};
  const ok = live.filter(s => F[s]);
  for (const [name, fn] of Object.entries(fired)) {
    const n = ok.filter(s => { try { return !!fn(F[s]); } catch (e) { return false; } }).length;
    out.filters[name] = n;
    const flag = n === 0 ? '  ⛔ لا يطلق' : (n / ok.length > 0.5 ? '  ⚠ يطلق على الأغلبية' : '');
    log(`${name.padEnd(32)} ${String(n).padStart(4)}  ${pct(n, ok.length)}${flag}`);
  }
  log('الإشارة الإجمالية: ' + fmtTally(tally(ok.map(s => F[s].sig))));
  log('masterScore: ' + dist(ok.map(s => F[s].masterScore)));
  const tatA = ok.map(s => F[s].tat).filter(t => t && t.active);
  log(`التوافق الزمني — الأدلّة لدى النشط: ${fmtTally(tally(tatA.map(t => t.evidenceCount)))} · دعم/مقاومة قوية ${tatA.filter(t => t.strongSR).length}/${tatA.length}`);
  log('  مصدر التطابق: فيبو ' + tatA.filter(t => t.fibMatch).length + ' · غان ' + tatA.filter(t => t.gannMatch).length +
    ' · غان تقويمي ' + tatA.filter(t => t.gannCalMatch).length + ' · دورة مكتشفة ' + tatA.filter(t => t.dcMatch).length +
    ' · مربع التسعة ' + tatA.filter(t => t.squareOfNine && t.squareOfNine.squared).length + ' · تقارب سعر-زمن ' + tatA.filter(t => t.ptConfirmed).length);

  /* ── ٣. خريطة المواعيد (الرادار الزمني) ────────────────────────────── */
  if (!NO_TIME) {
    H('٣. خريطة المواعيد — الرادار الزمني');
    const tt = Date.now();
    const T = {};
    for (const s of live) { try { T[s] = ctx._timeEntry(s); } catch (e) { T[s] = { state: 'error', why: e.message }; } }
    const fdr = ctx.applyTimeMapFDR(T);
    log(`(${((Date.now() - tt) / 1000).toFixed(1)} ث) · تصحيح BH على ${fdr.tested}: بقيت ${fdr.kept} دورة وأُسقطت ${fdr.demoted}`);
    const key = e => e.state + (e.tier ? '/' + e.tier : '') + (e.tier === 'cycle' && e.state === 'ok' ? (e.stabilityTested ? '/ثابتة' : '/غير مختبرة') : '');
    log('الحالة: ' + fmtTally(tally(live.map(s => key(T[s])))));
    const cyc = live.filter(s => T[s].state === 'ok' && T[s].tier === 'cycle');
    log(`دورات مقاسة: ${cyc.length} · قابلة للاستعمال ${cyc.filter(s => T[s].usable).length} · الدورة بالجلسات: ${dist(cyc.map(s => T[s].period))}`);
    log(`  الانعطاف القادم بالجلسات: ${dist(cyc.map(s => T[s].bars))} · عدم اليقين ±: ${dist(cyc.map(s => T[s].sd))}`);
    const within = h => cyc.filter(s => T[s].bars != null && T[s].bars <= h).length;
    log(`  ضمن 5 جلسات ${within(5)} · ضمن 10 ${within(10)} · ضمن 21 ${within(21)}`);
    cyc.slice(0, 8).forEach(s => { const e = T[s]; log(`  ${s}: دورة ${e.period} · p=${e.p} · ${e.type} بعد ${e.bars}±${e.sd} · ${e.usable ? 'قابلة' : 'غير قابلة'}`); });
    const cls = live.filter(s => T[s].state === 'ok' && T[s].tier === 'classic');
    log(`نوافذ كلاسيكية: ${cls.length} · بعد: ${dist(cls.map(s => T[s].bars))}`);
    const pv = live.map(s => T[s].p).filter(Boolean).map(x => parseFloat(String(x).replace(/[^\d.e-]/g, ''))).filter(isFinite);
    log(`قيمة p للطيف: ${dist(pv)} · تحت 0.05: ${pv.filter(x => x < 0.05).length}/${pv.length}`);
    out.time = { states: tally(live.map(s => key(T[s]))), cycles: cyc.length, usable: cyc.filter(s => T[s].usable).length };
  }

  /* ── ٤. قمع «جاهز» (actionPlan) ─────────────────────────────────────── */
  H('٤. قمع التوقيت الكامل (actionPlan)');
  const AP = {};
  for (const s of live) { try { AP[s] = ctx.KSATiming.actionPlan(G.cans[s], {}); } catch (e) { AP[s] = { action: 'error', title: e.message }; } }
  log('المرحلة: ' + fmtTally(tally(live.map(s => AP[s].title || AP[s].action))));
  out.funnel = tally(live.map(s => AP[s].action));

  /* ── ٥. مستويات الصفقة ──────────────────────────────────────────────── */
  H('٥. مستويات الصفقة (tradeLevels)');
  const TL = {};
  for (const s of live) { try { TL[s] = ctx.tradeLevels(s); } catch (e) { TL[s] = null; } }
  const tl = live.filter(s => TL[s]);
  log(`بخطة ${tl.length}/${N} · الحكم: ${fmtTally(tally(tl.map(s => TL[s].verdict)))}`);
  log(`نوع المنطقة: ${fmtTally(tally(tl.map(s => TL[s].zoneKind || '?')))}`);
  const rr1 = tl.map(s => TL[s].rr1);
  const riskAtr = tl.map(s => TL[s].riskATR);
  const t1pct = tl.map(s => TL[s].targets && TL[s].targets[0] ? (TL[s].targets[0].price / TL[s].entryRef - 1) * 100 : null);
  const stopPct = tl.map(s => TL[s].entryRef && TL[s].stop ? (1 - TL[s].stop / TL[s].entryRef) * 100 : null);
  log('عائد/مخاطرة الهدف الأول: ' + dist(rr1));
  log('المخاطرة بوحدات ATR: ' + dist(riskAtr));
  log('بُعد الوقف ٪: ' + dist(stopPct));
  log('بُعد الهدف الأول ٪: ' + dist(t1pct));
  const wild = tl.filter(s => { const t = TL[s].targets && TL[s].targets[0]; return t && t.rr > 5; });
  const fillT1 = tl.filter(s => TL[s].targets && TL[s].targets[0] && TL[s].targets[0].kind === 'fractal').length;
  log(`هدف أول فراكتالي (بلا بنية تحته): ${fillT1} · خطط مجدية ${tl.filter(s => TL[s].viable).length}`);
  log(`نسبة الهدف الأول فوق 1:5: ${wild.length} سهماً`);
  wild.slice(0, 8).forEach(s => { const x = TL[s], t = x.targets[0]; log(`  ${s}: سعر ${x.price} · منطقة ${x.entryLo}–${x.entryHi} · وقف ${x.stop} · هدف ${t.price} (${t.source || ''}) · 1:${t.rr}`); });
  out.levels = { n: tl.length, verdict: tally(tl.map(s => TL[s].verdict)), rr1: { med: q(rr1, .5), p90: q(rr1, .9), max: q(rr1, 1) }, wild: wild.length };

  /* ── ٦. ما كان سيُنبَّه عليه ────────────────────────────────────────── */
  H('٦. التنبيهات');
  const items = live.map(s => ({ sym: s, name: s, price: G.pr[s], levels: TL[s], time: null, action: (TL[s] && TL[s].viable && TL[s].riskOk) ? AP[s] : null }));
  const ev = ctx.KSAAlerts.evaluate(items, { kinds: ['ready', 'zone', 'approach'], approachPct: 1.5 });
  log(JSON.stringify(ev.stats));
  out.alerts = ev.stats;

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  log('\n✓ انتهى التشخيص');
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
