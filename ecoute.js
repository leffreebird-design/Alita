// Importation des dépendances
const express = require('express');
const axios = require('axios');
const app = express();


// Middlewares de sécurité et de parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Vérification au démarrage
if (!TELEGRAM_TOKEN) {
    console.warn("⚠️ [ATTENTION] TELEGRAM_BOT_TOKEN est manquant dans les variables d'environnement.");
}

// Route de diagnostic
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        system: 'NYX_ENGINE', 
        timestamp: new Date().toISOString() 
    });
});

// Route /pensee
app.post('/pensee', async (req, res) => {
    try {
        const { pensee, metadata } = req.body;
        if (!pensee) {
            return res.status(400).json({ error: 'Le champ "pensee" est requis.' });
        }

        console.log('[NYX - PENSÉE RECEIVED]:', pensee);
        return res.status(200).json({ status: 'processed', data: pensee });
    } catch (error) {
        console.error('[ERR /pensee]:', error.message);
        return res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});

// Webhook Telegram principal
app.post('/telegram', async (req, res) => {
    // Réponse immédiate pour Telegram
    res.sendStatus(200);

    try {
        const update = req.body;
        if (!update || !update.message) return;

        const chatId = update.message.chat.id;
        const text = update.message.text;
        const voice = update.message.voice;

        if (text) {
            console.log(`[MSG ${chatId}]: ${text}`);
        }

        if (voice) {
            console.log(`[VOICE ${chatId}]: File ID ${voice.file_id}`);
        }

    } catch (error) {
        console.error('[ERR TELEGRAM WEBHOOK]:', error.message);
    }
});

// Middleware global de gestion des erreurs
app.use((err, req, res, next) => {
    console.error('[CRITICAL ERROR]:', err.stack);
    res.status(500).send('Something broke!');
});

// Lancement du serveur
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NYX ENGINE] 🚀 Serveur en ligne sur le port ${PORT}`);
});
