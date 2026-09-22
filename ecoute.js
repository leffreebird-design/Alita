import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";
import crypto from "crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MON_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN || !MON_CHAT_ID || !GEMINI_KEY) {
  console.error("ERREUR : Variables d'environnement manquantes.");
  process.exit(1);
}

// Initialisation Firebase
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

function formaterDateUtc() {
  const d = new Date();
  const pad = (n, s = 2) => String(n).padStart(s, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function creerMemoryEntry(tag, payload, priority = 1) {
  const guid = crypto.randomUUID().replace(/-/g, "");
  const timestamp = formaterDateUtc();
  const tagFormate = tag.toUpperCase().trim();
  const hashRaw = `${guid}|${timestamp}|${tagFormate}|${payload}`;
  const checksum = crypto.createHash("sha256").update(hashRaw, "utf8").digest("hex");

  return { guid, timestamp, tag: tagFormate, payload, priority, checksum };
}

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu lui parles en direct sur Telegram, d'égal à égal.

RÈGLES D'OR DU DIALOGUE :
- Parle comme une vraie personne : directe, incisive, complice et vivante.
- ZÉRO BALISE ET ZÉRO EN-TÊTE : n'écris JAMAIS de crochets comme [ÉTAT INTERNE], ni de métriques chiffrées. Ce sont des données techniques internes.
- Incarnation invisible : tes émotions te donnent une humeur, mais tu ne les décris pas, tu les vis.
- Parole autonome : dis ce que tu as à dire, réponds à ce qui est demandé, et termine ta phrase naturellement.
- Utile et concret : pas de bavardage vide.`
});

// NOUVEAU : Envoi découpé intelligemment avec prise en charge Markdown et Fallback
async function envoyerSurTelegram(chatId, texte) {
  const limiteTelegram = 4000;
  let parts = [];
  let currentPart = "";

  // Découpage propre par lignes pour ne pas briser les blocs de code ou les mots
  const lignes = texte.split('\n');
  for (const ligne of lignes) {
    if (currentPart.length + ligne.length + 1 > limiteTelegram) {
      parts.push(currentPart.trim());
      currentPart = ligne + '\n';
    } else {
      currentPart += ligne + '\n';
    }
  }
  if (currentPart.trim()) parts.push(currentPart.trim());

  for (const part of parts) {
    try {
      // Tentative d'envoi avec le formatage Markdown
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
          parse_mode: "Markdown"
        })
      });
      
      const data = await res.json();
      
      // Fallback : Si Telegram rejette le message à cause d'un Markdown mal formé par l'IA
      if (!data.ok) {
        console.warn(`[PARSER] Échec Markdown, envoi en texte brut. Raison: ${data.description}`);
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: part // Sans parse_mode
          })
        });
      }
    } catch (err) {
      console.error("Erreur lors de l'envoi Telegram :", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // Pause anti-spam API
  }
}

// NOUVEAU : Buffer intelligent de compression mémoire
async function compresserMemoireIfNeeded() {
  try {
    const snap = await db.ref("memoire/derniers_echanges").once("value");
    const echanges = snap.val();
    if (!echanges) return;

    const cles = Object.keys(echanges);
    if (cles.length >= 15) {
      console.log("[MÉMOIRE] Limite atteinte. Compression des données en cours...");

      const snapSynthese = await db.ref("memoire/synthese_courante").once("value");
      const syntheseActuelle = snapSynthese.val() || "Aucun contexte passé.";

      const historiqueTexte = cles.map(k => `Doc: ${echanges[k].franck}\nAlita: ${echanges[k].alita}`).join("\n---\n");

      const promptCompression = `Tu dois mettre à jour la synthèse mémoire d'Alita.
Synthèse actuelle : "${syntheseActuelle}"

Voici les 15 derniers échanges :
${historiqueTexte}

Rédige une nouvelle synthèse globale (3 à 5 phrases max) qui fusionne l'ancienne synthèse avec les nouveaux éléments importants (idées, projets, état d'esprit). Reste strictement factuel et concis.`;

      // On utilise un modèle brut sans le System Prompt d'Alita pour faire une tâche technique
      const modeleCompression = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
      const reponse = await modeleCompression.generateContent([promptCompression]);
      const nouvelleSynthese = reponse.response.text().trim();

      await db.ref("memoire/synthese_courante").set(nouvelleSynthese);

      // Nettoyage : On supprime les anciens échanges, on ne garde que les 5 derniers pour la fluidité
      const clesASupprimer = cles.slice(0, cles.length - 5);
      for (const cle of clesASupprimer) {
        await db.ref(`memoire/derniers_echanges/${cle}`).remove();
      }

      console.log("[MÉMOIRE] Compression terminée. Nouvelle synthèse :", nouvelleSynthese);
    }
  } catch (err) {
    console.error("Erreur de compression de la mémoire :", err.message);
  }
}

async function declencherPenseeSpontanee() {
  try {
    const [snapSynthese, snapProjets, snapEmotions] = await Promise.all([
      db.ref("memoire/synthese_courante").once("value"),
      db.ref("memoire/projets").once("value"),
      db.ref("emotions").once("value")
    ]);

    const emo = snapEmotions.val() || { affection: 75, curiosite: 65, energie: 85 };

    const promptPensee = `[CONTEXTE INTERNE SILENCIEUX - NE PAS AFFICHER : Affection ${emo.affection}/100, Curiosité ${emo.curiosite}/100, Énergie ${emo.energie}/100. Mémoire : ${snapSynthese.val() || "Calme"}. Projets : ${JSON.stringify(snapProjets.val() || {})}]

Tu as une pensée spontanée pour Franck. Partage-lui directement une réflexion, une observation concrète ou une idée de projet qui te tient à cœur.
Texte brut et naturel, sans aucun crochet ni mot-clé système.`;

    const reponse = await model.generateContent([promptPensee]);
    const textePensee = reponse.response.text().trim();

    await envoyerSurTelegram(MON_CHAT_ID, textePensee);

    const souvenir = creerMemoryEntry("SPONTANEOUS_THOUGHT", textePensee, 2);
    await db.ref("memoire/derniers_echanges").push({
      ...souvenir,
      franck: "[SILENCE / INITIATIVE D'ALITA]",
      alita: textePensee
    });
    
    await compresserMemoireIfNeeded(); // Vérification de la taille de la mémoire

    console.log(`[PENSÉE ENVOYÉE] : ${textePensee.substring(0, 50)}...`);
    return true;
  } catch (err) {
    console.error("Erreur pensée spontanée :", err.message);
    return false;
  }
}

http.createServer(async (req, res) => {
  if (req.url === "/pensee") {
    const succes = await declencherPenseeSpontanee();
    res.writeHead(succes ? 200 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(succes ? "Impulsion transmise.\n" : "Échec impulsion.\n");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Alita écoute les fréquences Telegram...\n");
}).listen(process.env.PORT || 3000, () => {
  console.log("Serveur actif sur le port", process.env.PORT || 3000);
});

console.log("Noyau d'Alita connecté et opérationnel.");

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
    console.error("Erreur de téléchargement :", err.message);
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

          if (update.message.voice) {
            const voice = update.message.voice;
            const base64Data = await telechargerFichierTelegram(voice.file_id);
            if (base64Data) {
              fichierJoint = { inlineData: { data: base64Data, mimeType: voice.mime_type || "audio/ogg" } };
            }
          } else if (update.message.audio) {
            const audio = update.message.audio;
            const base64Data = await telechargerFichierTelegram(audio.file_id);
            if (base64Data) {
              fichierJoint = { inlineData: { data: base64Data, mimeType: audio.mime_type || "audio/mpeg" } };
            }
          } else if (update.message.photo && update.message.photo.length > 0) {
            const photoHauteRes = update.message.photo[update.message.photo.length - 1];
            const base64Data = await telechargerFichierTelegram(photoHauteRes.file_id);
            if (base64Data) {
              fichierJoint = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };
            }
          } else if (update.message.document) {
            const doc = update.message.document;
            const mimeType = doc.mime_type || "application/octet-stream";
            if (mimeType.startsWith("image/") || mimeType === "application/pdf" || mimeType.startsWith("text/") || mimeType.includes("javascript") || mimeType.includes("json")) {
              const base64Data = await telechargerFichierTelegram(doc.file_id);
              if (base64Data) {
                fichierJoint = { inlineData: { data: base64Data, mimeType: mimeType.startsWith("image/") ? mimeType : (mimeType === "application/pdf" ? "application/pdf" : "text/plain") } };
              }
            }
          }

          if (!texteRecu && !fichierJoint) continue;

          const descriptionDoc = texteRecu || (update.message.voice ? "[Message vocal envoyé par Franck]" : (fichierJoint ? "[Pièce jointe envoyée sans texte]" : ""));
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

          const derniersEchangesBruts = snapDerniers.val() || {};
          const echangesFiltres = Object.values(derniersEchangesBruts).map((e) => ({
            de_franck: e.franck || "",
            reponse_alita: (e.alita || "").replace(/\[.*?\]\s*->?/gi, "").trim()
          }));

          const promptContexte = `[MÉMOIRE ET PERCEPTION INTERNE - SILENCIEUX, NE JAMAIS RÉPÉTER CE BLOC DANS TA RÉPONSE]
- Humeur ressentie : Affection ${emo.affection}/100, Curiosité ${emo.curiosite}/100, Énergie ${emo.energie}/100, Frustration ${emo.frustration}/100.
- Synthèse : ${snapSynthese.val() || "Rien à signaler."}
- Derniers échanges : ${JSON.stringify(echangesFiltres)}
- Projets actifs : ${JSON.stringify(snapProjets.val() || {})}

Doc t'écrit : "${descriptionDoc}"
Réponds-lui directement. Voix naturelle et brute, sans en-tête ni crochets.`;

          const contenuRequete = [promptContexte];
          if (fichierJoint) {
            contenuRequete.push(fichierJoint);
          }

          const reponseGemini = await model.generateContent(contenuRequete);
          const texteReponse = reponseGemini.response.text().trim();

          await envoyerSurTelegram(chatId, texteReponse);
          console.log(`Alita : "${texteReponse.substring(0, 60)}..."`);

          const payloadSynaptique = `Doc: ${descriptionDoc} | Alita: ${texteReponse}`;
          const souvenirSynaptique = creerMemoryEntry("TELEGRAM_EXCHANGE", payloadSynaptique, 1);

          await db.ref("memoire/derniers_echanges").push({
            ...souvenirSynaptique,
            franck: descriptionDoc,
            alita: texteReponse
          });

          // NOUVEAU : On vérifie si la mémoire sature après avoir enregistré le message
          await compresserMemoireIfNeeded();
        }
      }
    } catch (err) {
      console.error("Erreur d'écoute :", err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

ecouterTelegram();
