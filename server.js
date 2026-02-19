const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();

app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  next();
});

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://globalapi.solarmanpv.com";


// ================= BASE RECALÉE =================
let BASE_TOTAL_KWH = 6645.0;


// ================= DATABASE =================
const db = new Database("/data/solar.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS energy_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 timestamp INTEGER,
 power REAL,
 energy REAL
)
`).run();

let addedEnergy = 0;
let lastTimestamp = Date.now();


// ================= UTILS =================
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


// ================= TOKEN =================
async function getAccessToken(){

  try{
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
    return extractToken(data);

  }catch(e){
    console.log("Token error");
    return null;
  }
}


// ================= STATION =================
async function getStation(token){

  if(!token) return null;

  try{
    const res = await fetch(`${BASE_URL}/station/v1.0/list`,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${token}`
      },
      body: JSON.stringify({pageNum:1,pageSize:10})
    });

    const data = await res.json();
    return data?.data?.list?.[0] || null;

  }catch(e){
    console.log("Station fetch error");
    return null;
  }
}


// ================= COLLECT ENERGY (30 MIN) =================
async function collectEnergy(){

  try{

    const token = await getAccessToken();
    const station = await getStation(token);

    const powerW = Number(station?.generationPower ?? 0);

    const now = Date.now();
    const deltaHours = (now - lastTimestamp)/3600000;

    if(powerW > 20){
      addedEnergy += (powerW/1000)*deltaHours;
    }

    lastTimestamp = now;

    const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

    db.prepare(`
      INSERT INTO energy_log(timestamp,power,energy)
      VALUES (?,?,?)
    `).run(now,powerW,totalEnergy);

  }catch(e){
    console.log("Collect error");
  }
}


// ================= API TOTAL (LIVE POWER) =================
app.get("/total", async (req,res)=>{

  let station = null;
  let powerW = 0;
  let batterySoc = 0;

  try{

    const token = await getAccessToken();
    station = await getStation(token);

    // ✅ lecture LIVE — comme le code qui marchait
    powerW = Number(station?.generationPower ?? 0);
    batterySoc = Number(station?.batterySoc ?? 0);

  }catch(e){
    console.log("Live read error");
  }

  const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

  res.json({
    station_name: station?.name || "PPV Aéroclub ARC - LFPX",
    current_power_w: powerW,
    total_kwh: Number(totalEnergy.toFixed(2)),
    battery_soc: batterySoc
  });
});


// ================= STATS JOUR =================
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


// ================= RESET COMPTEUR =================
app.get("/admin/reset",(req,res)=>{

  const value = parseFloat(req.query.value);

  if(isNaN(value)){
    return res.status(400).json({error:"Invalid value"});
  }

  BASE_TOTAL_KWH = value;
  addedEnergy = 0;

  db.prepare("DELETE FROM energy_log").run();

  res.json({
    status:"OK",
    new_base:value
  });
});


// ================= UPDATE AUTO 30 MIN =================
setInterval(async ()=>{
  await collectEnergy();
},1800000);


app.listen(PORT,()=>{
  console.log("✈️ ARC Solar API running — LIVE POWER RESTORED");
});
