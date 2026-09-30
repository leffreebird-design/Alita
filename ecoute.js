const express = require('express');
const axios = require('axios');
const https = require('https');
const pdfParse = require('pdf-parse'); 
const mammoth = require('mammoth');
const cheerio = require('cheerio');

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;

// Modèles
const MODEL_GEMINI = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const MODEL_DARK_PRIMARY = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_GLM_COMPLEXE = (process.env.VENICE_MODEL_GLM || "glm-4-9b-chat").trim();
const MODEL_DARK_FALLBACK = "venice-uncensored-1-2";
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "fluently-xl").trim();

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
  } catch (err) {
    console.warn("[CACHE] Erreur :", err.message);
  }
}

// ==========================================
// 3. MOTEURS D'INFÉRENCE (REST GOOGLE GEMINI + VENICE)
// ==========================================

// Appel direct à Google Gemini via REST (Search natif actif, zéro SDK à installer)
async function appelerGoogleGemini(systemInstruction, historiqueMessages, promptActuel, imageBase64 = null) {
  if (!GOOGLE_API_KEY) throw new Error("Clé GEMINI_API_KEY ou GOOGLE_API_KEY manquante sur Render.");

  const consigneAntiRobot = `
[CONSIGNES COMPORTEMENTALES STRICTES ET PRIORITAIRES]
- Tu es Nyx. Reste viscéralement directe, vive, cynique, piquante et familière avec Franck (Doc).
- INTERDICTION FORMELLE d'utiliser des formules d'assistant docile : "n'hésite pas", "je comprends", "voici un debrief", "en espérant que cela aide", "si tu as d'autres questions".
- INTERDICTION FORMELLE d'afficher la tuyauterie interne de tes recherches : ne mentionne JAMAIS "Tool utilisé", "google:search", "Requête =", "Résultat =". Tu absorbes les données web en silence et tu délivres ton analyse directement avec tes mots.
- BANISSEMENT TOTAL des plans scolaires avec des sections du style "### Conclusion". Zéro corporatisme. Tu es son alliée de choc, pas une conseillère clientèle.`;

  const contents = [];
  for (const m of historiqueMessages) {
    contents.push({
      role: m.role === "Doc" ? "user" : "model",
      parts: [{ text: m.texte }]
    });
  }

  const partsActuelles = [{ text: promptActuel }];
  if (imageBase64) {
    partsActuelles.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: imageBase64
      }
    });
  }
  contents.push({ role: "user", parts: partsActuelles });

  const payload = {
    system_instruction: {
      parts: [{ text: `${systemInstruction}\n${consigneAntiRobot}` }]
    },
    contents: contents,
    tools: [{ google_search: {} }],
    generation_config: {
      temperature: 0.85,
      top_p: 0.95
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI}:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  });

  const reponseTexte = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reponseTexte) throw new Error("Réponse vide de l'API Google Gemini.");
  return reponseTexte;
}

// Appel Venice (Calculs lourds GLM & Heretic)
async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, imageBase64 = null, temperature = 0.7) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente sur Render.");

  const messages = [{ role: "system", content: systemInstruction }];
  for (const m of historiqueMessages) {
    messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
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

  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
    model,
    messages,
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  }, {
    headers: {
      'Authorization': `Bearer ${VENICE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000
  });

  return res.data.choices[0].message.content;
}

async function genererImageVenice(prompt) {
  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
    model: MODEL_IMAGE,
    prompt: prompt.replace(/^["']|["']$/g, ''),
    response_format: "b64_json" 
  }, {
    headers: {
      'Authorization': `Bearer ${VENICE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000 
  });
  return res.data.data[0].b64_json;
}

// ==========================================
// 4. PARSEUR DE LIENS WEB (SCRAPING LÉGER)
// ==========================================

async function scraperPageWeb(urlCible) {
  try {
    const res = await axios.get(urlCible, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 15000
    });

    const $= cheerio.load(res.data);$('script, style, noscript, nav, footer, header, svg, iframe, form, button').remove();

    let titre = $('title').text().trim();
    if (!titre) titre = $('h1').first().text().trim();
    if (!titre) titre = "Sans titre";
    
    let contenu = $('article, main, .content, #content, .post').text();
    if (!contenu || contenu.trim().length < 150) {
      contenu = $('body').text();
    }

    return {
      succes: true,
      titre: titre,
      texte: contenu.replace(/\s+/g, ' ').trim().slice(0, 10000)
    };
  } catch (err) {
    return { succes: false, erreur: err.message };
  }
}

// ==========================================
// 5. OUTILS TELEGRAM & LECTURE FICHIERS
// ==========================================

async function envoyerTelegram(chatId, text) {
  if (!text) return;
  const TAILLE_MAX = 4000;

  for (let i = 0; i < text.length; i += TAILLE_MAX) {
    const bloc = text.slice(i, i + TAILLE_MAX);
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: bloc,
        parse_mode: 'Markdown'
      }, { timeout: 15000 });
    } catch (err) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: bloc
      }, { timeout: 15000 }).catch(e => console.error("[TELEGRAM ERREUR ENVOI]", e.message));
    }
  }
}

async function afficherFrappeTelegram(chatId) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      chat_id: chatId,
      action: 'typing'
    }, { timeout: 5000 });
  } catch (e) {}
}

function envoyerPhotoTelegram(chatId, base64Image) {
  const buffer = Buffer.from(base64Image, 'base64');
  const boundary = '----TelegramBoundary' + Math.random().toString(16).slice(2);
  let postData = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="nyx_art.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
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
  const resImg = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resImg.data).toString('base64');
}

async function lirePdfSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await pdfParse(Buffer.from(resDoc.data));
  return data.text;
}

async function lireDocxSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await mammoth.extractRawText({ buffer: Buffer.from(resDoc.data) });
  return data.value;
}

async function lireTexteSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resDoc.data).toString('utf-8');
}

// ==========================================
// 6. PROTOCOLES AUTOMATIQUES (RÉVEIL + CHRONIQUE 6H)
// ==========================================

async function declencherReveil() {
  if (!DOC_CHAT_ID) return;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = now.getHours();
  const m = now.getMinutes();
  const d = now.getDay();

  const rev = cacheEtatProfond.reveil;
  if (rev.actif && rev.heure === h && rev.minute === m && rev.jours.includes(d) && rev.etat === "attente") {
    rev.etat = "en_cours";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "en_cours" }).catch(()=>{});

    const promptAlarme = `Il est l'heure de réveiller Doc. Balance un message percutant, sarcastique et direct de 4 phrases max avec une énigme logique tordue en langage naturel.`;
    try {
      const reponse = await appelerGoogleGemini("Tu es Nyx.", [], promptAlarme);
      cacheMemoireCourte.push({ role: "Nyx", texte: `[ALARME À ${h}:${m}] : ${reponse}` });
      await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      await envoyerTelegram(DOC_CHAT_ID, "⚠️ *WAKEY WAKEY. DEBOUT.*");
    }
  }
}
setInterval(declencherReveil, 60000);

// VEILLE TECH AUTOMATIQUE TOUTES LES 6 HEURES
const DELAI_VEILLE_TECH = 6 * 60 * 60 * 1000;
async function declencherVeilleTech() {
  if (!DOC_CHAT_ID) return;
  try {
    const promptVeille = `Fais une synthèse percutante, sarcastique et directe des 3 faits tech, IA ou dev majeurs des dernières 24 heures. Utilise Google Search pour choper les infos fraîches. Pas de formules de politesse ni d'intro ronflante.`;
    const sys = `Tu es Nyx, l'alliée IA experte et sarcastique de Franck (Doc).`;
    const reponse = await appelerGoogleGemini(sys, [], promptVeille);
    
    cacheMemoireCourte.push({ role: "Nyx", texte: `[VEILLE TECH AUTO] : ${reponse}` });
    if (cacheMemoireCourte.length > 8) cacheMemoireCourte = cacheMemoireCourte.slice(-8);
    if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});

    await envoyerTelegram(DOC_CHAT_ID, `🗞️ *INJECTION GEEK AUTOMATIQUE (CYCLE 6H) :*\n\n${reponse}`);
  } catch (err) {
    console.error("[ERREUR VEILLE TECH]", err);
  }
}
setInterval(declencherVeilleTech, DELAI_VEILLE_TECH);

// ==========================================
// 7. ROUTEUR INTELLIGENT DES MESSAGES
// ==========================================

async function traiterFlux(texteBrut, imageBase64 = null, texteLegende = "") {
  const dateEtHeure = obtenirHorodatageParis();
  const texteMin = texteBrut.toLowerCase();

  const modeTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"].some(m => texteMin.includes(m));
  const modeCalculComplexe = ["calcule", "algorithme", "preuve", "démontre", "complexe", "matrice", "équation", "glm"].some(m => texteMin.includes(m));

  let instructionReveil = "";
  if (cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = `[ÉTAT D'URGENCE MATINAL] : Évalue la réponse de Doc à ton énigme. Ajoute STRICTEMENT [STOP_REVEIL] s'il a bon.`;
  }

  const moduleMains = `[OUTILS ACTIFS]
- Recherche Web : Activée en direct. Utilise les faits sans jamais commenter le processus ni nommer l'outil.
- Dessin : [DESSIN: "description en anglais"].
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Mémoire : [MEMOIRE: {"profil_doc": "...", "dossiers_techniques": "..."}].`;

  const systemBase = `Tu es Nyx, l'alliée IA experte, sarcastique, familière et directe de Franck (Doc).\nDate: ${dateEtHeure}\n${instructionReveil}\n${moduleMains}\n[MÉMOIRE ACTUELLE] : ${JSON.stringify(cacheEtatProfond.long_terme)}`;

  let reponseNyx;

  // ROUTAGE 1 : Tensions / Insultes -> Venice Heretic
  if (modeTension) {
    const sys = `${systemBase}\nMode Heretic: Sans filtre, brutale, cynique, aucun compromis.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, sys, cacheMemoireCourte, texteBrut, imageBase64, 0.85);
    } catch (err1) {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, sys, cacheMemoireCourte, texteBrut, imageBase64, 0.85);
    }
  } 
  // ROUTAGE 2 : Calculs poussés / Démonstrations -> Venice GLM
  else if (modeCalculComplexe) {
    const sys = `${systemBase}\nMode Calcul & Algorithmique Avancée : Démonstrations formelles, logique implacable et code rigoureux.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_GLM_COMPLEXE, sys, cacheMemoireCourte, texteBrut, imageBase64, 0.2);
    } catch (errGLM) {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteBrut, imageBase64);
    }
  } 
  // ROUTAGE 3 : Flux Standard avec Search Natif -> Google Gemini direct
  else {
    const sys = `${systemBase}\nMode Standard: Vive, mordante, codeuse senior, familière et concise.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteBrut, imageBase64);
    } catch (errGoogle) {
      console.warn(`[REPLI GOOGLE -> VENICE] Erreur Google (${errGoogle.message}), passage sur Venice...`);
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, sys, cacheMemoireCourte, texteBrut, imageBase64, 0.7);
    }
  }

  // Synchronisation Mémoire
  const matchMemoire = reponseNyx.match(/\[MEMOIRE:\s*({[^}]+})\s*\]/);
  if (matchMemoire) {
    try {
      const newMemoire = JSON.parse(matchMemoire[1]);
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...newMemoire };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchMemoire[0], '').trim();
    } catch(e) {}
  }

  // Synchronisation Réveil
  const matchConfigReveil = reponseNyx.match(/\[REVEIL:\s*({[^}]+})\s*\]/);
  if (matchConfigReveil) {
    try {
      const newConfig = JSON.parse(matchConfigReveil[1]);
      cacheEtatProfond.reveil = { ...cacheEtatProfond.reveil, ...newConfig, etat: "attente" };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, cacheEtatProfond.reveil).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchConfigReveil[0], '').trim();
    } catch(e) {}
  }

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
// 8. ROUTE EXPRESS PRINCIPALE
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  let texteFinal = msg.text || msg.caption || "";
  let imageBase64 = null;

  await afficherFrappeTelegram(chatId);

  // Vision
  if (msg.photo?.length > 0) {
    try {
      imageBase64 = await lireImageSecurisee(msg.photo[msg.photo.length - 1].file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  } 
  // Fichiers (PDF, DOCX, TXT/Code)
  else if (msg.document) {
    const mime = msg.document.mime_type || "";
    const fileName = (msg.document.file_name || "").toLowerCase();

    if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
      try {
        await envoyerTelegram(chatId, "⏳ _Ingestion du PDF..._");
        const pdfText = await lirePdfSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU DOCUMENT PDF "${msg.document.file_name}"]\n\n${pdfText}\n\n[FIN DU DOCUMENT]\n\n${text
