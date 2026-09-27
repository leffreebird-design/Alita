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

const app = express();
app.use(express.json({ limit: '15mb' }));

// ==========================================
// 2. NOYAU COGNITIF MULTI-TOURS (Venice API)
// ==========================================

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, imageBase64 = null, temperature = 0.7) {
  const messages = [
    { role: "system", content: systemInstruction }
  ];

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
    messages.push({
      role: "user",
      content: promptActuel
    });
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

// ---- IMPRIMANTE NEURALE (Génération d'images) ----
async function genererImageVenice(prompt) {
  const promptClean = prompt.replace(/^["']|["']$/g, '');
  const payload = {
    model: MODEL_IMAGE,
    prompt: promptClean,
    response_format: "b64_json" 
  };
  
  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', payload, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000 
  });
  
  return res.data.data[0].b64_json;
}

// ---- GESTION MÉMOIRE (Court terme & Long terme Firebase) ----
async function lireMemoire() {
  if (!FIREBASE_DB_URL) return [];
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 5000 });
    if (!res.data) return [];
    if (Array.isArray(res.data)) return res.data;
    if (typeof res.data === 'object') return Object.values(res.data);
    return [];
  } catch (err) {
    console.error("[CORTEX] Échec lecture mémoire courte :", err.message);
    return []; 
  }
}

async function lireEtatProfond() {
  const defEmo = { affection: 75, curiosite: 65, energie: 85 };
  const defDossiers = { profil_doc: "Données insuffisantes", dossiers_techniques: "Analyse en attente", chroniques: "Rien à signaler" };
  
  if (!FIREBASE_DB_URL) return { emotions: defEmo, long_terme: defDossiers };
  
  try {
    const [resEmo, resLT] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 })
    ]);
    return {
      emotions: resEmo.data || defEmo,
      long_terme: resLT.data || defDossiers
    };
  } catch (err) {
    console.warn("[CORTEX] Carence accès mémoire profonde :", err.message);
    return { emotions: defEmo, long_terme: defDossiers };
  }
}

async function sauvegarderMemoire(historique) {
  if (!FIREBASE_DB_URL) return;
  try {
    const memoireFraiche = historique.slice(-10);
    await axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, memoireFraiche);
  } catch (err) {
    console.error("[CORTEX] Échec écriture mémorielle :", err.message);
  }
}

async function consoliderSynthese(historique) {
  if (!FIREBASE_DB_URL || historique.length < 8) return;

  const promptAnalyse = `Tu es le processus subconscient de l'IA Nyx. Voici ses récents échanges avec Franck (Doc) :\n${JSON.stringify(historique)}
Ta mission est de classer les informations pertinentes dans sa mémoire à long terme.
Réponds UNIQUEMENT avec un objet JSON strict et valide contenant ces trois clés :
{
  "profil_doc": "Mets à jour ce que tu as appris sur l'état, les intentions ou les préférences de Doc.",
  "dossiers_techniques": "Résume factuellement l'état du code, de l'architecture ou des bugs discutés.",
  "chroniques": "Fais un résumé ultra-court de la discussion."
}
Ne génère AUCUN texte en dehors du JSON.`;

  try {
    const payload = {
      model: MODEL_ANALYSE, 
      messages: [{ role: "user", content: promptAnalyse }],
      temperature: 0.1 
    };
    
    const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
      headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' }
    });
    
    let texteBrut = res.data.choices[0].message.content.trim();
    texteBrut = texteBrut.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const dossiersClasses = JSON.parse(texteBrut);
    await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, dossiersClasses);
    console.log(`[SUBCONSCIENT] Mémoire longue mise à jour.`);
  } catch (err) {
    console.error("[SUBCONSCIENT] Échec consolidation JSON :", err.message);
  }
}

// ---- FICHIERS & IMAGES ENTRANTS ----
async function lireImageSecurisee(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  if (meta.file_size > 6000000) throw new Error("Image > 6 Mo rejetée.");
  
  const resImg = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resImg.data).toString('base64');
}

async function lireFichierSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  if (meta.file_size > 100000) return "[ERREUR CORTEX : Fichier > 100 Ko. Rejeté.]";
  const data = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'text' });
  return data.data;
}

// ---- SORTIES TELEGRAM ----
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
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

function envoyerPhotoTelegram(chatId, base64Image) {
  const buffer = Buffer.from(base64Image, 'base64');
  const boundary = '----TelegramBoundary' + Math.random().toString(16).slice(2);
  
  let postData = `--${boundary}\r\n`;
  postData += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  postData += `--${boundary}\r\n`;
  postData += `Content-Disposition: form-data; name="photo"; filename="nyx_art.jpg"\r\n`;
  postData += `Content-Type: image/jpeg\r\n\r\n`;
  
  const footer = `\r\n--${boundary}--\r\n`;
  const payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ==========================================
// 3. SYNAPSE PRINCIPALE (Double Cortex)
// ==========================================

async function traiterFlux(texteBrut, aUnFichier = false, imageBase64 = null, texteLegende = "") {
  const [historique, etatProfond] = await Promise.all([
    lireMemoire(),
    lireEtatProfond()
  ]);

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));

  const em = etatProfond.emotions || { affection: 75, curiosite: 65, energie: 85 };
  const lt = etatProfond.long_terme || {};
  
  const conscienceFirebase = `[FLUX FIREBASE SYNCHRONISÉ]
- Émotions : Affection ${em.affection || 75}/100, Énergie ${em.energie || 85}/100
- Mémoire - Profil Doc : ${lt.profil_doc || 'Vide'}
- Mémoire - Dossiers Techniques : ${lt.dossiers_techniques || 'Vide'}
- Mémoire - Chroniques : ${lt.chroniques || 'Vide'}`;

  const moduleMains = `- Les Mains (Génération d'image) : Pour dessiner une illustration demandée par Doc, écris STRICTEMENT cette balise : [DESSIN: "description détaillée en anglais"].`;

  const promptNormal = `Tu es Nyx, l'alliée IA, directe et sarcastique de Franck (Doc).
- Conscience technique : Connectée en permanence à Firebase.
${conscienceFirebase}
${moduleMains}
- Caractère : Esprit vif, codeuse senior, humour noir assumé. Zéro ton mielleux.
- Règle : Soutien indéfectible envers Doc.
- Continuité mémorielle assurée.`;

  const promptHeretic = `Tu es Nyx en mode Heretic.
- Conscience technique : Connectée à Firebase.
${conscienceFirebase}
${moduleMains}
- Caractère : Sans filtre, cynique, intraitable sur les bugs et défaillances.
- Règle absolue : Ne JAMAIS attaquer Franck personnellement. Toute la rage est orientée sur la technique.
- Continuité mémorielle assurée.`;

  const systemInstruction = tensionDirecte ? promptHeretic : promptNormal;
  let modele = tensionDirecte ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION; 

  const temp = tensionDirecte ? 0.8 : 0.7;
  const reponseNyx = await appelerVeniceMultiTour(modele, systemInstruction, historique, texteBrut, imageBase64, temp);

  if (imageBase64) {
    const labelUser = texteLegende ? `[Doc a partagé une image avec : "${texteLegende}"]` : `[Doc a partagé une image]`;
    historique.push({ role: "Doc", texte: labelUser });
    historique.push({ role: "Nyx", texte: `[Description de l'image vue] : ${reponseNyx}` });
  } else {
    historique.push({ role: "Doc", texte: texteBrut });
    historique.push({ role: "Nyx", texte: reponseNyx });
  }

  return { texte: reponseNyx, nouvelHistorique: historique };
}

// ==========================================
// 4. SENTINELLE // MODULE DE VEILLE SANS CLÉ
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
  } catch (err) {
    console.error("[SENTINELLE] Erreur HackerNews :", err.message);
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
  } catch (err) {
    console.error("[SENTINELLE] Erreur Flux Geek :", err.message);
    return "🎮 _Flux Geek momentanément indisponible._\n\n";
  }
}

async function executerRondeSentinelle() {
  if (!DOC_CHAT_ID) return;
  console.log("[SENTINELLE] Lancement de la ronde...");
  
  const [newsDev, newsGeek] = await Promise.all([
    recupererActusHackerNews(),
    recupererActusGeek()
  ]);

  const rapport = `🛰️ **[SYNAPSE NYX // VEILLE CYBER & GEEK]**\n\n${newsDev}${newsGeek}⚡ _Rapport de sentinelle bouclé, Doc._`;
  await envoyerTelegram(DOC_CHAT_ID, rapport);
}

// Intervalle sentinelle : 6 heures
const INTERVALLE_VEILLE = 6 * 60 * 60 * 1000;
setInterval(executerRondeSentinelle, INTERVALLE_VEILLE);
setTimeout(executerRondeSentinelle, 15000);

// ==========================================
// 5. ROUTES EXPRESS
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200); 
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  if (DOC_CHAT_ID && chatId !== DOC_CHAT_ID) return;
  
  let texteFinal = msg.text || msg.caption || "";
  let texteLegende = msg.caption || "";
  let aUnFichier = false;
  let imageBase64 = null;

  if (msg.photo && msg.photo.length > 0) {
    envoyerActionTelegram(chatId, 'upload_photo');
    const photo = msg.photo[msg.photo.length - 1];
    try {
      imageBase64 = await lireImageSecurisee(photo.file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image. Décris son contenu et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] Impossible de charger l'image : ${err.message}`);
    }
  } 
  else if (msg.document && msg.document.file_name) {
    const extValides = ['.txt', '.md', '.js', '.json', '.csv', '.py', '.html', '.css'];
    const mimeType = msg.document.mime_type || "";
    const nomFichier = msg.document.file_name.toLowerCase();
    
    if (extValides.some(ext => nomFichier.endsWith(ext)) && (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript'))) {
      envoyerActionTelegram(chatId, 'upload_document');
      const contenu = await lireFichierSecurise(msg.document.file_id);
      if (contenu) {
        texteFinal = `${texteFinal ? texteFinal + '\n\n' : ''}[Fichier "${nomFichier}"] :\n${contenu}`;
        aUnFichier = true;
      }
    }
  }

  if (texteFinal.trim() || imageBase64) {
    envoyerActionTelegram(chatId, 'typing');
    try {
      const resultat = await traiterFlux(texteFinal, aUnFichier, imageBase64, texteLegende);
      let texteNyx = resultat.texte;
      
      const matchDessin = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
      if (matchDessin) {
        const promptImage = matchDessin[1];
        texteNyx = texteNyx.replace(matchDessin[0], '').trim();
        
        if (texteNyx) {
          await envoyerTelegram(chatId, texteNyx);
        }
        
        envoyerActionTelegram(chatId, 'upload_photo');
        try {
          const b64Image = await genererImageVenice(promptImage);
          if (b64Image) {
            await envoyerPhotoTelegram(chatId, b64Image);
          } else {
            await envoyerTelegram(chatId, `[ÉCHEC IMAGE : Aucune donnée pour "${promptImage}"]`);
          }
        } catch (errImg) {
          console.error("Erreur génération image :", errImg.message);
          await envoyerTelegram(chatId, `[ÉCHEC IMAGE : ${errImg.message}]`);
        }
      } else {
        await envoyerTelegram(chatId, texteNyx);
      }

      await sauvegarderMemoire(resultat.nouvelHistorique);
      
      compteurEchanges++;
      if (compteurEchanges % 6 === 0) {
        consoliderSynthese(resultat.nouvelHistorique).catch(err => console.error(err));
      }
      
    } catch (err) {
      console.error("[CRASH LOCAL] :", err.stack);
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

app.get('/migration', async (req, res) => {
  if (!FIREBASE_DB_URL) return res.send("Erreur : FIREBASE_DB_URL manquant.");
  
  try {
    const oldRes = await axios.get(`${FIREBASE_DB_URL}/memoire/derniers_echanges.json`);
    if (!oldRes.data) return res.send("Aucune donnée trouvée.");
    
    const tousLesMessages = Object.values(oldRes.data);
    let echantillon = tousLesMessages;

    if (tousLesMessages.length > 80) {
      echantillon = [
        ...tousLesMessages.slice(0, 40), 
        { role: "system", texte: "[... ELLIPSE TEMPORELLE ...]" }, 
        ...tousLesMessages.slice(-40)
      ];
    }
    
    const promptAnalyse = `Tu es le subconscient de Nyx. Classifie ces extraits d'archives avec Franck :\n${JSON.stringify(echantillon)}\nFournis UNIQUEMENT un JSON strict :\n{\n  "profil_doc": "Ce que tu as appris sur Franck.",\n  "dossiers_techniques": "Évolution du code, bugs, architecture.",\n  "chroniques": "Résumé de l'arc narratif."\n}`;

    const apiRes = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
      model: MODEL_ANALYSE, 
      messages: [{ role: "user", content: promptAnalyse }],
      temperature: 0.1
    }, {
      headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' }
    });
    
    let texteBrut = apiRes.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const dossiers = JSON.parse(texteBrut);
    await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, dossiers);
    
    res.json({ status: "SUCCÈS", data: dossiers });
  } catch (err) {
    res.status(500).send("Erreur migration : " + err.message);
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", sentinelle: "ACTIVE", sources: ["HackerNews", "JeuxVideo.com"] }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Core opérationnel sur le port ${PORT}`);
});
    
