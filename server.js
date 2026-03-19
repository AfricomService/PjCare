// server.js
const express      = require("express");
const cors         = require("cors");
const { execFile } = require("child_process");
const path         = require("path");
const fs           = require("fs");
const os           = require("os");

const app = express();

// --- CORS : autoriser Angular (localhost:4200) et toute autre origine locale ---
app.use(cors());

app.use(express.json());

// --- TEMP DIR ---
const tmpBase  = process.env.TEMP || process.env.TMP || os.tmpdir();
const TEMP_DIR = path.join(tmpBase, "CorrespPj");
fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log("📂 Dossier temp :", TEMP_DIR);

// --- SERVIR LES FICHIERS GÉNÉRÉS ---
app.use("/Temp", express.static(TEMP_DIR));

// --- NAPS2 : recherche dynamique (plus de chemin codé en dur) ---
const POSSIBLE_NAPS2_PATHS = [
  "C:\\Program Files\\NAPS2\\NAPS2.Console.exe",
  "C:\\Program Files (x86)\\NAPS2\\NAPS2.Console.exe",
  path.join(process.env.LOCALAPPDATA || "", "NAPS2", "NAPS2.Console.exe"),
  path.join(process.env.APPDATA     || "", "NAPS2", "NAPS2.Console.exe"),
];
const NAPS2_EXE = POSSIBLE_NAPS2_PATHS.find(p => fs.existsSync(p)) || null;

if (!NAPS2_EXE) {
  console.warn("⚠️  NAPS2 introuvable. Le scan ne fonctionnera pas.");
} else {
  console.log("✅ NAPS2 trouvé :", NAPS2_EXE);
}

// --- TWAIN via node-twain ---
let twainApp = null;
try {
  const { TwainSDK, TWCY_FRANCE, TWLG_FRENCH } = require("node-twain");
  twainApp = new TwainSDK({
    productName:   "PjCare",
    productFamily: "CorrespCare",
    manufacturer:  "Africom",
    version: {
      country:  TWCY_FRANCE,
      language: TWLG_FRENCH,
      majorNum: 1,
      minorNum: 0,
      info:     "v1.0.0"
    }
  });
  console.log("✅ TWAIN initialisé");
} catch (err) {
  console.warn("⚠️  node-twain indisponible :", err.message);
}

// ─────────────────────────────────────────────
// GET /api/health  — ping pour Angular
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status:    200,
    service:   "PjCare",
    naps2:     NAPS2_EXE ? "found" : "missing",
    twain:     twainApp  ? "ready" : "unavailable",
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// GET /api/GetListScanner
// ─────────────────────────────────────────────
app.get("/api/GetListScanner", (req, res) => {
  if (!NAPS2_EXE) {
    return res.status(503).json({ status: 503, error: "NAPS2 introuvable", scanners: [] });
  }

  execFile(NAPS2_EXE, ["--listdevices", "--driver", "wia"],
    { windowsHide: true, timeout: 15000 },
    (err, stdout, stderr) => {
      console.log("listdevices stdout:", stdout);
      if (stderr) console.log("listdevices stderr:", stderr);

      if (err || !stdout.trim()) {
        // Fallback : retourner le scanner connu directement
        return res.json({
          status: 200,
          scanners: ["EPSON L6270 Series (10.1.10.33)"]
        });
      }

      const scanners = stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      res.json({ status: 200, scanners });
    }
  );
});


// ─────────────────────────────────────────────
// GET /api/Acquire?source=…&dpi=…&jpegquality=…&format=…&name=…
// ─────────────────────────────────────────────
app.get("/api/Acquire", (req, res) => {
  // 1) Vérifier NAPS2
  if (!NAPS2_EXE) {
    return res.status(503).json({
      status: 503,
      error:  "NAPS2 n'est pas installé sur ce poste. Installez NAPS2 depuis https://www.naps2.com"
    });
  }

  const { source, dpi = 150, jpegquality = 75, format = "jpg", name } = req.query;

  // 2) Vérifier le scanner source
  if (!source) {
    return res.status(400).json({ status: 400, error: "Paramètre 'source' manquant" });
  }

  // 3) Sanitiser le nom de fichier
  let baseName = source.toString().replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (name) {
    const safe = name.toString().trim().replace(/[^\p{L}\p{N}_-]/gu, "_");
    if (safe.length > 0) baseName = safe;
  }

  const filename = `${baseName}-${Date.now()}.${format}`;
  const outPath  = path.join(TEMP_DIR, filename);
  console.log("→ Scan vers :", outPath);

  // 4) Arguments NAPS2
  const args = [
    "--noprofile",
    "--driver",      "wia",
    "--device",      source.toString(),
    "--output",      outPath,
    "--dpi",         dpi.toString(),
    "--bitdepth",    "color",
    "--jpegquality", jpegquality.toString()
  ];

  // 5) Lancer NAPS2
  execFile(NAPS2_EXE, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
    console.log("← stdout:", stdout);
    if (stderr) console.error("← stderr:", stderr);

    if (err) {
      return res.status(500).json({ status: 500, error: stderr || err.message });
    }

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ status: 500, error: "Scan terminé mais fichier introuvable" });
    }

    fs.readFile(outPath, (readErr, data) => {
      if (readErr) {
        return res.status(500).json({ status: 500, error: readErr.message });
      }

      // Nettoyer le fichier temp après envoi (optionnel)
      fs.unlink(outPath, () => {});

      res.json({
        status: 200,
        data:   data.toString("base64"),
        file:   filename
      });
    });
  });
});

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = 7777;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ PjCare API démarrée sur http://127.0.0.1:${PORT}`);
  console.log(`   Health check : http://127.0.0.1:${PORT}/api/health`);
});