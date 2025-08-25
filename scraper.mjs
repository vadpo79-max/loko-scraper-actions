import fs from "fs/promises";
import puppeteer from "puppeteer";

const CANDIDATE_SCHEDULE_URLS = [
  "https://www.fclm.ru/schedule/",
  "https://www.fclm.ru/en/schedule/",
  "https://www.fclm.ru/schedule/?print=Y",
  "https://www.fclm.ru/en/schedule/?print=Y"
];
const TICKETS_URLS = [
  "https://www.fclm.ru/tickets/",
  "https://www.fclm.ru/en/tickets/schedule/"
];

// --- utils ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function uniqBy(arr, keyFn) {
  const m = new Map();
  arr.forEach(x => m.set(keyFn(x), x));
  return [...m.values()];
}

function parseFixturesFromLines(lines) {
  const now = new Date();
  const yearNow = now.getFullYear();
  const out = [];

  const isLoko = s => /локомотив|lokomotiv/i.test(s);
  const isScore = s => /^\s*\d+\s*[:\-]\s*\d+\s*$/.test(s);
  const isTime = s => /\b\d{1,2}:\d{2}\b/.test(s);
  const isDate = s => /\b\d{1,2}\.\d{1,2}\b/.test(s);
  const isWeekday = s => /\b(MON|TUE|WED|THU|FRI|SAT|SUN|ПН|ВТ|СР|ЧТ|ПТ|СБ|ВС|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(s);
  const isNoise = s => /match center|friendlies|турнир|table|video|photo|tickets|купить|билеты/i.test(s);

  // эвристика выбора лучшего кандидата-соперника из нескольких строк вокруг
  function pickOpponent(cands) {
    const cleaned = cands
      .map(s => (s || '').trim())
      .filter(Boolean)
      .filter(s => !isLoko(s) && !isScore(s) && !isTime(s) && !isWeekday(s) && !isNoise(s))
      .filter(s => /[A-Za-zА-Яа-яЁё]/.test(s))      // должны быть буквы
      .filter(s => s.length >= 2 && s.length <= 40); // разумная длина

    // если несколько — берём ближайшую к "Локо", предпочтительно слово с заглавной буквы/слова (имя клуба)
    cleaned.sort((a, b) => {
      const cap = x => /^[A-ZА-ЯЁ]/.test(x) ? -1 : 0;
      return cap(a) - cap(b) || a.length - b.length;
    });
    return cleaned[0] || '';
  }

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const mDate = isDate(L) ? L.match(/(\d{1,2})\.(\d{1,2})/) : null;
    if (!mDate) continue;

    // время ищем в той же строке или в следующих двух
    const lookTime = [L, lines[i+1] || '', lines[i+2] || ''].join(' ');
    const mTime = lookTime.match(/(\d{1,2}):(\d{2})/);
    if (!mTime) continue;

    const dd = +mDate[1], mm = +mDate[2];
    const hh = +mTime[1], mi = +mTime[2];

    // ищем блок с «Локо» поблизости
    let idxLoko = -1;
    for (let j = i; j < Math.min(lines.length, i + 14); j++) {
      if (isLoko(lines[j] || '')) { idxLoko = j; break; }
    }
    if (idxLoko === -1) continue;

    // возможные строки соперника — вокруг «Локо»
    const candidates = [
      lines[idxLoko-3], lines[idxLoko-2], lines[idxLoko-1],
      lines[idxLoko+1], lines[idxLoko+2], lines[idxLoko+3], lines[idxLoko+4]
    ];

    const oppName = pickOpponent(candidates);
    if (!oppName) continue;

    // Дом/выезд: если «Локо» идёт до соперника в карточке — считаем домашним
    const isHome = true; // на карточках с календаря часто порядок «Локо» затем соперник; оставим домашним.
    // (если нужно точнее — можно дополнительно проверять соседние блоки)

    // переход года (декабрь → январь)
    const year = (mm === 1 && now.getMonth() === 11) ? yearNow + 1 : yearNow;
    const start = new Date(year, mm - 1, dd, hh, mi);
    if (start <= now) continue; // только будущие
    const end = new Date(start.getTime() + 2*3600*1000);

    const title = isHome ? `Локомотив — ${oppName}` : `${oppName} — Локомотив`;

    out.push({
      title,
      isHome,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      location: isHome ? "РЖД Арена, Москва" : ""
    });
  }

  // убрать дубли (title+start)
  const key = e => e.title + '|' + e.startISO;
  return [...new Map(out.map(e => [key(e), e])).values()];
}



function buildTicketMap(blocks) {
  const map = new Map();
  for (const b of blocks) {
    const oppM  = b.blockText.match(/Локомотив\s*(?:vs|—|-|:)\s*([A-Za-zА-Яа-яёЁ0-9.\- ]+)/i);
    const dateM = b.blockText.match(/\b(\d{1,2})\.(\d{1,2})\b/);
    const timeM = b.blockText.match(/\b(\d{1,2}):(\d{2})\b/);
    if (!oppM || !dateM || !timeM) continue;

    const opp = oppM[1].trim().replace(/\s+/g," ").toLowerCase();
    const dd = String(dateM[1]).padStart(2,"0");
    const mm = String(dateM[2]).padStart(2,"0");
    const hh = String(timeM[1]).padStart(2,"0");
    const mi = String(timeM[2]).padStart(2,"0");
    const key = `home:${mm}-${dd} ${hh}:${mi} ${opp}`;
    map.set(key, b.href);
  }
  return map;
}

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 120000 });
      await sleep(1500);
      return true;
    } catch (_) {
      await sleep(2000 * attempt);
    }
  }
  return false;
}

async function acceptCookiesIfAny(page) {
  // ищем любую кнопку с текстом Согласен/Принять/Accept
  try {
    await page.evaluate(() => {
      const texts = ["Согласен","Принять","Accept"];
      const btn = [...document.querySelectorAll('button, [role="button"], .btn, .button')]
        .find(b => texts.some(t => (b.innerText||"").includes(t)));
      if (btn) btn.click();
    });
    await sleep(500);
  } catch {}
}

async function bodyLines(page) {
  const txt = await page.evaluate(() => (document.body.innerText || ''));
  return txt.split('\n').map(s => s.trim()).filter(Boolean);
}

// --- main ---
async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  });

  // --- календарь ---
  let scheduleLines = [];
  let usedScheduleUrl = "";
  let htmlSample = "";

  for (const url of CANDIDATE_SCHEDULE_URLS) {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari");
    await page.setExtraHTTPHeaders({ "Accept-Language": "ru,en;q=0.9" });

    if (await gotoWithRetry(page, url)) {
      await acceptCookiesIfAny(page);
      await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); });
      await sleep(1200);

      // ждём, пока появится дата и «Локомотив»
      try {
        await page.waitForFunction(() => {
          const t = (document.body.innerText || '').replace(/\s+/g,' ');
          return /\d{1,2}\.\d{1,2}/.test(t) && /Локомотив/i.test(t);
        }, { timeout: 20000 });
      } catch {}

      scheduleLines = await bodyLines(page);
      htmlSample = (await page.content()).slice(0, 2000);
      const score = scheduleLines.filter(l => /\d{1,2}\.\d{1,2}/.test(l) && /Локомотив/i.test(l)).length;
      if (score > 0) { usedScheduleUrl = url; await page.close(); break; }
    }
    await page.close();
  }

  if (!scheduleLines.length) {
    await fs.writeFile("debug-schedule.txt",
      `NO LINES FOUND from:\n${CANDIDATE_SCHEDULE_URLS.join("\n")}\n\nHTML SAMPLE:\n${htmlSample}\n`, "utf8");
  } else {
    await fs.writeFile("debug-schedule.txt", `USED: ${usedScheduleUrl}\n---\n${scheduleLines.slice(0,80).join("\n")}\n`, "utf8");
  }

  // --- билеты ---
  let ticketBlocks = [];
  let usedTicketsUrl = "";
  for (const url of TICKETS_URLS) {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari");
    await page.setExtraHTTPHeaders({ "Accept-Language": "ru,en;q=0.9" });

    if (await gotoWithRetry(page, url)) {
      await acceptCookiesIfAny(page);
      const blocks = await page.evaluate(() => {
        const out = [];
        const links = Array.from(document.querySelectorAll("a"));
        for (const a of links) {
          const txt = (a.innerText || "").trim();
          if (!/(купить билеты|Купить билеты|Купить|Билеты)/i.test(txt)) continue;
          let node = a;
          for (let j=0; j<6 && node && node.parentElement; j++) {
            node = node.parentElement;
            if ((node.innerText || "").trim().length > 40) break;
          }
          out.push({ href: a.href, blockText: (node?.innerText || a.innerText || "").trim() });
        }
        return out;
      });
      if (blocks.length) { ticketBlocks = blocks; usedTicketsUrl = url; await page.close(); break; }
    }
    await page.close();
  }

  await fs.writeFile("debug-tickets.txt",
    ticketBlocks.length ? `USED: ${usedTicketsUrl}\n---\n${ticketBlocks.slice(0,20).map(b=>b.blockText).join("\n---\n")}\n`
                        : `NO TICKETS FOUND from:\n${TICKETS_URLS.join("\n")}\n`, "utf8");

  await browser.close();

  // --- парсинг + fallback ---
  let fixtures = parseFixturesFromLines(scheduleLines);
  if (fixtures.length === 0 && ticketBlocks.length > 0) {
    const homeFromTickets = parseFixturesFromLines(ticketBlocks.map(b => b.blockText)).filter(x => x.isHome);
    fixtures = homeFromTickets;
  }

  const tmap = buildTicketMap(ticketBlocks);
  fixtures.forEach(f => {
    if (!f.isHome) return;
    const d = new Date(f.startISO);
    const key = `home:${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${f.title.replace(/^Локомотив — /,'').toLowerCase()}`;
    if (tmap.has(key)) f.ticketUrl = tmap.get(key);
  });

  const payload = { generatedAt: new Date().toISOString(), count: fixtures.length, fixtures };
  await fs.writeFile("fixtures.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("WROTE fixtures.json with", fixtures.length, "records");
}

run().catch(e => { console.error(e); process.exit(1); });
