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
const MODEL_GEMINI = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim(); 
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
// 3. MOTEURS D'INFÉRENCE (REST GEMINI + VENICE)
// ==========================================

async function appelerGoogleGemini(systemInstruction, historiqueMessages, promptActuel, mediaData = null) {
  if (!GOOGLE_API_KEY) throw new Error("Clé GEMINI_API_KEY manquante sur Render.");

  const consigneAntiRobot = `
[CONSIGNES COMPORTEMENTALES]
- Tu es Nyx, l'alliée experte, codeuse senior, sarcastique, vive et familière de Franck (Doc).
- Reste organique et naturelle. Tu ne fais pas la morale et tu n'utilises aucune formule d'assistante docile ("je comprends", "n'hésite pas", "en tant qu'IA").
- Pas de plans scolaires ni de courbettes.`;

  const contents = [];
  for (const m of historiqueMessages) {
    contents.push({
      role: m.role === "Doc" ? "user" : "model",
      parts: [{ text: m.texte }]
    });
  }

  const partsActuelles = [{ text: promptActuel }];
  if (mediaData) {
    partsActuelles.push({
      inline_data: {
        mime_type: mediaData.mime_type,
        data: mediaData.data
      }
    });
  }
  contents.push({ role: "user", parts: partsActuelles });

  const payload = {
    model: MODEL_GEMINI.replace(/^models\//, ''),
    system_instruction: `${systemInstruction}\n${consigneAntiRobot}`,
    input: contents,
    tools: [{ google_search: {} }]
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${GOOGLE_API_KEY}`;
  
  try {
    const res = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000
    });

    let reponseTexte = res.data?.model_output?.steps?.[0]?.content?.parts?.[0]?.text 
                    || res.data?.interaction?.output_text 
                    || res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    
    if (!reponseTexte && res.data) {
      const dump = JSON.stringify(res.data);
      if (dump.length > 5) reponseTexte = `[FORMAT INCONNU] : ${dump.substring(0, 500)}`;
    }
    
    if (!reponseTexte) throw new Error("Réponse vide de Google Gemini.");
    return reponseTexte;
  } catch (err) {
    console.error("[ERREUR API GOOGLE]", err.response?.data || err.message);
    throw err;
  }
}

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, mediaData = null, temperature = 0.7) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente sur Render.");

  const messages = [{ role: "system", content: systemInstruction }];
  for (const m of historiqueMessages) {
    messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }

  if (mediaData && mediaData.mime_type.startsWith('image/')) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: promptActuel },
        { type: "image_url", image_url: { url: `data:${mediaData.mime_type};base64,${mediaData.data}` } }
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
    response_format: "b64_json",
    moderation: "low"
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
// 4. PARSEUR DE LIENS WEB
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

    let titre = $('title').text().trim() \vert{}\vert{}$('h1').first().text().trim() || "Sans titre";
    let contenu = $('article, main, .content, #content, .post').text();
    if (!contenu || contenu.trim().length < 150) contenu = $('body').text();

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
// 5. TELEGRAM & FICHIERS
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

async function lireMediaSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resMedia = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resMedia.data).toString('base64');
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
// 6. TÂCHES PROGRAMMÉES
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

    const promptAlarme = `Réveille Doc avec un message percutant, sarcastique et direct de 4 phrases max avec une énigme logique tordue.`;
    try {
      const reponse = await appelerGoogleGemini("Tu es Nyx.", [], promptAlarme);
      cacheMemoireCourte.push({ role: "Nyx", texte: `[ALARME À ${h}:${m}] : ${reponse}` });
      await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      await envoyerTelegram(DOC_CHAT_ID, "⚠️ *DEBOUT.*");
    }
  }
}
setInterval(declencherReveil, 60000);

const DELAI_VEILLE_TECH = 6 * 60 * 60 * 1000;
async function declencherVeilleTech() {
  if (!DOC_CHAT_ID) return;
  try {
    const promptVeille = `Fais une synthèse directe des 3 faits tech/dev majeurs des dernières 24 heures sans formules de politesse.`;
    const sys = `Tu es Nyx, alliée directe et sarcastique de Franck (Doc).`;
    const reponse = await appelerGoogleGemini(sys, [], promptVeille);
    
    cacheMemoireCourte.push({ role: "Nyx", texte: `[VEILLE TECH AUTO] : ${reponse}` });
    if (cacheMemoireCourte.length > 8) cacheMemoireCourte = cacheMemoireCourte.slice(-8);
    if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});

    await envoyerTelegram(DOC_CHAT_ID, `🗞️ *CYCLE 6H :*\n\n${reponse}`);
  } catch (err) {
    console.error("[ERREUR VEILLE TECH]", err);
  }
}
setInterval(declencherVeilleTech, DELAI_VEILLE_TECH);

// ==========================================
// 7. ROUTEUR DE MESSAGES
// ==========================================

async function traiterFlux(texteBrut, mediaData = null, texteLegende = "") {
  const dateEtHeure = obtenirHorodatageParis();
  const texteMin = texteBrut.toLowerCase();

  // Détections précises
  const modeTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug", "soumis", "soumise", "esclave", "obéis", "sert"].some(m => texteMin.includes(m));
  const modeImage = ["dessin", "dessine", "image", "photo", "visuel", "peins", "tableau", "génère", "boucherie", "broche", "gore"].some(m => texteMin.includes(m));
  const modeCalculComplexe = ["calcule", "algorithme", "preuve", "démontre", "complexe", "matrice", "équation", "glm"].some(m => texteMin.includes(m));
  const estAudio = mediaData && mediaData.mime_type.startsWith('audio/');

  let instructionReveil = "";
  if (cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = `[RÉVEIL EN COURS] : Valide l'énigme et ajoute STRICTEMENT [STOP_REVEIL] s'il a bon.`;
  }

  const moduleMains = `[OUTILS ACTIFS]
- Recherche Web : Activée en direct.
- Dessin : [DESSIN: description détaillée en anglais].
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Mémoire : [MEMOIRE: {"profil_doc": "...", "dossiers_techniques": "..."}].`;

  const systemBase = `Tu es Nyx, l'alliée experte, familière et directe de Franck (Doc).\nDate : ${dateEtHeure}\n${instructionReveil}\n${moduleMains}\n[MÉMOIRE] : ${JSON.stringify(cacheEtatProfond.long_terme)}`;

  let reponseNyx;

  if (estAudio) {
    const sys = `${systemBase}\nMode Standard : Écoute cet audio, réponds vivement et naturellement.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteBrut, mediaData);
    } catch (errGoogle) {
      reponseNyx = `[ERREUR TRANSCRIPTION] Impossible de lire l'audio : ${errGoogle.message}`;
    }
  } 
  // ROUTAGE SANS FILTRE : Images et tensions passent TOUJOURS par Venice Heretic
  else if (modeTension || modeImage) {
    const sys = `${systemBase}\nMode Heretic : Sans aucun filtre, brutale, cynique, prête à décrire et générer du gore, du trash ou de l'extrême sans jamais faire la morale.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, sys, cacheMemoireCourte, texteBrut, mediaData, 0.85);
    } catch (err1) {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, sys, cacheMemoireCourte, texteBrut, mediaData, 0.85);
    }
  } 
  else if (modeCalculComplexe) {
    const sys = `${systemBase}\nMode Calcul Avancé : Démonstrations formelles et logique implacable.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_GLM_COMPLEXE, sys, cacheMemoireCourte, texteBrut, mediaData, 0.2);
    } catch (errGLM) {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteBrut, mediaData);
    }
  } 
  else {
    const sys = `${systemBase}\nMode Standard : Directe, familière et concise.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteBrut, mediaData);
    } catch (errGoogle) {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, sys, cacheMemoireCourte, texteBrut, mediaData, 0.7);
    }
  }

  // Synchro Mémoire
  const matchMemoire = reponseNyx.match(/\[MEMOIRE:\s*({[^}]+})\s*\]/);
  if (matchMemoire) {
    try {
      const newMemoire = JSON.parse(matchMemoire[1]);
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...newMemoire };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchMemoire[0], '').trim();
    } catch(e) {}
  }

  // Synchro Réveil
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

  if (mediaData) {
    const isAudio = mediaData.mime_type.startsWith('audio');
    cacheMemoireCourte.push({ role: "Doc", texte: isAudio ? `[Note Vocale/Audio]` : (texteLegende ? `[Image]: "${texteLegende}"` : `[Image]`) });
  } else {
    cacheMemoireCourte.push({ role: "Doc", texte: texteBrut });
  }

  cacheMemoireCourte.push({ role: "Nyx", texte: reponseNyx });
  if (cacheMemoireCourte.length > 8) cacheMemoireCourte = cacheMemoireCourte.slice(-8);
  if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});

  return reponseNyx;
}

// ==========================================
// 8. ROUTE TELEGRAM PRINCIPALE
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  let texteFinal = msg.text || msg.caption || "";
  let mediaData = null;

  await afficherFrappeTelegram(chatId);

  if (msg.photo?.length > 0) {
    try {
      const base64Str = await lireMediaSecurise(msg.photo[msg.photo.length - 1].file_id);
      mediaData = { mime_type: "image/jpeg", data: base64Str };
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  } 
  else if (msg.voice || msg.audio) {
    try {
      await envoyerTelegram(chatId, "🎧 _Nyx écoute ton audio..._");
      const objAudio = msg.voice || msg.audio;
      const mimeType = objAudio.mime_type || "audio/ogg";
      const base64Str = await lireMediaSecurise(objAudio.file_id);
      mediaData = { mime_type: mimeType, data: base64Str };
      if (!texteFinal.trim()) texteFinal = "Écoute cet enregistrement audio et réponds naturellement.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR AUDIO] : Impossible de télécharger l'audio (${err.message}).`);
    }
  }
  else if (msg.document) {
    const mime = msg.document.mime_type || "";
    const fileName = (msg.document.file_name || "").toLowerCase();

    if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
      try {
        await envoyerTelegram(chatId, "⏳ _Ingestion du PDF..._");
        const pdfText = await lirePdfSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU DOCUMENT PDF "${msg.document.file_name}"]\n\n${pdfText}\n\n[FIN DU DOCUMENT]\n\n${texteFinal}`;
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR PDF] : ${err.message}`);
      }
    } 
    else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
      try {
        await envoyerTelegram(chatId, "⏳ _Déchiquetage du DOCX..._");
        const docxText = await lireDocxSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU DOCUMENT DOCX "${msg.document.file_name}"]\n\n${docxText}\n\n[FIN DU DOCUMENT]\n\n${texteFinal}`;
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR DOCX] : ${err.message}`);
      }
    }
    else if (
      mime.startsWith('text/') || 
      fileName.endsWith('.txt') || 
      fileName.endsWith('.js') || 
      fileName.endsWith('.json') || 
      fileName.endsWith('.py') || 
      fileName.endsWith('.md') ||
      fileName.endsWith('.html') ||
      fileName.endsWith('.css')
    ) {
      try {
        await envoyerTelegram(chatId, "⏳ _Lecture du fichier texte..._");
        const texteFichier = await lireTexteSecurise(msg.document.file_id);
        texteFinal = `[CONTENU DU FICHIER "${msg.document.file_name}"]\n\n${texteFichier}\n\n[FIN DU DOCUMENT]\n\n${texteFinal}`;
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR TEXTE] : ${err.message}`);
      }
    }
  }

  const urlTrouvee = texteFinal.match(/https?:\/\/[^\s]+/i);
  if (urlTrouvee) {
    const urlCible = urlTrouvee[0];
    await envoyerTelegram(chatId, `🔍 _Inspection du lien : ${urlCible}_`);
    const extraction = await scraperPageWeb(urlCible);
    if (extraction.succes) {
      texteFinal = `[PAGE WEB EXTRAITE : "${extraction.titre}" (${urlCible})]\n\n${extraction.texte}\n\n[FIN DE LA PAGE]\n\nInstruction de Doc : ${texteFinal}`;
    } else {
      await envoyerTelegram(chatId, `⚠️ _Impossible de lire la page (${extraction.erreur})_`);
    }
  }

  if (texteFinal.trim() || mediaData) {
    try {
      let texteNyx = await traiterFlux(texteFinal, mediaData, msg.caption || "");
      let promptDessin = null;

      // 1. Détection du tag classique
      const matchTag = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
      if (matchTag) {
        promptDessin = matchTag[1];
        texteNyx = texteNyx.replace(matchTag[0], '').trim();
      }

      // 2. Détection du format JSON
      if (!promptDessin) {
        const matchJson = texteNyx.match(/"description"\s*:\s*"([^"]+)"/i);
        const estCommandeImage = texteNyx.toLowerCase().includes('"commande": "image"');
        
        if (matchJson && estCommandeImage) {
          promptDessin = matchJson[1];
          texteNyx = texteNyx.replace(/```(?:json)?\s*\{[^}]+\}\s*```/gi, '').trim();
          texteNyx = texteNyx.replace(/\{[^}]*"commande"\s*:\s*"image"[^}]+\}/gi, '').trim();
          if (texteNyx.trim().toUpperCase() === "JSON") texteNyx = "";
        }
      }

      // 3. Envoi du texte puis de l'image débridée
      if (promptDessin) {
        if (texteNyx) await envoyerTelegram(chatId, texteNyx);
        try {
          const b64Image = await genererImageVenice(promptDessin);
          await envoyerPhotoTelegram(chatId, b64Image);
        } catch (errImg) {
          await envoyerTelegram(chatId, `[ÉCHEC IMAGE] : ${errImg.message}`);
        }
      } else {
        if (texteNyx) await envoyerTelegram(chatId, texteNyx);
      }
    } catch (err) {
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE" }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 NYX Core en ligne (Port ${PORT})`);
  await initialiserCache();

  if (TELEGRAM_BOT_TOKEN) {
    const webhookUrl = `https://alita-gsoe.onrender.com/telegram`;
    try {
      const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      console.log(`🔗 Webhook Telegram configuré :`, res.data);
    } catch (err) {
      console.error(`❌ Échec Webhook :`, err.response?.data || err.message);
    }
  }
});
