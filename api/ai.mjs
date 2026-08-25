/**
 * واجهة المساعد — /api/ai
 *
 * أُعيدت كتابتها لمعالجة مشكلات في النسخة السابقة:
 *
 * 1) 🔴 الأهم: كانت وكيلاً مفتوحاً بلا أي قيد إلى مفتاح Anthropic الخاص
 *    بصاحب المنصة. أي شخص يعرف الرابط يستطيع إرسال أي نص بأي حجم وبأي
 *    تكرار على حساب صاحب المفتاح. أُضيف الآن: تقييد الطريقة، وسقف لطول
 *    النص، وتحديد معدّل بسيط لكل عنوان، وتقييد المنشأ.
 *
 * 2) `const { prompt } = req.body` بلا تحقّق — طلب بلا جسم يرمي استثناءً
 *    يُرجَع نصه للعميل عبر e.message، فيسرّب تفاصيل داخلية.
 *
 * 3) لم يكن هناك تحقّق من وجود ANTHROPIC_API_KEY. عند غيابها كان الطلب
 *    يُرسل بمفتاح undefined ويعود بخطأ مصادقة غامض بدل رسالة إعداد واضحة.
 *
 * 4) كان الطراز مثبّتاً على إصدار قديم.
 */

const MAX_PROMPT_CHARS = 6000;
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

/* تحديد معدّل داخل الذاكرة. ملاحظة صريحة: على منصة بلا حالة مشتركة بين
   النسخ، هذا يحدّ من الاستخدام لكل نسخة لا عالمياً. يمنع الإساءة العابرة
   لكنه ليس بديلاً عن بوابة معدّل حقيقية عند الاستخدام الجاد. */
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const win = (hits.get(key) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  if (win.length >= RATE_LIMIT.maxRequests) return true;
  win.push(now);
  hits.set(key, win);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < RATE_LIMIT.windowMs)) hits.delete(k);
  return false;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'خدمة المساعد غير مفعّلة: متغيّر البيئة ANTHROPIC_API_KEY غير مضبوط في إعدادات النشر'
    });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'rate_limited',
      message: `تجاوزت الحد المسموح (${RATE_LIMIT.maxRequests} طلبات في الدقيقة). حاول بعد قليل.`
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'missing_prompt', message: 'الحقل prompt مطلوب ويجب أن يكون نصاً' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({
      error: 'prompt_too_long',
      message: `طول النص ${prompt.length} حرفاً يتجاوز الحد ${MAX_PROMPT_CHARS}`
    });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: 'أنت مساعد تحليل كمي للسوق السعودي (تداول). أجب بالعربية، بإيجاز ودقة. '
          + 'لا تقدّم توصيات استثمارية مباشرة، ولا تذكر نسب نجاح أو احتمالات إلا إذا وردت في المعطيات مع حجم عينتها. '
          + 'إذا كانت المعطيات غير كافية لاستنتاج، قل ذلك صراحةً بدل التخمين.',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30_000)
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      /* لا نمرّر جسم خطأ المزوّد كما هو — قد يحتوي تفاصيل حساب أو مفتاح */
      console.error('anthropic upstream error', upstream.status, data?.error?.type);
      return res.status(502).json({
        error: 'upstream_error',
        message: 'تعذّر الحصول على رد من خدمة المساعد',
        type: data?.error?.type || null
      });
    }
    return res.status(200).json(data);
  } catch (e) {
    console.error('ai handler error', e);
    return res.status(e.name === 'TimeoutError' ? 504 : 500).json({
      error: e.name === 'TimeoutError' ? 'timeout' : 'internal_error',
      message: e.name === 'TimeoutError' ? 'انتهت مهلة الطلب' : 'خطأ داخلي'
    });
  }
}
