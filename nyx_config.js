// ==========================================
// 1. CONFIGURATION, SÉCURITÉ & UTILITAIRES (nyx_config.js)
// ==========================================
const axios = require('axios');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// 1. CONFIGURATION & SÉCURITÉ
// ==========================================
const PORT = process.env.PORT || 3000;

function assainirParametre(val) {
  if (!val) return "";
  return String(val).trim().replace(/^["'`\[\(\{]+|["'`\]\)\}]+$/g, '').trim();
}

// [SÉCU] Comparaison de secrets en temps constant (évite les attaques par timing)
function comparerTokenSecurise(fourni, attendu) {
  const a = crypto.createHash('sha256').update(String(fourni || '')).digest();
  const b = crypto.createHash('sha256').update(String(attendu || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// [SÉCU] Plafond de taille APRÈS décompression (anti zip-bomb). Réglable via MAX_DECOMPRESSION_MO.
const LIMITE_DECOMPRESSION_OCTETS = (parseInt(process.env.MAX_DECOMPRESSION_MO, 10) || 150) * 1024 * 1024;
const gunzipAsync = (buf, opts) => new Promise((ok, ko) => zlib.gunzip(buf, opts, (e, r) => e ? ko(e) : ok(r)));

// VENICE AI - GEMINI EN PRIORITÉ N°1 CHAT + IMAGES + PARACHUTES
const VENICE_API_KEY = assainirParametre(process.env.VENICE_API_KEY);
const MODEL_VENICE_CHAT = assainirParametre(process.env.VENICE_MODEL_CHAT) || "gemini-3-5-flash-lite";
const MODEL_DARK_PRIMARY = assainirParametre(process.env.VENICE_MODEL_DARK) || "llama-3.3-70b";
const MODEL_GLM_COMPLEXE = assainirParametre(process.env.VENICE_MODEL_GLM) || "z-ai-glm-5-3";
const MODEL_IMAGE = assainirParametre(process.env.VENICE_MODEL_IMAGE) || "flux-dev";

// OPENROUTER - ROUTE N°2 CHAT
let modelOpenRouter = assainirParametre(process.env.OPENROUTER_MODEL);
if (!modelOpenRouter || modelOpenRouter.includes(":free") || modelOpenRouter.includes("deepseek-r1") || modelOpenRouter.includes("gemma")) {
  modelOpenRouter = "meta-llama/llama-3.3-70b-instruct";
}
const MODEL_OPENROUTER_CHAT = modelOpenRouter;
const OPENROUTER_API_KEY = assainirParametre(process.env.OPENROUTER_API_KEY);

// MISTRAL AI - ROUTE N°3 CHAT
const MISTRAL_API_KEY = assainirParametre(process.env.MISTRAL_API_KEY);
const MODEL_MISTRAL = assainirParametre(process.env.MISTRAL_MODEL) || "mistral-small-latest";

// GEMINI DIRECT GOOGLE - MODÈLE ACTIF 3.1
const GEMINI_API_KEY_FREE = assainirParametre(process.env.GEMINI_API_KEY_FREE || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const GEMINI_API_KEY_PAID = assainirParametre(process.env.GEMINI_API_KEY_PAID);
const GEMINI_KEYS = [GEMINI_API_KEY_PAID, GEMINI_API_KEY_FREE].filter(k => k.length > 0);
const MODEL_GEMINI = assainirParametre(process.env.GEMINI_MODEL) || "gemini-3.1-flash-lite";

// GROQ - CODE & PROJETS TECHNIQUES (HAUT DÉBIT TPM)
const GROQ_API_KEY = assainirParametre(process.env.GROQ_API_KEY);
const MODEL_GROQ = assainirParametre(process.env.GROQ_MODEL) || "llama-3.3-70b-versatile";

// RECHERCHE WEB EN DIRECT (TAVILY)
const TAVILY_API_KEY = assainirParametre(process.env.TAVILY_API_KEY);

// GOOGLE CLOUD TTS OFFICIEL (VOIX STUDIO ANTI-429)
const GOOGLE_TTS_API_KEY = assainirParametre(process.env.GOOGLE_TTS_API_KEY);

// CANAUX & PERSISTANCE
const TELEGRAM_BOT_TOKEN = assainirParametre(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_WEBHOOK_SECRET = assainirParametre(process.env.TELEGRAM_WEBHOOK_SECRET).replace(/[^A-Za-z0-9_-]/g, '');
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL ? assainirParametre(process.env.FIREBASE_DB_URL).replace(/\/$/, '') : null;
const DOC_CHAT_ID = process.env.DOC_CHAT_ID ? parseInt(assainirParametre(process.env.DOC_CHAT_ID)) : null;
// Secret API indépendant du token Telegram. Sans CRON_SECRET, les routes privées restent fermées.
const CRON_SECRET = assainirParametre(process.env.CRON_SECRET);

// SUPABASE - GRENIER VECTORIEL (MÉMOIRE ++)
const SUPABASE_URL = assainirParametre(process.env.SUPABASE_URL);
const SUPABASE_KEY = assainirParametre(process.env.SUPABASE_KEY);
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

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

function obtenirCleJourParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

function slugifierNom(texte, fallback = "artefact") {
  const clean = String(texte || fallback)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return clean || fallback;
}

function calculerSha256(texte) {
  return crypto.createHash('sha256').update(texte.trim()).digest('hex');
}

function estAdresseReseauPrivee(ip) {
  const famille = net.isIP(ip);
  if (famille === 4) {
    const o = ip.split('.').map(Number);
    const [a, b, c] = o;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (famille === 6) {
    const v = ip.toLowerCase().split('%')[0];
    if (v.startsWith('::ffff:') || v === '::' || v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
        v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') ||
        v.startsWith('ff') || v.startsWith('2001:db8:') || v.startsWith('2001:0:') || v.startsWith('2002:') || v.startsWith('64:ff9b:')) return true;
    const premier = parseInt(v.split(':')[0] || '0', 16);
    return !(premier >= 0x2000 && premier <= 0x3fff);
  }
  return true;
}

async function axiosGetHttpsPublic(urlInitiale, options = {}) {
  let urlCourante = new URL(String(urlInitiale));
  for (let redirection = 0; redirection <= 3; redirection++) {
    if (urlCourante.protocol !== 'https:' || urlCourante.username || urlCourante.password ||
        (urlCourante.port && urlCourante.port !== '443')) {
      throw new Error("URL refusée : HTTPS public sur le port standard uniquement.");
    }

    const hostname = urlCourante.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    let adresses;
    if (net.isIP(hostname)) {
      adresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
      adresses = await dns.lookup(hostname, { all: true, verbatim: true });
    }
    if (!adresses.length || adresses.some(a => estAdresseReseauPrivee(a.address))) {
      throw new Error("URL refusée : adresse IP privée, locale ou réservée.");
    }

    // Épingle la résolution DNS validée pour éviter une seconde résolution (DNS rebinding).
    const cible = adresses[0];
    const agent = new https.Agent({
      keepAlive: false,
      lookup: (hote, opts, callback) => {
        if (String(hote).toLowerCase() !== hostname) {
          return callback(new Error("Résolution DNS inattendue refusée."));
        }
        if (opts && opts.all) return callback(null, [{ address: cible.address, family: cible.family }]);
        return callback(null, cible.address, cible.family);
      }
    });

    let reponse;
    try {
      reponse = await axios.get(urlCourante.toString(), {
        ...options,
        httpsAgent: agent,
        proxy: false,
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400
      });
    } finally {
      agent.destroy();
    }

    if (reponse.status >= 300 && reponse.status < 400) {
      const location = reponse.headers?.location;
      if (!location || redirection === 3) throw new Error("Trop de redirections ou redirection invalide.");
      urlCourante = new URL(location, urlCourante);
      continue;
    }
    return reponse;
  }
  throw new Error("Téléchargement refusé après redirections.");
}

async function scraperPageWeb(urlCible) {
  try {
    const res = await axiosGetHttpsPublic(urlCible, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 12000,
      maxContentLength: 5 * 1024 * 1024
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

module.exports = {
  PORT,
  assainirParametre,
  comparerTokenSecurise,
  LIMITE_DECOMPRESSION_OCTETS,
  gunzipAsync,
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
  TAVILY_API_KEY,
  GOOGLE_TTS_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  FIREBASE_DB_URL,
  DOC_CHAT_ID,
  CRON_SECRET,
  SUPABASE_URL,
  SUPABASE_KEY,
  supabase,
  obtenirHorodatageParis,
  obtenirCleJourParis,
  slugifierNom,
  calculerSha256,
  estAdresseReseauPrivee,
  axiosGetHttpsPublic,
  scraperPageWeb
};
