/**
 * وكيل بيانات السوق — /api/stock
 *
 * أُعيدت كتابته لمعالجة ثغرات في النسخة السابقة:
 *
 * 1) لم يكن هناك أي تحقّق من صحة الرمز. كانت قيمة `symbol` تُدرَج مباشرة
 *    في مسار عنوان المصدر الخارجي، فيمكن لأي زائر تمرير مسار أو معاملات
 *    استعلام إضافية واستخدام الدالة وكيلاً لطلبات لم تُقصد. الآن: قائمة
 *    بيضاء صارمة بنمط رموز تداول (4 أرقام) وقائمة نطاقات وفواصل مسموحة.
 *
 * 2) لم يكن هناك تحديد لطريقة الطلب — كانت تستجيب لأي طريقة.
 *
 * 3) Access-Control-Allow-Origin: '*' على واجهة تستهلكها الصفحة نفسها فقط.
 *
 * 4) عند الفشل كانت ترجع { error: 'unavailable' } بلا أي تمييز بين
 *    "الرمز غير موجود" و"المصدر متعذّر" و"انتهت المهلة" — فتظهر الواجهة
 *    رسالة واحدة غامضة، ويبقى السهم على بيانات عشوائية بلا تفسير.
 */

const SYMBOL_RE = /^[0-9]{4}$/;                       /* رموز تداول: أربعة أرقام */
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']);
const INTERVALS = new Set(['5m', '15m', '30m', '1h', '1d', '1wk', '1mo']);

const UPSTREAM_TIMEOUT_MS = 9000;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed', message: 'هذه الواجهة تقبل GET فقط' });
  }

  const { symbol = '2222', range = '3mo', interval = '1d' } = req.query || {};

  if (!SYMBOL_RE.test(String(symbol))) {
    return res.status(400).json({
      error: 'invalid_symbol',
      message: 'رمز السهم يجب أن يكون أربعة أرقام (مثال: 2222)'
    });
  }
  if (!RANGES.has(String(range))) {
    return res.status(400).json({ error: 'invalid_range', message: `النطاق المسموح: ${[...RANGES].join(', ')}` });
  }
  if (!INTERVALS.has(String(interval))) {
    return res.status(400).json({ error: 'invalid_interval', message: `الفاصل المسموح: ${[...INTERVALS].join(', ')}` });
  }

  const sym = `${symbol}.SR`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  const failures = [];
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(sym)}`
      + `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    try {
      const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!upstream.ok) { failures.push(`${host}: HTTP ${upstream.status}`); continue; }

      const data = await upstream.json();
      const result = data?.chart?.result?.[0];
      if (!result) {
        /* المصدر يميّز "رمز غير معروف" عن عطل مؤقت — ننقل التمييز للواجهة */
        const upstreamErr = data?.chart?.error?.description;
        failures.push(`${host}: ${upstreamErr || 'استجابة بلا نتائج'}`);
        continue;
      }
      if (!result.timestamp?.length) {
        failures.push(`${host}: لا توجد جلسات في هذا النطاق`);
        continue;
      }

      /* التخزين المؤقت على الحافة: 15 دقيقة، مع تقديم النسخة القديمة أثناء
         التحديث. يقلّل الضغط على المصدر ويجعل المسح الشامل (~250 سهماً)
         عملياً بدل أن يصطدم بحدود المعدّل. */
      res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      return res.status(200).json(data);
    } catch (e) {
      failures.push(`${host}: ${e.name === 'TimeoutError' ? 'انتهت المهلة' : e.message}`);
    }
  }

  return res.status(502).json({
    error: 'upstream_unavailable',
    message: 'تعذّر جلب بيانات هذا السهم من المصدر',
    detail: failures.join(' | ')
  });
}
