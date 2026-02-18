const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://globalapi.solarmanpv.com";
const BASE_TOTAL_KWH = 6637.6;


// ---------- CORS
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Origin, X-Requested-With, Content-Type, Accept");
  next();
});


// ---------- DATABASE
const db = new Database("/data/solar.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS energy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  power REAL,
  energy REAL
)
`).run();


// ---------- CACHE MÉMOIRE
let cachedData = null;
let lastUpdate = 0;
const CACHE_DURATION = 30000; // 30 sec


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

function getValue(list,key){
  const item = list.find(d=>d.key===key);
  if(!item) return null;
  return Number(String(item.value).replace(",","."));
}


// ---------- TOKEN
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

  return data?.data?.list?.[0] || data?.stationList?.[0];
}


// ---------- DEVICE DATA
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


// ---------- COLLECTE
async function collectEnergy(){

  const token = await getAccessToken();
  const station = await getStation(token);
  const device = await getDeviceData(token, station.id);

  const list = device?.dataList || [];

  // ✅ PUISSANCE RÉELLE INJECTÉE (SOFAR)
  let powerW =
      getValue(list,"PG_Pt1") ??   // puissance AC réelle
      getValue(list,"DPi_t1") ??   // fallback DC
      getValue(list,"P_INV1") ??   // fallback inverter
      0;

  if(powerW < 5) powerW = 0; // filtre bruit API

  // ✅ COMPTEUR TOTAL RÉEL
  let totalEnergy =
      getValue(list,"Et_ge0") || BASE_TOTAL_KWH;

  if(totalEnergy < BASE_TOTAL_KWH){
    totalEnergy = BASE_TOTAL_KWH;
  }

  const now = Date.now();

  db.prepare(`
    INSERT INTO energy_log(timestamp,power,energy)
    VALUES (?,?,?)
  `).run(now,powerW,totalEnergy);

  return { station, powerW, totalEnergy };
}


// ---------- API TOTAL (CACHE)
app.get("/total", async(req,res)=>{

  try{

    const now = Date.now();

    if(cachedData && (now-lastUpdate)<CACHE_DURATION){
      return res.json(cachedData);
    }

    const result = await collectEnergy();

    cachedData = {
      station_name: result.station.name,
      current_power_w: result.powerW,
      total_kwh: Number(result.totalEnergy.toFixed(1)),
      battery_soc: result.station.batterySoc
    };

    lastUpdate = now;

    res.json(cachedData);

  }catch(e){
    res.status(500).json({error:e.message});
  }
});


// ---------- PRODUCTION JOUR
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
        ? Number((row.end-row.start).toFixed(2))
        : 0
  });
});


// ---------- COURBE JOUR
app.get("/stats/day-curve",(req,res)=>{

  const start = new Date();
  start.setHours(0,0,0,0);

  const rows = db.prepare(`
    SELECT timestamp,power
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

  res.json({status:"OK"});
});


// ---------- COLLECTE AUTO
setInterval(async ()=>{
  try{ await collectEnergy(); }
  catch(e){ console.log("Collect error:",e.message); }
},60000);


app.listen(PORT,()=>{
  console.log("✈️ ARC Solar API running — REAL PV POWER ENABLED");
});
