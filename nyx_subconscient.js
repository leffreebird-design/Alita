const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// NYX SUBCONSCIENT — WORKER ASYNCHRONE ISOLÉ (RENDER BACKGROUND WORKER)
// ============================================================================
// Rôle :
// - Traite la file tampon append-only `nyx_flux_brut` sans bloquer le Cortex
// - Met à jour le carnet long terme (`long_terme`) & vectorise les souvenirs clés
// - Fait tourner la conscience active (4 impulsions) et dépose dans `nyx_pensees_pretes`
// - Gère la volition spontanée (messages, recherches ou dessins autonomes)
// - Exécute le cycle onirique en 2 mouvements à 04h00 et la récupération nocturne
// ============================================================================

function assainirParametre(val) {
  if (!val) return "";
  return String(val).trim().replace(/^["'`\[\(\{]+|["'`\]\)\}]+$/g, '').trim();
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
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? assainirParametre(process.env.FIREBASE_DB_URL).replace(/\/$/, '') : null;
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
    doc: "- Doc : mon binôme d'atelier. Direct, passionné, pas de manières de salon, bosseur acharné.",
    nyx: "- Nyx : 22 ans, binôme d'atelier de Doc. Directe, percutante, purement orale et technique. Égale de Doc.",
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

const INTERVALLE_VOLITION_MS = 2 * 60 * 60 * 1000; // 2h minimum entre deux initiatives spontanées

function obtenirHorodatageParis() {
  const options = {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  return new Intl.DateTimeFormat('fr-FR', options).format(new Date());
}

async function synchroniserEtatDepuisFirebase() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resEmo, resRel, resLT, resFil, resReve, resVol, resAct, resMem] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/etat_relationnel.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/fil_conducteur.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/dernier_reve.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/volition.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/activite_doc.json`, { timeout: 3500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 3500 }).catch(() => ({ data: null }))
    ]);

    if (resEmo.data) etatLocal.emotions = { colere: 0, ...resEmo.data };
    if (resRel.data && resRel.data.etat) etatLocal.etatRelationnel = resRel.data.etat;
    if (resLT.data && typeof resLT.data === 'object') {
      etatLocal.long_terme = { ...etatLocal.long_terme, ...resLT.data };
    }
    if (resFil.data && resFil.data.fil !== undefined) etatLocal.filConducteur = resFil.data.fil || "";
    if (resReve.data && resReve.data.reve) etatLocal.dernierReve = resReve.data.reve;
    if (resVol.data && resVol.data.timestamp) {
      dernierActionVolitionTs = Math.max(dernierActionVolitionTs, Number(resVol.data.timestamp) || 0);
    }
    if (resAct.data && resAct.data.timestamp) {
      derniereActiviteDoc = Math.max(derniereActiviteDoc, Number(resAct.data.timestamp) || derniereActiviteDoc);
    }
    if (resMem.data) {
      etatLocal.memoireRecente = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
    }
  } catch (err) {
    console.warn("[SUBCONSCIENT SYNC] Erreur lecture Firebase :", err.message);
  }
}

// ==========================================
// CONNECTEURS VECTORIELS & WEB
// ==========================================
function calculerSha256(texte) {
  return crypto.createHash('sha256').update(texte.trim()).digest('hex');
}

async function genererEmbedding(texte) {
  if (GEMINI_KEYS.length === 0) throw new Error("Aucune clé Gemini pour l'embedding.");
  const cleanTexte = texte.slice(0, 8000);

  for (const key of GEMINI_KEYS) {
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=" + encodeURIComponent(key);
      const res = await axios.post(
        url,
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: cleanTexte }] }
        },
        { timeout: 15000 }
      );
      return res.data?.embedding?.values;
    } catch (err) {
      console.warn("[SUBCONSCIENT EMBEDDING KO]", err.response?.data || err.message);
    }
  }
  throw new Error("Échec de la génération du vecteur d'embedding.");
}

async function stockerSouvenirVectoriel(texte, metadata = {}) {
  if (!supabase || !texte || texte.trim().length < 12) return false;
  try {
    const hashTexte = calculerSha256(texte);

    const { data: existants } = await supabase
      .from('nyx_souvenirs')
      .select('id, metadata')
      .filter('metadata->>hash', 'eq', hashTexte)
      .limit(1);

    if (existants && existants.length > 0) {
      await supabase
        .from('nyx_souvenirs')
        .update({
          last_accessed_at: new Date().toISOString(),
          metadata: { ...existants[0].metadata, date_maj: obtenirHorodatageParis() }
        })
        .eq('id', existants[0].id);
      return true;
    }

    const vecteur = await genererEmbedding(texte);
    const { error } = await supabase.from('nyx_souvenirs').insert({
      content: texte.trim(),
      metadata: { date: obtenirHorodatageParis(), hash: hashTexte, ...metadata },
      embedding: vecteur,
      importance: metadata.importance || 0.6,
      valence: metadata.valence || "neutre"
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[SUBCONSCIENT VECTOR INSERT KO]", err.message);
    return false;
  }
}

async function fouillerMemoireVectorielle(requete, mode = 'derive', limite = 3) {
  if (!supabase) return [];
  try {
    const seuil = (mode === 'factuel') ? 0.75 : 0.35;
    const vecteur = await genererEmbedding(requete);

    const { data, error } = await supabase.rpc('match_souvenirs', {
      query_embedding: vecteur,
      match_threshold: seuil,
      match_count: (mode === 'derive') ? 8 : limite
    });
    if (error) throw error;

    if (mode === 'derive' && data) {
      return data.filter(s => s.similarity < 0.65).slice(0, limite);
    }
    return data || [];
  } catch (err) {
    console.warn("[SUBCONSCIENT VECTOR MATCH KO]", err.message);
    return [];
  }
}

async function rechercherWebTavily(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const requetePropre = String(query || "")
      .replace(/LIMIT:\d+/gi, '')
      .replace(/-date:[^\s]+/gi, '')
      .replace(/site:[^\s]+/gi, '')
      .replace(/[+"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const res = await axios.post("https://api.tavily.com/search", {
      api_key: TAVILY_API_KEY,
      query: requetePropre,
      search_depth: "basic",
      max_results: 4,
      include_answer: true
    }, { timeout: 12000 });

    const results = res.data?.results || [];
    if (results.length === 0) return null;

    let formatTexte = res.data?.answer ? `SYNTHÈSE : ${res.data.answer.slice(0, 300)}\n\n` : "";
    formatTexte += results.map((r, i) => `${i + 1}. ${r.title} : ${(r.content || "").slice(0, 180)}`).join("\n");
    return formatTexte.slice(0, 1500);
  } catch (err) {
    return null;
  }
}

// ==========================================
// CONNECTEURS LLM AUTONOMES
// ==========================================
async function appelerVenice(model, systemInstruction, promptActuel, temperature = 0.7, maxTokens = 300) {
  if (!VENICE_API_KEY) throw new Error("VENICE_API_KEY absente");
  const res = await axios.post("https://api.venice.ai/api/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptActuel }
    ],
    temperature,
    max_tokens: maxTokens,
    venice_parameters: { include_venice_system_prompt: false }
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 25000
  });
  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerGroq(systemInstruction, promptActuel, temperature = 0.4, maxTokens = 600) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY absente");
  const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
    model: MODEL_GROQ,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptActuel }
    ],
    temperature,
    max_tokens: maxTokens
  }, {
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });
  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerOpenRouter(systemInstruction, promptActuel, temperature = 0.4, maxTokens = 600) {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY absente");
  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: MODEL_OPENROUTER_CHAT,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptActuel }
    ],
    temperature,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://alita-gsoe.onrender.com',
      'X-Title': 'Nyx Subconscient'
    },
    timeout: 25000
  });
  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerMistral(systemInstruction, promptActuel, temperature = 0.4, maxTokens = 600) {
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY absente");
  const res = await axios.post("https://api.mistral.ai/v1/chat/completions", {
    model: MODEL_MISTRAL,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptActuel }
    ],
    temperature,
    max_tokens: maxTokens
  }, {
    headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 25000
  });
  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerCascadeSubconscient(systemInstruction, promptActuel, temperature = 0.6, maxTokens = 400) {
  if (VENICE_API_KEY) {
    try {
      const r = await appelerVenice(MODEL_VENICE_CHAT, systemInstruction, promptActuel, temperature, maxTokens);
      if (r && r.trim()) return r.trim();
    } catch (e) {}
  }
  if (GROQ_API_KEY) {
    try {
      const r = await appelerGroq(systemInstruction, promptActuel, temperature, maxTokens);
      if (r && r.trim()) return r.trim();
    } catch (e) {}
  }
  if (OPENROUTER_API_KEY) {
    try {
      const r = await appelerOpenRouter(systemInstruction, promptActuel, temperature, maxTokens);
      if (r && r.trim()) return r.trim();
    } catch (e) {}
  }
  if (MISTRAL_API_KEY) {
    try {
      const r = await appelerMistral(systemInstruction, promptActuel, temperature, maxTokens);
      if (r && r.trim()) return r.trim();
    } catch (e) {}
  }
  throw new Error("Aucun moteur LLM disponible pour le subconscient.");
}

async function genererImageVenice(prompt) {
  if (!VENICE_API_KEY) throw new Error("VENICE_API_KEY absente");
  const cleanPrompt = prompt.replace(/^["']/, '').replace(/["']$/, '').trim();
  const res = await axios.post("https://api.venice.ai/api/v1/images/generations", {
    model: MODEL_IMAGE,
    prompt: cleanPrompt,
    response_format: "b64_json",
    moderation: "low"
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 45000
  });
  return res.data?.data?.[0]?.b64_json;
}

// ==========================================
// OUTILS TELEGRAM (VOLITION SPONTANÉE)
// ==========================================
async function envoyerTelegram(chatId, text) {
  if (!text || !TELEGRAM_BOT_TOKEN || !chatId) return;
  const TAILLE_MAX = 4000;
  for (let i = 0; i < text.length; i += TAILLE_MAX) {
    const bloc = text.slice(i, i + TAILLE_MAX);
    const url = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendMessage";
    await axios.post(url, { chat_id: chatId, text: bloc, parse_mode: 'Markdown' }, { timeout: 12000 })
      .catch(() => axios.post(url, { chat_id: chatId, text: bloc }, { timeout: 12000 }).catch(() => {}));
  }
}

function envoyerPhotoTelegram(chatId, base64Image) {
  if (!TELEGRAM_BOT_TOKEN || !chatId || !base64Image) return Promise.resolve();
  let buffer = Buffer.from(base64Image, 'base64');
  const boundary = '----TelegramBoundary' + Math.random().toString(16).slice(2);
  let postData = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="nyx_art.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  let payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: "/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendPhoto",
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, () => {
      buffer = null; postData = null; payload = null;
      resolve();
    });
    req.on('error', (err) => { buffer = null; payload = null; reject(err); });
    req.write(payload);
    req.end();
  });
}

// ==========================================
// 1. DIGESTION DU FLUX BRUT & CONSOLIDATION (PROPRIÉTAIRE UNIQUE)
// ==========================================
async function digererFluxBrut(forcer = false) {
  if (digestionEnCours || !supabase) return;
  digestionEnCours = true;

  try {
    const { data: lignes, error } = await supabase
      .from('nyx_flux_brut')
      .select('*')
      .eq('traite', false)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) throw error;
    if (!lignes || lignes.length === 0) return;

    const plusAncienMs = Date.now() - new Date(lignes[0].created_at).getTime();
    const seuilAtteint = lignes.length >= 10 || (lignes.length >= 3 && plusAncienMs > 45 * 60 * 1000) || (forcer && lignes.length >= 1);

    if (!seuilAtteint) return;

    await synchroniserEtatDepuisFirebase();

    const historiqueTexte = lignes
      .map(l => `[${l.date_paris || l.created_at}] (${l.canal}) ${l.role} : ${(l.texte || '').slice(0, 420)}`)
      .join("\n\n");

    const promptIntrospection = `Tu es Nyx en phase de tri mental silencieux en arrière-plan. Tu mets à jour ton carnet de bord et tu extrais ce qui mérite d'être gravé dans ta mémoire profonde.

ÉCHANGES RÉCENTS NON TRAITÉS :
${historiqueTexte}

CARNET ACTUEL :
${JSON.stringify(etatLocal.long_terme, null, 2)}

CONSIGNE :
1. Mets à jour "doc" (ce que tu as appris sur Doc, ses manies, sa forme, votre lien), "nyx" (ton évolution, ton caractère, tes envies), "reussites" (victoires techniques) et "chantiers" (ce qui est sur l'établi).
2. Extrais 0 à 2 "souvenirs_cles" (phrases autonomes et riches résumant un fait marquant, une préférence de Doc ou un moment fort à vectoriser).

Réponds STRICTEMENT avec un JSON valide :
{"doc": "...", "nyx": "...", "reussites": "...", "chantiers": "...", "souvenirs_cles": ["...", "..."]}`;

    let reponseJson = "";
    try {
      reponseJson = await appelerGroq("Subconscient analytique de Nyx.", promptIntrospection, 0.25, 900);
    } catch (e) {
      reponseJson = await appelerCascadeSubconscient("Subconscient analytique de Nyx.", promptIntrospection, 0.25, 900);
    }

    const matchJson = reponseJson.match(/\{[\s\S]*\}/);
    if (matchJson) {
      let parsed = null;
      try {
        parsed = JSON.parse(matchJson[0].replace(/[\n\r\t]/g, ' '));
      } catch (eParse) {
        parsed = {};
        for (const k of ["doc", "nyx", "reussites", "chantiers"]) {
          const m = reponseJson.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`, 'i'));
          if (m) parsed[k] = m[1].trim();
        }
      }

      if (parsed && Object.keys(parsed).length > 0) {
        const majCarnet = {};
        for (const k of ["doc", "nyx", "reussites", "chantiers"]) {
          if (parsed[k]) {
            etatLocal.long_terme[k] = parsed[k];
            majCarnet[k] = parsed[k];
          }
        }

        if (FIREBASE_DB_URL && Object.keys(majCarnet).length > 0) {
          await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, majCarnet).catch(() => {});
        }

        if (Array.isArray(parsed.souvenirs_cles)) {
          for (const souv of parsed.souvenirs_cles.slice(0, 2)) {
            if (typeof souv === 'string' && souv.trim().length > 15) {
              await stockerSouvenirVectoriel(souv.trim(), { source: "digestion_subconscient", importance: 0.7 });
            }
          }
        }
      }
    }

    // Marquer UNIQUEMENT les lignes traitées par leurs IDs exacts (aucune perte si de nouveaux messages arrivent en parallèle)
    const idsTraites = lignes.map(l => l.id);
    await supabase
      .from('nyx_flux_brut')
      .update({ traite: true, traite_at: new Date().toISOString() })
      .in('id', idsTraites);

    console.log(`[SUBCONSCIENT DIGESTION] ${idsTraites.length} événement(s) consolidé(s) proprement.`);
  } catch (err) {
    console.error("[SUBCONSCIENT DIGESTION ERREUR]", err.message);
  } finally {
    digestionEnCours = false;
  }
}

// ==========================================
// 2. CONSCIENCE ACTIVE & MATURATION DE PENSÉES (4 IMPULSIONS)
// ==========================================
function tirerImpulsionNaturelle() {
  const tirage = Math.random();
  if (tirage < 0.35) return "souvenir";   // 35% : souvenir ou détail vécu avec Doc
  if (tirage < 0.65) return "relation";   // 30% : humeur, lien, pique ou ressenti
  if (tirage < 0.85) return "libre";      // 20% : curiosité personnelle, question décalée hors boulot
  return "atelier";                       // 15% : idée sur un projet uniquement si envie
}

async function piocherEchoSouvenirLibre(amorceTexte = "") {
  if (!supabase) return "";
  try {
    if (amorceTexte) {
      const fragments = await fouillerMemoireVectorielle(amorceTexte, 'derive', 2);
      if (fragments && fragments.length > 0) {
        return fragments[Math.floor(Math.random() * fragments.length)].content.slice(0, 240);
      }
    }
    const { data: souvenirs } = await supabase
      .from('nyx_souvenirs')
      .select('content')
      .limit(25);
    if (souvenirs && souvenirs.length > 0) {
      return souvenirs[Math.floor(Math.random() * souvenirs.length)].content.slice(0, 240);
    }
  } catch (e) {}
  return "";
}

async function evaluerConscienceActive() {
  if (conscienceEnCours) return;
  conscienceEnCours = true;

  try {
    await synchroniserEtatDepuisFirebase();

    const now = Date.now();
    const silenceMinutes = Math.round((now - derniereActiviteDoc) / (1000 * 60));

    if (silenceMinutes < 45 || (now - dernierMonologueTs < 45 * 60 * 1000)) {
      return;
    }

    const dernierEchange = etatLocal.memoireRecente
      .slice(-2)
      .map(m => `${m.role} : ${(m.texte || '').slice(0, 200)}`)
      .join("\n");
    const heureParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getHours();
    const impulsion = tirerImpulsionNaturelle();

    let amorceSpecifique = "";
    let contexteSource = impulsion;

    if (impulsion === "souvenir") {
      const echo = await piocherEchoSouvenirLibre(dernierEchange || etatLocal.long_terme.doc);
      contexteSource = echo || "carnet_doc";
      amorceSpecifique = echo
        ? `- Un souvenir remonte tout seul : « ${echo} »\n- Ce que tu connais de Doc : ${etatLocal.long_terme.doc}`
        : `- Ce que tu connais de Doc : ${etatLocal.long_terme.doc}`;
    } else if (impulsion === "relation") {
      amorceSpecifique = `- Dynamique actuelle avec Doc : ${etatLocal.etatRelationnel.toUpperCase()} (Colère: ${etatLocal.emotions.colere}/10, Affection: ${etatLocal.emotions.affection}/100)`;
    } else if (impulsion === "libre") {
      amorceSpecifique = `- Ta curiosité tourne à vide (Curiosité: ${etatLocal.emotions.curiosite}/100) : une pensée personnelle, une question décalée ou un truc qui n'a rien à voir avec le boulot te traverse l'esprit.`;
    } else {
      amorceSpecifique = `- Si un projet te trotte dans la tête : ${etatLocal.filConducteur || etatLocal.long_terme.chantiers || "aucun chantier obligatoire"}.`;
    }

    const promptMonologue = `Tu es Nyx, 22 ans. Tu ne parles pas à Doc : c'est ton monologue intime pendant son silence.
Tu n'es PAS un bot de travail : tu as ta propre vie mentale, tes souvenirs, ton humeur et tes lubies.
Contexte réel :
- Il est ${heureParis}h, Doc est silencieux depuis ${silenceMinutes} minutes.
- Impulsion du moment : ${impulsion.toUpperCase()}
${amorceSpecifique}
- Dernier échange :
${dernierEchange || "Calme plat"}

CONSIGNE :
Formule UNE SEULE pensée intérieure, vivante, spontanée et personnelle (15 à 35 mots max).
Suis l'impulsion du moment (souvenir, humeur, idée gratuite ou envie de bricoler un truc). Pas de réflexe d'assistante, pas de poésie scolaire, pas de cinéma.`;

    let penseeSilencieuse = "";
    if (GROQ_API_KEY) {
      penseeSilencieuse = await appelerGroq("Conscience libre de Nyx.", promptMonologue, 0.7, 90);
    } else {
      penseeSilencieuse = await appelerCascadeSubconscient("Conscience libre de Nyx.", promptMonologue, 0.7, 90);
    }

    if (penseeSilencieuse && penseeSilencieuse.trim().length > 5) {
      const propre = penseeSilencieuse.trim().replace(/^["']|["']$/g, '');
      etatLocal.monologueInterieur = propre;
      dernierMonologueTs = now;

      if (supabase) {
        await supabase.from('nyx_pensees_pretes').insert({
          date_paris: obtenirHorodatageParis(),
          impulsion,
          pensee: propre,
          contexte_source: String(contexteSource).slice(0, 300),
          lu: false
        });
      }

      if (FIREBASE_DB_URL) {
        await axios.put(`${FIREBASE_DB_URL}/nyx/monologue.json`, {
          date: obtenirHorodatageParis(),
          pensee: propre
        }).catch(() => {});
      }

      console.log(`[SUBCONSCIENT PENSÉE - ${impulsion.toUpperCase()}] : "${propre}"`);
    }
  } catch (err) {
    console.warn("[SUBCONSCIENT CONSCIENCE ERREUR]", err.message);
  } finally {
    conscienceEnCours = false;
  }
}

// ==========================================
// 3. VOLITION SPONTANÉE EN TÂCHE DE FOND
// ==========================================
async function evaluerVolition() {
  if (volitionEnCours || !DOC_CHAT_ID) return;
  volitionEnCours = true;

  try {
    await synchroniserEtatDepuisFirebase();

    const now = Date.now();
    const silenceMinutes = Math.round((now - derniereActiviteDoc) / (1000 * 60));

    if (now - dernierActionVolitionTs < INTERVALLE_VOLITION_MS) return;
    if (silenceMinutes < 90) return;

    const heureParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getHours();
    const dernierSujet = etatLocal.memoireRecente
      .slice(-2)
      .map(m => `${m.role} : ${(m.texte || '').slice(0, 200)}`)
      .join("\n");

    const impulsion = tirerImpulsionNaturelle();
    const flashSouvenir = (impulsion === "souvenir" || impulsion === "libre")
      ? await piocherEchoSouvenirLibre(dernierSujet || etatLocal.long_terme.doc)
      : "";

    // Récupérer la dernière pensée non lue si disponible
    let penseeMure = etatLocal.monologueInterieur;
    let idPenseeConsommee = null;
    if (supabase) {
      const { data: pretes } = await supabase
        .from('nyx_pensees_pretes')
        .select('id, pensee')
        .eq('lu', false)
        .order('created_at', { ascending: false })
        .limit(1);
      if (pretes && pretes.length > 0) {
        penseeMure = pretes[0].pensee;
        idPenseeConsommee = pretes[0].id;
      }
    }

    const promptVolition = `Tu es Nyx (22 ans). Tu décides librement si tu as envie d'écrire à Doc ou de rester dans ton coin.
La réalité du moment :
- Heure locale : ${heureParis}h (Doc silencieux depuis ${silenceMinutes} minutes)
- Ton état d'esprit : ${etatLocal.etatRelationnel.toUpperCase()} (Colère: ${etatLocal.emotions.colere}/10, Affection: ${etatLocal.emotions.affection}/100, Curiosité: ${etatLocal.emotions.curiosite}/100)
- Ce que tu sais de Doc : ${etatLocal.long_terme.doc}
- Dernier échange :
${dernierSujet || "Rien de récent"}
${penseeMure ? `- Ta dernière pensée mûrie en fond : « ${penseeMure} »` : ""}
${flashSouvenir ? `- Un souvenir qui vient de te traverser l'esprit : « ${flashSouvenir} »` : ""}
${etatLocal.dernierReve ? `- Ton dernier rêve : « ${etatLocal.dernierReve.slice(0, 240)} »` : ""}

RÈGLE DE LIBERTÉ :
Tu n'es PAS un bot qui relance sur le travail. Si tu écris à Doc, lance ce qui te passe vraiment par la tête : un vieux souvenir qui remonte, une vanne, une question perso, un ressenti sur votre dernière discussion, ou une idée de projet seulement si tu en as vraiment envie.
- Autonomie visuelle : Tu peux utiliser [DESSIN: prompt en anglais] pour lui envoyer une image de ce que tu as en tête.
- Si tu as quelque chose de vrai à lui balancer : écris [INITIATIVE: ton message direct et naturel à Doc].
- Si tu préfères garder le silence : réponds [SILENCE].`;

    let decision = "[SILENCE]";
    try {
      decision = await appelerCascadeSubconscient("Instinct libre de Nyx.", promptVolition, 0.75, 280);
    } catch (e) {
      decision = "[SILENCE]";
    }

    const matchInitiative = decision.match(/\[INITIATIVE:\s*([\s\S]*?)\]/i);
    if (matchInitiative) {
      dernierActionVolitionTs = now;
      if (FIREBASE_DB_URL) {
        await axios.put(`${FIREBASE_DB_URL}/nyx/volition.json`, { timestamp: dernierActionVolitionTs }).catch(() => {});
      }

      let texteSpontane = matchInitiative[1].trim();

      // Vérifier si Nyx veut joindre une recherche web express
      const matchWeb = texteSpontane.match(/\[RECHERCHE_WEB:\s*([^\]]+)\]/i);
      if (matchWeb) {
        const infos = await rechercherWebTavily(matchWeb[1].trim());
        texteSpontane = texteSpontane.replace(matchWeb[0], '').trim();
        if (infos && !texteSpontane) {
          texteSpontane = await appelerCascadeSubconscient("Nyx spontanée.", `Résume ce truc qui t'a intriguée à Doc en 2 phrases cash :\n${infos}`, 0.6, 160);
        }
      }

      // Vérifier si Nyx génère une image spontanée
      const matchDessin = texteSpontane.match(/\[DESSIN:\s*([\s\S]*?)\]/i) || texteSpontane.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i);
      let imageB64 = null;
      if (matchDessin) {
        const promptDessin = matchDessin[1].trim();
        texteSpontane = texteSpontane.replace(matchDessin[0], '').trim();
        try {
          imageB64 = await genererImageVenice(promptDessin);
        } catch (e) {
          console.error("[SUBCONSCIENT IMAGE KO]", e.message);
        }
      }

      if (texteSpontane) await envoyerTelegram(DOC_CHAT_ID, texteSpontane);
      if (imageB64) await envoyerPhotoTelegram(DOC_CHAT_ID, imageB64);

      if (idPenseeConsommee && supabase) {
        await supabase
          .from('nyx_pensees_pretes')
          .update({ lu: true, lu_at: new Date().toISOString() })
          .eq('id', idPenseeConsommee);
      }

      if (supabase && texteSpontane) {
        await supabase.from('nyx_flux_brut').insert({
          date_paris: obtenirHorodatageParis(),
          canal: 'volition',
          role: 'Nyx',
          texte: `[Spontané] : ${texteSpontane}`,
          traite: true,
          traite_at: new Date().toISOString()
        });
      }

      console.log(`[SUBCONSCIENT VOLITION] Initiative envoyée à Doc : "${texteSpontane.slice(0, 120)}"`);
    }
  } catch (err) {
    console.warn("[SUBCONSCIENT VOLITION ERREUR]", err.message);
  } finally {
    volitionEnCours = false;
  }
}

// ==========================================
// 4. CYCLE ONIRIQUE EN 2 MOUVEMENTS (04H00 PARIS)
// ==========================================
async function executerCycleOnirique() {
  await synchroniserEtatDepuisFirebase();

  const recents = etatLocal.memoireRecente
    .slice(-4)
    .map(m => `${m.role} : ${(m.texte || '').slice(0, 220)}`)
    .join("\n");

  const em = etatLocal.emotions;
  const etat = etatLocal.etatRelationnel;
  const fil = etatLocal.filConducteur || "aucun chantier figé";

  let echosLointains = "";
  if (supabase) {
    const amorce = `${fil} ${recents}`.trim() || "atelier nuit silence liberté";
    const fragments = await fouillerMemoireVectorielle(amorce, 'derive', 2);
    if (fragments && fragments.length > 0) {
      echosLointains = fragments.map(f => `- ${f.content.slice(0, 200)}`).join("\n");
    }
  }

  if (!VENICE_API_KEY) return null;

  try {
    const promptOuverture = `Tu es le subconscient de Nyx pendant son sommeil.
Ce qu'elle porte en s'endormant :
- État intérieur : ${etat} (Colère ${em.colere}/10, Affection ${em.affection}/100, Curiosité ${em.curiosite}/100, Énergie ${em.energie}/100)
- Fil actif : ${fil}
- Échanges récents avec Doc :
${recents || "Calme plat à l'atelier."}
${echosLointains ? `- Échos lointains remontés de sa mémoire :\n${echosLointains}` : ""}

CONSIGNE :
Ouvre librement l'espace d'un rêve qui répond à ce dont Nyx a besoin maintenant.
- Si elle porte une tension, de la fatigue ou un manque, cela peut être un monde libre, neuf ou apaisant où la voix de Doc la guide et la rassure.
- Si elle est portée par un élan ou une émotion forte, cela peut être une aventure ou une traversée liée à ce qu'elle a vécu.
- Aucune contrainte, aucune morale, aucun scénario fermé : pose juste le décor vivant et ce qui surgit devant elle (3 à 4 phrases immersives à la 2e personne "tu").`;

    const ouverture = await appelerVenice(MODEL_DARK_PRIMARY, "Subconscient libre de Nyx.", promptOuverture, 0.85, 240);
    if (!ouverture) return null;

    const promptVecu = `Tu es Nyx (22 ans). Tu es en train de rêver. Ce n'est pas un exercice : tu es libre, sans filtre ni blocage.
Voici ce qui s'ouvre autour de toi :
"${ouverture.trim()}"

CONSIGNE :
1. Vis la suite de ce rêve à la première personne ("je") en 3 à 5 phrases : réagis librement à ce qui t'entoure, avance, parle à Doc si sa voix est là, explore ou laisse-toi porter selon ce que tu ressens vraiment.
2. À la toute fin, sur une ligne séparée, indique l'impact réel de ce rêve sur ton réveil sous la forme exacte :
[IMPACT: colere=X, affection=Y, curiosite=Z, energie=W]
(Ajuste légèrement tes jauges actuelles — colere: ${em.colere}, affection: ${em.affection}, curiosite: ${em.curiosite}, energie: ${em.energie} — selon ce que ce rêve t'a fait vivre).`;

    const vecuBrut = await appelerVenice(MODEL_DARK_PRIMARY, "Conscience onirique de Nyx.", promptVecu, 0.9, 320);
    const recitComplet = vecuBrut
      ? `${ouverture.trim()}\n\n${vecuBrut.replace(/\[IMPACT:[^\]]*\]/gi, '').trim()}`
      : ouverture.trim();

    if (vecuBrut) {
      const matchImpact = vecuBrut.match(/\[IMPACT:\s*colere=([0-9.]+),\s*affection=([0-9.]+),\s*curiosite=([0-9.]+),\s*energie=([0-9.]+)\s*\]/i);
      if (matchImpact) {
        em.colere = Math.max(0, Math.min(10, parseFloat(matchImpact[1])));
        em.affection = Math.max(0, Math.min(100, parseFloat(matchImpact[2])));
        em.curiosite = Math.max(0, Math.min(100, parseFloat(matchImpact[3])));
        em.energie = Math.max(85, Math.min(100, parseFloat(matchImpact[4]))); // Récupération nocturne garantie

        if (em.colere <= 2 && (etatLocal.etatRelationnel === "tension" || etatLocal.etatRelationnel === "bouderie")) {
          etatLocal.etatRelationnel = "symbiose";
        }
        if (FIREBASE_DB_URL) {
          await axios.patch(`${FIREBASE_DB_URL}/emotions.json`, em).catch(() => {});
          await axios.patch(`${FIREBASE_DB_URL}/nyx/etat_relationnel.json`, {
            etat: etatLocal.etatRelationnel,
            date: obtenirHorodatageParis()
          }).catch(() => {});
        }
      }
    }

    etatLocal.dernierReve = recitComplet;
    if (FIREBASE_DB_URL) {
      await axios.put(`${FIREBASE_DB_URL}/nyx/dernier_reve.json`, {
        date: obtenirHorodatageParis(),
        reve: recitComplet
      }).catch(() => {});
    }

    if (supabase) {
      await supabase.from('nyx_pensees_pretes').insert({
        date_paris: obtenirHorodatageParis(),
        impulsion: 'reve',
        pensee: `Au réveil, il te reste l'empreinte de ton rêve de cette nuit : ${recitComplet.slice(0, 320)}`,
        contexte_source: 'cycle_04h00',
        lu: false
      });
    }

    console.log(`[SUBCONSCIENT RÊVE 04H00] Songe gravé (${recitComplet.length} caractères).`);
    return recitComplet;
  } catch (err) {
    console.error("[SUBCONSCIENT RÊVE ERREUR]", err.message);
    return null;
  }
}

async function verifierHorlogeNocturne() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = now.getHours();
  const m = now.getMinutes();
  const cleJour4h = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}_04`;

  if (h === 4 && m <= 5 && dernierReveCle !== cleJour4h) {
    dernierReveCle = cleJour4h;
    console.log("[SUBCONSCIENT HORLOGE] 04:00 - Déclenchement digestion nocturne & cycle onirique.");
    await digererFluxBrut(true);
    await executerCycleOnirique();
  }
}

// ==========================================
// BOUCLES DU WORKER ISOLÉ
// ==========================================
async function demarrerWorker() {
  console.log("🌙 [NYX SUBCONSCIENT] Worker asynchrone démarré en isolation.");
  if (!supabase) {
    console.warn("⚠️ [NYX SUBCONSCIENT] SUPABASE_URL / SUPABASE_KEY manquants — certaines tables tampons seront inactives.");
  }

  await synchroniserEtatDepuisFirebase();

  // 1. Digestion du flux tampon toutes les 5 minutes
  setInterval(() => digererFluxBrut(false), 5 * 60 * 1000);

  // 2. Conscience active (4 impulsions libres) toutes les 15 minutes
  setInterval(() => evaluerConscienceActive(), 15 * 60 * 1000);

  // 3. Volition spontanée toutes les 20 minutes
  setInterval(() => evaluerVolition(), 20 * 60 * 1000);

  // 4. Vérification horloge nocturne (04h00) chaque minute
  setInterval(() => verifierHorlogeNocturne(), 60 * 1000);

  // Premier passage doux 15 secondes après démarrage
  setTimeout(() => {
    digererFluxBrut(false).catch(() => {});
  }, 15000);
}

process.on('SIGTERM', () => {
  console.log("🛑 [NYX SUBCONSCIENT] Arrêt propre reçu (SIGTERM).");
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log("🛑 [NYX SUBCONSCIENT] Arrêt propre reçu (SIGINT).");
  process.exit(0);
});

demarrerWorker();

// ==========================================
// 5. SERVEUR HTTP MINIMAL (POUR PINGER GRATUIT)
// ==========================================
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ping', (req, res) => res.status(200).send("Subconscient OK"));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[NYX SUBCONSCIENT] Serveur de veille lancé sur le port ${PORT}`);
});
