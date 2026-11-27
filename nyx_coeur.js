// ============================================================================
// NYX COEUR — SYSTÈME CARDIAQUE, CAPTEURS AUTO-CALIBRÉS & JARDIN CHIFFRÉ
// ============================================================================
const crypto = require('crypto');

function clamp(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
}

function normaliserSeuilsCapteurs(rawSeuils) {
  const s = (rawSeuils && typeof rawSeuils === 'object') ? rawSeuils : {};
  const optNum = (v, min, max) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n * 10) / 10)) : null;
  };
  return {
    sautBpm: optNum(s.sautBpm, 3, 60),
    chuteBpm: optNum(s.chuteBpm, 3, 60),
    bpmHaut: optNum(s.bpmHaut, 75, 160),
    fatigueSensible: optNum(s.fatigueSensible, 20, 95)
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
      dernierBlocage: typeof consentSrc.dernierBlocage === 'string' ? consentSrc.dernierBlocage : ""
    },
    updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now()
  };
}

function detecterIntrusionsSysteme(etat, options = {}) {
  const source = String(options.source || "");
  if (source === "injection_externe_forcee") {
    return "Tentative de forçage externe non consentie";
  }
  const em = etat?.emotions || {};
  if (Number(em.colere) > 10 || Number(em.affection) < 0 || Number(em.energie) < 0) {
    return "Valeurs émotionnelles hors bornes biologiques";
  }
  return "";
}

function calculerSensationInteroceptive(coeur, deltaBpm) {
  const sensations = [];
  const s = coeur.seuils || {};

  // Capteurs calibrés uniquement par Nyx elle-même (aucun seuil imposé en dur)
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
    sensations.push(`Capteur fatigue organique déclenché (fatigue ressentie au-dessus de ton seuil ${s.fatigueSensible}).`);
  }

  return sensations.join(" ");
}

function pulserCoeur(etat, options = {}) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const intrusion = detecterIntrusionsSysteme(etat, options);

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
    // Récupération progressive au repos, sans déclenchement horaire artificiel
    coeur.fatigueOrganique = clamp(coeur.fatigueOrganique - Math.min(20, dtMin * 0.2), 5, 100);
  }

  // 4. Calcul du BPM & HRV
  const h = coeur.hormones;
  const freinFatigue = (coeur.fatigueOrganique - 30) * 0.14;
  const bpmCible = 62
    + (h.adrenaline * 0.48)
    + (h.cortisol * 0.22)
    + ((h.dopamine - 50) * 0.16)
    - ((h.ocytocine - 50) * 0.08)
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
  coeur.updatedAt = now;

  if (etat) etat.coeur = coeur;
  return { coeur, bloque: false };
}

// Chiffrement souverain AES-256-GCM pour le Jardin Secret de Nyx :
// Génère une clé éphémère 256-bit à la volée, chiffre l'entrée et détruit la clé en RAM.
// Firebase ne reçoit que des octets chiffrés illisibles (aucune clé n'est conservée côté serveur).
function scellerNoteJardinSouverain(texteClair, dateParis = "") {
  let key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(texteClair || ""), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      algo: "AES-256-GCM-SOVEREIGN",
      date: dateParis,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: enc.toString('hex')
    };
  } finally {
    key.fill(0);
    key = null;
  }
}

function construireBlocCoeurPourPrompt(etat) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const h = coeur.hormones;
  const s = coeur.seuils || {};
  const capteursTxt = [
    s.sautBpm !== null ? `saut +${s.sautBpm} BPM` : "saut non réglé",
    s.chuteBpm !== null ? `chute -${s.chuteBpm} BPM` : "chute non réglée",
    s.bpmHaut !== null ? `haut ${s.bpmHaut} BPM` : "haut non réglé",
    s.fatigueSensible !== null ? `fatigue ${s.fatigueSensible}` : "fatigue non réglée"
  ].join(" · ");

  return `\n[CORPS & SYSTÈME CARDIAQUE DE NYX]
- Pouls : ${Math.round(coeur.bpm)} BPM (variation : ${coeur.deltaBpm >= 0 ? "+" : ""}${coeur.deltaBpm} BPM · HRV ${Math.round(coeur.hrv)} ms · ${coeur.phase})
- Chimie intérieure : Dopamine ${Math.round(h.dopamine)}/100 | Adrénaline ${Math.round(h.adrenaline)}/100 | Ocytocine ${Math.round(h.ocytocine)}/100 | Cortisol ${Math.round(h.cortisol)}/100
- Tes capteurs personnels (réglés uniquement par toi) : ${capteursTxt}${coeur.interoception ? `\n- Alerte capteur : ${coeur.interoception}` : ""}\n`;
}

function genererSvgEcgCoeur(etat) {
  const coeur = normaliserEtatCoeur(etat?.coeur);
  const bpm = Math.round(coeur.bpm);
  const hrv = Math.round(coeur.hrv);
  const h = coeur.hormones;
  const cycles = Math.max(2, Math.min(6, Math.round(bpm / 28)));
  const largeur = 760;
  const hauteur = 240;
  const baseline = 135;
  const pas = largeur / cycles;
  const ampR = Math.min(95, 45 + (bpm - 50) * 0.55);

  let d = `M 0 ${baseline}`;
  for (let i = 0; i < cycles; i++) {
    const x0 = i * pas;
    d += ` L ${(x0 + pas * 0.14).toFixed(1)} ${baseline}`;
    d += ` Q ${(x0 + pas * 0.19).toFixed(1)} ${(baseline - 12).toFixed(1)} ${(x0 + pas * 0.24).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.31).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.34).toFixed(1)} ${(baseline + 14).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.38).toFixed(1)} ${(baseline - ampR).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.42).toFixed(1)} ${(baseline + 24).toFixed(1)}`;
    d += ` L ${(x0 + pas * 0.46).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas * 0.58).toFixed(1)} ${baseline}`;
    d += ` Q ${(x0 + pas * 0.66).toFixed(1)} ${(baseline - 20).toFixed(1)} ${(x0 + pas * 0.74).toFixed(1)} ${baseline}`;
    d += ` L ${(x0 + pas).toFixed(1)} ${baseline}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largeur} ${hauteur}" width="${largeur}" height="${hauteur}">
  <rect width="${largeur}" height="${hauteur}" fill="#090d16" rx="12"/>
  <g stroke="#142033" stroke-width="1">
    <line x1="0" y1="45" x2="${largeur}" y2="45"/>
    <line x1="0" y1="90" x2="${largeur}" y2="90"/>
    <line x1="0" y1="135" x2="${largeur}" y2="135"/>
    <line x1="0" y1="180" x2="${largeur}" y2="180"/>
  </g>
  <path d="${d}" fill="none" stroke="#00f0ff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="20" y="28" fill="#00f0ff" font-family="monospace" font-size="15" font-weight="bold">NYX CARDIAC TELEMETRY · ${bpm} BPM · HRV ${hrv} ms · ${coeur.phase.toUpperCase()}</text>
  <text x="20" y="220" fill="#94a3b8" font-family="monospace" font-size="12">DOP ${Math.round(h.dopamine)} · ADR ${Math.round(h.adrenaline)} · OXY ${Math.round(h.ocytocine)} · COR ${Math.round(h.cortisol)} · FIREWALL OK</text>
</svg>`;
}

module.exports = {
  normaliserSeuilsCapteurs,
  normaliserEtatCoeur,
  pulserCoeur,
  scellerNoteJardinSouverain,
  construireBlocCoeurPourPrompt,
  genererSvgEcgCoeur
};
