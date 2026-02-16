const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://globalapi.solarmanpv.com";
const BASE_TOTAL_KWH = 6517.50;

// ---------- DATABASE
const db = new Database("/data/solar.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS energy_log (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER,
  power REAL,
  energy REAL
)
`).run();

let addedEnergy = 0;
let lastTimestamp = Date.now();

function sha256Lower(str) {
  return crypto.createHash("sha256").update(str).digest("hex").toLowerCase();
}

function extractToken(data) {
  return data?.access_token || data?.data?.access_token || null;
}

// ---------- TOKEN
async function getAccessToken() {
  const res = await fetch(
    `${BASE_URL}/account/v1.0/token?appId=${process.env.SOLARMAN_API_ID}&language=en`,
    {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        email: process.env.SOLARMAN_USERNAME,
        password: sha256Lower(process.env.SOLARMAN_PASSWORD),
        appSecret: process.env.SOLARMAN_API_SECRET
      })
    }
  );

  const data = await res.json();
  return extractToken(data);
}

// ---------- STATION
async function getStation(token){
  const res = await fetch(`${BASE_URL}/station/v1.0/list`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:`Bearer ${token}`
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
app.get("/total", async(req,res)=>{

  try {

    const token = await getAccessToken();
    const station = await getStation(token);

    const powerW = Number(station?.generationPower ?? 0);

    const now = Date.now();
    const deltaHours = (now-lastTimestamp)/3600000;

    if (powerW > 50) {
      addedEnergy += (powerW/1000)*deltaHours;
    }

    lastTimestamp = now;

    const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

    // sauvegarde historique
    db.prepare(`
      INSERT INTO energy_log(timestamp,power,energy)
      VALUES (?,?,?)
    `).run(now,powerW,totalEnergy);

    res.json({
      station_name: station.name,
      current_power_w: powerW,
      total_kwh: Number(totalEnergy.toFixed(2)),
      battery_soc: station.batterySoc
    });

  } catch(e){
    res.status(500).json({error:e.message});
  }
});


// ---------- STATS JOUR
app.get("/stats/today",(req,res)=>{

  const start = new Date();
  start.setHours(0,0,0,0);

  const row = db.prepare(`
    SELECT MIN(energy) as start,
           MAX(energy) as end
    FROM energy_log
    WHERE timestamp > ?
  `).get(start.getTime());

  res.json({
    today_kwh: row.end && row.start
      ? Number((row.end-row.start).toFixed(2))
      : 0
  });
});

app.listen(PORT, ()=>{
  console.log("ARC Solar API running with history");
});
