// main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { fork } = require("child_process");

let serverProc;

app.whenReady().then(() => {
  // 1) Lancer le serveur HTTP Express
  serverProc = fork(path.join(__dirname, "server.js"), [], { stdio: "inherit" });

  // 2) Ouvrir la fenêtre Electron
  const win = new BrowserWindow({
    width: 700,
    height: 550,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "public", "index.html"));
});

app.on("window-all-closed", () => {
  if (serverProc) serverProc.kill();
  if (process.platform !== "darwin") app.quit();
});
