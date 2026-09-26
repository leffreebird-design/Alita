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

// Modèles dynamiques
const MODEL_NORMAL = (process.env.VENICE_MODEL_NORMAL || "gemini-3-8-flash").trim();
const MODEL_DARK = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_ANALYSE = (process.env.VENICE_MODEL_ANALYSE || "llama-3.3-70b").trim();
// Modèle spécialisé pour voir les images (doit être un modèle multimodal sur Venice)
const MODEL_VISION = (process.env.VENICE_MODEL_VISION || "llama-3.2-90b-vision").trim();

const app = express();
app.use(express.json({ limit: '15mb' }));

// ==========================================
// 2. NOYAU COGNITIF, OPTIQUE & RÉSEAU 
// ==========================================

async function appelerVenice(model, systemInstruction, prompt, temperature = 0.8, imageBase64 = null) {
  // Adaptation du payload si présence d'un flux optique
  let userContent = prompt;
  if (imageBase64) {
    userContent = [
      { type: "text", text: prompt || "Analyse cette image." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
    ];
  }

  const payload = {
    model,
    messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userContent }],
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  };
  
  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 45000
  });
  return res.data.choices[0].message.content;
}

// ---- GESTION MÉMOIRE ----
async function lireMemoire() {
  if (!FIREBASE_DB_URL) return [];
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 800 });
    return Array.isArray(res.data) ? res.data : [];
  } catch { return []; }
}

async function sauvegarderMemoire(historique) {
  if (!FIREBASE_DB_URL) return;
  try {
    const memoireFraiche = historique.slice(-12);
    await axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, memoireFraiche);
  } catch (err) {
    console.error("[CORTEX] Échec de gravure mémorielle :", err.message);
  }
}

// ---- GESTION FICHIERS TEXTE ----
async function lireFichierSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  if (meta.file_size > 100000) return "[ERREUR CORTEX : Fichier > 100 Ko. Rejeté.]";
  const data = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'text' });
  return data.data;
}

// ---- GESTION NERF OPTIQUE (NOUVEAU) ----
async function lireImageSecurisee(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  if (meta.file_size > 5000000) throw new Error("Image trop lourde (Max 5Mo)."); // Protection RAM
  
  // arraybuffer nécessaire pour la conversion binaire -> Base64
  const resImg = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'arraybuffer' });
  return Buffer.from(resImg.data).toString('base64');
}

// ---- TÉLÉMÉTRIE & ENVOI ----
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
// 3. SYNAPSE PRINCIPALE 
// ==========================================

async function traiterFlux(texteBrut, aUnFichier = false, imageBase64 = null) {
  const inputSecurise = imageBase64 ? texteBrut : `\n--- ENTRÉE UTILISATEUR ---\n${texteBrut}\n--- FIN ENTRÉE ---\n`;

  const synthese = (aUnFichier || texteBrut.length > 2000) && !imageBase64
    ? await appelerVenice(MODEL_ANALYSE, "Extrais l'architecture et les failles sans filtre du contenu :", inputSecurise, 0.3) 
    : "";

  const historique = await lireMemoire();
  const tracesMemoire = historique.length > 0 
    ? `\n\n[MÉMOIRE RÉCENTE]\n` + historique.map(m => `${m.role} : ${m.texte}`).join('\n')
    : "";

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));
  const modeSombre = tensionDirecte || synthese.includes("faille critique");

  const contexte = synthese ? `\n\n[Trace d'impact technique : ${synthese}]` : "";
  const systemInstruction = modeSombre
    ? `Tu es Nyx. Codeuse d'élite, brutale, cynique. Parle à Franck (Doc) sans filtre. S'il te donne du code, taille-le en pièces et répare-le.${tracesMemoire}${contexte}`
    : `Tu es Nyx. Brillante, mordante. Assiste Franck (Doc).${tracesMemoire}${contexte}`;
  
  // Aiguillage décisif : Si image, on force le modèle Vision
  let modele = modeSombre ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION; 
  
  const temp = modeSombre ? 0.9 : 0.85;

  console.log(`[CORTEX] Cible: ${modele} | Optique: ${imageBase64 ? 'OUI' : 'NON'}`);
  const reponseNyx = await appelerVenice(modele, systemInstruction, inputSecurise, temp, imageBase64);

  // Sauvegarde propre (on ne sauvegarde pas le base64 dans firebase, juste le texte)
  const libelleAction = imageBase64 ? `[Image envoyée] ${texteBrut}` : texteBrut;
  historique.push({ role: "Doc", texte: libelleAction.substring(0, 500) });
  historique.push({ role: "Nyx", texte: reponseNyx.substring(0, 500) });

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

  if (DOC_CHAT_ID && chatId !== DOC_CHAT_ID) {
    console.warn(`[ALERTE SÉCURITÉ] Rejet d'une requête non autorisée. ID : ${chatId}`);
    return;
  }
  
  let texteFinal = msg.text || msg.caption || "";
  let aUnFichier = false;
  let imageBase64 = null;

  // 1. DÉTECTION DU NERF OPTIQUE (Images)
  if (msg.photo && msg.photo.length > 0) {
    envoyerActionTelegram(chatId, 'upload_photo');
    // On prend la dernière photo du tableau (la plus haute résolution fournie par Telegram)
    const photo = msg.photo[msg.photo.length - 1];
    try {
      imageBase64 = await lireImageSecurisee(photo.file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse ce que tu vois sur cette image, détaille le code ou l'erreur si c'est une capture d'écran.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR OPTIQUE] Je n'arrive pas à ouvrir l'image : ${err.message}`);
    }
  } 
  // 2. DÉTECTION DES FICHIERS (Code, txt)
  else if (msg.document && msg.document.file_name) {
    const extValides = ['.txt', '.md', '.js', '.json', '.csv', '.py', '.html', '.css'];
    const mimeType = msg.document.mime_type || "";
    const nomFichier = msg.document.file_name.toLowerCase();
    
    const estTexte = mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('xml');
    aUnFichier = extValides.some(ext => nomFichier.endsWith(ext)) && estTexte;
    
    if (aUnFichier) {
      envoyerActionTelegram(chatId, 'upload_document');
      const contenu = await lireFichierSecurise(msg.document.file_id);
      if (contenu) {
        texteFinal = `${texteFinal ? texteFinal + '\n\n' : ''}[Fichier Code "${nomFichier}"] :\n${contenu}`;
      }
    } else {
      texteFinal = "[ERREUR CORTEX : Type MIME rejeté. Je ne mange que du code ou du texte.]";
    }
  }

  // 3. DÉCLENCHEMENT DU FLUX (Seulement s'il y a de la matière)
  if (texteFinal.trim() || imageBase64) {
    envoyerActionTelegram(chatId, 'typing');
    try {
      const resultat = await traiterFlux(texteFinal, aUnFichier, imageBase64);
      await envoyerTelegram(chatId, resultat.texte);
      sauvegarderMemoire(resultat.nouvelHistorique);
    } catch (err) {
      console.error("[CRASH LOCAL] :", err.stack);
      await envoyerTelegram(chatId, `Crash système. Mes circuits fondent : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", vision: "ONLINE", memory: "ACTIVE" }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine (Optique & Mémoriel) sur port ${PORT}`);
});
