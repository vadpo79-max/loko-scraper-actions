import fs from "fs/promises";

const SOURCE_URLS = [
  "https://r.jina.ai/https://www.fclm.ru/schedule/",
  "https://r.jina.ai/http://www.fclm.ru/schedule/"
];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOME_STADIUM = "РЖД Арена, Москва";

const EN_RU = new Map(Object.entries({
  "Lokomotiv":"Локомотив", "Akhmat":"Ахмат", "Akron":"Акрон", "Baltika":"Балтика",
  "Zenit":"Зенит", "Spartak":"Спартак", "Rubin":"Рубин", "Orenburg":"Оренбург",
  "Rostov":"Ростов", "Fakel":"Факел", "Krasnodar":"Краснодар", "Rodina":"Родина",
  "Krylia Sovetov":"Крылья Советов", "PFC CSKA":"ПФК ЦСКА", "CSKA":"ПФК ЦСКА",
  "Dinamo Mkh":"Динамо Мх", "Dynamo Makhachkala":"Динамо Мх",
  "Dynamo Moscow":"Динамо Москва", "Dinamo Moscow":"Динамо Москва"
}));

function toRu(s) { const x=(s||"").trim(); return EN_RU.get(x)||x; }
function cleanLine(raw) {
  let s=(raw||"").trim();
  if(!s) return "";
  if(/^!\[.*\]\(.*\)$/.test(s)) return "";
  if(/^\[?Image:/i.test(s)) return "";
  s=s.replace(/^\[([^\]]+)\]\([^)]*\)$/g,"$1");
  s=s.replace(/^#{1,6}\s*/,"").replace(/^[-*+]\s+/,"");
  s=s.replace(/^\*\*(.*?)\*\*$/,"$1").replace(/^__(.*?)__$/,"$1");
  return s.trim();
}
const isDate=s=>/^\d{1,2}\.\d{1,2}$/.test(s);
const isYear=s=>/^20\d{2}$/.test(s);
const isTime=s=>/^\d{1,2}:\d{2}(?:\s+[А-ЯA-Za-z]{2,3})?$/.test(s);
const isCompetition=s=>/(премьер-лига|кубок|rpl|russian cup|фонбет|fonbet|товарищ|friendlies|тур\s*\d+|day\s*\d+)/i.test(s);
const isNoise=s=>/^(матч-центр|match center|купить билеты|билеты|tickets|календарь игр|loko calendar)$/i.test(s)||/^https?:\/\//i.test(s)||/^\[.*\]:/.test(s);
function isTeamName(s){
  if(!s||isNoise(s)||isDate(s)||isTime(s)||isYear(s)||isCompetition(s))return false;
  if(/^vs$/i.test(s)||/^\d+\s*[:\-]\s*\d+$/.test(s))return false;
  return /[A-Za-zА-Яа-яЁё]/.test(s)&&s.length>=2&&s.length<=50;
}
function previousTeam(lines,from){for(let i=from-1;i>=0;i--)if(isTeamName(lines[i]))return toRu(lines[i]);return "";}
function nextTeam(lines,from){for(let i=from+1;i<lines.length;i++)if(isTeamName(lines[i]))return toRu(lines[i]);return "";}

function parseFixtures(text){
  const lines=text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const fixtures=[]; let currentYear=new Date().getUTCFullYear(); const now=Date.now();
  for(let i=0;i<lines.length;i++){
    if(isYear(lines[i])){currentYear=Number(lines[i]);continue;}
    if(!isDate(lines[i]))continue;
    const card=[];
    for(let j=i;j<lines.length;j++){
      if(j>i&&(isDate(lines[j])||isYear(lines[j])))break;
      card.push(lines[j]); if(card.length>=30)break;
    }
    const vsIndex=card.findIndex(x=>/^vs$/i.test(x)); if(vsIndex<0)continue;
    const timeLine=card.find(isTime); if(!timeLine)continue;
    const team1=previousTeam(card,vsIndex), team2=nextTeam(card,vsIndex); if(!team1||!team2)continue;
    const isLoko1=/локомотив|lokomotiv/i.test(team1), isLoko2=/локомотив|lokomotiv/i.test(team2); if(!isLoko1&&!isLoko2)continue;
    const [dd,mm]=card[0].split('.').map(Number); const tm=timeLine.match(/^(\d{1,2}):(\d{2})/); const hh=+tm[1],mi=+tm[2];
    const startUTC=new Date(Date.UTC(currentYear,mm-1,dd,hh,mi)-MSK_OFFSET_MS); if(startUTC.getTime()<=now)continue;
    const endUTC=new Date(startUTC.getTime()+2*60*60*1000);
    const competitionLine=card.find(isCompetition)||""; const roundMatch=competitionLine.match(/(Тур\s*\d+|Day\s*\d+)/i);
    const round=roundMatch?roundMatch[0].replace(/^Day/i,"Тур"):"";
    const competition=competitionLine.replace(roundMatch?.[0]||"","").replace(/[,.;:\-–—]+\s*$/,"").trim();
    const home=isLoko1, opponent=home?team2:team1;
    fixtures.push({title:home?`Локомотив — ${opponent}`:`${opponent} — Локомотив`,isHome:home,startISO:startUTC.toISOString(),endISO:endUTC.toISOString(),location:home?HOME_STADIUM:"",competition,round});
  }
  const unique=new Map(); for(const f of fixtures)unique.set(`${f.title}|${f.startISO}`,f);
  return [...unique.values()].sort((a,b)=>a.startISO.localeCompare(b.startISO));
}

async function fetchText(url){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),90000);
  try{const r=await fetch(url,{signal:controller.signal,headers:{"User-Agent":"loko-calendar/2.1","Accept":"text/plain,text/markdown;q=0.9,*/*;q=0.5"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.text();}finally{clearTimeout(timer);}
}

async function run(){
  let source="",sourceText="",fixtures=[]; const errors=[]; let lastText="";
  for(const url of SOURCE_URLS){
    try{const text=await fetchText(url);lastText=text;const parsed=parseFixtures(text);if(parsed.length){source=url;sourceText=text;fixtures=parsed;break;}errors.push(`${url}: parsed 0 fixtures, body=${text.length} chars`);}catch(e){errors.push(`${url}: ${e.message}`);}
  }
  await fs.writeFile("debug-schedule.txt",fixtures.length?`USED: ${source}\nFOUND: ${fixtures.length}\n---\n${sourceText.slice(0,20000)}\n`:`NO FIXTURES FOUND\n${errors.join("\n")}\n--- RAW READER ---\n${lastText.slice(0,20000)}\n`,"utf8");
  await fs.writeFile("debug-tickets.txt","Ticket scraping disabled: calendar no longer depends on ticket page.\n","utf8");
  if(!fixtures.length){console.error("No fixtures parsed; fixtures.json left unchanged");return;}
  const payload={generatedAt:new Date().toISOString(),source,count:fixtures.length,fixtures};
  await fs.writeFile("fixtures.json",JSON.stringify(payload,null,2),"utf8");
  console.log("WROTE fixtures.json with",fixtures.length,"records from",source);
}
run().catch(e=>{console.error(e);process.exit(1);});
