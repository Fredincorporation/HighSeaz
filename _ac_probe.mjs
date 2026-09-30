import { chromium } from "playwright-core";
const EXE = "C:\\Users\\fred\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--enable-webgl","--disable-gpu-sandbox","--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = []; page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
await page.goto("http://localhost:3000/", { waitUntil: "load", timeout: 60000 }).catch((e) => errors.push("NAV " + e.message));
await page.waitForTimeout(9000);
await page.screenshot({ path: "C:\\Users\\fred\\Documents\\GitHub\\HighSeaz\\_ac_shot.png", timeout: 120000, animations: "disabled" });
console.log("shot saved", errors.join("\n"));
await browser.close();
