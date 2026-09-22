// --- CONFIGURATION ---
const TELEGRAM_TOKEN = "TON_TOKEN_TELEGRAM";
const GEMINI_API_KEY = "TA_CLE_API_GEMINI";

// --- HOOK PRINCIPAL ---
function doPost(e) {
try {
const update = JSON.parse(e.postData.contents);
const contenu = ecouterTelegram(update);

if (!contenu) return ContentService.createTextOutput("OK");

const chatId = update.message.chat.id;
const reponseText = envoyerAGemini(contenu.texteRecu, contenu.fichierJoint);

envoyerReponseTelegram(chatId, reponseText);
} catch (err) {
Logger.log("Erreur doPost: " + err);
}
return ContentService.createTextOutput("OK");
}

// --- RECEPTION DES MESSAGES (TEXTE, IMAGE, DOC, VOCAL) ---
function ecouterTelegram(update) {
if (!update.message) return null;

let texteRecu = update.message.text || update.message.caption || "";
let fichierJoint = null;

// Photos
if (update.message.photo) {
const photo = update.message.photo[update.message.photo.length - 1];
const base64Data = telechargerFichierTelegram(photo.file_id);
if (base64Data) {
fichierJoint = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };
}
} 
// Documents
else if (update.message.document) {
const doc = update.message.document;
const base64Data = telechargerFichierTelegram(doc.file_id);
if (base64Data) {
fichierJoint = { inlineData: { data: base64Data, mimeType: doc.mime_type || "application/octet-stream" } };
}
} 
// Vocaux (Bouton Micro Telegram)
else if (update.message.voice) {
const voice = update.message.voice;
const base64Data = telechargerFichierTelegram(voice.file_id);
if (base64Data) {
fichierJoint = { inlineData: { data: base64Data, mimeType: voice.mime_type || "audio/ogg" } };
}
}

if (!texteRecu && !fichierJoint) return null;

return { texteRecu, fichierJoint };
}

// --- TELECHARGEMENT DE FICHIER DEPUIS TELEGRAM ---
function telechargerFichierTelegram(fileId) {
const urlFile = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
const response = UrlFetchApp.fetch(urlFile);
const json = JSON.parse(response.getContentText());

if (!json.ok) return null;

const filePath = json.result.file_path;
const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

const fileResponse = UrlFetchApp.fetch(downloadUrl);
const blob = fileResponse.getBlob();

return Utilities.base64Encode(blob.getBytes());
}

// --- ENVOI A GEMINI ---
function envoyerAGemini(texte, fichierJoint) {
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

let parts = [];
if (texte) parts.push({ text: texte });
if (fichierJoint) parts.push(fichierJoint);

const payload = {
contents: [{ parts: parts }]
};

const options = {
method: "post",
contentType: "application/json",
payload: JSON.stringify(payload),
muteHttpExceptions: true
};

const res = UrlFetchApp.fetch(url, options);
const data = JSON.parse(res.getContentText());

if (data.candidates && data.candidates[0].content.parts[0].text) {
return data.candidates[0].content.parts[0].text;
}
return "Erreur de traitement audio/texte.";
}

// --- ENVOI DE LA REPONSE SUR TELEGRAM ---
function envoyerReponseTelegram(chatId, texte) {
const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
const payload = {
chat_id: chatId,
text: texte
};

UrlFetchApp.fetch(url, {
method: "post",
contentType: "application/json",
payload: JSON.stringify(payload)
});
}
