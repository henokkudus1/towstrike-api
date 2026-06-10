const https = require('https');

const http = require('http');

const PORT = process.env.PORT || 3000;

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || '';

const CORS_HEADERS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};

function httpsGet(url) {

  return new Promise((resolve) => {

    const urlObj = new URL(url);

    const req = https.request({hostname:urlObj.hostname,path:urlObj.pathname+urlObj.search,method:'GET',headers:{'User-Agent':'TowStrike/1.0'}},(res)=>{

      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(body)});}catch(e){resolve({status:res.statusCode,data:null});}});

    });

    req.on('error',(e)=>resolve({status:0,data:null}));

    req.setTimeout(10000,()=>{req.destroy();resolve({status:0,data:null});});

    req.end();

  });

}

function getBboxes(lat,lon,radiusMiles){

  const R=3958.8;

  const degLat=(radiusMiles/R)*(180/Math.PI);

  const degLon=(radiusMiles/R)*(180/Math.PI)/Math.cos(lat*Math.PI/180);

  let gridSize=radiusMiles<=55?2:radiusMiles<=110?3:radiusMiles<=165?4:5;

  const boxes=[];const stepLat=(degLat*2)/gridSize;const stepLon=(degLon*2)/gridSize;

  const minLat=lat-degLat;const minLon=lon-degLon;

  for(let r=0;r<gridSize;r++){for(let c=0;c<gridSize;c++){

    const bMinLat=minLat+r*stepLat;const bMaxLat=bMinLat+stepLat;

    const bMinLon=minLon+c*stepLon;const bMaxLon=bMinLon+stepLon;

    boxes.push({name:`Grid ${r},${c}`,bbox:`${bMinLon.toFixed(4)},${bMinLat.toFixed(4)},${bMaxLon.toFixed(4)},${bMaxLat.toFixed(4)}`});

  }}

  return boxes;

}

async function getTomTom(lat,lon,radiusMiles){

  if(!TOMTOM_KEY)return[];

  const boxes=getBboxes(lat,lon,radiusMiles);

  const fields=encodeURIComponent('{incidents{type,geometry{type,coordinates},properties{id,iconCategory,startTime,from,to,roadNumbers,events{description}}}}');

  const types={0:'Incident',1:'Accident',2:'Weather Hazard',3:'Hazard',4:'Weather Hazard',5:'Hazard',6:'Congestion',7:'Lane Closure',8:'Road Closure',9:'Construction',10:'Weather Hazard',11:'Hazard',14:'Disabled Vehicle'};

  const allIncidents=[];const seenIds=new Set();

  for(const box of boxes){

    try{

      const url=`https://api.tomtom.com/traffic/services/5/incidentDetails?key=${TOMTOM_KEY}&bbox=${box.bbox}&fields=${fields}&language=en-US&timeValidityFilter=present`;

      const result=await httpsGet(url);

      if(result.status!==200||!result.data?.incidents)continue;

      result.data.incidents.forEach((inc,i)=>{

        const p=inc.properties||{};const id='tt-'+(p.id||box.name+i);

        if(seenIds.has(id))return;seenIds.add(id);

        const coords=inc.geometry?.coordinates||[];let iLat=0,iLon=0;

        if(inc.geometry?.type==='Point'){iLon=coords[0];iLat=coords[1];}

        else if(inc.geometry?.type==='LineString'&&coords.length){iLon=coords[0][0];iLat=coords[0][1];}

        if(iLat===0||isNaN(iLat))return;

        allIncidents.push({id,source:'TomTom',type:types[p.iconCategory]||'Incident',description:(p.events||[]).map(e=>e.description).filter(Boolean).join('. '),lat:iLat,lon:iLon,location:[(p.roadNumbers||[]).join(', '),p.from,p.to].filter(Boolean).join(' to ')||'Local area',direction:'',reported:p.startTime||new Date().toISOString()});

      });

    }catch(e){console.log(box.name,'error:',e.message);}

  }

  return allIncidents;

}

const server=http.createServer(async(req,res)=>{

  if(req.method==='OPTIONS'){res.writeHead(204,CORS_HEADERS);res.end();return;}

  const url=new URL(req.url,`http://localhost:${PORT}`);

  if(url.pathname==='/health'){res.writeHead(200,{...CORS_HEADERS,'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',tomtom:!!TOMTOM_KEY}));return;}

  if(url.pathname==='/incidents'){

    const lat=parseFloat(url.searchParams.get('lat'))||42.2411;

    const lon=parseFloat(url.searchParams.get('lon'))||-83.6130;

    const radius=parseInt(url.searchParams.get('radius'))||150;

    const incidents=await getTomTom(lat,lon,radius);

    res.writeHead(200,{...CORS_HEADERS,'Content-Type':'application/json'});

    res.end(JSON.stringify({incidents,sources:{tomtom:incidents.length,total:incidents.length,isLive:incidents.length>0},location:{lat,lon,radius},fetchedAt:new Date().toISOString()}));

    return;

  }

  res.writeHead(404,{...CORS_HEADERS,'Content-Type':'application/json'});

  res.end(JSON.stringify({error:'Not found'}));

});

server.listen(PORT,()=>console.log(`TowStrike API running on port ${PORT} — Nationwide location-based coverage enabled`));
