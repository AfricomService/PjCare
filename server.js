// server.js
const express    = require("express");
const cors       = require("cors");
const { execFile } = require("child_process");
const path       = require("path");
const fs         = require("fs");
const os         = require("os");

const app = express();
app.use(cors());

// --- TEMP DIR (Windows %TEMP%\CorrespPj) ---
const tmpBase  = process.env.TEMP || process.env.TMP || os.tmpdir();
const TEMP_DIR = path.join(tmpBase, "CorrespPj");
fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log("📂 Dossier CorrespPj :", TEMP_DIR);

// --- SERVIR LES FICHIERS GÉNÉRÉS ---
app.use("/Temp", express.static(TEMP_DIR));

// Chemin vers NAPS2.Console.exe
const NAPS2_EXE = "C:\\Program Files\\NAPS2\\NAPS2.Console.exe";

// TWAIN via node-twain
const { TwainSDK, TWCY_CHINA, TWLG_CHINESE } = require("node-twain");
const twainApp = new TwainSDK({
  productName:   "scanner-app",
  productFamily: "electron-demo",
  manufacturer:  "MonEntreprise",
  version: {
    country:  TWCY_CHINA,
    language: TWLG_CHINESE,
    majorNum: 1,
    minorNum: 0,
    info:     "v1.0.0"
  }
});

// GET /api/GetListScanner
app.get("/api/GetListScanner", (req, res) => {
  try {
    const list = twainApp.getDataSources();
    res.json({ status: 200, scanners: Array.isArray(list) ? list : [] });
  } catch (err) {
    res.status(500).json({ status: 500, error: err.message });
  }
});

// GET /api/Acquire?source=…&dpi=…&jpegquality=…&format=…&name=…
app.get("/api/Acquire", (req, res) => {
  const { source, dpi = 150, jpegquality = 75, format = "jpg", name } = req.query;
  if (!source) {
    return res.status(400).json({ status: 400, error: "Paramètre source manquant" });
  }

  // Sanitisation Unicode-friendly : on autorise les lettres (\p{L}), chiffres (\p{N}), underscore et tiret
  let baseName = source.replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (name) {
    const safe = name
      .toString()
      .trim()
      // normalize pour pouvoir matcher correctement les lettres accentuées
      .replace(/[^\p{L}\p{N}_-]/gu, "_");
    if (safe.length > 0) {
      baseName = safe;
    }
  }

  const filename = `${baseName}-${Date.now()}.${format}`;
  const outPath  = path.join(TEMP_DIR, filename);
  console.log("→ Sortie prévue :", outPath);

  // Construire les arguments pour execFile
  const args = [
    "--noprofile",
    "--driver", "twain",
    "--device", source,
    "--output", outPath,
    "--dpi", dpi,
    "--bitdepth", "color",
    "--jpegquality", jpegquality
  ];

  execFile(NAPS2_EXE, args, { windowsHide: true }, (err, stdout, stderr) => {
    console.log("← stdout:", stdout);
    console.error("← stderr:", stderr);
    if (err) {
      return res.status(500).json({ status: 500, error: stderr || err.message });
    }

    // Vérifier que le fichier a bien été créé
    if (!fs.existsSync(outPath)) {
      console.error("❌ Fichier introuvable après scan :", outPath);
      return res.status(500).json({ status: 500, error: "Scan OK mais fichier introuvable" });
    }

    // Lire le fichier et renvoyer en base64
    fs.readFile(outPath, (e, data) => {
      if (e) {
        return res.status(500).json({ status: 500, error: e.message });
      }
      res.json({
        status: 200,
        data:   data.toString("base64"),
        file:   filename
      });
    });
  });
});

const PORT = 7777;
app.listen(PORT, () => console.log(`API démarrée sur http://localhost:${PORT}`));
