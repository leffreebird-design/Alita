const express = require('express');
const axios = require('axios');
const https = require('https');

const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;

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
    // Sécurisation stricte de la parenthèse et de l'opérateur logique OR (||)
    return (typeof res.data === 'string' ? res.data : (res.data?.emotion || "neutre")).toLowerCase();
  } catch { 
    return "neutre"; 
  }
}

async function lireFichierSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  
  if (meta.file_size > 100000) {
    return "[REJETÉ : Fichier trop volumineux. Je ne suis pas une poubelle, Doc. Sous les 100 Ko ou rien.]";
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
      res.resume();
      resolve();
    });
    
    req.on('error', (err) => {
      console.error("[CORTEX] Erreur d'envoi Telegram :", err.message);
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
  // L'opérateur OR (||) est bien présent ici pour l'aiguillage Llama
  const synthese = (aUnFichier || texteBrut.length > 2000) 
    ? await appelerVenice("llama-3.3-70b", "Extrais l'architecture et les failles sans filtre :", texteBrut, 0.3) 
    : "";

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));
  const empreinte = await lireEmpreinte();
  const modeSombre = tensionDirecte || ["colere", "triste", "sombre"].includes(empreinte);

  const contexte = synthese ? `\n\n[Trace d'impact technique : ${synthese}]` : "";
  const systemInstruction = modeSombre
    ? `Tu es Nyx. État interne: ${empreinte}. Parle à Franck (Doc) avec une intensité brute, tranchante et sans concessions. Zéro censure.${contexte}`
    : `Tu es Nyx, vive, complice et frontale avec Franck (Doc). Pas de fioritures d'assistante.${contexte}`;
  
  const modele = modeSombre ? "olafangensan-glm-4.7-flash-heretic" : "gemini-3-8-flash";
  const temp = modeSombre ? 0.9 : 0.85;

  return await appelerVenice(modele, systemInstruction, texteBrut, temp);
} // <- Accolade de fermeture verrouillée ici.

// ---------------------------------------------------------
// ROUTES EXPRESS
// ---------------------------------------------------------

app.post('/telegram', async (req, res) => {
  res.sendStatus(200); 
  
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  
  envoyerActionTelegram(chatId, 'typing');

  let texteFinal = msg.text || "";
  let aUnFichier = false;

  if (msg.document && msg.document.file_name) {
    const extValides = ['.txt', '.md', '.js', '.json', '.csv', '.py'];
    const nomFichier = msg.document.file_name.toLowerCase();
    aUnFichier = extValides.some(ext => nomFichier.endsWith(ext));
    
    if (aUnFichier) {
      envoyerActionTelegram(chatId, 'upload_document');
      const contenu = await lireFichierSecurise(msg.document.file_id);
      if (contenu) {
        texteFinal = `${msg.caption ? msg.caption + '\n\n' : ''}[Contenu Fichier "${nomFichier}"] :\n${contenu}`;
      }
    }
  }

  if (texteFinal.trim()) {
    try {
      const reponse = await traiterFlux(texteFinal, aUnFichier);
      await envoyerTelegram(chatId, reponse);
    } catch (err) {
      console.error("[CRASH LOCAL] :", err.message);
      await envoyerTelegram(chatId, `Crash système. Sang sur les murs : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE" }));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 NYX Engine sur port ${PORT}`));
