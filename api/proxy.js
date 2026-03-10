/**
 * TestPro — Vercel Edge Proxy
 *
 * GET  /api/proxy?endpoint=tests/public       → Streamlit (RAM meta)
 * GET  /api/proxy?endpoint=test/{id}/full     → Streamlit (TG lazy load)
 * GET  /api/proxy?endpoint=user/{uid}         → Telegram Bot API
 * POST /api/proxy?endpoint=admin/login        → parol tekshirish
 * POST /api/proxy?endpoint=result/save&body=  → Streamlit
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN          = "123:ABC..."
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 *   STREAMLIT_API_URL  = "https://webapiquizmarkerbot.streamlit.app"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN       = process.env.BOT_TOKEN       || '';
const ADMIN_IDS       = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'admin123';
const STREAMLIT_URL   = (process.env.STREAMLIT_API_URL || 'https://webapiquizmarkerbot.streamlit.app').replace(/\/$/, '');
const TG_API          = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// Streamlit ga so'rov yuborish
async function streamlit(endpoint, body = null) {
  const url = new URL(STREAMLIT_URL + '/');
  url.searchParams.set('endpoint', endpoint);
  if (body) url.searchParams.set('body', JSON.stringify(body));

  try {
    const res  = await fetch(url.toString(), { method: 'GET' });
    const text = await res.text();

    // Streamlit uyquda bo'lsa HTML qaytaradi
    if (text.trim().startsWith('<')) {
      return { _sleeping: true };
    }
    return JSON.parse(text);
  } catch (e) {
    return { error: e.message };
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── user/{uid} — Telegram Bot API orqali ──
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!uid || !/^\d+$/.test(uid)) return jsonResp({ error: "Noto'g'ri ID" });

    try {
      const res  = await fetch(`${TG_API}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: parseInt(uid) })
      });
      const data = await res.json();

      if (data.ok && data.result) {
        const u = data.result;
        return jsonResp({
          id:       u.id,
          name:     [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
          username: u.username || '',
          is_admin: ADMIN_IDS.includes(String(u.id)),
        });
      }
      return jsonResp({ error: 'Topilmadi' });
    } catch (e) {
      return jsonResp({ error: e.message });
    }
  }

  // ── admin/login ──
  if (ep === 'admin/login') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { uid, password } = body;

    if (!ADMIN_IDS.includes(String(uid))) {
      return jsonResp({ ok: false, error: 'Siz admin emassiz' });
    }
    if (password !== ADMIN_PASSWORD) {
      return jsonResp({ ok: false, error: "Parol noto'g'ri" });
    }
    return jsonResp({ ok: true });
  }

  // ── Qolgan endpointlar → Streamlit API (RAM + TG lazy load) ──
  const data = await streamlit(ep);

  if (data._sleeping) {
    return jsonResp({
      _sleeping: true,
      message: 'Server uyg\'onmoqda, 10 soniyadan keyin qayta urining'
    }, 503);
  }

  return jsonResp(data);
}
