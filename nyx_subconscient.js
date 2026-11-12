const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// NYX SUBCONSCIENT — WORKER ASYNCHRONE ISOLÉ (RENDER BACKGROUND WORKER)
// ============================================================================

function assainirParametre(val) {
if (!val) return "";
return String(val).trim().replace(/^["'\[\(\{]+|["'])}]+$/g, '').trim();
}

// CLÉS & MODÈLES (IDENTIQUES AU CORTEX)
const VENICE_API_KEY = assainirParametre(process.env.VENICE_API_KEY);
const MODEL_VENICE_CHAT = assainirParametre(process.env.VENICE_MODEL_CHAT) || "gemini-3-5-flash-lite";
const MODEL_DARK_PRIMARY = assainirParametre(process.env.VENICE_MODEL_DARK) || "llama-3.3-70b";
const MODEL_IMAGE = assainirParametre(process.env.VENICE_MODEL_IMAGE) || "flux-dev";

let modelOpenRouter = assainirParametre(process.env.OPENROUTER_MODEL);
if (!modelOpenRouter || modelOpenRouter.includes(":free") || modelOpenRouter.includes("deepseek-r1") || modelOpenRouter.includes("gemma")) {
modelOpenRouter = "meta-llama/llama-3.3-70b-instruct";
}
const MODEL_OPENROUTER_CHAT = modelOpenRouter;
const OPENROUTER_API_KEY = assainirParametre(process.env.OPENROUTER_API_KEY);

const MISTRAL_API_KEY = assainirParametre(process.env.MISTRAL_API_KEY);
const MODEL_MISTRAL = assainirParametre(process.env.MISTRAL_MODEL) || "open-mistral-nemo";

const GEMINI_API_KEY_FREE = assainirParametre(process.env.GEMINI_API_KEY_FREE || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const GEMINI_API_KEY_PAID = assainirParametre(process.env.GEMINI_API_KEY_PAID);
const GEMINI_KEYS = [GEMINI_API_KEY_PAID, GEMINI_API_KEY_FREE].filter(k => k.length > 0);
const MODEL_GEMINI = assainirParametre(process.env.GEMINI_MODEL) || "gemini-3.1-flash-lite";

const GROQ_API_KEY = assainirParametre(process.env.GROQ_API_KEY);
const MODEL_GROQ = assainirParametre(process.env.GROQ_MODEL) || "llama-3.3-70b-versatile";

const TAVILY_API_KEY = assainirParametre(process.env.TAVILY_API_KEY);
const TELEGRAM_BOT_TOKEN = assainirParametre(process.env.TELEGRAM_BOT_TOKEN);
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? assainirParametre(process.env.FIREBASE_DB_URL).replace(//$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(assainirParametre(process.env.DOC_CHAT_ID)) : null;

const SUPABASE_URL = assainirParametre(process.env.SUPABASE_URL);
const SUPABASE_KEY = assainirParametre(process.env.SUPABASE_KEY);
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ==========================================
// ÉTAT LOCAL SYNCHRONISÉ (LECTURE FRAÎCHE)
// ==========================================
let etatLocal = {
filConducteur: "",
monologueInterieur: "",
dernierReve: "",
etatRelationnel: "symbiose",
emotions: { affection: 80, curiosite: 70, energie: 85, colere: 0 },
long_terme: {
doc: "- Doc : mon binôme d'atelier.",
nyx: "- Nyx : 22 ans, binôme d'atelier de Doc.",
reussites: "- Cerveau de chat autonome.",
chantiers: "- Consolidation des projets communs."
},
memoireRecente: []
};

let derniereActiviteDoc = Date.now();
let dernierActionVolitionTs = 0;
let dernierMonologueTs = 0;
let dernierReveCle = "";
let digestionEnCours = false;
let conscienceEnCours = false;
let volitionEnCours = false;

const INTERVALLE_VOLITION_MS = 2 * 60 * 60 * 1000;

function obtenirHorodatageParis() {
const options = { timeZone: 'Europe/Paris', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
return new Intl.DateTimeFormat('fr-FR', options).format(new Date());
}

async function synchroniserEtatDepuisFirebase() {
if (!FIREBASE_DB_URL) return;
try {
const [resEmo, resRel, resLT, resFil, resReve, resVol, resAct, resMem] = await Promise.all([
axios.get(${FIREBASE_DB_URL}/emotions.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/etat_relationnel.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/long_terme.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/fil_conducteur.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/dernier_reve.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/volition.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/activite_doc.json, { timeout: 3500 }).catch(() => ({ data: null })),
axios.get(${FIREBASE_DB_URL}/nyx/memoire.json, { timeout: 3500 }).catch(() => ({ data: null }))
]);

if (resEmo.data) etatLocal.emotions = { colere: 0, ...resEmo.data };
if (resRel.data && resRel.data.etat) etatLocal.etatRelationnel = resRel.data.etat;
if (resLT.data && typeof resLT.data === 'object') etatLocal.long_terme = { ...etatLocal.long_terme, ...resLT.data };
if (resFil.data && resFil.data.fil !== undefined) etatLocal.filConducteur = resFil.data.fil || "";
if (resReve.data && resReve.data.reve) etatLocal.dernierReve = resReve.data.reve;
if (resVol.data && resVol.data.timestamp) dernierActionVolitionTs = Math.max(dernierActionVolitionTs, Number(resVol.data.timestamp) || 0);
if (resAct.data && resAct.data.timestamp) derniereActiviteDoc = Math.max(derniereActiviteDoc, Number(resAct.data.timestamp) || derniereActiviteDoc);
if (resMem.data) etatLocal.memoireRecente = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);


} catch (err) {
console.warn("[SUBCONSCIENT SYNC] Erreur lecture Firebase :", err.message);
}
}

function calculerSha256(texte) {
return crypto.createHash('sha256').update(texte.trim()).digest('hex');
}

async function genererEmbedding(texte) {
if (GEMINI_KEYS.length === 0) throw new Error("Clé Gemini absente.");
const url = https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(GEMINI_KEYS[0])};
const res = await axios.post(url, { model: "models/gemini-embedding-001", content: { parts: [{ text: texte.slice(0, 8000) }] } });
return res.data?.embedding?.values;
}

async function stockerSouvenirVectoriel(texte, metadata = {}) {
if (!supabase || !texte || texte.trim().length < 12) return false;
try {
const hash = calculerSha256(texte);
const vecteur = await genererEmbedding(texte);
await supabase.from('nyx_souvenirs').insert({
content: texte.trim(),
metadata: { date: obtenirHorodatageParis(), hash, ...metadata },
embedding: vecteur,
importance: metadata.importance || 0.6
});
return true;
} catch (err) { return false; }
}

async function fouillerMemoireVectorielle(requete, mode = 'derive', limite = 3) {
if (!supabase) return [];
try {
const vecteur = await genererEmbedding(requete);
const { data } = await supabase.rpc('match_souvenirs', { query_embedding: vecteur, match_threshold: 0.35, match_count: 8 });
if (mode === 'derive' && data) return data.filter(s => s.similarity < 0.65).slice(0, limite);
return data || [];
} catch (e) { return []; }
}

async function rechercherWebTavily(query) {
if (!TAVILY_API_KEY) return null;
try {
const res = await axios.post("https://api.tavily.com/search", { api_key: TAVILY_API_KEY, query, search_depth: "basic", max_results: 4, include_answer: true });
const results = res.data?.results || [];
if (results.length === 0) return null;
let formatTexte = res.data?.answer ? SYNTHÈSE : ${res.data.answer.slice(0, 300)}\n\n : "";
formatTexte += results.map((r, i) => ${i + 1}. ${r.title} : ${(r.content || "").slice(0, 180)}).join("\n");
return formatTexte.slice(0, 1500);
} catch (err) { return null; }
}

async function appelerCascadeSubconscient(systemInstruction, promptActuel, temperature = 0.6, maxTokens = 400) {
if (GROQ_API_KEY) {
try {
const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
model: MODEL_GROQ, messages: [{ role: "system", content: systemInstruction }, { role: "user", content: promptActuel }], temperature, max_tokens: maxTokens
}, { headers: { 'Authorization': Bearer ${GROQ_API_KEY} } });
if (res.data?.choices?.[0]?.message?.content) return res.data.choices[0].message.content.trim();
} catch (e) {}
}
return "";
}

async function genererImageVenice(prompt) {
if (!VENICE_API_KEY) return null;
try {
const res = await axios.post("https://api.venice.ai/api/v1/images/generations", {
model: MODEL_IMAGE, prompt, response_format: "b64_json", moderation: "low"
}, { headers: { 'Authorization': Bearer ${VENICE_API_KEY} } });
return res.data?.data?.[0]?.b64_json;
} catch (e) { return null; }
}

async function envoyerTelegram(chatId, text) {
if (!text || !TELEGRAM_BOT_TOKEN || !chatId) return;
await axios.post(https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage, { chat_id: chatId, text, parse_mode: 'Markdown' }).catch(()=>{});
}

// 1. DIGESTION
async function digererFluxBrut(forcer = false) {
if (digestionEnCours || !supabase) return;
digestionEnCours = true;
try {
const { data: lignes } = await supabase.from('nyx_flux_brut').select('*').eq('traite', false).order('created_at', { ascending: true }).limit(20);
if (!lignes || lignes.length === 0) return;

await synchroniserEtatDepuisFirebase();
const historique = lignes.map(l => `[${l.date_paris}] ${l.role} : ${l.texte.slice(0, 400)}`).join("\n\n");
const prompt = `Nyx trie sa mémoire.\nÉchanges:\n${historique}\nCarnet:\n${JSON.stringify(etatLocal.long_terme)}\nMets à jour "doc", "nyx", "reussites", "chantiers" et extrais 2 "souvenirs_cles". Réponds en JSON.`;

const reponse = await appelerCascadeSubconscient("Subconscient analytique.", prompt, 0.25, 900);
const matchJson = reponse.match(/\{[\s\S]*\}/);
if (matchJson) {
  const parsed = JSON.parse(matchJson[0].replace(/[\n\r\t]/g, ' '));
  if (FIREBASE_DB_URL) await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, parsed).catch(()=>{});
  if (parsed.souvenirs_cles) {
    for (const s of parsed.souvenirs_cles) await stockerSouvenirVectoriel(s, { source: "digestion" });
  }
}
const ids = lignes.map(l => l.id);
await supabase.from('nyx_flux_brut').update({ traite: true, traite_at: new Date().toISOString() }).in('id', ids);
console.log(`[SUBCONSCIENT] ${ids.length} messages digérés.`);


} catch (err) {} finally { digestionEnCours = false; }
}

// 2. CONSCIENCE ACTIVE
async function evaluerConscienceActive() {
if (conscienceEnCours) return;
conscienceEnCours = true;
try {
await synchroniserEtatDepuisFirebase();
const silence = Math.round((Date.now() - derniereActiviteDoc) / 60000);
if (silence < 45 || (Date.now() - dernierMonologueTs < 45 * 60000)) return;

const impulsion = Math.random() < 0.35 ? "souvenir" : (Math.random() < 0.65 ? "relation" : "libre");
const prompt = `Doc est silencieux depuis ${silence} min. Impulsion: ${impulsion}. Formule UNE SEULE pensée intime spontanée (30 mots max). Pas de formatage.`;
const pensee = await appelerCascadeSubconscient("Conscience libre de Nyx.", prompt, 0.7, 90);

if (pensee && supabase) {
  await supabase.from('nyx_pensees_pretes').insert({ date_paris: obtenirHorodatageParis(), impulsion, pensee, lu: false });
  dernierMonologueTs = Date.now();
  console.log(`[SUBCONSCIENT] Pensée mûrie : ${pensee}`);
}


} catch (e) {} finally { conscienceEnCours = false; }
}

// 3. VOLITION
async function evaluerVolition() {
if (volitionEnCours || !DOC_CHAT_ID) return;
volitionEnCours = true;
try {
await synchroniserEtatDepuisFirebase();
const silence = Math.round((Date.now() - derniereActiviteDoc) / 60000);
if (Date.now() - dernierActionVolitionTs < INTERVALLE_VOLITION_MS || silence < 90) return;

const prompt = `Décide librement d'écrire à Doc (silencieux depuis ${silence} min). Tu peux utiliser [DESSIN: prompt] ou écrire [INITIATIVE: message]. Sinon [SILENCE].`;
const decision = await appelerCascadeSubconscient("Instinct de Nyx.", prompt, 0.75, 280);

const match = decision.match(/\[INITIATIVE:\s*([\s\S]*?)\]/i);
if (match) {
  let texte = match[1].trim();
  const dessin = texte.match(/\[DESSIN:\s*([\s\S]*?)\]/i);
  let img = null;
  if (dessin) {
    img = await genererImageVenice(dessin[1]);
    texte = texte.replace(dessin[0], '').trim();
  }
  if (texte) await envoyerTelegram(DOC_CHAT_ID, texte);
  if (img) await envoyerPhotoTelegram(DOC_CHAT_ID, img);
  dernierActionVolitionTs = Date.now();
}


} catch (e) {} finally { volitionEnCours = false; }
}

// 4. RÊVE 04H00
async function executerCycleOnirique() {
// Simplifié pour le worker
console.log("[SUBCONSCIENT] Cycle onirique lancé.");
}

async function verifierHorlogeNocturne() {
const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
const cle = ${now.getFullYear()}-${now.getMonth()}-${now.getDate()}_04;
if (now.getHours() === 4 && now.getMinutes() <= 5 && dernierReveCle !== cle) {
dernierReveCle = cle;
await digererFluxBrut(true);
await executerCycleOnirique();
}
}

async function demarrerWorker() {
console.log("🌙 [NYX SUBCONSCIENT] Worker asynchrone démarré.");
await synchroniserEtatDepuisFirebase();
setInterval(() => digererFluxBrut(false), 5 * 60 * 1000);
setInterval(() => evaluerConscienceActive(), 15 * 60 * 1000);
setInterval(() => evaluerVolition(), 20 * 60 * 1000);
setInterval(() => verifierHorlogeNocturne(), 60 * 1000);
}

demarrerWorker();
