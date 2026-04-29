// Drive the Airplane UI as a real user would, end-to-end, in headless Chrome.
// Run via: bun run .qa/ui-test.ts
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync } from "node:fs";

const SHOTS = ".qa/shots";
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.AIRPLANE_BASE || "http://localhost:4242";
const REPO = process.env.AIRPLANE_REPO || "uitest";

function step(name: string) {
  process.stdout.write(`\n--- ${name} ---\n`);
}
function ok(msg: string) {
  process.stdout.write(`  ✓ ${msg}\n`);
}
function fail(msg: string): never {
  process.stdout.write(`  ✗ ${msg}\n`);
  process.exit(1);
}

async function shot(page: any, name: string) {
  const path = `${SHOTS}/${name}.png`;
  try {
    await page.screenshot({ path, fullPage: false, captureBeyondViewport: false, timeout: 30_000 });
    process.stdout.write(`     [screenshot ${path}]\n`);
  } catch (e: any) {
    process.stdout.write(`     [screenshot SKIPPED: ${e?.message ?? e}]\n`);
  }
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox"],
  protocolTimeout: 180_000,
});
const page = await browser.newPage();
const VIEW = process.env.VIEW || "phone";
if (VIEW === "desktop") {
  await page.setViewport({ width: 1280, height: 900 });
} else {
  await page.setViewport({ width: 414, height: 896 }); // phone-ish
}
process.stdout.write(`viewport: ${VIEW}\n`);

const consoleErrs: string[] = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrs.push(msg.text());
});
page.on("pageerror", (err) => consoleErrs.push("PAGEERROR: " + err.message));
page.on("requestfailed", (req) => consoleErrs.push(`REQFAIL ${req.method()} ${req.url()}: ${req.failure()?.errorText}`));
page.on("response", (resp) => {
  if (resp.status() >= 400 && !resp.url().endsWith("favicon.ico")) {
    consoleErrs.push(`HTTP ${resp.status()} ${resp.url()}`);
  }
});

step("load /");
const resp = await page.goto(BASE, { waitUntil: "networkidle0" });
if (!resp || resp.status() !== 200) fail(`/ returned ${resp?.status()}`);
ok("HTTP 200");
await shot(page, "01-initial-chat");
const title = await page.title();
if (title !== "Airplane") fail(`title=${title}`);
ok(`title="${title}"`);

step("status pill shows N repos");
const status = await page.$eval("#status", (el) => el.textContent);
if (!/\d+ repo/.test(status || "")) fail(`status="${status}"`);
ok(`status: ${status}`);

step("repo dropdown populated");
const opts = await page.$$eval("#chat-repo option", (els) => els.map((e) => (e as HTMLOptionElement).value));
if (!opts.includes(REPO)) fail(`#chat-repo missing ${REPO}: ${JSON.stringify(opts)}`);
ok(`options: ${JSON.stringify(opts)}`);

step("nav: switch to issues");
await page.click('nav button[data-view="issues"]');
await page.waitForFunction(() => (document.querySelector("#issues") as HTMLElement)?.classList.contains("active"));
// wait for /issues fetch to render
await new Promise((r) => setTimeout(r, 1500));
const issuesTxt = await page.$eval("#issues-list", (el) => el.textContent || "");
ok(`#issues-list: ${issuesTxt.slice(0, 80).replace(/\s+/g, " ")}…`);
await shot(page, "02-issues");

step("nav: switch to controls, render per-repo");
await page.click('nav button[data-view="controls"]');
await page.waitForFunction(() => (document.querySelector("#controls") as HTMLElement)?.classList.contains("active"));
await new Promise((r) => setTimeout(r, 800));
const ctrlText = await page.$eval("#repo-controls", (el) => el.textContent || "");
if (!ctrlText.includes(REPO)) fail(`#repo-controls missing ${REPO}: ${ctrlText}`);
ok(`controls list: ${ctrlText.replace(/\s+/g, " ").slice(0, 100)}`);
await shot(page, "03-controls");

step("global pause via UI button");
await page.click("#pause-global");
await new Promise((r) => setTimeout(r, 800));
const r1 = await fetch(`${BASE}/repos`).then((r) => r.json());
if (!r1.paused) fail("server still says paused=false after clicking pause");
ok("server reports paused=true");
await page.click("#resume-global");
await new Promise((r) => setTimeout(r, 600));
const r2 = await fetch(`${BASE}/repos`).then((r) => r.json());
if (r2.paused) fail("paused never reset");
ok("server reports paused=false after resume");

step("nav: activity (log SSE)");
await page.click('nav button[data-view="activity"]');
await page.waitForFunction(() => (document.querySelector("#activity") as HTMLElement)?.classList.contains("active"));
// wait until we see at least one log line streamed in
await page.waitForFunction(
  () => ((document.querySelector("#log-stream") as HTMLElement)?.textContent || "").length > 20,
  { timeout: 15000 }
);
const logTxt = await page.$eval("#log-stream", (el) => el.textContent || "");
ok(`log stream got ${logTxt.split("\n").length} lines`);
await shot(page, "04-log");

step("chat: send a message via SSE");
await page.click('nav button[data-view="chat"]');
await page.waitForFunction(() => (document.querySelector("#chat") as HTMLElement)?.classList.contains("active"));
await page.select("#chat-repo", REPO);
const msg = "Create a small issue: rename hello.ts to greet.ts. Acceptance: file is renamed, README updated. Trivial change.";
await page.type("#chat-msg", msg);
await shot(page, "05-chat-typed");
// Submit and wait for SSE chunks to stream into #chat-stream.
await page.click('button[type="submit"]');
await page.waitForFunction(
  () => ((document.querySelector("#chat-stream") as HTMLElement)?.textContent || "").length > 30,
  { timeout: 60_000 }
);
ok("chat-stream began receiving");
// Wait until either the EventSource closes (chunkCount stops growing) or 4 minutes.
const final = await page.evaluate(() => {
  return new Promise<string>((resolve) => {
    let last = "";
    let stable = 0;
    const t = setInterval(() => {
      const cur = (document.querySelector("#chat-stream") as HTMLElement)?.textContent || "";
      if (cur === last) {
        stable++;
        if (stable >= 6) {
          clearInterval(t);
          resolve(cur);
        }
      } else {
        last = cur;
        stable = 0;
      }
    }, 2000);
    setTimeout(() => {
      clearInterval(t);
      resolve(last);
    }, 240_000);
  });
});
ok(`final chat output (${final.length} chars):\n${final.slice(0, 500)}…`);
await shot(page, "06-chat-final");

const issueUrlMatch = /https:\/\/github\.com\/[^\s"']+\/issues\/(\d+)/.exec(final);
if (!issueUrlMatch) fail(`no issue URL in chat output`);
const issueUrl = issueUrlMatch[0];
const issueNum = parseInt(issueUrlMatch[1]!, 10);
ok(`chat created ${issueUrl}`);
writeFileSync(".qa/last-issue.json", JSON.stringify({ url: issueUrl, num: issueNum }));

step("nav back to issues — should now include the new issue");
await page.click('nav button[data-view="issues"]');
await new Promise((r) => setTimeout(r, 500));
await page.click("#refresh-issues");
// /issues serially calls gh per repo per label; can take several seconds.
// Poll the DOM until the issue appears or 30s.
await page.waitForFunction(
  (n: number) => ((document.querySelector("#issues-list") as HTMLElement)?.textContent || "").includes(`#${n}`),
  { timeout: 30_000 },
  issueNum
);
const issues2 = await page.$eval("#issues-list", (el) => el.textContent || "");
if (!issues2.includes(`#${issueNum}`)) fail(`issues list does not include #${issueNum}: ${issues2}`);
ok(`issues list now includes #${issueNum}`);
await shot(page, "07-issues-after-chat");

step("console errors");
if (consoleErrs.length) {
  for (const e of consoleErrs) process.stdout.write("  ! " + e + "\n");
  fail(`${consoleErrs.length} console errors`);
}
ok("no console errors");

await browser.close();
process.stdout.write("\nALL UI CHECKS PASSED\n");
