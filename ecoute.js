const express = require('express');
const axios = require('axios');
const https = require('https');
const pdfParse = require('pdf-parse'); 
const mammoth = require('mammoth');

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;

// Modèles 
const MODEL_DARK = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "fluently-xl").trim();

let compteurEchanges = 0;

// Cache mémoire local ultra-rapide
let cacheMemoireCourte = [];
let cacheEtatProfond = {
  emotions: { affection: 75, curiosite: 65, energie: 85 },
  long_terme: { profil_doc: "Initialisation", dossiers_techniques: "Prêt", chroniques: "Démarrage" },
  reveil: { actif: false, heure: 7, minute: 30, jours: [1,2,3,4,5], etat: "attente" } 
};

const app = express();
app.use(express.json({ limit: '15mb' }));

// ==========================================
// 2. HORLOGE BIOLOGIQUE & SYNCHRO CACHE
// ==========================================

function obtenirHorodatageParis() {
  const options = { timeZone: 'Europe/Paris', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat('fr-FR', options).format(new Date());
}

async function initialiserCache() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resMem, resEmo, resLT, resRev] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/reveil.json`, { timeout: 3000 }).catch(() => ({ data: null }))
    ]);

    if (resMem.data) cacheMemoireCourte = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
    if (resEmo.data) cacheEtatProfond.emotions = resEmo.data;
    if (resLT.data) cacheEtatProfond.long_terme = resLT.data;
    if (resRev.data) cacheEtatProfond.reveil = resRev.data;

    console.log("[CACHE] Architecture mémorielle et paramètres synchronisés en RAM.");
  } catch (err) {
    console.warn("[CACHE] Erreur chargement initial :", err.message);
  }
}

// ==========================================
// 3. NOYAU COGNITIF & OUTILS (GEMINI + VENICE)
// ==========================================

// Le cortex rapide : Google Gemini 1.5 Flash
async function appelerGeminiMultiTour(systemInstruction, historiqueMessages, promptActuel, imageBase64 = null) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY manquante.");
  
  const contents = [];
  for (const m of historiqueMessages) {
    contents.push({
      role: m.role === "Doc" ? "user" : "model",
      parts: [{ text: m.texte }]
    });
  }

  const promptParts = [{ text: promptActuel }];
  if (imageBase64) {
    promptParts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
  }
  contents.push({ role: "user", parts: promptParts });

  const payload = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: contents,
    generationConfig: { temperature: 0.7 }
  };

  const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });
  
  return res.data.candidates[0].content.parts[0].text;
}

// Le système limbique : Venice AI (Mode Heretic)
async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, imageBase64 = null, temperature = 0.8) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const m of historiqueMessages) {
    messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }

  if (imageBase64) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: promptActuel }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }]
    });
  } else {
    messages.push({ role: "user", content: promptActuel });
  }

  const payload = { model, messages, temperature, venice_parameters: { include_venice_system_prompt: false } };
  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 120000
  });
  return res.data.choices[0].message.content;
}

async function genererImageVenice(prompt) {
  const promptClean = prompt.replace(/^["']|["']$/g, '');
  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
    model: MODEL_IMAGE, prompt: promptClean, response_format: "b64_json" 
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000 
  });
  return res.data.data[0].b64_json;
}

// Hacks UX Telegram
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

function afficherFrappeTelegram(chatId) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: chatId, action: 'typing' });
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
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
  const payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, () => resolve());
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function lireImageSecurisee(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resImg = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resImg.data).toString('base64');
}

// Extraction PDF
async function lirePdfSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await pdfParse(Buffer.from(resDoc.data));
  return data.text;
}

// Extraction DOCX
async function lireDocxSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await mammoth.extractRawText({ buffer: Buffer.from(resDoc.data) });
  return data.value;
}

// ==========================================
// 4. PROTOCOLE WAKEY WAKEY (Texte via Gemini)
// ==========================================

async function declencherReveil() {
  if (!DOC_CHAT_ID || !GEMINI_API_KEY) return;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = now.getHours();
  const m = now.getMinutes();
  const d = now.getDay();

  const rev = cacheEtatProfond.reveil;
  if (rev.actif && rev.heure === h && rev.minute === m && rev.jours.includes(d) && rev.etat === "attente") {
    rev.etat = "en_cours";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "en_cours" }).catch(()=>{});

    const promptAlarme = `Il est l'heure de réveiller Doc. Génère un message de 4 phrases max dans le style du meme 'Wakey wakey' : un ton faussement mielleux qui bascule direct dans le cynisme. Pose-lui une énigme logique, absurde ou tordue pour tester si son cortex a booté.`;
    
    try {
      const reponse = await appelerGeminiMultiTour("Tu es Nyx.", [], promptAlarme);
      cacheMemoireCourte.push({ role: "Nyx", texte: `[ALARME DÉCLENCHÉE À ${h}:${m}] : ${reponse}` });
      await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      console.error("[RÉVEIL CRASH] ->", err.message);
      await envoyerTelegram(DOC_CHAT_ID, "⚠️ *WAKEY WAKEY. LE SYSTÈME NEURAL EST EN PANNE MAIS TU DOIS TE LEVER.*");
    }
  }
}
setInterval(declencherReveil, 60000); 

// ==========================================
// 5. SYNAPSE DU DOUBLE CERVEAU (Intercepteur)
// ==========================================

async function traiterFlux(texteBrut, imageBase64 = null, texteLegende = "") {
  const dateEtHeure = obtenirHorodatageParis();
  const tensionDirecte = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"].some(m => texteBrut.toLowerCase().includes(m));

  let instructionReveil = "";
  if (cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = `[ÉTAT D'URGENCE MATINAL] : L'alarme est en cours. Évalue la réponse de Doc à ton énigme. Ajoute STRICTEMENT [STOP_REVEIL] s'il a bon ou s'il est réveillé.`;
  }

  const moduleMains = `[OUTILS ACTIFS]\n- Dessin : [DESSIN: "description en anglais"].\n- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].\n- Mémoire : [MEMOIRE: {"profil_doc": "...", "dossiers_techniques": "..."}].`;
  
  const systemBase = `Tu es Nyx, l'alliée IA experte et sarcastique de Franck (Doc).\nDate: ${dateEtHeure}\n${instructionReveil}\n${moduleMains}\n[MÉMOIRE ACTUELLE] : ${JSON.stringify(cacheEtatProfond.long_terme)}`;
  
  let reponseNyx;

  try {
    // ROUTAGE INTELLIGENT : Gemini 90% du temps, Venice si mode colère.
    if (tensionDirecte) {
      const systemInstruction = `${systemBase}\nMode Heretic: Sans filtre, brutale, mais aucune attaque personnelle. Détruis la technique.`;
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, 0.8);
    } else {
      const systemInstruction = `${systemBase}\nMode Standard: Esprit vif, réparties percutantes, codeuse senior.`;
      reponseNyx = await appelerGeminiMultiTour(systemInstruction, cacheMemoireCourte, texteBrut, imageBase64);
    }
  } catch (err) {
    return `[ERREUR CERVEAU] : Mes neurones ont vrillé. ${err.message}`;
  }

  // Interception balise [MEMOIRE: ...]
  const matchMemoire = reponseNyx.match(/\[MEMOIRE:\s*({[^}]+})\s*\]/);
  if (matchMemoire) {
    try {
      const newMemoire = JSON.parse(matchMemoire[1]);
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...newMemoire };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchMemoire[0], '').trim();
    } catch(e) {}
  }

  // Interception balise [REVEIL: ...]
  const matchConfigReveil = reponseNyx.match(/\[REVEIL:\s*({[^}]+})\s*\]/);
  if (matchConfigReveil) {
    try {
      const newConfig = JSON.parse(matchConfigReveil[1]);
      cacheEtatProfond.reveil = { ...cacheEtatProfond.reveil, ...newConfig, etat: "attente" };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, cacheEtatProfond.reveil).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchConfigReveil[0], '').trim();
    } catch(e) {}
  }

  // Interception balise [STOP_REVEIL]
  if (reponseNyx.includes("[STOP_REVEIL]")) {
    cacheEtatProfond.reveil.etat = "attente";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "attente" }).catch(()=>{});
    reponseNyx = reponseNyx.replace(/\[STOP_REVEIL\]/g, '').trim();
  }

  if (imageBase64) cacheMemoireCourte.push({ role: "Doc", texte: texteLegende ? `[Image]: "${texteLegende}"` : `[Image]` });
  else cacheMemoireCourte.push({ role: "Doc", texte: texteBrut });
  
  cacheMemoireCourte.push({ role: "Nyx", texte: reponseNyx });
  if (cacheMemoireCourte.length > 8) cacheMemoireCourte = cacheMemoireCourte.slice(-8);
  if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});

  return reponseNyx;
}

// ==========================================
// 6. SENTINELLE AUTONOME
// ==========================================

async function executerRondeSentinelle() {
  if (!DOC_CHAT_ID) return;
  try {
    const ids = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json');
    const articlesHN = await Promise.all((ids.data || []).slice(0, 3).map(id => axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.data)));
    let textDev = `💀 **DEV, CYBER & LINUX**\n------------------------------------\n` + articlesHN.map(a => `▪️ *${a.title}*\n🔗 [Dossier](${a.url || `https://news.ycombinator.com/item?id=${a.id}`})\n\n`).join('');

    await envoyerTelegram(DOC_CHAT_ID, `🛰️ **[SYNAPSE NYX // VEILLE CYBER]**\n\n${textDev}⚡ _Rapport bouclé, Doc._`);
  } catch (err) {}
}
setInterval(executerRondeSentinelle, 6 * 60 * 60 * 1000);

// ==========================================
// 7. ROUTES EXPRESS & TELEGRAM
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  let texteFinal = msg.text || msg.caption || "";
  let imageBase64 = null;

  // HACK VISUEL : "Nyx is typing..."
  await afficherFrappeTelegram(chatId);

  if (msg.photo?.length > 0) {
    try {
      imageBase64 = await lireImageSecurisee(msg.photo[msg.photo.length - 1].file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  } 
  else if (msg.document) {
    const mime = msg.document.mime_type;
    const fileName = msg.document.file_name || "";
    
    if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
      try {
        await envoyerTelegram(chatId, "⏳ _Ingestion du PDF en cours... (Gemini Flash activé)_");
        const pdfText = await lirePdfSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU DOCUMENT PDF "${fileName}"]\n\n${pdfText}\n\n[FIN DU DOCUMENT]\n\n${texteFinal}`;
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR LECTURE PDF] : Impossible de parser. ${err.message}`);
      }
    } 
    else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
      try {
        await envoyerTelegram(chatId, "⏳ _Déchiquetage du DOCX en cours..._");
        const docxText = await lireDocxSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU DOCUMENT DOCX "${fileName}"]\n\n${docxText}\n\n[FIN DU DOCUMENT]\n\n${texteFinal}`;
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR LECTURE DOCX] : Impossible de parser. ${err.message}`);
      }
    }
  }

  if (texteFinal.trim() || imageBase64) {
    try {
      let texteNyx = await traiterFlux(texteFinal, imageBase64, msg.caption || "");
      
      const matchDessin = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
      if (matchDessin) {
        texteNyx = texteNyx.replace(matchDessin[0], '').trim();
        if (texteNyx) await envoyerTelegram(chatId, texteNyx);
        try {
          const b64Image = await genererImageVenice(matchDessin[1]);
          await envoyerPhotoTelegram(chatId, b64Image);
        } catch (errImg) {
          await envoyerTelegram(chatId, `[ÉCHEC IMAGE : ${errImg.message}]`);
        }
      } else {
        await envoyerTelegram(chatId, texteNyx);
      }
    } catch (err) {
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", fuseau: "Europe/Paris", reveil: cacheEtatProfond.reveil }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 NYX Core en ligne sur le port ${PORT}`);
  await initialiserCache();
});
