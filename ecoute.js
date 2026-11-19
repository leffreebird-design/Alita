5a6
> const { promisify } = require('util');
25a27,40
> // [OPTIM] Connexions HTTPS réutilisées (keep-alive) pour tous les appels axios (LLM, Firebase, Telegram...)
> axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
> 
> // [SÉCU] Comparaison de secrets en temps constant (évite les attaques par timing)
> function comparerTokenSecurise(fourni, attendu) {
>   const a = crypto.createHash('sha256').update(String(fourni || '')).digest();
>   const b = crypto.createHash('sha256').update(String(attendu || '')).digest();
>   return crypto.timingSafeEqual(a, b);
> }
> 
> // [SÉCU] Plafond de taille APRÈS décompression (anti zip-bomb). Réglable via MAX_DECOMPRESSION_MO.
> const LIMITE_DECOMPRESSION_OCTETS = (parseInt(process.env.MAX_DECOMPRESSION_MO, 10) || 150) * 1024 * 1024;
> const gunzipAsync = promisify(zlib.gunzip);
> 
62a78
> const TELEGRAM_WEBHOOK_SECRET = assainirParametre(process.env.TELEGRAM_WEBHOOK_SECRET).replace(/[^A-Za-z0-9_-]/g, '');
159a176,186
> // [OPTIM] Une seule écriture Firebase de la mémoire par rafale de messages (debounce 1,5 s)
> let timerSauvegardeMemoire = null;
> function sauvegarderMemoireFirebase() {
>   if (!FIREBASE_DB_URL) return;
>   clearTimeout(timerSauvegardeMemoire);
>   timerSauvegardeMemoire = setTimeout(() => {
>     axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte, { timeout: 8000 })
>       .catch(e => console.warn("[FIREBASE MÉMOIRE KO]", e.message));
>   }, 1500);
> }
> 
196,198c223,228
< let fileAttenteTraitement = Promise.resolve();
< function empilerTraitement(action) {
<   fileAttenteTraitement = fileAttenteTraitement
---
> // [OPTIM] File par « voie » : même comportement série qu'avant par défaut ('conversation'),
> // mais les tâches lourdes (atelier 3D) n'empêchent plus Telegram/PWA de répondre.
> const voiesTraitement = new Map();
> function empilerTraitement(action, voie = 'conversation') {
>   const precedent = voiesTraitement.get(voie) || Promise.resolve();
>   const suivant = precedent
200,201c230,232
<     .catch(err => console.error("[FILE TRAITEMENT ERREUR]", err.message));
<   return fileAttenteTraitement;
---
>     .catch(err => console.error(`[FILE TRAITEMENT ERREUR:${voie}]`, err.message));
>   voiesTraitement.set(voie, suivant);
>   return suivant;
883c914
<     const decomp = zlib.gunzipSync(buffer);
---
>     const decomp = zlib.gunzipSync(buffer, { maxOutputLength: LIMITE_DECOMPRESSION_OCTETS });
935c966
<         rawBuf = zlib.inflateRawSync(compSlice);
---
>         rawBuf = zlib.inflateRawSync(compSlice, { maxOutputLength: LIMITE_DECOMPRESSION_OCTETS });
1727c1758
<         axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});
---
>         sauvegarderMemoireFirebase();
3568c3599
<     if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});
---
>     sauvegarderMemoireFirebase();
3580a3612,3615
>   // [SÉCU] Si TELEGRAM_WEBHOOK_SECRET est défini, seul Telegram (qui renvoie ce secret) est accepté
>   if (TELEGRAM_WEBHOOK_SECRET && !comparerTokenSecurise(req.headers['x-telegram-bot-api-secret-token'], TELEGRAM_WEBHOOK_SECRET)) {
>     return res.sendStatus(401);
>   }
4157c4192
<   if (!CRON_SECRET || tokenFourni !== CRON_SECRET) {
---
>   if (!CRON_SECRET || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
4344c4379
<   if (TELEGRAM_BOT_TOKEN && (!CRON_SECRET || tokenFourni !== CRON_SECRET)) {
---
>   if (!CRON_SECRET || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
4362c4397
<       buffer = zlib.gunzipSync(buffer);
---
>       buffer = await gunzipAsync(buffer, { maxOutputLength: LIMITE_DECOMPRESSION_OCTETS });
4404c4439
<       });
---
>       }, 'atelier');
4422c4457
<   if (!CRON_SECRET || tokenFourni !== CRON_SECRET) {
---
>   if (!CRON_SECRET || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
4446c4481,4482
<       const urlWebhook = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/setWebhook?url=" + encodeURIComponent(webhookUrl);
---
>       const urlWebhook = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/setWebhook?url=" + encodeURIComponent(webhookUrl)
>         + (TELEGRAM_WEBHOOK_SECRET ? "&secret_token=" + encodeURIComponent(TELEGRAM_WEBHOOK_SECRET) : "");
