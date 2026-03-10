# TestPro — Streamlit + Telegram integratsiya

## Qisqa reja

```
Sayt (GitHub Pages / Netlify)
        ↕  fetch()
Cloudflare Worker  ← CORS hal qiladi
        ↕
Streamlit API  ←→  Bot (utils/tg_db)  ←→  TG kanal (ma'lumotlar)
```

---

## 1-qadam: Streamlit ga bot papkasini qo'shish

Streamlit app papkasiga botingizdan ko'chirish:
```
utils/
  tg_db.py
  ram_cache.py
  db.py
streamlit_api.py    ← bu fayl
```

`.streamlit/secrets.toml`:
```toml
BOT_TOKEN          = "123456:ABC..."
BOT_USERNAME       = "YourBotUsername"
ADMIN_IDS          = "123456789"
STORAGE_CHANNEL_ID = "-1001234567890"
```

---

## 2-qadam: Cloudflare Worker

1. https://workers.cloudflare.com → yangi worker yarating
2. `cloudflare_worker.js` mazmunini joylashtiring
3. `STREAMLIT_URL` ni Streamlit app URL ga o'zgartiring
4. Deploy → worker URL ni oling (masalan: `https://testpro.your.workers.dev`)

---

## 3-qadam: js/api.js sozlash

`js/api.js` faylida **faqat 2 qator**:

```js
const BOT_USERNAME = 'YourBotUsername';           // Telegram bot @username
const API_URL      = 'https://testpro.your.workers.dev';  // Cloudflare Worker URL
```

---

## 4-qadam: Telegram Bot ni sozlash

BotFather da:
```
/setdomain → bot domenini sayt domeniga ruxsat bering
```
Masalan: `testpro.netlify.app` yoki `your.github.io`

---

## 5-qadam: Saytni deploy qilish

**GitHub Pages:**
```bash
git add . && git commit -m "Streamlit API" && git push
```
Settings → Pages → main branch → / (root)

**Netlify:** `Test-main` papkasini drag & drop

---

## Ishlash tartibi

1. Foydalanuvchi saytga kiradi
2. `login.html` → Telegram Login Widget → `TGAuth.onLogin()` chaqiriladi
3. Telegram ma'lumotlari `localStorage` ga saqlanadi
4. `DB.getPublicTests()` → Cloudflare Worker → Streamlit → `tg_db` → TG kanal
5. Test natijasi → `DB.saveResult()` → Streamlit → bot DB ga yoziladi

