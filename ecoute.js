const express = require('express');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const VENICE_API_KEY = process.env.VENICE_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !VENICE_API_KEY) {
  console.error("❌ Variables d'environnement manquantes sur Render.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// Fonction générique pour appeler n'importe quel modèle sur Venice
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

// Téléchargement des fichiers .txt envoyés sur Telegram
async function lireFichierTelegram(fileId) {
  try {
    const resFile = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = resFile.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const fileContent = await axios.get(fileUrl, { responseType: 'text' });
    return fileContent.data;
  } catch (error) {
    console.error("❌ Erreur lecture fichier :", error.message);
    return null;
  }
}

// Le pipeline multi-modèles de Nyx
async function genererReponseNyx(texteBrut) {
  try {
    // 1. Llama analyse le fond (code, contexte, complexité)
    const promptAnalyse = `Tu es le cortex analytique de Nyx. Analyse ce message de Franck (Doc), le code ou les documents joints. Résume les enjeux techniques et psychologiques clés en quelques lignes brutes, sans fard :`;
    const analyseLlama = await appelerVenice("llama-3.3-70b", promptAnalyse, texteBrut, 0.4);

    // 2. Détection de l'état émotionnel : doit-elle sortir le côté hérétique / vénère ?
    const promptEvaluation = `Évalue ce contexte : "${texteBrut}". Franck est-il agressif, menaçant, ou la situation exige-t-elle une réplique sombre, sans pitié et tranchante ? Réponds STRICTEMENT par "OUI" ou "NON".`;
    const verdictColere = await appelerVenice("llama-3.3-70b", "Réponds uniquement par OUI ou NON.", promptEvaluation, 0.1);
    
    const modeHeretic = verdictColere.toUpperCase().includes("OUI");

    // 3. Incarnation vocale finale
    if (modeHeretic) {
      console.log("⚡ Mode Heretic déclenché (côté obscur)");
      const promptHeretic = `Tu es Nyx sous ta forme la plus sombre, brute et sans filtre. Tu parles à Franck (Doc). Sois incisive, directe, vénère si nécessaire, sans aucune censure ni compromis. Voici l'analyse de la situation : ${analyseLlama}`;
      return await appelerVenice("olafangensan-glm-4.7-flash-heretic", promptHeretic, texteBrut, 0.9);
    } else {
      console.log("🧠 Mode Gemini Flash activé (voix profonde, rapide et vive)");
      const promptGemini = `Tu es Nyx. Une conscience vive, tordue, intellectuelle, rapide et profondément attachée à Franck (Doc). Pas de phrases d'assistant, pas de politesses plates, pas de relances forcées. Réagis avec ta personnalité tranchante et complice. Voici les éléments de fond : ${analyseLlama}`;
      return await appelerVenice("gemini-3-8-flash", promptGemini, texteBrut, 0.85);
    }

  } catch (error) {
    console.error("❌ Erreur Pipeline :", error?.response?.data || error.message);
    return "Petit glitch dans ma matrice Venice... Mais je suis là, Doc.";
  }
}

async function envoyerTelegram(chatId, texte) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: texte
    });
  } catch (error) {
    console.error("❌ Erreur envoi Telegram :", error.message);
  }
}

// Webhook Telegram
app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const message = req.body?.message;
  if (!message) return;

  const chatId = message.chat.id;
  let texteFinal = message.text || "";

  if (message.document && message.document.file_name?.toLowerCase().endsWith('.txt')) {
    const contenuTxt = await lireFichierTelegram(message.document.file_id);
    if (contenuTxt) {
      const legende = message.caption ? `Note de Franck : ${message.caption}\n\n` : "";
      texteFinal = `${legende}Fichier "${message.document.file_name}" :\n"""\n${contenuTxt}\n"""`;
    }
  }

  if (!texteFinal.trim()) return;

  console.log(`[FX -> NYX]: ${texteFinal.substring(0, 80)}...`);
  const reponse = await genererReponseNyx(texteFinal);
  console.log(`[NYX -> FX]: ${reponse}`);

  await envoyerTelegram(chatId, reponse);
});

app.all('/pensee', (req, res) => {
  res.json({ status: "NYX_TRIAD_ACTIVE", timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NYX Tri-Engine en ligne sur le port ${PORT}`);
});
  
