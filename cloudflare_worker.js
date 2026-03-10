/**
 * TestPro — Cloudflare Worker (CORS Proxy)
 * ==========================================
 * Streamlit CORS qo'llab-quvvatlamaydi.
 * Bu worker sayt → Streamlit so'rovlariga CORS qo'shadi.
 *
 * Deploy:
 *   1. https://workers.cloudflare.com → yangi worker
 *   2. Bu kodni joylashtiring
 *   3. STREAMLIT_URL ni o'zgartiring
 *   4. Worker URL → js/api.js da API_URL ga yozing
 */

const STREAMLIT_URL = 'https://webapiquizmarkerbot.streamlit.app/';  // ← o'zgartiring

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-TG-ID',
          'Access-Control-Max-Age':       '86400',
        }
      });
    }

    // So'rovni Streamlit ga yo'naltirish
    const target = STREAMLIT_URL + url.pathname + url.search;
    const init   = {
      method:  request.method,
      headers: { 'Content-Type': 'application/json' },
    };

    const tgId = request.headers.get('X-TG-ID');
    if (tgId) init.headers['X-TG-ID'] = tgId;

    if (request.method === 'POST') {
      const body = await request.text();
      // Streamlit query params orqali body yuboradi
      const targetUrl = new URL(target);
      targetUrl.searchParams.set('m', 'POST');
      if (body) targetUrl.searchParams.set('body', body);
      const res = await fetch(targetUrl.toString(), { method: 'GET', headers: init.headers });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // GET so'rovi
    const res  = await fetch(target, init);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
