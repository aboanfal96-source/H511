/* ══════════════════════════════════════════════════════════════════════════
   /api/ai — وسيط استدعاء Claude
   ──────────────────────────────────────────────────────────────────────────
   دور هذه الدالة إخفاء مفتاح الواجهة البرمجية خلف الخادم لا أكثر. التحليل
   الكمي كله يتم في engine/core.js قبل الوصول إلى هنا؛ النموذج يشرح المخرجات
   المحسوبة ولا يُطلب منه اختراع أرقام دخول أو وقف أو أهداف.

   🛠️ ثلاثة إصلاحات على النسخة السابقة:

   ① معرّف النموذج كان `claude-sonnet-4-20250514` — جيل سابق. صار
      `claude-opus-5`، ويمكن تجاوزه بمتغيّر بيئة عند الحاجة.
   ② لم يكن هناك أي تحقّق: لا من الطريقة (POST)، ولا من وجود المفتاح، ولا
      من نوع `prompt` ولا من طوله. طلب بلا `prompt` كان يمرّ إلى Anthropic
      ويعود بخطأ 400 غامض، وطلب بمليون حرف كان يمرّ كما هو.
   ③ الاستجابة كانت تُعاد بحالة 200 دائماً حتى حين يفشل النداء، فتظهر
      رسالة خطأ المزوّد داخل واجهة تحسبها تحليلاً. الآن تُمرَّر حالة الخطأ.

   وشكل الخطأ موحَّد مع ما تقرأه الواجهة فعلاً في runAI:
      { error: <رمز آلي>, message: <نص عربي للعرض> }
   الواجهة تعرض `message` وتفرّع على `error === 'not_configured'` لتُظهر
   خطوات ضبط المفتاح. إرجاع نص عربي في حقل `error` وحده — كما فعلت نسخة
   وسيطة من هذا الملف — يجعل الواجهة تعرض «تعذّر الاتصال (HTTP 503)» ولا
   تُظهر خطوات الضبط إطلاقاً.

   يبقى النداء عبر fetch مباشرةً: المستودع بلا أي اعتمادية npm ولا خطوة
   بناء، وإضافة حزمة لأجل نداء واحد تغيّر شكل النشر على Vercel بلا داعٍ.
   ══════════════════════════════════════════════════════════════════════════ */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const MAX_PROMPT_CHARS = 20000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({
      error: 'not_configured',
      message: 'خدمة التحليل النصي غير مُهيّأة على الخادم — مفتاح ANTHROPIC_API_KEY غير مضبوط.'
    });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const prompt = body && body.prompt;

  if (typeof prompt !== 'string' || !prompt.trim())
    return res.status(400).json({ error: 'bad_request', message: 'الطلب بلا نص تحليل' });
  if (prompt.length > MAX_PROMPT_CHARS)
    return res.status(413).json({ error: 'prompt_too_long', message: `النص أطول من الحد المسموح (${MAX_PROMPT_CHARS} حرفاً)` });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        /* التفكير التكيّفي: النموذج يقرّر عمق الاستدلال بنفسه، ولا يُمرَّر
           budget_tokens — فهو مرفوض على هذا الجيل. */
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(55000)
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const code = upstream.status === 429 ? 'rate_limited'
        : upstream.status === 401 || upstream.status === 403 ? 'auth_failed'
        : 'upstream_error';
      const message = upstream.status === 429
        ? 'تجاوزت حدّ الطلبات المسموح — أعد المحاولة بعد قليل.'
        : (code === 'auth_failed'
          ? 'مفتاح الواجهة البرمجية مرفوض — تحقّق من صحته وصلاحيته.'
          : (data?.error?.message || `فشل نداء المزوّد (HTTP ${upstream.status})`));
      return res.status(upstream.status).json({ error: code, message, status: upstream.status });
    }

    /* رفض السلامة يعود بحالة 200 ومحتوى فارغ — يُصرَّح به بدل عرض فراغ */
    if (data?.stop_reason === 'refusal')
      return res.status(200).json({ ...data, notice: 'امتنع النموذج عن الإجابة على هذا الطلب' });

    return res.status(200).json(data);
  } catch (e) {
    const timeout = e && e.name === 'TimeoutError';
    return res.status(timeout ? 504 : 500).json({
      error: timeout ? 'timeout' : 'internal_error',
      message: timeout ? 'انتهت مهلة نداء التحليل النصي — أعد المحاولة.' : (e.message || 'خطأ غير متوقع')
    });
  }
}
