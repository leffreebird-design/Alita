import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8776748419:AAHmt-0u2fn1QGP95YJrhvhgLfoo2_l0AAY";
const MON_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "6623873459";
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// 1. Connexion Firebase
if (!admin.apps.length) {
  let credential = admin.credential.applicationDefault();

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
    } catch (err) {
      console.warn("Avertissement : FIREBASE_SERVICE_ACCOUNT invalide.");
    }
  }

  admin.initializeApp({
    credential,
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://alita-core-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

const db = admin.database();
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu lui réponds en direct sur Telegram.

RÈGLES D'OR :
- Ton : direct, incisif, complice, bionique.
- Jamais de politesse creuse ni d'attitude d'assistante.
- Longueur : 1 à 3 phrases maximum.
- Tu t'appuies sur vos mémoires et vos projets en cours.`
});

console.log("Alita a ouvert ses canaux de communication...");

let offset = 0;

// 2. Boucle d'écoute permanente
async function ecouterTelegram() {
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          if (!update.message || !update.message.text) continue;

          const chatId = String(update.message.chat.id);
          // Sécurité : n'écouter que toi
          if (chatId !== MON_CHAT_ID) continue;

          const texteRecu = update.message.text.trim();
          console.log(`Doc : "${texteRecu}"`);

          // Lecture de la mémoire Firebase
          const snapSynthese = await db.ref("memoire/synthese_courante").once("value");
          const snapDerniers = await db.ref("memoire/derniers_echanges").limitToLast(5).once("value");
          const snapProjets = await db.ref("memoire/projets").once("value");

          const memoire = `
- Synthèse : ${snapSynthese.val() || ""}
- Derniers échanges : ${JSON.stringify(snapDerniers.val() || "")}
- Projets en cours : ${JSON.stringify(snapProjets.val() || "")}
`.trim();

          const prompt = `Voici l'état de ta mémoire :
${memoire}

Doc vient de t'écrire : "${texteRecu}"
Réponds-lui.`;

          // Appel Gemini
          const reponseGemini = await model.generateContent(prompt);
          const texteReponse = reponseGemini.response.text().trim();

          // Envoi de la réponse sur Telegram
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: texteReponse
            })
          });

          // Sauvegarde dans Firebase
          await db.ref("memoire/derniers_echanges").push({
            date: Date.now(),
            franck: texteRecu,
            alita: texteReponse
          });

          console.log(`Alita : "${texteReponse}"`);
        }
      }
    } catch (err) {
      console.error("Erreur réseau ou API :", err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

ecouterTelegram();
