// Walks through passkey sign-in in Chromium with a virtual passkey, against a demo started with
// `DEMO_PASSKEY=1 demo`: setup, staying signed in on reload, sign-out, sign-in, a session that ends
// mid-use, and a browser without the passkey. Exits non-zero on the first step that fails. With an
// out dir, also saves screenshots of the screens it passes.
//
//   CHROME=/path/to/chromium node demo/passkey-check.mjs [url] [screenshot dir]
import puppeteer from "puppeteer-core";

const [,, base = "http://localhost:18080", shots] = process.argv;
if (!process.env.CHROME) throw new Error("Set CHROME to a Chromium binary, e.g. $(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium");
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--font-render-hinting=none"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh browser profile with its own virtual passkey device (Face ID that always succeeds). */
async function device({ width = 1440, height = 900, scheme = "light" } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }]);
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, cdp, authenticatorId };
}

/** The sign-in screen's title, or "Tally" for the app, once `selector` is on screen. */
async function heading(page, selector = ".signin-card h1, .sb .brand") {
  await page.waitForSelector(selector);
  return page.$eval(".signin-card h1, .sb .brand", (e) => e.textContent);
}
async function clickText(page, selector, text) {
  for (const el of await page.$$(selector)) {
    if ((await el.evaluate((e) => e.textContent)).includes(text)) return el.click();
  }
  throw new Error(`no ${selector} containing ${text}`);
}
async function shot(page, name) {
  if (!shots) return;
  await page.mouse.move(0, 0); // no hover tooltips
  await sleep(400);
  await page.screenshot({ path: `${shots}/${name}.png` });
  console.log(`  ${shots}/${name}.png`);
}
function expect(what, actual, wanted) {
  if (actual !== wanted) throw new Error(`${what}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  console.log(`ok  ${what}`);
}

try {
  const phone = await device();
  const { page } = phone;
  await page.goto(`${base}/?month=2026-11`, { waitUntil: "networkidle0" });
  expect("a new Tally asks for a passkey", await heading(page), "Set Up a Passkey");
  await shot(page, "setup");

  await clickText(page, "button", "Create Passkey");
  await page.waitForSelector(".ytable");
  expect("creating it opens the app", await heading(page), "Tally");
  const { credentials } = await phone.cdp.send("WebAuthn.getCredentials", { authenticatorId: phone.authenticatorId });
  expect("the passkey is saved on the device", credentials.length, 1);
  await shot(page, "signed-in");

  await page.reload({ waitUntil: "networkidle0" });
  expect("a reload stays signed in", await heading(page), "Tally");

  await clickText(page, ".sb button", "Sign Out");
  expect("signing out shows the sign-in screen", await heading(page, ".signin-card h1"), "Sign In to Tally");
  await page.reload({ waitUntil: "networkidle0" });
  expect("and a reload stays signed out", await heading(page), "Sign In to Tally");
  await shot(page, "sign-in");
  await clickText(page, "button", "Sign In with Passkey");
  await page.waitForSelector(".ytable");
  expect("the passkey signs back in", await heading(page), "Tally");

  // The session ends while the app is open: the next API call brings up the sign-in screen.
  await page.deleteCookie({ name: "tally_session", url: base });
  await clickText(page, ".sb a", "Transactions");
  expect("an ended session shows the sign-in screen", await heading(page, ".signin-card h1"), "Sign In to Tally");

  // Another browser, whose device has no passkey for Tally.
  const stranger = await device();
  await stranger.page.goto(base, { waitUntil: "networkidle0" });
  expect("another browser must sign in", await heading(stranger.page), "Sign In to Tally");
  await clickText(stranger.page, "button", "Sign In with Passkey");
  await stranger.page.waitForSelector(".signin-card .error-text", { timeout: 15_000 });
  expect("a device without the passkey can't", await heading(stranger.page), "Sign In to Tally");
  const refused = await stranger.page.evaluate(() =>
    fetch("/finance.AccountService/ListAccounts", { method: "POST", headers: { "Content-Type": "application/grpc-web+proto" }, body: new Uint8Array(5) })
      .then((r) => r.headers.get("grpc-status")),
  );
  expect("the API refuses it (gRPC unauthenticated)", refused, "16");

  if (shots) {
    for (const [name, opts] of [["sign-in-dark", { scheme: "dark" }], ["sign-in-phone", { width: 390, height: 844, scheme: "dark" }]]) {
      const d = await device(opts);
      await d.page.goto(`${base}/?month=2026-11`, { waitUntil: "networkidle0" });
      await heading(d.page);
      await shot(d.page, name);
    }
  }
  console.log("passkey sign-in works");
} finally {
  await browser.close();
}
