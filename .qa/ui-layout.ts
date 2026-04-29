// Lightweight layout-only check across viewports. No chat call.
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const SHOTS = ".qa/shots";
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.AIRPLANE_BASE || "http://localhost:4242";

async function check(viewport: { w: number; h: number; name: string }) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], protocolTimeout: 60_000 });
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.w, height: viewport.h });
  const errs: string[] = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) errs.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  process.stdout.write(`\n[${viewport.name} ${viewport.w}x${viewport.h}]\n`);
  for (const view of ["chat", "issues", "controls", "activity"] as const) {
    await page.click(`nav button[data-view="${view}"]`);
    await new Promise((r) => setTimeout(r, 500));
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const probs: string[] = [];
      for (const el of document.querySelectorAll("header, nav, .chat-form, .card, button, select, input")) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.right > w + 1) {
          probs.push(`overflow: ${(el as HTMLElement).tagName}.${(el as HTMLElement).className} right=${r.right.toFixed(0)} > vw=${w}`);
        }
      }
      return probs;
    });
    const path = `${SHOTS}/layout-${viewport.name}-${view}.png`;
    await page.screenshot({ path, fullPage: false, captureBeyondViewport: false });
    if (overflow.length) {
      process.stdout.write(`  ✗ ${view}: ${overflow.length} overflow issue(s)\n`);
      for (const o of overflow) process.stdout.write(`     - ${o}\n`);
    } else {
      process.stdout.write(`  ✓ ${view}: no overflow [${path}]\n`);
    }
  }
  if (errs.length) {
    process.stdout.write(`  ✗ ${errs.length} console errors\n`);
    for (const e of errs) process.stdout.write(`     - ${e}\n`);
  }
  await browser.close();
  return errs.length === 0;
}

const ok =
  (await check({ w: 414, h: 896, name: "phone" })) &&
  (await check({ w: 768, h: 1024, name: "tablet" })) &&
  (await check({ w: 1280, h: 900, name: "desktop" }));

if (!ok) process.exit(1);
process.stdout.write("\nALL LAYOUT CHECKS PASSED\n");
