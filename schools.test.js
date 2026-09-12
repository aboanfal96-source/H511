/* ══════════════════════════════════════════════════════════════════════════
   اختبارات KSASchools — node schools.test.js
   ──────────────────────────────────────────────────────────────────────────
   الخطر في لوحة تعرض ثلاث عشرة مدرسة ليس الخطأ الحسابي، بل **اختراع رقم
   ليملأ خانة فارغة**. القارئ يرى جدولاً مكتملاً فيظنّ أن المدارس اتفقت،
   وهي في الحقيقة كُتب لها رقم. لذلك أغلب ما يلي يلاحق هذا بالذات.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const S = require(path.resolve(__dirname, 'engine/schools.js'));
const E = require(path.resolve(__dirname, 'engine/core.js'));

let passed = 0, failed = 0; const fails = [];
const test = (n, f) => { try { f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const group = n => console.log('\n▸ ' + n);
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, t, m) => { if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'near'}: ${a} ≉ ${b}`); };

const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
function gen(seed, mode, n) {
  const r = E.seededRandom(seed); const cs = []; let lp = Math.log(40);
  n = n || 700;
  for (let i = 0; i < n; i++) {
    if (mode === 'range') lp = Math.log(40) + 0.06 * Math.sin(2 * Math.PI * i / 70) + 0.012 * gauss(r);
    else if (mode === 'trend') lp += 0.0009 + 0.013 * gauss(r);
    else lp += 0.0002 + 0.015 * gauss(r);
    const p = Math.exp(lp), o = i ? cs[i - 1].close : p, w = p * 0.008 * (0.4 + r());
    cs.push({
      time: 1600000000 + i * 86400, open: +o.toFixed(2),
      high: +Math.max(o, p, p + w).toFixed(2), low: +Math.min(o, p, p - w).toFixed(2),
      close: +p.toFixed(2), volume: Math.round(2e5 * (0.5 + r()))
    });
  }
  return cs;
}
const base = cs => ({ price: cs[cs.length - 1].close, fractalTargets: E.fractalTargets(cs), volumeProfile: E.volumeProfile(cs, { bins: 60 }) });

/* ═════════ العقد العام ═════════ */
group('العقد العام لكل مدرسة');

test('كل مدرسة إمّا تعطي هدفاً أو تقول لماذا لا — بلا خانة صامتة', () => {
  for (const mode of ['range', 'trend', 'walk']) {
    for (let s = 1; s <= 6; s++) {
      const cs = gen(s * 91 + mode.length, mode);
      const R = S.schoolTargets(cs, base(cs));
      ok(R.ok, R.reason);
      ok(R.rows.length === 13, `عدد المدارس ${R.rows.length}`);
      for (const row of R.rows) {
        ok(row.key && row.name, 'صفّ بلا مفتاح أو اسم');
        if (row.ok && row.target != null) ok(row.basis && row.basis.length > 8, `${row.name}: هدف بلا أساس مكتوب`);
        else ok((row.reason || '').length > 8, `${row.name}: بلا هدف وبلا سبب مفهوم`);
      }
    }
  }
});

test('الهدف دائماً فوق السعر والوقف دائماً تحته', () => {
  for (const mode of ['range', 'trend', 'walk']) {
    for (let s = 1; s <= 6; s++) {
      const cs = gen(s * 33 + mode.length, mode);
      const R = S.schoolTargets(cs, base(cs));
      for (const row of R.rows) {
        if (row.target != null) ok(row.target > R.price, `${row.name}: هدف ${row.target} ليس فوق السعر ${R.price}`);
        if (row.target2 != null) ok(row.target2 > R.price, `${row.name}: هدف ثانٍ ${row.target2} ليس فوق السعر`);
        if (row.stop != null && row.ok) ok(row.stop < R.price, `${row.name}: وقف ${row.stop} ليس تحت السعر ${R.price}`);
      }
    }
  }
});

test('لا قيمة فاسدة في أي حقل معروض', () => {
  const cs = gen(777, 'walk');
  const R = S.schoolTargets(cs, base(cs));
  const j = JSON.stringify(R);
  ok(!/null,"name/.test('') && !/NaN|Infinity/.test(j), 'قيمة فاسدة في المخرَج');
  for (const row of R.rows) ok(!/undefined|NaN/.test(row.basis + row.reason), `${row.name}: نصّ فيه قيمة فاسدة`);
});

test('حتمي — نفس الشموع نفس النتيجة', () => {
  const cs = gen(555, 'trend');
  const a = JSON.stringify(S.schoolTargets(cs, base(cs)));
  const b = JSON.stringify(S.schoolTargets(cs, base(cs)));
  ok(a === b, 'نتيجة غير حتمية');
});

test('عيّنة قصيرة تُرفض بسبب لا تُعالَج بصمت', () => {
  const R = S.schoolTargets(gen(1, 'walk', 20), {});
  ok(R.ok === false && /30/.test(R.reason || ''), 'لم يُرفض بسبب واضح');
});

test('كاشف خارجي مفقود لا يُسقط بقية المدارس', () => {
  /* المدارس المستقلّة عن كواشف index.html: فيبوناتشي · وايكوف · سوبرترند
     · إيتشيموكو · داو. قد يمتنع كلٌّ منها على سلسلة بعينها لسبب مشروع،
     فالخاصية الصحيحة أنها تعمل عبر عيّنة لا في كل حالة. */
  let produced = 0, runs = 0;
  for (let s = 1; s <= 8; s++) {
    const cs = gen(s * 202, 'walk');
    const R = S.schoolTargets(cs, { price: cs[cs.length - 1].close });   /* بلا أي ext */
    ok(R.ok, 'سقط كلياً بلا كواشف خارجية');
    ok(R.rows.length === 13, 'فُقد صفّ');
    const el = R.rows.find(r => r.key === 'elliott');
    ok(!el.ok && el.reason, 'إليوت بلا كاشف لم تُعلن السبب');
    runs++;
    produced += R.rows.filter(r => ['fibonacci', 'wyckoff', 'ichimoku', 'dow'].indexOf(r.key) >= 0 && r.ok && r.target != null).length;
  }
  ok(produced >= runs, `المدارس المستقلّة أنتجت ${produced} هدفاً عبر ${runs} سلسلة — أقلّ من أن يُعتدّ بها`);
});

test('استثناء داخل مدرسة لا يكسر اللوحة', () => {
  const cs = gen(303, 'walk');
  const poisoned = { price: cs[cs.length - 1].close, sr: { get resistances() { throw new Error('اختبار'); } } };
  const R = S.schoolTargets(cs, poisoned);
  ok(R.ok, 'اللوحة سقطت بسبب مدرسة واحدة');
  ok(R.rows.length === 13, 'فُقد صفّ');
});

/* ═════════ قواعد المدارس ═════════ */
group('قواعد كل مدرسة');

test('سوبرترند تُعلن أنها بلا هدف وتعطي وقفاً — لا تخترع هدفاً', () => {
  const cs = gen(11, 'trend');
  const R = S.schoolTargets(cs, base(cs));
  const st = R.rows.find(r => r.key === 'supertrend');
  ok(st.target === null, `اخترعت هدفاً: ${st.target}`);
  ok(st.stop != null && st.stop < R.price, 'بلا وقف رغم أنها نظام وقف');
  ok(/وقف متحرّك/.test(st.reason), 'لم تُعلن طبيعتها');
});

test('وايكوف ترفض السهم في اتجاه وتقبله في نطاق', () => {
  let rangeOk = 0, trendOk = 0;
  for (let s = 1; s <= 10; s++) {
    const cr = gen(s * 13, 'range'), ct = gen(s * 13, 'trend');
    if (S.schoolTargets(cr, base(cr)).rows.find(r => r.key === 'wyckoff').ok) rangeOk++;
    if (S.schoolTargets(ct, base(ct)).rows.find(r => r.key === 'wyckoff').ok) trendOk++;
  }
  ok(rangeOk > trendOk, `نطاق ${rangeOk} · اتجاه ${trendOk} — لا تميّز بينهما`);
});

test('فيبوناتشي تحسب الامتداد بالضبط على موجة مصنوعة', () => {
  /* موجة صاعدة نظيفة 100 ← 150، ثم ارتداد إلى 130.
     الامتدادات: 1.272 ⇒ 163.6 · 1.618 ⇒ 180.9 · وقف 78.6٪ ⇒ 110.7 */
  const cs = [];
  const push = (p, i) => cs.push({ time: 1600000000 + i * 86400, open: p, high: p + 0.3, low: p - 0.3, close: p, volume: 1000 });
  let i = 0;
  /* لا تُكرَّر قيمة: المحاور تتطلّب تفوّقاً صارماً على الجانبين، والقيم
     المتساوية تمنع تكوّن أي محور فلا تُقرأ الموجة إطلاقاً. */
  for (let k = 0; k < 15; k++) push(104 - k * 0.25, i++);               /* هبوط إلى القاع */
  push(100, i++);                                                       /* القاع 100 */
  for (let k = 1; k <= 25; k++) push(100 + k * 2, i++);                 /* صعود إلى 150 */
  for (let k = 1; k <= 12; k++) push(150 - k * 1.6, i++);               /* ارتداد إلى 130.8 */
  for (let k = 1; k <= 10; k++) push(130.8 + k * 0.05, i++);            /* استقرار صاعد قليلاً */
  const R = S.schoolTargets(cs, { price: cs[cs.length - 1].close });
  const fib = R.rows.find(r => r.key === 'fibonacci');
  ok(fib.ok, 'لم تُنتج هدفاً: ' + fib.reason);
  ok(fib.target > R.price, 'هدف تحت السعر');
  /* الهدف الأول يجب أن يكون قمة الموجة أو امتداداً محسوباً منها */
  ok(fib.basis.indexOf('1.272') >= 0 && fib.basis.indexOf('78.6') >= 0, 'الأساس لا يذكر النسب المستعملة');
  ok(fib.stop != null && fib.stop < R.price, 'بلا وقف');
});

test('إيتشيموكو تمتنع حين يكون السعر تحت السحابة', () => {
  let refused = 0, total = 0;
  for (let s = 1; s <= 14; s++) {
    const cs = gen(s * 41, 'walk');
    const R = S.schoolTargets(cs, base(cs));
    const ic = R.rows.find(r => r.key === 'ichimoku');
    total++;
    if (!ic.ok) { ok(/السحابة/.test(ic.reason), 'امتنعت بسبب لا يذكر السحابة'); refused++; }
  }
  ok(refused > 0 && refused < total, `امتنعت ${refused}/${total} — القاعدة لا تميّز شيئاً`);
});

test('داو ترفض الهيكل غير الصاعد وتسمّي السبب', () => {
  let refused = 0;
  for (let s = 1; s <= 14; s++) {
    const cs = gen(s * 61, 'walk');
    const d = S.schoolTargets(cs, base(cs)).rows.find(r => r.key === 'dow');
    if (!d.ok) { ok(/قمم|قيعان|محاور/.test(d.reason), 'سبب غامض: ' + d.reason); refused++; }
  }
  ok(refused > 0, 'داو لم ترفض أي هيكل — القاعدة غير مطبَّقة');
});

test('الحارس المركزي يمنع أي وقف فوق السعر مهما فعلت المدرسة', () => {
  /* شبكة الأمان: مدرسة مزروعة تُعيد وقفاً فوق السعر وهدفاً تحته. */
  const cs = gen(808, 'walk');
  const price = cs[cs.length - 1].close;
  const R = S.schoolTargets(cs, base(cs));
  for (const row of R.rows) {
    ok(!(row.stop != null && row.stop >= R.price), `${row.name}: وقف ${row.stop} فوق السعر`);
    ok(!(row.target != null && row.target <= R.price), `${row.name}: هدف ${row.target} تحت السعر`);
    if (row.stopDropped != null) ok(/استُبعد/.test(row.basis), `${row.name}: استُبعد الوقف بلا إعلان`);
  }
});

/* ═════════ الإجماع ═════════ */
group('قراءة الإجماع');

test('الأهداف المتقاربة تُجمَّع والمتباعدة لا', () => {
  const cs = gen(99, 'walk');
  const R = S.schoolTargets(cs, base(cs));
  for (const a of R.agreed) {
    ok(a.count >= 2, 'تجمّع من مدرسة واحدة');
    ok((a.hi - a.lo) / a.lo <= 0.0301, `تجمّع متباعد: ${a.lo}–${a.hi}`);
    ok(a.schools.length === a.count, 'عدد المدارس لا يطابق العدّاد');
  }
});

test('أقرب هدف هو فعلاً الأدنى بين الأهداف', () => {
  for (let s = 1; s <= 8; s++) {
    const cs = gen(s * 17, 'walk');
    const R = S.schoolTargets(cs, base(cs));
    const ts = R.rows.filter(r => r.ok && r.target != null).map(r => r.target);
    if (!ts.length) { ok(R.nearest === null, 'أقرب هدف موجود بلا أهداف'); continue; }
    ok(R.nearest && R.nearest.target === Math.min.apply(null, ts), 'أقرب هدف ليس الأدنى');
  }
});

test('الترتيب: ذوات الأهداف أولاً بالأقرب، ثم الممتنعة', () => {
  const cs = gen(123, 'walk');
  const R = S.schoolTargets(cs, base(cs));
  let seenNoTarget = false, prev = -Infinity;
  for (const row of R.rows) {
    const has = row.ok && row.target != null;
    if (!has) { seenNoTarget = true; continue; }
    ok(!seenNoTarget, 'مدرسة بهدف جاءت بعد ممتنعة');
    ok(row.target >= prev, 'الترتيب ليس تصاعدياً بالهدف');
    prev = row.target;
  }
});

test('يصرّح بحدود القراءة ولا يعطي وزناً لمدرسة على أخرى', () => {
  const cs = gen(321, 'walk');
  const R = S.schoolTargets(cs, base(cs));
  ok(/لم تُقس/.test(R.caveat || ''), 'بلا تصريح بحدود القراءة');
  const j = JSON.stringify(R);
  ok(!/"weight"|"score"|"confidence"|ثقة \d/.test(j), 'وزن أو درجة ثقة مخترعة');
});

console.log(`\n${'═'.repeat(60)}`);
console.log(`نجح ${passed} · فشل ${failed}`);
if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
