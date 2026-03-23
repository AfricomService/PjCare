// config.js
const { execSync } = require("child_process");
const fs = require("fs");

function findNaps2() {

  // Niveau 1 — Variable d'environnement (config manuelle admin/IT)
  if (process.env.NAPS2_PATH && fs.existsSync(process.env.NAPS2_PATH)) {
    console.log("✅ NAPS2 via variable d'environnement");
    return process.env.NAPS2_PATH;
  }

  // Niveau 2 — Registre Windows (installation standard, peu importe le disque)
  try {
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    const result = execSync(
      `reg query "${key}" /s /f "NAPS2" /t REG_SZ`, 
      { encoding: "utf8", windowsHide: true }
    );
    const match = result.match(/InstallLocation\s+REG_SZ\s+(.+)/);
    if (match) {
      const exePath = match[1].trim() + "\\NAPS2.Console.exe";
      if (fs.existsSync(exePath)) {
        console.log("✅ NAPS2 trouvé via le registre Windows");
        return exePath;
      }
    }
  } catch (_) {}

  // Niveau 3 — Chemins courants (filet de sécurité)
  const fallbacks = [
    "C:\\Program Files\\NAPS2\\NAPS2.Console.exe",
    "C:\\Program Files (x86)\\NAPS2\\NAPS2.Console.exe",
  ];
  const found = fallbacks.find(p => fs.existsSync(p));
  if (found) {
    console.log("✅ NAPS2 trouvé via fallback");
    return found;
  }

  return null;
}

module.exports = { findNaps2 };