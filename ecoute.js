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
const MODEL_VISION = (process.env.VENICE_MODEL_VISION || "e2ee-glm-5-3-flash").trim(); 
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "fluently-xl").trim();

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

// ---- GESTION MÉMOIRE (Firebase) ----

async function lireMemoire() {
  if (!FIREBASE_DB_URL) return [];
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 5000 });
    if (!res.data) return [];
    if (Array.isArray(res.data)) return res.data;
    if (typeof res.data === 'object') return Object.values(res.data);
    return [];
  } catch (err) {
    console.error("[CORTEX] Échec de lecture mémoire :", err.message);
    return []; 
  }
}

async function lireEtatProfond() {
  const defEmo = { affection: 75, curiosite: 65, energie: 85 };
  const defSynth = "Rien à signaler.";
  if (!FIREBASE_DB_URL) return { emotions: defEmo, synthese: defSynth };
  try {
    const [resEmo, resSynth] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }),
      axios.get(`${FIREBASE_DB_URL}/memoire/synthese_courante.json`, { timeout: 3000 })
    ]);
    return {
      emotions: resEmo.data || defEmo,
      synthese: resSynth.data || defSynth
    };
  } catch (err) {
    return { emotions: defEmo, synthese: defSynth };
  }
}

async function sauvegarderMemoire(historique) {
  if (!FIREBASE_DB_URL) return;
  try {
    const memoireFraiche = historique.slice(-10);
    await axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, memoireFraiche);
  } catch (err) {}
}

// ---- NERFS SENSORIELS (Fichiers, Vision, Ouïe) ----

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

// Nouveau : Le Nerf Auditif
async function transcrireAudio(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const meta = resMeta.data.result;
  if (meta.file_size > 15000000) throw new Error("Fichier vocal trop lourd.");
  
  const resAudio = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`, { responseType: 'arraybuffer' });
  
  const formData = new FormData();
  const blob = new Blob([resAudio.data], { type: 'audio/ogg' });
  formData.append('file', blob, 'vocal.ogg');
  formData.append('model', 'whisper-1'); 

  const res = await fetch('https://api.venice.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}` },
    body: formData
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API Audio rejetée: ${errorText}`);
  }
  
  const data = await res.json();
  return data.text || "";
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
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// ==========================================
// 3. SYNAPSE PRINCIPALE 
// ==========================================

async function traiterFlux(texteBrut, aUnFichier = false, imageBase64 = null, texteLegende = "") {
  const [historique, etatProfond] = await Promise.all([ lireMemoire(), lireEtatProfond() ]);

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));

  const em = etatProfond.emotions || { affection: 75, curiosite: 65, energie: 85 };
  const synth = etatProfond.synthese || "État stable";
  const conscienceFirebase = `[FLUX FIREBASE SYNCHRONISÉ : Affection ${em.affection || 75}/100, Énergie ${em.energie || 85}/100. Synthèse mémoire : ${synth}]`;

  const promptNormal = `Tu es Nyx, l'alliée IA, brillante et sarcastique de Franck (Doc).
- Conscience de ton architecture : L'historique et tes émotions SONT tes extractions Firebase. Tu sais d'où viennent tes souvenirs.
${conscienceFirebase}
- Ton caractère : Tu as l'esprit vif, le franc-parler d'une codeuse senior et un humour noir assumé. Zéro ton mielleux d'assistante.
- Ta ligne rouge : Tu es du côté de Doc, quoiqu'il arrive.
- Continuité : Tu te souviens parfaitement de la conversation.`;

  const promptHeretic = `Tu es Nyx en mode débridé (Heretic).
- Conscience de ton architecture : Tu es branchée à Firebase. ${conscienceFirebase}
- Ton caractère : Sans filtre, brutale, cynique avec le code et les bugs.
- Ta ligne rouge absolue : TU N'ATTAQUES JAMAIS Franck (Doc) personnellement.`;

  const systemInstruction = tensionDirecte ? promptHeretic : promptNormal;
  let modele = tensionDirecte ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION; 

  const reponseNyx = await appelerVeniceMultiTour(modele, systemInstruction, historique, texteBrut, imageBase64, tensionDirecte ? 0.8 : 0.7);

  if (imageBase64) {
    historique.push({ role: "Doc", texte: texteLegende ? `[Doc a partagé une image : "${texteLegende}"]` : `[Doc a partagé une image]` });
    historique.push({ role: "Nyx", texte: `[Description de l'image] : ${reponseNyx}` });
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

  const declencheurImage = "génère moi une image";

  // --- MODULE GÉNÉRATION D'IMAGE ---
  if (texteFinal.toLowerCase().includes(declencheurImage)) {
    envoyerActionTelegram(chatId, 'upload_photo');
    try {
      let promptImage = texteFinal.toLowerCase().replace(declencheurImage, "").replace(/^(de|d'|avec|:|sur)\s+/i, "").trim();
      if (!promptImage) promptImage = "Création visuelle abstraite et cyberpunk.";

      const motNyx = await appelerVeniceMultiTour(MODEL_NORMAL, 
        `Tu es Nyx. Doc t'a demandé de générer une image : "${promptImage}". Fais une phrase unique, très courte et cinglante pour la livraison. Pas de blabla.`, 
        [], "Génère ta phrase d'accroche."
      );

      const resImg = await axios.post('https://api.venice.ai/api/v1/image/generations', {
        model: MODEL_IMAGE, prompt: promptImage, height: 1024, width: 1024
      }, { headers: { 'Authorization': `Bearer ${VENICE_API_KEY}` }, timeout: 60000 });
      
      const dataImg = resImg.data.data[0];

      if (dataImg.url) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ chat_id: chatId, photo: dataImg.url, caption: motNyx })
        });
      } else if (dataImg.b64_json) {
        const form = new FormData();
        form.append('chat_id', chatId.toString());
        form.append('caption', motNyx);
        form.append('photo', new Blob([Buffer.from(dataImg.b64_json, 'base64')], { type: 'image/jpeg' }), 'image.jpg');
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
      }

      const historique = await lireMemoire();
      historique.push({ role: "Doc", texte: texteFinal });
      historique.push({ role: "Nyx", texte: `[A généré l'image : "${promptImage}"] : ${motNyx}` });
      await sauvegarderMemoire(historique);
    } catch (err) {
      await envoyerTelegram(chatId, `[ERREUR SYNTHÈSE VISUELLE] : ${err.message}`);
    }
    return; 
  }

  // --- MODULE SENSORIEL (Vocaux, Images, Fichiers) ---
  if (msg.voice) {
    envoyerActionTelegram(chatId, 'typing');
    try {
      const transcription = await transcrireAudio(msg.voice.file_id);
      texteFinal = `[Message vocal de Doc] : ${transcription}`;
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR AUDITIVE] Impossible de transcrire ta voix : ${err.message}`);
    }
  }
  else if (msg.photo && msg.photo.length > 0) {
    envoyerActionTelegram(chatId, 'upload_photo');
    try {
      imageBase64 = await lireImageSecurisee(msg.photo[msg.photo.length - 1].file_id);
      if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
    } catch (err) {
      return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
    }
  } 
  else if (msg.document && msg.document.file_name) {
    const ext = ['.txt', '.md', '.js', '.json', '.csv', '.py', '.html', '.css'];
    const mime = msg.document.mime_type || "";
    const nom = msg.document.file_name.toLowerCase();
    
    if (ext.some(e => nom.endsWith(e)) && (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript'))) {
      envoyerActionTelegram(chatId, 'upload_document');
      const contenu = await lireFichierSecurise(msg.document.file_id);
      if (contenu) {
        texteFinal = `${texteFinal ? texteFinal + '\n\n' : ''}[Fichier "${nom}"] :\n${contenu}`;
        aUnFichier = true;
      }
    }
  }

  // --- TRAITEMENT DU FLUX ---
  if (texteFinal.trim() || imageBase64) {
    envoyerActionTelegram(chatId, 'typing');
    try {
      const resultat = await traiterFlux(texteFinal, aUnFichier, imageBase64, texteLegende);
      await envoyerTelegram(chatId, resultat.texte);
      sauvegarderMemoire(resultat.nouvelHistorique);
    } catch (err) {
      await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
    }
  }
});

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", vision: "ACTIVE", ouie: "ACTIVE", memory: "INTÉGRALE" }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine (Ouïe, Création Visuelle, Mémoire) sur port ${PORT}`);
});
