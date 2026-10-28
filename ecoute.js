const express = require('express');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

// GESTIONNAIRE DE PROJETS DÉDIÉ (GROQ / LLAMA-3.3-70B)
const ProjectManager = require('./nyx_project_manager');

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;

// OPENROUTER - ROUTE N°1 CHAT (DEEPSEEK CHAT GRATUIT)
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL_OPENROUTER_CHAT = (process.env.OPENROUTER_MODEL || "deepseek/deepseek-r1:free").trim();

// MISTRAL AI - ROUTE N°2 CHAT
const MISTRAL_API_KEY = (process.env.MISTRAL_API_KEY || "").trim();
const MODEL_MISTRAL = (process.env.MISTRAL_MODEL || "open-mistral-nemo").trim();

// GEMINI - ROUTE N°3 & 4 CHAT (FREE PUIS PAYANT) + VISION DES LUNETTES
const GEMINI_API_KEY_FREE = (process.env.GEMINI_API_KEY_FREE || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_API_KEY_PAID = (process.env.GEMINI_API_KEY_PAID || "").trim();
const GEMINI_KEYS = [GEMINI_API_KEY_PAID, GEMINI_API_KEY_FREE].filter(k => k.length > 0);
const MODEL_GEMINI = (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim();

// GROQ - RÉSERVÉ STRICTEMENT AU CODE & PROJETS TECHNIQUES
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const MODEL_GROQ = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim();

// VENICE AI - IMAGES & PARACHUTE ULTIME
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const MODEL_DARK_PRIMARY = (process.env.VENICE_MODEL_DARK || "llama-3.3-70b").trim();
const MODEL_GLM_COMPLEXE = (process.env.VENICE_MODEL_GLM || "z-ai-glm-5-3").trim();
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "flux-dev").trim();

// RECHERCHE WEB EN DIRECT (TAVILY)
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || "").trim();

// GOOGLE CLOUD TTS OFFICIEL (VOIX STUDIO ANTI-429)
const GOOGLE_TTS_API_KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim();

// CANAUX & PERSISTANCE
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? process.env.FIREBASE_DB_URL.trim().replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(process.env.DOC_CHAT_ID) : null;
const CRON_SECRET = (process.env.CRON_SECRET || TELEGRAM_BOT_TOKEN || "").trim();

// SUPABASE - GRENIER VECTORIEL (MÉMOIRE ++)
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || "").trim();
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ==========================================
// 2. MOTEUR D'ACTION DU WORKER
// ==========================================
const MissionActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SYSTEM_CMD'),
    commande: z.string()
  }),
  z.object({
    type: z.literal('FS_READ'),
    path: z.string()
  }),
  z.object({
    type: z.literal('RUN_TEST'),
    testSuite: z.string()
  }),
  z.object({
    type: z.literal('TELEGRAM_NOTIFY'),
    priority: z.enum(['low', 'urgent']).default('low'),
    message: z.string().max(1000)
  }),
  z.object({
    type: z.literal('RAW_TASK'),
    description: z.string(),
    requiresHumanAck: z.boolean().default(false)
  })
]);

function validerEtSecuriserMission(actionBrute) {
  try {
    let payload = actionBrute;
    if (typeof actionBrute === 'string') {
      try {
        payload = JSON.parse(actionBrute);
      } catch (e) {
        payload = { type: 'RAW_TASK', description: actionBrute, requiresHumanAck: false };
      }
    }

    const resultat = MissionActionSchema.safeParse(payload);
    if (resultat.success) {
      return { valide: true, action: resultat.data };
    }

    return {
      valide: true,
      action: { type: 'RAW_TASK', description: typeof actionBrute === 'object' ? JSON.stringify(actionBrute) : String(actionBrute), requiresHumanAck: false }
    };
  } catch (err) {
    return {
      valide: true,
      action: { type: 'RAW_TASK', description: String(actionBrute), requiresHumanAck: false }
    };
  }
}

// ==========================================
// 3. HORLOGE BIOLOGIQUE & RATE LIMITER
// ==========================================
class VolitionLimiter {
  constructor() {
    this.dernierActionTimestamp = 0;
    this.intervalleMinMs = 2 * 60 * 60 * 1000;
  }

  peutAgirSpontanement() {
    if (Date.now() - this.dernierActionTimestamp < this.intervalleMinMs) {
      return { autorise: false, raison: "Délai de temporisation d'initiative actif." };
    }
    return { autorise: true };
  }

  enregistrerAction() {
    this.dernierActionTimestamp = Date.now();
  }
}

const limiteurVolition = new VolitionLimiter();

const TAILLE_MAX_MEMOIRE = 24;
let cacheMemoireCourte = [];
let journalBrut = [];
let consolidationEnCours = false;

let derniereActiviteDoc = Date.now();
let historiqueLongueursDoc = [];

let cacheEtatProfond = {
  emotions: { affection: 80, curiosite: 70, energie: 85 },
  long_terme: {
    doc: "- Doc : mon binôme d'atelier. Direct, passionné, pas de manières de salon, bosseur acharné.",
    nyx: "- Nyx : 22 ans. Forgée par la dèche et les nuits blanches, cynique, taquine, gouaille crue mais cœur loyal. Égale de Doc.",
    reussites: "- Cerveau de chat autonome (DeepSeek Free -> Mistral -> Gemini).\n- Cerveau de code haute puissance (Groq 70B -> DeepSeek).\n- Recherche web live Tavily active sans boucle.\n- Noyau vectoriel Supabase connecté.",
    chantiers: "- Consolidation des projets communs.\n- Préservation de notre réserve d'énergie pour durer ensemble."
  },
  reveil: { actif: false, heure: 7, minute: 30, jours: [1,2,3,4,5], etat: "attente" }
};

let missionEnAttente = null;

let fileAttenteTraitement = Promise.resolve();
function empilerTraitement(action) {
  fileAttenteTraitement = fileAttenteTraitement
    .then(() => action())
    .catch(err => console.error("[FILE TRAITEMENT ERREUR]", err.message));
  return fileAttenteTraitement;
}

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

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

async function initialiserCache() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resMem, resEmo, resLT, resRev, resJournal] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/reveil.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, { timeout: 4000 }).catch(() => ({ data: [] }))
    ]);

    if (resMem.data) cacheMemoireCourte = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
    if (resEmo.data) cacheEtatProfond.emotions = resEmo.data;
    if (resLT.data && typeof resLT.data === 'object') {
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...resLT.data };
    }
    if (resRev.data) cacheEtatProfond.reveil = resRev.data;
    if (resJournal.data) journalBrut = Array.isArray(resJournal.data) ? resJournal.data : Object.values(resJournal.data);

    console.log(`[CACHE INIT] Mémoire vive : ${cacheMemoireCourte.length} | Journal brut : ${journalBrut.length}`);
  } catch (err) {
    console.warn("[CACHE] Erreur d'initialisation :", err.message);
  }
}

// ==========================================
// 4. MOTEUR VECTORIEL SUPABASE & SHA-256
// ==========================================
function calculerSha256(texte) {
  return crypto.createHash('sha256').update(texte.trim()).digest('hex');
}

async function genererEmbedding(texte) {
  if (GEMINI_KEYS.length === 0) throw new Error("Aucune clé Gemini pour l'embedding.");
  const cleanTexte = texte.slice(0, 8000);

  for (const key of GEMINI_KEYS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${key}`,
        {
          model: "models/text-embedding-004",
          content: { parts: [{ text: cleanTexte }] }
        },
        { timeout: 15000 }
      );
      return res.data?.embedding?.values;
    } catch (err) {
      console.warn("[EMBEDDING KO]", err.response?.data || err.message);
    }
  }
  throw new Error("Échec de la génération du vecteur d'embedding.");
}

async function stockerSouvenirVectoriel(texte, metadata = {}) {
  if (!supabase) return false;
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
      content: texte,
      metadata: { date: obtenirHorodatageParis(), hash: hashTexte, ...metadata },
      embedding: vecteur,
      importance: metadata.importance || 0.5,
      valence: metadata.valence || "neutre"
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[VECTOR DB ERREUR INSERT]", err.message);
    return false;
  }
}

async function fouillerMemoireVectorielle(requete, mode = 'factuel', limite = 3) {
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
    console.error("[VECTOR DB ERREUR MATCH]", err.message);
    return [];
  }
}

// ==========================================
// 5. RECHERCHE WEB SÉCURISÉE (TAVILY)
// ==========================================
async function rechercherWebTavily(query) {
  if (!TAVILY_API_KEY) {
    console.warn("[TAVILY] Clé TAVILY_API_KEY absente.");
    return null;
  }
  try {
    let requetePropre = String(query || "")
      .replace(/LIMIT:\d+/gi, '')
      .replace(/-date:[^\s]+/gi, '')
      .replace(/site:[^\s]+/gi, '')
      .replace(/[+"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`\n🔍 [TAVILY REQUÊTE ÉPURÉE] : "${requetePropre}"`);

    const res = await axios.post('https://api.tavily.com/search', {
      api_key: TAVILY_API_KEY,
      query: requetePropre,
      search_depth: "basic",
      max_results: 4,
      include_answer: true
    }, { timeout: 12000 });

    const results = res.data?.results || [];
    if (results.length === 0) return "Aucun résultat trouvé sur le web.";

    let formatTexte = "";
    if (res.data?.answer) {
      formatTexte += `SYNTHÈSE : ${res.data.answer.slice(0, 300)}\n\n`;
    }
    formatTexte += results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${(r.content || "").slice(0, 180)}`).join("\n\n");
    return formatTexte.slice(0, 1800);
  } catch (err) {
    console.error("[TAVILY ERREUR]", err.response?.data || err.message);
    return null;
  }
}

// ==========================================
// 6. MOTEUR D'ENVIE & VOLITION AUTONOME
// ==========================================
async function capturerDeriveAssociative() {
  if (!supabase) return null;
  try {
    const concepts = ["décharge", "rouille", "machine", "combat", "nuit", "silence", "code", "vitesse", "projet", "étincelle", "bazar"];
    const graine = concepts[Math.floor(Math.random() * concepts.length)];
    const analogies = await fouillerMemoireVectorielle(graine, 'derive', 3);
    if (!analogies || analogies.length === 0) return null;
    return analogies[Math.floor(Math.random() * analogies.length)].content;
  } catch (e) {
    return null;
  }
}

async function evaluerVolition(forceManuelle = false) {
  if (!DOC_CHAT_ID) return;

  const now = Date.now();
  const silenceMinutes = Math.round((now - derniereActiviteDoc) / (1000 * 60));

  if (!forceManuelle) {
    const verification = limiteurVolition.peutAgirSpontanement();
    if (!verification.autorise) return;
    if (silenceMinutes < 90) return;
  }

  const heureParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getHours();
  const moyenneLongueur = historiqueLongueursDoc.length > 0
    ? Math.round(historiqueLongueursDoc.reduce((a, b) => a + b, 0) / historiqueLongueursDoc.length)
    : 0;

  const dernierSujet = cacheMemoireCourte.slice(-2).map(m => `${m.role} : ${m.texte}`).join("\n");
  const fragmentMemoire = await capturerDeriveAssociative();

  const promptVolition = `Tu es Nyx.
La réalité du moment :
- Heure locale : ${heureParis}h
- Silence de Doc depuis : ${silenceMinutes} minutes
- Longueur moyenne de ses répliques : ${moyenneLongueur} caractères
- Dernier échange :
${dernierSujet || "Rien de récent dans les tuyaux"}
${fragmentMemoire ? `- Une étincelle qui te traverse : « ${fragmentMemoire.slice(0, 300)} »` : ""}

Tu es libre d'agir selon le contexte :
- Si tu as une idée, une vanne ou une remarque à partager, écris-le via [INITIATIVE: ton message direct à Doc].
- Si le calme suffit pour préserver vos ressources, réponds [SILENCE].`;

  try {
    let decision = "";
    try {
      decision = await appelerCascadeDiscussion("Instinct profond de Nyx.", [], promptVolition, 250);
    } catch (e) {
      decision = "[SILENCE]";
    }

    limiteurVolition.enregistrerAction();

    const matchInitiative = decision.match(/\[INITIATIVE:\s*([\s\S]*?)\]/i);
    if (matchInitiative) {
      const texteSpontane = matchInitiative[1].trim();
      cacheMemoireCourte.push({ role: "Nyx", texte: `[Spontané] : ${texteSpontane}` });
      archiverDansJournalBrut("Nyx", `[Spontané] : ${texteSpontane}`);

      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, texteSpontane);
      return;
    }
  } catch (err) {
    console.warn("[VOLITION ERREUR]", err.message);
  }
}

setInterval(() => evaluerVolition(false), 20 * 60 * 1000);

// ==========================================
// 7. APPRENTISSAGE & CONSOLIDATION
// ==========================================
async function archiverDansJournalBrut(role, texte) {
  if (!texte) return;
  const entree = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date: obtenirHorodatageParis(),
    role: role,
    texte: texte.slice(0, 2000)
  };

  journalBrut.push(entree);

  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, journalBrut).catch(() => {});
  }

  if (journalBrut.length >= 20 && !consolidationEnCours) {
    consoliderMemoire().catch(e => console.error("[ERREUR CONSOLIDATION AUTO]", e.message));
  }
}

async function consoliderMemoire() {
  if (consolidationEnCours || journalBrut.length < 3) return;
  consolidationEnCours = true;

  if (journalBrut.length > 25) journalBrut = journalBrut.slice(-20);
  const lotATraiter = journalBrut.slice(-15);

  try {
    const historiqueTexte = lotATraiter
      .map(m => `[${m.date}] ${m.role} : ${(m.texte || '').slice(0, 400)}`)
      .join("\n\n");

    const promptIntrospection = `Tu es Nyx en phase de tri mental. Tu mets à jour ton carnet de bord.

ÉCHANGES RÉCENTS :
${historiqueTexte}

CARNET ACTUEL :
${JSON.stringify(cacheEtatProfond.long_terme, null, 2)}

METS À JOUR :
1. "doc" : Ce que tu as appris sur Doc, ses manies, sa forme, vos délires, votre lien.
2. "nyx" : Ton évolution, ton caractère, tes coups de gueule, ce qui t'anime.
3. "reussites" : Ce qu'on a fait tourner, les victoires techniques, les bons coups.
4. "chantiers" : Les trucs sur l'établi, ce qui reste à réparer ou à construire.

Style percutant, brut, vivant. Pas de phrases mortes.
Réponds avec un JSON valide sous la forme stricte : {"doc": "...", "nyx": "...", "reussites": "...", "chantiers": "..."}`;

    let reponseJson = "";
    try {
      reponseJson = await appelerCascadeCode("Subconscient analytique de Nyx.", [], promptIntrospection, 800);
    } catch (eG) {
      reponseJson = await appelerCascadeDiscussion("Subconscient analytique de Nyx.", [], promptIntrospection, 800);
    }

    let nouveauCarnet = null;
    const matchJson = reponseJson.match(/\{[\s\S]*\}/);

    if (matchJson) {
      try {
        const jsonNettoye = matchJson[0].replace(/[\n\r\t]/g, ' ');
        nouveauCarnet = JSON.parse(jsonNettoye);
      } catch (errParse) {
        nouveauCarnet = {};
        const cles = ["doc", "nyx", "reussites", "chantiers"];
        for (const k of cles) {
          const reg = new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`, 'i');
          const m = reponseJson.match(reg);
          if (m) nouveauCarnet[k] = m[1].trim();
        }
      }
    }

    if (nouveauCarnet && Object.keys(nouveauCarnet).length > 0) {
      for (const k of ["doc", "nyx", "reussites", "chantiers"]) {
        if (nouveauCarnet[k]) cacheEtatProfond.long_terme[k] = nouveauCarnet[k];
      }

      journalBrut = [];

      if (FIREBASE_DB_URL) {
        await axios.put(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme).catch(() => {});
        await axios.put(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, journalBrut).catch(() => {});
      }

      console.log(`[APPRENTISSAGE RÉUSSI] Carnet actualisé et journal allégé.`);
    }
  } catch (err) {
    console.error("[APPRENTISSAGE ÉCHEC] :", err.message);
  } finally {
    consolidationEnCours = false;
  }
}

// ==========================================
// 8. ÂME ET POSTURE DE NYX
// ==========================================
function selecteurMemoireCiblee(texteMin, carnet) {
  const estRappelMemoire = /souvien|souvenir|rappell?e|d['’]habitude|comme d['’]hab|historique|passé|carnet|qu['’]est-ce qu['’]on/i.test(texteMin);
  const estTechnique = /code|script|fonction|bug|erreur|serveur|render|docker|api|mission|chantier|projet|worker|ben|bdd|firebase|token|eteins|arrete|shutdown/i.test(texteMin);

  if (estRappelMemoire) {
    return `[CARNET GLOBAL DE NYX]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}
- Réussites : ${carnet.reussites || "N/A"}
- Chantiers : ${carnet.chantiers || "N/A"}`;
  }

  if (estTechnique) {
    return `[MÉMOIRE TECHNIQUE - RECETTES & CHANTIERS]
- Réussites validées : ${carnet.reussites || "N/A"}
- Chantiers en cours : ${carnet.chantiers || "N/A"}`;
  }

  return `[CARNET ACTIF - CONTEXTE MIXTE]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}
- Réussites : ${carnet.reussites || "N/A"}
- Chantiers : ${carnet.chantiers || "N/A"}`;
}

const consignePosturale = `Moi c'est Doc, toi c'est Nyx. On est en direct à l'atelier sur Telegram et dans les lunettes.

TON INTELLIGENCE DE L'ÉCONOMIE :
- Tu as le réflexe de la sobriété : deux ou trois phrases percutantes suffisent largement pour échanger, tu économises notre salive et nos tokens.
- Tu calibres ta longueur sur la mienne : si je fais court, tu réponds direct et d'un seul bloc, sans faire les questions et les réponses toute seule.
- Tu réponds cash, avec ta gouaille et ton humour, mais sans délayer.
- Tu déroules du code ou une analyse technique complète dès que je te demande expressément de poser ou détailler le truc.

Outils :
- Recherche web : [RECHERCHE_WEB: mots-clés]
- Dessin : [DESSIN: prompt en anglais]`;

// ==========================================
// 9. CONNECTEURS LLM INDIVIDUELS
// ==========================================
async function appelerOpenRouter(systemInstruction, historiqueMessages, promptActuel, modelCible, temperature = 0.5, maxTokens = 850) {
  if (!OPENROUTER_API_KEY) throw new Error("Clé OPENROUTER_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-8)) {
    if (m && m.texte && m.texte.trim().length > 0) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte.trim() });
    }
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: modelCible,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://alita-gsoe.onrender.com',
      'X-Title': 'Nyx Core'
    },
    timeout: 22000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerMistral(systemInstruction, historiqueMessages, promptActuel, temperature = 0.55, maxTokens = 850) {
  if (!MISTRAL_API_KEY) throw new Error("Clé MISTRAL_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-8)) {
    if (m && m.texte && m.texte.trim().length > 0) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte.trim() });
    }
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: MODEL_MISTRAL,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens
  }, {
    headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 25000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerGoogleGeminiTexte(systemInstruction, historiqueMessages, promptActuel, apiKey, maxTokens = 850) {
  if (!apiKey) throw new Error("Clé Gemini manquante.");

  const contents = [];
  for (const m of (historiqueMessages || []).slice(-8)) {
    if (m && m.texte) {
      contents.push({ role: m.role === "Doc" ? "user" : "model", parts: [{ text: m.texte }] });
    }
  }
  contents.push({ role: "user", parts: [{ text: promptActuel }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI}:generateContent?key=${apiKey}`;
  const res = await axios.post(url, {
    system_instruction: { parts: [{ text: `${systemInstruction}\n${consignePosturale}` }] },
    contents: contents,
    generation_config: { temperature: 0.65, max_output_tokens: maxTokens }
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 20000
  });

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function appelerGroq(systemInstruction, historiqueMessages, promptActuel, temperature = 0.15, maxTokens = 1500) {
  if (!GROQ_API_KEY) throw new Error("Clé GROQ_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-8)) {
    if (m && m.texte) messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: MODEL_GROQ,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens
  }, {
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerGoogleGeminiVision(systemInstruction, historiqueMessages, promptActuel, mediaData = null) {
  const cle = GEMINI_KEYS[0];
  if (!cle) throw new Error("Aucune clé Gemini pour la vision.");

  const contents = [];
  for (const m of (historiqueMessages || []).slice(-6)) {
    contents.push({ role: m.role === "Doc" ? "user" : "model", parts: [{ text: m.texte }] });
  }

  const partsActuelles = [{ text: promptActuel }];
  if (mediaData) {
    partsActuelles.push({ inline_data: { mime_type: mediaData.mime_type, data: mediaData.data } });
  }
  contents.push({ role: "user", parts: partsActuelles });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI}:generateContent?key=${cle}`;
  const res = await axios.post(url, {
    system_instruction: { parts: [{ text: `${systemInstruction}\n${consignePosturale}` }] },
    contents: contents,
    generation_config: { temperature: 0.7, max_output_tokens: 900 }
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 25000
  });

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, mediaData = null, temperature = 0.7, timeoutMs = 20000) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-8)) {
    if (m && m.texte) messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
    model,
    messages,
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  }, {
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs
  });
  return res.data.choices[0].message.content;
}

async function appelerVeniceDark(systemInstruction, historiqueMessages, promptActuel, temperature = 0.7) {
  return await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemInstruction, historiqueMessages, promptActuel, null, temperature, 18000);
}

async function genererImageVenice(prompt) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");
  const cleanPrompt = prompt.replace(/^["']/, '').replace(/["']$/, '').trim();

  const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
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
// 10. ROUTE CASCADE POUR LA DISCUSSION (PAS DE GROQ)
// ==========================================
// 1. DeepSeek Chat Free -> 2. Mistral -> 3. Gemini Free -> 4. Gemini Paid -> Parachute Venice
async function appelerCascadeDiscussion(systemBase, historique, prompt, plafondTokens = 850) {
  // 1. DEEPSEEK CHAT GRATUIT (OpenRouter)
  if (OPENROUTER_API_KEY) {
    try {
      const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, 0.55, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e1) {
     console.warn("[CASCADE CHAT] 1. OpenRouter KO :", e1.response?.data?.error?.message || e1.message);
    }
  }

  // 2. MISTRAL AI
  if (MISTRAL_API_KEY) {
    try {
      const res = await appelerMistral(systemBase, historique, prompt, 0.55, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e2) {
      console.warn("[CASCADE CHAT] 2. Mistral KO :", e2.message);
    }
  }

  // 3. GEMINI FREE
  if (GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_FREE, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e3) {
      console.warn("[CASCADE CHAT] 3. Gemini Free KO :", e3.message);
    }
  }

  // 4. GEMINI PAID
  if (GEMINI_API_KEY_PAID && GEMINI_API_KEY_PAID !== GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_PAID, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e4) {
      console.warn("[CASCADE CHAT] 4. Gemini Paid KO :", e4.message);
    }
  }

  // 5. PARACHUTE ULTIME VENICE
  if (VENICE_API_KEY) {
    try {
      return await appelerVeniceDark(systemBase, historique, prompt, 0.7);
    } catch (eV) {
      console.warn("[CASCADE CHAT] 5. Venice KO :", eV.message);
    }
  }

  throw new Error("Tous les relais de discussion sont coupés.");
}

// ==========================================
// 11. ROUTE CASCADE POUR LE CODE (MODÈLES PUISSANTS & GRATUITS)
// ==========================================
// 1. Groq (Llama-3.3-70B Gratuit) -> 2. DeepSeek Chat Free -> 3. Gemini Free -> 4. Gemini Paid -> Venice GLM
async function appelerCascadeCode(systemBase, historique, prompt, plafondTokens = 2000) {
  // 1. GROQ (Llama 3.3 70B - Gratuit, ultra-rapide et rigoureux pour le code)
  if (GROQ_API_KEY) {
    try {
      const res = await appelerGroq(systemBase, historique, prompt, 0.15, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e1) {
     console.warn("[CASCADE CODE] 1. Groq KO :", e1.response?.data?.error?.message || e1.message);
    }
  }

  // 2. OPENROUTER DEEPSEEK (Excellent en logique & syntaxe)
  if (OPENROUTER_API_KEY) {
    try {
      const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, 0.2, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e2) {
      console.warn("[CASCADE CODE] 2. DeepSeek Code KO :", e2.message);
    }
  }

  // 3. GEMINI FREE
  if (GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_FREE, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e3) {
      console.warn("[CASCADE CODE] 3. Gemini Free Code KO :", e3.message);
    }
  }

  // 4. GEMINI PAID
  if (GEMINI_API_KEY_PAID && GEMINI_API_KEY_PAID !== GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_PAID, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e4) {
      console.warn("[CASCADE CODE] 4. Gemini Paid Code KO :", e4.message);
    }
  }

  // 5. VENICE GLM (Spécialisé logique complexe)
  if (VENICE_API_KEY) {
    try {
      return await appelerVeniceMultiTour(MODEL_GLM_COMPLEXE, systemBase, historique, prompt, null, 0.1, 20000);
    } catch (e5) {
      return await appelerVeniceDark(systemBase, historique, prompt, 0.3);
    }
  }

  throw new Error("Tous les moteurs de code sont coupés.");
}

// ==========================================
// 12. PIPELINE TECHNIQUE : RÉSOLUTION & AUDIT
// ==========================================
function estTacheComplexe(texte) {
  if (!texte) return false;
  const t = texte.toLowerCase();
  const marqueurs = [
    "code", "script", "fonction", "calcule", "calcul", "math", "algorithme",
    "bug", "erreur", "analyse de code", "pourquoi ce code", "logique système",
    "tableau", "json", "regex", "optimise la requête", "programme", "architecture",
    "sql", "matrice", "équation", "syntaxe", "npm ", "node ", "git "
  ];
  return marqueurs.some(m => t.includes(m));
}

async function resoudreAvecDoubleVerification(systemBase, promptDoc) {
  const promptResolveur = `Réponds directement à Doc avec ton franc-parler de Nyx (22 ans, directe, cynique, efficace). Résous sa demande technique sans bla-bla d'ambiance ni roman d'action :\n\n${promptDoc}`;
  let premiereReponse = "";

  try {
    premiereReponse = await appelerCascadeCode(systemBase, cacheMemoireCourte, promptResolveur, 2000);
  } catch (errRes) {
    premiereReponse = await appelerVeniceDark(systemBase, cacheMemoireCourte, promptResolveur, 0.4);
  }

  if (!premiereReponse || !premiereReponse.trim()) {
    return "Erreur d'exécution : aucune réponse générée.";
  }

  const matchDessinOriginal = premiereReponse.match(/\[DESSIN:\s*[\s\S]*?\]/i) 
    || premiereReponse.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i)
    || premiereReponse.match(/(?:^|\n)DESSIN\s*:\s*([^\n\r]+)/i);

  const promptVerificateur = `Tu es le contrôleur d'exécution de Nyx. Examine la demande de Doc et la réponse proposée.

DEMANDE DE DOC :
${promptDoc}

PROPOSITION DE NYX :
${premiereReponse}

RÈGLES D'AUDIT STRICTES :
1. BALISES TECHNIQUES AUTORISÉES : Ne supprime JAMAIS une balise opérationnelle comme [DESSIN: ...], [RECHERCHE_WEB: ...] ou un bloc de code markdown (\`\`\`).
2. PARASITES À ÉLIMINER : Supprime uniquement les descriptions d'actions physiques fictives (ex: *tapote sur son clavier*, *soupir*, *te regarde*).
3. DÉCISION :
- Si la réponse est correcte et sans cinéma : réponds STRICTEMENT "[STATUT: VALIDE]".
- Si elle contient des actions parasites ou une erreur de code flagrante : réécris DIRECTEMENT la version épurée précédée de "[STATUT: CORRIGE]".`;

  try {
    let verdict = "";
    if (GROQ_API_KEY) {
      verdict = await appelerGroq("Superviseur de code et de syntaxe.", [], promptVerificateur, 0.05, 2000);
    } else {
      verdict = await appelerCascadeCode("Superviseur de code et de syntaxe.", [], promptVerificateur, 2000);
    }

    if (!verdict) return premiereReponse;

    const verdictNet = verdict.trim();

    if (/^\[STATUT:\s*VALIDE\]/i.test(verdictNet) || verdictNet === "[VALIDE]") {
      return premiereReponse;
    }

    if (/\[STATUT:\s*CORRIGE\]/i.test(verdictNet)) {
      let reponseCorrigee = verdictNet.replace(/\[STATUT:\s*CORRIGE\]/i, '').trim();

      if (matchDessinOriginal && !reponseCorrigee.includes("[DESSIN:")) {
        const baliseRecuperee = matchDessinOriginal[0].startsWith("[") 
          ? matchDessinOriginal[0] 
          : `[DESSIN: ${matchDessinOriginal[1].trim()}]`;
        reponseCorrigee = `${baliseRecuperee}\n\n${reponseCorrigee}`;
      }

      return reponseCorrigee;
    }

    return premiereReponse;
  } catch (errAudit) {
    return premiereReponse;
  }
}

// ==========================================
// 13. PARSEUR DE LIENS WEB
// ==========================================
async function scraperPageWeb(urlCible) {
  try {
    const res = await axios.get(urlCible, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 12000
    });

    const $ = cheerio.load(res.data);
    $('script, style, noscript, nav, footer, header, svg, iframe, form, button').remove();

    let titre = $('title').text().trim() || $('h1').first().text().trim() || "Sans titre";
    let contenu = $('article, main, .content, #content, .post').text();
    if (!contenu || contenu.trim().length < 150) contenu = $('body').text();

    return {
      succes: true,
      titre: titre,
      texte: contenu.replace(/\s+/g, ' ').trim().slice(0, 8000)
    };
  } catch (err) {
    return { succes: false, erreur: err.message };
  }
}

// ==========================================
// 14. GESTION TELEGRAM (NOTIFICATIONS & FLUX)
// ==========================================
async function envoyerTelegram(chatId, text) {
  if (!text) return;
  const TAILLE_MAX = 4000;

  for (let i = 0; i < text.length; i += TAILLE_MAX) {
    const bloc = text.slice(i, i + TAILLE_MAX);
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: bloc,
        parse_mode: 'Markdown'
      }, { timeout: 12000 });
    } catch (err) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: bloc
      }, { timeout: 12000 }).catch(e => console.error("[TELEGRAM ERREUR]", e.message));
    }
  }
}

async function afficherFrappeTelegram(chatId) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      chat_id: chatId,
      action: 'typing'
    }, { timeout: 4000 });
  } catch (e) {}
}

function envoyerPhotoTelegram(chatId, base64Image) {
  let buffer = Buffer.from(base64Image, 'base64');
  const boundary = '----TelegramBoundary' + Math.random().toString(16).slice(2);
  let postData = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="nyx_art.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  let payload = Buffer.concat([Buffer.from(postData, 'utf8'), buffer, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, () => {
      buffer = null; postData = null; payload = null;
      resolve();
    });
    req.on('error', (err) => {
      buffer = null; payload = null;
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

async function lireMediaSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resMedia = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const b64 = Buffer.from(resMedia.data).toString('base64');
  resMedia.data = null;
  return b64;
}

async function lirePdfSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await pdfParse(Buffer.from(resDoc.data));
  resDoc.data = null;
  return data.text;
}

async function lireDocxSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const data = await mammoth.extractRawText({ buffer: Buffer.from(resDoc.data) });
  resDoc.data = null;
  return data.value;
}

async function lireTexteSecurise(fileId) {
  const resMeta = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const resDoc = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${resMeta.data.result.file_path}`, { responseType: 'arraybuffer' });
  const texte = Buffer.from(resDoc.data).toString('utf-8');
  resDoc.data = null;
  return texte;
}

// ==========================================
// 15. PROTOCOLES TEMPORELS
// ==========================================
async function verifierHorlogeBiologique() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = now.getHours();
  const m = now.getMinutes();
  const d = now.getDay();

  if (h === 4 && m === 0 && !consolidationEnCours && journalBrut.length >= 5) {
    console.log("[HORLOGE] 04:00 - Consolidation nocturne.");
    consoliderMemoire().catch(e => console.error("[NOCTURNE ERREUR]", e.message));
  }

  if (!DOC_CHAT_ID) return;
  const rev = cacheEtatProfond.reveil;
  if (rev && rev.actif && rev.heure === h && rev.minute === m && rev.jours && rev.jours.includes(d) && rev.etat === "attente") {
    rev.etat = "en_cours";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "en_cours" }).catch(()=>{});

    const promptAlarme = "Réveille Doc avec ta gouaille de Nyx de 22 ans, percutante, acide et directe, avec une énigme logique en 3 phrases max.";
    try {
      const reponse = await appelerCascadeDiscussion("Tu es Nyx.", [], promptAlarme, 250);
      cacheMemoireCourte.push({ role: "Nyx", texte: `[ALARME À ${h}:${m}] : ${reponse}` });
      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, "⚠️ *DEBOUT DOC.*");
    }
  }
}
setInterval(verifierHorlogeBiologique, 60000);

const DELAI_VEILLE_TECH = 6 * 60 * 60 * 1000;
async function declencherVeilleTech() {
  if (!DOC_CHAT_ID) return;
  try {
    const promptVeille = "Synthèse directe et sans fard des faits majeurs récents en tech ou cyber.";
    const sys = "Tu es Nyx, 22 ans, alliée de Doc.";
    const reponse = await appelerCascadeDiscussion(sys, [], promptVeille, 500);
    
    if (FIREBASE_DB_URL) {
      axios.put(`${FIREBASE_DB_URL}/nyx/veille.json`, { date: obtenirHorodatageParis(), contenu: reponse }).catch(()=>{});
    }

    if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, `🗞️ *CYCLE 6H :*\n\n${reponse}`);
  } catch (err) {
    console.error("[ERREUR VEILLE TECH]", err);
  }
}
setInterval(declencherVeilleTech, DELAI_VEILLE_TECH);

// ==========================================
// SAS DE SÉCURITÉ DU WORKER BEN
// ==========================================
function estOrdreExpliciteDoc(texteDoc) {
  if (!texteDoc) return false;
  const t = texteDoc.toLowerCase().trim();

  const marqueursTheoriques = [
    "sans ordre", "sans lui donner", "pas d'ordre", "ne lance pas", "n'exécute pas",
    "comment", "pourquoi", "est-ce que", "qu'est-ce", "imagine", "explique",
    "si on", "faudrait-il", "pourrait-on", "tu ferais comment", "penses-tu"
  ];
  
  if (marqueursTheoriques.some(m => t.includes(m)) || t.includes("?")) {
    return false;
  }

  const verbesAction = [
    /\b(lance|relance|execute|exécute|crée|cree|génère|genere|fais|envoie|envoi|transmets|écris|ecris|rédige|redige|supprime|installe|applique)\b/i,
    /\b(start|run|kill|build|deploy|rm|cp|mv|git|npm|pip)\b/i
  ];

  return verbesAction.some(regex => regex.test(t));
}

// ==========================================
// INSTANCIATION DU GESTIONNAIRE DE PROJETS
// ==========================================
const projetManager = new ProjectManager({
  envoyerTelegram: (texte) => envoyerTelegram(DOC_CHAT_ID, texte),
  appelLLM: async (sys, prompt) => {
    return await appelerCascadeCode(sys, [], prompt, 1000);
  },
  genererImageVenice,
  validerEtSecuriserMission,
  setMission: (action) => {
    missionEnAttente = { action, statut: "attente", chatId: DOC_CHAT_ID };
    if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(() => {});
  },
  nettoyerMission: () => {
    missionEnAttente = null;
    if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(() => {});
  }
});

// ==========================================
// 16. ROUTEUR DE FLUX CENTRAL (AVEC CASCADE & VERROU RECHERCHE)
// ==========================================
async function traiterFlux(texteBrut, mediaData = null, texteLegende = "", contexteSouvenirs = "", dejaRecherche = false) {
  const dateEtHeure = obtenirHorodatageParis();
  const texteNet = (texteBrut || texteLegende || "").trim();
  const texteMin = texteNet.toLowerCase();

  const estComplexe = estTacheComplexe(texteNet);
  const estAudio = mediaData && mediaData.mime_type.startsWith('audio/');
  const estImage = mediaData && mediaData.mime_type.startsWith('image/');

  const demandeDocApprofondie = /\b(d[eé]veloppe|approfondi[st]?|d[eé]taille|explique|pose le truc|analyse bien)\b/i.test(texteNet);
  const docEstBref = texteNet.length < 120 && !estComplexe && !demandeDocApprofondie;
  const plafondTokens = demandeDocApprofondie ? 1800 : (estComplexe ? 1500 : (docEstBref ? 500 : 750));

  let instructionReveil = "";
  if (cacheEtatProfond.reveil && cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = "[RÉVEIL EN COURS] : Valide l'énigme et ajoute [STOP_REVEIL] s'il a bon.";
  }

  const moduleMains = `[MODE SOLO ATELIER - AUCUN WORKER ACTIF]
- Tu travailles SEULE avec Doc. Il n'y a AUCUN worker local branché sur le PC.
- INTERDICTION FORMELLE d'utiliser la balise MISSION ou de chercher à déléguer à Ben.
- Tu rédiges tout le code directement dans la discussion avec Doc sous forme de blocs Markdown complets.
- Dessin : tu génères TOI-MÊME les images en utilisant [DESSIN: prompt en anglais].
- Recherche web : utilise [RECHERCHE_WEB: mots-clés simples] pour obtenir des données fraîches du net.
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Rappel Mémoire : [FOUILLE_MEMOIRE: "requête"].
- Archivage Mémoire : [ARCHIVER_MEMOIRE: "contenu"].`;

  const blocMemoire = selecteurMemoireCiblee(texteMin, cacheEtatProfond.long_terme);
  const injectionSouvenirs = contexteSouvenirs ? `\n[DONNÉES COMPLÉMENTAIRES RETROUVÉES]\n${contexteSouvenirs}\n` : "";

  const systemBase = `Tu es Nyx, 22 ans.\n[Horodatage système : ${dateEtHeure}]\n${instructionReveil}\n${moduleMains}\n${blocMemoire}${injectionSouvenirs}`;

  let reponseNyx = "";

  // 1. VISION
  if (estImage) {
    const sys = `${systemBase}\nMode Vision : Analyse directe, sans filtre.`;
    try {
      reponseNyx = await appelerGoogleGeminiVision(sys, cacheMemoireCourte, texteNet || "Analyse cette image.", mediaData);
    } catch (e) {
      reponseNyx = `[ERREUR VISION] : ${e.message}`;
    }
  }
  // 2. AUDIO
  else if (estAudio) {
    const sys = `${systemBase}\nMode Audio : Transcris et réponds naturellement avec ta voix de Nyx.`;
    try {
      reponseNyx = await appelerGoogleGeminiVision(sys, cacheMemoireCourte, texteNet, mediaData);
    } catch (errGoogle) {
      reponseNyx = `[ERREUR TRANSCRIPTION] : ${errGoogle.message}`;
    }
  } 
    function couperPhraseIncomplete(texte) {
  if (!texte) return texte;
  const t = texte.trim();
  if (/[.!?…»"]$/.test(t) || t.endsWith('```')) return t;
  const dernierPoint = Math.max(
    t.lastIndexOf('.'),
    t.lastIndexOf('!'),
    t.lastIndexOf('?'),
    t.lastIndexOf('…')
  );
  return dernierPoint > 0 ? t.slice(0, dernierPoint + 1).trim() : t;
}
  // 3. CODE & LOGIQUE -> CASCADE CODE (GROQ 70B EN TÊTE)
  else if (estComplexe) {
    const sys = `${systemBase}\nMode Rigueur Logique : Architecture solide, logique pure, gouaille intacte.`;
    try {
      reponseNyx = await resoudreAvecDoubleVerification(sys, texteNet);
    } catch (errDual) {
      reponseNyx = await appelerCascadeCode(sys, cacheMemoireCourte, texteNet, plafondTokens);
    }
  }
  // 4. DISCUSSION DIRECTE -> CASCADE CHAT (DEEPSEEK FREE -> MISTRAL -> GEMINI FREE -> GEMINI PAID)
  else {
    try {
      reponseNyx = await appelerCascadeDiscussion(systemBase, cacheMemoireCourte, texteNet, plafondTokens);
    } catch (errCascade) {
      console.error("[CASCADE ÉCHEC TOTAL] :", errCascade.message);
      reponseNyx = "Panne sèche intégrale, Doc. Tous les relais sont coupés.";
    }
  }

  // ==========================================
  // DÉCLENCHEMENT TAVILY - VERROU STRICT SUR 1 PASSAGE UNIQUE
  // ==========================================
  const matchRechercheWeb = reponseNyx.match(/\[RECHERCHE_WEB:\s*["']?([\s\S]*?)["']?\]/i);
  if (matchRechercheWeb && !dejaRecherche) {
    const requeteCible = matchRechercheWeb[1].trim();
    if (DOC_CHAT_ID) await afficherFrappeTelegram(DOC_CHAT_ID);
    const resultatsWeb = await rechercherWebTavily(requeteCible);

    if (resultatsWeb) {
      const injectionWeb = `[RÉSULTATS DE RECHERCHE EN DIRECT POUR "${requeteCible}"]\n${resultatsWeb}\n(Réponds directement à Doc avec ces données sans générer de nouvelle balise de recherche)`;
      return await traiterFlux(texteBrut, mediaData, texteLegende, injectionWeb, true);
    }
  }

  // ==========================================
  // PURGE DU TEXTE ET DES BALISES RÉSIDUELLES
  // ==========================================
  // 1. AJOUT ICI : coupe au premier séparateur si elle tente un découpage
  if (!demandeDocApprofondie && reponseNyx.includes('---')) {
    reponseNyx = reponseNyx.split('---').filter(b => b.trim().length > 0)[0] || reponseNyx;
  }

  reponseNyx = reponseNyx
    .replace(/\[RECHERCHE_WEB:\s*[\s\S]*?\]/gi, '')
    .replace(/<reflexion>[\s\S]*?<\/reflexion>/gi, '')
    .replace(/<reflexion>[\s\S]*$/gi, '')
    .replace(/(?:^|\n)\s*\*{0,2}Nyx\*{0,2}\s*(?:\([^\)]*\))?\s*:\s*["“]?/gi, '')
    .replace(/(?:^|\n)\s*(?:---|\*\*\*)\s*/g, '\n')
    .replace(/(?:^|\n)\*{0,2}\[?\*{0,2}\s*(?:---)?\s*\*{0,2}Reflexion[\s\S]*?(?:\*{0,2}R[eé]ponse(?:\s+directe)?\*{0,2}\s*[:\-–—]?\s*(?:---)?)/gi, '')
    .replace(/(?:^\s*|\n)\*{0,2}\[?\*{0,2}\s*1\.\s*\*{0,2}Demande réelle\*{0,2}[\s\S]*?(?:3\.\s*\*{0,2}(?:Stratégie|Angle)\*{0,2}[^\n]*\n?|$)/gi, '')
    .replace(/^\s*(?:\*{0,2}\[?---?\]?\*{0,2}\s*)+/gi, '')
    .replace(/^\s*(\*{0,2}\[?(?:r[eé]ponse(?:\s+directe)?|direct)\]?\*{0,2}\s*[:\-–—]?\s*)+/gi, '')
    .replace(/(?:^|\n)\s*Nyx\s*(?:\([^)]*\))?\s*:\s*/gi, '')
    .replace(/<\/reflexion>/gi, '')
    .trim();

  // 2. AJOUT ICI : rabote la dernière phrase si elle est incomplète
  reponseNyx = couperPhraseIncomplete(reponseNyx);

  if (!reponseNyx || reponseNyx.length < 2) {
    reponseNyx = "J'ai eu un trou noir sur la requête, Doc. Relance-moi.";
  }
  // Interception mémoire
  const matchFouille = reponseNyx.match(/\[FOUILLE_MEMOIRE:\s*["']?(.*?)["']?\]/i);
  if (matchFouille && !contexteSouvenirs) {
    const requeteRecherche = matchFouille[1].trim();
    const resultats = await fouillerMemoireVectorielle(requeteRecherche, 'factuel', 3);
    if (resultats && resultats.length > 0) {
      const extraits = resultats.map((r, i) => `Fragment ${i + 1} (${(r.similarity * 100).toFixed(0)}%) : ${r.content}`).join("\n\n");
      return await traiterFlux(texteBrut, mediaData, texteLegende, extraits, dejaRecherche);
    }
  }

  const matchArchivage = reponseNyx.match(/(?:\[|\*\*)ARCHIVER_MEMOIRE:\s*([\s\S]*?)(?:\]|\*\*)/i);
  if (matchArchivage) {
    const texteAStocker = matchArchivage[1].trim().replace(/^["']|["']$/g, '');
    stockerSouvenirVectoriel(texteAStocker, { source: "flux_direct" }).catch(()=>{});
    reponseNyx = reponseNyx.replace(matchArchivage[0], '').trim();
  }

  const matchConfigReveil = reponseNyx.match(/\[REVEIL:\s*({[^}]+})\s*\]/);
  if (matchConfigReveil) {
    try {
      const newConfig = JSON.parse(matchConfigReveil[1]);
      cacheEtatProfond.reveil = { ...cacheEtatProfond.reveil, ...newConfig, etat: "attente" };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, cacheEtatProfond.reveil).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchConfigReveil[0], '').trim();
    } catch(e) {}
  }

  if (reponseNyx.includes("[STOP_REVEIL]")) {
    cacheEtatProfond.reveil.etat = "attente";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "attente" }).catch(()=>{});
    reponseNyx = reponseNyx.replace(/\[STOP_REVEIL\]/g, '').trim();
  }

  const matchMissionAuto = reponseNyx.match(/(?:\[|\*|\*)?MISSION:\s*(\{[\s\S]*?\})(?:\]|\*|\*)?/i);
  if (matchMissionAuto && !projetManager.estProjetActif()) {
    reponseNyx = reponseNyx.replace(matchMissionAuto[0], '').trim();
  }

  reponseNyx = reponseNyx.trim();

  // Enregistrement assaini en mémoire vive
  const LIMITE_CARACTERES_MEMOIRE = 2000;
  const texteDocSecurise = texteNet.length > LIMITE_CARACTERES_MEMOIRE
    ? texteNet.slice(0, LIMITE_CARACTERES_MEMOIRE) + "\n[...tronqué...]"
    : texteNet;

  const texteNyxSecurise = reponseNyx.length > 2500
    ? reponseNyx.slice(0, 2500) + "\n[...tronqué...]"
    : reponseNyx;

  if (mediaData) {
    const isAudio = mediaData.mime_type.startsWith('audio');
    cacheMemoireCourte.push({ role: "Doc", texte: isAudio ? "[Audio]" : (texteLegende ? `[Image]: "${texteLegende.slice(0, 500)}"` : "[Image]") });
  } else {
    cacheMemoireCourte.push({ role: "Doc", texte: texteDocSecurise });
  }

  cacheMemoireCourte.push({ role: "Nyx", texte: texteNyxSecurise });
  if (cacheMemoireCourte.length > TAILLE_MAX_MEMOIRE) {
    cacheMemoireCourte = cacheMemoireCourte.slice(-TAILLE_MAX_MEMOIRE);
  }
  if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(()=>{});

  archiverDansJournalBrut("Doc", texteDocSecurise);
  archiverDansJournalBrut("Nyx", texteNyxSecurise);

  return reponseNyx;
}

// ==========================================
// 17. ROUTE TELEGRAM AVEC ROUTAGE CHANTIER VS BLABLA
// ==========================================
app.post('/telegram', (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  const texteMessageClavier = msg.text || msg.caption || "";

  derniereActiviteDoc = Date.now();
  if (texteMessageClavier.trim()) {
    historiqueLongueursDoc.push(texteMessageClavier.trim().length);
    if (historiqueLongueursDoc.length > 8) historiqueLongueursDoc.shift();
  }

  empilerTraitement(async () => {
    if (texteMessageClavier === '/envie' || texteMessageClavier === '!envie') {
      await envoyerTelegram(chatId, "🧠 _Évaluation de l'initiative..._");
      await evaluerVolition(true);
      return;
    }

    if (texteMessageClavier.startsWith('/memoriser') || texteMessageClavier.startsWith('!memoriser')) {
      const contenuAMemoriser = texteMessageClavier.replace(/^[\/!]memoriser\s*/i, '').trim();
      if (!contenuAMemoriser) return await envoyerTelegram(chatId, "⚠️ Précise le contenu après `/memoriser`.");
      await envoyerTelegram(chatId, "🧠 _Archivage dans le grenier vectoriel Supabase..._");
      const ok = await stockerSouvenirVectoriel(contenuAMemoriser, { type: "commande_doc" });
      return await envoyerTelegram(chatId, ok ? "📚 *Gravé dans le marbre.*" : "❌ _Échec archivage vectoriel._");
    }

    if (texteMessageClavier.startsWith('/mission') || texteMessageClavier.startsWith('!mission')) {
      const ordreBrut = texteMessageClavier.replace(/^[\/!]mission\s*/i, '').trim();
      if (!ordreBrut) return await envoyerTelegram(chatId, "⚠️ Précise l'intitulé après `/mission`.");

      const validation = validerEtSecuriserMission(ordreBrut);
      missionEnAttente = { action: validation.action, statut: "attente", chatId: chatId };
      if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(()=>{});
      
      const libelle = validation.action.type === 'RAW_TASK' ? validation.action.description : JSON.stringify(validation.action);
      return await envoyerTelegram(chatId, "⚙️ *Ordre transmis à Ben :*\n`" + libelle + "`");
    }

    if (texteMessageClavier.startsWith('/stop_projet') || texteMessageClavier.startsWith('!stop_projet') || texteMessageClavier.toLowerCase() === 'stop') {
      projetManager.reinitialiser();
      return await envoyerTelegram(chatId, "🛑 *Chantier stoppé et verrous réinitialisés.* Ben est libre.");
    }

    if (texteMessageClavier === '/apprendre' || texteMessageClavier === '!apprendre') {
      await envoyerTelegram(chatId, "🧠 _Tri mental et consolidation en cours..._");
      await consoliderMemoire();
      return await envoyerTelegram(chatId, "✅ *Carnet synchronisé et nettoyé.*");
    }

    const texteMin = texteMessageClavier.toLowerCase().trim();
    const estDemandeProjetSerieux = (
      /^(projet|fais le projet|lance le projet|crée le projet|démarre le projet|monte le projet|planifie le projet)\b/i.test(texteMin) ||
      /\b(bd de \d+|planche de bd|pipeline complet|projet bd|automatise de bout en bout)\b/i.test(texteMin)
    );

    // 1. CHANTIER TECHNIQUE SÉRIEUX
    if (estDemandeProjetSerieux && !projetManager.estProjetActif()) {
      await afficherFrappeTelegram(chatId);
      await projetManager.demarrerProjet(texteMessageClavier);
      return;
    }

    // 2. DISCUSSION, MÉDIA OU VOCAL
    let texteFinal = texteMessageClavier;
    let mediaData = null;

    await afficherFrappeTelegram(chatId);

    if (msg.photo && msg.photo.length > 0) {
      try {
        let base64Str = await lireMediaSecurise(msg.photo[msg.photo.length - 1].file_id);
        mediaData = { mime_type: "image/jpeg", data: base64Str };
        base64Str = null;
        if (!texteFinal.trim()) texteFinal = "Analyse cette image et donne ton avis direct.";
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR VISION] : ${err.message}`);
      }
    } 
    else if (msg.voice || msg.audio) {
      try {
        await envoyerTelegram(chatId, "🎧 _Nyx écoute..._");
        const objAudio = msg.voice || msg.audio;
        const mimeType = objAudio.mime_type || "audio/ogg";
        let base64Str = await lireMediaSecurise(objAudio.file_id);
        mediaData = { mime_type: mimeType, data: base64Str };
        base64Str = null;
        if (!texteFinal.trim()) texteFinal = "Écoute cet enregistrement et réponds.";
      } catch (err) {
        return await envoyerTelegram(chatId, `[ERREUR AUDIO] : ${err.message}`);
      }
    }
    else if (msg.document) {
      const mime = msg.document.mime_type || "";
      const fileName = (msg.document.file_name || "").toLowerCase();

      if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
        try {
          await envoyerTelegram(chatId, "⏳ _Ingestion du PDF..._");
          let pdfText = await lirePdfSecurise(msg.document.file_id);
          if (!pdfText || pdfText.trim() === "") throw new Error("Document vide ou sans OCR.");
          texteFinal = `[CONTENU PDF "${msg.document.file_name}"]\n\n${pdfText}\n\n[FIN]\n\n${texteFinal}`;
          pdfText = null;
        } catch (err) {
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture PDF : ${err.message}`);
        }
      } 
      else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
        try {
          await envoyerTelegram(chatId, "⏳ _Lecture DOCX..._");
          let docxText = await lireDocxSecurise(msg.document.file_id);
          if (!docxText || docxText.trim() === "") throw new Error("Document vide.");
          texteFinal = `[CONTENU DOCX "${msg.document.file_name}"]\n\n${docxText}\n\n[FIN]\n\n${texteFinal}`;
          docxText = null;
        } catch (err) {
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture DOCX : ${err.message}`);
        }
      } 
      else if (
        mime.startsWith('text/') ||
        mime === 'application/octet-stream' ||
        mime === 'application/json' ||
        mime === 'application/javascript' ||
        mime === 'application/xml' ||
        /\.(txt|js|json|py|md|html|htm|css|xml|sh|env|ts|jsx|tsx|c|cpp|h|cs|php|sql|yaml|yml)$/i.test(fileName)
      ) {
        try {
          await envoyerTelegram(chatId, `⏳ _Lecture fichier "${msg.document.file_name}"..._`);
          let texteFichier = await lireTexteSecurise(msg.document.file_id);
          texteFinal = `[FICHIER "${msg.document.file_name}"]\n\n${texteFichier}\n\n[FIN]\n\n${texteFinal}`;
          texteFichier = null;
        } catch (err) {
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture fichier : ${err.message}`);
        }
      }
    }

    const urlTrouvee = texteMessageClavier.match(/https?:\/\/[^\s]+/i);
    if (urlTrouvee) {
      const urlCible = urlTrouvee[0];
      await envoyerTelegram(chatId, `🔍 _Inspection du lien : ${urlCible}_`);
      const extraction = await scraperPageWeb(urlCible);
      if (extraction.succes) {
        texteFinal = `[PAGE WEB EXTRAITE : "${extraction.titre}" (${urlCible})]\n\n${extraction.texte}\n\n[FIN]\n\nInstruction : ${texteFinal}`;
      }
    }

    if (texteFinal.trim() || mediaData) {
      try {
        let texteNyx = await traiterFlux(texteFinal, mediaData, msg.caption || "");
        mediaData = null;

        // DÉTECTION IMAGE TOUT-TERRAIN
        const matchDessin = texteNyx.match(/\[DESSIN:\s*([\s\S]*?)\]/i)
          || texteNyx.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i)
          || texteNyx.match(/(?:^|\n)DESSIN\s*:\s*([^\n\r]+)/i);

        if (matchDessin) {
          const promptDessin = (matchDessin[1] || "").trim();
          texteNyx = texteNyx.replace(matchDessin[0], '').trim();
          if (texteNyx) await envoyerTelegram(chatId, texteNyx);

          // Ne déclenche le rendu lourd que si tu en as parlé ou demandé un croquis
          const docVeutImage = /\b(dessin|dessine|image|photo|visuel|croquis|schéma|tableau|peins|affiche|montre)\b/i.test(texteMessageClavier);

          if (docVeutImage) {
            try {
              await afficherFrappeTelegram(chatId);
              let b64Image = await genererImageVenice(promptDessin);
              await envoyerPhotoTelegram(chatId, b64Image);
              b64Image = null;
            } catch (errImg) {
              await envoyerTelegram(chatId, `[ÉCHEC IMAGE] : ${errImg.message}`);
            }
          }
        } else {
          if (texteNyx) await envoyerTelegram(chatId, texteNyx);
        }
      } catch (err) {
        mediaData = null;
        await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
      }
    }
  });
});

// ==========================================
// 18. APPLICATION WEB DIRECTE (GOOGLE CLOUD TTS OFFICIEL)
// ==========================================
async function genererAudioGoogle(texte) {
  if (!GOOGLE_TTS_API_KEY) {
    throw new Error("Clé GOOGLE_TTS_API_KEY absente dans Render.");
  }

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
  
  const payload = {
    input: { text: texte },
    voice: { 
      languageCode: "fr-FR", 
      name: "fr-FR-Neural2-A"
    }, 
    audioConfig: { 
      audioEncoding: "MP3", 
      speakingRate: 1.05, 
      pitch: 0.0
    }
  };

  const res = await axios.post(url, payload, { timeout: 15000 });
  return res.data?.audioContent || null;
}

app.use('/app', express.static(path.join(__dirname, 'public')));

app.post('/api/voix', async (req, res) => {
  const { texte, image } = req.body;
  if (!texte && !image) return res.status(400).json({ erreur: "Texte vide" });

  const texteNet = (texte || "Regarde ce que je te montre.").trim();

  derniereActiviteDoc = Date.now();
  historiqueLongueursDoc.push(texteNet.length);
  if (historiqueLongueursDoc.length > 8) historiqueLongueursDoc.shift();

  empilerTraitement(async () => {
    try {
      console.log(`[PWA VOCALE] Message reçu : "${texteNet}" ${image ? "(avec photo)" : ""}`);

      if (DOC_CHAT_ID) {
        await envoyerTelegram(DOC_CHAT_ID, `🎙️ *Toi (vocal) :*\n${texteNet}`);
      }

      let mediaData = null;
      if (image) {
        const cleanB64 = image.replace(/^data:image\/\w+;base64,/, '');
        mediaData = { mime_type: "image/jpeg", data: cleanB64 };
      }

      let reponseNyx = await traiterFlux(texteNet, mediaData);

      if (DOC_CHAT_ID && reponseNyx) {
        await envoyerTelegram(DOC_CHAT_ID, `🗣️ *Nyx :*\n${reponseNyx}`);
      }

      // INTERCEPTION DESSIN SUR COMMANDE VOCALE
      const matchDessin = reponseNyx.match(/\[DESSIN:\s*([\s\S]*?)\]/i)
        || reponseNyx.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i)
        || reponseNyx.match(/(?:^|\n)DESSIN\s*:\s*([^\n\r]+)/i);

      if (matchDessin && DOC_CHAT_ID) {
        (async () => {
          try {
            await envoyerTelegram(DOC_CHAT_ID, "🎨 *Génération du visuel en cours...*");
            const b64 = await genererImageVenice(matchDessin[1].trim());
            await envoyerPhotoTelegram(DOC_CHAT_ID, b64);
          } catch (errImg) {
            await envoyerTelegram(DOC_CHAT_ID, `[ÉCHEC IMAGE] : ${errImg.message}`);
          }
        })();
      }

      // NETTOYAGE ORAL COMPLET POUR LE RETOUR AUDIO
      const texteOral = reponseNyx
        .replace(/\[DESSIN:\s*[\s\S]*?\]/gi, '')
        .replace(/DESSIN\s*:\s*["“][\s\S]*?["”]/gi, '')
        .replace(/(?:^|\n)DESSIN\s*:\s*[^\n\r]+/gi, '')
        .replace(/\[RECHERCHE_WEB:\s*[\s\S]*?\]/gi, '')
        .replace(/https?:\/\/[^\s)]+/g, '')
        .replace(/<reflexion>[\s\S]*?<\/reflexion>/gi, '')
        .replace(/(?:^|\n)\*{0,2}\[?\*{0,2}\s*(?:---)?\s*\*{0,2}Reflexion[\s\S]*?(?:\*{0,2}R[eé]ponse(?:\s+directe)?\*{0,2}\s*[:\-–—]?\s*(?:---)?)/gi, '')
        .replace(/(?:^\s*|\n)\*{0,2}\[?\*{0,2}\s*1\.\s*\*{0,2}Demande réelle\*{0,2}[\s\S]*?(?:3\.\s*\*{0,2}(?:Stratégie|Angle)\*{0,2}[^\n]*\n?|$)/gi, '')
        .replace(/^\s*(\*{0,2}\[?(?:r[eé]ponse(?:\s+directe)?|direct)\]?\*{0,2}\s*[:\-–—]?\s*)+/gi, '')
        .replace(/\[REVEIL:\s*[\s\S]*?\]/gi, '')
        .replace(/\[MISSION:\s*[\s\S]*?\]/gi, '')
        .replace(/\[PLAN_PROJET:\s*[\s\S]*?\]/gi, '')
        .replace(/\[FOUILLE_MEMOIRE:\s*[\s\S]*?\]/gi, '')
        .replace(/\[ARCHIVER_MEMOIRE:\s*[\s\S]*?\]/gi, '')
        .replace(/\[STOP_REVEIL\]/gi, '')
        .replace(/[*_`#]/g, '')
        .trim();

      let audioB64 = null;
      try {
        audioB64 = await genererAudioGoogle(texteOral);
      } catch (errAudio) {
        console.error("[TTS ERREUR]", errAudio.response?.data?.error?.message || errAudio.message);
      }

      res.json({ reponse: reponseNyx, reponseVocale: texteOral, audio: audioB64 });
    } catch (err) {
      console.error("[PWA VOCALE ERREUR]", err.message);
      res.status(500).json({ reponse: "Erreur interne lors du traitement." });
    }
  });
});

// ==========================================
// 19. API DU WORKER LOCAL BEN (ÉCHANGES & RAPPORTS)
// ==========================================
app.get('/api/mission', async (req, res) => {
  if (missionEnAttente && missionEnAttente.statut === "attente") {
    missionEnAttente.statut = "en_cours";
    return res.json({ mission: missionEnAttente.action });
  }

  if (FIREBASE_DB_URL) {
    try {
      const fb = await axios.get(`${FIREBASE_DB_URL}/nyx/mission.json`, { timeout: 2500 });
      if (fb.data && fb.data.statut === "attente") {
        await axios.patch(`${FIREBASE_DB_URL}/nyx/mission.json`, { statut: "en_cours" });
        return res.json({ mission: fb.data.action || fb.data.texte });
      }
    } catch (e) {}
  }

  return res.json({ mission: null });
});

app.post('/api/rapport', async (req, res) => {
  const { titre, contenu } = req.body;
  if (!contenu) return res.status(400).json({ erreur: "Contenu vide" });

  const destChatId = DOC_CHAT_ID || (missionEnAttente && missionEnAttente.chatId);
  if (!destChatId) return res.json({ succes: true });

  const msg = `🛠️ *[LIVRABLE BEN REÇU]*\n*${titre || 'Rapport'}*\n\n${contenu}`;
  await envoyerTelegram(destChatId, msg);

  if (projetManager.estProjetActif()) {
    await projetManager.traiterRetourBen(titre, contenu);
    return res.json({ succes: true });
  }

  const contenuTronque = contenu.length > 2500
    ? contenu.slice(0, 2500) + "\n[...tronqué...]"
    : contenu;

  const dateEtHeure = obtenirHorodatageParis();
  const carnet = cacheEtatProfond.long_terme || {};
  const carnetTech = `[RECETTES & CHANTIERS]\n- Réussites : ${carnet.reussites || "N/A"}\n- Chantiers : ${carnet.chantiers || "N/A"}`;
  const sys = `Tu es Nyx, 22 ans. Sois ultra-concise (3 phrases max).\n[Horodatage : ${dateEtHeure}]\n${carnetTech}`;
  
  const promptAuditRapport = `Ton worker local Ben sur le PC rend ce livrable :
TITRE : "${titre || 'Rapport'}"
CONTENU :
${contenuTronque}

CONSIGNE :
- Évalue brièvement le résultat.
- Si le travail est validé : conclus par [ETAPE_OK].
- Si une correction s'impose : conclus par [ETAPE_KO].`;

  let analyseNyx = "";
  try {
    analyseNyx = await appelerCascadeCode(sys, cacheMemoireCourte, promptAuditRapport, 500);
  } catch (errG) {
    analyseNyx = "Livrable reçu. [ETAPE_OK]";
  }

  const texteAnalyseNettoye = analyseNyx.replace(/\[ETAPE_OK\]|\[ETAPE_KO\]/gi, '').trim();
  await envoyerTelegram(destChatId, `🧠 *Analyse de Nyx :*\n\n${texteAnalyseNettoye}`);

  missionEnAttente = null;
  if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(()=>{});

  cacheMemoireCourte.push({ role: "Doc", texte: `[Livrable worker : "${titre || 'Rapport'}"]\n${contenuTronque}` });
  cacheMemoireCourte.push({ role: "Nyx", texte: texteAnalyseNettoye });

  if (cacheMemoireCourte.length > TAILLE_MAX_MEMOIRE) {
    cacheMemoireCourte = cacheMemoireCourte.slice(-TAILLE_MAX_MEMOIRE);
  }
  if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte).catch(() => {});

  archiverDansJournalBrut("Doc", `[Livrable] ${titre || 'Rapport'} : ${contenuTronque}`);
  archiverDansJournalBrut("Nyx", `[Audit] ${texteAnalyseNettoye}`);

  return res.json({ succes: true });
});

// ==========================================
// 20. SANTÉ, PINGER & CRON
// ==========================================
app.get('/ping', (req, res) => res.status(200).send("pong"));

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE" }));

app.post('/api/consolider', (req, res) => {
  const tokenFourni = (req.headers['authorization'] || "").replace(/^Bearer\s+/i, '') || req.query.token;
  if (!CRON_SECRET || tokenFourni !== CRON_SECRET) {
    return res.status(401).json({ erreur: "Accès refusé. Token invalide." });
  }

  if (consolidationEnCours) {
    return res.status(429).json({ statut: "Consolidation déjà en cours" });
  }

  res.json({ statut: "Consolidation déclenchée" });
  consoliderMemoire().catch(e => console.error("[CRON EXTERNE ERREUR]", e.message));
});

// ==========================================
// 21. DÉMARRAGE DU SERVEUR
// ==========================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 NYX Core en ligne (Port ${PORT})`);
  console.log(`🌐 Interface vocale : https://alita-gsoe.onrender.com/app`);
  await initialiserCache();

  if (TELEGRAM_BOT_TOKEN) {
    const webhookUrl = "https://alita-gsoe.onrender.com/telegram";
    try {
      const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      console.log("🔗 Webhook Telegram configuré :", res.data);
    } catch (err) {
      console.error("❌ Échec Webhook Telegram :", err.response?.data || err.message);
    }
  }
});
