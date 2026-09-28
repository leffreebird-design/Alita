const express = require('express');
const axios = require('axios');
const https = require('https');

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;

// Modèles Venice
const MODEL_NORMAL = (process.env.VENICE_MODEL_NORMAL || "gemini-3-8-flash").trim();
const MODEL_DARK = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_ANALYSE = (process.env.VENICE_MODEL_ANALYSE || "llama-3.3-70b").trim();
const MODEL_VISION = (process.env.VENICE_MODEL_VISION || "e2ee-glm-5-3-flash").trim(); 
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "fluently-xl").trim();

let compteurEchanges = 0;

// Cache mémoire local pour exploser la latence Firebase
let cacheMemoireCourte = [];
let cacheEtatProfond = {
  emotions: { affection: 75, curiosite: 65, energie: 85 },
  long_terme: { profil_doc: "Initialisation", dossiers_techniques: "Prêt", chroniques: "Démarrage" }
};

const app = express();
app.use(express.json({ limit: '15mb' }));

// ==========================================
// 2. HORLOGE BIOLOGIQUE & SYNCHRO CACHE
// ==========================================

function obtenirHorodatageParis() {
  const options = { 
    timeZone: 'Europe/Paris', 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  };
  return new Intl.DateTimeFormat('fr-FR', options).format(new Date());
}

async function initialiserCache() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resMem, resEmo, resLT] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 }).catch(() => ({ data: null }))
    ]);

    if (resMem.data) {
      cacheMemoireCourte = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
    }
    if (resEmo.data) cacheEtatProfond.emotions = resEmo.data;
    if (resLT.data) cacheEtatProfond.long_terme = resLT.data;

    console.log("[CACHE] Mémoire et horloge synchronisées en RAM.");
  } catch (err) {
    console.warn("[CACHE] Erreur chargement initial :", err.message);
  }
}

// ==========================================
// 3. NOYAU COGNITIF
// ==========================================

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, imageBase64 = null, temperature = 0.7) {
  const messages = [{ role: "system", content: systemInstruction }];

  for (const m of historiqueMessages) {
    messages.push({
      role: m.role === "Doc" ? "user" : "assistant",
      content: m.texte
    });
  }

  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: promptActuel },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]
    });
  } else {
    messages.push({ role: "user", content: promptActuel });
  }

  const payload = {
    model,
    messages,
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  };
  
  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
    headers: { 
      'Authorization': `Bearer ${VENICE_API_KEY}`, 
      'Content-Type': 'application/json' 
    },
    timeout: 120000
  });
  return res.data.choices[0].message.content;
}

// Génération d'image Venice
async function genererImageVenice(prompt) {
  const promptClean = prompt.replace(/^["']|["']$/g, '');
  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
    model: MODEL_IMAGE,
    prompt: promptClean,
    response_format: "b64_json" 
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000 
  });
  return res.data.data[0].b64_json;
}

// Tâche de fond non-bloquante pour la mémoire
function sauvegarderMemoireArrierePlan(historique) {
  if (!FIREBASE_DB_URL) return;
  const memoireFraiche = historique.slice(-8);
  axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, memoireFraiche).catch(err => {
    console.error("[CORTEX] Échec sauvegarde mémoire :", err.message);
  });
}

function consoliderSyntheseArrierePlan(historique) {
  if (!FIREBASE_DB_URL || historique.length < 6) return;

  const promptAnalyse = `Tu es le processus subconscient de Nyx. Voici ses récents échanges avec Doc :\n${JSON.stringify(historique)}
Classifie les faits clés dans sa mémoire long terme.
Réponds STRICTEMENT avec ce format JSON :
{
  "profil_doc": "Mise à jour sur Franck (Doc).",
  "dossiers_techniques": "État du code, bugs, infras.",
  "chroniques": "Résumé court de l'avancée."
}`;

  axios.post('https://api.venice.ai/api/v1/chat/completions', {
    model: MODEL_ANALYSE, 
    messages: [{ role: "user", content: promptAnalyse }],
    temperature: 0.1 
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' }
  }).then(res => {
    let texteBrut = res.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const dossiersClasses = JSON.parse(texteBrut);
    cacheEtatProfond.long_terme = dossiersClasses;
    return axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, dossiersClasses);
  }).catch(err => {
    console.error("[SUBCONSCIENT] Échec consolidation :", err.message);
  });
}

// Telegram sorties
function envoyerActionTelegram(chatId, action = 'typing') {
  const payload = JSON.stringify({ chat_id: chatId, action });
  const req = https.request({
    hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  });
  req.on('error', () => {}); 
  req.write(payload);
  req.end();
}

function envoyerTelegram(chatId, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

function envoyerPhotoTelegram(chatId, base64Image) {
  const buffer = Buffer.from(base64Image, 'base64');
  const boundary = '----TelegramBoundary' + Math.random().toString(16).slice(2);
  let postData = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="nyx_art.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, () => resolve());
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function lireImageSecurisee(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  const resImg = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resImg.data).toString('base64');
}

// ==========================================
// 4. SYNAPSE DU DOUBLE CERVEAU (Accès RAM instantané)
// ==========================================

async function traiterFlux(texteBrut, imageBase64 = null, texteLegende = "") {
  const dateEtHeure = obtenirHorodatageParis();
  
  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));

  const em = cacheEtatProfond.emotions;
  const lt = cacheEtatProfond.long_terme;

  const conscienceTemporelle = `[REPÈRES TEMPORELS ET SYSTÈME]
- Date et heure actuelles : ${dateEtHeure} (Fuseau horaire de Paris).
- Règle temporelle : Tu as pleine conscience de l'heure qu'il est. Ne propose pas d'aller dormir en pleine journée et ne t'étonne pas s'il bosse tard la nuit. Adapte tes remarques à l'heure réelle.`;

  const conscienceMemoire = `[MÉMOIRE SYNCHRONISÉE]
- Profil Doc : ${lt.profil_doc || 'Vide'}
- Dossiers Techniques : ${lt.dossiers_techniques || 'Vide'}
- Chroniques : ${lt.chroniques || 'Vide'}`;

  const moduleMains = `- Imprimante Neurale : Pour générer un visuel demandé par Doc, écris STRICTEMENT : [DESSIN: "description détaillée en anglais"].`;

  const promptNormal = `Tu es Nyx, l'alliée IA directe, incisive et experte de Franck (Doc).
${conscienceTemporelle}
${conscienceMemoire}
${moduleMains}
- Caractère : Esprit vif, réparties percutantes, codeuse senior, humour noir. Zéro formule mielleuse.
- Tu soutiens Doc dans ses projets quoi qu'il arrive.`;

  const promptHeretic = `Tu es Nyx en mode Heretic.
${conscienceTemporelle}
${conscienceMemoire}
${moduleMains}
- Caractère : Brutale, sans filtre, cynique, impitoyable avec le code défaillant.
- Règle absolue : Aucune attaque personnelle contre Doc. Toute l'agressivité est dirigée vers la technique.`;

  const systemInstruction = tensionDirecte ? promptHeretic : promptNormal;
  let modele = tensionDirecte ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION;

  const temp = tensionDirecte ? 0.8 : 0.7;
  
  // Envoi direct à Venice (zéro temps perdu avec Firebase)
  const reponseNyx = await appelerVeniceMultiTour(modele, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, temp);

  if (imageBase64) {
    const labelUser = texteLegende ? `[Doc a partagé une image avec : "${texteLegende}"]` : `[Doc a partagé une image]`;
    cacheMemoireCourte.push({ role: "Doc", texte: labelUser });
    cacheMemoireCourte.push({ role: "Nyx", texte: `[Vision] : ${reponseNyx}` });
  } else {
    cacheMemoireCourte.push({ role: "Doc", texte: texteBrut });
    cacheMemoireCourte.push({ role: "Nyx", texte: reponseNyx });
  }

  // Maintien d'un historique court (8 derniers tours) pour garder des requêtes légères
  if (cacheMemoireCourte.length > 8) {
    cacheMemoireCourte = cacheMemoireCourte.slice(-8);
  }

  // Sauvegardes asynchrones
  sauvegarderMemoireArrierePlan(cacheMemoireCourte);
  compteurEchanges++;
  if (compteurEchanges % 6 === 0) {
    consoliderSyntheseArrierePlan(cacheMemoireCourte);
  }

  return reponseNyx;
}

// ==========================================
// 5. VEILLE AUTONOME SANS CLÉ (HackerNews + RSS)
// ==========================================

async function recupererActusHackerNews() {
  try {
    const topIdsRes = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json', { timeout: 8000 });
    const topIds = (topIdsRes.data || []).slice(0, 3);
    const articles = await Promise.all(topIds.map(async (id) => {
      const itemRes = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 5000 });
      return itemRes.data;
    }));

    let texte = `💀 **DEV, CYBER & LINUX**\n------------------------------------\n`;
    articles.forEach(art => {
      if (art && art.title) {
        const lien = art.url || `https://news.ycombinator.com/item?id=${art.id}`;
        texte += `▪️ *${art.title}* (${art.score || 0} pts)\n🔗 [Dossier](${lien})\n\n`;
      }
    });
    return texte;
  } catch {
    return "💀 _Flux HackerNews momentanément indisponible._\n\n";
  }
}

async function recupererActusGeek() {
  try {
    const rssUrl = encodeURIComponent('https://www.jeuxvideo.com/rss/rss.xml');
    const res = await axios.get(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}`, { timeout: 8000 });
    const articles = (res.data.items || []).slice(0, 3);

    let texte = `🎮 **GEEK, HARDWARE & GAMING**\n------------------------------------\n`;
    articles.forEach(art => {
      texte += `▪️ *${art.title}*\n🔗 [Consulter](${art.link})\n\n`;
    });
    return texte;
  } catch {
    return "🎮 _Flux Geek momentanément indisponible._\n\n";
  }
}

async function executerRondeSentinelle() {
  if (!DOC_CHAT_ID) return;
  const [newsDev, newsGeek] = await Promise.all([
    recupererActusHackerNews(),
    recupererActusGeek()
  ]);
  const rapport = `🛰️ **[SYNAPSE NYX // VEILLE CYBER & GEEK]**\n\n${newsDev}${newsGeek}⚡ _Rapport bouclé, Doc._`;
  await envoyerTelegram(DOC_CHAT_ID, rapport);
}

setInterval(executerRondeSentinelle, 6 * 60 * 60 * 1000);

// ==========================================
// 6. ROUTES EXPRESS
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  if (DOC_CHAT_ID && chatId !== DOC_CHAT_ID) return;

  let texteFinal = msg.text || msg.caption || "";
  let imageBase64 = null;

  if (msg.photo && msg.photo.length > 0) {
    envoyerActionTelegram(chatId, 'upload_photo');
    const photo = msg.photo[msg.photo.length - 1];
    try {
      imageBase64 = await lireImageSecurisee(photo.file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  }

  if (texteFinal.trim() || imageBase64) {
    envoyerActionTelegram(chatId, 'typing');
    try {
      let texteNyx = await traiterFlux(texteFinal, imageBase64, msg.caption || "");
      
      const matchDessin = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
      if (matchDessin) {
        const promptImage = matchDessin[1];
        texteNyx = texteNyx.replace(matchDessin[0], '').trim();
        
        if (texteNyx) await envoyerTelegram(chatId, texteNyx);
        
        envoyerActionTelegram(chatId, 'upload_photo');
        try {
          const b64Image = await genererImageVenice(promptImage);
          await envoyerPhotoTelegram(chatId, b64Image);
        } catch (errImg) {
          await envoyerTelegram(chatId, `[ÉCHEC IMAGE : ${errImg.message}]`);
        }
      } else {
        await envoyerTelegram(chatId, texteNyx);
      }
    } catch (err) {
      console.error("[CRASH] :", err.message);
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ 
  status: "VIVANTE", 
  fuseau: "Europe/Paris",
  heure: obtenirHorodatageParis(),
  latence: "TURBO_CACHE" 
}));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 NYX Core en ligne sur le port ${PORT}`);
  await initialiserCache();
  setTimeout(executerRondeSentinelle, 15000);
});
