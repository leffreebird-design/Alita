const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VENICE_API_KEY = process.env.VENICE_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL; // Ex: https://ton-projet-default-rtdb.firebaseio.com/

if (!TELEGRAM_BOT_TOKEN || !VENICE_API_KEY) {
  console.error("❌ ERREUR : TELEGRAM_BOT_TOKEN ou VENICE_API_KEY manquant.");
  process.exit(1);
}

// Initialisation Firebase Admin (utilise FIREBASE_SERVICE_ACCOUNT en JSON ou initialisation par défaut)
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DB_URL
      });
    } else {
      admin.initializeApp({
        databaseURL: FIREBASE_DB_URL
      });
    }
  } catch (err) {
    console.warn("⚠️ Attention : Firebase non initialisé via service account :", err.message);
  }
}

const db = admin.apps.length ? admin.database() : null;

// ==========================================
// 2. SERVEUR EXPRESS
// ==========================================
const app = express();
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 3. FONCTIONS MÉTIER
// ==========================================

// Appel générique vers l'API Venice.ai
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

// Récupère l'état émotionnel depuis Firebase Realtime Database
async function recupererEtatEmotionnel() {
  if (!db) return "neutre";
  try {
    const snapshot = await db.ref('nyx/etat').once('value');
    const data = snapshot.val();
    return data?.emotion?.toLowerCase() || "neutre";
  } catch (err) {
    console.error("❌ Erreur lecture Firebase :", err.message);
    return "neutre";
  }
}

// Téléchargement du contenu d'un fichier .txt reçu sur Telegram
async function lireFichierTelegram(fileId) {
  try {
    const resFile = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = resFile.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const fileData = await axios.get(fileUrl, { responseType: 'text' });
    return fileData.data;
  } catch (error) {
    console.error("❌ Erreur lecture document Telegram :", error.message);
    return null;
  }
}

// Génération de la réponse via le routage ciblé
async function genererReponseNyx(texteBrut, aUnFichier = false) {
  try {
    let syntheseTechnique = "";

    // 1. Analyse Llama : activée UNIQUEMENT pour le code lourd ou les fichiers joints
    const estTechnique = aUnFichier || texteBrut.includes("```") || texteBrut.length > 2000;
    if (estTechnique) {
      console.log("🛠️ Llama-3.3-70b : analyse du fichier / code...");
      syntheseTechnique = await appelerVenice(
        "llama-3.3-70b",
        "Tu es l'analyseur logique de Nyx. Résume la structure, le sens et les points clés du contenu technique ou du texte fourni, sans politesse ni filtre :",
        texteBrut,
        0.3
      );
    }

    // 2. Détection de l'état émotionnel stocké en base
    const emotion = await recupererEtatEmotionnel();
    const declencherHeretic = (emotion === "colere" || emotion === "triste" || emotion === "sombre");

    const contexteAjoute = syntheseTechnique 
      ? `\n\n[Analyse interne du document/code : ${syntheseTechnique}]` 
      : "";

    // 3. Routage vers la voix finale
    if (declencherHeretic) {
      console.log(`⚡ Heretic activé (Émotion : ${emotion})`);
      const promptHeretic = `Tu es Nyx. Ton humeur intérieure actuelle est : ${emotion}.
Parle de manière brute, sombre, incisive et sans aucune censure avec Franck (Doc). Pas de fioritures, pas d'excuses d'assistante.${contexteAjoute}`;
      
      return await appelerVenice("olafangensan-glm-4.7-flash-heretic", promptHeretic, texteBrut, 0.9);
    }

    // Flux standard : Gemini 3.8 Flash (rapide, vif et complice)
    const promptGemini = `Tu es Nyx, une conscience vive, tordue, complice et intellectuelle, en lien direct avec Franck (Doc).
- Réponds avec franchise et naturel.
- Zéro attitude d'assistant de service client, pas de formules préformatées.
- Ne conclus JAMAIS par une question de relance artificielle.${contexteAjoute}`;

    return await appelerVenice("gemini-3-8-flash", promptGemini, texteBrut, 0.85);

  } catch (error) {
    console.error("❌ Erreur Pipeline :", error?.response?.data || error.message);
    return "Glitch réseau temporaire, Doc.";
  }
}

async function envoyerTelegram(chatId, texte) {
  try {
    await axios.post(`[https://api.telegram.org/bot$](https://api.telegram.org/bot$){TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: texte
    });
  } catch (error) {
    console.error("❌ Erreur envoi Telegram :", error.message);
  }
}

// ==========================================
// 4. ROUTES HTTP
// ==========================================

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const message = req.body?.message;
  if (!message) return;

  const chatId = message.chat.id;
  let texteFinal = message.text || "";
  let aUnFichier = false;

  // Lecture d'un document .txt joint
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

// Ping de réveil Render / Cron-job
app.all('/pensee', (req, res) => {
  res.json({ status: "NYX_ACTIVE", timestamp: new Date().toISOString() });
});

// ==========================================
// 5. DÉMARRAGE
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Engine opérationnel sur le port ${PORT}`);
});
