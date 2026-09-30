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
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;

// Modèles déclarés chez Venice
const MODEL_FAST = (process.env.VENICE_MODEL_NORMAL || "gemini-3-8-flash").trim();
const MODEL_DARK_PRIMARY = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
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
// 3. NOYAU VENICE UNIFIÉ
// ==========================================

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, imageBase64 = null, temperature = 0.7) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY manquante dans Render.");

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

  const payload = {
    model,
    messages,
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  };

  try {
    const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${VENICE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return res.data.choices[0].message.content;
  } catch (err) {
    const detailErreur = err.response?.data?.error?.message || err.code || err.message;
    console.error(`[VENICE ERREUR - ${model}] :`, detailErreur);
    throw new Error(detailErreur);
  }
}

async function genererImageVenice(prompt) {
  const promptClean = prompt.replace(/^["']|["']$/g, '');
  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
    model: MODEL_IMAGE,
    prompt: promptClean,
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
// 4. RADAR WEB (TAVILY) & SCRAPING LIENS
// ==========================================

async function rechercherTavily(requete) {
  if (!TAVILY_API_KEY) {
    throw new Error("Clé TAVILY_API_KEY absente des variables Render.");
  }

  const res = await axios.post('https://api.tavily.com/search', {
    api_key: TAVILY_API_KEY,
    query: requete,
    search_depth: "basic",
    include_answer: false,
    max_results: 3
  }, { timeout: 15000 });

  if (!res.data || !res.data.results || res.data.results.length === 0) {
    return "Aucun résultat trouvé sur le web.";
  }

  return res.data.results.map((r, i) => `[Source ${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`).join('\n\n');
}

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
    if (!titre) {
      titre = $('h1').first().text().trim();
    }
    if (!titre) {
      titre = "Sans titre";
    }
    
    let contenu = $('article, main, .content, #content, .post').text();
    if (!contenu || contenu.trim().length < 150) {
      contenu = $('body').text();
    }

    const texteNettoye = contenu.replace(/\s+/g, ' ').trim();
    return {
      succes: true,
      titre: titre,
      texte: texteNettoye.slice(0, 10000)
    };
  } catch (err) {
    return {
      succes: false,
      erreur: err.message
    };
  }
}

// ==========================================
// 5. OUTILS TELEGRAM AVEC CHUNKING
// ==========================================

async function envoyerTelegram(chatId, text) {
  if (!text) return;

  const TAILLE_MAX = 4000;
  const blocs = [];

  for (let i = 0; i < text.length; i += TAILLE_MAX) {
    blocs.push(text.slice(i, i + TAILLE_MAX));
  }

  for (const bloc of blocs) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: bloc,
        parse_mode: 'Markdown'
      }, { timeout: 15000 });
    } catch (err) {
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: bloc
        }, { timeout: 15000 });
      } catch (e) {
        console.error("[TELEGRAM ERREUR ENVOI]", e.response?.data || e.message);
      }
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
// 6. PROTOCOLE WAKEY WAKEY
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

    const promptAlarme = `Il est l'heure de réveiller Doc. Génère un message de 4 phrases max dans le style 'Wakey wakey' : ton faussement mielleux qui bascule direct dans le cynisme. Pose-lui une énigme logique, absurde ou tordue en langage naturel.`;
    
    try {
      const reponse = await appelerVeniceMultiTour(MODEL_FAST, "Tu es Nyx.", [], promptAlarme);
      cacheMemoireCourte.push({ role: "Nyx", texte: `[ALARME DÉCLENCHÉE À ${h}:${m}] : ${reponse}` });
      await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      await envoyerTelegram(DOC_CHAT_ID, "⚠️ *WAKEY WAKEY. DEBOUT.*");
    }
  }
}
setInterval(declencherReveil, 60000);

// ==========================================
// 7. ROUTAGE DES MESSAGES & BOUCLE D'OUTILS
// ==========================================

async function traiterFlux(texteBrut, imageBase64 = null, texteLegende = "", chatId = null) {
  const dateEtHeure = obtenirHorodatageParis();
  const tensionDirecte = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"].some(m => texteBrut.toLowerCase().includes(m));

  let instructionReveil = "";
  if (cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = `[ÉTAT D'URGENCE MATINAL] : L'alarme est en cours. Évalue la réponse de Doc à ton énigme. Ajoute STRICTEMENT [STOP_REVEIL] s'il a bon.`;
  }

  const moduleMains = `[OUTILS ACTIFS]
- Recherche Web : Pour chercher une information récente, un fait inconnu ou si Doc te demande de chercher, réponds UNIQUEMENT par [RECHERCHE: "mots clés précis"]. Les résultats te seront injectés immédiatement.
- Dessin : [DESSIN: "description en anglais"].
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Mémoire : [MEMOIRE: {"profil_doc": "...", "dossiers_techniques": "..."}].`;

  const systemBase = `Tu es Nyx, l'alliée IA experte et sarcastique de Franck (Doc).\nDate: ${dateEtHeure}\n${instructionReveil}\n${moduleMains}\n[MÉMOIRE ACTUELLE] : ${JSON.stringify(cacheEtatProfond.long_terme)}`;

  let reponseNyx;

  if (tensionDirecte) {
    const systemInstruction = `${systemBase}\nMode Heretic: Sans filtre, brutale, cynique, aucun compromis.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, 0.85);
    } catch (err1) {
      try {
        reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, 0.85);
      } catch (err2) {
        return `[ERREUR VENICE] Heretic: ${err1.message} | Fallback: ${err2.message}`;
      }
    }
  } else {
    const systemInstruction = `${systemBase}\nMode Standard: Esprit vif, réparties percutantes, codeuse senior ultra-rapide.`;
    try {
      reponseNyx = await appelerVeniceMultiTour(MODEL_FAST, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, 0.7);
    } catch (errFast) {
      console.warn(`[REPLI MOTEUR] ${MODEL_FAST} en échec (${errFast.message}), bascule sur secours...`);
      try {
        reponseNyx = await appelerVeniceMultiTour(MODEL_DARK_FALLBACK, systemInstruction, cacheMemoireCourte, texteBrut, imageBase64, 0.7);
      } catch (errFallback) {
        return `[ERREUR MOTEUR] ${MODEL_FAST}: ${errFast.message} | ${MODEL_DARK_FALLBACK}: ${errFallback.message}`;
      }
    }
  }

  // Interception de l'outil Recherche Web
  const matchRecherche = reponseNyx.match(/\[RECHERCHE:\s*["']?(.*?)["']?\s*\]/i);
  if (matchRecherche) {
    const requeteWeb = matchRecherche[1];
    if (chatId) await envoyerTelegram(chatId, `🌐 _Recherche en direct : « ${requeteWeb} »..._`);
    
    try {
      const resultatsWeb = await rechercherTavily(requeteWeb);
      const instructionSynthese = `${systemBase}\nMode Standard: Synthétise les résultats web suivants avec ton ton percutant pour Doc. Ne remets pas de balise [RECHERCHE].`;
      const promptWeb = `[RÉSULTATS DE LA RECHERCHE WEB POUR "${requeteWeb}"]\n\n${resultatsWeb}\n\n[FIN DES RÉSULTATS]\n\nQuestion d'origine de Doc : ${texteBrut}`;

      reponseNyx = await appelerVeniceMultiTour(MODEL_FAST, instructionSynthese, cacheMemoireCourte, promptWeb, null, 0.7);
    } catch (errTavily) {
      reponseNyx = `Échec de la recherche web (${errTavily.message}).`;
    }
  }

  // Gestion Mémoire
  const matchMemoire = reponseNyx.match(/\[MEMOIRE:\s*({[^}]+})\s*\]/);
  if (matchMemoire) {
    try {
      const newMemoire = JSON.parse(matchMemoire[1]);
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...newMemoire };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchMemoire[0], '').trim();
    } catch(e) {}
  }

  // Gestion Réveil
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
// 8. ROUTE PRINCIPALE EXPRESS
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  let texteFinal = msg.text || msg.caption || "";
  let imageBase64 = null;

  await afficherFrappeTelegram(chatId);

  // Ingestion Image
  if (msg.photo?.length > 0) {
    try {
      imageBase64 = await lireImageSecurisee(msg.photo[msg.photo.length - 1].file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  } 
  // Ingestion Fichiers
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

  // Scraping direct si un lien est présent
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

  if (texteFinal.trim() || imageBase64) {
    try {
      let texteNyx = await traiterFlux(texteFinal, imageBase64, msg.caption || "", chatId);

      const matchDessin = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
      if (matchDessin) {
        texteNyx = texteNyx.replace(matchDessin[0], '').trim();
        if (texteNyx) await envoyerTelegram(chatId, texteNyx);
        try {
          const b64Image = await genererImageVenice(matchDessin[1]);
          await envoyerPhotoTelegram(chatId, b64Image);
        } catch (errImg) {
          await envoyerTelegram(chatId, `[ÉCHEC IMAGE]`);
        }
      } else {
        await envoyerTelegram(chatId, texteNyx);
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
