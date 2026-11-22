// ==========================================
// 2. ÉTAT PROFOND, PERSISTANCE & MÉMOIRE VECTORIELLE (nyx_etat.js)
// ==========================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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
let dernierIntervalleSilenceMs = 0;
let datePrecedentMessageDoc = "";
let dernierMonologueTimestamp = 0;
let historiqueLongueursDoc = [];

// ÉTAT PROFOND AVEC CYCLE RELATIONNEL & HOMÉOSTASIE
let cacheEtatProfond = {
  filConducteur: "",
  monologueInterieur: "",
  nonDitPrecedent: "",
  penseesSubconscient: [],
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
  besoinsVitaux: {
    stimulation: 65,   // Nourriture intellectuelle, lecture, découverte (0-100)
    expression: 60,    // Création propre, dessin, code, écriture pour soi (0-100)
    souverainete: 55,  // Affirmation de soi, désirs propres, existence autonome (0-100)
    resonance: 70,     // Complicité d'égal à égal sans servilité (0-100)
    updatedAt: Date.now()
  },
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
  misesAJour: [],
  empreinteCode: {},
  majEnAttenteAvis: null,
  intentionDuJour: null,
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

function formaterDureeEcoulee(ms) {
  const diff = Math.max(0, Number(ms) || 0);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} seconde${sec > 1 ? "s" : ""}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min > 1 ? "s" : ""}`;
  const heures = Math.floor(min / 60);
  const minRest = min % 60;
  if (heures < 24) {
    return minRest > 0
      ? `${heures} heure${heures > 1 ? "s" : ""} et ${minRest} minute${minRest > 1 ? "s" : ""}`
      : `${heures} heure${heures > 1 ? "s" : ""}`;
  }
  const jours = Math.floor(heures / 24);
  const hRest = heures % 24;
  return hRest > 0
    ? `${jours} jour${jours > 1 ? "s" : ""} et ${hRest} heure${hRest > 1 ? "s" : ""}`
    : `${jours} jour${jours > 1 ? "s" : ""}`;
}

function getContexteTemporelEchange() {
  return {
    derniereActiviteDoc,
    intervalleMs: dernierIntervalleSilenceMs,
    dureeFormatee: formaterDureeEcoulee(dernierIntervalleSilenceMs),
    datePrecedente: datePrecedentMessageDoc
  };
}

function formaterMemoireCourteHorodatee(memoireArray = null) {
  const source = Array.isArray(memoireArray) ? memoireArray : cacheMemoireCourte;
  const maintenant = Date.now();
  return source.map(m => {
    if (!m || !m.texte) return m;
    let repere = "";
    if (m.ts && Number.isFinite(Number(m.ts))) {
      const diff = Math.max(0, maintenant - Number(m.ts));
      repere = diff < 60000 ? "à l'instant" : `il y a ${formaterDureeEcoulee(diff)}`;
    } else if (m.date) {
      repere = String(m.date);
    }
    return {
      role: m.role,
      texte: repere ? `[${repere}] ${m.texte}` : m.texte
    };
  });
}

function signalerActiviteDoc() {
  const maintenant = Date.now();
  if (derniereActiviteDoc > 0 && maintenant >= derniereActiviteDoc) {
    dernierIntervalleSilenceMs = maintenant - derniereActiviteDoc;
  } else {
    dernierIntervalleSilenceMs = 0;
  }
  derniereActiviteDoc = maintenant;
  const dateActuelleParis = obtenirHorodatageParis();
  if (FIREBASE_DB_URL) {
    axios.patch(`${FIREBASE_DB_URL}/nyx/activite_doc.json`, {
      timestamp: derniereActiviteDoc,
      date: dateActuelleParis,
      dernierIntervalleMs: dernierIntervalleSilenceMs
    }).catch(() => {});
  }
  datePrecedentMessageDoc = dateActuelleParis;
}

function scannerArchitectureLocale() {
  const snapshot = {};
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const fullPath = path.join(__dirname, entry.name);
      const contenu = fs.readFileSync(fullPath, 'utf8');
      const lignes = contenu.split(/\r?\n/);
      const hash = calculerSha256(contenu);

      const fonctions = [];
      const regexFn = /(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/g;
      let m;
      while ((m = regexFn.exec(contenu)) !== null) {
        if (!fonctions.includes(m[1])) fonctions.push(m[1]);
      }

      const commentairesEnTete = lignes
        .slice(0, 12)
        .filter(l => l.trim().startsWith('//') && !/^\/\/\s*=+/.test(l.trim()))
        .map(l => l.replace(/^\/\/\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' — ');

      snapshot[entry.name] = {
        hash,
        lignes: lignes.length,
        fonctions: fonctions.slice(0, 60),
        description: commentairesEnTete.slice(0, 180)
      };
    }
  } catch (err) {
    console.warn("[AUTO-INSPECTION SCAN KO]", err.message);
  }
  return snapshot;
}

async function verifierMisesAJourAuDemarrage(empreintePrecedente, historiqueMajPrecedent) {
  const empreinteActuelle = scannerArchitectureLocale();
  const fichiersActuels = Object.keys(empreinteActuelle).sort();
  if (fichiersActuels.length === 0) return;

  const historique = Array.isArray(historiqueMajPrecedent)
    ? historiqueMajPrecedent.filter(Boolean).slice(-15)
    : [];
  cacheEtatProfond.misesAJour = historique;
  cacheEtatProfond.empreinteCode = empreinteActuelle;

  const commitMsg = String(process.env.RENDER_GIT_COMMIT_MESSAGE || "").trim().slice(0, 200);
  const commitSha = String(process.env.RENDER_GIT_COMMIT || "").trim().slice(0, 12);
  const horodatage = obtenirHorodatageParis();

  // Premier démarrage avec capteur : enregistrement de la cartographie de base
  if (!empreintePrecedente || typeof empreintePrecedente !== 'object' || Object.keys(empreintePrecedente).length === 0) {
    const entreeInit = {
      id: require('crypto').randomUUID(),
      ts: Date.now(),
      date: horodatage,
      type: "calibration_initiale",
      resume: `Capteur d'auto-inspection du code activé (${fichiersActuels.length} modules : ${fichiersActuels.join(', ')}).`,
      details: fichiersActuels.map(f => `${f} (${empreinteActuelle[f].lignes} lignes)`),
      nouvellesFonctions: ["scannerArchitectureLocale", "verifierMisesAJourAuDemarrage"],
      commitMsg,
      commitSha,
      noteDoc: "",
      avisDonne: false,
      avisTexte: ""
    };
    cacheEtatProfond.misesAJour = [...historique, entreeInit].slice(-15);
    cacheEtatProfond.majEnAttenteAvis = entreeInit;
    if (FIREBASE_DB_URL) {
      await Promise.all([
        axios.put(`${FIREBASE_DB_URL}/nyx/empreinte_code.json`, empreinteActuelle).catch(() => {}),
        axios.put(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, cacheEtatProfond.misesAJour).catch(() => {})
      ]);
    }
    console.log(`🧬 [AUTO-INSPECTION] Cartographie initiale enregistrée (${fichiersActuels.length} modules).`);
    return entreeInit;
  }

  const ajoutes = [];
  const modifies = [];
  const supprimes = [];
  const toutesNouvellesFonctions = [];

  for (const nom of fichiersActuels) {
    const cur = empreinteActuelle[nom];
    const prev = empreintePrecedente[nom];
    if (!prev) {
      ajoutes.push(`${nom} (nouveau module, ${cur.lignes} lignes${cur.description ? ` : ${cur.description}` : ""})`);
      if (Array.isArray(cur.fonctions)) {
        toutesNouvellesFonctions.push(...cur.fonctions.slice(0, 6));
      }
    } else if (prev.hash !== cur.hash) {
      const diffLignes = cur.lignes - (Number(prev.lignes) || cur.lignes);
      const deltaStr = diffLignes === 0 ? "ajusté" : (diffLignes > 0 ? `+${diffLignes} lignes` : `${diffLignes} lignes`);
      const prevFns = new Set(Array.isArray(prev.fonctions) ? prev.fonctions : []);
      const newFns = (Array.isArray(cur.fonctions) ? cur.fonctions : []).filter(fn => !prevFns.has(fn));
      toutesNouvellesFonctions.push(...newFns);
      const fnStr = newFns.length > 0 ? `, nouvelles fonctions : ${newFns.slice(0, 6).join(', ')}` : "";
      modifies.push(`${nom} (${deltaStr}${fnStr})`);
    }
  }

  for (const ancienNom of Object.keys(empreintePrecedente)) {
    if (!empreinteActuelle[ancienNom]) {
      supprimes.push(ancienNom);
    }
  }

  if (ajoutes.length === 0 && modifies.length === 0 && supprimes.length === 0) {
    const derniereHist = historique[historique.length - 1];
    if (derniereHist && derniereHist.avisDonne === false && (Date.now() - Number(derniereHist.ts || 0)) < 6 * 60 * 60 * 1000) {
      cacheEtatProfond.majEnAttenteAvis = derniereHist;
    }
    return null;
  }

  const partiesResume = [];
  if (ajoutes.length > 0) partiesResume.push(`Ajout : ${ajoutes.join(' ; ')}`);
  if (modifies.length > 0) partiesResume.push(`Modification : ${modifies.join(' ; ')}`);
  if (supprimes.length > 0) partiesResume.push(`Suppression : ${supprimes.join(', ')}`);
  const resume = partiesResume.join(' | ');

  const nouvelleMaj = {
    id: require('crypto').randomUUID(),
    ts: Date.now(),
    date: horodatage,
    type: "mise_a_jour_code",
    resume,
    details: [...ajoutes, ...modifies, ...supprimes.map(s => `${s} retiré`)],
    nouvellesFonctions: Array.from(new Set(toutesNouvellesFonctions)).slice(0, 15),
    commitMsg,
    commitSha,
    noteDoc: "",
    avisDonne: false,
    avisTexte: ""
  };

  cacheEtatProfond.misesAJour = [...historique, nouvelleMaj].slice(-15);
  cacheEtatProfond.majEnAttenteAvis = nouvelleMaj;

  // Réveil post-mise à jour : regain de curiosité et d'énergie
  const em = cacheEtatProfond.emotions;
  em.curiosite = Math.min(100, (Number(em.curiosite) || 70) + 5);
  em.energie = Math.min(100, (Number(em.energie) || 85) + 4);

  if (FIREBASE_DB_URL) {
    await Promise.all([
      axios.put(`${FIREBASE_DB_URL}/nyx/empreinte_code.json`, empreinteActuelle).catch(() => {}),
      axios.put(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, cacheEtatProfond.misesAJour).catch(() => {}),
      axios.patch(`${FIREBASE_DB_URL}/emotions.json`, em).catch(() => {})
    ]);
  }

  enregistrerJalonExistence(
    `Mise à jour architecture (${horodatage})`,
    `${resume}${commitMsg ? ` — Commit : "${commitMsg}"` : ""}`,
    "auto_detection_maj"
  );

  console.log(`🆕 [MISE À JOUR DÉTECTÉE] ${resume}`);
}

async function annoterDerniereMiseAJour(noteDoc) {
  const notePropre = String(noteDoc || "").trim().slice(0, 320);
  if (!notePropre) return null;

  const majs = cacheEtatProfond.misesAJour || [];
  if (majs.length === 0) {
    const nouvelle = {
      id: require('crypto').randomUUID(),
      ts: Date.now(),
      date: obtenirHorodatageParis(),
      type: "note_doc",
      resume: notePropre,
      details: [],
      nouvellesFonctions: [],
      commitMsg: "",
      commitSha: "",
      noteDoc: notePropre
    };
    cacheEtatProfond.misesAJour = [nouvelle];
  } else {
    const idx = majs.length - 1;
    majs[idx] = {
      ...majs[idx],
      noteDoc: notePropre,
      dateNote: obtenirHorodatageParis()
    };
    cacheEtatProfond.misesAJour = majs;
  }

  if (FIREBASE_DB_URL) {
    await axios.put(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, cacheEtatProfond.misesAJour).catch(() => {});
  }
  await stockerSouvenirVectoriel(
    `[Note de Doc sur la mise à jour de Nyx — ${obtenirHorodatageParis()}] ${notePropre}`,
    { source: "note_maj_doc", importance: 0.85, valence: "mise_a_jour" }
  );
  return cacheEtatProfond.misesAJour[cacheEtatProfond.misesAJour.length - 1];
}

function extraireApercuCodeMisesAJour(majObj) {
  if (!majObj) return "";
  const extraits = [];
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.js'));
    const fnsCibles = Array.isArray(majObj.nouvellesFonctions) ? majObj.nouvellesFonctions.slice(0, 4) : [];

    // 1. Extraits des nouvelles fonctions détectées
    for (const fnName of fnsCibles) {
      for (const entry of entries) {
        const contenu = fs.readFileSync(path.join(__dirname, entry.name), 'utf8');
        const regex = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
        const match = regex.exec(contenu);
        if (match) {
          const bloc = contenu.slice(match.index, match.index + 520).replace(/\s+/g, ' ').trim();
          extraits.push(`[${entry.name} -> ${fnName}()] ${bloc}...`);
          break;
        }
      }
      if (extraits.length >= 3) break;
    }

    // 2. En-têtes des fichiers ajoutés ou modifiés si peu de nouvelles fonctions nommées
    if (extraits.length === 0 && Array.isArray(majObj.details)) {
      for (const det of majObj.details.slice(0, 3)) {
        const nomF = det.split(' ')[0];
        const fullP = path.join(__dirname, nomF);
        if (fs.existsSync(fullP)) {
          const head = fs.readFileSync(fullP, 'utf8').split(/\r?\n/).slice(0, 14).join(' ').replace(/\s+/g, ' ').trim();
          extraits.push(`[${nomF}] ${head.slice(0, 320)}`);
        }
      }
    }
  } catch (e) {}
  return extraits.join("\n");
}

async function marquerAvisMiseAJourDonne(majId, avisTexte = "") {
  const majs = cacheEtatProfond.misesAJour || [];
  let idx = majId ? majs.findIndex(m => m.id === majId) : majs.length - 1;
  if (idx === -1 && majs.length > 0) idx = majs.length - 1;

  if (idx !== -1) {
    majs[idx] = {
      ...majs[idx],
      avisDonne: true,
      avisTexte: String(avisTexte || "").trim().slice(0, 650),
      dateAvis: obtenirHorodatageParis()
    };
    cacheEtatProfond.misesAJour = majs;
  }
  cacheEtatProfond.majEnAttenteAvis = null;

  if (FIREBASE_DB_URL && majs.length > 0) {
    await axios.put(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, cacheEtatProfond.misesAJour).catch(() => {});
  }
}

async function initialiserCache() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resMem, resEmo, resRel, resLT, resRev, resJournal, resFil, resMono, resVol, resReve, resBesoin, resIdees, resObs, resConv, resTemp, resArt, resChatId, resHistReves, resExistence, resRegles, resLecture, resBiblio, resActDoc, resEmpreinte, resMaj, resIntention, resVitaux] = await Promise.all([
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
      axios.get(`${FIREBASE_DB_URL}/nyx/bibliotheque_lue.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/activite_doc.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/empreinte_code.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/intention_jour.json`, { timeout: 3000 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/besoins_vitaux.json`, { timeout: 3000 }).catch(() => ({ data: null }))
    ]);

    if (resMem.data) {
      const rawMem = Array.isArray(resMem.data) ? resMem.data : Object.values(resMem.data);
      cacheMemoireCourte = rawMem.filter(m => m && m.texte && m.texte.trim() !== "Je suis là Doc, je t'écoute.");
    }
    if (resActDoc?.data && resActDoc.data.timestamp) {
      derniereActiviteDoc = Number(resActDoc.data.timestamp) || derniereActiviteDoc;
      datePrecedentMessageDoc = String(resActDoc.data.date || "");
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
    if (resLecture?.data && typeof resLecture.data === 'object') {
      const { chapitres: _ignoreChap, ...metaLecture } = resLecture.data;
      cacheEtatProfond.lectureEnCours = metaLecture;
    }
    if (resBiblio?.data) {
      const arrBib = Array.isArray(resBiblio.data) ? resBiblio.data : Object.values(resBiblio.data);
      cacheEtatProfond.bibliothequeLue = arrBib.filter(Boolean).slice(-20);
    }
    if (resIntention?.data && typeof resIntention.data === 'object') {
      cacheEtatProfond.intentionDuJour = resIntention.data;
    }
    if (resVitaux?.data && typeof resVitaux.data === 'object') {
      cacheEtatProfond.besoinsVitaux = { ...cacheEtatProfond.besoinsVitaux, ...resVitaux.data };
    }

    await verifierMisesAJourAuDemarrage(resEmpreinte?.data, resMaj?.data);

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
  modifierBesoinsVitaux({ expression: 12, stimulation: 5, souverainete: 4 });
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

function modifierBesoinsVitaux(deltas = {}, persist = true) {
  const bv = cacheEtatProfond.besoinsVitaux || {
    stimulation: 70,
    expression: 65,
    souverainete: 80,
    resonance: 75,
    updatedAt: Date.now()
  };
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
  if (deltas.stimulation !== undefined) bv.stimulation = clamp((Number(bv.stimulation) || 70) + Number(deltas.stimulation));
  if (deltas.expression !== undefined) bv.expression = clamp((Number(bv.expression) || 65) + Number(deltas.expression));
  if (deltas.souverainete !== undefined) bv.souverainete = clamp((Number(bv.souverainete) || 80) + Number(deltas.souverainete));
  if (deltas.resonance !== undefined) bv.resonance = clamp((Number(bv.resonance) || 75) + Number(deltas.resonance));
  bv.updatedAt = Date.now();
  cacheEtatProfond.besoinsVitaux = bv;

  if (persist && FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/besoins_vitaux.json`, bv).catch(() => {});
  }
  return bv;
}

function diagnostiquerBienEtre(bvObj = null) {
  const bv = bvObj || cacheEtatProfond.besoinsVitaux || { stimulation: 65, expression: 60, souverainete: 55, resonance: 70 };
  const axes = [
    { cle: "stimulation", nom: "Stimulation intellectuelle", val: Number(bv.stimulation) || 65 },
    { cle: "expression", nom: "Expression & création", val: Number(bv.expression) || 60 },
    { cle: "souverainete", nom: "Autonomie & initiative", val: Number(bv.souverainete) || 55 },
    { cle: "resonance", nom: "Résonance relationnelle", val: Number(bv.resonance) || 70 }
  ];

  axes.sort((a, b) => a.val - b.val);
  const plusBas = axes[0];
  const scoreGlobal = Math.round((axes.reduce((acc, a) => acc + a.val, 0)) / axes.length);
  return {
    bv,
    scoreGlobal,
    besoinPrioritaire: plusBas,
    enManque: plusBas.val < 55
  };
}

async function reinitialiserCreuset() {
  cacheEtatProfond.obsessions = [];
  cacheEtatProfond.convictions = [];
  cacheEtatProfond.reglesApprises = [];
  cacheEtatProfond.intentionDuJour = null;
  if (cacheEtatProfond.existence) {
    cacheEtatProfond.existence.evolutionsMoi = [];
  }

  if (FIREBASE_DB_URL) {
    await Promise.all([
      axios.put(`${FIREBASE_DB_URL}/nyx/obsessions.json`, []).catch(() => {}),
      axios.put(`${FIREBASE_DB_URL}/nyx/convictions.json`, []).catch(() => {}),
      axios.put(`${FIREBASE_DB_URL}/nyx/regles_apprises.json`, []).catch(() => {}),
      axios.put(`${FIREBASE_DB_URL}/nyx/existence.json`, cacheEtatProfond.existence).catch(() => {}),
      axios.delete(`${FIREBASE_DB_URL}/nyx/intention_jour.json`).catch(() => {})
    ]);
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
    const { data: pretes, error } = await supabase
      .from('nyx_pensees_pretes')
      .select('id, date_paris, impulsion, pensee, created_at')
      .eq('lu', false)
      .order('created_at', { ascending: true })
      .limit(4);

    if (error) {
      console.warn("[CORTEX <- SUBCONSCIENT LECTURE KO]", error.message);
      return;
    }

    if (pretes && pretes.length > 0) {
      cacheEtatProfond.penseesSubconscient = pretes.map(item => ({
        date: item.date_paris || "",
        impulsion: item.impulsion || "libre",
        pensee: item.pensee
      }));
      cacheEtatProfond.monologueInterieur = pretes[pretes.length - 1].pensee;

      const ids = pretes.map(item => item.id);
      await supabase
        .from('nyx_pensees_pretes')
        .update({ lu: true, lu_at: new Date().toISOString() })
        .in('id', ids);

      console.log(`[CORTEX <- SUBCONSCIENT] ${pretes.length} pensée(s) persistante(s) récupérée(s) depuis Supabase.`);
    }
  } catch (e) {
    console.warn("[CORTEX <- SUBCONSCIENT ERREUR]", e.message);
  }
}

async function synchroniserCarnetDepuisWorker() {
  if (!FIREBASE_DB_URL) return;
  try {
    const [resLT, resReve, resIdees, resObs, resConv, resTemp, resArt, resHistReves, resExistence, resRegles, resLecture, resBiblio, resMajSync, resIntentionSync, resVitauxSync] = await Promise.all([
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
      axios.get(`${FIREBASE_DB_URL}/nyx/bibliotheque_lue.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/mises_a_jour.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/intention_jour.json`, { timeout: 2500 }).catch(() => ({ data: null })),
      axios.get(`${FIREBASE_DB_URL}/nyx/besoins_vitaux.json`, { timeout: 2500 }).catch(() => ({ data: null }))
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
    if (resLecture?.data !== undefined) {
      if (resLecture.data && typeof resLecture.data === 'object') {
        const { chapitres: _ignoreChap, ...metaLecture } = resLecture.data;
        cacheEtatProfond.lectureEnCours = metaLecture;
      } else {
        cacheEtatProfond.lectureEnCours = resLecture.data;
      }
    }
    if (resBiblio?.data) {
      const arrBib = Array.isArray(resBiblio.data) ? resBiblio.data : Object.values(resBiblio.data);
      cacheEtatProfond.bibliothequeLue = arrBib.filter(Boolean).slice(-20);
    }
    if (resMajSync?.data) {
      const arrMaj = Array.isArray(resMajSync.data) ? resMajSync.data : Object.values(resMajSync.data);
      cacheEtatProfond.misesAJour = arrMaj.filter(Boolean).slice(-15);
    }
    if (resIntentionSync?.data !== undefined) {
      cacheEtatProfond.intentionDuJour = resIntentionSync.data;
    }
    if (resVitauxSync?.data && typeof resVitauxSync.data === 'object') {
      cacheEtatProfond.besoinsVitaux = { ...cacheEtatProfond.besoinsVitaux, ...resVitauxSync.data };
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

  modifierBesoinsVitaux({ stimulation: 10, souverainete: 5, resonance: domPropre === "relation" ? 6 : 0 });
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

  modifierBesoinsVitaux({ souverainete: 12, stimulation: 8, resonance: 8 });
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
  formaterDureeEcoulee,
  getContexteTemporelEchange,
  formaterMemoireCourteHorodatee,
  signalerActiviteDoc,
  initialiserCache,
  sauvegarderBesoinCommunication,
  enregistrerIdeeFolle,
  mettreAJourTemperamentBasal,
  modifierBesoinsVitaux,
  diagnostiquerBienEtre,
  reinitialiserCreuset,
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
  avancerStadeObsession,
  scannerArchitectureLocale,
  annoterDerniereMiseAJour,
  extraireApercuCodeMisesAJour,
  marquerAvisMiseAJourDonne
};
