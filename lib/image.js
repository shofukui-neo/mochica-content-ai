// 画像生成。プロバイダは管理画面で選ぶ:
//   cloudflare … Cloudflare Workers AI（FLUX.1 schnell）。毎日の無料枠あり
//   gemini     … Gemini の画像モデル（課金設定が必要）
const err = (status, message) => Object.assign(new Error(message), { status });
// 共通の指示: 文字はアプリ側で重ねるので画像に入れさせない。実在の人物っぽさを避ける
const STYLE = 'Photorealistic, clean, bright, natural light, suitable for a corporate recruiting LINE menu. No text, no letters, no logos, no watermarks. No identifiable faces in close-up.';

async function toEnglish(settings, prompt) { // FLUXは日本語が苦手なので、Geminiのキーがあれば英訳してから渡す
  if (!settings.geminiKey) return prompt;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Translate this image description into one concise English prompt for an image model. Output only the prompt.\n\n${prompt}` }] }] }),
  }).catch(() => null);
  const j = await r?.json().catch(() => null);
  const t = (j?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  return t ? t.slice(0, 1500) : prompt;
}

async function cloudflare(settings, prompt) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${settings.cfAccountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { authorization: `Bearer ${settings.cfToken}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ prompt: `${await toEnglish(settings, prompt)}. ${STYLE}`.slice(0, 2048), steps: 8 }),
  });
  const j = await r.json().catch(() => ({}));
  const b64 = j.result?.image || j.image;
  if (!r.ok || !b64) throw err(r.status === 429 ? 429 : 502, `Cloudflare ${r.status}: ${j.errors?.[0]?.message || 'no image'}`.slice(0, 200));
  return { type: 'image/jpeg', body: Buffer.from(b64, 'base64') };
}

async function gemini(settings, prompt, aspect) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiImageModel)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${prompt}\n\n${STYLE}` }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect === 'wide' ? '16:9' : '1:1' } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  const part = (j.candidates?.[0]?.content?.parts || []).map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
  if (!r.ok || !part) throw err(r.status === 429 ? 429 : 502, `Gemini ${r.status}: ${j.error?.message || j.candidates?.[0]?.finishReason || 'no image'}`.slice(0, 200));
  return { type: part.mimeType || part.mime_type || 'image/png', body: Buffer.from(part.data, 'base64') };
}

export const imageReady = (s) => (s.imageProvider === 'cloudflare' && !!s.cfAccountId && !!s.cfToken) || (s.imageProvider === 'gemini' && !!s.geminiKey);

export async function generateImage(settings, { prompt, aspect }) {
  if (process.env.AI_MOCK) { // 1x1 の PNG
    return { type: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') };
  }
  if (!imageReady(settings)) throw err(503, '画像生成が未設定です。管理者に連絡してください');
  const r = settings.imageProvider === 'gemini' ? await gemini(settings, prompt, aspect) : await cloudflare(settings, prompt);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(r.type) || r.body.length < 100) throw err(502, '画像を生成できませんでした');
  return r;
}
