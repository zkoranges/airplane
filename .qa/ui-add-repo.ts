// Drives the new "Add repo" form end-to-end as a real user.
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const SHOTS = ".qa/shots";
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.AIRPLANE_BASE || "http://localhost:4242";
const ADD_PATH = process.env.ADD_PATH || "/tmp/airplane-ui-test/airplane-uitest-1777070360";

function ok(m: string) { process.stdout.write(`  ✓ ${m}\n`); }
function fail(m: string): never { process.stdout.write(`  ✗ ${m}\n`); process.exit(1); }
function step(m: string) { process.stdout.write(`\n--- ${m} ---\n`); }

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox"],
  protocolTimeout: 120_000,
});
const page = await browser.newPage();
await page.setViewport({ width: 414, height: 896 });
const errs: string[] = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // Chrome logs "Failed to load resource" for any 4xx fetch — that includes
  // the deliberate bad-path probe. Skip these; the response listener already
  // gates real failures.
  if (/Failed to load resource: the server responded with a status of 400/.test(t)) return;
  errs.push(t);
});
page.on("pageerror", (e) => errs.push(e.message));
page.on("dialog", async (d) => { await d.accept(); });
page.on("response", (r) => {
  // 400s on POST /repos are expected during the deliberate bad-path test.
  if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) {
    if (r.status() === 400 && r.url().endsWith("/repos") && r.request().method() === "POST") return;
    errs.push(`HTTP ${r.status()} ${r.url()}`);
  }
});

step("load and switch to controls");
await page.goto(BASE, { waitUntil: "networkidle0" });
await page.click('nav button[data-view="controls"]');
await page.waitForSelector("#add-repo-form");
ok("controls + add form rendered");
await page.screenshot({ path: `${SHOTS}/add-01-empty.png`, fullPage: false });

step("type a bad path, submit, expect error");
await page.type("#add-repo-path", "/this/does/not/exist");
await page.click('#add-repo-form button[type="submit"]');
await page.waitForFunction(
  () => /✗/.test((document.querySelector("#add-repo-msg") as HTMLElement)?.textContent || ""),
  { timeout: 8_000 }
);
const errMsg = await page.$eval("#add-repo-msg", (el) => el.textContent);
ok(`error shown: ${errMsg}`);
await page.screenshot({ path: `${SHOTS}/add-02-error.png`, fullPage: false });

step("clear, type a real path, submit, expect repo to appear");
await page.evaluate(() => { (document.querySelector("#add-repo-path") as HTMLInputElement).value = ""; });
await page.type("#add-repo-path", ADD_PATH);
await page.click('#add-repo-form button[type="submit"]');
await page.waitForFunction(
  () => /✓/.test((document.querySelector("#add-repo-msg") as HTMLElement)?.textContent || ""),
  { timeout: 15_000 }
);
const okMsg = await page.$eval("#add-repo-msg", (el) => el.textContent);
ok(`success: ${okMsg}`);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${SHOTS}/add-03-added.png`, fullPage: false });

step("verify repo appears in #repo-controls with UI tag and Remove button");
const cards = await page.$eval("#repo-controls", (el) => el.textContent || "");
if (!cards.includes("airplane-uitest")) fail(`controls list missing repo: ${cards}`);
if (!/UI/.test(cards)) fail(`expected UI source tag: ${cards}`);
if (!/remove/.test(cards)) fail(`expected remove button: ${cards}`);
ok(`controls show repo + UI tag + remove`);

step("verify dropdown has it on Chat too");
await page.click('nav button[data-view="chat"]');
await new Promise((r) => setTimeout(r, 500));
const opts = await page.$$eval("#chat-repo option", (els) => els.map((e) => (e as HTMLOptionElement).value));
if (!opts.length) fail("chat repo dropdown empty");
ok(`chat dropdown options: ${JSON.stringify(opts)}`);
const banner = await page.$eval("#repo-info", (el) => el.textContent || "");
if (!/path/.test(banner) || !/origin/.test(banner)) fail(`banner missing details: ${banner}`);
ok(`banner: ${banner.replace(/\s+/g, " ").slice(0, 100)}…`);
await page.screenshot({ path: `${SHOTS}/add-04-chat-banner.png`, fullPage: false });

step("remove via UI, verify it disappears");
await page.click('nav button[data-view="controls"]');
await page.waitForSelector("button[data-act='remove']");
// click via evaluate so we don't race against re-renders detaching the node.
await page.evaluate(() => {
  (document.querySelector("button[data-act='remove']") as HTMLButtonElement).click();
});
// the page's confirm() is auto-accepted by the dialog handler above.
await page.waitForFunction(
  () => !((document.querySelector("#repo-controls") as HTMLElement)?.textContent || "").includes("airplane-uitest"),
  { timeout: 8_000 }
);
const cardsAfter = await page.$eval("#repo-controls", (el) => el.textContent || "");
if (cardsAfter.includes("airplane-uitest")) fail(`repo still listed after remove: ${cardsAfter}`);
ok("repo removed from list");
await page.screenshot({ path: `${SHOTS}/add-05-removed.png`, fullPage: false });

step("console errors");
if (errs.length) { for (const e of errs) process.stdout.write("  ! " + e + "\n"); fail(`${errs.length} errors`); }
ok("no console errors");

await browser.close();
process.stdout.write("\nADD-REPO UI FLOW PASSED\n");
