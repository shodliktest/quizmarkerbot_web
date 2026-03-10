/**
 * TestPro — Vercel Edge Function (CORS Proxy)
 * Sayt → bu proxy → Streamlit API
 */

const STREAMLIT_URL = 'https://webapiquizmarkerbot.streamlit.app';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age':       '86400',
      }
    });
  }

  // Query params ni Streamlit ga uzatish
  const target = new URL(STREAMLIT_URL + '/');
  url.searchParams.forEach((val, key) => target.searchParams.set(key, val));

  try {
    const res  = await fetch(target.toString(), { method: 'GET' });
    const text = await res.text();

    // Streamlit HTML qaytarsa — JSON yo'q demak
    let body = text;
    if (text.trim().startsWith('<')) {
      body = JSON.stringify({ error: 'Streamlit hali yuklanmagan, qayta urining' });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
