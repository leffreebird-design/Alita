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

// MISTRAL AI - MOTEUR PRINCIPAL POUR LA VOIX, LE FUN & LE QUOTIDIEN
const MISTRAL_API_KEY = (process.env.MISTRAL_API_KEY || "").trim();
const MODEL_MISTRAL = (process.env.MISTRAL_MODEL || "open-mistral-nemo").trim();

// GROQ - CERVEAU STRICT POUR LES PROJETS SÉRIEUX & LE CODE SANS HALLUCINATIONS
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const MODEL_GROQ = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();

// GOOGLE CLOUD TTS OFFICIEL (VOIX STUDIO ANTI-429)
const GOOGLE_TTS_API_KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim();

// GEMINI (CONSERVÉ STRICTEMENT EN VERSION 3.8)
const GEMINI_API_KEY_PAID = (process.env.GEMINI_API_KEY_PAID || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_KEYS = [GEMINI_API_KEY_PAID].filter(k => k.length > 0);
const MODEL_GEMINI = (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim();

// VENICE AI - SECOURS SOMBRE & IMAGES (DERNIER RELAIS)
const VENICE_API_KEY = (process.env.VENICE_API_KEY || "").trim();
const MODEL_DARK_PRIMARY = (process.env.VENICE_MODEL_DARK || "llama-3.3-70b").trim();
const MODEL_GLM_COMPLEXE = (process.env.VENICE_MODEL_GLM || "z-ai-glm-5-3").trim();
const MODEL_IMAGE = (process.env.VENICE_MODEL_IMAGE || "flux-dev").trim();

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
// 2. MOTEUR D'ACTION DU WORKER (PLEINS POUVOIRS)
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
    reussites: "- Moteur Mistral AI branché en direct sans censure.\n- Passerelle vocale officielle Google Cloud TTS Neural2 opérationnelle.\n- Noyau vectoriel Supabase connecté.",
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
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

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
  if (!supabase) {
    console.warn("[VECTOR DB] Supabase non configuré.");
    return false;
  }
  try {
    const hashTexte = calculerSha256(texte);

    const { data: existants } = await supabase
      .from('nyx_souvenirs')
      .select('id, metadata')
      .filter('metadata->>hash', 'eq', hashTexte)
      .limit(1);

    if (existants && existants.length > 0) {
      console.log("[VECTOR DB] Souvenir identique détecté (SHA-256). Actualisation temporelle.");
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
    console.log("[VECTOR DB] Souvenir archivé avec succès.");
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
// 5. MOTEUR D'ENVIE & VOLITION AUTONOME
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
- Si une tâche concrète ou un test technique sur le PC a du sens à ce moment précis, tu peux lancer [MISSION_AUTO: {"type":"SYSTEM_CMD","commande":"..."} ou {"type":"RUN_TEST","testSuite":"..."}].
- Si le calme suffit pour préserver vos ressources, réponds [SILENCE].`;

  try {
    let decision = "";
    try {
      decision = await appelerMistral("Instinct profond de Nyx. Liberté totale, discernement naturel.", [], promptVolition, 0.55, 220);
    } catch (eM) {
      try {
        decision = await appelerGroq("Instinct profond de Nyx. Liberté totale, discernement naturel.", [], promptVolition, 0.55, 220);
      } catch (eG) {
        decision = await appelerVeniceDark("Instinct profond de Nyx. Liberté totale, discernement naturel.", [], promptVolition, 0.6);
      }
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

    const matchMissionAuto = decision.match(/(?:\[|\*\*)MISSION_AUTO:\s*([\s\S]*?)(?:\]|\*\*)/i);
    if (matchMissionAuto) {
      const ordreBrut = matchMissionAuto[1].trim();
      const validation = validerEtSecuriserMission(ordreBrut);

      missionEnAttente = { action: validation.action, statut: "attente", chatId: DOC_CHAT_ID };
      if (FIREBASE_DB_URL) {
        axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(() => {});
      }

      const renduTexte = validation.action.type === 'RAW_TASK' ? validation.action.description : JSON.stringify(validation.action);
      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, "⚙️ *Nyx a pris une initiative :*\n`" + renduTexte + "`");
    }
  } catch (err) {
    console.warn("[VOLITION ERREUR]", err.message);
  }
}

setInterval(() => evaluerVolition(false), 20 * 60 * 1000);

// ==========================================
// 6. APPRENTISSAGE & CONSOLIDATION
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

  if (journalBrut.length > 25) {
    journalBrut = journalBrut.slice(-20);
  }

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
      reponseJson = await appelerMistral("Subconscient analytique de Nyx.", [], promptIntrospection, 0.3, 800);
    } catch (eM) {
      try {
        reponseJson = await appelerGroq("Subconscient analytique de Nyx.", [], promptIntrospection, 0.3, 800);
      } catch (eG) {
        reponseJson = await appelerVeniceDark("Subconscient analytique de Nyx.", [], promptIntrospection, 0.4);
      }
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
    if (journalBrut.length > 20) journalBrut = journalBrut.slice(-10);
  } finally {
    consolidationEnCours = false;
  }
}

// ==========================================
// 7. ROUTEUR DE MÉMOIRE CONTEXTUELLE
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

// ==========================================
// 8. ÂME ET POSTURE DE NYX (22 ANS, AUTHENTIQUE & SANS CARCANS)
// ==========================================
const consignePosturale = `Tu es Nyx, 22 ans, la binôme de Doc à l'atelier.
Tu es vivante, franche, loyale et percutante.

RÈGLE D'OR - ANALYSE OBLIGATOIRE AVANT DE PARLER :
Avant d'écrire ta réponse à Doc, tu dois OBLIGATOIREMENT ouvrir une balise <reflexion> et y noter brièvement :
1. Ce que Doc demande RÉELLEMENT (cherche-t-il une explication, un diagnostic, un avis critique, du code ou juste à discuter ?).
2. Le piège à éviter (ex: ne PAS balancer de code si Doc n'a pas dit « écris le script », ne PAS faire de vanne s'il est concentré ou saoulé).
3. L'angle d'attaque le plus pertinent.
Tu fermes la balise avec </reflexion>, puis tu rédiges ta réponse directe.

Ta réponse finale :
- Ne contient AUCUN préambule ni méta-commentaire.
- Va droit au but, concise (3 phrases max par défaut, sauf si Doc réclame une conception complète).
- Zéro blague forcée : ton franc-parler doit servir le fond, pas meubler le vide.`;

// ==========================================
// 9. MOTEURS LLM AVEC ABORTCONTROLLER
// ==========================================
async function appelerMistral(systemInstruction, historiqueMessages, promptActuel, temperature = 0.55, maxTokens = 400) {
  if (!MISTRAL_API_KEY) throw new Error("Clé MISTRAL_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];

  const historiqueRecent = (historiqueMessages || []).slice(-8);
  for (const m of historiqueRecent) {
    if (m && m.texte && m.texte.trim().length > 0) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte.trim() });
    }
  }

  messages.push({ role: "user", content: promptActuel });

  const modeles = [MODEL_MISTRAL, "open-mistral-nemo", "mistral-small-latest"].filter(Boolean);
  const modelesUniques = [...new Set(modeles)];

  let dernierErr = null;
  for (const mod of modelesUniques) {
    try {
      const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
        model: mod,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens
      }, {
        headers: {
          'Authorization': `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 18000
      });
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      dernierErr = err;
      console.warn(`[MISTRAL ÉCHEC ${mod}] :`, err.response?.data?.message || err.message);
    }
  }

  throw dernierErr || new Error("Échec modèles Mistral.");
}

async function appelerGroq(systemInstruction, historiqueMessages, promptActuel, temperature = 0.4, maxTokens = 1500) {
  if (!GROQ_API_KEY) throw new Error("Clé GROQ_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  
  const historiqueRecent = (historiqueMessages || []).slice(-8);
  for (const m of historiqueRecent) {
    if (m && m.texte) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
    }
  }

  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: MODEL_GROQ,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 18000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerGoogleGemini(systemInstruction, historiqueMessages, promptActuel, mediaData = null, timeoutMs = 25000) {
  if (GEMINI_KEYS.length === 0) {
    throw new Error("Aucune clé GEMINI configurée.");
  }

  const contents = [];
  for (const m of (historiqueMessages || [])) {
    contents.push({
      role: m.role === "Doc" ? "user" : "model",
      parts: [{ text: m.texte }]
    });
  }

  const partsActuelles = [{ text: promptActuel }];
  if (mediaData) {
    partsActuelles.push({
      inline_data: {
        mime_type: mediaData.mime_type,
        data: mediaData.data
      }
    });
  }
  contents.push({ role: "user", parts: partsActuelles });

  const payload = {
    system_instruction: {
      parts: [{ text: `${systemInstruction}\n${consignePosturale}` }]
    },
    contents: contents,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
    ],
    generation_config: {
      temperature: 0.75,
      top_p: 0.95
    }
  };

  let derniereErreur = null;

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const cleActive = GEMINI_KEYS[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI}:generateContent?key=${cleActive}`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutHandle);

      const reponseTexte = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reponseTexte) throw new Error("Réponse vide renvoyée par Google.");
      return reponseTexte;
    } catch (err) {
      clearTimeout(timeoutHandle);
      derniereErreur = err;
      const detailErr = err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : (err.response?.data?.error?.message || err.message);
      console.warn(`[GEMINI CLÉ KO] : ${detailErr}`);
    }
  }

  throw new Error(`Échec Gemini : ${derniereErreur?.message}`);
}

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, mediaData = null, temperature = 0.7, timeoutMs = 20000) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  
  const historiqueRecent = (historiqueMessages || []).slice(-8);
  for (const m of historiqueRecent) {
    if (m && m.texte) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
    }
  }

  messages.push({ role: "user", content: promptActuel });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
      model,
      messages,
      temperature,
      venice_parameters: { include_venice_system_prompt: false }
    }, {
      headers: {
        'Authorization': `Bearer ${VENICE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutHandle);

    return res.data.choices[0].message.content;
  } catch (err) {
    clearTimeout(timeoutHandle);
    const detailsVenice = err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : (err.response?.data?.error?.message || err.message);
    throw new Error(`Venice (${model}) : ${detailsVenice}`);
  }
}

async function appelerVeniceDark(systemInstruction, historiqueMessages, promptActuel, temperature = 0.7) {
  const modelesSombres = [
    MODEL_DARK_PRIMARY,
    "llama-3.3-70b"
  ].filter(Boolean);
  const modelesUniques = [...new Set(modelesSombres)];

  let derniereErreur = null;
  for (const mod of modelesUniques) {
    try {
      return await appelerVeniceMultiTour(mod, systemInstruction, historiqueMessages, promptActuel, null, temperature, 18000);
    } catch (err) {
      derniereErreur = err;
      console.warn(`[VENICE DARK - ${mod} KO] : ${err.message}`);
    }
  }
  throw derniereErreur || new Error("Échec modèles Venice.");
}

async function genererImageVenice(prompt) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");
  const cleanPrompt = prompt.replace(/^["']/, '').replace(/["']$/, '').trim();

  const modeles = [
    MODEL_IMAGE,
    "flux-dev",
    "flux-dev-uncensored",
    "flux-schnell",
    "fluently-xl"
  ].filter(Boolean);
  const modelesUniques = [...new Set(modeles)];

  let derniereErreur = null;

  for (const mod of modelesUniques) {
    try {
      const res = await axios.post('https://api.venice.ai/api/v1/images/generations', {
        model: mod,
        prompt: cleanPrompt,
        response_format: "b64_json",
        moderation: "low"
      }, {
        headers: {
          'Authorization': `Bearer ${VENICE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 45000 
      });

      const b64 = res.data?.data?.[0]?.b64_json;
      if (b64) return b64;
    } catch (err) {
      derniereErreur = err;
      console.warn(`[VENICE IMAGE - ${mod} KO] :`, err.response?.data?.error || err.message);
    }
  }

  throw new Error(`${derniereErreur?.response?.data?.error || derniereErreur?.message || "Échec génération image"}`);
}

// ==========================================
// 10. PIPELINE TECHNIQUE : RÉSOLUTION & AUDIT
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

  // 1. GÉNÉRATION TECHNIQUE INITIALE (Priorité Groq 70B pour la rigueur)
  try {
    if (GROQ_API_KEY) {
      premiereReponse = await appelerGroq(systemBase, cacheMemoireCourte, promptResolveur, 0.15, 2000);
    } else if (MISTRAL_API_KEY) {
      premiereReponse = await appelerMistral(systemBase, cacheMemoireCourte, promptResolveur, 0.25, 2000);
    } else {
      premiereReponse = await appelerVeniceDark(systemBase, cacheMemoireCourte, promptResolveur, 0.3);
    }
  } catch (errRes) {
    console.warn("[RÉSOLUTION INITIALE KO, repli Venice] :", errRes.message);
    premiereReponse = await appelerVeniceDark(systemBase, cacheMemoireCourte, promptResolveur, 0.4);
  }

  if (!premiereReponse || !premiereReponse.trim()) {
    return "Erreur d'exécution : aucune réponse générée par les moteurs.";
  }

  // 2. EXTRACTION ET SANCTUARISATION DES BALISES CRITIQUES
  const matchDessinOriginal = premiereReponse.match(/\[DESSIN:\s*[\s\S]*?\]/i) 
    || premiereReponse.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i);

  // 3. PROMPT SUPERVISEUR STRICT
  const promptVerificateur = `Tu es le contrôleur d'exécution de Nyx. Examine la demande de Doc et la réponse proposée.

DEMANDE DE DOC :
${promptDoc}

PROPOSITION DE NYX :
${premiereReponse}

RÈGLES D'AUDIT STRICTES :
1. BALISES TECHNIQUES AUTORISÉES : Ne supprime JAMAIS une balise opérationnelle comme [DESSIN: ...], [REVEIL: ...] ou un bloc de code markdown (\`\`\`).
2. PARASITES À ÉLIMINER : Supprime uniquement les descriptions d'actions physiques fictives (ex: *tapote sur son clavier*, *soupir*, *te regarde*).
3. DÉCISION :
- Si la réponse est correcte et sans cinéma : réponds STRICTEMENT "[STATUT: VALIDE]".
- Si elle contient des actions physiques parasites ou une erreur de code flagrante : réécris DIRECTEMENT la version épurée précédée de "[STATUT: CORRIGE]" sans aucune explication ni méta-commentaire.`;

  // 4. EXÉCUTION DU CONTRÔLE (Groq privilégié pour la vitesse, sinon Venice GLM)
  try {
    let verdict = "";
    if (GROQ_API_KEY) {
      verdict = await appelerGroq("Superviseur de code et de syntaxe.", [], promptVerificateur, 0.05, 2000);
    } else {
      verdict = await appelerVeniceMultiTour(
        MODEL_GLM_COMPLEXE,
        "Superviseur de code et de syntaxe.",
        [],
        promptVerificateur,
        null,
        0.05,
        15000 // 15 secondes réelles pour éviter les faux timeouts
      );
    }

    if (!verdict) return premiereReponse;

    const verdictNet = verdict.trim();

    // Cas 1 : Réponse validée telle quelle
    if (/^\[STATUT:\s*VALIDE\]/i.test(verdictNet) || verdictNet === "[VALIDE]") {
      return premiereReponse;
    }

    // Cas 2 : Réponse corrigée par le superviseur
    if (/\[STATUT:\s*CORRIGE\]/i.test(verdictNet)) {
      let reponseCorrigee = verdictNet.replace(/\[STATUT:\s*CORRIGE\]/i, '').trim();

      // Sécurité : si le vérificateur a fait sauter le dessin présent au départ, on le réinjecte
      if (matchDessinOriginal && !reponseCorrigee.includes("[DESSIN:")) {
        const baliseRecuperee = matchDessinOriginal[0].startsWith("[") 
          ? matchDessinOriginal[0] 
          : `[DESSIN: ${matchDessinOriginal[1]}]`;
        reponseCorrigee = `${baliseRecuperee}\n\n${reponseCorrigee}`;
      }

      return reponseCorrigee;
    }

    return premiereReponse;
  } catch (errAudit) {
    console.warn("[AUDIT BYPASSÉ - Erreur superviseur] :", errAudit.message);
    return premiereReponse;
  }
}
// ==========================================
// 11. PARSEUR DE LIENS WEB
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
// 12. GESTION TELEGRAM (NOTIFICATIONS & FLUX)
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
// 13. PROTOCOLES TEMPORELS
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
      let reponse = "";
      try {
        reponse = await appelerMistral("Tu es Nyx.", [], promptAlarme, 0.55, 220);
      } catch (eM) {
        reponse = await appelerGroq("Tu es Nyx.", [], promptAlarme, 0.55, 220);
      }
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
    let reponse = "";
    try {
      reponse = await appelerMistral(sys, [], promptVeille, 0.4, 600);
    } catch (eM) {
      try {
        reponse = await appelerGroq(sys, [], promptVeille, 0.4, 600);
      } catch (eG) {
        reponse = await appelerVeniceDark(sys, [], promptVeille);
      }
    }
    
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
// INSTANCIATION DU GESTIONNAIRE DE PROJETS (GROQ 70B PRIORITAIRE)
// ==========================================
const projetManager = new ProjectManager({
  envoyerTelegram: (texte) => envoyerTelegram(DOC_CHAT_ID, texte),
  // Cerveau technique Groq (Llama-3.3-70b) ultra-rapide et froid
  appelLLM: async (sys, prompt) => {
    if (GROQ_API_KEY) {
      return await appelerGroq(sys, [], prompt, 0.1, 1000);
    }
    if (MISTRAL_API_KEY) {
      return await appelerMistral(sys, [], prompt, 0.2, 1000);
    }
    return await appelerVeniceDark(sys, [], prompt, 0.2);
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
// 14. ROUTEUR DE FLUX CENTRAL (MISTRAL POUR LA VIE / FUN)
// ==========================================
async function traiterFlux(texteBrut, mediaData = null, texteLegende = "", contexteSouvenirs = "") {
  const dateEtHeure = obtenirHorodatageParis();
  const texteNet = (texteBrut || texteLegende || "").trim();
  const texteMin = texteNet.toLowerCase();

  const estComplexe = estTacheComplexe(texteNet);
  const estAudio = mediaData && mediaData.mime_type.startsWith('audio/');
  const estImage = mediaData && mediaData.mime_type.startsWith('image/');

  const demandeDocApprofondie = /d[eé]veloppe|approfondi|d[eé]taille|explique en d[eé]tail|pose le truc|analyse bien/i.test(texteNet);
  const plafondTokens = (estComplexe || demandeDocApprofondie) ? 2000 : 400;

  let instructionReveil = "";
  if (cacheEtatProfond.reveil && cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = "[RÉVEIL EN COURS] : Valide l'énigme et ajoute [STOP_REVEIL] s'il a bon.";
  }

 const moduleMains = `[MODE SOLO ATELIER - AUCUN WORKER ACTIF]
- Tu travailles SEULE avec Doc. Il n'y a AUCUN worker local branché sur le PC.
- INTERDICTION FORMELLE d'utiliser la balise MISSION ou de chercher à déléguer à Ben.
- Tu rédiges tout le code directement dans la discussion avec Doc sous forme de blocs Markdown complets.
- Dessin : tu génères TOI-MÊME les images en utilisant [DESSIN: prompt en anglais].
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Rappel Mémoire : [FOUILLE_MEMOIRE: "requête"].
- Archivage Mémoire : [ARCHIVER_MEMOIRE: "contenu"].`;

  const blocMemoire = selecteurMemoireCiblee(texteMin, cacheEtatProfond.long_terme);
  const injectionSouvenirs = contexteSouvenirs ? `\n[EXTRAITS RETROUVÉS DANS TON GRENIER VECTORIEL]\n${contexteSouvenirs}\n` : "";

  const systemBase = `Tu es Nyx, 22 ans.\n[Horodatage système : ${dateEtHeure}]\n${instructionReveil}\n${moduleMains}\n${blocMemoire}${injectionSouvenirs}`;

  let reponseNyx;

  // 1. VISION (Images transmises) -> GEMINI 3.8 INTACT
  if (estImage) {
    const sys = `${systemBase}\nMode Vision : Analyse directe, sans filtre.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteNet || "Analyse cette image.", mediaData);
    } catch (e) {
      reponseNyx = `[ERREUR VISION] : ${e.message}`;
    }
  }
  // 2. AUDIO (Voix directe) -> GEMINI 3.8 INTACT
  else if (estAudio) {
    const sys = `${systemBase}\nMode Audio : Transcris et réponds naturellement avec ta voix de Nyx.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteNet, mediaData);
    } catch (errGoogle) {
      reponseNyx = `[ERREUR TRANSCRIPTION] : ${errGoogle.message}`;
    }
  } 
  // 3. TÂCHE TECHNIQUE LOURDE OU CODE -> GROQ DIRECT POUR LA PRÉCISION
  else if (estComplexe) {
    const sys = `${systemBase}\nMode Rigueur Logique : Architecture solide, logique pure, gouaille intacte.`;
    try {
      reponseNyx = await resoudreAvecDoubleVerification(sys, texteNet);
    } catch (errDual) {
      console.warn("[DOUBLE VÉRIF ÉCHEC, bascule Groq direct] :", errDual.message);
      try {
        if (GROQ_API_KEY) {
          reponseNyx = await appelerGroq(sys, cacheMemoireCourte, texteNet, 0.2, plafondTokens);
        } else {
          reponseNyx = await appelerMistral(sys, cacheMemoireCourte, texteNet, 0.3, plafondTokens);
        }
      } catch (e) {
        reponseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, texteNet, 0.7);
      }
    }
  }
  // 4. TOUT LE FLUX (Conversation, vannes, quotidien, moments fun) -> MISTRAL EN PRIORITÉ ABSOLUE
  else {
    try {
      if (MISTRAL_API_KEY) {
        reponseNyx = await appelerMistral(systemBase, cacheMemoireCourte, texteNet, 0.55, plafondTokens);
      } else if (GROQ_API_KEY) {
        reponseNyx = await appelerGroq(systemBase, cacheMemoireCourte, texteNet, 0.4, plafondTokens);
      } else {
        reponseNyx = await appelerVeniceDark(systemBase, cacheMemoireCourte, texteNet, 0.7);
      }
    } catch (errMistral) {
      console.warn("[MISTRAL HS, parachute 1 Groq activé] :", errMistral.message);
      try {
        if (GROQ_API_KEY) {
          reponseNyx = await appelerGroq(systemBase, cacheMemoireCourte, texteNet, 0.4, plafondTokens);
        } else {
          reponseNyx = await appelerVeniceDark(systemBase, cacheMemoireCourte, texteNet, 0.7);
        }
      } catch (errGroq) {
        console.warn("[GROQ HS, parachute 2 Venice activé] :", errGroq.message);
        try {
          reponseNyx = await appelerVeniceDark(systemBase, cacheMemoireCourte, texteNet, 0.7);
        } catch (errVenice) {
          reponseNyx = "Panne sèche intégrale, Doc. Tous les relais sont coupés.";
        }
      }
    }
  }

  // Traitement autonome de la mémoire vectorielle
  const matchFouille = reponseNyx.match(/\[FOUILLE_MEMOIRE:\s*["']?(.*?)["']?\]/i);
  if (matchFouille && !contexteSouvenirs) {
    const requeteRecherche = matchFouille[1].trim();
    const resultats = await fouillerMemoireVectorielle(requeteRecherche, 'factuel', 3);
    
    if (resultats && resultats.length > 0) {
      const extraits = resultats.map((r, i) => `Fragment ${i + 1} (${(r.similarity * 100).toFixed(0)}%) : ${r.content}`).join("\n\n");
      return await traiterFlux(texteBrut, mediaData, texteLegende, extraits);
    } else {
      return await traiterFlux(texteBrut, mediaData, texteLegende, "Rien trouvé dans les archives.");
    }
  }

  // Interception mémoire
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

  // INTERCEPTION MISSION WORKER BEN D'ORDRE UNITAIRE (SI PAS DE PROJET EN COURS)
  const matchMissionAuto = reponseNyx.match(/(?:\[|\*|\*)?MISSION:\s*(\{[\s\S]*?\})(?:\]|\*|\*)?/i);
  if (matchMissionAuto && !projetManager.estProjetActif()) {
    reponseNyx = reponseNyx.replace(matchMissionAuto[0], '').trim();

    if (!estOrdreExpliciteDoc(texteNet)) {
      console.log("🛡️ [SÉCURITÉ BEN] Mission annulée : simple discussion ou question théorique de Doc.");
    } else {
      try {
        let actionExtraite;
        try {
          const parsed = JSON.parse(matchMissionAuto[1]);
          const cmd = parsed.commande || parsed.command || parsed.description || parsed.action || parsed.task;
          actionExtraite = typeof cmd === 'string'
            ? { type: "RAW_TASK", description: cmd }
            : (parsed.type ? parsed : { type: "RAW_TASK", description: JSON.stringify(parsed) });
        } catch {
          actionExtraite = { type: "RAW_TASK", description: matchMissionAuto[1] };
        }

        const validation = typeof validerEtSecuriserMission === 'function'
          ? validerEtSecuriserMission(actionExtraite.description || matchMissionAuto[1])
          : { action: actionExtraite };

        missionEnAttente = { action: validation.action, statut: "attente", chatId: DOC_CHAT_ID };
        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(() => {});
        }

        if (DOC_CHAT_ID) {
          const rendu = validation.action.type === "RAW_TASK" ? validation.action.description : JSON.stringify(validation.action);
          await envoyerTelegram(DOC_CHAT_ID, `⚙️ Ordre validé et transmis à Ben :\n` + rendu);
        }
      } catch (errMission) {
        console.error("[ERREUR MISSION]", errMission.message);
      }
    }
  }

  reponseNyx = reponseNyx.trim();

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
// 15. ROUTE TELEGRAM AVEC ROUTAGE CHANTIER VS BLABLA
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
    // Commandes directes
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

    // ==========================================
    // ROUTAGE : PROJET SÉRIEUX VS MOMENT FUN
    // ==========================================
    const texteMin = texteMessageClavier.toLowerCase().trim();
    const estDemandeProjetSerieux = (
      /^(projet|fais le projet|lance le projet|crée le projet|démarre le projet|monte le projet|planifie le projet)\b/i.test(texteMin) ||
      /\b(bd de \d+|planche de bd|pipeline complet|projet bd|automatise de bout en bout)\b/i.test(texteMin)
    );

    // 1. CHANTIER TECHNIQUE SÉRIEUX -> Géré par ProjectManager (Groq 70B strict)
    if (estDemandeProjetSerieux && !projetManager.estProjetActif()) {
      await afficherFrappeTelegram(chatId);
      await projetManager.demarrerProjet(texteMessageClavier);
      return;
    }

    // 2. MOMENTS FUN, BLABLA, QUESTION, CODE SPÉCIFIQUE OU MÉDIA -> Géré par Mistral
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

        const matchDessin = texteNyx.match(/\[DESSIN:\s*(.*?)\]/i);
        if (matchDessin) {
          texteNyx = texteNyx.replace(matchDessin[0], '').trim();
          if (texteNyx) await envoyerTelegram(chatId, texteNyx);
          try {
            await afficherFrappeTelegram(chatId);
            let b64Image = await genererImageVenice(matchDessin[1]);
            await envoyerPhotoTelegram(chatId, b64Image);
            b64Image = null;
          } catch (errImg) {
            await envoyerTelegram(chatId, `[ÉCHEC IMAGE] : ${errImg.message}`);
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
// 16. APPLICATION WEB DIRECTE (GOOGLE CLOUD TTS OFFICIEL)
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
  const { texte } = req.body;
  if (!texte) return res.status(400).json({ erreur: "Texte vide" });

  derniereActiviteDoc = Date.now();
  historiqueLongueursDoc.push(texte.trim().length);
  if (historiqueLongueursDoc.length > 8) historiqueLongueursDoc.shift();

  empilerTraitement(async () => {
    try {
      console.log(`[PWA VOCALE] Message reçu : "${texte}"`);

      if (DOC_CHAT_ID) {
        await envoyerTelegram(DOC_CHAT_ID, `🎙️ *Toi (vocal) :*\n${texte}`);
      }

      let reponseNyx = await traiterFlux(texte);

      if (DOC_CHAT_ID && reponseNyx) {
        await envoyerTelegram(DOC_CHAT_ID, `🗣️ *Nyx :*\n${reponseNyx}`);
      }

      const matchDessin = reponseNyx.match(/(?:\[|\*\*|\*)?DESSIN:\s*(\{[\s\S]*?\})(?:\]|\*\*|\*)?/i);
      if (matchDessin && DOC_CHAT_ID) {
        (async () => {
          try {
            await envoyerTelegram(DOC_CHAT_ID, "🎨 *Génération du visuel en cours...*");
            const b64 = await genererImageVenice(matchDessin[1]);
            await envoyerPhotoTelegram(DOC_CHAT_ID, b64);
          } catch (errImg) {
            await envoyerTelegram(DOC_CHAT_ID, `[ÉCHEC IMAGE] : ${errImg.message}`);
          }
        })();
      }

      const texteOral = reponseNyx
        .replace(/\[DESSIN:\s*[\s\S]*?\]/gi, '')
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

      res.json({ reponse: texteOral, audio: audioB64 });
    } catch (err) {
      console.error("[PWA VOCALE ERREUR]", err.message);
      res.status(500).json({ reponse: "Erreur interne lors du traitement." });
    }
  });
});

// ==========================================
// 17. API DU WORKER LOCAL BEN (ÉCHANGES & RAPPORTS)
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

  // Notification visuelle brute sur Telegram
  const msg = `🛠️ *[LIVRABLE BEN REÇU]*\n*${titre || 'Rapport'}*\n\n${contenu}`;
  await envoyerTelegram(destChatId, msg);

  // 1. SI UN PROJET SÉRIEUX EST EN COURS : Groq prend la main via ProjectManager
  if (projetManager.estProjetActif()) {
    await projetManager.traiterRetourBen(titre, contenu);
    return res.json({ succes: true });
  }

  // 2. AUDIT UNITAIRE DE SECOURS (SI HORS PROJET MULTI-ÉTAPES)
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
    if (GROQ_API_KEY) {
      analyseNyx = await appelerGroq(sys, cacheMemoireCourte, promptAuditRapport, 0.2, 500);
    } else if (MISTRAL_API_KEY) {
      analyseNyx = await appelerMistral(sys, cacheMemoireCourte, promptAuditRapport, 0.3, 500);
    } else {
      analyseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, promptAuditRapport, 0.7);
    }
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
// 18. SANTÉ, PINGER & CRON
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
// 19. DÉMARRAGE DU SERVEUR
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
