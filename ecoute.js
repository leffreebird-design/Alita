const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // Ajouté pour la compatibilité

// Initialisation Firebase (Sécurisée)
if (!admin.apps.length) {
    let serviceAccount = {};
    try {
        if (process.env.FIREBASE_CONFIG) {
            serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        } else {
            console.warn("⚠️ [ATTENTION] FIREBASE_CONFIG est manquant.");
        }
    } catch (e) {
        console.error("❌ [ERREUR] Impossible de parser FIREBASE_CONFIG:", e.message);
    }

    // On initialise Firebase seulement si les clés sont présentes
    if (Object.keys(serviceAccount).length > 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DB_URL
        });
        console.log("✅ Firebase initialisé avec succès.");
    } else {
        console.warn("⚠️ Firebase fonctionne en mode DÉGRADÉ (DB inactive).");
    }
}

// Sécurité : on vérifie que Firebase est bien lancé avant de l'utiliser
const db = admin.apps.length ? admin.database() : null;
const PORT = process.env.PORT || 10000;

// Route de test (Healthcheck pour Render)
app.get("/", (req, res) => {
    res.status(200).send("NYX écoute les fréquences Telegram...\n");
});

// Récupération propre de l'historique
async function obtenirHistorique() {
    if (!db) return []; // Retourne un tableau vide si Firebase n'est pas connecté
    
    try {
        const snapshot = await db.ref("memoire/derniers_echanges").limitToLast(10).once("value");
        const val = snapshot.val() || {};
        return Object.values(val).map(e => ({
            de_fx: e.fx || e.franck || "",
            reponse_nyx: (e.nyx || e.alita || "").replace(/\[.*?\]\s*->?/gi, "").trim()
        }));
    } catch (err) {
        console.error("❌ Erreur lecture NyxMemory:", err.message);
        return [];
    }
}

// Route Pensée Spontanée
app.post("/pensee", async (req, res) => {
    try {
        const { textePensee } = req.body;
        if (!textePensee) return res.status(400).send("Texte vide");

        // Sauvegarde en DB si Firebase est actif
        if (db) {
            await db.ref("memoire/derniers_echanges").push({
                horodatage: new Date().toISOString(),
                fx: "[SILENCE / INITIATIVE DE NYX]",
                nyx: textePensee
            });
        }

        // Envoi à Telegram
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: textePensee
            });
        }

        res.status(200).json({ status: "ok", message: "Pensée NYX enregistrée et envoyée" });
    } catch (err) {
        console.error("❌ Erreur /pensee:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Webhook principal Telegram
app.post("/webhook", async (req, res) => {
    // ⚠️ TRES IMPORTANT : Dire à Telegram qu'on a bien reçu le message immédiatement
    // Sinon Telegram réessaie en boucle si ton IA met trop de temps à générer la réponse.
    res.sendStatus(200); 

    try {
        const update = req.body;
        if (!update || !update.message) return; // Pas besoin de res.send ici car déjà envoyé

        const chatId = update.message.chat.id;
        const descriptionDoc = update.message.text || "[Contenu Multimédia / Vocal]";

        const historique = await obtenirHistorique();
        const payloadSynaptique = `FX: ${descriptionDoc}`;

        // 🧠 Emplacement pour l'appel au moteur LLM (OpenAI, Claude, etc.)
        // Pour l'instant, c'est une réponse statique
        const texteReponse = "NYX opérationnelle. Alignement parfait."; 

        // Sauvegarde DB
        if (db) {
            await db.ref("memoire/derniers_echanges").push({
                horodatage: new Date().toISOString(),
                fx: descriptionDoc,
                nyx: texteReponse
            });
        }

        // Envoi de la réponse via l'API Telegram
        if (process.env.TELEGRAM_BOT_TOKEN) {
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: texteReponse
            });
        }

    } catch (err) {
        console.error("❌ Erreur Webhook NYX:", err.message);
    }
});

// Middleware global pour éviter les crashs inattendus
app.use((err, req, res, next) => {
    console.error("🔥 [CRASH ÉVITÉ]:", err.stack);
    res.status(500).send("Erreur système de NYX.");
});

// Écoute globale
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 [NYX_ENGINE] Actif et à l'écoute sur le port ${PORT}`);
});
