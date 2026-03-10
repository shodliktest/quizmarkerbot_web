/**
 * TestPro — Vercel Edge Proxy
 * Streamlit kerak emas — to'g'ridan Telegram Bot API orqali ishlaydi
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN    = process.env.BOT_TOKEN          || '';
const CHANNEL_ID   = process.env.STORAGE_CHANNEL_ID || '';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASS   = process.env.ADMIN_PASSWORD     || 'admin123';
const TG           = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};


// ── Session tekshirish ──
function getSession(request) {
  // Admin login qilinganligini tekshirish — bu yerda faqat admin/login endpoint orqali
  // Vercel Edge da cookie yo'q — biz admin/login da server da tekshiramiz
  // Client tomonda localStorage da saqlanadi
  return true; // Proxy da hamma so'rov admin/login dan o'tgan deb hisoblaymiz
}

function normMeta(t) {
  if (!t.id) t.id = t.test_id;
  if (!t.authorId) t.authorId = String(t.creator_id || '');
  if (!t.subject) t.subject = t.category || 'other';
  return t;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// ── TG Bot API yordamchi ──
async function tgPost(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── Index JSON ni yuklab olish (pinned message dan) ──
let _indexCache   = null;
let _indexCacheTs = 0;

async function getIndex() {
  // 2 daqiqa cache
  if (_indexCache && Date.now() - _indexCacheTs < 120000) return _indexCache;

  try {
    // 1. Pinned message ni ol
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    if (!pin?.document) return null;

    // 2. File path ol
    const fileRes = await tgPost('getFile', { file_id: pin.document.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    // 3. Faylni yukla
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const raw     = await fetch(fileUrl);
    const data    = await raw.json();

    if (data?.tests_meta) {
      _indexCache   = data;
      _indexCacheTs = Date.now();
      return data;
    }
  } catch (e) {
    console.error('getIndex error:', e);
  }
  return null;
}

// ── Test to'liq savollarini msg_id dan yuklab olish ──
async function getTestFull(msgId) {
  try {
    // Forward qilib file_id olish
    const fwd = await tgPost('forwardMessage', {
      chat_id:     CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id:  parseInt(msgId)
    });
    const doc = fwd?.result?.document;
    if (!doc) return null;

    // O'chirish (kerak emas)
    tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: fwd.result.message_id });

    // Faylni yukla
    const fileRes = await tgPost('getFile', { file_id: doc.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const raw = await fetch(fileUrl);
    return raw.json();
  } catch (e) {
    return null;
  }
}

// ════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════
export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── tests/public — index dan meta (tezkor) ──
  if (ep === 'tests/public') {
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const tests = (index.tests_meta || []).filter(
      t => t.visibility === 'public' && t.is_active !== false
    );
    // Savollarni olib tashlaymiz — faqat meta
    const meta = tests.map(({ questions, ...t }) => normMeta(t));
    // creator_name — creator_id dan Telegram getChat bilan olish (parallel)
    await Promise.all(meta.map(async t => {
      if (t.creator_id && !t.creator_name) {
        try {
          const r = await tgPost('getChat', { chat_id: t.creator_id });
          if (r?.ok) {
            const u = r.result;
            t.creator_name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
          }
        } catch {}
      }
    }));
    return jsonResp(meta.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── tests/my?uid=X ──
  if (ep === 'tests/my') {
    const uid   = url.searchParams.get('uid') || '';
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const mine = (index.tests_meta || [])
      .filter(t => String(t.creator_id) === uid)
      .map(({ questions, ...t }) => normMeta(t));
    return jsonResp(mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── test/{id}/full — savollar bilan (TG lazy load) ──
  if (ep.startsWith('test/') && ep.endsWith('/full')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test topilmadi' });

    const full = await getTestFull(msgId);
    if (!full || !full.questions?.length) {
      return jsonResp({ error: 'Savollar yuklanmadi' });
    }

    const meta = (index.tests_meta || []).find(t => t.test_id === tid) || {};
    const tData = { ...meta, ...full, questions: undefined };
    tData.id       = tData.id       || tData.test_id;
    tData.authorId = tData.authorId || String(tData.creator_id || "");
    tData.subject  = tData.subject  || tData.category || "other";
    return jsonResp({ testData: tData, questions: full.questions, total: full.questions.length });
    });
  }

  // ── test/{id}/meta ──
  if (ep.startsWith('test/') && ep.endsWith('/meta')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    return jsonResp(meta || { error: 'Topilmadi' });
  }

  // ── user/{uid} — Telegram getChat ──
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!/^\d+$/.test(uid)) return jsonResp({ error: "Noto'g'ri ID" });

    const res  = await tgPost('getChat', { chat_id: parseInt(uid) });
    if (res?.ok && res.result) {
      const u = res.result;
      return jsonResp({
        id:       u.id,
        name:     [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
        username: u.username || '',
        is_admin: ADMIN_IDS.includes(String(u.id)),
      });
    }
    return jsonResp({ error: 'Topilmadi' });
  }

  // ── admin/login ──
  if (ep === 'admin/login') {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!ADMIN_IDS.includes(String(body.uid))) {
      return jsonResp({ ok: false, error: 'Siz admin emassiz' });
    }
    if (body.password !== ADMIN_PASS) {
      return jsonResp({ ok: false, error: "Parol noto'g'ri" });
    }
    return jsonResp({ ok: true });
  }


  // ── admin/tests — barcha testlar (admin uchun) ──
  if (ep === 'admin/tests') {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const tests = (index.tests_meta || []).map(({ questions, ...t }) => normMeta(t));
    await Promise.all(tests.map(async t => {
      if (t.creator_id && !t.creator_name) {
        try {
          const r = await tgPost('getChat', { chat_id: t.creator_id });
          if (r?.ok) {
            const u = r.result;
            t.creator_name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
          }
        } catch {}
      }
    }));
    return jsonResp(tests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── admin/test/{id}/pause ──
  if (ep.match(/^admin\/test\/.+\/pause$/)) {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    // Note: pause state is in bot RAM — bu yerda faqat OK qaytaramiz
    // Haqiqiy pause bot orqali amalga oshiriladi
    return jsonResp({ ok: true, note: 'Bot orqali amalga oshiriladi' });
  }

  // ── admin/test/{id}/delete ──
  if (ep.match(/^admin\/test\/.+\/delete$/)) {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    return jsonResp({ ok: true, note: 'Bot orqali amalga oshiriladi' });
  }

  return jsonResp({ error: "Noma'lum endpoint" }, 404);
}
