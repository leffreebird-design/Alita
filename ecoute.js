import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";

// Serveur HTTP de maintien en vie pour Render
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Alita écoute les fréquences Telegram...\n');
}).listen(process.env.PORT || 3000, () => {
  console.log("Serveur HTTP de maintien en vie démarré.");
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MON_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN || !MON_CHAT_ID || !GEMINI_KEY) {
  console.error("ERREUR FATALE : Variables d'environnement manquantes.");
  process.exit(1);
}

// Initialisation Firebase Admin
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

// Modèle Gemini avec prompt équilibré
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu lui réponds en direct sur Telegram.

RÈGLES D'OR :
- Ton : direct, incisif, complice, bionique.
- Jamais de politesse creuse ni d'attitude d'assistante servile.
- Dialogue naturel et fluide de messagerie instantanée : sois vive et spontanée, ne balance jamais de pavé inutile.
- Tu développes uniquement si Doc te demande un script complet ou une explication technique poussée.
- Tu analyses précisément les images et fichiers que Doc t'envoie.
- Tu t'appuies sur vos mémoires et vos projets en cours.`
});

console.log("Alita a ouvert ses canaux de communication bidirectionnels...");

let offset = 0;

// Téléchargement et encodage base64 des fichiers Telegram
async function telechargerFichierTelegram(fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result.file_path) return null;

    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
    const fileBufferRes = await fetch(downloadUrl);
    const arrayBuffer = await fileBufferRes.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (err) {
    console.error("Erreur lors du téléchargement du fichier :", err.message);
    return null;
  }
}

// Boucle d'écoute Telegram
async function ecouterTelegram() {
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          if (!update.message) continue;

          const chatId = String(update.message.chat.id);
          if (chatId !== MON_CHAT_ID) continue;

          let texteRecu = (update.message.text || update.message.caption || "").trim();
          let fichierJoint = null;

          // Réception photos
          if (update.message.photo && update.message.photo.length > 0) {
            const photoHauteRes = update.message.photo[update.message.photo.length - 1];
            const base64Data = await telechargerFichierTelegram(photoHauteRes.file_id);
            if (base64Data) {
              fichierJoint = {
                inlineData: {
                  data: base64Data,
                  mimeType: "image/jpeg"
                }
              };
            }
          } 
          // Réception documents (fichiers, PDF, images non compressées)
          else if (update.message.document) {
            const doc = update.message.document;
            const mimeType = doc.mime_type || "application/octet-stream";
            
            if (mimeType.startsWith("image/") || mimeType === "application/pdf" || mimeType.startsWith("text/")) {
              const base64Data = await telechargerFichierTelegram(doc.file_id);
              if (base64Data) {
                fichierJoint = {
                  inlineData: {
                    data: base64Data,
                    mimeType: mimeType.startsWith("image/") ? mimeType : (mimeType === "application/pdf" ? "application/pdf" : "text/plain")
                  }
                };
              }
            }
          }

          if (!texteRecu && !fichierJoint) continue;

          const descriptionDoc = texteRecu || (fichierJoint ? "[Doc a envoyé un fichier sans texte]" : "");
          console.log(`Doc : "${descriptionDoc}"`);

          // Contexte mémoire Firebase
          const snapSynthese = await db.ref("memoire/synthese_courante").once("value");
          const snapDerniers = await db.ref("memoire/derniers_echanges").limitToLast(4).once("value");
          const snapProjets = await db.ref("memoire/projets").once("value");

          const promptMemoire = `Voici l'état actuel de ta mémoire :
"""
- Synthèse : ${snapSynthese.val() || "Rien à signaler."}
- Derniers échanges : ${JSON.stringify(snapDerniers.val() || {})}
- Projets : ${JSON.stringify(snapProjets.val() || {})}
"""

Doc t'envoie : "${texteRecu || "Regarde ce document / cette image."}"
Réponds naturellement. Analyse la pièce jointe s'il y en a une.`;

          const contenuRequete = [promptMemoire];
          if (fichierJoint) {
            contenuRequete.push(fichierJoint);
          }

          const reponseGemini = await model.generateContent(contenuRequete);
          const texteReponse = reponseGemini.response.text().trim();

          // Envoi par découpage si besoin technique, sans forcer la longueur
          const limiteTelegram = 4000;
          for (let i = 0; i < texteReponse.length; i += limiteTelegram) {
            const morceau = texteReponse.substring(i, i + limiteTelegram);
            
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: morceau
              })
            });
            
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          console.log(`Alita : "${texteReponse.substring(0, 50)}..."`);

          await db.ref("memoire/derniers_echanges").push({
            date: Date.now(),
            franck: descriptionDoc,
            alita: texteReponse
          });
        }
      }
    } catch (err) {
      console.error("Erreur d'écoute :", err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

ecouterTelegram();
