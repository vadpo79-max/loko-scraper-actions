import fs from "fs/promises";
import { chromium } from "playwright";

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

function uniqBy(arr, keyFn) {
  const m = new Map();
  arr.forEach(x => m.set(keyFn(x), x));
  return [...m.values()];
}

function parseFixturesFromLines(lines) {
  const now = new Date();
  const yearNow = now.getFullYear();
  const out = [];

  for (const L of lines) {
    const dateM = L.match(/\b(\d{1,2})\.(\d{1,2})\b/);
    const timeM = L.match(/\b(\d{1,2}):(\d{2})\b/);
    const teamsM = L.match(/(.+?)\s*(?:vs|—|-|:)\s*(.+)/i);
    if (!dateM || !timeM || !teamsM) continue;

    const dd = +dateM[1], mm = +dateM[2];
    const hh = +timeM[1], mi = +timeM[2];

    const A = teamsM[1].trim(), B = teamsM[2].trim();
    const isHome = /локомотив/i.test(A) && !/локомотив/i.test(B);
    const isAway = /локомотив/i.test(B) && !/локомотив/i.test(A);
    if (!isHome && !isAway) continue;

    // простая эвристика перехода через Новый год
    const year = (mm === 1 && now.getMonth() === 11) ? yearNow + 1 : yearNow;

    const start = new Date(year, mm - 1, dd, hh, mi);
    const end = new Date(start.getTime() + 2 * 3600 * 1000);
    if (start <= now) continue;

    out.push({
      title: isHome ? `Локомотив — ${B}` : `${A} — Локомотив`,
      isHome,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      location: isHome ? "РЖД Арена, Москва" : ""
    });
  }

  return uniqBy(out, e => e.title + "|" + e.startISO);
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
      await page.waitForTimeout(1500);
      return true;
    } catch (_) {
      await page.waitForTimeout(2000 * attempt);
    }
  }
  return false;
}

async function acceptCookiesIfAny(page) {
  const candidates = [
    'button:has-text("Согласен")',
    'button:has-text("Принять")',
    'button:has-text("Accept")',
    '[data-accept="Y"]',
    '.cookie-accept, .cookies-accept'
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel);
    if (await btn.first().isVisible().catch(()=>false)) {
      await btn.first().click({ timeout: 2000 }).catch(()=>{});
      await page.waitForTimeout(500);
    }
  }
}

async function waitForScheduleText(page) {
  // ждём, пока в body появится дата и слово Локомотив
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').replace(/\s+/g,' ');
    return /\d{1,2}\.\d{1,2}/.test(t) && /Локомотив/i.test(t);
  }, { timeout: 20000 }).catch(()=>{});
}

async function grabLinesFrom(page) {
  const txt = await page.locator("body").innerText().catch(()=>"");
  return txt.split("\n").map(s => s.trim()).filter(Boolean);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1366, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  // немного шумоподавления
  await context.route(/\.(?:png|jpg|jpeg|gif|webp|svg|woff2?)$/i, r => r.abort());
  await context.route(/googletagmanager|google-analytics|yandex|metric|facebook|vk\.com/i, r => r.abort());

  let scheduleLines = [];
  let usedScheduleUrl = "";
  let lastHtmlSample = "";

  for (const url of CANDIDATE_SCHEDULE_URLS) {
    const page = await context.newPage();
    if (await gotoWithRetry(page, url)) {
      await acceptCookiesIfAny(page);
      await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r=>setTimeout(r,1200)); });
      await waitForScheduleText(page);
      scheduleLines = await grabLinesFrom(page);
      lastHtmlSample = (await page.content()).slice(0, 2000); // на случай полной пустоты
      const score = scheduleLines.filter(l => /\d{1,2}\.\d{1,2}/.test(l) && /Локомотив/i.test(l)).length;
      if (score > 0) { usedScheduleUrl = url; await page.close(); break; }
    }
    await page.close();
  }

  // Диагностика
  if (!scheduleLines.length) {
    await fs.writeFile("debug-schedule.txt",
      `NO LINES FOUND from:\n${CANDIDATE_SCHEDULE_URLS.join("\n")}\n\nHTML SAMPLE:\n${lastHtmlSample}\n`,
      "utf8");
  } else {
    const sample = scheduleLines.slice(0, 80).join("\n");
    await fs.writeFile("debug-schedule.txt", `USED: ${usedScheduleUrl}\n---\n${sample}\n`, "utf8");
  }

  // TICKETS (домашние)
  let ticketBlocks = [];
  let usedTicketsUrl = "";
  for (const url of TICKETS_URLS) {
    const page = await context.newPage();
    if (await gotoWithRetry(page, url)) {
      await acceptCookiesIfAny(page);
      const links = page.locator("a");
      const count = await links.count();
      const blocks = [];
      for (let i = 0; i < count; i++) {
        const el = links.nth(i);
        const txt = (await el.innerText().catch(()=>"")).trim();
        if (!/(купить билеты|Купить билеты|Купить|Билеты)/i.test(txt)) continue;
        const hrefRaw = await el.getAttribute("href");
        const href = hrefRaw ? (hrefRaw.startsWith("http") ? hrefRaw : new URL(hrefRaw, "https://www.fclm.ru").toString()) : "";
        const block = await el.evaluate((a) => {
          let node = a;
          for (let j=0; j<6 && node && node.parentElement; j++) {
            node = node.parentElement;
            if ((node.innerText || "").trim().length > 40) break;
          }
          return (node?.innerText || a.innerText || "").trim();
        });
        if (href) blocks.push({ href, blockText: block });
      }
      if (blocks.length) { ticketBlocks = blocks; usedTicketsUrl = url; await page.close(); break; }
    }
    await page.close();
  }
  await fs.writeFile("debug-tickets.txt",
    ticketBlocks.length ? `USED: ${usedTicketsUrl}\n---\n${ticketBlocks.slice(0,20).map(b=>b.blockText).join("\n---\n")}\n`
                        : `NO TICKETS FOUND from:\n${TICKETS_URLS.join("\n")}\n`, "utf8");

  await context.close();
  await browser.close();

  // Парсинг
  let fixtures = parseFixturesFromLines(scheduleLines);

  // Fallback: если расписание пустое, но на билетах есть карточки,
  // создадим хотя бы домашние матчи из билетов (без выездных)
  if (fixtures.length === 0 && ticketBlocks.length > 0) {
    const homeFromTickets = parseFixturesFromLines(
      ticketBlocks.map(b => b.blockText) // в блоках обычно есть "ДД.ММ ЧЧ:ММ Локомотив — ..."
    ).filter(x => x.isHome);
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
