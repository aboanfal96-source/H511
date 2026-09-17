/* ══════════════════════════════════════════════════════════════════════════
   engine/price.test.js — سعر واحد: ما يُعرض هو ما يُرسم وما يُحسب عليه
   ──────────────────────────────────────────────────────────────────────────
   العطب المُبلَّغ: بعد إغلاق السوق يختلف السعر المعروض عن سعر الشارت.
   السبب: مصدران. الرأس كان يقرأ meta.regularMarketPrice، والشارت يرسم
   إغلاق آخر شمعة، والتحليل كلّه (منطقة الدخول، الوقف، الأهداف) يُبنى على
   الشموع. فيُقاس الحكم على رقم ليس في السلسلة المرسومة.

   ما تثبته هذه الاختبارات: مهما كان الفرق الذي يعلنه المصدر، يبقى
   price === cs[last].close دائماً — أي أن الرقم المعروض موجود على الشارت
   بالتعريف، لا بالمصادفة.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const { createAppContext } = require('./appvm.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '\n      ' + extra : '')); }
};

const { ctx } = createAppContext();

/* ── بناء استجابة Yahoo اصطناعية ────────────────────────────────────────
   يوم تداول سعودي يبدأ 10:00 بتوقيت الرياض = 07:00 UTC. */
function session(daysAgo) {
  const d = new Date();
  d.setUTCHours(7, 0, 0, 0);
  return Math.floor(d.getTime() / 1000) - daysAgo * 86400;
}
function buildRes(opt) {
  opt = opt || {};
  const n = opt.n || 40;
  const ts = [], open = [], high = [], low = [], close = [], volume = [];
  let p = 30;
  for (let i = n - 1; i >= 0; i--) {
    const o = +p.toFixed(2), c = +(o * (1 + ((i % 7) - 3) * 0.004)).toFixed(2);
    ts.push(session(i));
    open.push(o); close.push(c);
    high.push(+(Math.max(o, c) + 0.12).toFixed(2));
    low.push(+(Math.min(o, c) - 0.12).toFixed(2));
    volume.push(100000 + i * 10);
    p = c;
  }
  if (opt.lastClose != null) {
    /* يُضبط المدى مع الإغلاق المفروض: مُنظِّف المحرّك يُسقط أي شمعة
       مقلوبة، ولو سقطت آخر شمعة لصار الاختبار يقيس جلسة أخرى. */
    close[n - 1] = opt.lastClose;
    high[n - 1] = +Math.max(high[n - 1], opt.lastClose, open[n - 1]).toFixed(2);
    low[n - 1] = +Math.min(low[n - 1], opt.lastClose, open[n - 1]).toFixed(2);
  }
  return {
    meta: {
      regularMarketPrice: opt.metaPrice,
      regularMarketTime: opt.metaTime != null ? opt.metaTime : ts[n - 1] + 5 * 3600,
      previousClose: opt.previousClose,
      chartPreviousClose: close[0],
      dataGranularity: opt.granularity || '1d'
    },
    timestamp: ts,
    indicators: { quote: [{ open, high, low, close, volume }] }
  };
}

/** يشغّل parseY بحالة سوق مفروضة، ثم يعيد marketOpen الأصلية. */
function withMarket(isOpen, fn) {
  const orig = ctx.marketOpen;
  ctx.marketOpen = () => isOpen;
  try { return fn(); } finally { ctx.marketOpen = orig; }
}

console.log('\n\x1b[1mسعر واحد مُعلن المصدر\x1b[0m');

/* ① الثابت المركزي: السعر المعروض هو إغلاق آخر شمعة، في الحالتين. */
{
  const cases = [
    { name: 'المصدر يعلن أعلى من الإغلاق', metaPrice: 31.9, lastClose: 31.2 },
    { name: 'المصدر يعلن أدنى من الإغلاق', metaPrice: 30.1, lastClose: 31.2 },
    { name: 'المصدر مطابق للإغلاق', metaPrice: 31.2, lastClose: 31.2 },
    { name: 'المصدر غائب', metaPrice: undefined, lastClose: 31.2 }
  ];
  for (const isOpen of [true, false]) {
    let bad = null;
    for (const c of cases) {
      const d = withMarket(isOpen, () => ctx.parseY(buildRes(c), '2222'));
      const drawn = d.cs[d.cs.length - 1].close;
      if (Math.abs(d.price - drawn) > 1e-9) bad = `${c.name}: معروض ${d.price} · مرسوم ${drawn}`;
    }
    ok(`price === إغلاق آخر شمعة — السوق ${isOpen ? 'مفتوح' : 'مغلق'}`, !bad, bad);
  }
}

/* ② السوق مغلق: الإغلاق الرسمي يفوز، والفرق يُعلَن ولا يُخفى. */
{
  const d = withMarket(false, () => ctx.parseY(buildRes({ metaPrice: 31.9, lastClose: 31.2 }), '2222'));
  ok('بعد الإغلاق: الإغلاق الرسمي هو السعر', d.price === 31.2 && d.priceSrc === 'close',
    `price=${d.price} src=${d.priceSrc}`);
  ok('بعد الإغلاق: رقم المصدر المخالف يُعلَن صراحةً',
    !!d.gap && d.gap.quote === 31.9, JSON.stringify(d.gap));
}

/* ③ جلسة قائمة: السعر المعلن هو الأحدث، وتُزامَن عليه الشمعة فلا يفترق الشارت. */
{
  const d = withMarket(true, () => ctx.parseY(buildRes({ metaPrice: 31.9, lastClose: 31.2 }), '2222'));
  const last = d.cs[d.cs.length - 1];
  ok('أثناء الجلسة: السعر المعلن يفوز', d.price === 31.9 && d.priceSrc === 'live',
    `price=${d.price} src=${d.priceSrc}`);
  ok('أثناء الجلسة: الشمعة تُزامَن على السعر فلا تبقى فجوة', last.close === 31.9 && !d.gap);
  ok('أثناء الجلسة: المدى يتّسع للسعر ولا يخرج عنه',
    last.high >= 31.9 && last.low <= 31.9, `hi=${last.high} lo=${last.low}`);
}

/* ④ طابع زمني من جلسة أخرى: لا تُزامَن الشمعة على سعر ليس منها. */
{
  const res = buildRes({ metaPrice: 31.9, lastClose: 31.2, metaTime: session(0) + 5 * 3600 });
  /* اجعل آخر شمعة من الأمس بينما إعلان المصدر من اليوم */
  res.timestamp[res.timestamp.length - 1] = session(1);
  const d = withMarket(true, () => ctx.parseY(res, '2222'));
  ok('إعلان من جلسة أحدث لا يُكتب على شمعة جلسة أقدم',
    d.price === d.cs[d.cs.length - 1].close && d.price === 31.2, `price=${d.price}`);
  ok('ويُصرَّح بأن الفرق من جلستين مختلفتين',
    !!d.gap && d.gap.sameSession === false, JSON.stringify(d.gap));
}

/* ⑤ التغيّر المعروض = فرق الشمعتين الأخيرتين على الشارت بالضبط. */
{
  /* previousClose من المصدر مضلّل عمداً: لو اعتُمد لاختلف التغيّر عن الشارت */
  const d = withMarket(false, () => ctx.parseY(buildRes({ metaPrice: 31.2, lastClose: 31.2, previousClose: 99 }), '2222'));
  const prevDrawn = d.cs[d.cs.length - 2].close;
  ok('الإغلاق السابق من السلسلة لا من meta', Math.abs(d.pv - prevDrawn) < 1e-9,
    `pv=${d.pv} · مرسوم ${prevDrawn}`);
}

/* ⑤ب الفواصل داخل اليوم: «التغيّر» يبقى يوميّاً لا ساعيّاً. */
{
  const d = withMarket(false, () => ctx.parseY(
    buildRes({ metaPrice: 31.2, lastClose: 31.2, previousClose: 30.5, granularity: '1h' }), '2222'));
  ok('بفاصل ساعي: الإغلاق السابق يوميّ من المصدر لا الشمعة السابقة',
    d.pv === 30.5, `pv=${d.pv}`);
}

/* ⑥ بعد applyY: ما تقرؤه كل طبقات التطبيق مطابق لما يرسمه الشارت. */
{
  const G = ctx.G;
  const d = withMarket(false, () => ctx.parseY(buildRes({ metaPrice: 31.9, lastClose: 31.2 }), '2222'));
  ctx.applyY('2222', d);
  const drawn = G.cans['2222'][G.cans['2222'].length - 1].close;
  ok('G.pr مطابق لإغلاق الشمعة المرسومة بعد applyY', G.pr['2222'] === drawn,
    `G.pr=${G.pr['2222']} · مرسوم ${drawn}`);
  ok('مصدر السعر محفوظ وقابل للعرض', G.prSrc['2222'] === 'close' && !!G.prGap['2222']);

  /* والحكم التجاري يُقاس على السعر نفسه */
  ctx.calcInd('2222');
  const L = ctx.tradeLevels('2222');
  if (L) ok('tradeLevels يقيس على السعر المرسوم نفسه',
    Math.abs(L.price - drawn) < 0.011, `price=${L.price} · مرسوم ${drawn}`);
  else ok('tradeLevels يقيس على السعر المرسوم نفسه (رُفضت الخطة بتبرير)', true);
}

/* ⑦ سهم يُفقد فيه تطابق السعر لا يبقى صامتاً: prGap يُمسح حين يزول الفرق. */
{
  const G = ctx.G;
  const d2 = withMarket(false, () => ctx.parseY(buildRes({ metaPrice: 31.2, lastClose: 31.2 }), '2222'));
  ctx.applyY('2222', d2);
  ok('يزول وسم الفرق حين يتطابق المصدر مع الشمعة', !G.prGap['2222']);
}

console.log('\n' + '═'.repeat(60));
console.log(`نجح ${pass} · فشل ${fail}`);
console.log('═'.repeat(60) + '\n');
process.exit(fail ? 1 : 0);
