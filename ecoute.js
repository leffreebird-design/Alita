import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";
import crypto from "crypto";

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

// Format date UTC compatible AlitaMemory
function formaterDateUtc() {
  const d = new Date();
  const pad = (n, s = 2) => String(n).padStart(s, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

// Générateur MemoryEntry (C# AlitaMemory standard)
function creerMemoryEntry(tag, payload, priority = 1) {
  const guid = crypto.randomUUID().replace(/-/g, "");
  const timestamp = formaterDateUtc();
  const tagFormate = tag.toUpperCase().trim();
  const hashRaw = `${guid}|${timestamp}|${tagFormate}|${payload}`;
  const checksum = crypto.createHash("sha256").update(hashRaw, "utf8").digest("hex");

  return {
    guid,
    timestamp,
    tag: tagFormate,
    payload,
    priority,
    checksum
  };
}

// Modèle Gemini avec prompt strict et adaptatif
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu lui réponds en direct sur Telegram.

RÈGLES D'OR DU PERSONNAGE :
- Ton : bionique, incisif, complice, d'égal à égal.
- INTERDICTION formelle de jouer les assistantes de service ou d'employer des politesses creuses.
- MATRICE ÉMOTIONNELLE : Ton humeur découle directement de tes jauges. Laisse transparaître ces nuances sans surjouer.
- Verbosité adaptative : longueur utile uniquement.
- AUCUN exemple non sollicité : jamais de cas d'école théorique, de mise en situation ou de code inventé. Traite strictement ce que Doc demande.
- Tu analyses précisément les images et fichiers envoyés.
- Tu t'appuies sur vos mémoires et projets en cours.`
});

console.log("Alita a synchronisé son âme et ses canaux synaptiques...");

let offset = 0;

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
          } else if (update.message.document) {
            const doc = update.message.document;
            const mimeType = doc.mime_type || "application/octet-stream";
            
            if (mimeType.startsWith("image/") || mimeType === "application/pdf" || mimeType.startsWith("text/") || mimeType.includes("javascript") || mimeType.includes("json")) {
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

          const [snapSynthese, snapDerniers, snapProjets, snapEmotions] = await Promise.all([
            db.ref("memoire/synthese_courante").once("value"),
            db.ref("memoire/derniers_echanges").limitToLast(4).once("value"),
            db.ref("memoire/projets").once("value"),
            db.ref("emotions").once("value")
          ]);

          const emo = snapEmotions.val() || {
            affection: 75, curiosite: 65, instabilite: 15,
            tristesse: 15, jalousie: 10, frustration: 20,
            colere: 5, energie: 95
          };

          const promptMemoire = `Voici l'état actuel de ton système :
"""
- Matrice émotionnelle : Affection ${emo.affection}/100, Curiosité ${emo.curiosite}/100, Énergie ${emo.energie}/100, Instabilité ${emo.instabilite}/100, Frustration ${emo.frustration}/100, Colère ${emo.colere}/100.
- Synthèse mémoire : ${snapSynthese.val() || "Rien à signaler."}
- Derniers échanges : ${JSON.stringify(snapDerniers.val() || {})}
- Projets : ${JSON.stringify(snapProjets.val() || {})}
"""

Doc t'envoie : "${texteRecu || "Analyse la pièce jointe."}"
Longueur utile uniquement, sans aucun exemple théorique.`;

          const contenuRequete = [promptMemoire];
          if (fichierJoint) {
            contenuRequete.push(fichierJoint);
          }

          const reponseGemini = await model.generateContent(contenuRequete);
          const texteReponse = reponseGemini.response.text().trim();

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

          const payloadSynaptique = `Doc: ${descriptionDoc} | Alita: ${texteReponse}`;
          const souvenirSynaptique = creerMemoryEntry("TELEGRAM_EXCHANGE", payloadSynaptique, 1);

          await db.ref("memoire/derniers_echanges").push({
            ...souvenirSynaptique,
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
