/* ══════════════════════════════════════════════════════════════════════════
   اختبارات KSAAlerts — node alerts.test.js
   ──────────────────────────────────────────────────────────────────────────
   تنبيه يُطلق على شرط خاطئ يوقظك بلا سبب، وتنبيه يتكرّر كل دقيقة يُكتم بعد
   يومين فيصير كأنه غير موجود. الاختبارات هنا تلاحق الحالتين معاً.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const A = require(path.resolve(__dirname, 'engine/alerts.js'));

let passed = 0, failed = 0; const fails = [];
const test = (n, f) => { try { f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const group = n => console.log('\n▸ ' + n);
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

/** خطة سليمة: منطقة فوق الوقف، ومخاطرة خارج الضجيج، وهدفان. */
const plan = (o) => Object.assign({
  entryLo: 10, entryHi: 10.3, entryRef: 10.15, stop: 9.6, risk: 0.55, riskATR: 1.1,
  riskOk: true, viable: true, rel: 'inside', price: 10.2, atr: 0.5, rr1: 2.1,
  zoneKind: 'FVG',
  targets: [{ price: 11.3, rr: 2.1, kind: 'structural' }, { price: 12, rr: 3.4, kind: 'structural' }]
}, o || {});
const timeOk = (o) => Object.assign({
  state: 'ok', tier: 'cycle', type: 'valley', bars: 3, sd: 1.2, period: 34,
  p: '0.003', usable: true, stabilityTested: true
}, o || {});
const item = (sym, o) => Object.assign({ sym, name: 'سهم ' + sym, price: 10.2 }, o || {});

/* ═════════ متى يُطلق ═════════ */
group('شروط الإطلاق');

test('السعر داخل منطقة خطة مجدية ⇒ تنبيه', () => {
  const r = A.evaluate([item('1111', { levels: plan() })]);
  ok(r.alerts.length === 1, `عدد التنبيهات ${r.alerts.length}`);
  ok(r.alerts[0].kind === A.KIND.ZONE, 'النوع ' + r.alerts[0].kind);
});

test('وقف داخل ضجيج الجلسة ⇒ لا تنبيه إطلاقاً', () => {
  /* هذا هو العطل الذي ظهر على الشارت: وقف على بعد 0.1×ATR ينتج نسبة
     عائد/مخاطرة مضخّمة. التنبيه عليه أسوأ من السكوت. */
  const r = A.evaluate([item('1111', { levels: plan({ riskOk: false, risk: 0.05, riskATR: 0.1 }) })]);
  ok(r.alerts.length === 0, 'أُطلق تنبيه على وقف داخل الضجيج');
  ok(r.stats.skippedNoisyStop === 1, 'لم يُسجَّل سبب الاستبعاد');
});

test('خطة غير مجدية ⇒ لا تنبيه', () => {
  ok(A.evaluate([item('1111', { levels: plan({ viable: false }) })]).alerts.length === 0);
});

test('السعر خارج المنطقة ⇒ لا تنبيه منطقة', () => {
  ok(A.evaluate([item('1111', { levels: plan({ rel: 'above', price: 11 }) })]).alerts.length === 0);
});

test('«الشروط مكتملة» تُغني عن «داخل المنطقة» ولا تتكرّران', () => {
  const r = A.evaluate([item('1111', { levels: plan(), action: { action: 'ready', action_ar: 'شراء عند 10.15', steps: [] } })]);
  ok(r.alerts.length === 1, `صدر ${r.alerts.length} تنبيهاً لنفس السهم`);
  ok(r.alerts[0].kind === A.KIND.READY, 'النوع ' + r.alerts[0].kind);
});

test('الرادار مطفأ ما لم يُطلب صراحةً', () => {
  const it = item('1111', { time: timeOk(), levels: null });
  ok(A.evaluate([it]).alerts.length === 0, 'أُطلق رادار بلا طلب');
  ok(A.evaluate([it], { kinds: [A.KIND.RADAR] }).alerts.length === 1, 'لم يُطلق رادار عند طلبه');
});

test('الرادار يرفض دورة لم يُفحص ثباتها', () => {
  const r = A.evaluate([item('1111', { time: timeOk({ stabilityTested: false }) })], { kinds: [A.KIND.RADAR] });
  ok(r.alerts.length === 0, 'أُطلق تنبيه على دورة غير مفحوصة الثبات');
});

test('الرادار يرفض انعطافاً نطاقه أوسع من ربع دورة', () => {
  const r = A.evaluate([item('1111', { time: timeOk({ usable: false }) })], { kinds: [A.KIND.RADAR] });
  ok(r.alerts.length === 0, 'أُطلق تنبيه على انعطاف لا يميّز القمة من القاع');
});

test('الرادار يحترم الأفق', () => {
  const it = item('1111', { time: timeOk({ bars: 25 }) });
  ok(A.evaluate([it], { kinds: [A.KIND.RADAR], radarHorizon: 10 }).alerts.length === 0, 'تجاوز الأفق');
  ok(A.evaluate([it], { kinds: [A.KIND.RADAR], radarHorizon: 30 }).alerts.length === 1, 'رفض داخل الأفق');
});

test('الاقتراب يُقاس بالمسافة لا بالاتجاه وحده', () => {
  const near = item('1111', { levels: plan({ rel: 'above', price: 10.4, entryHi: 10.3 }) });   /* 0.97٪ */
  const far = item('2222', { levels: plan({ rel: 'above', price: 12, entryHi: 10.3 }) });     /* 16٪ */
  const r = A.evaluate([near, far], { kinds: [A.KIND.APPROACH], approachPct: 1.5 });
  ok(r.alerts.length === 1 && r.alerts[0].sym === '1111', 'التصفية بالمسافة لا تعمل');
});

test('الترتيب بالأولوية لا بالأبجدية', () => {
  const r = A.evaluate([
    item('9999', { levels: plan() }),
    item('1111', { levels: plan(), action: { action: 'ready', steps: [] } })
  ]);
  ok(r.alerts[0].kind === A.KIND.READY, 'الأهمّ ليس أولاً');
});

test('مدخل فارغ أو مشوّه لا يرمي استثناءً', () => {
  ok(A.evaluate(null).alerts.length === 0);
  ok(A.evaluate([null, {}, { sym: 'x' }]).alerts.length === 0);
});

test('منطقة مشتقّة من ATR لا تُطلق تنبيهاً — لأنها تحيط بالسعر بالتعريف', () => {
  /* 🛠️ ظهر على المتصفّح: 37 تنبيه «منطقة» من 68 سهماً محمّلاً. السبب أن
     النطاق البديل يُبنى حول السعر الحالي، فالسعر داخله دائماً — والتنبيه
     يقول لك إن السعر داخل نطاق رسمناه حول السعر. */
  const r = A.evaluate([item('1111', { levels: plan({ zoneKind: 'atr' }) })]);
  ok(r.alerts.length === 0, 'أُطلق تنبيه على نطاق ATR');
  ok(r.stats.skippedAtrZone === 1, 'سبب الاستبعاد غير معلن في الإحصاء');
});

test('فجوة القيمة العادلة وكتلة الأوامر ونطاق الاختراق تُطلق', () => {
  for (const k of ['FVG', 'OB', 'breakout']) {
    const r = A.evaluate([item('1111', { levels: plan({ zoneKind: k }) })]);
    ok(r.alerts.length === 1, `النوع ${k} لم يُطلق تنبيهاً`);
  }
});

test('«الشروط مكتملة» لا يشترط بنية النطاق — بوابة السيولة فحصتها سلفاً', () => {
  const r = A.evaluate([item('1111', { levels: plan({ zoneKind: 'atr' }), action: { action: 'ready', steps: [] } })]);
  ok(r.alerts.length === 1 && r.alerts[0].kind === A.KIND.READY, 'كُتم تنبيه «مكتملة»');
});

/* ═════════ منع التكرار ═════════ */
group('منع التكرار');

test('نفس التنبيه لا يتكرّر داخل فترة التهدئة', () => {
  const al = A.evaluate([item('1111', { levels: plan() })]).alerts;
  const t0 = 1700000000000;
  const a = A.dedupe(al, {}, { now: t0, cooldownHours: 20 });
  ok(a.send.length === 1, 'لم يُرسل أول مرة');
  const b = A.dedupe(al, a.store, { now: t0 + 3600000, cooldownHours: 20 });
  ok(b.send.length === 0, 'أُرسل مرتين خلال ساعة');
  ok(/أُرسل قبل/.test(b.suppressed[0].reason), 'سبب الكتم غير معلن');
});

test('بعد انتهاء التهدئة يُرسل مجدداً', () => {
  const al = A.evaluate([item('1111', { levels: plan() })]).alerts;
  const t0 = 1700000000000;
  const a = A.dedupe(al, {}, { now: t0, cooldownHours: 20 });
  const b = A.dedupe(al, a.store, { now: t0 + 21 * 3600000, cooldownHours: 20 });
  ok(b.send.length === 1, 'لم يُرسل بعد انتهاء التهدئة');
});

test('تغيّر الخطة نفسها حدث جديد يستحق تنبيهاً فوراً', () => {
  const t0 = 1700000000000;
  const a1 = A.evaluate([item('1111', { levels: plan() })]).alerts;
  const s = A.dedupe(a1, {}, { now: t0 }).store;
  /* منطقة ووقف مختلفان ⇒ بصمة مختلفة ⇒ لا يُكتم */
  const a2 = A.evaluate([item('1111', { levels: plan({ entryLo: 12, entryHi: 12.4, stop: 11.4, price: 12.2 }) })]).alerts;
  ok(A.dedupe(a2, s, { now: t0 + 60000 }).send.length === 1, 'كُتم تنبيه خطة جديدة');
});

test('تذبذب هللة في حدّ المنطقة ليس خطة جديدة', () => {
  const t0 = 1700000000000;
  const a1 = A.evaluate([item('1111', { levels: plan() })]).alerts;
  const s = A.dedupe(a1, {}, { now: t0 }).store;
  const a2 = A.evaluate([item('1111', { levels: plan({ entryLo: 10.001, entryHi: 10.302 }) })]).alerts;
  ok(A.dedupe(a2, s, { now: t0 + 60000 }).send.length === 0, 'أُطلق تنبيه على فرق هللة');
});

test('سقف الدفعة يحمي من انهمار الرسائل', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(item('S' + i, { levels: plan() }));
  const r = A.dedupe(A.evaluate(many).alerts, {}, { now: 1, max: 6 });
  ok(r.send.length === 6, `أُرسل ${r.send.length} بدل 6`);
  ok(r.suppressed.length === 24 && /سقف/.test(r.suppressed[0].reason), 'الفائض بلا تفسير');
});

test('المفاتيح القديمة تُنظَّف فلا ينتفخ التخزين', () => {
  const old = { 'a:zone:1:2:3': 1000 };
  const r = A.dedupe([], old, { now: 1000 + 20 * 86400000 });
  ok(Object.keys(r.store).length === 0, 'مفتاح عمره 20 يوماً ما زال محفوظاً');
});

test('بصمة نوعين مختلفين لنفس السهم لا تتصادم', () => {
  const z = A.evaluate([item('1111', { levels: plan() })]).alerts[0];
  const rd = A.evaluate([item('1111', { time: timeOk() })], { kinds: [A.KIND.RADAR] }).alerts[0];
  ok(A.signature(z) !== A.signature(rd), 'بصمة واحدة لنوعين');
});

/* ═════════ الصياغة ═════════ */
group('الصياغة');

test('نصّ تنبيه المنطقة يحمل الأرقام التي يُتصرَّف بها', () => {
  const a = A.evaluate([item('1111', { levels: plan() })]).alerts[0];
  const t = A.format(a);
  for (const n of ['10', '10.3', '9.6', '11.3', '12'])
    ok(t.indexOf(n) >= 0, `الرقم ${n} غائب عن النصّ`);
  ok(/ليس توصية/.test(t), 'بلا تنويه المسؤولية');
});

test('نصّ الرادار يقول صراحةً إنه ليس دعوة دخول', () => {
  const a = A.evaluate([item('1111', { time: timeOk() })], { kinds: [A.KIND.RADAR] }).alerts[0];
  const t = A.format(a);
  ok(/ليست دعوة دخول|للمراقبة/.test(t), 'نصّ الرادار يوحي بالتنفيذ');
  ok(/34/.test(t) && /0\.003/.test(t), 'الدورة أو قيمة الاحتمال غائبة');
});

test('لا رقم ثقة ولا احتمال نجاح في أي نصّ', () => {
  const alerts = A.evaluate([
    item('1111', { levels: plan(), action: { action: 'ready', action_ar: 'شراء', steps: ['شرط التأكيد الإلزامي: إغلاق فوق 10.3'] } }),
    item('2222', { levels: plan() })
  ]).alerts;
  for (const a of alerts) {
    const t = A.format(a);
    ok(!/احتمال النجاح|نسبة نجاح|ثقة \d/.test(t), 'رقم ثقة مخترع في: ' + t.slice(0, 60));
  }
});

test('النصّ المختصر سطر واحد صالح لإشعار المتصفّح', () => {
  const a = A.evaluate([item('1111', { levels: plan() })]).alerts[0];
  const s = A.shortText(a);
  ok(s.indexOf('\n') < 0, 'النصّ المختصر متعدّد الأسطر');
  ok(s.length < 90, 'النصّ المختصر طويل: ' + s.length);
});

console.log(`\n${'═'.repeat(60)}`);
console.log(`نجح ${passed} · فشل ${failed}`);
if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
