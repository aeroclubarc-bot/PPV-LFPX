// ================= REALTIME DATA (SOFAR) =================
async function getRealtimeData(token){

  if(!token) return { powerW:0, batterySoc:0 };

  try{

    const res = await fetch(`${BASE_URL}/device/v1.0/currentData`,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${token}`
      },
      body: JSON.stringify({
        deviceSn: process.env.SOLARMAN_DEVICE_SN
      })
    });

    const data = await res.json();

    const list = data?.dataList || [];

    let powerW = 0;
    let batterySoc = 0;

    list.forEach(item => {

      // puissance inverter réelle
      if(item.key === "P_INV1"){
        powerW = Number(item.value);
      }

      // SOC batterie
      if(item.key === "B_left_cap1"){
        batterySoc = Number(item.value);
      }

    });

    return { powerW, batterySoc };

  }catch(e){
    console.log("Realtime data error");
    return { powerW:0, batterySoc:0 };
  }
}
