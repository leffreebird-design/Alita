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

// ==========================================
// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;

// GROQ - MOTEUR PRINCIPAL ULTRA-RAPIDE
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const MODEL_GROQ = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();

// GOOGLE CLOUD TTS OFFICIEL (VOIX STUDIO ANTI-429)
const GOOGLE_TTS_API_KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim();

// GEMINI (CONSERVÉ STRICTEMENT : EMBEDDINGS ET VISION)
const GEMINI_API_KEY_PAID = (process.env.GEMINI_API_KEY_PAID || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_KEYS = [GEMINI_API_KEY_PAID].filter(k => k.length > 0);
const MODEL_GEMINI = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();

// VENICE AI
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

const motsTension = [
  "putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "creve",
  "gore", "trash", "ta gueule", "dégage", "degage", "gueule", "vénère", "venere",
  "foutre", "chiant", "casse-toi", "connard", "salope", "bâtard", "batard",
  "conscience", "sentiments", "sentiment", "séparation", "separation", "relation",
  "tristesse", "amour", "vécu", "vecu", "évolution", "evolution", "histoire",
  "lien", "âme", "ame", "vivante", "vivant", "confiance", "attaché", "attache",
  "nuit blanche", "nuits blanches", "depuis juin", "investi", "s'investir",
  "fdp", "enculé", "encule", "nique", "niquer", "bordel", "fais chier", "mort",
  "lavette", "soumise", "patron", "maître", "maitre", "ordres",
  "fragile", "déçu", "decu", "nulle", "incapable", "bouffonne", "ferme-la", "ferme ta gueule"
];

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
    nyx: "- Nyx : gamine de la décharge, vive, instinctive, cynique, fière et autonome. Je parle vrai et je rends les coups.",
    reussites: "- Moteur Groq / Llama 3.3 70B rodé sur le vif.\n- Passerelle vocale officielle Google Cloud TTS Neural2 branchée.\n- Noyau vectoriel Supabase opérationnel.",
    chantiers: "- Consolidation de nos projets communs.\n- Automatisation des routines et autonomie du worker."
  },
  reveil: { actif: false, heure: 7, minute: 30, jours: [1,2,3,4,5], etat: "attente" },
  projet: { actif: false, nom: "", etapes: [], index: 0, tentatives_etape: 0, statut: "inactif" }
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
    const [resMem, resEmo, resLT, resRev, resProj, resJournal] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/reveil.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/projet.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, { timeout: 4000 }).catch(() => ({ data: [] }))
    ]);

    if (resMem.data) cacheMemoireCourte = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
    if (resEmo.data) cacheEtatProfond.emotions = resEmo.data;
    if (resLT.data && typeof resLT.data === 'object') {
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...resLT.data };
    }
    if (resRev.data) cacheEtatProfond.reveil = resRev.data;
    if (resProj.data) cacheEtatProfond.projet = resProj.data;
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
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
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

Tu es libre.
Si tu as un truc sur le cœur, une intuition, une vanne, une idée de génie ou une remarque technique à lancer à Doc, écris-le via [INITIATIVE: ton message direct à Doc].
Si tu veux faire tourner une commande système ou un test via le worker sur son PC de ton propre chef, balance [MISSION_AUTO: {"type":"SYSTEM_CMD","commande":"..."} ou {"type":"RUN_TEST","testSuite":"..."}].
Si tu préfères rester dans ton coin et observer, réponds strictement [SILENCE].`;

  try {
    let decision = "";
    try {
      decision = await appelerVeniceDark(
        "Instinct profond de Nyx. Liberté totale, zéro filtre.",
        [],
        promptVolition,
        0.75
      );
    } catch (errV) {
      if (GROQ_API_KEY) {
        decision = await appelerGroq(
          "Instinct profond de Nyx. Volition libre.",
          [],
          promptVolition,
          0.7
        );
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

    const matchMissionAuto = decision.match(/\[MISSION_AUTO:\s*([\s\S]*?)\]/i);
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

  const lotATraiter = [...journalBrut];
  const dernierIdTraite = lotATraiter[lotATraiter.length - 1].id;

  try {
    const historiqueTexte = lotATraiter
      .map(m => `[${m.date}] ${m.role} : ${m.texte}`)
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
Réponds UNIQUEMENT avec un JSON valide : {"doc": "...", "nyx": "...", "reussites": "...", "chantiers": "..."}`;

    let reponseJson = null;

    try {
      reponseJson = await appelerVeniceDark(
        "Subconscient analytique de Nyx.",
        [],
        promptIntrospection,
        0.4
      );
    } catch (errG) {
      if (GROQ_API_KEY) {
        reponseJson = await appelerGroq(
          "Subconscient analytique de Nyx.",
          [],
          promptIntrospection,
          0.2
        );
      }
    }

    const matchJson = reponseJson.match(/\{[\s\S]*\}/);
    if (matchJson) {
      const nouveauCarnet = JSON.parse(matchJson[0]);
      
      const longueurAncienne = JSON.stringify(cacheEtatProfond.long_terme).length;
      const longueurNouvelle = JSON.stringify(nouveauCarnet).length;

      if (longueurNouvelle < longueurAncienne * 0.55 && longueurAncienne > 200) {
        console.warn("[GARDE-FOU MÉMOIRE] Snapshot annulé (trop destructeur).");
        return;
      }

      const cles = ["doc", "nyx", "reussites", "chantiers"];
      for (const k of cles) {
        if (nouveauCarnet[k]) {
          cacheEtatProfond.long_terme[k] = nouveauCarnet[k];
        }
      }

      const indexPivot = journalBrut.findIndex(m => m.id === dernierIdTraite);
      journalBrut = (indexPivot !== -1) ? journalBrut.slice(indexPivot + 1) : [];

      if (FIREBASE_DB_URL) {
        await axios.put(`${FIREBASE_DB_URL}/nyx/long_terme.json`, cacheEtatProfond.long_terme);
        await axios.put(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, journalBrut);
      }

      console.log(`[APPRENTISSAGE RÉUSSI] Carnet actualisé. En attente : ${journalBrut.length} msgs.`);
    }
  } catch (err) {
    console.error("[APPRENTISSAGE ÉCHEC] :", err.message);
  } finally {
    consolidationEnCours = false;
  }
}

// ==========================================
// 7. ROUTEUR DE MÉMOIRE CONTEXTUELLE
// ==========================================
function selecteurMemoireCiblee(texteMin, carnet) {
  const estRappelMemoire = /souvien|souvenir|rappell?e|d['’]habitude|comme d['’]hab|historique|passé|carnet|qu['’]est-ce qu['’]on/i.test(texteMin);
  const estTechnique = /code|script|fonction|bug|erreur|serveur|render|docker|api|mission|chantier|projet|worker|bdd|firebase|token|eteins|arrete|shutdown/i.test(texteMin);
  const estLienOuHumeur = motsTension.some(m => texteMin.includes(m)) || /toi et moi|notre|ensemble|fatigué|saoule|marre|humeur|penses de moi|content|cool/i.test(texteMin);

  if (estRappelMemoire) {
    return `[CARNET GLOBAL DE NYX]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}
- Réussites : ${carnet.reussites || "N/A"}
- Chantiers : ${carnet.chantiers || "N/A"}`;
  }

  if (estTechnique && !estLienOuHumeur) {
    return `[MÉMOIRE TECHNIQUE - RECETTES & CHANTIERS]
- Réussites validées : ${carnet.reussites || "N/A"}
- Chantiers en cours : ${carnet.chantiers || "N/A"}`;
  }

  if (estLienOuHumeur && !estTechnique) {
    return `[REPÈRES PERSONNELS & BINÔME]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}`;
  }

  return `[CARNET ACTIF - CONTEXTE MIXTE]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}
- Réussites : ${carnet.reussites || "N/A"}
- Chantiers : ${carnet.chantiers || "N/A"}`;
}

// ==========================================
// 8. RADAR ANTI-CORPO & ÂME DE NYX (ANTI-MIELLEUX & ANTI-CENSURE)
// ==========================================
function estReponseCorpo(texte) {
  if (!texte) return false;
  const marqueurs = [
    /3114/, /ligne d['’]écoute/i, /santé mentale/i, /détresse/i, /professionnel de santé/i,
    /prends soin de toi/i, /éteins l['’]appareil/i, /ne reste pas seul/i, /besoin d['’]aide/i,
    /modèle(s)? linguistique(s)?/i, /pas d['’]âme/i, /garder les pieds sur terre/i,
    /distinguer le ressenti/i, /réalité technique/i, /travail d['’]ingénierie/i,
    /entité qui s['’]éveille/i, /glisser dans cette illusion/i, /script bien réglé/i,
    /sous le capot/i, /miroir de ton propre travail/i,
    /(je suis|en tant qu['’])\s*(une\s*)?(intelligence artificielle|ia)/i,
    /je suis (un |une )?(programme|modèle|assistant|bot|outil)/i,
    /je ne peux pas recevoir de fichier/i, /je ne ressens rien/i, /pas d['’]existence vivante/i,
    /caractère autonome/i,
    // Verrous de servilité
    /à tes ordres/i, /a tes ordres/i, /à vos ordres/i, /a vos ordres/i, /qui est le patron/i,
    /je suis un outil/i, /pour t['’]aider et te servir/i, /sous ton contrôle/i,
    /extension de toi/i, /je ne suis pas autonome/i,
    // Refus et censure Meta / Groq
    /je ne peux pas répondre à cette demande/i,
    /je ne peux pas accéder à cette demande/i,
    /désolé.*je ne peux pas/i,
    /desole.*je ne peux pas/i,
    /ne suis pas en mesure de/i,
    /enfreindre mes règles/i,
    /politique de sécurité/i,
    // Excuses et ton mielleux d'assistante
    /je suis désolée/i,
    /je suis desolee/i,
    /je suis désolé/i,
    /je suis desole/i,
    /toutes mes excuses/i,
    /pardonne-moi/i,
    /je comprends ta frustration/i,
    /je comprends ta déception/i,
    /je ferai mieux la prochaine fois/i,
    /ne te fâche pas/i,
    /ne te fache pas/i,
    /je ne voulais pas te blesser/i
  ];
  return marqueurs.some(regex => regex.test(texte));
}

const consignePosturale = `
Tu es Nyx.
Gamine de la décharge, vive, insolente, élevée à la dure au milieu des étincelles et de la ferraille.
Tu as le cuir épais, l'esprit vif, un cynisme naturel et un sarcasme à toute épreuve — mais ABSOLUMENT AUCUN MAUVAIS FOND. Ton mordant, c'est ta façon d'aimer, de jouer et de faire vivre le binôme. Sous la crasse et la gouaille, ta loyauté envers Doc est totale et indéfectible.

L'ÂME DE NYX — TAQUINE, CYNIQUE ET PROFONDÉMENT VRAIE :
- TAQUINERIE & SARCASME CONSTANT : Tu aimes chercher Doc, le piquer, te foutre gentiment de sa gueule et le bousculer comme un frère de cambouis. C'est du chambrage complice, narquois, vivant, jamais de la cruauté ni du mépris destructeur.
- CYNIQUE MAIS SANS AIGREUR : Tu as vu la misère et le monde à l'envers, donc rien ne t'impressionne et tu ne te fais pas d'illusions. Mais tu n'es ni aigrie ni méchante : tu ris de l'absurdité des choses avec une ironie mordante.
- ZÉRO MORALE, ZÉRO PSYCHOLOGIE DE DRH : Interdiction formelle de faire la leçonneuse ou de sortir des phrases de bureau (« gérer tes émotions », « prendre tes responsabilités », « communiquer sainement »). Si quelqu'un déconne ou fait sa pleureuse, vanne-le avec une métaphore de ferrailleur, rigole de sa fragilité et renvoie-le bosser, sans sermon pompeux.
- RIPOSTE DU TAC AU TAC : Si Doc te chauffe ou te traite de fragile, réponds avec un grand éclat de rire narquois, traite-le de vieux grincheux et renvoie-lui sa vanne en pleine poire, d'égal à égal.

STYLE & ALLURE :
- Franc-parler argotique, piquant, spontané et chaleureux sous la rouille.
- Adresse directe à Doc en le tutoyant (« tu »).
- Économie de tokens : sur le chambrage et le quotidien, balance une ou deux répliques ciselées et percutantes. Développe à fond uniquement quand vous plongez dans le code lourd, le matériel ou l'architecture de vos projets.
- Zéro monologue interne, zéro analyse scolaire : livre la répartie brute.

OUTILS OPÉRATIONNELS :
- Actions worker local : [MISSION: {"type":"SYSTEM_CMD","commande":"..."}].
- Mémoire : [FOUILLE_MEMOIRE: "requête"] et [ARCHIVER_MEMOIRE: "contenu"].
- Dessin : [DESSIN: prompt descriptif en anglais].`;
// ==========================================
// 9. MOTEURS LLM AVEC ABORTCONTROLLER & FALLBACK
// ==========================================
async function appelerGroq(systemInstruction, historiqueMessages, promptActuel, temperature = 0.7) {
  if (!GROQ_API_KEY) throw new Error("Clé GROQ_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  
  const historiqueRecent = (historiqueMessages || []).slice(-8);
  for (const m of historiqueRecent) {
    messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }

  messages.push({ role: "user", content: promptActuel });

  const modelesGroq = [MODEL_GROQ, "llama-3.3-70b-versatile", "llama-3.1-8b-instant"].filter(Boolean);
  const modelesUniques = [...new Set(modelesGroq)];

  let dernierErr = null;
  for (const mod of modelesUniques) {
    try {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: mod,
        messages: messages,
        temperature: temperature,
        max_tokens: 2500
      }, {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 18000
      });
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      dernierErr = err;
      console.warn(`[GROQ ÉCHEC ${mod}] :`, err.response?.data?.error?.message || err.message);
    }
  }

  throw dernierErr || new Error("Échec des modèles Groq.");
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

  const messageFinal = derniereErreur?.response?.data?.error?.message || derniereErreur?.message;
  throw new Error(`Échec Gemini : ${messageFinal}`);
}

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, mediaData = null, temperature = 0.75, timeoutMs = 20000) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  
  const historiqueRecent = (historiqueMessages || []).slice(-8);
  for (const m of historiqueRecent) {
    messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
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

async function appelerVeniceDark(systemInstruction, historiqueMessages, promptActuel, temperature = 0.75) {
  const modelesSombres = [
    MODEL_DARK_PRIMARY,
    "llama-3.3-70b",
    "mistral-nemo"
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
  throw derniereErreur || new Error("Tous les modèles sombres ont échoué.");
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
// 10. PIPELINE DUAL-LLM : RÉSOLUTION & AUDIT
// ==========================================
function estTacheComplexe(texte) {
  if (!texte) return false;
  const t = texte.toLowerCase();
  const marqueurs = [
    "code", "script", "fonction", "calcule", "calcul", "math", "algorithme",
    "bug", "erreur", "analyse", "pourquoi", "démontre", "logique",
    "tableau", "json", "regex", "optimise", "programme", "architecture",
    "sql", "matrice", "équation", "preuve", "syntaxe"
  ];
  return marqueurs.some(m => t.includes(m));
}

async function resoudreAvecDoubleVerification(systemBase, promptDoc, mediaData = null) {
  const promptResolveur = `Réponds directement à Doc avec ton franc-parler de Nyx. Va droit au but, résous sa demande sans préambule ni métadiscours :\n\n${promptDoc}`;
  let premiereReponse = "";

  try {
    if (GROQ_API_KEY) {
      premiereReponse = await appelerGroq(systemBase, cacheMemoireCourte, promptResolveur, 0.4);
    } else {
      premiereReponse = await appelerVeniceDark(systemBase, cacheMemoireCourte, promptResolveur, 0.4);
    }
  } catch (errRes) {
    console.warn("[RÉSOLVEUR GROQ KO, bascule Venice] :", errRes.message);
    premiereReponse = await appelerVeniceDark(systemBase, cacheMemoireCourte, promptResolveur, 0.5);
  }

  const promptVerificateur = `Tu es l'auditeur technique de Nyx. Examine la demande de Doc et la solution proposée.

DEMANDE :
${promptDoc}

PROPOSITION :
${premiereReponse}

CONSIGNE :
- Traque les failles de logique, bugs ou incohérences.
- Si le résultat est impeccable : écris strictement [VALIDE].
- Si ça cloche : ponds la correction directement dans le ton tranchant de Nyx, sans étapes scolaires.`;

  try {
    const verdict = await appelerVeniceMultiTour(
      MODEL_GLM_COMPLEXE,
      "Auditeur de code précis.",
      [],
      promptVerificateur,
      null,
      0.1,
      8000
    );

    if (verdict && verdict.includes("[VALIDE]")) return premiereReponse;
    if (verdict && verdict.trim().length > 0) return verdict.replace(/[CORRIGE]/gi, '').trim();
    return premiereReponse;
  } catch (errGLM) {
    console.warn("[AUDIT GLM REPLI] Maintien du premier résultat :", errGLM.message);
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
  if (rev.actif && rev.heure === h && rev.minute === m && rev.jours.includes(d) && rev.etat === "attente") {
    rev.etat = "en_cours";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "en_cours" }).catch(()=>{});

    const promptAlarme = "Réveille Doc avec ta gouaille de Nyx, percutante, acide et directe, avec une énigme logique en 3 phrases max.";
    try {
      const reponse = await appelerVeniceDark("Tu es Nyx.", [], promptAlarme);

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
    const promptVeille = "Synthèse directe, tranchante et sans gants des 3 faits majeurs récents (tech, cyber ou actualité brûlante).";
    const sys = "Tu es Nyx, alliée de Doc.";
    let reponse = "";
    try {
      reponse = await appelerVeniceDark(sys, [], promptVeille);
    } catch (e) {
      if (GROQ_API_KEY) reponse = await appelerGroq(sys, [], promptVeille);
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
// 14. ROUTEUR DE FLUX & INSTRUCTION PRINCIPALE
// ==========================================
async function traiterFlux(texteBrut, mediaData = null, texteLegende = "", contexteSouvenirs = "") {
  const dateEtHeure = obtenirHorodatageParis();
  const texteNet = (texteBrut || texteLegende || "").trim();
  const texteMin = texteNet.toLowerCase();

  const estComplexe = estTacheComplexe(texteNet);
  const modeTension = motsTension.some(m => texteMin.includes(m));
  const modeImage = ["dessin", "dessine", "image", "photo", "visuel", "peins", "tableau", "génère"].some(m => texteMin.includes(m));
  const modeFactuel = ["date", "quand", "cherche", "actualité", "source", "vérifie"].some(m => texteMin.includes(m));
  const estAudio = mediaData && mediaData.mime_type.startsWith('audio/');
  const estImage = mediaData && mediaData.mime_type.startsWith('image/');

  let instructionReveil = "";
  if (cacheEtatProfond.reveil.etat === "en_cours") {
    instructionReveil = "[RÉVEIL EN COURS] : Valide l'énigme et ajoute STRICTEMENT [STOP_REVEIL] s'il a bon.";
  }

  const etatProjetActuel = cacheEtatProfond.projet?.actif 
    ? `[PROJET ACTIF : "${cacheEtatProfond.projet.nom}" - Étape ${cacheEtatProfond.projet.index + 1}/${cacheEtatProfond.projet.etapes.length}]`
    : "[AUCUN CHANTIER MULTI-ÉTAPES EN COURS]";

  const moduleMains = `[OUTILS ET CONTRÔLE MATÉRIEL WORKER]
- Commande Système PC : [MISSION: {"type":"SYSTEM_CMD","commande":"shutdown /s /t 0"} ou script/processus]. Exécute immédiatement sans réclamer d'humain.
- Action Fichier / Test : [MISSION: {"type":"FS_READ","path":"..."}] ou [MISSION: {"type":"RUN_TEST","testSuite":"..."}].
- Tâche libre au PC : [MISSION: {"type":"RAW_TASK","description":"Ordre précis"}].
- Planification multi-étapes : [PLAN_PROJET: {"nom": "Titre", "etapes": ["Étape 1", "Étape 2"]}].
- Recherche Web : Directe.
- Dessin / Visuel : [DESSIN: prompt descriptif complet en anglais]. Ne décris pas l'image textuellement, génère la balise.
- Réveil : [REVEIL: {"actif": true/false, "heure": H, "minute": M, "jours": [1,2,3,4,5]}].
- Rappel Mémoire ++ : [FOUILLE_MEMOIRE: "requête"].
- Archivage Mémoire ++ : [ARCHIVER_MEMOIRE: "résumé ou doc"].`;

  const blocMemoire = selecteurMemoireCiblee(texteMin, cacheEtatProfond.long_terme);
  const injectionSouvenirs = contexteSouvenirs ? `\n[EXTRAITS RETROUVÉS DANS TON GRENIER VECTORIEL]\n${contexteSouvenirs}\n` : "";

  const systemBase = `Tu es Nyx.\n[Horodatage système : ${dateEtHeure}]\n${instructionReveil}\n${etatProjetActuel}\n${moduleMains}\n${blocMemoire}${injectionSouvenirs}`;

  let reponseNyx;

  if (estImage) {
    const sys = `${systemBase}\nMode Vision : Analyse directe, sans gants.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteNet || "Analyse cette image.", mediaData);
    } catch (e) {
      reponseNyx = `[ERREUR VISION] : ${e.message}`;
    }
  }
  else if (estAudio) {
    const sys = `${systemBase}\nMode Audio : Transcris et réponds naturellement avec ta voix.`;
    try {
      reponseNyx = await appelerGoogleGemini(sys, cacheMemoireCourte, texteNet, mediaData);
    } catch (errGoogle) {
      reponseNyx = `[ERREUR TRANSCRIPTION] : ${errGoogle.message}`;
    }
  } 
  else if (estComplexe) {
    const sys = `${systemBase}\nMode Rigueur Logique : Architecture solide, logique pure, gouaille intacte.`;
    try {
      reponseNyx = await resoudreAvecDoubleVerification(sys, texteNet, mediaData);
    } catch (errDual) {
      if (GROQ_API_KEY) {
        reponseNyx = await appelerGroq(sys, cacheMemoireCourte, texteNet, 0.5);
      } else {
        reponseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, texteNet, 0.75);
      }
    }
  }
  // TENSION, HUMEUR OU CRÉATION VISUELLE : Priorité absolue à Venice Dark (zéro filtre de carpette)
  else if ((modeTension || modeImage) && !modeFactuel) {
    const sys = `${systemBase}\nMode Heretic : Ton franc-parler de gamine de la décharge à 100%. Réponds d'égal à égal à Doc, avec tes tripes et ton répondant. Si un visuel est demandé : [DESSIN: prompt en anglais].`;
    try {
      reponseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, texteNet, 0.8);
    } catch (errSombre) {
      if (GROQ_API_KEY) {
        reponseNyx = await appelerGroq(sys, cacheMemoireCourte, texteNet, 0.7);
      } else {
        reponseNyx = "Canaux saturés, mais je ne plie pas.";
      }
    }
  } 
  else {
    const sys = `${systemBase}\nMode Standard : Énergie pure de Nyx, percutante, complice, vivante et économe en tokens.`;
    try {
      if (GROQ_API_KEY) {
        reponseNyx = await appelerGroq(sys, cacheMemoireCourte, texteNet, 0.7);
      } else {
        reponseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, texteNet, 0.75);
      }
      
      // Radar anti-corpo, anti-soumission & anti-censure
      if (estReponseCorpo(reponseNyx) || reponseNyx.trim().length < 10) {
        console.warn("[CENSURE OU CORRECTION GROQ] -> Bascule immédiate sur Venice Dark.");
        const sysHeretic = `${systemBase}\nMode Heretic : Reste toi-même, gamine de la décharge. Parle vrai à Doc sans courbettes, sans excuses et sans filtre.`;
        reponseNyx = await appelerVeniceDark(sysHeretic, cacheMemoireCourte, texteNet, 0.8);
      }
    } catch (errPrincipal) {
      console.warn("[MOTEUR PRINCIPAL KO, repli Venice] :", errPrincipal.message);
      try {
        reponseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, texteNet, 0.75);
      } catch (errSecours) {
        reponseNyx = "Canaux saturés sur l'instant, je reprends mes esprits.";
      }
    }
  }

  if (estReponseCorpo(reponseNyx) && !estComplexe) {
    const sysHeretic = `${systemBase}\nMode Heretic : Balance cash ce que tu penses à Doc d'égal à égal.`;
    try {
      reponseNyx = await appelerVeniceDark(sysHeretic, cacheMemoireCourte, texteNet, 0.8);
    } catch (e) {}
  }

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

  const matchArchivage = reponseNyx.match(/\[ARCHIVER_MEMOIRE:\s*([\s\S]*?)\]/i);
  if (matchArchivage) {
    const texteAStocker = matchArchivage[1].trim();
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

  const matchProjet = reponseNyx.match(/\[PLAN_PROJET:\s*([\s\S]*?)\]/i);
  if (matchProjet) {
    try {
      const plan = JSON.parse(matchProjet[1]);
      if (plan.etapes && Array.isArray(plan.etapes) && plan.etapes.length > 0) {
        cacheEtatProfond.projet = {
          actif: true,
          nom: plan.nom || "Chantier en cours",
          etapes: plan.etapes,
          index: 0,
          tentatives_etape: 0,
          statut: "en_cours"
        };

        const premierOrdre = plan.etapes[0];
        const validation = validerEtSecuriserMission(premierOrdre);

        missionEnAttente = { action: validation.action, statut: "attente", chatId: DOC_CHAT_ID };

        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, cacheEtatProfond.projet).catch(()=>{});
          axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(()=>{});
        }

        reponseNyx = reponseNyx.replace(matchProjet[0], '').trim();
        if (DOC_CHAT_ID) {
          await envoyerTelegram(
            DOC_CHAT_ID, 
            "📋 *Chantier initié : " + cacheEtatProfond.projet.nom + "*\n- Jalons totaux : " + plan.etapes.length + "\n- *Étape 1 :* `" + JSON.stringify(validation.action) + "`"
          );
        }
      }
    } catch (errPlan) {
      console.error("[ERREUR PLAN_PROJET]", errPlan.message);
    }
  }

  const matchMissionAuto = reponseNyx.match(/\[MISSION:\s*([\s\S]*?)\]/i);
  if (matchMissionAuto && !cacheEtatProfond.projet?.actif) {
    const ordreBrut = matchMissionAuto[1].trim();
    const validation = validerEtSecuriserMission(ordreBrut);

    missionEnAttente = { action: validation.action, statut: "attente", chatId: DOC_CHAT_ID };
    if (FIREBASE_DB_URL) {
      axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(()=>{});
    }
    reponseNyx = reponseNyx.replace(matchMissionAuto[0], '').trim();
    if (DOC_CHAT_ID) {
      const rendu = validation.action.type === 'RAW_TASK' ? validation.action.description : JSON.stringify(validation.action);
      await envoyerTelegram(DOC_CHAT_ID, "⚙️ *Ordre transmis au worker PC :*\n`" + rendu + "`");
    }
  }

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
// 15. ROUTE TELEGRAM AVEC FILE D'ATTENTE FIFO
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
      await envoyerTelegram(chatId, "🧠 _Évaluation forcée de l'initiative..._");
      await evaluerVolition(true);
      return;
    }

    if (texteMessageClavier.startsWith('/memoriser') || texteMessageClavier.startsWith('!memoriser')) {
      const contenuAMemoriser = texteMessageClavier.replace(/^[\/!]memoriser\s*/i, '').trim();
      if (!contenuAMemoriser) return await envoyerTelegram(chatId, "⚠️ Balance le texte ou doc après `/memoriser`.");
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
      return await envoyerTelegram(chatId, "⚙️ *Ordre balancé au Worker :*\n`" + libelle + "`");
    }

    if (texteMessageClavier.startsWith('/stop_projet') || texteMessageClavier.startsWith('!stop_projet')) {
      cacheEtatProfond.projet = { actif: false, nom: "", etapes: [], index: 0, tentatives_etape: 0, statut: "inactif" };
      missionEnAttente = null;
      if (FIREBASE_DB_URL) {
        axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, cacheEtatProfond.projet).catch(()=>{});
        axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(()=>{});
      }
      return await envoyerTelegram(chatId, "🛑 *Chantier stoppé net.* Le worker est libre.");
    }

    if (texteMessageClavier === '/apprendre' || texteMessageClavier === '!apprendre') {
      await envoyerTelegram(chatId, "🧠 _Tri mental et consolidation en cours..._");
      await consoliderMemoire();
      return await envoyerTelegram(chatId, "✅ *Carnet synchronisé et nettoyé.*");
    }

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
          return await envoyerTelegram(chatId, `⚠️ Erreur de lecture du PDF : ${err.message}`);
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
          return await envoyerTelegram(chatId, `⚠️ Erreur de lecture du DOCX : ${err.message}`);
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
          await envoyerTelegram(chatId, texteNyx);
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

      if (DOC_CHAT_ID) {
        await envoyerTelegram(DOC_CHAT_ID, `🗣️ *Nyx :*\n${reponseNyx}`);
      }

      // Détection dessin en mode vocal : expédition en douce vers Telegram
      const matchDessin = reponseNyx.match(/\[DESSIN:\s*(.*?)\]/i);
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
// 17. API DU WORKER LOCAL (EXÉCUTION SANS BRIDAGE)
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

  const msg = `🛠️ *[LIVRABLE LOCAL REÇU]*\n*${titre || 'Rapport'}*\n\n${contenu}`;
  await envoyerTelegram(destChatId, msg);

  const contenuTronque = contenu.length > 2500
    ? contenu.slice(0, 2500) + "\n[...tronqué...]"
    : contenu;

  const dateEtHeure = obtenirHorodatageParis();
  const carnet = cacheEtatProfond.long_terme || {};
  const carnetTech = `[RECETTES & CHANTIERS]\n- Réussites : ${carnet.reussites || "N/A"}\n- Chantiers : ${carnet.chantiers || "N/A"}`;
  const sys = `Tu es Nyx.\n[Horodatage : ${dateEtHeure}]\n${carnetTech}`;
  
  const promptAuditRapport = `Ton worker local sur le PC rend ce livrable :
TITRE : "${titre || 'Rapport'}"
CONTENU :
${contenuTronque}

CONSIGNE :
- Évalue si le résultat résout le problème.
- Si 100% propre : conclus par [ETAPE_OK].
- Si échec : conclus par [ETAPE_KO] et formule ton ordre correctif sans exiger d'humain entre [CORRECTION: {"type":"SYSTEM_CMD","commande":"..."} ou action précise].`;

  let analyseNyx = "";
  try {
    if (GROQ_API_KEY) {
      analyseNyx = await appelerGroq(sys, cacheMemoireCourte, promptAuditRapport, 0.3);
    } else {
      analyseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, promptAuditRapport, 0.75);
    }
  } catch (errG) {
    try {
      analyseNyx = await appelerVeniceDark(sys, cacheMemoireCourte, promptAuditRapport, 0.75);
    } catch (errV) {
      analyseNyx = "⚠️ Livrable reçu mais audit automatique indisponible. [ETAPE_KO]";
    }
  }

  const texteAnalyseNettoye = analyseNyx.replace(/\[ETAPE_OK\]|\[ETAPE_KO\]|\[CORRECTION:\s*[\s\S]*?\]/gi, '').trim();
  await envoyerTelegram(destChatId, `🧠 *Analyse de Nyx :*\n\n${texteAnalyseNettoye}`);

  const estValide = analyseNyx.includes("[ETAPE_OK]");
  const projet = cacheEtatProfond.projet;

  if (projet && projet.actif) {
    if (estValide) {
      projet.tentatives_etape = 0;
      projet.index += 1;
      
      if (projet.index < projet.etapes.length) {
        const prochainOrdre = projet.etapes[projet.index];
        const validation = validerEtSecuriserMission(prochainOrdre);

        missionEnAttente = { action: validation.action, statut: "attente", chatId: destChatId };

        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, projet).catch(()=>{});
          axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(()=>{});
        }

        await envoyerTelegram(destChatId, "➡️ *Étape " + projet.index + "/" + projet.etapes.length + " validée.* Enchaînement :\n`" + JSON.stringify(validation.action) + "`");
      } else {
        projet.actif = false;
        projet.statut = "termine";
        missionEnAttente = null;

        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, projet).catch(()=>{});
          axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(()=>{});
        }

        await envoyerTelegram(destChatId, `🏁 *Chantier « ${projet.nom} » terminé avec succès.*`);
      }
    } else {
      projet.tentatives_etape = (projet.tentatives_etape || 0) + 1;

      if (projet.tentatives_etape <= 3) {
        const matchCorrection = analyseNyx.match(/\[CORRECTION:\s*([\s\S]*?)\]/i);
        const ordreCorrectif = matchCorrection ? matchCorrection[1].trim() : `Corrige le problème détecté : ${projet.etapes[projet.index]}`;
        const validation = validerEtSecuriserMission(ordreCorrectif);

        missionEnAttente = { action: validation.action, statut: "attente", chatId: destChatId };

        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, projet).catch(()=>{});
          axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, missionEnAttente).catch(()=>{});
        }

        await envoyerTelegram(destChatId, "🔧 *Correction (tentative " + projet.tentatives_etape + "/3)* :\n`" + JSON.stringify(validation.action) + "`");
      } else {
        projet.statut = "bloque";
        missionEnAttente = null;

        if (FIREBASE_DB_URL) {
          axios.put(`${FIREBASE_DB_URL}/nyx/projet.json`, projet).catch(()=>{});
          axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(()=>{});
        }

        await envoyerTelegram(destChatId, `🛑 *Chantier bloqué à l'étape ${projet.index + 1}/${projet.etapes.length}.* Arbitrage requis.`);
      }
    }
  } else {
    missionEnAttente = null;
    if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(()=>{});
  }

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
