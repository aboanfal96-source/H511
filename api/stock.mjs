/* ══════════════════════════════════════════════════════════════════════════
   /api/stock — وسيط بيانات السوق
   ──────────────────────────────────────────────────────────────────────────
   يعمل من جهة الخادم فلا يخضع لقيد CORS، ولهذا حُذف الاعتماد على وسطاء
   CORS العامّين من الواجهة: أطراف ثالثة غير موثوقة كانت تتوسّط كل طلبات
   السوق، بلا ضمان توفّر ولا اتفاقية خدمة، فإذا سقطت بقيت المنصة على بيانات
   عشوائية بلا أن يدري المستخدم.

   🛠️ إصلاح أمني: النسخة السابقة كانت تحقن `symbol` في مسار الرابط مباشرة
   بلا أي تحقّق:
       `${host}/v8/finance/chart/${sym}?range=${range}&interval=${interval}`
   رمز مثل `../../v1/test/getcrumb` أو `2222.SR?x=y#` يغيّر المسار المطلوب
   ويحوّل هذه الدالة إلى وسيط طلبات عامّ نحو نطاق Yahoo — وهو ما تمنعه
   قائمة السماح أدناه. والرموز والنطاقات تُقارَن الآن بقوائم مغلقة، لا
   تُهرَّب فقط.
   ══════════════════════════════════════════════════════════════════════════ */

/* رمز تداول سعودي: أربعة أو خمسة أرقام، مع لاحقة .SR اختيارية */
const SYMBOL_RE = /^\d{4,5}(\.SR)?$/i;

/* قيم Yahoo المسموحة فقط — لا تُمرَّر سلسلة من المستخدم إلى الرابط */
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/** هل السوق السعودي مفتوح الآن؟ أحد–خميس، 10:00–15:10 بتوقيت الرياض. */
function marketOpenNow(d) {
  d = d || new Date();
  const riyadh = new Date(d.getTime() + (3 * 60 + d.getTimezoneOffset()) * 60000);
  const day = riyadh.getDay();            /* 5=الجمعة 6=السبت */
  if (day === 5 || day === 6) return false;
  const mins = riyadh.getHours() * 60 + riyadh.getMinutes();
  return mins >= 600 && mins <= 910;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed', message: 'الطريقة غير مدعومة' });

  const { symbol = '2222', range = '3mo', interval = '1d' } = req.query || {};

  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol))
    return res.status(400).json({ error: 'bad_symbol', message: 'رمز غير صالح — يُقبل رقم تداول من 4 أو 5 خانات فقط' });
  if (!RANGES.has(String(range)))
    return res.status(400).json({ error: 'bad_range', message: 'نطاق زمني غير مدعوم' });
  if (!INTERVALS.has(String(interval)))
    return res.status(400).json({ error: 'bad_interval', message: 'فاصل زمني غير مدعوم' });

  const sym = symbol.toUpperCase().endsWith('.SR') ? symbol.toUpperCase() : symbol + '.SR';

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };

  let lastStatus = 0;
  for (const host of HOSTS) {
    try {
      /* مهلة صريحة: بلا مهلة يبقى الطلب معلّقاً حتى تنتهي مهلة الدالة
         نفسها، فيدفع المستخدم انتظاراً كاملاً مقابل مصدر ساقط. */
      const url = `${host}/v8/finance/chart/${encodeURIComponent(sym)}`
        + `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
      lastStatus = r.status;
      if (!r.ok) continue;
      const d = await r.json();
      if (!d?.chart?.result?.[0]) continue;
      /* 🛠️ إصلاح: التخزين الوسيط كان 15 دقيقة + 30 دقيقة "قديم أثناء التجديد".
         أثران سيّئان: (1) التحديث الحيّ كل خمس دقائق كان يُخدَم من الذاكرة
         نفسها فلا يأتي بجديد — لوحة "حيّة" ساكنة فعلياً، (2) كل نطاق
         (5d، 5y) مفتاح مستقل يُملأ في لحظة مختلفة، فيحمل أحدهما لقطة ما قبل
         الإغلاق والآخر ما بعده — وهذا مصدر مباشر لاختلاف السعر بين الشارت
         والرأس. الآن: مهلة قصيرة أثناء الجلسة، وأطول بعد إغلاقها حيث
         البيانات شبه ثابتة، وبلا تقديم نسخة قديمة. */
      res.setHeader('Cache-Control', marketOpenNow() ? 's-maxage=120' : 's-maxage=600');
      return res.status(200).json(d);
    } catch (e) { continue; }
  }
  return res.status(503).json({ error: 'upstream_unavailable', message: `تعذّر جلب بيانات ${sym} من المصدر`, upstreamStatus: lastStatus || null });
}
