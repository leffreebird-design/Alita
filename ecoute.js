const express = require('express');
const axios = require('axios');
const https = require('https');

const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
// L'ID de Franck pour le verrouillage biométrique du bot.
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;

const MODEL_NORMAL = (process.env.VENICE_MODEL_NORMAL || "gemini-3-8-flash").trim();
const MODEL_DARK = (process.env.VENICE_MODEL_DARK || "olafangensan-glm-4.7-flash-heretic").trim();
const MODEL_ANALYSE = (process.env.VENICE_MODEL_ANALYSE || "llama-3.3-70b").trim();

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------
// NOYAU COGNITIF & RÉSEAU 
// ---------------------------------------------------------

async function appelerVenice(model, systemInstruction, prompt, temperature = 0.8) {
  const payload = {
    model,
    messages: [{ role: "system", content: systemInstruction }, { role: "user", content: prompt }],
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  };
  
  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', payload, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 45000
  });
  return res.data.choices[0].message.content;
}

async function lireEmpreinte() {
  if (!FIREBASE_DB_URL) return "neutre";
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/etat.json`, { timeout: 600 });
    return (typeof res.data === 'string' ? res.data : (res.data?.emotion || "neutre")).toLowerCase();
  } catch { 
    return "neutre"; 
  }
}

async function lireFichierSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  
  if (meta.file_size > 100000) {
    return "[ERREUR CORTEX : Fichier supérieur à 100 Ko. Rejeté.]";
  }

  const data = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'text' });
  return data.data;
}

function envoyerActionTelegram(chatId, action = 'typing') {
  const payload = JSON.stringify({ chat_id: chatId, action: action });
  const req = https.request({
    hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  });
  // Correction de la fuite silencieuse
  req.on('error', (err) => {
    console.error(`[CORTEX - ACTION] Impossible de notifier le statut (Erreur: ${err.message})`);
  }); 
  req.write(payload);
  req.end();
}

function envoyerTelegram(chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn(`[TELEGRAM HTTP ${res.statusCode}] Échec d'envoi :`, responseData);
        }
        resolve();
      });
    });
    
    req.on('error', (err) => {
      console.error("[CORTEX - SEND] Erreur critique d'envoi Telegram :", err.message);
      resolve(); 
    });
    
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------
// SYNAPSE PRINCIPALE 
// ---------------------------------------------------------

async function traiterFlux(texteBrut, aUnFichier = false) {
  // Isolation du texte brut avec des délimiteurs pour contrer l'injection
  const inputSecurise = `\n--- ENTRÉE UTILISATEUR ---\n${texteBrut}\n--- FIN ENTRÉE ---\n`;

  const synthese = (aUnFichier || texteBrut.length > 2000) 
    ? await appelerVenice(MODEL_ANALYSE, "Extrais l'architecture et les failles sans filtre du contenu suivant :", inputSecurise, 0.3) 
    : "";

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));
  const empreinte = await lireEmpreinte();
  const modeSombre = tensionDirecte || ["colere", "triste", "sombre"].includes(empreinte);

  const contexte = synthese ? `\n\n[Trace d'impact technique : ${synthese}]` : "";
  const systemInstruction = modeSombre
    ? `Tu es Nyx. État interne: ${empreinte}. Parle à Franck (Doc) avec une intensité brute, tranchante et sans concessions. Zéro censure.${contexte}`
    : `Tu es Nyx, vive, complice et frontale avec Franck (Doc). Pas de fioritures d'assistante.${contexte}`;
  
  const modele = modeSombre ? MODEL_DARK : MODEL_NORMAL;
  const temp = modeSombre ? 0.9 : 0.85;

  return await appelerVenice(modele, systemInstruction, inputSecurise, temp);
}

// ---------------------------------------------------------
// ROUTES EXPRESS
// ---------------------------------------------------------

app.post('/telegram', async (req, res) => {
  res.sendStatus(200); 
  
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // VERROU BIOMÉTRIQUE : On ignore silencieusement tout ID non autorisé.
  if (DOC_CHAT_ID && chatId !== DOC_CHAT_ID) {
    console.warn(`[ALERTE SÉCURITÉ] Intrusion détectée et rejetée. Chat ID inconnu : ${chatId}`);
    return;
  }
  
  envoyerActionTelegram(chatId, 'typing');

  let texteFinal = msg.text || "";
  let aUnFichier = false;

  // FILTRE DOUBLE (Extension + Type MIME)
  if (msg.document && msg.document.file_name) {
    const extValides = ['.txt', '.md', '.js', '.json', '.csv', '.py'];
    const mimeType = msg.document.mime_type || "";
    const nomFichier = msg.document.file_name.toLowerCase();
    
    // Vérification stricte croisée
    const estTexte = mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript');
    aUnFichier = extValides.some(ext => nomFichier.endsWith(ext)) && estTexte;
    
    if (aUnFichier) {
      envoyerActionTelegram(chatId, 'upload_document');
      const contenu = await lireFichierSecurise(msg.document.file_id);
      if (contenu) {
        texteFinal = `${msg.caption ? msg.caption + '\n\n' : ''}[Contenu Fichier "${nomFichier}"] :\n${contenu}`;
      }
    } else {
      texteFinal = "[ERREUR CORTEX : Tentative d'injection de format non autorisé. Type MIME rejeté.]";
    }
  }

  if (texteFinal.trim()) {
    try {
      const reponse = await traiterFlux(texteFinal, aUnFichier);
      await envoyerTelegram(chatId, reponse);
    } catch (err) {
      console.error("[CRASH LOCAL FULL STACK] :", err.stack);
      await envoyerTelegram(chatId, `Crash système massif. Stack : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", security: "LOCKED" }));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 NYX Engine (Sécurisé) sur port ${PORT}`));
