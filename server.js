const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://globalapi.solarmanpv.com";

// ✅ POINT OFFICIEL ARC (synchronisation réelle)
const BASE_TOTAL_KWH = 6637.6;


// ---------- CORS
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Origin, X-Requested-With, Content-Type, Accept");
  next();
});


// ---------- DATABASE (Railway volume)
const db = new Database("/data/solar.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS energy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  power REAL,
  energy REAL
)
`).run();


// ---------- UTILS
function sha256Lower(str){
  return crypto.createHash("sha256")
    .update(str)
    .digest("hex")
    .toLowerCase();
}

function extractToken(data){
  return data?.access_token ||
         data?.data?.access_token ||
         null;
}


// ---------- TOKEN SOLARMAN
async function getAccessToken(){

  const res = await fetch(
    `${BASE_URL}/account/v1.0/token?appId=${process.env.SOLARMAN_API_ID}&language=en`,
    {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
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


// ---------- DEVICE DATA (ONDULEUR)
async function getDeviceData(token, stationId){

  const res = await fetch(`${BASE_URL}/device/v1.0/currentData`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:`Bearer ${token}`
    },
    body: JSON.stringify({ stationId })
  });

  const data = await res.json();

  return data?.data || {};
}


// ---------- COLLECTE RÉELLE
async function collectEnergy(){

  const token = await getAccessToken();
  const station = await getStation(token);
  const device = await getDeviceData(token, station.id);

  const list = device?.dataList || [];

  // ✅ puissance PV réelle panneaux
  const powerItem =
    list.find(d => d.key === "DPi_t1") || // PV DC input
    list.find(d => d.key === "P_INV1");   // fallback

  const powerW = Number(powerItem?.value || 0);

  // ✅ compteur cumulatif réel onduleur
  const energyItem = list.find(d => d.key === "Et_ge0");

  let totalEnergy = Number(energyItem?.value || 0);

  // sécurité anti-retour arrière
  if(!totalEnergy || totalEnergy < BASE_TOTAL_KWH){
    totalEnergy = BASE_TOTAL_KWH;
  }

  const now = Date.now();

  db.prepare(`
    INSERT INTO energy_log(timestamp,power,energy)
    VALUES (?,?,?)
  `).run(now, powerW, totalEnergy);

  return {
    station,
    powerW,
    totalEnergy
  };
}


// ---------- API TOTAL
app.get("/total", async(req,res)=>{

  try{

    const result = await collectEnergy();

    res.json({
      station_name: result.station.name,
      current_power_w: result.powerW,
      total_kwh: Number(result.totalEnergy.toFixed(1)),
      battery_soc: result.station.batterySoc
    });

  }catch(e){
    res.status(500).json({error:e.message});
  }
});


// ---------- PRODUCTION DU JOUR
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

  const rows = db.prepare(`
    SELECT timestamp, power
    FROM energy_log
    WHERE timestamp > ?
    ORDER BY timestamp ASC
  `).all(start.getTime());

  res.json(rows);
});


// ---------- RESET SÉCURISÉ
app.get("/reset",(req,res)=>{

  if(req.query.key !== process.env.ADMIN_KEY){
    return res.status(403).json({error:"Forbidden"});
  }

  db.prepare("DELETE FROM energy_log").run();

  res.json({
    status:"OK",
    message:"Historique réinitialisé ✅"
  });
});


// ---------- COLLECTE AUTO (60 s)
setInterval(async ()=>{
  try{
    await collectEnergy();
  }catch(e){
    console.log("Collect error:",e.message);
  }
},60000);


app.listen(PORT,()=>{
  console.log("✈️ ARC Solar API running — synchronized at 6637.6 kWh");
});
