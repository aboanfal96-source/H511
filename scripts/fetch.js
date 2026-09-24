/* ══════════════════════════════════════════════════════════════════════════
   scripts/fetch.js — جلب الشموع للأدوات التي تعمل خارج المتصفّح
   ──────────────────────────────────────────────────────────────────────────
   مشترك بين فاحص التنبيهات وأداة التشخيص، حتى لا يختلف ما يُقاس عمّا
   يُنبَّه عليه. ويدعم «لقطة»: حفظ الاستجابات الخام في ملف ثم إعادة التشغيل
   عليها بلا شبكة — فيُكرَّر القياس على بيانات السوق الحقيقية نفسها.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* إعادة المحاولة بتباعد أسّي: ياهو يردّ 429 أحياناً على عناوين مراكز
   البيانات، والفشل الصامت لسهم واحد يعني تنبيهاً ضائعاً لا عطلاً ظاهراً. */
async function fetchCandles(sym, range, apiBase) {
  const url = apiBase
    ? `${apiBase}/api/stock?symbol=${encodeURIComponent(sym)}&range=${range}&interval=1d`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.SR?range=${range}&interval=1d`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ksa-alerts/1.0)', 'accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * Math.pow(2, attempt)); continue; }
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      if (!res) return { ok: false, reason: (d && d.chart && d.chart.error && d.chart.error.description) || 'استجابة بلا نتائج' };
      return { ok: true, res };
    } catch (e) {
      if (attempt === 3) return { ok: false, reason: e.name === 'TimeoutError' ? 'مهلة' : (e.message || 'تعذّر الاتصال') };
      await sleep(800 * Math.pow(2, attempt));
    }
  }
  return { ok: false, reason: 'فشل بعد أربع محاولات' };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/** يحفظ الاستجابات الخام {sym: res} مضغوطة. */
function writeSnapshot(p, raw, meta) {
  const body = JSON.stringify({ takenAt: new Date().toISOString(), meta: meta || {}, raw });
  fs.writeFileSync(p, zlib.gzipSync(body));
}
function readSnapshot(p) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
}

/**
 * يحمّل الأسهم في سياق التطبيق — من الشبكة أو من لقطة.
 * @returns {Promise<{ok:number, failed:string[], raw:Object, takenAt:string|null}>}
 */
async function loadInto(ctx, syms, opt) {
  opt = opt || {};
  const raw = {}, failed = [];
  let ok = 0, takenAt = null;
  const apply = (sym, res) => {
    try {
      const p = ctx.parseY(res, sym);
      if (!p || !p.cs || p.cs.length < (opt.minBars || 120)) { failed.push(`${sym}: شموع غير كافية`); return; }
      ctx.applyY(sym, p);
      ok++;
    } catch (e) { failed.push(`${sym}: ${e.message}`); }
  };
  if (opt.from) {
    const snap = readSnapshot(opt.from);
    takenAt = snap.takenAt;
    for (const sym of syms) {
      if (!snap.raw[sym]) { failed.push(`${sym}: غائب عن اللقطة`); continue; }
      raw[sym] = snap.raw[sym];
      apply(sym, snap.raw[sym]);
    }
  } else {
    await mapLimit(syms, opt.concurrency || 5, async (sym) => {
      const r = await fetchCandles(sym, opt.range || '5y', opt.apiBase || '');
      if (!r.ok) { failed.push(`${sym}: ${r.reason}`); return; }
      raw[sym] = r.res;
      apply(sym, r.res);
    });
  }
  return { ok, failed, raw, takenAt };
}

module.exports = { fetchCandles, mapLimit, writeSnapshot, readSnapshot, loadInto, sleep };
