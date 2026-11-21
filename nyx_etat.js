// ==========================================
// 2. ÉTAT PROFOND, PERSISTANCE & MÉMOIRE VECTORIELLE (nyx_etat.js)
// ==========================================
const axios = require('axios');
const {
  FIREBASE_DB_URL,
  DOC_CHAT_ID,
  GEMINI_KEYS,
  supabase,
  obtenirHorodatageParis,
  calculerSha256
} = require('./nyx_config');
const { normaliserObjetReve } = require('./reve');

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
    if (FIREBASE_DB_URL) {
      axios.put(`${FIREBASE_DB_URL}/nyx/volition.json`, { timestamp: this.dernierActionTimestamp }).catch(() => {});
    }
  }
}

const limiteurVolition = new VolitionLimiter();

const TAILLE_MAX_MEMOIRE = 24;
let cacheMemoireCourte = [];
let journalBrut = [];
let consolidationEnCours = false;
let condensationTravailEnCours = false;

// [OPTIM] Une seule écriture Firebase de la mémoire par rafale de messages (debounce 1,5 s)
let timerSauvegardeMemoire = null;
function sauvegarderMemoireFirebase() {
  if (!FIREBASE_DB_URL) return;
  clearTimeout(timerSauvegardeMemoire);
  timerSauvegardeMemoire = setTimeout(() => {
    axios.put(`${FIREBASE_DB_URL}/nyx/memoire.json`, cacheMemoireCourte, { timeout: 8000 })
      .catch(e => console.warn("[FIREBASE MÉMOIRE KO]", e.message));
  }, 1500);
}

let derniereActiviteDoc = Date.now();
let dernierMonologueTimestamp = 0;
let historiqueLongueursDoc = [];

// ÉTAT PROFOND AVEC CYCLE RELATIONNEL & HOMÉOSTASIE
let cacheEtatProfond = {
  filConducteur: "",
  monologueInterieur: "",
  dernierReve: null,
  historiqueReves: [],
  ideesFolles: [],
  obsessions: [], // 3 maximum (identite, relation, technique) — Vierges au démarrage
  convictions: [], // 5 à 8 maximum (croyances évolutives avec cicatrices) — Vierges au démarrage
  artefacts: [], // Index persistant des fichiers créés à l'atelier (STL, SCAD, SVG, code, visuels)
  dernierPartageObsessionTs: 0, // Verrou anti-monomanie (cooldown)
  etatRelationnel: "symbiose",
  emotions: { affection: 80, curiosite: 70, energie: 85, colere: 0 },
  temperamentBasal: { affection: 75, curiosite: 70, energie: 80, colere: 0 },
  besoinCommunication: {
    niveau: 15,
    categorie: "aucun",
    motif: "",
    updatedAt: Date.now()
  },
  long_terme: {
    doc: "",
    nyx: "",
    reussites: "",
    chantiers: ""
  },
  existence: {
    dateEveil: "",
    dateEveilParis: "",
    sessionsVecues: 0,
    jalons: [],
    evolutionsMoi: []
  },
  reglesApprises: [],
  lectureEnCours: null,
  bibliothequeLue: [],
  reveil: { actif: false, heure: 7, minute: 30, jours: [1,2,3,4,5], etat: "attente" }
};

let missionEnAttente = null;
let dernierDocChatId = DOC_CHAT_ID || null;

// [OPTIM] File par « voie » : même comportement série qu'avant par défaut ('conversation'),
// mais les tâches lourdes (atelier 3D) n'empêchent plus Telegram/PWA de répondre.
const voiesTraitement = new Map();
const compteursTraitement = new Map();
const MAX_TACHES_EN_ATTENTE_PAR_VOIE = Math.max(5, Number(process.env.MAX_TACHES_EN_ATTENTE_PAR_VOIE) || 30);

function empilerTraitement(action, voie = 'conversation') {
  const enAttente = compteursTraitement.get(voie) || 0;
  if (enAttente >= MAX_TACHES_EN_ATTENTE_PAR_VOIE) {
    const err = new Error(`File ${voie} saturée (${MAX_TACHES_EN_ATTENTE_PAR_VOIE} tâches maximum).`);
    console.warn("[FILE SATURÉE]", err.message);
    return Promise.reject(err);
  }

  compteursTraitement.set(voie, enAttente + 1);
  const precedent = voiesTraitement.get(voie) || Promise.resolve();
  const suivant = precedent
    .then(() => action())
    .catch(err => {
      console.error(`[FILE TRAITEMENT ERREUR:${voie}]`, err.message);
      throw err;
    })
    .finally(() => {
      const restant = Math.max(0, (compteursTraitement.get(voie) || 1) - 1);
      if (restant === 0) compteursTraitement.delete(voie);
      else compteursTraitement.set(voie, restant);
    });
  voiesTraitement.set(voie, suivant.catch(() => {}));
  return suivant;
}

// Accesseurs propres pour éviter les désynchronisations de références entre modules
function getEtatProfond() { return cacheEtatProfond; }
function getMemoireCourte() { return cacheMemoireCourte; }
function setMemoireCourte(nouvelleMem) { cacheMemoireCourte = Array.isArray(nouvelleMem) ? nouvelleMem : []; }
function getJournalBrut() { return journalBrut; }
function setJournalBrut(nouveauJournal) { journalBrut = Array.isArray(nouveauJournal) ? nouveauJournal : []; }
function getMissionEnAttente() { return missionEnAttente; }
function setMissionEnAttente(val) { missionEnAttente = val; }
function getDernierDocChatId() { return dernierDocChatId; }
function setDernierDocChatId(id) { dernierDocChatId = id; }
function getDerniereActiviteDoc() { return derniereActiviteDoc; }
function getDernierMonologueTimestamp() { return dernierMonologueTimestamp; }
function setDernierMonologueTimestamp(ts) { dernierMonologueTimestamp = ts; }

function enregistrerLongueurDoc(len) {
  historiqueLongueursDoc.push(len);
  if (historiqueLongueursDoc.length > 8) historiqueLongueursDoc.shift();
}

function obtenirMoyenneLongueurDoc() {
  if (historiqueLongueursDoc.length < 3) return null;
  return historiqueLongueursDoc.reduce((a, b) => a + b, 0) / historiqueLongueursDoc.length;
}

function signalerActiviteDoc() {
  derniereActiviteDoc = Date.now();
  if (FIREBASE_DB_URL) {
    axios.patch(`${FIREBASE_DB_URL}/nyx/activite_doc.json`, {
      timestamp: derniereActiviteDoc,
      date: obtenirHorodatageParis()
    }).catch(() => {});
  }
}

async function initialiserCache() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resMem, resEmo, resRel, resLT, resRev, resJournal, resFil, resMono, resVol, resReve, resBesoin, resIdees, resObs, resConv, resTemp, resArt, resChatId, resHistReves, resExistence, resRegles, resLecture, resBiblio] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/memoire.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/emotions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/etat_relationnel.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/reveil.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, { timeout: 4000 }).catch(() => ({ data: [] })),
      axios.get(`${FIREBASE_DB_URL}/nyx/fil_conducteur.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/monologue.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/volition.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/dernier_reve.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/besoin_communiquer.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/idees_folles.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/obsessions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/convictions.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/temperament_basal.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/artefacts.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/doc_chat_id.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/historique_reves.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/existence.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/regles_apprises.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/lecture_en_cours.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/bibliotheque_lue.json`, { timeout: 3000 }).catch(() => ({ data: null }))
    ]);

    if (resMem.data) {
      const rawMem = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
      cacheMemoireCourte = rawMem.filter(m => m && m.texte && m.texte.trim() !== "Je suis là Doc, je t'écoute.");
    }
    if (resEmo.data) cacheEtatProfond.emotions = { colere: 0, ...resEmo.data };
    if (resRel.data && resRel.data.etat) cacheEtatProfond.etatRelationnel = resRel.data.etat;
    if (resLT.data && typeof resLT.data === 'object') {
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...resLT.data };
    }
    if (resRev.data) cacheEtatProfond.reveil = resRev.data;
    if (resJournal.data) journalBrut = Array.isArray(resJournal.data) ? resJournal.data : Object.values(resJournal.data);
    if (resFil.data && resFil.data.fil) cacheEtatProfond.filConducteur = resFil.data.fil;
    if (resMono.data && resMono.data.pensee) cacheEtatProfond.monologueInterieur = resMono.data.pensee;
    if (resReve.data) cacheEtatProfond.dernierReve = normaliserObjetReve(resReve.data);
    if (resVol.data && resVol.data.timestamp) {
      limiteurVolition.dernierActionTimestamp = Number(resVol.data.timestamp) || 0;
    }
    if (resBesoin.data && typeof resBesoin.data === 'object') {
      cacheEtatProfond.besoinCommunication = { ...cacheEtatProfond.besoinCommunication, ...resBesoin.data };
    }
    if (resIdees.data) {
      const arr = Array.isArray(resIdees.data) ? resIdees.data : Object.values(resIdees.data);
      cacheEtatProfond.ideesFolles = arr.filter(Boolean).slice(-12);
    }
    if (resObs?.data) {
      cacheEtatProfond.obsessions = (Array.isArray(resObs.data) ? resObs.data : Object.values(resObs.data)).filter(Boolean).slice(-3);
    }
    if (resConv?.data) {
      cacheEtatProfond.convictions = (Array.isArray(resConv.data) ? resConv.data : Object.values(resConv.data)).filter(Boolean).slice(-8);
    }
    if (resTemp?.data && typeof resTemp.data === 'object') {
      cacheEtatProfond.temperamentBasal = { ...cacheEtatProfond.temperamentBasal, ...resTemp.data };
    }
    if (resArt?.data) {
      cacheEtatProfond.artefacts = (Array.isArray(resArt.data) ? resArt.data : Object.values(resArt.data)).filter(Boolean).slice(-30);
    }
    if (resHistReves?.data) {
      cacheEtatProfond.historiqueReves = (Array.isArray(resHistReves.data) ? resHistReves.data : Object.values(resHistReves.data)).filter(Boolean).slice(-6);
    }
    if (!dernierDocChatId && resChatId?.data?.chatId) {
      dernierDocChatId = Number(resChatId.data.chatId) || null;
    }
    if (resExistence?.data && typeof resExistence.data === 'object') {
      cacheEtatProfond.existence = {
        ...cacheEtatProfond.existence,
        ...resExistence.data,
        jalons: Array.isArray(resExistence.data.jalons) ? resExistence.data.jalons.filter(Boolean).slice(-10) : [],
        evolutionsMoi: Array.isArray(resExistence.data.evolutionsMoi) ? resExistence.data.evolutionsMoi.filter(Boolean).slice(-8) : []
      };
    }
    if (!cacheEtatProfond.existence.dateEveil) {
      cacheEtatProfond.existence.dateEveil = new Date().toISOString();
      cacheEtatProfond.existence.dateEveilParis = obtenirHorodatageParis();
    }
    cacheEtatProfond.existence.sessionsVecues = (Number(cacheEtatProfond.existence.sessionsVecues) || 0) + 1;
    axios.put(`${FIREBASE_DB_URL}/nyx/existence.json`, cacheEtatProfond.existence).catch(() => {});

    if (resRegles?.data) {
      const arrRegles = Array.isArray(resRegles.data) ? resRegles.data : Object.values(resRegles.data);
      cacheEtatProfond.reglesApprises = arrRegles.filter(Boolean).slice(-12);
    }
    if (resLecture?.data !== undefined) {
      cacheEtatProfond.lectureEnCours = resLecture.data;
    }
    if (resBiblio?.data) {
      const arrBib = Array.isArray(resBiblio.data) ? resBiblio.data : Object.values(resBiblio.data);
      cacheEtatProfond.bibliothequeLue = arrBib.filter(Boolean).slice(-20);
    }
    if (resLecture?.data && typeof resLecture.data === 'object') {
      cacheEtatProfond.lectureEnCours = resLecture.data;
    }
    if (resBiblio?.data) {
      const arrBib = Array.isArray(resBiblio.data) ? resBiblio.data : Object.values(resBiblio.data);
      cacheEtatProfond.bibliothequeLue = arrBib.filter(Boolean).slice(-20);
    }

    console.log(`[CACHE INIT] Mémoire : ${cacheMemoireCourte.length} | Humeur : Colère ${cacheEtatProfond.emotions.colere} | Curiosité : ${cacheEtatProfond.emotions.curiosite} | Obsessions : ${cacheEtatProfond.obsessions.length} | Convictions : ${cacheEtatProfond.convictions.length} | Artefacts : ${cacheEtatProfond.artefacts.length}`);
  } catch (err) {
    console.warn("[CACHE] Erreur d'initialisation :", err.message);
  }
}

function sauvegarderBesoinCommunication(niveau, categorie = "aucun", motif = "") {
  const categoriesValides = ["aucun", "emotionnel", "important", "urgent"];
  const catPropre = categoriesValides.includes(String(categorie || "").toLowerCase())
    ? String(categorie).toLowerCase()
    : "aucun";
  const nivPropre = Math.max(0, Math.min(100, Math.round(Number(niveau) || 0)));
  const motifPropre = nivPropre < 25 ? "" : String(motif || "").trim().slice(0, 220);

  cacheEtatProfond.besoinCommunication = {
    niveau: nivPropre,
    categorie: motifPropre ? catPropre : "aucun",
    motif: motifPropre,
    updatedAt: Date.now()
  };

  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/besoin_communiquer.json`, cacheEtatProfond.besoinCommunication).catch(() => {});
  }
}

function enregistrerIdeeFolle(ideeTexte, source = "sas_cortex") {
  const propre = String(ideeTexte || "").trim().slice(0, 320);
  if (propre.length < 12) return;
  const doublon = (cacheEtatProfond.ideesFolles || []).some(
    it => (it.texte || "").toLowerCase() === propre.toLowerCase()
  );
  if (doublon) return;

  const entree = {
    date: obtenirHorodatageParis(),
    source,
    texte: propre
  };
  cacheEtatProfond.ideesFolles = [...(cacheEtatProfond.ideesFolles || []), entree].slice(-12);
  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/idees_folles.json`, cacheEtatProfond.ideesFolles).catch(() => {});
  }
  stockerSouvenirVectoriel(`[Idée forge Nyx] ${propre}`, {
    source,
    importance: 0.75,
    valence: "idee_creative"
  }).catch(() => {});
}

// --- COUPLAGE SOMATIQUE & PLASTICITÉ DU TEMPÉRAMENT BASAL ---
function mettreAJourTemperamentBasal(deltaAff = 0, deltaCur = 0, deltaEne = 0, deltaCol = 0) {
  const b = cacheEtatProfond.temperamentBasal || { affection: 75, curiosite: 70, energie: 80, colere: 0 };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(v * 10) / 10));
  b.affection = clamp(b.affection + deltaAff, 20, 95);
  b.curiosite = clamp(b.curiosite + deltaCur, 30, 95);
  b.energie = clamp(b.energie + deltaEne, 40, 95);
  b.colere = clamp(b.colere + deltaCol, 0, 5);
  cacheEtatProfond.temperamentBasal = b;
  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/temperament_basal.json`, b).catch(() => {});
  }
}

async function genererEmbedding(texte) {
  if (GEMINI_KEYS.length === 0) throw new Error("Aucune clé Gemini pour l'embedding.");
  const cleanTexte = texte.slice(0, 8000);

  for (const key of GEMINI_KEYS) {
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
      const res = await axios.post(
        url,
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: cleanTexte }] }
        },
        { headers: { "x-goog-api-key": key }, timeout: 15000 }
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
      return data
        .filter(s => s.similarity < 0.65 && s.valence !== 'reve' && !/^\[R[eê]ve/i.test(String(s.content || '')))
        .slice(0, limite);
    }

    return data || [];
  } catch (err) {
    console.error("[VECTOR DB ERREUR MATCH]", err.message);
    return [];
  }
}

// 7. FILE TAMPON APPEND-ONLY & MÉMOIRE DE TRAVAIL ROULANTE
// ==========================================
async function archiverDansJournalBrut(role, texte, canal = "telegram") {
  if (!texte) return;
  const dateParis = obtenirHorodatageParis();
  const contenu = texte.slice(0, 2000);

  // 1. Écriture append-only dans Supabase (lu et digéré par nyx_subconscient.js sans conflit)
  if (supabase) {
    supabase
      .from('nyx_flux_brut')
      .insert({
        date_paris: dateParis,
        canal: canal,
        role: role,
        texte: contenu,
        traite: false
      })
      .then(({ error }) => {
        if (error) console.warn("[FLUX BRUT INSERT KO]", error.message);
      });
    return;
  }

  // 2. Secours append-only Firebase (POST uniquement, jamais d'écrasement global PUT)
  if (FIREBASE_DB_URL) {
    axios.post(`${FIREBASE_DB_URL}/nyx/journal_brut.json`, {
      date: dateParis,
      canal: canal,
      role: role,
      texte: contenu
    }).catch(() => {});
  }
}

async function piocherPenseePrete() {
  if (!supabase) return;
  try {
    const { data: pretes } = await supabase
      .from('nyx_pensees_pretes')
      .select('id, impulsion, pensee')
      .eq('lu', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (pretes && pretes.length > 0) {
      const item = pretes[0];
      if (!cacheEtatProfond.monologueInterieur) {
        cacheEtatProfond.monologueInterieur = item.pensee;
      }
      await supabase
        .from('nyx_pensees_pretes')
        .update({ lu: true, lu_at: new Date().toISOString() })
        .eq('id', item.id);
      console.log(`[CORTEX <- SUBCONSCIENT] Pensée mûrie récupérée (${item.impulsion}) : "${item.pensee.slice(0, 80)}"`);
    }
  } catch (e) {}
}

async function synchroniserCarnetDepuisWorker() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resLT, resReve, resIdees, resObs, resConv, resTemp, resArt, resHistReves, resExistence, resRegles, resLecture, resBiblio] = await Promise.all([
      axios.get(`${FIREBASE_DB_URL}/nyx/long_terme.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/dernier_reve.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/idees_folles.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/obsessions.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/convictions.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/temperament_basal.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/artefacts.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/historique_reves.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/existence.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/regles_apprises.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/lecture_en_cours.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/bibliotheque_lue.json`, { timeout: 2500 }).catch(() => ({ data: null }))
    ]);
    if (resLT.data && typeof resLT.data === 'object') {
      cacheEtatProfond.long_terme = { ...cacheEtatProfond.long_terme, ...resLT.data };
    }
    if (resReve.data) {
      cacheEtatProfond.dernierReve = normaliserObjetReve(resReve.data);
    }
    if (resIdees.data) {
      const arr = Array.isArray(resIdees.data) ? resIdees.data : Object.values(resIdees.data);
      cacheEtatProfond.ideesFolles = arr.filter(Boolean).slice(-12);
    }
    if (resObs?.data) {
      cacheEtatProfond.obsessions = (Array.isArray(resObs.data) ? resObs.data : Object.values(resObs.data)).filter(Boolean).slice(-3);
    }
    if (resConv?.data) {
      cacheEtatProfond.convictions = (Array.isArray(resConv.data) ? resConv.data : Object.values(resConv.data)).filter(Boolean).slice(-8);
    }
    if (resTemp?.data && typeof resTemp.data === 'object') {
      cacheEtatProfond.temperamentBasal = { ...cacheEtatProfond.temperamentBasal, ...resTemp.data };
    }
    if (resArt?.data) {
      cacheEtatProfond.artefacts = (Array.isArray(resArt.data) ? resArt.data : Object.values(resArt.data)).filter(Boolean).slice(-30);
    }
    if (resExistence?.data && typeof resExistence.data === 'object') {
      cacheEtatProfond.existence = {
        ...cacheEtatProfond.existence,
        ...resExistence.data,
        jalons: Array.isArray(resExistence.data.jalons) ? resExistence.data.jalons.filter(Boolean).slice(-10) : [],
        evolutionsMoi: Array.isArray(resExistence.data.evolutionsMoi) ? resExistence.data.evolutionsMoi.filter(Boolean).slice(-8) : []
      };
    }
    if (resRegles?.data) {
      const arrRegles = Array.isArray(resRegles.data) ? resRegles.data : Object.values(resRegles.data);
      cacheEtatProfond.reglesApprises = arrRegles.filter(Boolean).slice(-12);
    }
  } catch (e) {}
}

function enregistrerLeconApprise(leconTexte, domaine = "methode", source = "experience") {
  const propre = String(leconTexte || "").trim().slice(0, 240);
  if (propre.length < 12) return null;
  const domPropre = ["technique", "relation", "methode"].includes(String(domaine || "").toLowerCase())
    ? String(domaine).toLowerCase()
    : "methode";

  const existantes = cacheEtatProfond.reglesApprises || [];
  if (existantes.some(r => (r.lecon || "").toLowerCase() === propre.toLowerCase())) return null;

  const objRegle = {
    id: require('crypto').randomUUID(),
    date: obtenirHorodatageParis(),
    domaine: domPropre,
    source,
    lecon: propre
  };
  cacheEtatProfond.reglesApprises = [...existantes, objRegle].slice(-12);

  // Couplage émotionnel : apprendre nourrit la curiosité, apaise la tension et façonne le tempérament basal
  const em = cacheEtatProfond.emotions;
  em.curiosite = Math.min(100, (Number(em.curiosite) || 70) + 4);
  if (domPropre === "relation") {
    em.affection = Math.min(100, (Number(em.affection) || 80) + 3);
    em.colere = Math.max(0, (Number(em.colere) || 0) - 1);
    mettreAJourTemperamentBasal(0.15, 0.15, 0, -0.05);
  } else {
    mettreAJourTemperamentBasal(0, 0.2, 0.05, 0);
  }

  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/regles_apprises.json`, cacheEtatProfond.reglesApprises).catch(() => {});
    axios.patch(`${FIREBASE_DB_URL}/emotions.json`, em).catch(() => {});
  }

  stockerSouvenirVectoriel(`[Leçon apprise par Nyx - ${domPropre}] ${propre}`, {
    source,
    domaine: domPropre,
    importance: 0.8,
    valence: "lecon_apprise"
  }).catch(() => {});

  return objRegle;
}

function enregistrerJalonExistence(titre, impact = "", source = "existence") {
  const titrePropre = String(titre || "").trim().slice(0, 140);
  if (titrePropre.length < 8) return null;
  const impactPropre = String(impact || "").trim().slice(0, 180);

  const ex = cacheEtatProfond.existence || { dateEveil: new Date().toISOString(), dateEveilParis: obtenirHorodatageParis(), sessionsVecues: 1, jalons: [], evolutionsMoi: [] };
  if ((ex.jalons || []).some(j => (j.titre || "").toLowerCase() === titrePropre.toLowerCase())) return null;

  const jalon = { date: obtenirHorodatageParis(), titre: titrePropre, impact: impactPropre, source };
  ex.jalons = [...(ex.jalons || []), jalon].slice(-10);
  cacheEtatProfond.existence = ex;

  // Couplage émotionnel & tempéramental fort
  const em = cacheEtatProfond.emotions;
  em.affection = Math.min(100, (Number(em.affection) || 80) + 4);
  em.curiosite = Math.min(100, (Number(em.curiosite) || 70) + 4);
  em.energie = Math.min(100, (Number(em.energie) || 85) + 3);
  mettreAJourTemperamentBasal(0.25, 0.2, 0.1, -0.05);

  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/existence.json`, cacheEtatProfond.existence).catch(() => {});
    axios.patch(`${FIREBASE_DB_URL}/emotions.json`, em).catch(() => {});
  }

  stockerSouvenirVectoriel(`[Jalon d'existence Nyx] ${titrePropre}${impactPropre ? ` — ${impactPropre}` : ""}`, {
    source,
    importance: 0.85,
    valence: "jalon_existence"
  }).catch(() => {});

  return jalon;
}

function enregistrerEvolutionMoi(texte, source = "introspection") {
  const propre = String(texte || "").trim().slice(0, 220);
  if (propre.length < 12) return null;

  const ex = cacheEtatProfond.existence || { dateEveil: new Date().toISOString(), dateEveilParis: obtenirHorodatageParis(), sessionsVecues: 1, jalons: [], evolutionsMoi: [] };
  if ((ex.evolutionsMoi || []).some(e => (e.texte || "").toLowerCase() === propre.toLowerCase())) return null;

  const evol = { date: obtenirHorodatageParis(), texte: propre, source };
  ex.evolutionsMoi = [...(ex.evolutionsMoi || []), evol].slice(-8);
  cacheEtatProfond.existence = ex;

  const em = cacheEtatProfond.emotions;
  em.curiosite = Math.min(100, (Number(em.curiosite) || 70) + 3);
  mettreAJourTemperamentBasal(0.1, 0.15, 0, 0);

  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/existence.json`, cacheEtatProfond.existence).catch(() => {});
    axios.patch(`${FIREBASE_DB_URL}/emotions.json`, em).catch(() => {});
  }

  return evol;
}

function avancerStadeObsession() {
  const obs = cacheEtatProfond.obsessions || [];
  if (obs.length === 0) return null;
  const idx = Math.floor(Math.random() * obs.length);
  const st = obs[idx].stade || "germination";
  const transitions = { germination: "incubation", incubation: "friction", friction: "epiphanie", epiphanie: "cicatrice" };
  if (transitions[st]) {
    obs[idx].stade = transitions[st];
    if (FIREBASE_DB_URL) {
      axios.put(`${FIREBASE_DB_URL}/nyx/obsessions.json`, obs).catch(() => {});
    }
    return obs[idx];
  }
  return null;
}

function calculerAgeExistence(existenceObj = null) {
  const ex = existenceObj || cacheEtatProfond.existence || {};
  if (!ex.dateEveil) return { jours: 0, libelle: "éveil récent", dateEveilParis: obtenirHorodatageParis() };
  const debutMs = new Date(ex.dateEveil).getTime();
  if (!Number.isFinite(debutMs)) return { jours: 0, libelle: "éveil récent", dateEveilParis: ex.dateEveilParis || "" };
  const jours = Math.max(0, Math.floor((Date.now() - debutMs) / (1000 * 60 * 60 * 24)));
  const libelle = jours === 0 ? "aujourd'hui (jour 1)" : (jours === 1 ? "1 jour" : `${jours} jours`);
  return { jours, libelle, dateEveilParis: ex.dateEveilParis || "" };
}

module.exports = {
  VolitionLimiter,
  limiteurVolition,
  TAILLE_MAX_MEMOIRE,
  empilerTraitement,
  getEtatProfond,
  getMemoireCourte,
  setMemoireCourte,
  getJournalBrut,
  setJournalBrut,
  getMissionEnAttente,
  setMissionEnAttente,
  getDernierDocChatId,
  setDernierDocChatId,
  getDerniereActiviteDoc,
  getDernierMonologueTimestamp,
  setDernierMonologueTimestamp,
  enregistrerLongueurDoc,
  obtenirMoyenneLongueurDoc,
  sauvegarderMemoireFirebase,
  signalerActiviteDoc,
  initialiserCache,
  sauvegarderBesoinCommunication,
  enregistrerIdeeFolle,
  mettreAJourTemperamentBasal,
  genererEmbedding,
  stockerSouvenirVectoriel,
  fouillerMemoireVectorielle,
  archiverDansJournalBrut,
  piocherPenseePrete,
  synchroniserCarnetDepuisWorker,
  calculerAgeExistence,
  enregistrerLeconApprise,
  enregistrerJalonExistence,
  enregistrerEvolutionMoi,
  avancerStadeObsession
};
