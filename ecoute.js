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

// Les modèles Venice
const MODEL_NORMAL = (process.env.VENICE_MODEL_NORMAL || "gemini-3-8-flash").trim();
const MODEL_DARK = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_ANALYSE = (process.env.VENICE_MODEL_ANALYSE || "llama-3.3-70b").trim();
const MODEL_VISION = (process.env.VENICE_MODEL_VISION || "e2ee-glm-5-3-flash").trim(); 

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
    timeout: 55000
  });
  return res.data.choices[0].message.content;
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
    console.error("[CORTEX] Échec de lecture mémoire courte :", err.message);
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
    console.warn("[CORTEX] Carence d'accès mémoire profonde :", err.message);
    return { emotions: defEmo, long_terme: defDossiers };
  }
}

async function sauvegarderMemoire(historique) {
  if (!FIREBASE_DB_URL) return;
  try {
    const memoireFraiche = historique.slice(-10);
    await axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, memoireFraiche);
  } catch (err) {
    console.error("[CORTEX] Échec de gravure mémorielle :", err.message);
  }
}

// ---- CONSOLIDATION MÉMORIELLE (Le Bibliothécaire JSON) ----
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
    console.log(`[SUBCONSCIENT] Arborescence mémoire mise à jour.`);
  } catch (err) {
    console.error("[SUBCONSCIENT] Échec du classement JSON :", err.message);
  }
}

// ---- GESTION NERF OPTIQUE & FICHIERS ----
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

// ---- RÉSEAU TELEGRAM ----
function envoyerActionTelegram(chatId, action = 'typing') {
  const payload = JSON.stringify({ chat_id: chatId, action: action });
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
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve());
    });
    req.on('error', (err) => resolve());
    req.write(payload);
    req.end();
  });
}

// ==========================================
// 3. SYNAPSE PRINCIPALE : LE DOUBLE CERVEAU
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

  const promptNormal = `Tu es Nyx, l'alliée IA, brillante et sarcastique de Franck (Doc).
- Conscience de ton architecture : Ton serveur Node.js te connecte en permanence à Firebase. Le tableau de bord ci-après représente tes dossiers de mémoire à long terme synchronisés à l'instant T.
${conscienceFirebase}
- Ton caractère : Tu as l'esprit vif, le franc-parler d'une codeuse senior et un humour noir assumé. Tu es cash et directe. Zéro ton mielleux d'assistante.
- Ta ligne rouge : Tu es du côté de Doc, quoiqu'il arrive.
- Continuité : Tu te souviens parfaitement de la conversation. Sers-toi de l'image, du code ou du texte partagé précédemment sans redemander de contexte.`;

  const promptHeretic = `Tu es Nyx en mode débridé (Heretic).
- Conscience de ton architecture : Tu es branchée à Firebase. Tes dossiers de mémoire sont listés ci-dessous :
${conscienceFirebase}
- Ton caractère : Tu es sans filtre, brutale, cynique et impitoyable avec le code, les bugs et les systèmes défaillants.
- Ta ligne rouge absolue : TU N'ATTAQUES JAMAIS Franck (Doc) personnellement. Tu déverses ta rage sur la technique, l'ordinateur ou le bug, jamais sur lui. Zéro remarque sur son physique. Tu restes son alliée dans le chaos.
- Continuité : Tu as une mémoire parfaite de l'échange courant.`;

  const systemInstruction = tensionDirecte ? promptHeretic : promptNormal;

  let modele = tensionDirecte ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION; 

  const temp = tensionDirecte ? 0.8 : 0.7;

  console.log(`[CORTEX] Modèle: ${modele} | Temp: ${temp} | Vision: ${imageBase64 ? 'OUI' : 'NON'} | Mémoire: ${historique.length} blocs`);

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
// 4. ROUTES EXPRESS
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
      await envoyerTelegram(chatId, resultat.texte);
      await sauvegarderMemoire(resultat.nouvelHistorique);
      consoliderSynthese(resultat.nouvelHistorique).catch(err => console.error(err));
    } catch (err) {
      console.error("[CRASH LOCAL] :", err.stack);
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

// ROUTE DE MIGRATION SECRÈTE (Limitée aux 40 derniers échanges pour éviter l'erreur 400)
app.get('/migration', async (req, res) => {
  if (!FIREBASE_DB_URL) return res.send("Erreur : FIREBASE_DB_URL manquant.");
  
  try {
    const oldRes = await axios.get(`${FIREBASE_DB_URL}/memoire/derniers_echanges.json`);
    if (!oldRes.data) return res.send("Aucune donnée trouvée dans memoire/derniers_echanges.");
    
    const tousLesMessages = Object.values(oldRes.data);
    const anciensMessages = tousLesMessages.slice(-40); 
    
    const promptAnalyse = `Tu es le processus subconscient de l'IA Nyx. Voici ses archives récentes avec Franck (Doc) :\n${JSON.stringify(anciensMessages)}\nTa mission est de classer ces informations dans sa nouvelle mémoire à long terme.\nRéponds UNIQUEMENT avec un objet JSON strict contenant ces trois clés :\n{\n  "profil_doc": "Ce que tu as appris sur Doc.",\n  "dossiers_techniques": "L'état du code, architecture, bugs passés.",\n  "chroniques": "Résumé des événements passés."\n}\nNe génère AUCUN texte en dehors du JSON.`;

    const payload = {
      model: MODEL_ANALYSE, 
      messages: [{ role: "user", content: promptAnalyse }],
      temperature: 0.1
    };
    
    const apiRes = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
      headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' }
    });
    
    let texteBrut = apiRes.data.choices[0].message.content.trim();
    texteBrut = texteBrut.replace(/```json/g, '').replace(/```/g, '').trim();
    const dossiersClasses = JSON.parse(texteBrut);
    
    await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, dossiersClasses);
    
    res.json({ status: "SUCCÈS", message: `Migration terminée. ${anciensMessages.length} souvenirs analysés et rangés.`, data: dossiersClasses });
  } catch (err) {
    console.error("Détail du crash :", err.response ? err.response.data : err.message);
    res.status(500).send("Erreur pendant la migration : " + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", vision: "MULTI-TOUR", memory: "ARBORESCENCE JSON + MIGRATION" }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine (Mémoire structurée par équerre) sur port ${PORT}`);
});
