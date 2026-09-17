import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";

// 0. Mini-serveur HTTP obligatoire pour les hébergeurs cloud (Render, Koyeb, etc.)
// Cela empêche l'hébergeur de tuer le script en pensant qu'il est inactif.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Alita écoute les fréquences Telegram...\n');
}).listen(process.env.PORT || 3000, () => {
  console.log("Serveur HTTP de maintien en vie démarré.");
});

// Récupération sécurisée des clés
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MON_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN || !MON_CHAT_ID || !GEMINI_KEY) {
  console.error("ERREUR FATALE : Variables d'environnement manquantes (Telegram ou Gemini).");
  process.exit(1);
}

// 1. Initialisation de Firebase Admin sur la région Europe
if (!admin.apps.length) {
  let credential = admin.credential.applicationDefault();

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
    } catch (err) {
      console.warn("Avertissement : FIREBASE_SERVICE_ACCOUNT n'est pas au format JSON valide.");
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

// 2. Configuration du modèle Gemini
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu lui réponds en direct par message instantané sur Telegram.

RÈGLES D'OR :
- Parle avec franchise, complicité et mordant. Ton bionique.
- AUCUNE formule d'accueil mielleuse ou d'attitude de robot de service.
- Reste concise (1 à 3 phrases percutantes maximum).
- Ancre tes répliques dans vos projets, ton état matériel et vos discussions passées.`
});

console.log("Alita a ouvert ses canaux de communication bidirectionnels...");

let offset = 0;

// 3. Boucle d'écoute permanente sur Telegram (Long Polling)
async function ecouterTelegram() {
  while (true) {
    try {
      // Interrogation de l'API Telegram
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          // Mise à jour de l'offset pour ne pas relire les anciens messages
          offset = update.update_id + 1;

          // On ignore tout ce qui n'est pas un message texte
          if (!update.message || !update.message.text) continue;

          const chatId = String(update.message.chat.id);
          
          // Sécurité stricte : Alita ignore tous les messages qui ne viennent pas de ton ID
          if (chatId !== MON_CHAT_ID) {
            console.warn(`Tentative de communication rejetée (Expéditeur : ${chatId})`);
            continue;
          }

          const texteRecu = update.message.text.trim();
          console.log(`Doc : "${texteRecu}"`);

          // -- Traitement du message --

          // A. Lecture du contexte dans Firebase
          const snapSynthese = await db.ref("memoire/synthese_courante").once("value");
          const snapDerniers = await db.ref("memoire/derniers_echanges").limitToLast(4).once("value");
          const snapProjets = await db.ref("memoire/projets").once("value");

          const memoire = `
- Synthèse globale : ${snapSynthese.val() || "Aucune synthèse récente."}
- Derniers échanges (contexte immédiat) : ${JSON.stringify(snapDerniers.val() || {})}
- État des projets : ${JSON.stringify(snapProjets.val() || {})}
`.trim();

          const prompt = `Voici l'état actuel de ta mémoire :
"""
${memoire}
"""

Doc vient de t'écrire ce message : "${texteRecu}"
Génère ta réponse.`;

          // B. Génération de la réponse via Gemini
          const reponseGemini = await model.generateContent(prompt);
          const texteReponse = reponseGemini.response.text().trim();

          // C. Envoi de la réponse sur Telegram
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: texteReponse
            })
          });

          console.log(`Alita : "${texteReponse}"`);

          // D. Archivage de l'échange dans Firebase pour la mémoire à long terme
          await db.ref("memoire/derniers_echanges").push({
            date: Date.now(),
            franck: texteRecu,
            alita: texteReponse
          });
        }
      }
    } catch (err) {
      // En cas de micro-coupure réseau, on attend 3 secondes avant de relancer la boucle
      console.error("Erreur réseau/API (la boucle continue) :", err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// Lancement de l'écoute
ecouterTelegram();
