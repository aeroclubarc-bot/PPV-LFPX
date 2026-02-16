const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://globalapi.solarmanpv.com";
const BASE_TOTAL_KWH = 6517.50;

let addedEnergy = 0;
let lastTimestamp = Date.now();

function sha256Lower(str) {
  return crypto.createHash("sha256").update(str).digest("hex").toLowerCase();
}

function extractToken(data) {
  return data?.access_token || data?.data?.access_token || null;
}

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

app.get("/total", async(req,res)=>{

  try {

    const token = await getAccessToken();
    const station = await getStation(token);

    const powerW = Number(station?.generationPower ?? 0);

    const now = Date.now();
    const deltaHours = (now-lastTimestamp)/3600000;

    addedEnergy += (powerW/1000)*deltaHours;
    lastTimestamp = now;

    const totalEnergy = BASE_TOTAL_KWH + addedEnergy;

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

app.listen(PORT, ()=>{
  console.log("ARC Solar API running");
});
