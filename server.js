// ============================================================
// ARC Solar API — PPV Aéroclub ARC (LFPX)
// Solarman Business API v1.0 — https://globalapi.solarmanpv.com
// ============================================================

const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://globalapi.solarmanpv.com";

// ================= PLANNING DE COLLECTE =================
// Économie de quota API (appId allowance Solarman) :
//   - Jour  (06h–22h, heure de Paris) : 1 appel toutes les 30 min
//   - Nuit  (22h–06h)                 : 1 appel toutes les 2 h
// Soit ~36 appels/jour → un quota de 100 000 dure plusieurs années.
const DAY_INTERVAL_MS = 30 * 60 * 1000;
const NIGHT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const NIGHT_START_HOUR = 22; // inclus
const NIGHT_END_HOUR = 6;    // exclu

// Heure locale de Paris (les serveurs Railway sont en UTC)
function parisHour() {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hourCycle: "h23"
    }).format(new Date())
  );
}

function isNight() {
  const h = parisHour();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

function currentPollInterval() {
  return isNight() ? NIGHT_INTERVAL_MS : DAY_INTERVAL_MS;
}

const STATION_NAME_FILTER = "Aéroclub ARC";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// ================= CORS =================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ================= DATABASE =================
const db = new Database(process.env.DB_PATH || "/data/solar.db");
db.pragma("journal_mode = WAL");

db.prepare(`
  CREATE TABLE IF NOT EXISTS energy_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    power REAL,
    energy REAL
  )
`).run();

// Petit stockage clé/valeur : l'état survit aux redémarrages
db.prepare(`
  CREATE TABLE IF NOT EXISTS kv(
    key TEXT PRIMARY KEY,
    value TEXT
  )
`).run();

const kvGet = (key, fallback = null) => {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const kvSet = (key, value) => {
  db.prepare(
    "INSERT INTO kv(key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, JSON.stringify(value));
};

// ================= ÉTAT (persistant) =================
let BASE_TOTAL_KWH = kvGet("base_total_kwh", 6645.0);
let addedEnergy = kvGet("added_energy", 0);
let lastTimestamp = kvGet("last_timestamp", Date.now());

// Dernière lecture servie en cache aux clients HTTP
let lastReading = kvGet("last_reading", {
  station_name: "PPV Aéroclub ARC - LFPX",
  current_power_w: 0,
  battery_soc: 0,
  updated_at: null
});

// ================= UTILS =================
const sha256Lower = (str) =>
  crypto.createHash("sha256").update(str).digest("hex").toLowerCase();

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ================= TOKEN (avec cache) =================
// Doc Solarman : le token /account/v1.0/token est valable ~2 mois
// (champ expires_in) et l'endpoint est soumis à un quota strict.
// On le met donc en cache (mémoire + SQLite) au lieu de le redemander
// à chaque requête.
let tokenCache = kvGet("token_cache", null); // { token, expiresAt }

async function getAccessToken(force = false) {
  const now = Date.now();

  if (!force && tokenCache && tokenCache.expiresAt - now > 60 * 60 * 1000) {
    return tokenCache.token;
  }

  const url =
    `${BASE_URL}/account/v1.0/token` +
    `?appId=${encodeURIComponent(process.env.SOLARMAN_API_ID)}&language=en`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appSecret: process.env.SOLARMAN_API_SECRET,
      email: process.env.SOLARMAN_USERNAME,
      password: sha256Lower(process.env.SOLARMAN_PASSWORD)
    })
  });

  const data = await res.json();
  const token = data?.access_token || data?.data?.access_token || null;

  if (!token) {
    log("Token error:", data?.msg || JSON.stringify(data).slice(0, 200));
    return null;
  }

  // expires_in est en secondes (~5184000 = 60 jours). Marge de 1 h.
  const expiresIn = Number(data.expires_in || data?.data?.expires_in || 3600);
  tokenCache = { token, expiresAt: now + expiresIn * 1000 };
  kvSet("token_cache", tokenCache);

  log("Nouveau token Solarman obtenu, expire dans", Math.round(expiresIn / 86400), "jours");
  return token;
}

// ================= APPEL API GÉNÉRIQUE =================
// Réessaie une fois avec un token neuf si la session a expiré
// (code 401 HTTP ou code applicatif Solarman lié au token).
async function apiPost(path, body, retry = true) {
  const token = await getAccessToken();
  if (!token) return null;

  const res = await fetch(`${BASE_URL}${path}?language=en`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  let data = null;
  try { data = await res.json(); } catch { /* réponse non-JSON */ }

  const tokenInvalid =
    res.status === 401 ||
    (data && data.success === false && /token/i.test(data.msg || ""));

  if (tokenInvalid && retry) {
    log("Token invalide/expiré — renouvellement…");
    await getAccessToken(true);
    return apiPost(path, body, false);
  }

  if (data && data.success === false) {
    log(`API ${path} error:`, data.code, data.msg);
  }

  return data;
}

// ================= STATION =================
async function getStation() {
  const data = await apiPost("/station/v1.0/list", { page: 1, size: 20 });
  if (!data) return null;

  const stations = data.stationList || data?.data?.list || [];

  return (
    stations.find((s) => s.name && s.name.includes(STATION_NAME_FILTER)) ||
    stations[0] ||
    null
  );
}

// ================= COLLECTE ÉNERGIE =================
async function collectEnergy() {
  try {
    const station = await getStation();
    if (!station) {
      log("Collecte : aucune station trouvée");
      return;
    }

    const powerW = Number(station.generationPower ?? 0);
    const batterySoc = Number(station.batterySoc ?? 0);

    const now = Date.now();

    // Intégration trapézoïdale simple, avec garde-fou : si le serveur
    // était arrêté, on ne crédite pas tout le temps écoulé.
    let deltaHours = (now - lastTimestamp) / 3600000;
    const maxDelta = (currentPollInterval() * 1.5) / 3600000;
    if (deltaHours > maxDelta) deltaHours = maxDelta;

    if (powerW > 20 && deltaHours > 0) {
      addedEnergy += (powerW / 1000) * deltaHours;
    }

    lastTimestamp = now;
    const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

    db.prepare(
      "INSERT INTO energy_log(timestamp, power, energy) VALUES (?,?,?)"
    ).run(now, powerW, totalEnergy);

    lastReading = {
      station_name: station.name || "PPV Aéroclub ARC - LFPX",
      current_power_w: powerW,
      battery_soc: batterySoc,
      updated_at: now
    };

    // Mémorise l'ID de la station pour le recalage nocturne
    const sid = station.id ?? station.stationId;
    if (sid) kvSet("station_id", sid);

    // Persistance de l'état : un redémarrage ne perd plus rien
    kvSet("added_energy", addedEnergy);
    kvSet("last_timestamp", lastTimestamp);
    kvSet("last_reading", lastReading);
  } catch (e) {
    log("Collect error:", e.message);
  }
}

// ================= API TOTAL =================
// Sert le cache du poller : pas d'appel Solarman par requête HTTP,
// donc aucun risque de dépassement de quota même si la page du club
// est rafraîchie souvent.
app.get("/total", (req, res) => {
  // Le navigateur peut garder la réponse 60 s : encore moins de
  // requêtes vers Railway, et toujours zéro appel Solarman.
  res.set("Cache-Control", "public, max-age=60");

  const totalEnergy = BASE_TOTAL_KWH + addedEnergy;
  const stale =
    !lastReading.updated_at ||
    Date.now() - lastReading.updated_at > currentPollInterval() * 2;

  res.json({
    station_name: lastReading.station_name,
    current_power_w: lastReading.current_power_w,
    total_kwh: Number(totalEnergy.toFixed(2)),
    battery_soc: lastReading.battery_soc,
    updated_at: lastReading.updated_at,
    stale
  });
});

// ================= STATS JOUR =================
app.get("/stats/today", (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const row = db.prepare(`
    SELECT MIN(energy) AS start, MAX(energy) AS end
    FROM energy_log
    WHERE timestamp > ?
  `).get(start.getTime());

  res.json({
    today_kwh:
      row && row.end != null && row.start != null
        ? Number((row.end - row.start).toFixed(2))
        : 0
  });
});

// ================= HISTORIQUE JOURNALIER =================
// Production par jour sur N jours (défaut 7, max 90)
app.get("/stats/history", (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const since = Date.now() - days * 86400000;

  const rows = db.prepare(`
    SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS day,
           MAX(energy) - MIN(energy) AS kwh,
           MAX(power) AS peak_w
    FROM energy_log
    WHERE timestamp > ?
    GROUP BY day
    ORDER BY day
  `).all(since);

  res.json(
    rows.map((r) => ({
      day: r.day,
      kwh: Number((r.kwh || 0).toFixed(2)),
      peak_w: Number(r.peak_w || 0)
    }))
  );
});

// ================= ADMIN GUARD =================
// Seuls /total, /stats/* et /health sont publics (lecture du cache,
// aucun appel Solarman). Tout endpoint qui déclenche un appel API
// ou modifie l'état est protégé par ADMIN_TOKEN.
function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!ADMIN_TOKEN) {
    log(`⚠️ ${req.path} appelé sans ADMIN_TOKEN configuré !`);
  }
  next();
}

// ================= RESET (protégé) =================
app.get("/admin/reset", requireAdmin, (req, res) => {
  const value = parseFloat(req.query.value);
  if (isNaN(value)) {
    return res.status(400).json({ error: "Invalid value" });
  }

  BASE_TOTAL_KWH = value;
  addedEnergy = 0;
  lastTimestamp = Date.now();

  db.prepare("DELETE FROM energy_log").run();
  kvSet("base_total_kwh", BASE_TOTAL_KWH);
  kvSet("added_energy", 0);
  kvSet("last_timestamp", lastTimestamp);

  res.json({ status: "OK", new_base: value });
});

// ================= DEBUG (protégé — déclenche de vrais appels API) =================
app.get("/debug/raw", requireAdmin, async (req, res) => {
  try {
    const data = await apiPost("/station/v1.0/list", { page: 1, size: 50 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug/token", requireAdmin, async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({
      token_exists: !!token,
      token_preview: token ? token.substring(0, 20) + "..." : null,
      expires_at: tokenCache
        ? new Date(tokenCache.expiresAt).toISOString()
        : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Production totale officielle (2 appels API) + détail par année.
// À consulter AVANT déploiement pour décider de l'offset.
app.get("/debug/official", requireAdmin, async (req, res) => {
  try {
    const stationId = kvGet("station_id", null);
    if (!stationId) {
      return res.status(409).json({ error: "stationId inconnu — attendre une collecte" });
    }
    const official = await fetchOfficialTotal(stationId);
    res.json({
      ...official,
      manual_offset_kwh: Number(kvGet("manual_offset_kwh", 0)),
      displayed_total_if_recalibrated: official
        ? Number((official.total_kwh + Number(kvGet("manual_offset_kwh", 0))).toFixed(2))
        : null,
      current_displayed_total: Number((BASE_TOTAL_KWH + addedEnergy).toFixed(2)),
      last_recalibration: kvGet("last_recalibration", null)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quota d'appels API restant (doc Solarman §13 : /account/v1.0/balance)
app.get("/debug/quota", requireAdmin, async (req, res) => {
  try {
    const data = await apiPost("/account/v1.0/balance", {
      appId: process.env.SOLARMAN_API_ID
    });
    res.json({
      remaining_calls: data?.total ?? null,
      success: data?.success ?? false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Offset manuel ajouté au total officiel lors du recalage
// (ex : production antérieure à l'installation du data-logger)
app.get("/admin/offset", requireAdmin, (req, res) => {
  const value = parseFloat(req.query.value);
  if (isNaN(value)) {
    return res.json({ manual_offset_kwh: Number(kvGet("manual_offset_kwh", 0)) });
  }
  kvSet("manual_offset_kwh", value);
  res.json({ status: "OK", manual_offset_kwh: value });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, last_collect: lastReading.updated_at });
});

// ================= RECALAGE OFFICIEL (doc Solarman 4.1 + 4.3) =================
// Stratégie en 3 étapes :
//   1. /station/v1.0/base    → startOperatingTime (date de mise en service)
//   2. /station/v1.0/history → timeType 4 (dimension année), de l'année de
//      mise en service à l'année courante
//   3. Somme des generationValue = production totale MESURÉE par l'onduleur
// Exécuté 1x/nuit (2 appels API) : corrige la dérive de l'intégration locale.

function parisDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date()); // → "2026-06-11"
}

async function fetchOfficialTotal(stationId) {
  // Étape 1 : année de mise en service (pas de valeur codée en dur)
  const base = await apiPost("/station/v1.0/base", { stationId });
  let startYear = 2000; // repli large si le champ est absent
  let sot = Number(base?.startOperatingTime || 0);
  if (sot > 0) {
    if (sot > 1e12) sot = sot / 1000; // ms → s si nécessaire
    startYear = new Date(sot * 1000).getFullYear();
  }

  // Étape 2 : production annuelle depuis la mise en service
  const currentYear = new Date().getFullYear();
  const hist = await apiPost("/station/v1.0/history", {
    stationId,
    timeType: 4,
    startTime: String(startYear),
    endTime: String(currentYear)
  });

  const items = hist?.stationDataItems || [];
  if (!items.length) return null;

  // Étape 3 : somme
  const total = items.reduce(
    (sum, it) => sum + (Number(it.generationValue) || 0),
    0
  );

  return {
    total_kwh: Number(total.toFixed(2)),
    start_year: startYear,
    per_year: items.map((it) => ({
      year: it.year,
      kwh: Number((it.generationValue ?? 0).toFixed(2))
    }))
  };
}

async function recalibrate() {
  try {
    const stationId = kvGet("station_id", null);
    if (!stationId) {
      log("Recalage impossible : stationId inconnu (attendre une collecte)");
      return;
    }

    const official = await fetchOfficialTotal(stationId);
    if (!official || official.total_kwh <= 0) {
      log("Recalage ignoré : données history indisponibles");
      return;
    }

    // Offset manuel optionnel (ex : production antérieure au data-logger)
    const offset = Number(kvGet("manual_offset_kwh", 0));
    const newBase = official.total_kwh + offset;
    const drift = newBase - (BASE_TOTAL_KWH + addedEnergy);

    BASE_TOTAL_KWH = newBase;
    addedEnergy = 0;
    kvSet("base_total_kwh", BASE_TOTAL_KWH);
    kvSet("added_energy", 0);
    kvSet("last_recalibration", {
      day: parisDateString(),
      official_kwh: official.total_kwh,
      offset_kwh: offset,
      drift_corrected_kwh: Number(drift.toFixed(3))
    });

    log(
      `Recalage : officiel ${official.total_kwh} kWh + offset ${offset} kWh` +
      ` — dérive corrigée ${drift.toFixed(3)} kWh`
    );
  } catch (e) {
    log("Recalibrate error:", e.message);
  }
}


// Boucle auto-replanifiée : l'intervalle est recalculé après chaque
// collecte selon l'heure de Paris (jour 30 min / nuit 2 h).
async function pollLoop() {
  await collectEnergy();

  // Recalage officiel : 1x par nuit, entre 01h et 06h (heure de Paris),
  // quand la production est nulle et le compteur annuel figé.
  const h = parisHour();
  const today = parisDateString();
  if (h >= 1 && h < 6 && kvGet("last_recal_day") !== today) {
    await recalibrate();
    kvSet("last_recal_day", today);
  }

  const next = currentPollInterval();
  log(
    `Prochaine collecte dans ${next / 60000} min (${isNight() ? "nuit" : "jour"})`
  );
  setTimeout(pollLoop, next);
}
pollLoop(); // première collecte immédiate au démarrage

// ================= START SERVER =================
app.listen(PORT, () => {
  log(`✈️ ARC Solar API running on :${PORT} — jour 30 min / nuit 2 h (Paris)`);
});
