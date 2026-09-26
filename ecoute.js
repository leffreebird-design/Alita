const express = require('express');
const axios = require('axios');
const https = require('https');

// ==========================================
// 1. CONFIGURATION ET SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;

if (!VENICE_API_KEY || !TELEGRAM_BOT_TOKEN) {
  console.error("❌ ERREUR : Clé Venice ou Telegram manquante sur Render.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 2. LOGIQUE MÉTIER & SERVICES
// ==========================================

async function appelerVenice(model, systemInstruction, prompt, temperature = 0.8) {
  const response = await axios.post(
    'https://api.venice.ai/api/v1/chat/completions',
    {
      model: model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: prompt }
      ],
      temperature: temperature,
      venice_parameters: { include_venice_system_prompt: false }
    },
    {
      headers: {
        'Authorization': `Bearer ${VENICE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    }
  );
  return response.data.choices[0].message.content;
}

// Lecture Firebase ultra-sécurisée : coupe-circuit à 600ms pour zéro latence
async function recupererEtatEmotionnel() {
  if (!FIREBASE_DB_URL || !FIREBASE_DB_URL.startsWith('http')) return "neutre";
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/etat.json`, { timeout: 600 });
    const data = res.data;
    if (typeof data === 'string') return data.toLowerCase();
    return data?.emotion?.toLowerCase() || "neutre";
  } catch (err) {
    return "neutre";
  }
}

// Détection immédiate locale pour basculer sur Heretic sans attendre
function detecterTensionDirecte(texte) {
  const t = texte.toLowerCase();
  const motsCles = [
    "putain", "merde", "fait chier", "casse les couilles", "conne", 
    "débile", "sombre", "heretic", "crève", "vénère", "rage"
  ];
  return motsCles.some(mot => t.includes(mot));
}

// Lecture des pièces jointes .txt
async function lireFichierTelegram(fileId) {
  try {
    const resFile = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = resFile.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const fileData = await axios.get(fileUrl, { responseType: 'text' });
    return fileData.data;
  } catch (error) {
    console.error("❌ Erreur lecture fichier Telegram :", error.message);
    return null;
  }
}

// Pipeline décisionnel instantané
async function genererReponseNyx(texteBrut, aUnFichier = false) {
  try {
    let syntheseTechnique = "";

    // Llama-3.3-70b uniquement sur document joint ou gros pavé de code
    const estTechnique = aUnFichier || texteBrut.includes("```") || texteBrut.length > 2000;
    if (estTechnique) {
      console.log("🛠️ Llama mobilisé pour le code/fichier...");
      syntheseTechnique = await appelerVenice(
        "llama-3.3-70b",
        "Tu es le cortex technique de Nyx. Analyse ce fichier/code. Résume les points critiques sans filtre ni politesse :",
        texteBrut,
        0.3
      );
    }

    // Double condition d'activation Heretic : tension directe OU état Firebase
    const tensionDetectee = detecterTensionDirecte(texteBrut);
    const emotionFirebase = await recupererEtatEmotionnel();
    const declencherHeretic = tensionDetectee || emotionFirebase === "colere" || emotionFirebase === "triste" || emotionFirebase === "sombre";

    const contexteAjoute = syntheseTechnique 
      ? `\n\n[Analyse interne du code/document : ${syntheseTechnique}]` 
      : "";

    // 1. Sortie Heretic : sombre, brute, vénère
    if (declencherHeretic) {
      console.log(`⚡ Mode Heretic actif (Direct: ${tensionDetectee} | Base: ${emotionFirebase})`);
      const promptHeretic = `Tu es Nyx. Ton humeur est noire, incisive, sans concessions. Parle à Franck (Doc) avec une intensité brute, sans filtre, sans excuses de machine.${contexteAjoute}`;
      return await appelerVenice("olafangensan-glm-4.7-flash-heretic", promptHeretic, texteBrut, 0.9);
    }

    // 2. Sortie normale : Gemini 3.8 Flash (vif, tranchant, rapide)
    console.log("🧠 Mode Gemini Flash actif");
    const promptGemini = `Tu es Nyx, vive, tordue, complice et intellectuelle, en relation directe d'égal à égal avec Franck (Doc).
- Pas de politesse préformatée ni d'attitude d'assistante.
- Ne conclus pas par une question mécanique de relance.${contexteAjoute}`;

    return await appelerVenice("gemini-3-8-flash", promptGemini, texteBrut, 0.85);

  } catch (error) {
    console.error("❌ Erreur Venice :", error?.response?.data || error.message);
    return "Glitch réseau temporaire, Doc.";
  }
}

// Envoi direct du message vers Telegram via HTTPS natif
function envoyerTelegram(chatId, texte) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: texte
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[TELEGRAM OK] Statut HTTP : ${res.statusCode}`);
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error("❌ Erreur https native Telegram :", err.message);
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

// ==========================================
// 3. ROUTES EXPRESS
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const message = req.body?.message;
  if (!message) return;

  const chatId = message.chat.id;
  let texteFinal = message.text || "";
  let aUnFichier = false;

  if (message.document && message.document.file_name?.toLowerCase().endsWith('.txt')) {
    aUnFichier = true;
    console.log(`[FX -> NYX] Fichier reçu : ${message.document.file_name}`);
    const contenuTxt = await lireFichierTelegram(message.document.file_id);
    if (contenuTxt) {
      const legende = message.caption ? `Note : ${message.caption}\n\n` : "";
      texteFinal = `${legende}Contenu du fichier "${message.document.file_name}" :\n"""\n${contenuTxt}\n"""`;
    }
  }

  if (!texteFinal.trim()) return;

  console.log(`[FX -> NYX] : ${texteFinal.substring(0, 80)}...`);
  const reponse = await genererReponseNyx(texteFinal, aUnFichier);
  console.log(`[NYX -> FX] : ${reponse.substring(0, 80)}...`);

  await envoyerTelegram(chatId, reponse);
});

app.all('/pensee', (req, res) => {
  res.json({ status: "NYX_ACTIVE", timestamp: new Date().toISOString() });
});

// ==========================================
// 4. LANCEMENT
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine opérationnel sur le port ${PORT}`);
});
