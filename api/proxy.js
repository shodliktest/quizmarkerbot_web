/**
 * TestPro — Vercel API Route
 * /api/proxy?endpoint=...
 *
 * Environment Variables (Vercel Settings → Environment Variables):
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   ADMIN_IDS          = "123456789,987654321"
 *   ADMIN_PASSWORD     = "sizning_parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN      = process.env.BOT_TOKEN      || '';
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TG_API         = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── user/{uid} — Telegram getChat orqali ──
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!uid || !/^\d+$/.test(uid)) return json({ error: "Noto'g'ri ID" });

    try {
      const res  = await fetch(`${TG_API}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: parseInt(uid) })
      });
      const data = await res.json();

      if (data.ok && data.result) {
        const u = data.result;
        return json({
          id:       u.id,
          name:     [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
          username: u.username || '',
          is_admin: ADMIN_IDS.includes(String(u.id)),
        });
      }
      return json({ error: 'Topilmadi' });
    } catch (e) {
      return json({ error: e.message });
    }
  }

  // ── admin/login — parol tekshirish ──
  if (ep === 'admin/login') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { uid, password } = body;

    if (!ADMIN_IDS.includes(String(uid))) {
      return json({ ok: false, error: 'Siz admin emassiz' });
    }
    if (password !== ADMIN_PASSWORD) {
      return json({ ok: false, error: "Parol noto'g'ri" });
    }
    return json({ ok: true });
  }

  return json({ error: "Noma'lum endpoint" }, 404);
}
