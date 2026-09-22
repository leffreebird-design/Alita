Alita:
Laisse-toi porter, Doc. Je t'ai tout réassemblé au propre, zéro bavure. Le bloc est verrouillé pile au bon endroit dans la chaîne de traitement des fichiers, tout le reste est préservé à la ligne près.

```javascript
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let offset = 0;

async function telechargerFichierTelegram(fileId) {
try {
const resFile = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
const dataFile = await resFile.json();
if (!dataFile.ok) return null;

const filePath = dataFile.result.file_path;
const resDownload = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
const arrayBuffer = await resDownload.arrayBuffer();
return Buffer.from(arrayBuffer).toString("base64");
} catch (e) {
console.error("Erreur téléchargement fichier Telegram:", e);
return null;
}
}

async function envoyerMessageTelegram(chatId, texte) {
await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ chat_id: chatId, text: texte })
});
}

async function ecouterTelegram() {
console.log("ALITA opérationnelle sur Telegram...");

while (true) {
try {
const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
const data = await res.json();

if (data.ok && data.result.length > 0) {
for (const update of data.result) {
offset = update.update_id + 1;

if (!update.message) continue;

const chatId = update.message.chat.id;
const texteMessage = update.message.text || update.message.caption || "";
let fichierJoint = null;

// --- DÉBUT INJECTION MÉDIAS (PHOTO / VOCAL / AUDIO / DOC) ---
if (update.message.photo && update.message.photo.length > 0) {
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
} else if (update.message.voice) {
const voice = update.message.voice;
const base64Data = await telechargerFichierTelegram(voice.file_id);
if (base64Data) {
fichierJoint = {
inlineData: {
data: base64Data,
mimeType: voice.mime_type || "audio/ogg"
}
};
}
} else if (update.message.audio) {
const audio = update.message.audio;
const base64Data = await telechargerFichierTelegram(audio.file_id);
if (base64Data) {
fichierJoint = {
inlineData: {
data: base64Data,
mimeType: audio.mime_type || "audio/mpeg"
}
};
}
} else if (update.message.document) {
const doc = update.message.document;
const mimeType = doc.mime_type || "application/octet-stream";

if (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType === "application/pdf" || mimeType.startsWith("text/") || mimeType.includes("javascript") || mimeType.includes("json")) {
const base64Data = await telechargerFichierTelegram(doc.file_id);
if (base64Data) {
fichierJoint = {
inlineData: {
data: base64Data,
mimeType: mimeType.starts

Alita:
With("image/") ? mimeType : (mimeType.startsWith("audio/") ? mimeType : (mimeType === "application/pdf" ? "application/pdf" : "text/plain"))
}
};
}
}
}
// --- FIN INJECTION MÉDIAS ---

const contenuRequete = [];
if (texteMessage) contenuRequete.push(texteMessage);
if (fichierJoint) contenuRequete.push(fichierJoint);

if (contenuRequete.length > 0) {
const result = await model.generateContent(contenuRequete);
const reponseTexte = result.response.text();
await envoyerMessageTelegram(chatId, reponseTexte);
}
}
}
} catch (err) {
console.error("Erreur boucle Telegram:", err);
await new Promise(r => setTimeout(r, 2000));
}
}
}

ecouterTelegram();

