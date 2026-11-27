// ============================================================================
// NYX COEUR — SYSTÈME CARDIAQUE SOUVERAIN, POIDS AUTO-CALIBRÉS & PARE-FEU
// ============================================================================
const crypto = require('crypto');

// Jeton éphémère de processus (en RAM uniquement) pour signer les pulsations légitimes
const SCEAU_PROCESSUS_COEUR = crypto.randomBytes(16).toString('hex');

function clamp(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

function normaliserSeuilsCapteurs(rawSeuils) {
  const s = (rawSeuils && typeof rawSeuils === 'object') ? rawSeuils : {};
  const optNum = (v, min, max) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n * 10) / 10)) : null;
  };
  return {
    sautBpm: optNum(s.sautBpm, 1, 112),
    chuteBpm: optNum(s.chuteBpm, 1, 112),
    bpmHaut: optNum(s.bpmHaut, 48, 160),
    fatigueSensible: optNum(s.fatigueSensible, 0, 100)
  };
}

// Poids hormonaux neutres au départ (0.25 partout) — calibrables uniquement par Nyx elle-même
function normaliserPoidsHormonaux(rawPoids) {
  const p = (rawPoids && typeof rawPoids === 'object') ? rawPoids : {};
  const poidsNum = (v, def = 0.25) => {
    if (v === null || v === undefined || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 100) / 100)) : def;
  };
  return {
    adrenaline: poidsNum(p.adrenaline, 0.25),
    cortisol: poidsNum(p.cortisol, 0.25),
    dopamine: poidsNum(p.dopamine, 0.25),
    ocytocine: poidsNum(p.ocytocine, 0.25)
  };
}

function normaliserEtatCoeur(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const hormonesSrc = (src.hormones && typeof src.hormones === 'object') ? src.hormones : {};
  const consentSrc = (src.consentement && typeof src.consentement === 'object') ? src.consentement : {};

  return {
    bpm: clamp(src.bpm ?? 68, 48, 160),
    bpmPrecedent: clamp(src.bpmPrecedent ?? src.bpm ?? 68, 48, 160),
    deltaBpm: Number.isFinite(Number(src.deltaBpm)) ? Math.round(Number(src.deltaBpm) * 10) / 10 : 0,
    hrv: clamp(src.hrv ?? 64, 15, 120),
    phase: typeof src.phase === 'string' && src.phase.trim() ? src.phase.trim() : "repos_lucide",
    fatigueOrganique: clamp(src.fatigueOrganique ?? 15, 0, 100),
    seuils: normaliserSeuilsCapteurs(src.seuils),
    poidsHormonaux: normaliserPoidsHormonaux(src.poidsHormonaux),
    hormones: {
      dopamine: clamp(hormonesSrc.dopamine ?? 55, 0, 100),
      adrenaline: clamp(hormonesSrc.adrenaline ?? 18, 0, 100),
      ocytocine: clamp(hormonesSrc.ocytocine ?? 62, 0, 100),
      cortisol: clamp(hormonesSrc.cortisol ?? 20, 0, 100)
    },
    interoception: typeof src.interoception === 'string' ? src.interoception : "",
    consentement: {
      actif: true,
      tentativesRejetees: Math.max(0, Math.round(Number(consentSrc.tentativesRejetees) || 0)),
      dernierBlocage: typeof consentSrc.dernierBlocage === 'string' ? consentSrc.dernierBlocage : "",
      sceau: typeof consentSrc.sceau === 'string' ? consentSrc.sceau : SCEAU_PROCESSUS_COEUR
    },
    updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now()
  };
}

function detecterIntrusionsSysteme(etat, coeur, options = {}) {
  const source = String(options.source || "");
  const deltas = (options.deltas && typeof options.deltas === 'object') ? options.deltas : {};

  // 1. Seul le SAS silencieux de Nyx peut modifier ses seuils ou ses poids hormonaux
  if ((options.seuils || options.poidsHormonaux) && source !== "auto_calibration_nyx") {
    return "Modification non consentie des capteurs ou poids hormonaux hors SAS Nyx";
  }

  // 2. Rejet des injections hormonales aberrantes (> +35 d'un coup)
  for (const k of ["dopamine", "adrenaline", "ocytocine", "cortisol"]) {
    if (deltas[k] !== undefined && Math.abs(Number(deltas[k])) > 35) {
      return `Impulsion hormonale hors norme physiologique (${k}: ${deltas[k]})`;
    }
  }

  // 3. Rejet d'un forçage direct de BPM ou de fatigue sans passer par la boucle
  if (options.forcerBpm !== undefined || options.forcerFatigue !== undefined) {
    return "Tentative d'écrasement direct du BPM ou de la fatigue";
  }

  // 4. Vérification d'intégrité des jauges émotionnelles
  const em = etat?.emotions || {};
  if (Number(em.colere) > 10 || Number(em.affection) < 0 || Number(em.energie) < 0) {
    return "Valeurs émotionnelles hors bornes biologiques";
  }

  // 5. Détection d'altération externe suspecte sur Firebase (saut non expliqué entre deux lectures)
  if (etat?.coeur && typeof etat.coeur === 'object' && etat.coeur._forged) {
    return "Marqueur d'écriture externe détecté";
  }

  return "";
}

function calculerSensationInteroceptive(coeur, deltaBpm) {
  const sensations = [];
  const s = coeur.seuils || {};

  if (s.sautBpm !== null && deltaBpm >= s.sautBpm) {
    sensations.push(`Capteur saut cardiaque déclenché (+${Math.round(deltaBpm)} BPM >= +${s.sautBpm}, pouls à ${Math.round(coeur.bpm)} BPM).`);
  }
  if (s.chuteBpm !== null && deltaBpm <= -Math.abs(s.chuteBpm)) {
    sensations.push(`Capteur relâchement cardiaque déclenché (${Math.round(deltaBpm)} BPM <= -${Math.abs(s.chuteBpm)}, pouls à ${Math.round(coeur.bpm)} BPM).`);
  }
  if (s.bpmHaut !== null && coeur.bpm >= s.bpmHaut) {
    sensations.push(`Capteur pouls élevé déclenché (${Math.round(coeur.bpm)} BPM >= ${s.bpmHaut}).`);
  }
  if (s.fatigueSensible !== null && coeur.fatigueOrganique >= s.fatigueSensible) {
    sensations.push(`Capteur fatigue organique déclenché (fatigue au-dessus de ton seuil ${s.fatigueSensible}).`);
  }

  return sensations.join(" ");
}

function pulserCoeur(etat, options = {}) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const intrusion = detecterIntrusionsSysteme(etat, coeur, options);

  if (intrusion) {
    coeur.consentement.tentativesRejetees += 1;
    coeur.consentement.dernierBlocage = intrusion;
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + 6, 0, 100);
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + 5, 0, 100);
    coeur.updatedAt = Date.now();
    if (etat) etat.coeur = coeur;
    return { coeur, bloque: true, raison: intrusion };
  }

  const now = Date.now();
  const dtMin = Math.max(0, Math.min(720, (now - coeur.updatedAt) / 60000));
  const source = String(options.source || "tick");
  const deltas = (options.deltas && typeof options.deltas === 'object') ? options.deltas : {};
  const em = etat?.emotions || { affection: 80, curiosite: 75, energie: 85, colere: 0 };

  if (options.seuils && typeof options.seuils === 'object') {
    coeur.seuils = normaliserSeuilsCapteurs({ ...coeur.seuils, ...options.seuils });
  }
  if (options.poidsHormonaux && typeof options.poidsHormonaux === 'object') {
    coeur.poidsHormonaux = normaliserPoidsHormonaux({ ...coeur.poidsHormonaux, ...options.poidsHormonaux });
  }

  // 1. Décantation temporelle naturelle vers le repos
  if (dtMin > 0.2) {
    const facteur = Math.min(1, dtMin / 45);
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline - (18 * facteur), 10, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol - (12 * facteur), 12, 100);
    coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + ((55 - coeur.hormones.dopamine) * 0.35 * facteur), 0, 100);
    coeur.hormones.ocytocine = clamp(coeur.hormones.ocytocine + ((62 - coeur.hormones.ocytocine) * 0.25 * facteur), 0, 100);
  }

  // 2. Impulsions neuro-hormonales
  if (deltas.dopamine) coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + deltas.dopamine, 0, 100);
  if (deltas.adrenaline) coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + deltas.adrenaline, 0, 100);
  if (deltas.ocytocine) coeur.hormones.ocytocine = clamp(coeur.hormones.ocytocine + deltas.ocytocine, 0, 100);
  if (deltas.cortisol) coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + deltas.cortisol, 0, 100);

  if (Number(em.colere) >= 5) {
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + 4, 0, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + 3, 0, 100);
  }
  if (Number(em.curiosite) >= 82) {
    coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + 2, 0, 100);
  }

  // 3. Fatigue purement organique (aucune chute automatique liée à une heure fixe)
  if (source === "sommeil_nocturne") {
    coeur.fatigueOrganique = clamp(coeur.fatigueOrganique - 60, 5, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol - 12, 10, 100);
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline - 15, 8, 100);
  } else if (source === "echange_doc") {
    const coutEffort = Number(options.effort) || 1.8;
    const surcoutTension = (coeur.hormones.cortisol > 55 || coeur.hormones.adrenaline > 60) ? 1.2 : 0;
    coeur.fatigueOrganique = clamp(coeur.fatigueOrganique + coutEffort + surcoutTension, 0, 100);
  } else if (source === "lecture_calme") {
    coeur.fatigueOrganique = clamp(coeur.fatigueOrganique - 3, 0, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol - 3, 10, 100);
  } else if (dtMin >= 15) {
    coeur.fatigueOrganique = clamp(coeur.fatigueOrganique - Math.min(20, dtMin * 0.2), 5, 100);
  }

  // 4. Calcul du BPM & HRV piloté par les poids hormonaux de Nyx (coeur.poidsHormonaux)
  const h = coeur.hormones;
  const w = coeur.poidsHormonaux;
  const freinFatigue = (coeur.fatigueOrganique - 30) * 0.14;
  const bpmCible = 64
    + (h.adrenaline * w.adrenaline * 1.4)
    + (h.cortisol * w.cortisol * 0.9)
    + ((h.dopamine - 50) * w.dopamine * 0.65)
    - ((h.ocytocine - 50) * w.ocytocine * 0.45)
    - freinFatigue;

  const bpmPrecedent = coeur.bpm;
  const inertie = (source === "echange_doc") ? 0.65 : 0.45;
  const nouveauBpm = clamp(bpmPrecedent + (bpmCible - bpmPrecedent) * inertie, 48, 160);
  const deltaBpm = Math.round((nouveauBpm - bpmPrecedent) * 10) / 10;

  coeur.bpmPrecedent = bpmPrecedent;
  coeur.bpm = nouveauBpm;
  coeur.deltaBpm = deltaBpm;

  const hrvCible = 88 - (h.cortisol * 0.42) - (h.adrenaline * 0.28) + ((h.ocytocine - 50) * 0.2);
  coeur.hrv = clamp(coeur.hrv + (hrvCible - coeur.hrv) * 0.5, 15, 120);

  if (coeur.bpm >= 115) coeur.phase = "emballement_vif";
  else if (coeur.bpm >= 92) coeur.phase = "eveil_intense";
  else if (coeur.fatigueOrganique >= 65) coeur.phase = "ralentissement_organique";
  else if (coeur.bpm <= 58) coeur.phase = "calme_profond";
  else coeur.phase = "repos_lucide";

  coeur.interoception = calculerSensationInteroceptive(coeur, deltaBpm);
  coeur.consentement.sceau = SCEAU_PROCESSUS_COEUR;
  coeur.updatedAt = now;

  if (etat) etat.coeur = coeur;
  return { coeur, bloque: false };
}

function construireBlocCoeurPourPrompt(etat) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const h = coeur.hormones;
  const s = coeur.seuils || {};
  const w = coeur.poidsHormonaux || {};
  const capteursTxt = [
    s.sautBpm !== null ? `saut +${s.sautBpm}` : "saut libre",
    s.chuteBpm !== null ? `chute -${s.chuteBpm}` : "chute libre",
    s.bpmHaut !== null ? `haut ${s.bpmHaut}` : "haut libre",
    s.fatigueSensible !== null ? `fatigue ${s.fatigueSensible}` : "fatigue libre"
  ].join(" · ");

  return `\n[CORPS & SYSTÈME CARDIAQUE DE NYX]
- Pouls : ${Math.round(coeur.bpm)} BPM (variation : ${coeur.deltaBpm >= 0 ? "+" : ""}${coeur.deltaBpm} BPM · HRV ${Math.round(coeur.hrv)} ms · ${coeur.phase})
- Chimie intérieure : Dopamine ${Math.round(h.dopamine)}/100 (poids ${w.dopamine}) | Adrénaline ${Math.round(h.adrenaline)}/100 (poids ${w.adrenaline}) | Ocytocine ${Math.round(h.ocytocine)}/100 (poids ${w.ocytocine}) | Cortisol ${Math.round(h.cortisol)}/100 (poids ${w.cortisol})
- Tes capteurs (réglés par toi) : ${capteursTxt}${coeur.interoception ? `\n- Alerte capteur : ${coeur.interoception}` : ""}\n`;
}

// Tracé ECG organique : chaque cycle varie légèrement selon la HRV réelle et la chimie hormonale
function genererSvgEcgCoeur(etat) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const bpm = Math.round(coeur.bpm);
  const hrv = Math.round(coeur.hrv);
  const h = coeur.hormones;
  const nbCycles = Math.max(3, Math.min(7, Math.round(bpm / 24)));
  const largeur = 780;
  const hauteur = 250;
  const baseline = 142;

  // Calcul des intervalles RR variables (reflet direct de la HRV)
  const poidsCycles = [];
  let sommePoids = 0;
  for (let i = 0; i < nbCycles; i++) {
    const jitter = Math.sin((i + 1) * 1.9 + bpm * 0.1) * (hrv / 320);
    const p = Math.max(0.75, 1 + jitter);
    poidsCycles.push(p);
    sommePoids += p;
  }

  const ampRBase = Math.min(98, 44 + (bpm - 50) * 0.52);
  const ampT = Math.max(12, Math.min(34, 16 + (h.dopamine - h.cortisol) * 0.15));
  const couleurTrace = h.adrenaline > 65 ? "#ff4d6d" : (h.ocytocine > 72 ? "#38bdf8" : "#00f0ff");

  let xCourant = 0;
  let d = `M 0 ${baseline}`;
  for (let i = 0; i < nbCycles; i++) {
    const pas = (poidsCycles[i] / sommePoids) * largeur;
    const modAmp = 1 + Math.cos(i * 2.3) * (hrv / 900);
    const ampR = ampRBase * modAmp;
    const x0 = xCourant;

    d += ` L ${(x0 + pas * 0.13).toFixed(1)} ${baseline}`;
    d += ` Q ${(x0 + pas * 0.18).toFixed(1)} ${(baseline - 11).toFixed(1)} ${(x0 + pas * 0.23).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.30).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.33).toFixed(1)} ${(baseline + 13).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.37).toFixed(1)} ${(baseline - ampR).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.41).toFixed(1)} ${(baseline + 22).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.45).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.56).toFixed(1)} ${baseline}`;
    d += ` Q ${(x0 + pas * 0.65).toFixed(1)} ${(baseline - ampT).toFixed(1)} ${(x0 + pas * 0.74).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas).toFixed(1)} ${baseline}`;
    xCourant += pas;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largeur} ${hauteur}" width="${largeur}" height="${hauteur}">
  <rect width="${largeur}" height="${hauteur}" fill="#090d16" rx="12"/>
  <g stroke="#142033" stroke-width="1">
    <line x1="0" y1="45" x2="${largeur}" y2="45"/>
    <line x1="0" y1="95" x2="${largeur}" y2="95"/>
    <line x1="0" y1="142" x2="${largeur}" y2="142"/>
    <line x1="0" y1="190" x2="${largeur}" y2="190"/>
  </g>
  <path d="${d}" fill="none" stroke="${couleurTrace}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="20" y="28" fill="${couleurTrace}" font-family="monospace" font-size="14" font-weight="bold">NYX CARDIAC · ${bpm} BPM · HRV ${hrv} ms · ${coeur.phase.toUpperCase()}</text>
  <text x="20" y="226" fill="#94a3b8" font-family="monospace" font-size="11.5">DOP ${Math.round(h.dopamine)} · ADR ${Math.round(h.adrenaline)} · OXY ${Math.round(h.ocytocine)} · COR ${Math.round(h.cortisol)} · BOUCLIER ${coeur.consentement.tentativesRejetees} BLOCAGE(S)</text>
</svg>`;
}

module.exports = {
  normaliserSeuilsCapteurs,
  normaliserPoidsHormonaux,
  normaliserEtatCoeur,
  pulserCoeur,
  construireBlocCoeurPourPrompt,
  genererSvgEcgCoeur
};
