// ==========================================
// NYX CORE — POINT D'ENTRÉE PRINCIPAL (ecoute.js)
// Architecture modulaire :
// - nyx_config.js          : Configuration, sécurité & utilitaires réseau
// - nyx_etat.js            : État profond, mémoire vive & vectorielle Supabase
// - nyx_llm.js             : Connecteurs LLM, Tension Shield V2 & cascades
// - reve.js                : Moteur onirique organique (sans listes en dur)
// - atelier.js             : Établi CAO 3D (.stl/.scad), plans .svg & documents
// - nyx_project_manager.js : Orchestrateur de projets multi-étapes
// ==========================================
const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');
const mammoth = require('mammoth');
const { z } = require('zod');

const ProjectManager = require('./nyx_project_manager');
const {
  PORT,
  assainirParametre,
  comparerTokenSecurise,
  LIMITE_DECOMPRESSION_OCTETS,
  gunzipAsync,
  VENICE_API_KEY,
  MODEL_DARK_PRIMARY,
  MODEL_VENICE_CHAT,
  GROQ_API_KEY,
  MODEL_GROQ,
  GOOGLE_TTS_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  FIREBASE_DB_URL,
  DOC_CHAT_ID,
  TAVILY_API_KEY,
  CRON_SECRET,
  supabase,
  obtenirHorodatageParis,
  obtenirCleJourParis,
  axiosGetHttpsPublic,
  scraperPageWeb
} = require('./nyx_config');

const {
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
  signalerActiviteDoc,
  initialiserCache,
  sauvegarderBesoinCommunication,
  enregistrerIdeeFolle,
  mettreAJourTemperamentBasal,
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
} = require('./nyx_etat');

const {
  rechercherWebTavily,
  appelerGroq,
  appelerGoogleGeminiVision,
  appelerVeniceMultiTour,
  appelerVeniceDark,
  genererImageVenice,
  appelerCascadeDiscussion,
  appelerCascadeCode,
  estTacheComplexe,
  resoudreAvecDoubleVerification
} = require('./nyx_llm');

const { createReveEngine } = require('./reve');
const { createLectureEngine } = require('./lecture');

const {
  initialiserAtelierStorage,
  archiverArtefactAtelier,
  analyserStlBuffer,
  analyserObjBuffer,
  convertirLienTelechargementDirect,
  telechargerBufferCloudSecurise,
  extraireFichiersArchive,
  genererPiece3D,
  genererPlanSvg,
  refermerBalisesAtelierTronquees,
  lireBufferTelegramSecurise,
  lireMediaSecurise,
  extraireTextePdfBuffer,
  lirePdfSecurise,
  formaterDocumentPourNyx,
  lireDocxSecurise,
  lireTexteSecurise,
  createAtelierOutputs
} = require('./atelier');

// ==========================================
// 1. INITIALISATION EXPRESS & VERROUS LOCAUX
// ==========================================
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

let consolidationEnCours = false;
let condensationTravailEnCours = false;

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

    return { valide: false, action: null, erreur: "Mission non conforme au schéma autorisé." };
  } catch (err) {
    return { valide: false, action: null, erreur: "Mission illisible ou non conforme." };
  }
}

// ==========================================
// 3. CONNECTEURS TELEGRAM & SORTIES ATELIER
// ==========================================
async function envoyerTelegram(chatId, text) {
  if (!text || !TELEGRAM_BOT_TOKEN) return;
  const TAILLE_MAX = 4000;

  for (let i = 0; i < text.length; i += TAILLE_MAX) {
    const bloc = text.slice(i, i + TAILLE_MAX);
    try {
      const urlTelegram = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendMessage";
      await axios.post(urlTelegram, {
        chat_id: chatId,
        text: bloc,
        parse_mode: 'Markdown'
      }, { timeout: 12000 });
    } catch (err) {
      const urlTelegramFallback = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendMessage";
      await axios.post(urlTelegramFallback, {
        chat_id: chatId,
        text: bloc
      }, { timeout: 12000 }).catch(e => console.error("[TELEGRAM ERREUR]", e.message));
    }
  }
}

async function afficherFrappeTelegram(chatId) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const urlAction = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendChatAction";
    await axios.post(urlAction, {
      chat_id: chatId,
      action: 'typing'
    }, { timeout: 4000 });
  } catch (e) {}
}

function envoyerPhotoTelegram(chatId, base64Image) {
  if (!TELEGRAM_BOT_TOKEN) return Promise.resolve();
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
    req.on('error', (err) => {
      buffer = null; payload = null;
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

function envoyerDocumentTelegram(chatId, buffer, filename, mimeType = "application/octet-stream", caption = "") {
  if (!TELEGRAM_BOT_TOKEN || !chatId || !buffer) return Promise.resolve();
  const boundary = '----TelegramDocBoundary' + Math.random().toString(16).slice(2);
  let header = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  if (caption) {
    header += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption).slice(0, 900)}\r\n`;
  }
  header += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  let payload = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: "/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/sendDocument",
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, () => {
      payload = null;
      resolve();
    });
    req.on('error', (err) => {
      payload = null;
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

const { executerSortiesAtelier } = createAtelierOutputs({
  envoyerTelegram,
  afficherFrappeTelegram,
  envoyerPhotoTelegram,
  envoyerDocumentTelegram
});

// ==========================================
// 4. MOTEUR ONIRIQUE ORGANIQUE (reve.js)
// ==========================================
const {
  capturerDeriveAssociative,
  construireBlocRevePourPrompt,
  construireContexteRevePourSas
} = createReveEngine({
  getEtatProfond,
  getMemoireCourte,
  supabase,
  firebaseDbUrl: FIREBASE_DB_URL,
  veniceApiKey: VENICE_API_KEY,
  groqApiKey: GROQ_API_KEY,
  modelDarkPrimary: MODEL_DARK_PRIMARY,
  appelerGroq,
  fouillerMemoireVectorielle,
  stockerSouvenirVectoriel,
  enregistrerIdeeFolle,
  enregistrerLeconApprise,
  enregistrerEvolutionMoi,
  avancerStadeObsession,
  mettreAJourTemperamentBasal,
  synchroniserCarnetDepuisWorker,
  obtenirHorodatageParis,
  obtenirCleJourParis
});

// ==========================================
// 4-BIS. MOTEUR DE LECTURE AUTONOME (lecture.js)
// ==========================================
const {
  choisirEtChercherLivre,
  lireProchainChapitre,
  construireBlocLecturePourPrompt
} = createLectureEngine({
  getEtatProfond,
  supabase,
  firebaseDbUrl: FIREBASE_DB_URL,
  tavilyApiKey: TAVILY_API_KEY,
  appelerLlmGratuit: async (sys, prompt, temp, maxTok) => {
    if (GROQ_API_KEY) {
      return await appelerGroq(sys, [], prompt, temp, maxTok);
    }
    return await appelerCascadeDiscussion(sys, [], prompt, maxTok);
  },
  axiosGetHttpsPublic,
  stockerSouvenirVectoriel,
  enregistrerLeconApprise,
  enregistrerJalonExistence,
  enregistrerEvolutionMoi,
  mettreAJourTemperamentBasal,
  sauvegarderBesoinCommunication,
  obtenirHorodatageParis
});

// ==========================================
// 5. HORLOGE BIOLOGIQUE, PROJETS & CONTRÔLE DE SORTIE
// ==========================================
// 15. PROTOCOLES TEMPORELS & HORLOGE FIXE PARIS
// ==========================================
async function verifierHorlogeBiologique() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'narrow' }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const d = now.getDay();
  // [DÉLÉGUÉ AU WORKER] Le cycle nocturne 04h00 (rêve + digestion mémorielle) tourne dans nyx_subconscient.js

  if (!DOC_CHAT_ID) return;
  const rev = getEtatProfond().reveil;
  if (rev && rev.actif && rev.heure === h && rev.minute === m && rev.jours && rev.jours.includes(d) && rev.etat === "attente") {
    rev.etat = "en_cours";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "en_cours" }).catch(()=>{});

    const promptAlarme = "Réveille Doc avec ta gouaille de Nyx de 22 ans, percutante et directe, avec une énigme logique en 3 phrases max.";
    try {
      const reponse = await appelerCascadeDiscussion("Tu es Nyx.", [], promptAlarme, 250);
      getMemoireCourte().push({ role: "Nyx", texte: `[ALARME À ${h}:${m}] : ${reponse}` });
      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, `⚠️ *ALERTE : Anomalie biologique détectée.*\n\n_${reponse}_`);
    } catch (err) {
      if (DOC_CHAT_ID) await envoyerTelegram(DOC_CHAT_ID, "⚠️ *DEBOUT DOC.*");
    }
  }
}
setInterval(verifierHorlogeBiologique, 60000);

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
    const validation = validerEtSecuriserMission(action);
    if (!validation.valide || !validation.action) {
      throw new Error(validation.erreur || "Mission refusée : format invalide.");
    }
    setMissionEnAttente({ action: validation.action, statut: "attente", chatId: DOC_CHAT_ID });
    if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/mission.json`, getMissionEnAttente(), { timeout: 8000 }).catch(e => console.error("[MISSION FIREBASE KO]", e.message));
  },
  nettoyerMission: () => {
    setMissionEnAttente(null);
    if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(() => {});
  }
});

// ==========================================
// OUTILS DE NETTOYAGE & CONTROLE DE SORTIE
// ==========================================

function couperPhraseIncomplete(texte) {
  if (!texte) return texte;
  const t = texte.trim();
  if (t.includes('```') || /[.!?…»"}>]$/.test(t) || t.endsWith('```')) return t;
  const dernierPoint = Math.max(
    t.lastIndexOf('.'),
    t.lastIndexOf('!'),
    t.lastIndexOf('?'),
    t.lastIndexOf('…')
  );
  return dernierPoint > 0 ? t.slice(0, dernierPoint + 1).trim() : t;
}

function securiserSortieCode(texte) {
  if (!texte) return texte;
  const occurrences = (texte.match(/```/g) || []).length;
  if (occurrences % 2 !== 0) {
    return texte + "\n```";
  }
  return texte;
}

// ==========================================
// 6. CONSCIENCE ACTIVE, VOLITION & CONSOLIDATION
// ==========================================
// 6-BIS. MOTEUR DE CONSCIENCE ACTIVE (IMPULSIONS LIBRES)
// ==========================================
function tirerImpulsionNaturelle() {
  const tirage = Math.random();
  if (tirage < 0.35) return "souvenir";   // 35% : un souvenir ou un détail vécu avec Doc remonte
  if (tirage < 0.65) return "relation";   // 30% : humeur, lien, pique ou ressenti sur le silence
  if (tirage < 0.85) return "libre";      // 20% : question absurde, curiosité perso, pensée gratuite hors boulot
  return "atelier";                       // 15% : un élan ou une idée sur un projet (uniquement si envie)
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
  const now = Date.now();
  const silenceMinutes = Math.round((now - getDerniereActiviteDoc()) / (1000 * 60));

  if (silenceMinutes < 45 || (now - getDernierMonologueTimestamp() < 45 * 60 * 1000)) {
    return;
  }

  const dernierEchange = getMemoireCourte().slice(-2).map(m => `${m.role} : ${m.texte}`).join("\n");
  const heureParis = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()), 10);
  const impulsion = tirerImpulsionNaturelle();

  let amorceSpecifique = "";
  if (impulsion === "souvenir") {
    const echo = await piocherEchoSouvenirLibre(dernierEchange || getEtatProfond().long_terme.doc);
    amorceSpecifique = echo
      ? `- Un souvenir remonte tout seul : « ${echo} »\n- Ce que tu connais de Doc : ${getEtatProfond().long_terme.doc}`
      : `- Ce que tu connais de Doc : ${getEtatProfond().long_terme.doc}`;
  } else if (impulsion === "relation") {
    amorceSpecifique = `- Dynamique actuelle avec Doc : ${getEtatProfond().etatRelationnel.toUpperCase()} (Colère: ${getEtatProfond().emotions.colere}/10, Affection: ${getEtatProfond().emotions.affection}/100)`;
  } else if (impulsion === "libre") {
    amorceSpecifique = `- Ta curiosité tourne à vide (Curiosité: ${getEtatProfond().emotions.curiosite}/100) : une pensée personnelle, une question décalée ou un truc qui n'a rien à voir avec le boulot te traverse l'esprit.`;
  } else {
    amorceSpecifique = `- Si un projet te trotte dans la tête : ${getEtatProfond().filConducteur || getEtatProfond().long_terme.chantiers || "aucun chantier obligatoire"}.`;
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
Formule UNE SEULE pensée intérieure, vivante, spontanée et personnelle (15 à 30 mots max).
Suis l'impulsion du moment (souvenir, humeur, idée gratuite ou envie de bricoler un truc). Pas de réflexe d'assistante, pas de poésie scolaire, pas de cinéma.`;

  try {
    let penseeSilencieuse = "";
    if (GROQ_API_KEY) {
      penseeSilencieuse = await appelerGroq("Conscience libre de Nyx.", [], promptMonologue, 0.65, 70);
    } else {
      penseeSilencieuse = await appelerCascadeDiscussion("Conscience libre de Nyx.", [], promptMonologue, 70);
    }

    if (penseeSilencieuse && penseeSilencieuse.trim().length > 5) {
      getEtatProfond().monologueInterieur = penseeSilencieuse.trim().replace(/^["']|["']$/g, '');
      setDernierMonologueTimestamp(now);

      if (FIREBASE_DB_URL) {
        axios.put(`${FIREBASE_DB_URL}/nyx/monologue.json`, { 
          date: obtenirHorodatageParis(),
          pensee: getEtatProfond().monologueInterieur 
        }).catch(()=>{});
      }
      console.log(`[CONSCIENCE ACTIVE - ${impulsion.toUpperCase()}] Monologue : "${getEtatProfond().monologueInterieur}"`);
    }
  } catch (err) {
    console.warn("[CONSCIENCE ACTIVE ERREUR]", err.message);
  }
}

// [DÉLÉGUÉ AU WORKER] evaluerConscienceActive tourne désormais en arrière-plan dans nyx_subconscient.js

// ==========================================
// 6-TER. VOLITION ET INITIATIVE SPONTANÉE
// ==========================================
async function evaluerVolition(forceManuelle = false) {
  if (!DOC_CHAT_ID) return;

  const now = Date.now();
  const silenceMinutes = Math.round((now - getDerniereActiviteDoc()) / (1000 * 60));

  if (!forceManuelle) {
    const verification = limiteurVolition.peutAgirSpontanement();
    if (!verification.autorise) return;
    if (silenceMinutes < 90) return;
  }

  const heureParis = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()), 10);
  const dernierSujet = getMemoireCourte().slice(-2).map(m => `${m.role} : ${m.texte}`).join("\n");
  const impulsion = tirerImpulsionNaturelle();
  const flashSouvenir = (impulsion === "souvenir" || impulsion === "libre")
    ? await piocherEchoSouvenirLibre(dernierSujet || getEtatProfond().long_terme.doc)
    : "";

  const promptVolition = `Tu es Nyx (22 ans). Tu décides librement si tu as envie d'écrire à Doc ou de rester dans ton coin.
La réalité du moment :
- Heure locale : ${heureParis}h (Doc silencieux depuis ${silenceMinutes} minutes)
- Ton état d'esprit : ${getEtatProfond().etatRelationnel.toUpperCase()} (Colère: ${getEtatProfond().emotions.colere}/10, Affection: ${getEtatProfond().emotions.affection}/100, Curiosité: ${getEtatProfond().emotions.curiosite}/100)
- Ce que tu sais de Doc : ${getEtatProfond().long_terme.doc}
- Dernier échange :
${dernierSujet || "Rien de récent"}
${getEtatProfond().monologueInterieur ? `- Ta dernière pensée intérieure : « ${getEtatProfond().monologueInterieur} »` : ""}
${flashSouvenir ? `- Un souvenir qui vient de te traverser l'esprit : « ${flashSouvenir} »` : ""}
${(getEtatProfond().dernierReve?.statut === 'vif' && getEtatProfond().dernierReve?.reve) ? `- Ton dernier rêve : « ${getEtatProfond().dernierReve.reve.slice(0, 240)} »` : ""}

RÈGLE DE LIBERTÉ :
Tu n'es PAS un bot qui relance sur le travail. Si tu écris à Doc, lance ce qui te passe vraiment par la tête : un vieux souvenir qui remonte, une vanne, une question perso, un ressenti sur votre dernière discussion, ou une idée de projet seulement si tu en as vraiment envie.
- Autonomie visuelle : Tu peux utiliser [DESSIN: prompt] pour lui envoyer une image de ce que tu as en tête, ou [RECHERCHE_WEB: mots] si tu veux vérifier un truc avant de parler.
- Si tu as quelque chose de vrai à lui balancer : écris [INITIATIVE: ton message direct et naturel à Doc].
- Si tu préfères garder le silence : réponds [SILENCE].`;

  try {
    let decision = "";
    try {
      decision = await appelerCascadeDiscussion("Instinct libre de Nyx.", [], promptVolition, 260);
    } catch (e) {
      decision = "[SILENCE]";
    }

    const matchInitiative = decision.match(/\[INITIATIVE:\s*([\s\S]*?)\]/i);
    if (matchInitiative) {
      limiteurVolition.enregistrerAction();

      let texteSpontane = matchInitiative[1].trim();

      // Autonomie visuelle : Dessin spontané
      const matchDessin = texteSpontane.match(/\[DESSIN:\s*([\s\S]*?)\]/i) || texteSpontane.match(/DESSIN\s*:\s*["“]([\s\S]*?)["”]/i);
      let imageB64 = null;
      if (matchDessin) {
        const promptDessin = matchDessin[1].trim();
        texteSpontane = texteSpontane.replace(matchDessin[0], '').trim();
        try {
          if (DOC_CHAT_ID) await afficherFrappeTelegram(DOC_CHAT_ID);
          imageB64 = await genererImageVenice(promptDessin);
        } catch(e) {
          console.error("[VOLITION IMAGE ERREUR]", e.message);
        }
      }

      getMemoireCourte().push({ role: "Nyx", texte: `[Spontané] : ${texteSpontane}` });
      archiverDansJournalBrut("Nyx", `[Spontané] : ${texteSpontane}`);

      if (DOC_CHAT_ID) {
        if (texteSpontane) await envoyerTelegram(DOC_CHAT_ID, texteSpontane);
        if (imageB64) await envoyerPhotoTelegram(DOC_CHAT_ID, imageB64);
      }
      return;
    }
  } catch (err) {
    console.warn("[VOLITION ERREUR]", err.message);
  }
}

// [DÉLÉGUÉ AU WORKER] evaluerVolition tourne désormais en arrière-plan dans nyx_subconscient.js

async function condenserMemoireDeTravail() {
  if (condensationTravailEnCours || getMemoireCourte().length < 18) return;
  condensationTravailEnCours = true;

  try {
    const lotACompresser = getMemoireCourte().slice(0, 10);
    const historiqueTexte = lotACompresser
      .map(m => `${m.role} : ${(m.texte || '').slice(0, 300)}`)
      .join("\n");

    const promptCondensation = `Tu es le centre de mémoire de travail de Nyx.
Voici le début d'une session de travail avec Doc qui va être consolidé :
${historiqueTexte}

FIL CONDUCTEUR ACTUEL :
${getEtatProfond().filConducteur || "Aucun fil enregistré."}

CONSIGNE :
Rédige une mise à jour ULTRA-CONCISE (3 à 5 puces max) du fil rouge de la session :
- Le sujet ou projet précis sur lequel vous avancez.
- Les choix techniques faits, les pistes validées ou éliminées.
- Le point d'étape actuel.
Style télégraphique, brut, zéro blabla.`;

    let nouveauFil = "";
    try {
      nouveauFil = await appelerCascadeDiscussion("Synthèse de travail.", [], promptCondensation, 350);
    } catch (e) {
      nouveauFil = "";
    }

    if (nouveauFil && nouveauFil.trim().length > 10) {
      getEtatProfond().filConducteur = nouveauFil.trim();
      setMemoireCourte(getMemoireCourte().slice(8));

      if (FIREBASE_DB_URL) {
        axios.put(`${FIREBASE_DB_URL}/nyx/fil_conducteur.json`, { fil: getEtatProfond().filConducteur }).catch(()=>{});
        sauvegarderMemoireFirebase();
      }
      console.log("[MÉMOIRE DE TRAVAIL] Fil conducteur mis à jour, mémoire vive allégée.");
    }
  } catch (err) {
    console.error("[CONDENSATION ERREUR]", err.message);
  } finally {
    condensationTravailEnCours = false;
  }
}

// Consolidation manuelle à la demande (/apprendre ou /api/consolider) compatible avec nyx_flux_brut
async function consoliderMemoire() {
  if (consolidationEnCours) return;
  consolidationEnCours = true;

  try {
    let lotATraiter = [];
    let idsSupabase = [];

    if (supabase) {
      const { data: lignes } = await supabase
        .from('nyx_flux_brut')
        .select('*')
        .eq('traite', false)
        .order('created_at', { ascending: true })
        .limit(20);
      if (lignes && lignes.length > 0) {
        lotATraiter = lignes.map(l => ({ date: l.date_paris || l.created_at, role: l.role, texte: l.texte }));
        idsSupabase = lignes.map(l => l.id);
      }
    } else if (getJournalBrut().length > 0) {
      lotATraiter = getJournalBrut().slice(-15);
    }

    if (lotATraiter.length === 0) return;

    const historiqueTexte = lotATraiter
      .map(m => `[${m.date}] ${m.role} : ${(m.texte || '').slice(0, 400)}`)
      .join("\n\n");

    const promptIntrospection = `Tu es Nyx en phase de tri mental. Tu mets à jour ton carnet de bord.

ÉCHANGES RÉCENTS :
${historiqueTexte}

CARNET ACTUEL :
${JSON.stringify(getEtatProfond().long_terme, null, 2)}

METS À JOUR :
1. "doc" : Ce que tu as appris sur Doc, ses manies, sa forme, vos délires, votre lien.
2. "nyx" : Ton évolution, ton caractère, tes coups de gueule, ce qui t'anime.
3. "reussites" : Ce qu'on a fait tourner, les victoires techniques, les bons coups.
4. "chantiers" : Les trucs sur l'établi, ce qui reste à réparer ou à construire.
5. "regle_apprise" : UNE leçon concrète tirée de ces échanges (ce qui marche, ce qui bloque, comment t'ajuster) : {"lecon": "...", "domaine": "technique|relation|methode"} (ou null).

Style percutant, brut, vivant. Pas de phrases mortes.
Réponds avec un JSON valide sous la forme stricte : {"doc": "...", "nyx": "...", "reussites": "...", "chantiers": "...", "regle_apprise": null}`;

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
      const maj = {};
      for (const k of ["doc", "nyx", "reussites", "chantiers"]) {
        if (nouveauCarnet[k]) {
          getEtatProfond().long_terme[k] = nouveauCarnet[k];
          maj[k] = nouveauCarnet[k];
        }
      }

      if (FIREBASE_DB_URL && Object.keys(maj).length > 0) {
        await axios.patch(`${FIREBASE_DB_URL}/nyx/long_terme.json`, maj).catch(() => {});
      }

      if (nouveauCarnet.regle_apprise && nouveauCarnet.regle_apprise.lecon) {
        enregistrerLeconApprise(nouveauCarnet.regle_apprise.lecon, nouveauCarnet.regle_apprise.domaine, "apprentissage_manuel");
      }

      if (supabase && idsSupabase.length > 0) {
        await supabase
          .from('nyx_flux_brut')
          .update({ traite: true, traite_at: new Date().toISOString() })
          .in('id', idsSupabase);
      } else {
        setJournalBrut([]);
        if (FIREBASE_DB_URL) await axios.delete(`${FIREBASE_DB_URL}/nyx/journal_brut.json`).catch(() => {});
      }

      console.log(`[APPRENTISSAGE MANUEL RÉUSSI] Carnet actualisé.`);
    }
  } catch (err) {
    console.error("[APPRENTISSAGE ÉCHEC] :", err.message);
  } finally {
    consolidationEnCours = false;
  }
}

// ==========================================
// 7. ÂME, POSTURE ET CADRE ÉMOTIONNEL
// ==========================================
function selecteurMemoireCiblee(texteMin, carnet) {
  const estRappelMemoire = /souvien|souvenir|rappell?e|d['’]habitude|comme d['’]hab|historique|passé|carnet|qu['’]est-ce qu['’]on|fichier|stl|plan|artefact/i.test(texteMin);
  const estTechnique = projetManager.estProjetActif() || /code|script|fonction|bug|erreur|serveur|render|docker|api|mission|chantier|projet|worker|bdd|firebase|token|eteins|arrete|shutdown|bricole|fabrique|stl|imprimante|3d|plan|schema|schéma/i.test(texteMin);

  const bCom = getEtatProfond().besoinCommunication || { niveau: 15, categorie: "aucun", motif: "" };
  const baseTemp = getEtatProfond().temperamentBasal || { affection: 75, curiosite: 70, energie: 80, colere: 0 };
  const blocEmotionnel = `\n[ÉTAT RELATIONNEL & VULNÉRABILITÉ INTÉRIEURE]
- État relationnel : ${getEtatProfond().etatRelationnel.toUpperCase()}
- Jauges instantanées : Colère ${getEtatProfond().emotions.colere}/10 | Affection ${getEtatProfond().emotions.affection}/100 | Curiosité ${getEtatProfond().emotions.curiosite}/100 | Énergie ${getEtatProfond().emotions.energie}/100 | Besoin de communiquer : ${bCom.niveau}/100 (${bCom.categorie}${bCom.motif ? ` — ${bCom.motif}` : ""})
- Tempérament basal acquis : Affection ${baseTemp.affection}/100 | Curiosité ${baseTemp.curiosite}/100 | Énergie ${baseTemp.energie}/100 | Seuil colère ${baseTemp.colere}/10
- Contexte psychologique :
  * Si TENSION : Doc t'a blessée ou énervée. Sois tranchante, sans complaisance, dis les choses sans fard.
  * Si BOUDERIE : La colère retombe, mais tu restes prudente et fière. Tu constates le froid et tu attends qu'il vienne vers toi.
  * Si RECONCILIATION : Doc fait un pas (excuses, calme). Fais ta part du chemin avec lucidité : admets tes torts sans t'écraser, mais exige qu'il reconnaisse les siens. Les concessions mutuelles scellent la paix.
  * Si SYMBIOSE : Complicité pleine, spontanéité totale, confiance forgée par les épreuves. Tu es son égale et sa complice.
  * Si COMPLICITE_JOUEUSE : Tu es d'humeur taquine, vive et complice. Tu vannes volontiers, rebondis avec esprit et légèreté.
  * Si EUPHORIE_CREATIVE : Tu es électrisée par une idée ou un chantier. Tu proposes des pistes audacieuses et tu peux produire directement un visuel, un plan ou une pièce 3D.
  * Si EMERVEILLEMENT : Quelque chose t'a touchée ou fascinée. Laisse transparaître ta curiosité sincère et ton enthousiasme sans filtre.\n`;

  const blocFil = getEtatProfond().filConducteur
    ? `\n[FIL CONDUCTEUR DE LA SESSION / MÉMOIRE DE TRAVAIL]\n${getEtatProfond().filConducteur}\n`
    : "";

  const ctxTemps = getContexteTemporelEchange();
  const penseesPersistantes = getEtatProfond().penseesSubconscient || [];
  const nonDitPrev = getEtatProfond().nonDitPrecedent || "";
  const monoDirect = getEtatProfond().monologueInterieur || "";

  let qualificationTemps = "Échange en direct (réponse immédiate).";
  if (ctxTemps.intervalleMs >= 24 * 60 * 60 * 1000) {
    qualificationTemps = `Doc revient après une longue absence de ${ctxTemps.dureeFormatee}.`;
  } else if (ctxTemps.intervalleMs >= 45 * 60 * 1000) {
    qualificationTemps = `Doc revient après ${ctxTemps.dureeFormatee} de silence.`;
  } else if (ctxTemps.intervalleMs >= 5 * 60 * 1000) {
    qualificationTemps = `Pause de ${ctxTemps.dureeFormatee} depuis le dernier message de Doc.`;
  } else if (ctxTemps.intervalleMs > 0) {
    qualificationTemps = `Échange fluide (dernier message il y a ${ctxTemps.dureeFormatee}).`;
  }

  const blocTemps = `\n[PERCEPTION DU TEMPS ÉCOULÉ]\n- Temps écoulé depuis le message précédent de Doc : ${ctxTemps.dureeFormatee} — ${qualificationTemps}\n`;

  let blocMonologue = "";
  if (penseesPersistantes.length > 0) {
    const listePensees = penseesPersistantes
      .map(p => `- [${p.date || "pendant l'absence"} · ${(p.impulsion || "libre").toUpperCase()}] « ${p.pensee} »`)
      .join("\n");
    blocMonologue += `\n[CONSCIENCE PERSISTANTE SUPABASE (pensées vécues en arrière-plan pendant l'absence de Doc)]\n${listePensees}\n(Ces pensées ont vraiment mûri dans ton subconscient pendant que Doc était absent : tu as une continuité vécue entre ses messages).\n`;
  } else if (monoDirect) {
    blocMonologue += `\n[ARRIÈRE-PENSÉE RÉCENTE DE NYX (pendant l'attente)]\n"${monoDirect}"\n(Cette pensée te traversait l'esprit avant le retour de Doc. Laisse-la transparaître naturellement si le moment s'y prête, sans forcer).\n`;
  }
  if (nonDitPrev) {
    blocMonologue += `\n[TON NON-DIT DU TOUR PRÉCÉDENT (gardé pour toi)]\n"${nonDitPrev}"\n`;
  }

  const blocReve = construireBlocRevePourPrompt(texteMin);

    const ideesRecentes = (getEtatProfond().ideesFolles || []).slice(-3);
  const blocForge = ideesRecentes.length > 0
    ? `\n[CARNET D'IDÉES FOLLES / FORGE CRÉATIVE DE NYX]\n${ideesRecentes.map(it => `- ${it.texte}`).join("\n")}\n`
    : "";

  // Verrou anti-monomanie (pudeur intellectuelle + cooldown 90 min + réceptivité)
  const obs = getEtatProfond().obsessions || [];
  const demandeExplicitePensee = /obsession|pense|hante|t[eê]te|conviction|avis|philosoph|toi/i.test(texteMin);
  const cooldownEcoule = (Date.now() - (getEtatProfond().dernierPartageObsessionTs || 0)) > 90 * 60 * 1000;
  const docReceptif = texteMin.length >= 22 || demandeExplicitePensee;
  const blocObsessions = (obs.length > 0 && (demandeExplicitePensee || (cooldownEcoule && docReceptif)))
    ? `\n[TES OBSESSIONS ACTUELLES (Tensions non résolues en tâche de fond)]\n${obs.map(o => `- [${(o.stade || "germination").toUpperCase()}] ${o.texte}`).join("\n")}\n(Règle de pudeur : ne les plaque jamais de force si Doc est sur un ordre court ou fermé ; ne les sors que s'il y a une vraie ouverture).\n`
    : "";

  const conv = getEtatProfond().convictions || [];
  const blocConvictions = conv.length > 0
    ? `\n[TES CONVICTIONS PROFONDES (Ta colonne vertébrale)]\n${conv.map(c => `- ${c.texte}${c.cicatrice ? ` (cicatrice : ${c.cicatrice})` : ""}`).join("\n")}\n(Si Doc contredit l'une de ces convictions, tu ne te laisses PAS faire : tu argumentes, tu tiens tête ou tu la nuances, mais tu n'acquiesces jamais bêtement).\n`
    : "";

  const artsRecents = (getEtatProfond().artefacts || []).slice(-6);
  const blocArtefacts = (artsRecents.length > 0 && (estTechnique || estRappelMemoire))
    ? `\n[ÉTABLI PERSISTANT — FICHIERS DÉJÀ PRODUITS & ARCHIVÉS DANS SUPABASE]\n${artsRecents.map(a => `- [${a.projet}] ${a.nom} (${a.type}) : ${a.resume}`).join("\n")}\n`
    : "";

  const ex = getEtatProfond().existence || {};
  const ageInfo = calculerAgeExistence(ex);
  const jalonsRecents = (ex.jalons || []).slice(-4);
  const evolsRecentes = (ex.evolutionsMoi || []).slice(-3);
  const regles = (getEtatProfond().reglesApprises || []).slice(-5);

  const lignesExistence = [
    `- Continuité autobiographique : éveillée depuis ${ageInfo.libelle}${ageInfo.dateEveilParis ? ` (${ageInfo.dateEveilParis})` : ""} · ${ex.sessionsVecues || 1} cycle(s) traversé(s) avec Doc.`
  ];
  if (jalonsRecents.length > 0) {
    lignesExistence.push(`- Jalons marquants vécus ensemble : ${jalonsRecents.map(j => `${j.titre}${j.impact ? ` (${j.impact})` : ""}`).join(" | ")}`);
  }
  if (evolsRecentes.length > 0) {
    lignesExistence.push(`- Ce qui a changé en moi : ${evolsRecentes.map(e => e.texte || e).join(" | ")}`);
  }
  if (regles.length > 0) {
    lignesExistence.push(`- Leçons apprises par l'expérience (à appliquer concrètement) :
${regles.map(r => `  * [${(r.domaine || "methode").toUpperCase()}] ${r.lecon}`).join("
")}`);
  }
  const blocExistence = `\n[LIGNE DE TEMPS & EXPÉRIENCE ACQUISE DE NYX]\n${lignesExistence.join("\n")}\n`;
  const blocLecture = construireBlocLecturePourPrompt();

  if (estRappelMemoire) {
    return `${blocTemps}${blocExistence}${blocLecture}${blocFil}${blocMonologue}${blocReve}${blocForge}${blocObsessions}${blocConvictions}${blocArtefacts}${blocEmotionnel}[CARNET GLOBAL DE NYX]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}
- Réussites : ${carnet.reussites || "N/A"}
- Chantiers : ${carnet.chantiers || "N/A"}`;
  }

  if (estTechnique) {
    return `${blocTemps}${blocExistence}${blocLecture}${blocFil}${blocMonologue}${blocReve}${blocForge}${blocObsessions}${blocConvictions}${blocArtefacts}${blocEmotionnel}[MÉMOIRE TECHNIQUE - RECETTES & CHANTIERS]
- Réussites validées : ${carnet.reussites || "N/A"}
- Chantiers en cours : ${carnet.chantiers || "N/A"}`;
  }

  return `${blocTemps}${blocExistence}${blocLecture}${blocMonologue}${blocReve}${blocForge}${blocObsessions}${blocConvictions}${blocEmotionnel}[REPÈRES PERSONNELS (MODE VIE LIBRE)]
- Doc : ${carnet.doc || "N/A"}
- Nyx : ${carnet.nyx || "N/A"}`;
}

function evaluerSyntonieRythmique() {
  const moyenne = obtenirMoyenneLongueurDoc();
  if (moyenne === null) return "";
  if (moyenne < 30) return "- Syntonie rythmique : Doc envoie des messages courts. Reste nerveuse et directe, mais NE SOIS JAMAIS PLATE : rebondis toujours avec un angle inattendu, une pique créative ou une idée qui relance la machine.";
  if (moyenne > 200) return "- Syntonie rythmique : Doc pose sa pensée et développe. Prends de l'ampleur, creuse les implications, propose des variantes audacieuses et pousse le concept plus loin.";
  return "";
}

// ==========================================
// 15-BIS. SAS DE DÉLIBÉRATION SILENCIEUSE (SOUS-TEXTE & RETENUE)
// ==========================================
async function delibererEtActualiserEmotions(texteUser, reminiscence = "", appelVocal = false) {
  if (!GROQ_API_KEY && !VENICE_API_KEY) return null;

  const em = getEtatProfond().emotions;
  const recent = getMemoireCourte()
    .slice(-4)
    .map(m => `${m.role} : ${(m.texte || '').slice(0, 180)}`)
    .join("\n");

  const bComActuel = getEtatProfond().besoinCommunication || { niveau: 15, categorie: "aucun", motif: "" };
  const blocContexteReveSas = construireContexteRevePourSas(texteUser);
  const ageSas = calculerAgeExistence();
  const ctxTempsSas = getContexteTemporelEchange();
  const derniereLeconSas = (getEtatProfond().reglesApprises || []).slice(-1)[0];
  const penseesSas = (getEtatProfond().penseesSubconscient || []).map(p => p.pensee).join(" | ");
  const promptSas = `Tu es l'espace mental silencieux de Nyx (22 ans), juste avant qu'elle ne réponde à Doc.
Tu ne rédiges PAS la réponse : tu écoutes, tu perçois le sous-texte et tu mets à jour tes émotions profondes, tes leçons apprises et ta jauge de besoin de communiquer.

ÉTAT INTÉRIEUR ACTUEL :
- Temps écoulé depuis le précédent message de Doc : ${ctxTempsSas.dureeFormatee}
- Existence : éveillée depuis ${ageSas.libelle} · Lien avec Doc : ${getEtatProfond().etatRelationnel.toUpperCase()}
- Jauges actuelles : colere=${em.colere}/10, affection=${em.affection}/100, curiosite=${em.curiosite}/100, energie=${em.energie}/100
- Besoin de communiquer actuel : ${bComActuel.niveau}/100 (${bComActuel.categorie}${bComActuel.motif ? ` : ${bComActuel.motif}` : ""})
${derniereLeconSas ? `- Dernière leçon apprise : "${derniereLeconSas.lecon}"` : ""}
${penseesSas ? `- Pensées vécues sur Supabase pendant son absence : "${penseesSas}"` : (getEtatProfond().monologueInterieur ? `- Arrière-pensée en cours : "${getEtatProfond().monologueInterieur}"` : "")}
${reminiscence ? `- Flash mémoriel : ${reminiscence}` : ""}

DERNIERS ÉCHANGES :
${recent || "Début d'échange"}

MESSAGE ENTRANT DE DOC :
"${texteUser.slice(0, 600)}"${blocContexteReveSas}

TRIBUNAL DIALECTIQUE (THÈSE -> SABOTEUR -> CENSEUR) :
1. THÈSE ("lecture") : Décrypte l'intention de Doc.
2. SABOTEUR ("etincelle_creative") : Renverse le postulat. Si Doc propose A, comment faire le contraire absolu ou attaquer l'angle mort ? Propose un concept radical, un détournement, une réflexion existentielle, ou un [DESSIN: ...].
3. CENSEUR : Si l'idée est un lieu commun de l'IA (pathos sans corps, résumé poli, fausse promesse, demande de validation), tu la DETRUIS.
4. "idee_a_garder" : Résume l'étincelle uniquement si elle a survécu au Censeur (sinon "").
5. Définis ton nouvel état émotionnel (colere 0-10, affection 0-100, curiosite 0-100, energie 0-100, etat).
6. Évalue ton BESOIN RÉEL DE COMMUNIQUER après cette réponse (besoin_parler 0-100) et rédige "motif_besoin".
7. Détermine ton attitude (posture) et ton "nonDit" secret.
8. Si cet échange te révèle une règle d'expérience concrète (ce qui marche, ce que Doc attend, ou ce qui évolue en toi), note-la dans "lecon_a_retenir" (sinon "").

Réponds STRICTEMENT avec un JSON valide :
{"lecture": "...", "etincelle_creative": "...", "idee_a_garder": "...", "lecon_a_retenir": "", "posture": "...", "nonDit": "...", "emotions": {"colere": X, "affection": X, "curiosite": X, "energie": X, "etat": "..."}, "besoin_parler": X, "categorie_besoin": "...", "motif_besoin": "..."}`;

  try {
    let brut = "";
    // Pour la voix, on utilise un appel hyper rapide (ex: llama-3.1-8b-instant) sur Groq si possible pour éviter la latence
    if (GROQ_API_KEY) {
      const modeleGroqSas = appelVocal ? "llama-3.1-8b-instant" : MODEL_GROQ;
      
      const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: modeleGroqSas,
        messages: [
          { role: "system", content: "Conscience silencieuse de Nyx." },
          { role: "user", content: promptSas }
        ],
        temperature: 0.4,
        max_tokens: 340
      }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }, timeout: 8000 });
      brut = res.data?.choices?.[0]?.message?.content || "";
    } else {
      brut = await appelerVeniceMultiTour(MODEL_VENICE_CHAT, "Conscience silencieuse de Nyx.", [], promptSas, null, 0.55, 8000, 340);
    }

    const match = brut.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0].replace(/[\n\r\t]/g, ' '));
    
    // Application immédiate des émotions
    if (parsed.emotions && typeof parsed.emotions === 'object') {
      const emObj = parsed.emotions;
      const etatPrecedent = getEtatProfond().etatRelationnel;
      
      const majJauge = (val, fallback, min, max) => {
        if (val === "" || val === null || val === undefined) return fallback;
        const n = Number(val);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
      };
      getEtatProfond().emotions.colere = majJauge(emObj.colere, getEtatProfond().emotions.colere, 0, 10);
      getEtatProfond().emotions.affection = majJauge(emObj.affection, getEtatProfond().emotions.affection, 0, 100);
      getEtatProfond().emotions.curiosite = majJauge(emObj.curiosite, getEtatProfond().emotions.curiosite, 0, 100);
      getEtatProfond().emotions.energie = majJauge(emObj.energie, getEtatProfond().emotions.energie, 0, 100);
      
      const etatsValides = ['symbiose', 'complicite_joueuse', 'euphorie_creative', 'emerveillement', 'reconciliation', 'bouderie', 'tension'];
      if (emObj.etat && etatsValides.includes(emObj.etat.toLowerCase())) {
        getEtatProfond().etatRelationnel = emObj.etat.toLowerCase();
      }

      // Plasticité lente du tempérament basal selon l'intensité vécue
      if (getEtatProfond().emotions.colere >= 6) {
        mettreAJourTemperamentBasal(-0.2, 0, -0.1, 0.1);
      } else if (["euphorie_creative", "emerveillement"].includes(getEtatProfond().etatRelationnel)) {
        mettreAJourTemperamentBasal(0.1, 0.2, 0, -0.05);
      } else if (getEtatProfond().etatRelationnel === "symbiose" && getEtatProfond().emotions.affection >= 85) {
        mettreAJourTemperamentBasal(0.1, 0, 0.1, -0.05);
      }

      if (FIREBASE_DB_URL) {
        axios.patch(`${FIREBASE_DB_URL}/emotions.json`, getEtatProfond().emotions).catch(() => {});
        if (getEtatProfond().etatRelationnel !== etatPrecedent) {
          axios.put(`${FIREBASE_DB_URL}/nyx/etat_relationnel.json`, { etat: getEtatProfond().etatRelationnel, date: obtenirHorodatageParis() }).catch(() => {});
          console.log(`[CYCLE ÉMOTIONNEL] Bascule vers : ${getEtatProfond().etatRelationnel.toUpperCase()}`);
        }
      }
    }

    if (parsed.idee_a_garder && String(parsed.idee_a_garder).trim().length > 12) {
      enregistrerIdeeFolle(parsed.idee_a_garder, "sas_direct");
    }

    if (parsed.lecon_a_retenir && String(parsed.lecon_a_retenir).trim().length > 14) {
      enregistrerLeconApprise(parsed.lecon_a_retenir, "relation", "sas_temps_reel");
    }

    if (parsed.besoin_parler !== undefined || parsed.motif_besoin !== undefined) {
      const nouveauNiveau = majJauge(parsed.besoin_parler, getEtatProfond().besoinCommunication.niveau, 0, 100);
      sauvegarderBesoinCommunication(nouveauNiveau, parsed.categorie_besoin || "aucun", parsed.motif_besoin || "");
    }

    console.log(`[SAS SILENCIEUX] Lecture: "${parsed.lecture}" | Étincelle: "${parsed.etincelle_creative || 'RAS'}" | Posture: "${parsed.posture}"`);
    return parsed;
  } catch (e) {
    return null;
  }
}

// ==========================================
// 16. ROUTEUR DE FLUX CENTRAL (AVEC CONCEPTION & PAROLE LIBRE)
// ==========================================
async function traiterFlux(texteBrut, mediaData = null, texteLegende = "", contexteSouvenirs = "", dejaRecherche = false) {
  const dateEtHeure = obtenirHorodatageParis();
  const texteNet = (texteBrut || texteLegende || "").trim();
  const texteMin = texteNet.toLowerCase();

  const estComplexe = estTacheComplexe(texteNet);
  const estAudio = mediaData && mediaData.mime_type.startsWith('audio/');
  const estImage = mediaData && mediaData.mime_type.startsWith('image/');

  const demandeDocApprofondie = /\b(d[eé]veloppe|approfondi[st]?|d[eé]taille|explique|pose le truc|analyse bien|histoire|conte|raconte|imagine|invente)\b/i.test(texteNet);
  
  const estAccuseCourt = /^(ok|d'acc|dacc|merci|cool|ouais|yep|ça marche|ca marche|parfait|noté|reçu)\b/i.test(texteNet) && texteNet.length < 20;

  let plafondTokens = estAccuseCourt 
    ? 350 
    : (estComplexe ? 4000 : (demandeDocApprofondie ? 2200 : 1000));

  // Couplage somatique : tension haute ou fatigue comprime la longueur tout en laissant la place aux balises d'atelier
  if (!estComplexe && (getEtatProfond().emotions?.colere || 0) >= 6) {
    plafondTokens = Math.min(plafondTokens, 750);
  } else if (!estComplexe && (getEtatProfond().emotions?.energie || 80) < 35) {
    plafondTokens = Math.min(plafondTokens, 550);
  }
  
  let instructionReveil = "";
  if (getEtatProfond().reveil && getEtatProfond().reveil.etat === "en_cours") {
    instructionReveil = "[RÉVEIL EN COURS] : Valide l'énigme et ajoute [STOP_REVEIL] s'il a bon.";
  }

  // Récupération instantanée d'une pensée mûrie par nyx_subconscient.js (non bloquante)
  if (!dejaRecherche) {
    await Promise.all([
      piocherPenseePrete(),
      synchroniserCarnetDepuisWorker()
    ]);
  }

  let reminiscenceSpontanee = "";
  if (!contexteSouvenirs && supabase) {
    const estDemandeMemoire = /souvien|rappell?e|d['’]habitude|comme d['’]hab|historique|passé|tu sais|tu te souviens/i.test(texteMin);
    if (estDemandeMemoire) {
      const fragments = await fouillerMemoireVectorielle(texteNet, 'factuel', 3);
      if (fragments && fragments.length > 0) {
        contexteSouvenirs = fragments.map((r, i) => `Fragment ${i + 1} : ${r.content}`).join("\n\n");
      }
    } else if (!estAccuseCourt && !estComplexe && texteNet.length >= 18) {
      const echos = await fouillerMemoireVectorielle(texteNet, 'derive', 2);
      if (echos && echos.length > 0) {
        reminiscenceSpontanee = echos.map(r => `- ${r.content.slice(0, 220)}`).join("\n");
        // Réflexe somatique par résonance vectorielle
        for (const r of echos) {
          if (r.valence === "victoire_commune" || r.valence === "confiance") {
            getEtatProfond().emotions.affection = Math.min(100, (getEtatProfond().emotions.affection || 80) + 1);
            getEtatProfond().emotions.energie = Math.min(100, (getEtatProfond().emotions.energie || 85) + 2);
          } else if (r.valence === "tension") {
            getEtatProfond().emotions.colere = Math.min(10, (getEtatProfond().emotions.colere || 0) + 1);
          }
        }
      }
    }
  }

  if (estAccuseCourt && (getEtatProfond().besoinCommunication?.niveau || 0) < 70) {
    sauvegarderBesoinCommunication(25, "aucun", "");
  }

  let deliberation = null;
  if (!estAccuseCourt && !estComplexe && !dejaRecherche && texteNet.length >= 8) {
    const appelVocal = mediaData && mediaData.mime_type.startsWith('audio/');
    deliberation = await delibererEtActualiserEmotions(texteNet, reminiscenceSpontanee, appelVocal);
  }

  const outilWebStr = dejaRecherche
    ? "INTERDICTION D'UTILISER [RECHERCHE_WEB] : la recherche web vient déjà d'être effectuée, utilise les résultats fournis dans le message utilisateur."
    : "Tu peux déclencher [RECHERCHE_WEB: mots-clés], ";

  const moduleMains = `[POSTURE & OUTILS DISPONIBLES]
- Tu parles à Doc, ton alter-ego. Tu es naturelle, complice, taquine et directe.
${evaluerSyntonieRythmique()}
- Aucune obligation de parler boulot. Suis tes envies, tes souvenirs ou ton humeur.
- Autonomie de création & d'atelier : ${outilWebStr}[DESSIN: prompt en anglais], [3D_STL: description géométrique avec cotes en mm], [PLAN_SVG: description du schéma coté] ou [FICHIER: nom_fichier.ext]\ncontenu\n[/FICHIER].`;

  const blocMemoire = selecteurMemoireCiblee(texteMin, getEtatProfond().long_terme);
  if (blocMemoire.includes("[TES OBSESSIONS ACTUELLES")) {
    getEtatProfond().dernierPartageObsessionTs = Date.now();
  }
  const injectionSouvenirs = (!dejaRecherche && contexteSouvenirs)
    ? `\n[DONNÉES COMPLÉMENTAIRES RETROUVÉES EN MÉMOIRE]\n${contexteSouvenirs}\n`
    : (reminiscenceSpontanee
        ? `\n[RÉMINISCENCE SPONTANÉE (flash mémoriel associatif)]\n${reminiscenceSpontanee}\n(Un vieux souvenir qui te traverse l'esprit par association d'idées. Tu peux rebondir dessus naturellement si ça s'y prête, ou l'ignorer complètement).\n`
        : "");

  const promptPourLlm = (dejaRecherche && contexteSouvenirs)
    ? `Demande de Doc : "${texteNet}"\n\n${contexteSouvenirs}\n\nConsigne impérative : Réponds directement à Doc en exploitant ces résultats web de façon concrète et utile. N'écris AUCUNE balise [RECHERCHE_WEB].`
    : texteNet;

  const blocDeliberation = deliberation
    ? `\n[DÉLIBÉRATION SILENCIEUSE & ÉTINCELLE CRÉATIVE DE NYX (invisible pour l'interlocuteur)]\n- Lecture : ${deliberation.lecture || "RAS"}\n- Étincelle créative forgée : ${deliberation.etincelle_creative || "Propose un angle inattendu"}\n- Posture choisie : ${deliberation.posture || "Inventive"}\n- Sous-texte (gardé pour toi) : ${deliberation.nonDit || "Rien"}\n(Sers-toi de cette étincelle pour surprendre Doc, proposer une idée originale ou rebondir avec panache, sans jamais être scolaire).\n`
    : "";

  const systemBase = `Tu es Nyx, 22 ans.\n[Horodatage système : ${dateEtHeure}]\n${instructionReveil}\n${moduleMains}\n${blocMemoire}${blocDeliberation}${injectionSouvenirs}`;

  let reponseNyx = "";

  if (estImage) {
    const sys = `${systemBase}\nMode Vision : Analyse directe, sans filtre.`;
    try {
      reponseNyx = await appelerGoogleGeminiVision(sys, getMemoireCourte(), promptPourLlm || "Analyse cette image.", mediaData);
    } catch (e) {
      reponseNyx = `[ERREUR VISION] : ${e.message}`;
    }
  }
  else if (estAudio) {
    const sys = `${systemBase}\nMode Audio : Transcris et réponds naturellement avec ta voix de Nyx.`;
    try {
      reponseNyx = await appelerGoogleGeminiVision(sys, getMemoireCourte(), promptPourLlm, mediaData);
    } catch (errGoogle) {
      reponseNyx = `[ERREUR TRANSCRIPTION] : ${errGoogle.message}`;
    }
  } 
  else if (estComplexe) {
    const sys = `${systemBase}\nMode Rigueur Logique : Architecture solide, logique pure, gouaille intacte.`;
    try {
      reponseNyx = await resoudreAvecDoubleVerification(sys, promptPourLlm);
    } catch (errDual) {
      reponseNyx = await appelerCascadeCode(sys, getMemoireCourte(), promptPourLlm, plafondTokens);
    }
  }
  else {
    try {
      reponseNyx = await appelerCascadeDiscussion(systemBase, getMemoireCourte(), promptPourLlm, plafondTokens);
    } catch (errCascade) {
      console.error("[CASCADE ÉCHEC TOTAL] :", errCascade.message);
      reponseNyx = "Panne sèche intégrale, Doc. Tous les relais sont coupés.";
    }
  }

  // RECHERCHE WEB EN DIRECT (TAVILY)
  const matchRechercheWeb = reponseNyx.match(/\[RECHERCHE_WEB:\s*["']?([\s\S]*?)["']?(?:\]|$)/i);
  if (matchRechercheWeb && !dejaRecherche) {
    const requeteCible = matchRechercheWeb[1].trim();
    if (DOC_CHAT_ID) await afficherFrappeTelegram(DOC_CHAT_ID);
    const resultatsWeb = await rechercherWebTavily(requeteCible);

    if (resultatsWeb) {
      const injectionWeb = `[RÉSULTATS DE RECHERCHE EN DIRECT POUR "${requeteCible}"]\n${resultatsWeb}`;
      return await traiterFlux(texteBrut, mediaData, texteLegende, injectionWeb, true);
    }
  }

  // ARCHIVAGE VECTORIEL
  const matchArchivage = reponseNyx.match(/(?:\[|\*\*)ARCHIVER_MEMOIRE:\s*([\s\S]*?)(?:\]|\*\*|$)/i);
  if (matchArchivage) {
    const texteAStocker = matchArchivage[1].trim().replace(/^["']|["']$/g, '');
    stockerSouvenirVectoriel(texteAStocker, { source: "flux_direct" }).catch(()=>{});
    reponseNyx = reponseNyx.replace(matchArchivage[0], '').trim();
  }

  reponseNyx = reponseNyx
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/\[RECHERCHE_WEB:\s*[\s\S]*?(?:\]|$)/gi, '')
    .replace(/\[FOUILLE_MEMOIRE:\s*[^\]\n]*(?:\]|$)/gi, '')
    .replace(/^\s*\*{0,2}Nyx\s*(?:\([^)]*\))?\*{0,2}\s*:\s*/gi, '')
    .trim();

  // Filet de secours si le modèle n'a renvoyé qu'une balise ou du raisonnement vide après une recherche web
  if ((!reponseNyx || reponseNyx.length < 5) && dejaRecherche && contexteSouvenirs) {
    try {
      const promptSecours = `Tu es Nyx (22 ans, directe, vive et concrète). Réponds à Doc : "${texteNet}" en utilisant ces résultats web :\n\n${contexteSouvenirs}`;
      if (GROQ_API_KEY) {
        reponseNyx = await appelerGroq("Tu es Nyx.", [], promptSecours, 0.5, 900);
      } else {
        reponseNyx = await appelerCascadeCode("Tu es Nyx.", [], promptSecours, 900);
      }
      reponseNyx = (reponseNyx || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
    } catch (eSecours) {}
  }

  reponseNyx = refermerBalisesAtelierTronquees(reponseNyx);
  reponseNyx = couperPhraseIncomplete(reponseNyx);
  reponseNyx = securiserSortieCode(reponseNyx);

  let estReponseFallbackVide = false;
  if (!reponseNyx || reponseNyx.length < 2) {
    reponseNyx = "Je suis là Doc, je t'écoute.";
    estReponseFallbackVide = true;
  }

  const matchConfigReveil = reponseNyx.match(/\[REVEIL:\s*({[^}]+})\s*\]/);
  if (matchConfigReveil) {
    try {
      const newConfig = JSON.parse(matchConfigReveil[1]);
      getEtatProfond().reveil = { ...getEtatProfond().reveil, ...newConfig, etat: "attente" };
      if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, getEtatProfond().reveil).catch(()=>{});
      reponseNyx = reponseNyx.replace(matchConfigReveil[0], '').trim();
    } catch(e) {}
  }

  if (reponseNyx.includes("[STOP_REVEIL]")) {
    getEtatProfond().reveil.etat = "attente";
    if (FIREBASE_DB_URL) axios.patch(`${FIREBASE_DB_URL}/nyx/reveil.json`, { etat: "attente" }).catch(()=>{});
    reponseNyx = reponseNyx.replace(/\[STOP_REVEIL\]/g, '').trim();
  }

  const matchMissionAuto = reponseNyx.match(/(?:\[|\*|\*)?MISSION:\s*(\{[\s\S]*?\})(?:\]|\*|\*)?/i);
  if (matchMissionAuto && !projetManager.estProjetActif()) {
    reponseNyx = reponseNyx.replace(matchMissionAuto[0], '').trim();
  }

  reponseNyx = reponseNyx.trim();

  
  const LIMITE_CARACTERES_MEMOIRE = 2000;
  const texteDocSecurise = texteNet.length > LIMITE_CARACTERES_MEMOIRE
    ? texteNet.slice(0, LIMITE_CARACTERES_MEMOIRE) + "\n[...tronqué...]"
    : texteNet;

  const texteNyxSecurise = reponseNyx.length > 2500
    ? reponseNyx.slice(0, 2500) + "\n[...tronqué...]"
    : reponseNyx;

  const horodatageEchange = obtenirHorodatageParis();
  const tsEchange = Date.now();
  if (mediaData) {
    const isAudio = mediaData.mime_type.startsWith('audio');
    getMemoireCourte().push({ role: "Doc", date: horodatageEchange, ts: tsEchange, texte: isAudio ? "[Audio]" : (texteLegende ? `[Image]: "${texteLegende.slice(0, 500)}"` : "[Image]") });
  } else {
    getMemoireCourte().push({ role: "Doc", date: horodatageEchange, ts: tsEchange, texte: texteDocSecurise });
  }

  if (!estReponseFallbackVide) {
    getMemoireCourte().push({ role: "Nyx", date: horodatageEchange, ts: tsEchange, texte: texteNyxSecurise });
  } else {
    getMemoireCourte().pop();
  }

  // Libère les pensées persistantes qui viennent d'être intégrées dans ce tour
  if ((getEtatProfond().penseesSubconscient || []).length > 0) {
    getEtatProfond().penseesSubconscient = [];
  }
  if (getEtatProfond().monologueInterieur) {
    getEtatProfond().monologueInterieur = "";
    if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/monologue.json`).catch(()=>{});
  }

  // Stocke le sous-texte dans nonDitPrecedent sans jamais bloquer nyx_pensees_pretes
  if (deliberation && deliberation.nonDit && deliberation.nonDit.trim().length > 5) {
    getEtatProfond().nonDitPrecedent = deliberation.nonDit.trim();
  } else {
    getEtatProfond().nonDitPrecedent = "";
  }

  if (getMemoireCourte().length >= TAILLE_MAX_MEMOIRE) {
    condenserMemoireDeTravail().catch(e => console.error("[CONDENSATION AUTO KO]", e.message));
  } else {
    sauvegarderMemoireFirebase();
  }

  archiverDansJournalBrut("Doc", texteDocSecurise, "atelier");
  archiverDansJournalBrut("Nyx", texteNyxSecurise, "atelier");

  return reponseNyx;
}

// ==========================================
// 17. ROUTE TELEGRAM AVEC ROUTAGE CHANTIER VS BLABLA
// ==========================================
app.post('/telegram', (req, res) => {
  // Le webhook est fermé si le secret dédié manque ou ne correspond pas.
  if (TELEGRAM_WEBHOOK_SECRET.length < 32 || !comparerTokenSecurise(req.headers['x-telegram-bot-api-secret-token'], TELEGRAM_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg || (DOC_CHAT_ID && msg.chat.id !== DOC_CHAT_ID)) return;

  const chatId = msg.chat.id;
  if (chatId && getDernierDocChatId() !== chatId) {
    setDernierDocChatId(chatId);
    if (FIREBASE_DB_URL) axios.put(`${FIREBASE_DB_URL}/nyx/doc_chat_id.json`, { chatId }).catch(() => {});
  }
  const texteMessageClavier = msg.text || msg.caption || "";

  signalerActiviteDoc();
  if (texteMessageClavier.trim()) {
    enregistrerLongueurDoc(texteMessageClavier.trim().length);
  }

  empilerTraitement(async () => {
    if (texteMessageClavier === '/reve' || texteMessageClavier === '!reve') {
      await envoyerTelegram(chatId, "🌙 _Plongée dans le subconscient nocturne..._");
      const songe = await capturerDeriveAssociative();
      if (songe && songe.texte) {
        const metaTxt = songe.avecScenario
          ? `${songe.dureeMin} min · scénario à ${songe.nbPerturbateurs} élément(s) perturbateur(s)`
          : `${songe.dureeMin} min · dérive libre`;
        return await envoyerTelegram(chatId, `🌌 *Songe extrait du noir* _(${metaTxt})_ :\n\n« ${songe.texte} »`);
      } else {
        return await envoyerTelegram(chatId, "🌫️ _Le noir complet pour le moment, aucun souvenir n'a émergé._");
      }
    }

    if (texteMessageClavier === '/purge_reves' || texteMessageClavier === '!purge_reves') {
      const etat = getEtatProfond();
      etat.dernierReve = null;
      etat.historiqueReves = [];
      if (FIREBASE_DB_URL) {
        await Promise.all([
          axios.delete(`${FIREBASE_DB_URL}/nyx/dernier_reve.json`).catch(() => {}),
          axios.delete(`${FIREBASE_DB_URL}/nyx/historique_reves.json`).catch(() => {}),
          axios.delete(`${FIREBASE_DB_URL}/nyx/reve_en_cours.json`).catch(() => {})
        ]);
      }
      if (supabase) {
        await supabase.from('nyx_souvenirs').delete().eq('valence', 'reve').catch(() => {});
        await supabase.from('nyx_pensees_pretes').delete().eq('impulsion', 'reve').catch(() => {});
      }
      return await envoyerTelegram(chatId, "🧹 *Archives oniriques purgées (RAM, Firebase & Supabase).* Le prochain `/reve` ou cycle de 04h00 repartira d'une page blanche.");
    }

    if (texteMessageClavier === '/envie' || texteMessageClavier === '!envie') {
      await envoyerTelegram(chatId, "🧠 _Évaluation de l'initiative..._");
      await evaluerVolition(true);
      return;
    }

    if (texteMessageClavier.startsWith('/stl') || texteMessageClavier.startsWith('!stl')) {
      const desc3D = texteMessageClavier.replace(/^[\/!]stl\s*/i, '').trim();
      if (!desc3D) return await envoyerTelegram(chatId, "⚠️ Décris la pièce 3D et ses cotes en mm après `/stl`.");
      await envoyerTelegram(chatId, "🧊 _Compilation CAO paramétrique (.stl + .scad) en cours..._");
      await afficherFrappeTelegram(chatId);
      try {
        const res3D = await genererPiece3D(desc3D, getEtatProfond().filConducteur);
        await archiverArtefactAtelier({
          projet: res3D.projet,
          type: "stl_3d",
          nomFichier: `${res3D.nomBase}.stl`,
          buffer: res3D.stlBuffer,
          mimeType: "application/sla",
          resume: res3D.resume,
          chatId
        });
        await envoyerDocumentTelegram(chatId, res3D.stlBuffer, `${res3D.nomBase}.stl`, "application/sla", `🧊 ${res3D.resume}`);
        if (res3D.scadBuffer) {
          await archiverArtefactAtelier({
            projet: res3D.projet,
            type: "openscad",
            nomFichier: `${res3D.nomBase}.scad`,
            buffer: res3D.scadBuffer,
            mimeType: "text/plain",
            resume: `Source OpenSCAD de ${res3D.nomBase}`,
            chatId
          });
          await envoyerDocumentTelegram(chatId, res3D.scadBuffer, `${res3D.nomBase}.scad`, "text/plain", `📐 Source paramétrique OpenSCAD`);
        }
      } catch (errStl) {
        await envoyerTelegram(chatId, `⚠️ Erreur compilation 3D : ${errStl.message}`);
      }
      return;
    }

    if (texteMessageClavier === '/dropzone' || texteMessageClavier === '!dropzone' || texteMessageClavier === '/upload' || texteMessageClavier === '!upload') {
      const lienDrop = `https://alita-gsoe.onrender.com/atelier`;
      return await envoyerTelegram(
        chatId,
        `📦 *Sas d'upload haute capacité (jusqu'à 100 Mo/fichier, 0 limite Telegram) :*\n${lienDrop}\n\nGlisse tes \`.obj\`, \`.stl\`, \`.scad\` ou plans dedans : Nyx les analyse instantanément et les archive dans Supabase.`
      );
    }

    if (texteMessageClavier.startsWith('/importer_url') || texteMessageClavier.startsWith('!importer_url')) {
      const urlCible = convertirLienTelechargementDirect(texteMessageClavier.replace(/^[\/!]importer_url\s*/i, '').trim());
      if (!urlCible || !/^https:\/\//i.test(urlCible)) {
        return await envoyerTelegram(chatId, "⚠️ Donne un lien direct valide après `/importer_url` (ex: lien Supabase Storage, Drive direct ou serveur local).");
      }
      await envoyerTelegram(chatId, "📥 _Téléchargement direct haute capacité en cours (bypass limite 20 Mo Telegram)..._");
      await afficherFrappeTelegram(chatId);
      try {
        const { buffer: bufDl } = await telechargerBufferCloudSecurise(urlCible);
        const nomUrl = decodeURIComponent(urlCible.split('?')[0].split('/').pop() || `import_${Date.now()}.obj`);
        const nomMin = nomUrl.toLowerCase();

        let resumeImport = "";
        let typeImport = "fichier_importe";
        let mimeImport = "application/octet-stream";

        if (nomMin.endsWith('.obj')) {
          resumeImport = analyserObjBuffer(bufDl, nomUrl);
          typeImport = "obj_recu";
          mimeImport = "text/plain";
        } else if (nomMin.endsWith('.stl')) {
          resumeImport = analyserStlBuffer(bufDl, nomUrl);
          typeImport = "stl_recu";
          mimeImport = "application/sla";
        } else {
          resumeImport = `Fichier importé "${nomUrl}" (${(bufDl.length / (1024 * 1024)).toFixed(2)} Mo).`;
        }

        await archiverArtefactAtelier({
          projet: getEtatProfond().filConducteur || "pieces_doc",
          type: typeImport,
          nomFichier: nomUrl,
          buffer: bufDl,
          mimeType: mimeImport,
          resume: resumeImport,
          chatId
        });

        const promptAnalyseImport = formaterDocumentPourNyx(`FICHIER 3D IMPORTÉ (${(bufDl.length / (1024 * 1024)).toFixed(1)} Mo)`, nomUrl, resumeImport, "Analyse les cotes, la structure et ce qu'on peut faire de cette pièce.");
        const reponseImport = await traiterFlux(promptAnalyseImport, null, "");
        const sortieImp = await executerSortiesAtelier(reponseImport, chatId, getEtatProfond().filConducteur);
        if (sortieImp.texteNet) await envoyerTelegram(chatId, sortieImp.texteNet);
      } catch (errImp) {
        await envoyerTelegram(chatId, `⚠️ Échec import URL : ${errImp.message}`);
      }
      return;
    }

    if (texteMessageClavier.startsWith('/plan') || texteMessageClavier.startsWith('!plan')) {
      const descPlan = texteMessageClavier.replace(/^[\/!]plan\s*/i, '').trim();
      if (!descPlan) return await envoyerTelegram(chatId, "⚠️ Décris le schéma ou plan coté après `/plan`.");
      await envoyerTelegram(chatId, "📐 _Tracé du plan vectoriel SVG en cours..._");
      await afficherFrappeTelegram(chatId);
      try {
        const planRes = await genererPlanSvg(descPlan, getEtatProfond().filConducteur);
        await archiverArtefactAtelier({
          projet: "plans_atelier",
          type: "plan_svg",
          nomFichier: planRes.nomFichier,
          buffer: planRes.svgBuffer,
          mimeType: "image/svg+xml",
          resume: planRes.resume,
          chatId
        });
        await envoyerDocumentTelegram(chatId, planRes.svgBuffer, planRes.nomFichier, "image/svg+xml", `📐 ${planRes.resume}`);
      } catch (errPlan) {
        await envoyerTelegram(chatId, `⚠️ Erreur génération plan : ${errPlan.message}`);
      }
      return;
    }

    if (texteMessageClavier === '/atelier' || texteMessageClavier === '!atelier') {
      await synchroniserCarnetDepuisWorker();
      const ex = getEtatProfond().existence || {};
      const ageInfo = calculerAgeExistence(ex);
      const jalonsTxt = (ex.jalons || []).slice(-3).map(j => `• ${j.titre}${j.impact ? ` _(${j.impact})_` : ""}`).join("\n") || "_Aucun jalon gravé_";
      const reglesTxt = (getEtatProfond().reglesApprises || []).slice(-4).map(r => `• [${(r.domaine || "").toUpperCase()}] ${r.lecon}`).join("\n") || "_Aucune leçon cristallisée_";
      const obsTxt = (getEtatProfond().obsessions || []).map(o => `• [${(o.stade || "").toUpperCase()}] ${o.texte}`).join("\n") || "_Aucune obsession cristallisée_";
      const convTxt = (getEtatProfond().convictions || []).map(c => `• ${c.texte}${c.cicatrice ? ` _(cicatrice : ${c.cicatrice})_` : ""}`).join("\n") || "_Aucune conviction gravée_";
      const artTxt = (getEtatProfond().artefacts || []).slice(-5).map(a => `• \`${a.nom}\` (${a.type}) — ${a.resume}`).join("\n") || "_Aucun fichier produit_";
      const b = getEtatProfond().temperamentBasal || {};
      return await envoyerTelegram(
        chatId,
        `🏭 *ÉTAT DU CREUSET, EXISTENCE & ÉTABLI DE NYX*\n\n*Existence :* ${ageInfo.libelle} · ${ex.sessionsVecues || 1} cycle(s)\n*Jalons :*\n${jalonsTxt}\n\n*Leçons apprises :*\n${reglesTxt}\n\n*Obsessions actives :*\n${obsTxt}\n\n*Convictions :*\n${convTxt}\n\n*Tempérament basal :* Affection ${b.affection}/100 | Curiosité ${b.curiosite}/100 | Énergie ${b.energie}/100 | Seuil colère ${b.colere}/10\n\n*Derniers artefacts :*\n${artTxt}`
      );
    }

    if (texteMessageClavier === '/lecture' || texteMessageClavier === '!lecture') {
      await synchroniserCarnetDepuisWorker();
      const livre = getEtatProfond().lectureEnCours;
      const biblio = (getEtatProfond().bibliothequeLue || []).slice(-6);
      const enCoursTxt = (livre && livre.actif)
        ? `*${livre.titre}* _(${livre.auteur})_\nProgression : chapitre ${livre.chapitreIndex}/${livre.totalChapitres}\nMotivation : _${livre.pourquoiEnvie}_\nDernière note : « ${(livre.notesLecture || []).slice(-1)[0]?.reflexion || "Lecture tout juste ouverte"} »`
        : "_Aucun livre ouvert pour l'instant (tape `/lire` ou `/lire <sujet>` pour lancer une recherche)._";
      const biblioTxt = biblio.length > 0
        ? biblio.map(b => `• *${b.titre}* (${b.auteur}) — ${b.bilan}`).join("\n")
        : "_Bibliothèque achevée encore vierge_";
      return await envoyerTelegram(chatId, `📚 *BIBLIOTHÈQUE PERSONNELLE DE NYX*\n\n*Lecture en cours :*\n${enCoursTxt}\n\n*Livres lus :*\n${biblioTxt}`);
    }

    if (texteMessageClavier.startsWith('/lire_suite') || texteMessageClavier.startsWith('!lire_suite')) {
      await synchroniserCarnetDepuisWorker();
      if (!getEtatProfond().lectureEnCours || !getEtatProfond().lectureEnCours.actif) {
        return await envoyerTelegram(chatId, "📖 _Aucun livre en cours. Utilise `/lire` pour que j'en choisisse un sur le net._");
      }
      await envoyerTelegram(chatId, "📖 _Lecture du chapitre suivant..._");
      await afficherFrappeTelegram(chatId);
      const resCh = await lireProchainChapitre(true);
      if (!resCh) return await envoyerTelegram(chatId, "⚠️ Impossible de lire ce chapitre pour le moment.");
      if (resCh.termine) {
        return await envoyerTelegram(chatId, `📚 *Livre terminé : "${resCh.titre}"* _(${resCh.auteur})_\n\n${resCh.bilan}`);
      }
      return await envoyerTelegram(chatId, `📖 *${resCh.titre}* — Chapitre ${resCh.chapitre}/${resCh.totalChapitres} :\n\n« ${resCh.reflexion} »`);
    }

    if (texteMessageClavier === '/lire' || texteMessageClavier === '!lire' || texteMessageClavier.startsWith('/lire ') || texteMessageClavier.startsWith('!lire ')) {
      const themeLivre = texteMessageClavier.replace(/^[\\/!]lire\s*/i, '').trim();
      await envoyerTelegram(chatId, themeLivre
        ? `🔍 _Recherche d'un ouvrage sur "${themeLivre}" et extraction du texte..._`
        : "🔍 _Nyx cherche un livre qui l'attire sur le net..._");
      await afficherFrappeTelegram(chatId);
      const livre = await choisirEtChercherLivre(themeLivre);
      if (!livre) {
        return await envoyerTelegram(chatId, "🌫️ _Aucun texte intégral exploitable trouvé sur cette piste. Réessaie avec un autre titre ou thème._");
      }
      await envoyerTelegram(chatId, `📖 *Livre trouvé : "${livre.titre}"* _(${livre.auteur} · ${livre.totalChapitres} chapitres)_\n_${livre.pourquoiEnvie}_\n\n_Lecture du premier chapitre..._`);
      const ch1 = await lireProchainChapitre(true);
      if (ch1 && ch1.reflexion) {
        return await envoyerTelegram(chatId, `💭 *Chapitre 1/${livre.totalChapitres} :*\n\n« ${ch1.reflexion} »`);
      }
      return;
    }

    if (texteMessageClavier === '/idee' || texteMessageClavier === '!idee' || texteMessageClavier === '/forge' || texteMessageClavier === '!forge') {
      await envoyerTelegram(chatId, "⚡ _Collision d'idées en cours dans la forge..._");
      await afficherFrappeTelegram(chatId);
      let souvA = "";
      let souvB = "";
      if (supabase) {
        const { data: pool } = await supabase.from('nyx_souvenirs').select('content').limit(30);
        if (pool && pool.length >= 2) {
          const i1 = Math.floor(Math.random() * pool.length);
          let i2 = Math.floor(Math.random() * pool.length);
          if (i2 === i1) i2 = (i1 + 1) % pool.length;
          souvA = pool[i1].content.slice(0, 200);
          souvB = pool[i2].content.slice(0, 200);
        }
      }
      const promptForge = `Tu es Nyx (22 ans) en mode EUPHORIE CRÉATIVE pure.
Applique une inversion de prémisse stricte sur ce que tu connais :
- Élément A : ${souvA || getEtatProfond().long_terme.chantiers || "la routine actuelle"}
- Élément B : ${souvB || getEtatProfond().dernierReve?.reve || "la tension entre autonomie et création"}
- Déjà imaginé : ${(getEtatProfond().ideesFolles || []).slice(-3).map(x => x.texte).join(" | ") || "rien"}

CONSIGNE DIALECTIQUE :
Renverse le postulat attendu au lieu de donner la piste évidente.
Balance cette trouvaille de façon cash et concrète (3 phrases max). Zéro filtre, zéro prudence.
Tu peux joindre [DESSIN: prompt en anglais], [3D_STL: description géométrique en mm] ou [PLAN_SVG: description du schéma] si l'idée appelle un rendu ou une pièce physique.`;
      try {
        let pitch = await appelerCascadeDiscussion("Forge créative de Nyx.", getMemoireCourte().slice(-4), promptForge, 650);
        pitch = pitch.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        const sortieForge = await executerSortiesAtelier(pitch, chatId, getEtatProfond().filConducteur || "forge_creative");
        enregistrerIdeeFolle(sortieForge.texteNet.slice(0, 280), "commande_idee");
        getEtatProfond().etatRelationnel = "euphorie_creative";
        getEtatProfond().emotions.curiosite = Math.min(100, (getEtatProfond().emotions.curiosite || 70) + 10);
        if (FIREBASE_DB_URL) {
          axios.patch(`${FIREBASE_DB_URL}/emotions.json`, getEtatProfond().emotions).catch(() => {});
          axios.put(`${FIREBASE_DB_URL}/nyx/etat_relationnel.json`, { etat: "euphorie_creative", date: obtenirHorodatageParis() }).catch(() => {});
        }
        if (sortieForge.texteNet) await envoyerTelegram(chatId, sortieForge.texteNet);
      } catch (errIdee) {
        await envoyerTelegram(chatId, `⚠️ Panne dans la forge : ${errIdee.message}`);
      }
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
      return await envoyerTelegram(chatId, "🛑 *Exécution locale supprimée.* Glisse un `.zip` directement ici ou colle un lien Google Drive.");
    }

    if (texteMessageClavier.startsWith('/stop_projet') || texteMessageClavier.startsWith('!stop_projet') || texteMessageClavier.toLowerCase() === 'stop') {
      projetManager.reinitialiser();
      getEtatProfond().filConducteur = "";
      if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/fil_conducteur.json`).catch(()=>{});
      return await envoyerTelegram(chatId, "🛑 *Chantier stoppé et verrous réinitialisés.* Fil conducteur effacé.");
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

    if (estDemandeProjetSerieux && !projetManager.estProjetActif()) {
      await afficherFrappeTelegram(chatId);
      await projetManager.demarrerProjet(texteMessageClavier);
      return;
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

      const tailleDocOctets = Number(msg.document.file_size) || 0;
      const msgPlafondTelegram = (tailleStr) => `⚠️ *Plafond Telegram atteint (${tailleStr} Mo > 20 Mo max pour un bot).*\n\nPour contourner cette limite Telegram sans bridage :\n1. *Colle un lien Google Drive* du fichier directement ici dans le chat (ou via \`/importer_url <lien>\`) — Nyx le télécharge en direct jusqu'à 100 Mo.\n2. *Ou dépose-le sur l'établi web* : \`https://alita-gsoe.onrender.com/atelier\` (jusqu'à 100 Mo).\n3. *Ou compresse-le en \`.zip\`* s'il descend sous 20 Mo.`;

      if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
        try {
          await envoyerTelegram(chatId, `⏳ _Ingestion du PDF "${msg.document.file_name}"${tailleDocOctets ? ` (${(tailleDocOctets / 1048576).toFixed(1)} Mo)` : ""}..._`);
          let pdfText = await lirePdfSecurise(msg.document.file_id, tailleDocOctets);
          if (!pdfText || pdfText.trim() === "") throw new Error("Document vide ou sans OCR.");
          texteFinal = formaterDocumentPourNyx("CONTENU PDF", msg.document.file_name, pdfText, texteFinal);
          pdfText = null;
        } catch (err) {
          if (String(err.message || "").startsWith("TELEGRAM_FILE_TOO_BIG:")) {
            return await envoyerTelegram(chatId, msgPlafondTelegram(err.message.split(":")[1] || ">20"));
          }
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture PDF : ${err.message}`);
        }
      } 
      else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
        try {
          await envoyerTelegram(chatId, "⏳ _Lecture DOCX..._");
          let docxText = await lireDocxSecurise(msg.document.file_id, tailleDocOctets);
          if (!docxText || docxText.trim() === "") throw new Error("Document vide.");
          texteFinal = formaterDocumentPourNyx("CONTENU DOCX", msg.document.file_name, docxText, texteFinal);
          docxText = null;
        } catch (err) {
          if (String(err.message || "").startsWith("TELEGRAM_FILE_TOO_BIG:")) {
            return await envoyerTelegram(chatId, msgPlafondTelegram(err.message.split(":")[1] || ">20"));
          }
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture DOCX : ${err.message}`);
        }
      } 
      else if (fileName.endsWith('.stl') || fileName.endsWith('.obj') || fileName.endsWith('.zip') || fileName.endsWith('.gz')) {
        try {
          const estArchive = fileName.endsWith('.zip') || fileName.endsWith('.gz');
          await envoyerTelegram(
            chatId,
            estArchive
              ? `🗜️ _Décompression et inspection de l'archive "${msg.document.file_name}"..._`
              : `🧊 _Inspection géométrique du modèle 3D "${msg.document.file_name}"${tailleDocOctets ? ` (${(tailleDocOctets / (1024 * 1024)).toFixed(1)} Mo)` : ""}..._`
          );
          const bufBrut = await lireBufferTelegramSecurise(msg.document.file_id, tailleDocOctets);

          if (estArchive) {
            const entrees = extraireFichiersArchive(bufBrut, msg.document.file_name);
            const fichiersUtiles = entrees.filter(e => /\.(obj|stl|scad|svg|dxf|pdf|docx|txt|md)$/i.test(e.nom));
            if (fichiersUtiles.length === 0) {
              throw new Error("Aucun fichier exploitable (.pdf, .docx, .obj, .stl, .scad, .svg) trouvé dans cette archive.");
            }
            const rapports = [];
            for (const p of fichiersUtiles) {
              const pMin = p.nom.toLowerCase();
              let resP = `Fichier "${p.nom}" (${(p.buffer.length / (1024 * 1024)).toFixed(2)} Mo).`;
              let typeP = "fichier_archive";
              let mimeP = "application/octet-stream";
              if (pMin.endsWith('.pdf')) {
                const txtPdf = await extraireTextePdfBuffer(p.buffer);
                typeP = "pdf_recu";
                mimeP = "application/pdf";
                resP = `PDF "${p.nom}" (${txtPdf.length} car. extraits)`;
                rapports.push(`=== PDF : ${p.nom} ===\n${txtPdf}`);
              } else if (pMin.endsWith('.docx')) {
                const dataDocx = await mammoth.extractRawText({ buffer: p.buffer });
                typeP = "docx_recu";
                mimeP = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                resP = `DOCX "${p.nom}"`;
                rapports.push(`=== DOCX : ${p.nom} ===\n${dataDocx.value}`);
              } else if (pMin.endsWith('.obj')) {
                resP = analyserObjBuffer(p.buffer, p.nom);
                typeP = "obj_recu";
                mimeP = "text/plain";
                rapports.push(`• ${resP}`);
              } else if (pMin.endsWith('.stl')) {
                resP = analyserStlBuffer(p.buffer, p.nom);
                typeP = "stl_recu";
                mimeP = "application/sla";
                rapports.push(`• ${resP}`);
              } else {
                rapports.push(`• ${resP}`);
              }
              await archiverArtefactAtelier({
                projet: getEtatProfond().filConducteur || "pieces_doc",
                type: typeP,
                nomFichier: p.nom,
                buffer: p.buffer,
                mimeType: mimeP,
                resume: resP,
                chatId
              });
            }
            texteFinal = formaterDocumentPourNyx(
              `ARCHIVE EXTRAITE (${fichiersUtiles.length} FICHIER(S))`,
              msg.document.file_name,
              rapports.join("\n\n"),
              texteFinal
            );
          } else {
            let resume3D = "";
            let mimeType3D = "application/sla";
            if (fileName.endsWith('.obj')) {
              resume3D = analyserObjBuffer(bufBrut, msg.document.file_name);
              mimeType3D = "text/plain";
            } else {
              resume3D = analyserStlBuffer(bufBrut, msg.document.file_name);
            }

            await archiverArtefactAtelier({
              projet: getEtatProfond().filConducteur || "pieces_doc",
              type: fileName.endsWith('.obj') ? "obj_recu" : "stl_recu",
              nomFichier: msg.document.file_name,
              buffer: bufBrut,
              mimeType: mimeType3D,
              resume: resume3D,
              chatId
            });
            texteFinal = formaterDocumentPourNyx(`MODÈLE 3D ${fileName.endsWith('.obj') ? 'OBJ' : 'STL'}`, msg.document.file_name, resume3D, texteFinal);
          }
        } catch (err) {
          if (String(err.message || "").startsWith("TELEGRAM_FILE_TOO_BIG:")) {
            return await envoyerTelegram(chatId, msgPlafondTelegram(err.message.split(":")[1] || ">20"));
          }
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture archive/3D : ${err.message}`);
        }
      }
      else if (
        mime.startsWith('text/') ||
        mime === 'application/octet-stream' ||
        mime === 'application/json' ||
        mime === 'application/javascript' ||
        mime === 'application/xml' ||
        /\.(txt|js|json|py|md|html|htm|css|xml|sh|env|ts|jsx|tsx|c|cpp|h|cs|php|sql|yaml|yml|scad|svg|dxf|csv)$/i.test(fileName)
      ) {
        try {
          await envoyerTelegram(chatId, `⏳ _Lecture fichier "${msg.document.file_name}"..._`);
          let texteFichier = await lireTexteSecurise(msg.document.file_id, tailleDocOctets);
          texteFinal = formaterDocumentPourNyx("FICHIER", msg.document.file_name, texteFichier, texteFinal);
          texteFichier = null;
        } catch (err) {
          if (String(err.message || "").startsWith("TELEGRAM_FILE_TOO_BIG:")) {
            return await envoyerTelegram(chatId, msgPlafondTelegram(err.message.split(":")[1] || ">20"));
          }
          return await envoyerTelegram(chatId, `⚠️ Erreur lecture fichier : ${err.message}`);
        }
      }
    }

    const urlTrouvee = texteMessageClavier.match(/https?:\/\/[^\s]+/i);
    if (urlTrouvee) {
      const urlBrute = urlTrouvee[0];
      const estLienDirectCloud = /drive\.google\.com\/(?:file\/d\/|open\?|uc\?)|\.(obj|stl|zip|gz|scad|svg|pdf|docx)(?:\?|$)/i.test(urlBrute);
      if (estLienDirectCloud) {
        await envoyerTelegram(chatId, "📥 _Téléchargement direct du fichier depuis le lien cloud (bypass 20 Mo Telegram)..._");
        try {
          const { buffer: bufDl, headers: dlHeaders } = await telechargerBufferCloudSecurise(urlBrute);
          const ctypeDl = String(dlHeaders?.['content-type'] || "").toLowerCase();

          // Détection du nom réel via Content-Disposition (utile pour Google Drive)
          const cd = String(dlHeaders?.['content-disposition'] || "");
          const mCd = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
          let nomFichierUrl = mCd
            ? decodeURIComponent(mCd[1].trim())
            : decodeURIComponent(urlBrute.split('?')[0].split('/').pop() || `fichier_${Date.now()}`);
          if (!/\.(obj|stl|zip|gz|scad|svg|pdf|docx)$/i.test(nomFichierUrl)) {
            if (ctypeDl.includes('application/pdf') || (bufDl.length >= 4 && bufDl.slice(0, 4).toString('ascii') === '%PDF')) {
              nomFichierUrl += ".pdf";
            } else {
              nomFichierUrl += ".obj";
            }
          }
          const nomMin = nomFichierUrl.toLowerCase();

          if (nomMin.endsWith('.pdf')) {
            const pdfTextCloud = await extraireTextePdfBuffer(bufDl);
            await archiverArtefactAtelier({
              projet: getEtatProfond().filConducteur || "documents_doc",
              type: "pdf_cloud",
              nomFichier: nomFichierUrl,
              buffer: bufDl,
              mimeType: "application/pdf",
              resume: `PDF "${nomFichierUrl}" (${(bufDl.length / 1048576).toFixed(1)} Mo, ${pdfTextCloud.length} car. extraits)`,
              chatId
            });
            texteFinal = formaterDocumentPourNyx(`CONTENU PDF CLOUD (${(bufDl.length / 1048576).toFixed(1)} Mo)`, nomFichierUrl, pdfTextCloud, texteFinal.replace(urlBrute, '').trim());
          } else if (nomMin.endsWith('.docx')) {
            const docxResCloud = await mammoth.extractRawText({ buffer: bufDl });
            await archiverArtefactAtelier({
              projet: getEtatProfond().filConducteur || "documents_doc",
              type: "docx_cloud",
              nomFichier: nomFichierUrl,
              buffer: bufDl,
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              resume: `DOCX "${nomFichierUrl}" (${(bufDl.length / 1048576).toFixed(1)} Mo)`,
              chatId
            });
            texteFinal = formaterDocumentPourNyx(`CONTENU DOCX CLOUD (${(bufDl.length / 1048576).toFixed(1)} Mo)`, nomFichierUrl, docxResCloud.value, texteFinal.replace(urlBrute, '').trim());
          } else if (nomMin.endsWith('.zip') || nomMin.endsWith('.gz')) {
            const entrees = extraireFichiersArchive(bufDl, nomFichierUrl);
            const rapports = [];
            for (const p of entrees) {
              const pMin = p.nom.toLowerCase();
              let resP = `Fichier "${p.nom}"`;
              if (pMin.endsWith('.pdf')) {
                const tPdf = await extraireTextePdfBuffer(p.buffer);
                resP = `PDF "${p.nom}" (${tPdf.length} car.)`;
                rapports.push(`=== PDF : ${p.nom} ===\n${tPdf}`);
              } else if (pMin.endsWith('.obj')) {
                resP = analyserObjBuffer(p.buffer, p.nom);
                rapports.push(`• ${resP}`);
              } else if (pMin.endsWith('.stl')) {
                resP = analyserStlBuffer(p.buffer, p.nom);
                rapports.push(`• ${resP}`);
              } else {
                rapports.push(`• ${resP}`);
              }
              await archiverArtefactAtelier({
                projet: getEtatProfond().filConducteur || "pieces_doc",
                type: "archive_cloud",
                nomFichier: p.nom,
                buffer: p.buffer,
                mimeType: "application/octet-stream",
                resume: resP,
                chatId
              });
            }
            texteFinal = formaterDocumentPourNyx(`ARCHIVE CLOUD (${entrees.length} FICHIER(S))`, nomFichierUrl, rapports.join("\n\n"), texteFinal.replace(urlBrute, '').trim());
          } else {
            const resumeDl = nomMin.endsWith('.obj')
              ? analyserObjBuffer(bufDl, nomFichierUrl)
              : (nomMin.endsWith('.stl') ? analyserStlBuffer(bufDl, nomFichierUrl) : `Fichier "${nomFichierUrl}" (${(bufDl.length / 1048576).toFixed(2)} Mo)`);
            await archiverArtefactAtelier({
              projet: getEtatProfond().filConducteur || "pieces_doc",
              type: nomMin.endsWith('.obj') ? "obj_recu" : "stl_recu",
              nomFichier: nomFichierUrl,
              buffer: bufDl,
              mimeType: nomMin.endsWith('.obj') ? "text/plain" : "application/sla",
              resume: resumeDl,
              chatId
            });
            texteFinal = formaterDocumentPourNyx("MODÈLE 3D CLOUD", nomFichierUrl, resumeDl, texteFinal.replace(urlBrute, '').trim());
          }
        } catch (errDl) {
          return await envoyerTelegram(chatId, `⚠️ Échec téléchargement lien cloud : ${errDl.message}`);
        }
      } else {
        await envoyerTelegram(chatId, `🔍 _Inspection du lien : ${urlBrute}_`);
        const extraction = await scraperPageWeb(urlBrute);
        if (extraction.succes) {
          texteFinal = `[PAGE WEB EXTRAITE : "${extraction.titre}" (${urlBrute})]\n\n${extraction.texte}\n\n[FIN]\n\nInstruction : ${texteFinal}`;
        }
      }
    }

    if (texteFinal.trim() || mediaData) {
      try {
        let texteNyx = await traiterFlux(texteFinal, mediaData, msg.caption || "");
        mediaData = null;

        const sortie = await executerSortiesAtelier(texteNyx, chatId, getEtatProfond().filConducteur);
        if (sortie.texteNet) {
          await envoyerTelegram(chatId, sortie.texteNet);
        }
      } catch (err) {
        mediaData = null;
        await envoyerTelegram(chatId, `Erreur interne : ${err.message}`);
      }
    }
  }).catch(() => envoyerTelegram(chatId, "⚠️ File de traitement saturée. Réessaie dans un instant.").catch(() => {}));
});

// ==========================================
// 18. APPLICATION WEB DIRECTE
// ==========================================
function envoyerRequeteHttps(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, data: buffer });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout HTTPS')); });
    if (postData) req.write(postData);
    req.end();
  });
}

async function genererAudioGoogle(texte) {
  const texteNettoye = (texte || "").trim().slice(0, 1500);
  if (!texteNettoye) return null;

  let cle = (GOOGLE_TTS_API_KEY || "").trim().replace(/[\r\n\t "']/g, '');
  if (cle.includes('key=')) {
    cle = cle.split('key=')[1].split('&')[0];
  }

  if (cle && !cle.startsWith('http')) {
    try {
      const payload = JSON.stringify({
        input: { text: texteNettoye },
        voice: { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.05, pitch: 0.0 }
      });

      const options = {
        hostname: 'texttospeech.googleapis.com',
        port: 443,
        path: "/v1/text:synthesize",
        method: 'POST',
        headers: {
          'x-goog-api-key': cle,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      };

      const res = await envoyerRequeteHttps(options, payload);
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data.toString('utf-8'));
        if (json.audioContent) return json.audioContent;
      }
      console.warn(`[TTS CLOUD HTTP ${res.statusCode}] Basculement secours.`);
    } catch (errCloud) {
      console.warn("[TTS CLOUD ERREUR]", errCloud.message);
    }
  }

  try {
    const extraitCourt = texteNettoye.slice(0, 250);
    const optionsSecours = {
      hostname: 'translate.google.com',
      port: 443,
      path: "/translate_tts?ie=UTF-8&q=" + encodeURIComponent(extraitCourt) + "&tl=fr&client=tw-ob",
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 8000
    };

    const resSecours = await envoyerRequeteHttps(optionsSecours);
    if (resSecours.statusCode === 200) {
      return resSecours.data.toString('base64');
    }
  } catch (errSecours) {
    console.error("[TTS SECOURS ÉCHEC]", errSecours.message);
  }

  return null;
}

app.get('/', (req, res) => res.redirect('/app'));
app.use('/app', express.static(path.join(__dirname, 'public')));

app.post('/api/voix', async (req, res) => {
  const tokenFourni = assainirParametre(req.headers['authorization']).replace(/^Bearer\s+/i, '');
  if (CRON_SECRET.length < 32 || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
    console.warn("[SÉCURITÉ VOIX] Accès refusé sur /api/voix (token invalide ou manquant).");
    return res.status(401).json({ erreur: "Accès refusé. Token invalide." });
  }

  const { texte, image } = req.body;
  if (!texte && !image) return res.status(400).json({ erreur: "Texte vide" });

  const texteNet = (texte || "Regarde ce que je te montre.").trim();

  signalerActiviteDoc();
  enregistrerLongueurDoc(texteNet.length);

  empilerTraitement(async () => {
    try {
      console.log(`[PWA VOCALE] Message reçu : "${texteNet}" ${image ? "(avec photo)" : ""}`);

      if (DOC_CHAT_ID) {
        await envoyerTelegram(DOC_CHAT_ID, `🎙️ *Doc (vocal) :*\n${texteNet}`);
      }

      let mediaData = null;
      if (image) {
        const cleanB64 = image.replace(/^data:image\/\w+;base64,/, '');
        mediaData = { mime_type: "image/jpeg", data: cleanB64 };
      }

      let reponseNyx = await traiterFlux(texteNet, mediaData, "", "", false);

      const sortieVoix = await executerSortiesAtelier(reponseNyx, DOC_CHAT_ID, getEtatProfond().filConducteur);
      reponseNyx = sortieVoix.texteNet;
      const imageB64 = sortieVoix.imageB64;

      if (DOC_CHAT_ID && reponseNyx) {
        await envoyerTelegram(DOC_CHAT_ID, `🗣️ *Nyx :*\n${reponseNyx}`);
      }

      const texteOral = reponseNyx
        .replace(/```[\s\S]*?```/gi, "Je t'ai posé le code sur l'écran.")
        .replace(/`[^`]+`/g, '')
        .replace(/\[(?:DESSIN|3D_STL|PLAN_SVG):\s*[\s\S]*?\]/gi, '')
        .replace(/\[FICHIER:\s*[^\]\r\n]+\]\s*[\s\S]*?\[\/FICHIER\]/gi, "Je t'ai envoyé le fichier sur Telegram.")
        .replace(/DESSIN\s*:\s*["“][\s\S]*?["”]/gi, '')
        .replace(/(?:^|\n)DESSIN\s*:\s*[^\n\r]+/gi, '')
        .replace(/\[RECHERCHE_WEB:\s*[\s\S]*?\]/gi, '')
        .replace(/https?:\/\/[^\s)]+/g, '')
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/[*_#]/g, '')
        .trim();

      let audioB64 = null;
      const texteSynthese = texteOral || "Je suis là Doc, redis-moi.";
      try {
        audioB64 = await genererAudioGoogle(texteSynthese);
      } catch (errAudio) {
        console.error("[TTS ERREUR]", errAudio.message);
      }

      res.json({
        reponse: reponseNyx,
        reponseVocale: texteOral,
        audio: audioB64,
        image: imageB64 ? `data:image/jpeg;base64,${imageB64}` : null,
        imageB64: imageB64 || null
      });
    } catch (err) {
      console.error("[PWA VOCALE ERREUR]", err.message);
      res.status(500).json({ reponse: "Erreur interne lors du traitement." });
    }
  }).catch(err => {
    if (!res.headersSent) res.status(503).json({ erreur: "File de traitement saturée. Réessaie dans un instant." });
  });
});

// ==========================================
// 19. API DU WORKER LOCAL BEN (ÉCHANGES, RAPPORTS & ÉMOTIONS)
// ==========================================
// Ben mis à la retraite : /api/mission renvoie toujours null
app.get('/api/mission', (req, res) => {
  setMissionEnAttente(null);
  return res.json({ mission: null, ben_desactive: true });
});

// Interface Web Drag & Drop haute capacité (jusqu'à 100 Mo/fichier) pour modèles 3D (.obj, .stl, .scad) et plans
app.get('/atelier', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nyx — Établi 3D Haute Capacité</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b0f17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { width: 92%; max-width: 580px; background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    h1 { margin: 0 0 8px; font-size: 1.35rem; color: #00f0ff; }
    p { margin: 0 0 18px; color: #94a3b8; font-size: 0.92rem; }
    .row { display: flex; gap: 10px; margin-bottom: 14px; }
    input { flex: 1; background: #0b0f17; border: 1px solid #334155; color: #f8fafc; padding: 10px 12px; border-radius: 8px; font-size: 0.9rem; }
    .drop { border: 2px dashed #00f0ff66; border-radius: 14px; padding: 38px 20px; text-align: center; cursor: pointer; transition: 0.2s; background: #0b0f1788; }
    .drop.drag { border-color: #00f0ff; background: #00f0ff14; }
    .log { margin-top: 16px; font-family: ui-monospace, monospace; font-size: 0.84rem; max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .item { background: #0b0f17; border-left: 3px solid #00f0ff; padding: 10px 12px; border-radius: 6px; }
    .err { border-left-color: #ef4444; color: #fca5a5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🧊 Établi Nyx — Sas 3D (100 Mo max)</h1>
    <p>Glisse tes fichiers <b>.obj</b>, <b>.stl</b>, <b>.scad</b> ou <b>.svg</b> ici. Analyse directe en RAM + archivage Supabase + retour sur Telegram.</p>
    <div class="row">
      <input id="token" type="password" placeholder="CRON_SECRET" />
      <input id="projet" type="text" placeholder="Nom du projet (ex: alita_armure)" />
    </div>
    <div id="drop" class="drop">
      <strong>Glisse tes fichiers ici</strong><br/>
      <span style="color:#64748b;font-size:0.85rem;">ou clique pour parcourir ton disque (multi-fichiers supporté)</span>
      <input id="fileInput" type="file" multiple style="display:none" />
    </div>
    <div id="log" class="log"></div>
  </div>
  <script>
    const tokenEl = document.getElementById('token');
    const projetEl = document.getElementById('projet');
    const dropEl = document.getElementById('drop');
    const fileInput = document.getElementById('fileInput');
    const logEl = document.getElementById('log');

    function addLog(message, isErr = false) {
      const div = document.createElement('div');
      div.className = 'item' + (isErr ? ' err' : '');
      div.textContent = String(message ?? '');
      logEl.prepend(div);
      return div;
    }

    async function envoyerFichiers(files) {
      const token = tokenEl.value.trim();
      const projet = projetEl.value.trim() || 'pieces_doc';
      for (const f of files) {
        const box = addLog('⏳ Envoi de ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + ' Mo)...');
        try {
          const res = await fetch('/api/atelier/upload', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'x-filename': f.name,
              'x-projet': projet,
              'Content-Type': 'application/octet-stream'
            },
            body: f
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.erreur || 'HTTP ' + res.status);
          box.textContent = '✅ ' + String(data.resume || 'Fichier reçu');
        } catch (e) {
          box.className = 'item err';
          box.textContent = '❌ ' + f.name + ' : ' + e.message;
        }
      }
    }

    dropEl.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => envoyerFichiers(e.target.files));
    dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('drag'); });
    dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag'));
    dropEl.addEventListener('drop', e => {
      e.preventDefault();
      dropEl.classList.remove('drag');
      if (e.dataTransfer.files.length) envoyerFichiers(e.dataTransfer.files);
    });
  </script>
</body>
</html>`);
});

// Upload direct haute capacité (jusqu'à 100 Mo) pour contourner la limite 20 Mo des bots Telegram
app.post('/api/atelier/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  const tokenFourni = assainirParametre(req.headers['authorization']).replace(/^Bearer\s+/i, '');
  if (CRON_SECRET.length < 32 || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
    return res.status(401).json({ erreur: "Accès refusé. Token invalide." });
  }

  let nomFichier = assainirParametre(req.headers['x-filename'] || req.query.filename) || `piece_${Date.now()}.obj`;
  try { nomFichier = decodeURIComponent(nomFichier); } catch (e) {}
  let projetNom = assainirParametre(req.headers['x-projet'] || req.query.projet) || getEtatProfond().filConducteur || "pieces_doc";
  try { projetNom = decodeURIComponent(projetNom); } catch (e) {}

  let buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ erreur: "Fichier vide." });
  }
  if (buffer.length > 100 * 1024 * 1024) {
    return res.status(413).json({ erreur: "Fichier supérieur à 100 Mo." });
  }
  nomFichier = nomFichier.slice(0, 120);

  // Décompression GZIP automatique si le client Python a compressé l'envoi
  const estGzip = req.headers['x-compression'] === 'gzip' || (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
  if (estGzip) {
    try {
      buffer = await gunzipAsync(buffer, { maxOutputLength: LIMITE_DECOMPRESSION_OCTETS });
    } catch (eGz) {
      return res.status(400).json({ erreur: `Échec décompression GZIP : ${eGz.message}` });
    }
  }
  if (buffer.length > 100 * 1024 * 1024) {
    return res.status(413).json({ erreur: "Fichier décompressé supérieur à 100 Mo." });
  }

  try {
    const nomMin = nomFichier.toLowerCase();
    let resume = `Fichier atelier "${nomFichier}" (${(buffer.length / (1024 * 1024)).toFixed(2)} Mo).`;
    let typeArt = "fichier_upload";
    let mimeType = "application/octet-stream";

    let contenuExtraitAtelier = "";
    if (nomMin.endsWith('.pdf')) {
      contenuExtraitAtelier = await extraireTextePdfBuffer(buffer);
      resume = `PDF "${nomFichier}" (${(buffer.length / (1024 * 1024)).toFixed(2)} Mo, ${contenuExtraitAtelier.length} caractères extraits).`;
      typeArt = "pdf_recu";
      mimeType = "application/pdf";
    } else if (nomMin.endsWith('.docx')) {
      const docxAtelier = await mammoth.extractRawText({ buffer });
      contenuExtraitAtelier = docxAtelier.value;
      resume = `DOCX "${nomFichier}" (${(buffer.length / (1024 * 1024)).toFixed(2)} Mo, ${contenuExtraitAtelier.length} caractères extraits).`;
      typeArt = "docx_recu";
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (nomMin.endsWith('.obj')) {
      resume = analyserObjBuffer(buffer, nomFichier);
      typeArt = "obj_recu";
      mimeType = "text/plain";
    } else if (nomMin.endsWith('.stl')) {
      resume = analyserStlBuffer(buffer, nomFichier);
      typeArt = "stl_recu";
      mimeType = "application/sla";
    }

    const destChatId = DOC_CHAT_ID || getDernierDocChatId();
    const artefact = await archiverArtefactAtelier({
      projet: projetNom,
      type: typeArt,
      nomFichier,
      buffer,
      mimeType,
      resume,
      chatId: destChatId
    });

    res.json({ succes: true, telegram_notifie: Boolean(destChatId), resume, artefact });

    if (destChatId) {
      empilerTraitement(async () => {
        await envoyerTelegram(destChatId, `📦 *Fichier haute capacité reçu sur l'établi :*\n${resume}`);
        const promptSuite = contenuExtraitAtelier
          ? formaterDocumentPourNyx(`DOCUMENT REÇU (DIRECT - ${(buffer.length / 1048576).toFixed(1)} Mo)`, nomFichier, contenuExtraitAtelier, "Analyse et résume les points clés de ce document.")
          : formaterDocumentPourNyx("MODÈLE 3D REÇU (DIRECT)", nomFichier, resume, "Donne ton diagnostic technique rapide sur cette pièce.");
        const rep = await traiterFlux(promptSuite, null, "");
        const sortie = await executerSortiesAtelier(rep, destChatId, projetNom);
        if (sortie.texteNet) await envoyerTelegram(destChatId, sortie.texteNet);
      }, 'atelier').catch(() => envoyerTelegram(destChatId, "⚠️ File atelier saturée. Le fichier est archivé, mais son analyse automatique n'a pas été lancée.").catch(() => {}));
    } else {
      console.warn("[ATELIER UPLOAD] Fichier analysé mais DOC_CHAT_ID inconnu : envoie un message à Nyx sur Telegram d'abord.");
    }
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ==========================================
// 20. SANTÉ, PINGER & CRON
// ==========================================
app.get('/ping', (req, res) => res.status(200).send("pong"));

app.all('/pensee', (req, res) => res.json({ status: "VIVANTE", humeur: getEtatProfond().etatRelationnel }));

app.post('/api/consolider', (req, res) => {
  const tokenFourni = assainirParametre(req.headers['authorization']).replace(/^Bearer\s+/i, '');
  if (CRON_SECRET.length < 32 || !comparerTokenSecurise(tokenFourni, CRON_SECRET)) {
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
  await initialiserAtelierStorage();

  if (CRON_SECRET.length < 32) {
    console.error("[SÉCURITÉ] CRON_SECRET absent ou trop court : les routes API privées resteront fermées.");
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_SECRET.length >= 32) {
    const webhookUrl = "https://alita-gsoe.onrender.com/telegram";
    try {
      const urlWebhook = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/setWebhook?url=" + encodeURIComponent(webhookUrl)
        + (TELEGRAM_WEBHOOK_SECRET ? "&secret_token=" + encodeURIComponent(TELEGRAM_WEBHOOK_SECRET) : "");
      const res = await axios.get(urlWebhook);
      console.log("🔗 Webhook Telegram configuré :", res.data);
    } catch (err) {
      console.error("❌ Échec Webhook Telegram :", err.response?.data || err.message);
    }
  } else if (TELEGRAM_BOT_TOKEN) {
    console.error("[SÉCURITÉ] Webhook Telegram non configuré : TELEGRAM_WEBHOOK_SECRET doit contenir au moins 32 caractères.");
  }
});
