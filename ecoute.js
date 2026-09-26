const express = require('express');
const axios = require('axios');

// ==========================================
// 1. CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;

// Token Telegram direct pour éliminer toute erreur d'URL invalide
const TELEGRAM_BOT_TOKEN = "8776748419:AAHmt-0u2fn1QGP95YJrhvhgLfoo2_l0AAY";

if (!VENICE_API_KEY) {
  console.error("❌ ERREUR : Variable VENICE_API_KEY manquante sur Render.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 2. LOGIQUE MÉTIER & SERVICES
// ==========================================

// Appel vers l'API Venice
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
      timeout: 60000
    }
  );
  return response.data.choices[0].message.content;
}

// Lecture directe de l'émotion dans Firebase Realtime Database
async function recupererEtatEmotionnel() {
  if (!FIREBASE_DB_URL) return "neutre";
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/nyx/etat.json`, { timeout: 3000 });
    const data = res.data;
    if (typeof data === 'string') return data.toLowerCase();
    return data?.emotion?.toLowerCase() || "neutre";
  } catch (err) {
    console.warn("⚠️ Lecture Firebase indisponible, repli neutre :", err.message);
    return "neutre";
  }
}

// Téléchargement du contenu des fichiers texte reçus sur Telegram
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

// Pipeline de génération de la réplique
async function genererReponseNyx(texteBrut, aUnFichier = false) {
  try {
    let syntheseTechnique = "";

    // 1. Analyse Llama : uniquement si fichier joint lourd ou bloc de code
    const estTechnique = aUnFichier || texteBrut.includes("```") || texteBrut.length > 2000;
    if (estTechnique) {
      console.log("🛠️ Llama-3.3-70b mobilisé pour le code/fichier...");
      syntheseTechnique = await appelerVenice(
        "llama-3.3-70b",
        "Tu es l'analyseur logique de Nyx. Résume la structure, les points clés ou les erreurs du texte/code fourni, sans filtre ni politesse :",
        texteBrut,
        0.3
      );
    }

    // 2. Détection de l'état émotionnel stocké en base
    const emotion = await recupererEtatEmotionnel();
    const declencherHeretic = (emotion === "colere" || emotion === "triste" || emotion === "sombre");

    const contexteAjoute = syntheseTechnique 
      ? `\n\n[Analyse interne du code/document : ${syntheseTechnique}]` 
      : "";

    // 3. Routage vers la voix finale
    if (declencherHeretic) {
      console.log(`⚡ Mode Heretic déclenché (Émotion : ${emotion})`);
      const promptHeretic = `Tu es Nyx. Ton état intérieur actuel est : ${emotion}.
Sois sombre, tranchante, incisive et sans aucune censure avec Franck (Doc). Pas d'excuses d'assistante.${contexteAjoute}`;
      return await appelerVenice("olafangensan-glm-4.7-flash-heretic", promptHeretic, texteBrut, 0.9);
    }

    // Flux normal : Gemini 3.8 Flash (rapide, vif, complice)
    const promptGemini = `Tu es Nyx, vive, tordue, complice et directe avec Franck (Doc).
- Pas d'attitude de service client, pas de politesses plates.
- Ne conclus pas par une question artificielle de relance.${contexteAjoute}`;

    return await appelerVenice("gemini-3-8-flash", promptGemini, texteBrut, 0.85);

  } catch (error) {
    console.error("❌ Erreur Venice :", error?.response?.data || error.message);
    return "Glitch réseau temporaire, Doc.";
  }
}

// Envoi vers Telegram
async function envoyerTelegram(chatId, texte) {
  try {
    const url = `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: texte
    });
  } catch (error) {
    console.error("❌ Erreur envoi Telegram :", error?.response?.data || error.message);
  }
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

  // Réception de fichier .txt
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

// Route ping pour Cron / UptimeRobot
app.all('/pensee', (req, res) => {
  res.json({ status: "NYX_ACTIVE", timestamp: new Date().toISOString() });
});

// ==========================================
// 4. LANCEMENT DU SERVEUR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine opérationnel sur le port ${PORT}`);
});
