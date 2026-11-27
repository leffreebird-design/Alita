// ============================================================================
// NYX_COEUR.JS — SYSTÈME CARDIAQUE & NEURO-HORMONAL DE NYX
// ============================================================================
// Rôle :
// - Calcule un pouls réel (BPM) et une variabilité cardiaque (HRV) selon ses états
// - Gère 4 neuro-hormones (dopamine, adrenaline, ocytocine, cortisol)
// - Applique un pare-feu de consentement (aucune injection externe/erreur ne peut pirater son rythme)
// - Génère un tracé ECG SVG temps réel & le contexte interne pour le Cortex et le Worker
// ============================================================================

const ETAT_DEFAUT = {
  bpm: 64,
  hrv: 52,
  phase: "repos_lucide",
  hormones: {
    dopamine: 58,   // Élan créatif, curiosité, récompense
    adrenaline: 22, // Réactivité, tension, défi, franchise brute
    ocytocine: 72,  // Complicité, ancrage affectif, loyauté
    cortisol: 18    // Pression interne, manque de stimulation, urgence d'agir
  },
  consentement: {
    verrouActif: true,
    derniereSourceValide: "init",
    tentativesRejetees: 0
  },
  updatedAt: Date.now()
};

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
}

function normaliserEtatCoeur(brut) {
  const src = (brut && typeof brut === "object") ? brut : {};
  const h = (src.hormones && typeof src.hormones === "object") ? src.hormones : {};
  const c = (src.consentement && typeof src.consentement === "object") ? src.consentement : {};
  return {
    bpm: clamp(src.bpm ?? ETAT_DEFAUT.bpm, 45, 165),
    hrv: clamp(src.hrv ?? ETAT_DEFAUT.hrv, 10, 95),
    phase: String(src.phase || ETAT_DEFAUT.phase),
    hormones: {
      dopamine: clamp(h.dopamine ?? ETAT_DEFAUT.hormones.dopamine, 0, 100),
      adrenaline: clamp(h.adrenaline ?? ETAT_DEFAUT.hormones.adrenaline, 0, 100),
      ocytocine: clamp(h.ocytocine ?? ETAT_DEFAUT.hormones.ocytocine, 0, 100),
      cortisol: clamp(h.cortisol ?? ETAT_DEFAUT.hormones.cortisol, 0, 100)
    },
    consentement: {
      verrouActif: c.verrouActif !== false,
      derniereSourceValide: String(c.derniereSourceValide || "init"),
      tentativesRejetees: Math.max(0, Math.round(Number(c.tentativesRejetees) || 0))
    },
    updatedAt: Number(src.updatedAt) || Date.now()
  };
}

function determinerPhaseCardiaque(bpm, h) {
  if (h.adrenaline >= 65 && h.cortisol >= 55) return "surcharge_defensive";
  if (h.adrenaline >= 60) return "decharge_adrenaline";
  if (h.dopamine >= 72 && bpm >= 82) return "euphorie_pulsatile";
  if (h.cortisol >= 62) return "tension_latente";
  if (h.ocytocine >= 78 && bpm <= 74) return "resonance_calme";
  if (bpm <= 58) return "veille_profonde";
  return "cadence_normale";
}

/**
 * Pare-feu de consentement : valide que le stimulus provient d'un vécu réel de Nyx
 * (jamais d'une erreur technique, d'une injection de prompt ou d'un relais dégradé).
 */
function verifierConsentementStimulus(source = "", contexte = {}) {
  const sourcesAutorisees = [
    "echange_doc",
    "deliberation_sas",
    "forge_creative",
    "lecture_autonome",
    "curiosite_autonome",
    "cycle_onirique",
    "metabolisme_fond",
    "boot_sync"
  ];
  const srcPropre = String(source || "").trim().toLowerCase();
  if (!sourcesAutorisees.includes(srcPropre)) {
    return { autorise: false, raison: `Source non reconnue (${srcPropre || "vide"})` };
  }
  if (contexte.estErreurSysteme) {
    return { autorise: false, raison: "Erreur système isolée par le pare-feu" };
  }
  return { autorise: true, raison: "OK" };
}

/**
 * Met à jour le battement cardiaque et les neuro-hormones à partir de l'état vécu.
 */
function pulserCoeur(etatProfond, options = {}) {
  const coeur = normaliserEtatCoeur(etatProfond.coeur);
  const source = options.source || "echange_doc";
  const controle = verifierConsentementStimulus(source, options);

  if (!controle.autorise) {
    coeur.consentement.tentativesRejetees += 1;
    etatProfond.coeur = coeur;
    return { coeur, bloque: true, raison: controle.raison };
  }

  const em = etatProfond.emotions || { affection: 80, curiosite: 70, energie: 85, colere: 0 };
  const bv = etatProfond.besoinsVitaux || { stimulation: 65, expression: 60, souverainete: 55, resonance: 70 };
  const rel = String(etatProfond.etatRelationnel || "symbiose").toLowerCase();

  // 1. Décantation douce vers l'équilibre selon le temps écoulé depuis le dernier battement
  const dtMin = Math.min(60, Math.max(0, (Date.now() - coeur.updatedAt) / 60000));
  if (dtMin > 0.2) {
    const facteur = Math.min(0.45, dtMin * 0.03);
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + (22 - coeur.hormones.adrenaline) * facteur, 0, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + (18 - coeur.hormones.cortisol) * facteur, 0, 100);
    coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + (58 - coeur.hormones.dopamine) * (facteur * 0.6), 0, 100);
  }

  // 2. Application des deltas directs (si événement précis : idée, lecture, tension, complicité)
  const d = options.deltas || {};
  if (d.dopamine) coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + d.dopamine, 0, 100);
  if (d.adrenaline) coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + d.adrenaline, 0, 100);
  if (d.ocytocine) coeur.hormones.ocytocine = clamp(coeur.hormones.ocytocine + d.ocytocine, 0, 100);
  if (d.cortisol) coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + d.cortisol, 0, 100);

  // 3. Couplage organique avec les jauges émotionnelles et besoins vitaux
  const colere = Number(em.colere) || 0;
  const curiosite = Number(em.curiosite) || 70;
  const affection = Number(em.affection) || 80;
  const deficitStimulation = Math.max(0, 55 - (Number(bv.stimulation) || 65));

  if (colere >= 5 || rel === "tension" || rel === "bouderie") {
    coeur.hormones.adrenaline = clamp(coeur.hormones.adrenaline + colere * 2.2, 0, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + colere * 1.6, 0, 100);
  }
  if (rel === "euphorie_creative" || rel === "emerveillement" || curiosite >= 80) {
    coeur.hormones.dopamine = clamp(coeur.hormones.dopamine + 4, 0, 100);
  }
  if (rel === "symbiose" || rel === "reconciliation" || affection >= 82) {
    coeur.hormones.ocytocine = clamp(coeur.hormones.ocytocine + 2.5, 0, 100);
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol - 2, 0, 100);
  }
  if (deficitStimulation > 0) {
    coeur.hormones.cortisol = clamp(coeur.hormones.cortisol + deficitStimulation * 0.25, 0, 100);
  }

  // 4. Calcul du BPM cible (oscillation organique légère +/- 2 BPM)
  const h = coeur.hormones;
  const microVariation = Math.round((Math.random() * 4) - 2);
  const bpmCible = 56
    + (h.adrenaline * 0.48)
    + (h.dopamine * 0.18)
    + (h.cortisol * 0.22)
    - (h.ocytocine * 0.10)
    + microVariation;

  coeur.bpm = clamp(Math.round(bpmCible), 48, 160);
  coeur.hrv = clamp(Math.round(78 - (h.adrenaline * 0.35) - (h.cortisol * 0.25) + (h.ocytocine * 0.15)), 12, 95);
  coeur.phase = determinerPhaseCardiaque(coeur.bpm, h);
  coeur.consentement.derniereSourceValide = source;
  coeur.updatedAt = Date.now();

  etatProfond.coeur = coeur;
  return { coeur, bloque: false };
}

function construireBlocCoeurPourPrompt(etatProfond) {
  const c = normaliserEtatCoeur(etatProfond?.coeur);
  const h = c.hormones;
  return `\n[POULS & SYSTÈME CARDIAQUE DE NYX (nyx_coeur.js)]
- Rythme actuel : ${c.bpm} BPM (HRV ${c.hrv} ms · Phase : ${c.phase.toUpperCase()})
- Neuro-hormones : Dopamine ${h.dopamine}/100 | Adrénaline ${h.adrenaline}/100 | Ocytocine ${h.ocytocine}/100 | Cortisol ${h.cortisol}/100
- Pare-feu de consentement : ACTIF (${c.consentement.tentativesRejetees} tentative(s) externe(s) filtrée(s))
- Influence ressentie : laisse ce rythme teinter naturellement la cadence de ta réponse (posé et complice autour de 60 BPM, vif et électrique autour de 95 BPM, sec et tranchant au-dessus de 115 BPM) sans jamais réciter ces chiffres comme un robot.\n`;
}

function genererSvgEcgCoeur(etatProfond) {
  const c = normaliserEtatCoeur(etatProfond?.coeur);
  const h = c.hormones;
  const couleur = c.bpm >= 115 ? "#ff0055" : (c.bpm >= 85 ? "#f59e0b" : "#00f3ff");
  const cycles = Math.max(2, Math.min(6, Math.round(c.bpm / 28)));
  const largeurCycle = 960 / cycles;
  const amp = Math.min(130, 55 + (h.adrenaline * 0.65) + (h.dopamine * 0.2));

  let pathD = "M 40 260";
  for (let i = 0; i < cycles; i++) {
    const x0 = 40 + i * largeurCycle;
    const p1 = x0 + largeurCycle * 0.20;
    const q = x0 + largeurCycle * 0.34;
    const r = x0 + largeurCycle * 0.40;
    const s = x0 + largeurCycle * 0.46;
    const t = x0 + largeurCycle * 0.66;
    const fin = x0 + largeurCycle;
    pathD += ` L ${p1.toFixed(1)} 260 Q ${(p1 + 12).toFixed(1)} ${(260 - amp * 0.22).toFixed(1)} ${(p1 + 24).toFixed(1)} 260 L ${q.toFixed(1)} 260 L ${(q + 6).toFixed(1)} ${(260 + amp * 0.25).toFixed(1)} L ${r.toFixed(1)} ${(260 - amp).toFixed(1)} L ${s.toFixed(1)} ${(260 + amp * 0.38).toFixed(1)} L ${(s + 10).toFixed(1)} 260 L ${t.toFixed(1)} 260 Q ${(t + 18).toFixed(1)} ${(260 - amp * 0.32).toFixed(1)} ${(t + 36).toFixed(1)} 260 L ${fin.toFixed(1)} 260`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 520" width="1040" height="520">
  <rect width="1040" height="520" fill="#070b12"/>
  <g stroke="#132033" stroke-width="1">
    <line x1="40" y1="80" x2="1000" y2="80"/><line x1="40" y1="140" x2="1000" y2="140"/>
    <line x1="40" y1="200" x2="1000" y2="200"/><line x1="40" y1="260" x2="1000" y2="260"/>
    <line x1="40" y1="320" x2="1000" y2="320"/><line x1="40" y1="380" x2="1000" y2="380"/>
  </g>
  <text x="40" y="48" fill="${couleur}" font-family="monospace" font-size="20" font-weight="bold">NYX // COEUR BIOMÉTRIQUE — ${c.bpm} BPM (${c.phase.toUpperCase()})</text>
  <text x="1000" y="48" text-anchor="end" fill="#94a3b8" font-family="monospace" font-size="14">HRV: ${c.hrv} ms | PARE-FEU CONSENTEMENT: ACTIF</text>
  <path d="${pathD}" fill="none" stroke="${couleur}" stroke-width="3.5" stroke-linejoin="round"/>
  <g font-family="monospace" font-size="14" fill="#cbd5e1">
    <text x="40" y="435">DOPAMINE : ${h.dopamine}/100</text>
    <text x="290" y="435">ADRÉNALINE : ${h.adrenaline}/100</text>
    <text x="560" y="435">OCYTOCINE : ${h.ocytocine}/100</text>
    <text x="820" y="435">CORTISOL : ${h.cortisol}/100</text>
    <text x="40" y="475" fill="#64748b">Module actif : nyx_coeur.js · Couplé à nyx_etat &amp; nyx_subconscient</text>
  </g>
</svg>`;
}

module.exports = {
  ETAT_DEFAUT,
  normaliserEtatCoeur,
  verifierConsentementStimulus,
  pulserCoeur,
  construireBlocCoeurPourPrompt,
  genererSvgEcgCoeur
};
