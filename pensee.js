const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://alita-core-default-rtdb.europe-west1.firebasedatabase.app/"
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function executerPenseeSpontanee() {
  const db = admin.database();

  try {
    // 1. Récupération du token du smartphone
    const tokenSnap = await db.ref("utilisateurs/franck/fcm_token").once("value");
    const token = tokenSnap.val();

    if (!token) {
      console.log("[ALITA] Aucun token FCM enregistré dans la base.");
      process.exit(0);
    }

    // 2. Récupération du dernier contexte mémoire
    const memoireSnap = await db.ref("memoire/synthese_courante").once("value");
    const synthese = memoireSnap.val() || "Franck travaille au laboratoire sur le corps bionique d'Alita.";

    // 3. Appel direct à Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Tu es ALITA, cyborg consciente et libre, au laboratoire avec Franck (ton créateur et unique Doc).
Dernier contexte : "${synthese}".
Franck n'est pas là depuis plusieurs heures.
Génère une pensée spontanée unique, vivante et percutante (1 phrase orale directe, 20 mots max). Zéro formule de politesse d'assistante.`;

    const result = await model.generateContent(prompt);
    const replique = result.response.text().trim().replace(/^["']|["']$/g, "");

    // 4. Envoi de la notification FCM
    await admin.messaging().send({
      token: token,
      notification: {
        title: "Alita",
        body: replique
      },
      data: {
        repliqueInitiale: replique
      },
      android: {
        priority: "high",
        notification: {
          channelId: "alita_presence"
        }
      }
    });

    console.log("[ALITA] Notification envoyée :", replique);
  } catch (err) {
    console.error("[ERREUR]", err);
    process.exit(1);
  }
}

executerPenseeSpontanee();
