// main.js
const { app, Tray, Menu, dialog } = require("electron");
const path = require("path");
const { fork } = require("child_process");

let serverProc;
let tray;

// Empêcher une deuxième instance de l'app
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(() => {
  // Cacher l'app du dock macOS (pas utile sur Windows mais propre)
  if (app.dock) app.dock.hide();

  // 1) Lancer le serveur HTTP Express en arrière-plan
  serverProc = fork(path.join(__dirname, "server.js"), [], {
    stdio: "inherit"
  });

  serverProc.on("error", (err) => {
    dialog.showErrorBox("PjCare - Erreur serveur", `Le serveur n'a pas pu démarrer :\n${err.message}`);
    app.quit();
  });

  serverProc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      dialog.showErrorBox("PjCare - Serveur arrêté", `Le serveur s'est arrêté de façon inattendue (code ${code}).`);
      app.quit();
    }
  });

  // 2) Icône dans la barre système (system tray)
  const iconPath = path.join(__dirname, "assets", "icon.ico");
  tray = new Tray(iconPath);
  tray.setToolTip("PjCare — Service de scan actif ✅");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "PjCare — Service de scan",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Statut : En cours d'exécution ✅",
      enabled: false
    },
    {
      label: "Port : localhost:7777",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Quitter PjCare",
      click: () => {
        if (serverProc) serverProc.kill();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Clic gauche sur l'icône → afficher le menu aussi
  tray.on("click", () => {
    tray.popUpContextMenu();
  });
});

// Ne pas quitter quand toutes les fenêtres sont fermées
// (il n'y a pas de fenêtre, mais au cas où)
app.on("window-all-closed", () => {
  // Ne rien faire — l'app continue en tâche de fond
});

app.on("before-quit", () => {
  if (serverProc) serverProc.kill();
});