const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
// ---- CORS (autorise Webflow)
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Origin, X-Requested-With, Content-Type, Accept");
  next();
});
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://globalapi.solarmanpv.com";
const BASE_TOTAL_KWH = 6505.05; // calibration réelle ARC

// ---------- DATABASE (volume Railway)
const db = new Database("/data/solar.db");

db.prepare(
CREATE TABLE IF NOT EXISTS energy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  power REAL,
  energy REAL
)
).run();

let addedEnergy = 0;
let lastTimestamp = Date.now();

// ---------- UTILS
function sha256Lower(str) {
  return crypto.createHash("sha256")
    .update(str)
    .digest("hex")
    .toLowerCase();
}

function extractToken(data) {
  return data?.access_token ||
         data?.data?.access_token ||
         null;
}

// ---------- TOKEN SOLARMAN
async function getAccessToken() {

  const res = await fetch(
    ${BASE_URL}/account/v1.0/token?appId=${process.env.SOLARMAN_API_ID}&language=en,
    {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        email: process.env.SOLARMAN_USERNAME,
        password: sha256Lower(process.env.SOLARMAN_PASSWORD),
        appSecret: process.env.SOLARMAN_API_SECRET
      })
    }
  );

  const data = await res.json();
  const token = extractToken(data);

  if(!token) throw new Error("Token failed");

  return token;
}

// ---------- STATION
async function getStation(token){

  const res = await fetch(${BASE_URL}/station/v1.0/list,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:Bearer ${token}
    },
    body: JSON.stringify({pageNum:1,pageSize:10})
  });

  const data = await res.json();

  return (
    data?.data?.list?.[0] ||
    data?.stationList?.[0]
  );
}

// ---------- TOTAL LIVE
async function collectEnergy(){

  const token = await getAccessToken();
  const station = await getStation(token);

  const powerW = Number(station?.generationPower ?? 0);

  const now = Date.now();
  const deltaHours = (now - lastTimestamp) / 3600000;

  // ignore nuit / bruit capteur
  if (powerW > 50) {
    addedEnergy += (powerW / 1000) * deltaHours;
  }

  lastTimestamp = now;

  const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

// enregistre seulement si production ou toutes les 10 min
if (powerW > 20 || now % 600000 < 60000) {
  db.prepare(
    INSERT INTO energy_log(timestamp,power,energy)
    VALUES (?,?,?)
  ).run(now, powerW, totalEnergy);
};

  return {
    station,
    powerW,
    totalEnergy
  };
}

app.get("/total", async(req,res)=>{

  try {

    const result = await collectEnergy();

    res.json({
      station_name: result.station.name,
      current_power_w: result.powerW,
      total_kwh: Number(result.totalEnergy.toFixed(2)),
      battery_soc: result.station.batterySoc
    });

  } catch(e){
    res.status(500).json({error:e.message});
  }
});

// ---------- STATS JOUR
app.get("/stats/today",(req,res)=>{

  const start = new Date();
  start.setHours(0,0,0,0);

  const row = db.prepare(
    SELECT MIN(energy) as start,
           MAX(energy) as end
    FROM energy_log
    WHERE timestamp > ?
  ).get(start.getTime());

  res.json({
    today_kwh:
      row.end && row.start
        ? Number((row.end - row.start).toFixed(2))
        : 0
  });
});

// ---------- COURBE JOURNALIÈRE
app.get("/stats/day-curve",(req,res)=>{

  const start = new Date();
  start.setHours(0,0,0,0);

  const rows = db.prepare(
    SELECT timestamp, power
    FROM energy_log
    WHERE timestamp > ?
    ORDER BY timestamp ASC
  ).all(start.getTime());

  res.json(rows);
});

// ---------- COLLECTE AUTO (toutes les 60s)
setInterval(async ()=>{
  try {
    await collectEnergy();
  } catch(e){
    console.log("Collect error:", e.message);
  }
}, 60000);

app.listen(PORT, ()=>{
  console.log("✈️ ARC Solar API running with persistent history");
});
