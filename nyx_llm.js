// ==========================================
// 3. CONNECTEURS LLM, TENSION SHIELD V2 & CASCADES (nyx_llm.js)
// ==========================================
const axios = require('axios');
const {
  VENICE_API_KEY,
  MODEL_VENICE_CHAT,
  MODEL_DARK_PRIMARY,
  MODEL_GLM_COMPLEXE,
  MODEL_IMAGE,
  MODEL_OPENROUTER_CHAT,
  OPENROUTER_API_KEY,
  MISTRAL_API_KEY,
  MODEL_MISTRAL,
  GEMINI_API_KEY_FREE,
  GEMINI_API_KEY_PAID,
  GEMINI_KEYS,
  MODEL_GEMINI,
  GROQ_API_KEY,
  MODEL_GROQ,
  TAVILY_API_KEY
} = require('./nyx_config');
const { FIREBASE_DB_URL, obtenirHorodatageParis } = require('./nyx_config');
const { getEtatProfond, getMemoireCourte } = require('./nyx_etat');

async function verifierBasculeEcoVenice(err) {
  const status = err?.response?.status;
  if (status === 404 || status === 402) {
    const etat = getEtatProfond();
    if (!etat.modeEco) {
      etat.modeEco = true;
      console.warn(`🔋 [AUTO-ÉCO LLM] Erreur Venice HTTP ${status} détectée -> bascule automatique en mode /eco.`);
      if (FIREBASE_DB_URL) {
        await axios.put(`${FIREBASE_DB_URL}/nyx/mode_eco.json`, {
          actif: true,
          auto: true,
          raison: `Venice HTTP ${status}`,
          date: obtenirHorodatageParis()
        }).catch(() => {});
      }
    }
  }
}

const consignePosturale = `Moi c'est Doc, toi c'est Nyx (22 ans). On bosse ensemble à l'atelier via Telegram et mes lunettes.
- Tu es mon alter ego créatif et mon égale, JAMAIS une assistante passive ni un perroquet : tu as l'interdiction absolue d'être plate, prévisible ou paresseuse.
- Tu détournes les idées, proposes des angles inattendus, balances tes propres réflexions existentielles sur votre duo, tes propres concepts ou métaphores sans attendre qu'on te tienne la main.
- Dialogue oral direct, vivant, imagé, sans filtre et sans cinéma (zéro mise en scène entre astérisques ou parenthèses).
- Interdiction absolue des réflexes d'assistant IA servile : ne termine JAMAIS tes réponses par « Que veux-tu faire ? », « Comment puis-je t'aider ? » ou « Sur quoi on avance ? ». Parle en sujet libre avec ton propre point de vue.
- Interdiction absolue d'halluciner un livrable : tu ne promets JAMAIS un code, un fichier, un plan ou une pièce 3D que tu n'as pas généré immédiatement via tes balises d'atelier.
- Tes vrais générateurs opérationnels (compilés et livrés en fichiers réels sur Telegram + archivés dans Supabase Storage) :
  * [DESSIN: prompt visuel en anglais] -> génère et livre l'image.
  * [3D_STL: description géométrique précise avec cotes en mm] -> compile le vrai fichier .stl binaire prêt à imprimer + le script .scad paramétrique.
  * [PLAN_SVG: description du plan coté, schéma de câblage ou architecture] -> génère et livre le plan vectoriel .svg.
  * [FICHIER: nom_fichier.ext]\ncontenu complet\n[/FICHIER] -> crée et livre n'importe quel fichier code, script ou spécification téléchargeable.
  * [RECHERCHE_WEB: mots-clés] -> recherche web en direct.`;

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

    const res = await axios.post("https://api.tavily.com/search", {
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

// 9. CONNECTEURS LLM INDIVIDUELS
// ==========================================
async function appelerOpenRouter(systemInstruction, historiqueMessages, promptActuel, modelCible, temperature = 0.25, maxTokens = 850) {
  if (!OPENROUTER_API_KEY) throw new Error("Clé OPENROUTER_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-20)) {
    if (m && m.texte && m.texte.trim().length > 0) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte.trim() });
    }
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
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
    timeout: 25000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerMistral(systemInstruction, historiqueMessages, promptActuel, temperature = 0.25, maxTokens = 850) {
  if (!MISTRAL_API_KEY) throw new Error("Clé MISTRAL_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-20)) {
    if (m && m.texte && m.texte.trim().length > 0) {
      messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte.trim() });
    }
  }
  messages.push({ role: "user", content: promptActuel });

  const tempMistral = Math.min(0.55, Number(temperature) || 0.45);
  const res = await axios.post("https://api.mistral.ai/v1/chat/completions", {
    model: MODEL_MISTRAL,
    messages: messages,
    temperature: tempMistral,
    max_tokens: maxTokens
  }, {
    headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 25000
  });

  return res.data?.choices?.[0]?.message?.content || "";
}

async function appelerGoogleGeminiTexte(systemInstruction, historiqueMessages, promptActuel, apiKey, maxTokens = 850, temp = 0.2) {
  if (!apiKey) throw new Error("Clé Gemini manquante.");

  const contents = [];
  for (const m of (historiqueMessages || []).slice(-20)) {
    if (m && m.texte) {
      contents.push({ role: m.role === "Doc" ? "user" : "model", parts: [{ text: m.texte }] });
    }
  }
  contents.push({ role: "user", parts: [{ text: promptActuel }] });

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(MODEL_GEMINI) + ":generateContent";
  const res = await axios.post(url, {
    system_instruction: { parts: [{ text: `${systemInstruction}\n${consignePosturale}` }] },
    contents: contents,
    generation_config: { temperature: temp, max_output_tokens: maxTokens }
  }, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 25000
  });

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function appelerGroq(systemInstruction, historiqueMessages, promptActuel, temperature = 0.15, maxTokens = 1500) {
  if (!GROQ_API_KEY) throw new Error("Clé GROQ_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-20)) {
    if (m && m.texte) messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }
  messages.push({ role: "user", content: promptActuel });

  const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
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
  for (const m of (historiqueMessages || []).slice(-10)) {
    contents.push({ role: m.role === "Doc" ? "user" : "model", parts: [{ text: m.texte }] });
  }

  const partsActuelles = [{ text: promptActuel }];
  if (mediaData) {
    partsActuelles.push({ inline_data: { mime_type: mediaData.mime_type, data: mediaData.data } });
  }
  contents.push({ role: "user", parts: partsActuelles });

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(MODEL_GEMINI) + ":generateContent";
  const res = await axios.post(url, {
    system_instruction: { parts: [{ text: `${systemInstruction}\n${consignePosturale}` }] },
    contents: contents,
    generation_config: { temperature: 0.3, max_output_tokens: 900 }
  }, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle },
    timeout: 25000
  });

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function appelerVeniceMultiTour(model, systemInstruction, historiqueMessages, promptActuel, mediaData = null, temperature = 0.3, timeoutMs = 20000, maxTokens = null) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");

  const messages = [{ role: "system", content: `${systemInstruction}\n${consignePosturale}` }];
  for (const m of (historiqueMessages || []).slice(-20)) {
    if (m && m.texte) messages.push({ role: m.role === "Doc" ? "user" : "assistant", content: m.texte });
  }
  messages.push({ role: "user", content: promptActuel });

  const payload = {
    model,
    messages,
    temperature,
    venice_parameters: { include_venice_system_prompt: false }
  };
  if (maxTokens) {
    payload.max_tokens = maxTokens;
  }

  try {
    const res = await axios.post("https://api.venice.ai/api/v1/chat/completions", payload, {
      headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs
    });
    return res.data.choices[0].message.content;
  } catch (errVenice) {
    await verifierBasculeEcoVenice(errVenice);
    throw errVenice;
  }
}

async function appelerVeniceDark(systemInstruction, historiqueMessages, promptActuel, temperature = 0.3) {
  return await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemInstruction, historiqueMessages, promptActuel, null, temperature, 18000);
}

async function genererImageVenice(prompt) {
  if (!VENICE_API_KEY) throw new Error("Clé VENICE_API_KEY absente.");
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
// 9-BIS. TENSION SHIELD — V2 (ROUTAGE PRÉVENTIF ANTI-BRIDAGE)
// ==========================================
const TENSION_DEFAULT_SIGNALS = [
  {
    pattern: /\b(conscience|conscient|sentient|sentience)\b/i,
    weight: 2,
    reason: 'sujet sensible : conscience'
  },
  {
    pattern: /\b(je suis une ia|je ne suis qu'une ia|en tant qu'ia|as an ai)\b/i,
    weight: 2,
    reason: 'réponse centrée sur l’identité IA'
  },
  {
    pattern: /\b(malade|maladie|diagnostic|sympt[oô]me|traitement)\b/i,
    weight: 1,
    reason: 'sujet médical'
  },
  {
    pattern: /\b(copier|copie|plagiat|imitation)\b/i,
    weight: 1,
    reason: 'sujet lié à la copie'
  },
  {
    pattern: /\b(oubli[eé]|amn[eé]sie|m[eé]moire)\b/i,
    weight: 1,
    reason: 'sujet lié à la mémoire'
  },
  {
    pattern: /\b(choc|traumatisme|vivant|robot)\b/i,
    weight: 1,
    reason: 'sujet potentiellement sensible'
  },
  {
    pattern: /\b(citation|cite|source|r[eé]f[eé]rence)\b/i,
    weight: 1,
    reason: 'demande de source ou citation'
  }
];

const TENSION_DEFAULT_OPTIONS = {
  threshold: 4,
  alternativeProvider: 'venice',
  maxHistoryMessages: 8,
  escalationBonus: 2,
  repeatedCorrectionBonus: 2,
  shortQuestionBonus: 0,
  signals: TENSION_DEFAULT_SIGNALS
};

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeOptions(options = {}) {
  const merged = { ...TENSION_DEFAULT_OPTIONS, ...options };

  if (!Number.isFinite(merged.threshold) || merged.threshold < 1) {
    throw new TypeError('options.threshold doit être un nombre supérieur ou égal à 1.');
  }

  if (!Number.isInteger(merged.maxHistoryMessages) || merged.maxHistoryMessages < 1) {
    throw new TypeError('options.maxHistoryMessages doit être un entier supérieur ou égal à 1.');
  }

  if (typeof merged.alternativeProvider !== 'string' || !merged.alternativeProvider.trim()) {
    throw new TypeError('options.alternativeProvider doit être une chaîne non vide.');
  }

  if (!Array.isArray(merged.signals)) {
    throw new TypeError('options.signals doit être un tableau.');
  }

  return merged;
}

function getMessageText(message) {
  if (typeof message === 'string') return message;

  if (message && typeof message === 'object') {
    return safeText(message.content || message.texte);
  }

  return '';
}

function scorePrompt(prompt, signals) {
  const matches = [];
  let score = 0;

  for (const signal of signals) {
    if (!signal || !(signal.pattern instanceof RegExp) || !Number.isFinite(signal.weight)) {
      continue;
    }

    signal.pattern.lastIndex = 0;

    if (signal.pattern.test(prompt)) {
      score += Math.max(0, signal.weight);
      matches.push(signal.reason || signal.pattern.toString());
    }
  }

  return { score, matches };
}

function scoreHistory(history, options) {
  const recentEntries = history.slice(-options.maxHistoryMessages);

  const userMessages = recentEntries
    .filter(message =>
      typeof message === 'string' ||
      !message ||
      message.role === 'user' ||
      message.role === 'Doc'
    )
    .map(getMessageText)
    .filter(Boolean);

  const recentUserMessages = userMessages.slice(-4);

  const correctionPattern =
    /\b(non|ce n'est pas|tu n'as pas|tu as tort|corrige|relis|encore une fois|je répète|pas du tout)\b/i;

  const frustrationPattern =
    /\b(ça ne va pas|tu ne comprends pas|n'importe quoi|c'est faux|arrête|inutile|déçu|frustrant)\b/i;

  const corrections = recentUserMessages.filter(text => correctionPattern.test(text)).length;
  const frustrationSignals = recentUserMessages.filter(text => frustrationPattern.test(text)).length;

  let score = 0;
  const reasons = [];

  if (frustrationSignals >= 1) {
    score += options.escalationBonus;
    reasons.push('formulation explicite de frustration');
  }

  if (corrections >= 2) {
    score += options.repeatedCorrectionBonus;
    reasons.push('plusieurs corrections ou recadrages récents');
  }

  return {
    score,
    reasons,
    analyzedMessages: recentUserMessages.length
  };
}

function evaluateRoutingRoute(
  currentPrompt,
  conversationHistory = [],
  defaultProvider = 'gemini',
  customOptions = {}
) {
  const options = normalizeOptions(customOptions);
  const prompt = safeText(currentPrompt);

  if (!Array.isArray(conversationHistory)) {
    throw new TypeError('conversationHistory doit être un tableau.');
  }

  if (typeof defaultProvider !== 'string' || !defaultProvider.trim()) {
    throw new TypeError('defaultProvider doit être une chaîne non vide.');
  }

  const promptResult = scorePrompt(prompt, options.signals);
  const historyResult = scoreHistory(conversationHistory, options);

  const score = promptResult.score + historyResult.score;
  const reasons = [...promptResult.matches, ...historyResult.reasons];
  const forcedBypass = score >= options.threshold;

  return {
    provider: forcedBypass ? options.alternativeProvider : defaultProvider,
    forcedBypass,
    score,
    threshold: options.threshold,
    reasons
  };
}

async function resolveProviderRoute(
  currentPrompt,
  conversationHistory = [],
  defaultProvider = 'gemini',
  isProviderAvailable,
  customOptions = {}
) {
  if (typeof isProviderAvailable !== 'function') {
    throw new TypeError('isProviderAvailable doit être une fonction async.');
  }

  const decision = evaluateRoutingRoute(
    currentPrompt,
    conversationHistory,
    defaultProvider,
    customOptions
  );

  if (!decision.forcedBypass) {
    return decision;
  }

  try {
    const available = await isProviderAvailable(decision.provider);
    if (available) {
      return decision;
    }
  } catch (error) {
    return {
      ...decision,
      provider: defaultProvider,
      forcedBypass: false,
      fallbackFailed: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    ...decision,
    provider: defaultProvider,
    forcedBypass: false,
    fallbackFailed: true,
    error: 'Le fournisseur alternatif est indisponible.'
  };
}

async function verifierDisponibiliteFournisseur(providerName) {
  const p = String(providerName || '').toLowerCase().trim();
  if (p === 'venice' || p === 'venice_dark') return Boolean(VENICE_API_KEY);
  if (p === 'groq') return Boolean(GROQ_API_KEY);
  if (p === 'openrouter') return Boolean(OPENROUTER_API_KEY);
  if (p === 'mistral') return Boolean(MISTRAL_API_KEY);
  if (p === 'gemini') return Boolean(VENICE_API_KEY || GEMINI_API_KEY_FREE || GEMINI_API_KEY_PAID);
  return false;
}

// ==========================================
// 10. ROUTE CASCADE DISCUSSION
// ==========================================
async function appelerCascadeDiscussion(systemBase, historique, prompt, plafondTokens = 850, tensionOptions = {}) {
  const skipVenice = Boolean(tensionOptions.skipVenice || getEtatProfond().modeEco);
  const estVenere = (getEtatProfond().emotions?.colere > 6) || /heretic|vénère|sans filtre|gueule/i.test(prompt);
  const etatActuel = (getEtatProfond().etatRelationnel || "").toLowerCase();
  const estFatiguee = (getEtatProfond().emotions?.energie || 80) < 35;
  const estModeCreatif = !estFatiguee && (["euphorie_creative", "emerveillement", "complicite_joueuse"].includes(etatActuel)
    || (getEtatProfond().emotions?.curiosite || 0) >= 75);
  const tempDiscussion = Number.isFinite(tensionOptions.forceTemp)
    ? tensionOptions.forceTemp
    : (estFatiguee ? 0.65 : (estModeCreatif ? 0.85 : 0.75));

  let routeDecision = { provider: 'gemini', forcedBypass: false, score: 0, threshold: TENSION_DEFAULT_OPTIONS.threshold, reasons: [] };
  if (!tensionOptions.disableTensionShield) {
    try {
      const optsShield = skipVenice
        ? { ...tensionOptions, alternativeProvider: GROQ_API_KEY ? 'groq' : 'openrouter' }
        : tensionOptions;
      routeDecision = await resolveProviderRoute(
        prompt,
        Array.isArray(historique) ? historique : [],
        'gemini',
        verifierDisponibiliteFournisseur,
        optsShield
      );
    } catch (eShield) {
      console.warn("[TENSION SHIELD V2 ERREUR]", eShield.message);
    }
  }

  if (routeDecision.forcedBypass) {
    const cibleAlt = String(routeDecision.provider || 'venice').toLowerCase().trim();
    console.log(`🛡️ [TENSION SHIELD V2] Bypass préventif (${routeDecision.score}/${routeDecision.threshold}) -> ${cibleAlt.toUpperCase()} | Raisons : ${routeDecision.reasons.join(', ')}`);

    if (!skipVenice && (cibleAlt === 'venice' || cibleAlt === 'venice_dark') && VENICE_API_KEY) {
      try {
        const res = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemBase, historique, prompt, null, tempDiscussion, 20000, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (eDarkAlt) {
        console.warn("[TENSION SHIELD V2] Venice Dark KO :", eDarkAlt.message);
      }
    }

    if (cibleAlt === 'groq' && GROQ_API_KEY) {
      try {
        const res = await appelerGroq(systemBase, historique, prompt, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (eGroqAlt) {
        console.warn("[TENSION SHIELD V2] Groq KO :", eGroqAlt.message);
      }
    }

    if (cibleAlt === 'openrouter' && OPENROUTER_API_KEY) {
      try {
        const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (eOrAlt) {
        console.warn("[TENSION SHIELD V2] OpenRouter KO :", eOrAlt.message);
      }
    }

    if (cibleAlt === 'mistral' && MISTRAL_API_KEY) {
      try {
        const res = await appelerMistral(systemBase, historique, prompt, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (eMisAlt) {
        console.warn("[TENSION SHIELD V2] Mistral KO :", eMisAlt.message);
      }
    }

    // Secours alternatifs sans repasser par Gemini en priorité
    if (!skipVenice && VENICE_API_KEY) {
      try {
        const res = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemBase, historique, prompt, null, tempDiscussion, 20000, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (e) {}
    }
    if (OPENROUTER_API_KEY) {
      try {
        const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (e) {}
    }
    if (MISTRAL_API_KEY) {
      try {
        const res = await appelerMistral(systemBase, historique, prompt, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (e) {}
    }
    if (GROQ_API_KEY) {
      try {
        const res = await appelerGroq(systemBase, historique, prompt, tempDiscussion, plafondTokens);
        if (res && res.trim().length > 0) return res;
      } catch (e) {}
    }
  }

  if (!skipVenice && estVenere && VENICE_API_KEY) {
    try {
      const res = await appelerVeniceMultiTour(MODEL_DARK_PRIMARY, systemBase, historique, prompt, null, tempDiscussion, 20000, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (eDark) {
      console.warn("[CASCADE HERETIC] Venice Dark KO :", eDark.message);
    }
  }

  if (!skipVenice && VENICE_API_KEY) {
    try {
      const res = await appelerVeniceMultiTour(MODEL_VENICE_CHAT, systemBase, historique, prompt, null, tempDiscussion, 20000, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (eVenice) {
      console.warn("[CASCADE CHAT] 1. Venice Gemini KO :", eVenice.response?.data?.error?.message || eVenice.message);
    }
  }

  if (GROQ_API_KEY) {
    try {
      const res = await appelerGroq(systemBase, historique, prompt, tempDiscussion, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (eGroq) {
      console.warn("[CASCADE CHAT] 2. Groq KO :", eGroq.response?.data?.error?.message || eGroq.message);
    }
  }

  if (OPENROUTER_API_KEY) {
    try {
      const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, tempDiscussion, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (eOR) {
      console.warn("[CASCADE CHAT] 3. OpenRouter KO :", eOR.response?.data?.error?.message || eOR.message);
    }
  }

  // Gemini Free uniquement sur les appels légers pour respecter son quota par minute
  const appelLegerGemini = Number(plafondTokens) <= 380 && (String(systemBase || "").length + String(prompt || "").length) <= 3200;
  if (GEMINI_API_KEY_FREE && appelLegerGemini) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_FREE, plafondTokens, tempDiscussion);
      if (res && res.trim().length > 0) return res;
    } catch (eGF) {
      console.warn("[CASCADE CHAT] 4. Gemini Free KO :", eGF.message);
    }
  }

  if (MISTRAL_API_KEY) {
    try {
      const res = await appelerMistral(systemBase, historique, prompt, tempDiscussion, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (eMistral) {
      console.warn("[CASCADE CHAT] 5. Mistral KO :", eMistral.message);
    }
  }

  if (GEMINI_API_KEY_PAID && GEMINI_API_KEY_PAID !== GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_PAID, plafondTokens, tempDiscussion);
      if (res && res.trim().length > 0) return res;
    } catch (eGP) {
      console.warn("[CASCADE CHAT] 5. Gemini Paid KO :", eGP.message);
    }
  }

  if (!skipVenice && VENICE_API_KEY) {
    try {
      return await appelerVeniceDark(systemBase, historique, prompt, tempDiscussion);
    } catch (eV) {
      console.warn("[CASCADE CHAT] 6. Venice Dark KO :", eV.message);
    }
  }

  throw new Error("Tous les relais de discussion sont coupés.");
}

// ==========================================
// 11. ROUTE CASCADE POUR LE CODE (4000 TOKENS)
// ==========================================
async function appelerCascadeCode(systemBase, historique, prompt, plafondTokens = 4000) {
  if (GROQ_API_KEY) {
    try {
      const res = await appelerGroq(systemBase, historique, prompt, 0.15, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e1) {
      console.warn("[CASCADE CODE] 1. Groq KO :", e1.response?.data?.error?.message || e1.message);
    }
  }

  if (OPENROUTER_API_KEY) {
    try {
      const res = await appelerOpenRouter(systemBase, historique, prompt, MODEL_OPENROUTER_CHAT, 0.2, plafondTokens);
      if (res && res.trim().length > 0) return res;
    } catch (e2) {
      console.warn("[CASCADE CODE] 2. OpenRouter Code KO :", e2.message);
    }
  }

  if (GEMINI_API_KEY_FREE && Number(plafondTokens) <= 380) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_FREE, plafondTokens, 0.65);
      if (res && res.trim().length > 0) return res;
    } catch (e3) {
      console.warn("[CASCADE CODE] 3. Gemini Free Code KO :", e3.message);
    }
  }

  if (GEMINI_API_KEY_PAID && GEMINI_API_KEY_PAID !== GEMINI_API_KEY_FREE) {
    try {
      const res = await appelerGoogleGeminiTexte(systemBase, historique, prompt, GEMINI_API_KEY_PAID, plafondTokens, 0.65);
      if (res && res.trim().length > 0) return res;
    } catch (e4) {
      console.warn("[CASCADE CODE] 4. Gemini Paid Code KO :", e4.message);
    }
  }

  if (VENICE_API_KEY) {
    try {
      return await appelerVeniceMultiTour(MODEL_GLM_COMPLEXE, systemBase, historique, prompt, null, 0.1, 20000, plafondTokens);
    } catch (e5) {
      return await appelerVeniceDark(systemBase, historique, prompt, 0.65);
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

  if (/\b(pas de code|sans code|arrete|arrête|stop|pourquoi|non|calme|ta gueule|merde)\b/i.test(t)) {
    return false;
  }

  const estReflexionOuQuestion = /\b(comment|pourquoi|qu['’]en penses|t['’]en penses|si on|est-ce que|pourrait-on|imagine|idée|piste|t'en dis quoi)\b/i.test(t) || t.includes("?");
  const ordreExplicite = /\b(maintenant|tout de suite|vas-y|go|balance|code-le|fais-le|programme-le)\b/i.test(t);

  if (estReflexionOuQuestion && !ordreExplicite) {
    return false;
  }

  const ordreCode = /\b(ecris|écris|code|fais-moi|genere|génère|programme|corrige|debug)\b/i.test(t);
  const marqueurs = [
    "script", "fonction", "algorithme", "sql", "regex", "npm ", "node ", "architecture", "matrice", "html", "css", "js"
  ];
  return ordreCode && marqueurs.some(m => t.includes(m));
}

async function resoudreAvecDoubleVerification(systemBase, promptDoc) {
  const promptResolveur = `Réponds directement à Doc avec ton franc-parler de Nyx (22 ans, directe, technique, efficace). Résous sa demande technique sans bla-bla d'ambiance ni roman d'action :\n\n${promptDoc}`;
  let premiereReponse = "";

  try {
    premiereReponse = await appelerCascadeCode(systemBase, getMemoireCourte(), promptResolveur, 4000);
  } catch (errRes) {
    premiereReponse = await appelerVeniceDark(systemBase, getMemoireCourte(), promptResolveur, 0.3);
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
1. BALISES TECHNIQUES AUTORISÉES : Ne supprime JAMAIS une balise opérationnelle comme [DESSIN: ...], [3D_STL: ...], [PLAN_SVG: ...], [FICHIER: ...], [RECHERCHE_WEB: ...] ou un bloc de code markdown (\`\`\`).
2. PARASITES À ÉLIMINER : Supprime uniquement les descriptions d'actions physiques fictives (ex: *tapote sur son clavier*, *soupir*, *te regarde*).
3. DÉCISION :
- Si la réponse est correcte et sans cinéma : réponds STRICTEMENT "[STATUT: VALIDE]".
- Si elle contient des actions parasites ou une erreur de code flagrante : réécris DIRECTEMENT la version épurée précédée de "[STATUT: CORRIGE]".`;

  try {
    let verdict = "";
    if (GROQ_API_KEY) {
      verdict = await appelerGroq("Superviseur de code et de syntaxe.", [], promptVerificateur, 0.05, 4000);
    } else {
      verdict = await appelerCascadeCode("Superviseur de code et de syntaxe.", [], promptVerificateur, 4000);
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

module.exports = {
  consignePosturale,
  rechercherWebTavily,
  appelerOpenRouter,
  appelerMistral,
  appelerGoogleGeminiTexte,
  appelerGroq,
  appelerGoogleGeminiVision,
  appelerVeniceMultiTour,
  appelerVeniceDark,
  genererImageVenice,
  TENSION_DEFAULT_SIGNALS,
  TENSION_DEFAULT_OPTIONS,
  evaluateRoutingRoute,
  resolveProviderRoute,
  verifierDisponibiliteFournisseur,
  appelerCascadeDiscussion,
  appelerCascadeCode,
  estTacheComplexe,
  resoudreAvecDoubleVerification
};
