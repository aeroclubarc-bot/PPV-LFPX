const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL="https://globalapi.solarmanpv.com";
const BASE_TOTAL_KWH=6637.6;


// ---------- CORS
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  next();
});


// ---------- DB
const db=new Database("/data/solar.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS energy_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 timestamp INTEGER,
 power REAL,
 energy REAL
)`).run();


// ---------- CACHE
let cached=null;
let lastUpdate=0;
const CACHE_MS=30000;


// ---------- UTILS
function sha256Lower(str){
 return crypto.createHash("sha256")
   .update(str)
   .digest("hex")
   .toLowerCase();
}

function extractToken(d){
 return d?.access_token||d?.data?.access_token||null;
}

function getValue(list,key){
 const i=list.find(x=>x.key===key);
 return i?Number(String(i.value).replace(",", ".")):null;
}


// ---------- TOKEN
async function getAccessToken(){

 const r=await fetch(
 `${BASE_URL}/account/v1.0/token?appId=${process.env.SOLARMAN_API_ID}&language=en`,
 {
   method:"POST",
   headers:{ "Content-Type":"application/json"},
   body:JSON.stringify({
     email:process.env.SOLARMAN_USERNAME,
     password:sha256Lower(process.env.SOLARMAN_PASSWORD),
     appSecret:process.env.SOLARMAN_API_SECRET
   })
 });

 const data=await r.json();
 const token=extractToken(data);
 if(!token) throw new Error("Token failed");
 return token;
}


// ---------- STATION
async function getStation(token){

 const r=await fetch(`${BASE_URL}/station/v1.0/list`,{
   method:"POST",
   headers:{
     "Content-Type":"application/json",
     Authorization:`Bearer ${token}`
   },
   body:JSON.stringify({pageNum:1,pageSize:10})
 });

 const data=await r.json();
 return data?.data?.list?.[0]||data?.stationList?.[0];
}


// ---------- DEVICE LIVE
async function getDevice(token,stationId){

 const r=await fetch(`${BASE_URL}/device/v1.0/currentData`,{
   method:"POST",
   headers:{
     "Content-Type":"application/json",
     Authorization:`Bearer ${token}`
   },
   body:JSON.stringify({stationId})
 });

 const data=await r.json();
 return data?.data?.dataList||[];
}


// ---------- COLLECTE HYBRIDE
async function collectEnergy(){

 const token=await getAccessToken();
 const station=await getStation(token);

 let powerW=Number(station.generationPower||0);

 // ⚡ fallback inverter si station = 0
 if(powerW<50){

   const list=await getDevice(token,station.id);

   powerW =
     getValue(list,"DPi_t1") ??
     getValue(list,"P_INV1") ??
     0;
 }

 let totalEnergy=
   Number(station.totalEnergy||
          station.totalYield||
          BASE_TOTAL_KWH);

 if(totalEnergy<BASE_TOTAL_KWH)
   totalEnergy=BASE_TOTAL_KWH;

 const now=Date.now();

 db.prepare(`
 INSERT INTO energy_log(timestamp,power,energy)
 VALUES (?,?,?)
 `).run(now,powerW,totalEnergy);

 return {station,powerW,totalEnergy};
}


// ---------- API
app.get("/total",async(req,res)=>{

 try{

   const now=Date.now();

   if(cached&&(now-lastUpdate)<CACHE_MS)
     return res.json(cached);

   const r=await collectEnergy();

   cached={
     station_name:r.station.name,
     current_power_w:r.powerW,
     total_kwh:Number(r.totalEnergy.toFixed(1)),
     battery_soc:r.station.batterySoc
   };

   lastUpdate=now;

   res.json(cached);

 }catch(e){
   res.status(500).json({error:e.message});
 }
});


// ---------- RESET
app.get("/reset",(req,res)=>{
 if(req.query.key!==process.env.ADMIN_KEY)
   return res.status(403).json({error:"Forbidden"});

 db.prepare("DELETE FROM energy_log").run();
 res.json({status:"OK"});
});


// ---------- AUTO COLLECT
setInterval(async()=>{
 try{await collectEnergy();}
 catch(e){console.log(e.message);}
},60000);


app.listen(PORT,()=>{
 console.log("✈️ ARC Solar API — HYBRID POWER MODE");
});
