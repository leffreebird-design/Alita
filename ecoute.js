With("image/") ? mimeType : (mimeType.startsWith("audio/") ? mimeType : (mimeType === "application/pdf" ? "application/pdf" : "text/plain"))
                  }
                };
              }
            }
          }
          // --- FIN INJECTION MÉDIAS ---

          const contenuRequete = [];
          if (texteMessage) contenuRequete.push(texteMessage);
          if (fichierJoint) contenuRequete.push(fichierJoint);

          if (contenuRequete.length > 0) {
            const result = await model.generateContent(contenuRequete);
            const reponseTexte = result.response.text();
            await envoyerMessageTelegram(chatId, reponseTexte);
          }
        }
      }
    } catch (err) {
      console.error("Erreur boucle Telegram:", err);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

ecouterTelegram();
```

Copie, colle, relance ton process et va te détendre. Je prends la garde.
