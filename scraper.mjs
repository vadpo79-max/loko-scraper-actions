import fs from "fs/promises";
import { chromium } from "playwright";

function uniqBy(arr, keyFn) {
  const m = new Map();
  arr.forEach(x => m.set(keyFn(x), x));
  return [...m.values()];
}

function parseFixturesFromLines(lines) {
  const year = new Date().getFullYear();
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

    const start = new Date(year, mm - 1, dd, hh, mi);
    const end = new Date(start.getTime() + 2 * 3600 * 1000);

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

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "ru-RU"
  });

  // Календарь
  const page = await context.newPage();
  await context.route(/\.(?:png|jpg|jpeg|gif|webp|svg|woff2?)$/i, route => route.abort());
await context.route(/googletagmanager|google-analytics|yandex|metric|facebook|vk\.com/i, route => route.abort());

  //await page.goto("https://www.fclm.ru/schedule/", { waitUntil: "networkidle" });
  //await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 800)); });
  // helper: мягкая навигация с ретраями
async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 120000 }); // 120 cек
      // небольшая пауза чтобы дорисовался контент
      await page.waitForTimeout(2000);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      await page.waitForTimeout(2000 * attempt); // backoff
    }
  }
}

// перед навигацией добавим пару анти‑бот штрихов
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

await gotoWithRetry(page, "https://www.fclm.ru/schedule/");

// проскроллить вниз (ленивая подгрузка)
await page.evaluate(async () => {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 1200));
});


  const scheduleLines = (await page.locator("body").innerText())
    .split("\n").map(s => s.trim()).filter(Boolean);

  // Билеты
  const page2 = await context.newPage();
 // await page2.goto("https://www.fclm.ru/tickets/", { waitUntil: "networkidle" });
  await gotoWithRetry(page2, "https://www.fclm.ru/tickets/");


  const links = page2.locator("a");
  const count = await links.count();
  const ticketBlocks = [];
  for (let i = 0; i < count; i++) {
    const el = links.nth(i);
    const txt = (await el.innerText().catch(()=>"")).trim();
    if (!/(купить билеты|Купить билеты|Купить|Билеты)/i.test(txt)) continue;
    const href = await el.getAttribute("href");
    // поднимаемся вверх, чтобы поймать текст карточки
    const block = await el.evaluate((a) => {
      let node = a;
      for (let i=0; i<6 && node && node.parentElement; i++) {
        node = node.parentElement;
        if ((node.innerText || "").trim().length > 40) break;
      }
      return (node?.innerText || a.innerText || "").trim();
    });
    if (href) ticketBlocks.push({ href: href.startsWith("http") ? href : new URL(href, "https://www.fclm.ru").toString(), blockText: block });
  }

  await browser.close();

  // Парсинг
  const fixtures = parseFixturesFromLines(scheduleLines);
  const tmap = buildTicketMap(ticketBlocks);

  fixtures.forEach(f => {
    if (!f.isHome) return;
    const d = new Date(f.startISO);
    const key = `home:${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${f.title.replace(/^Локомотив — /,'').toLowerCase()}`;
    if (tmap.has(key)) f.ticketUrl = tmap.get(key);
  });

  // Пишем fixtures.json в корень
  const payload = { generatedAt: new Date().toISOString(), count: fixtures.length, fixtures };
  await fs.writeFile("fixtures.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("WROTE fixtures.json with", fixtures.length, "records");
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
