import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, ".build", "ext-msg2");
fs.rmSync(EXT, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });

fs.writeFileSync(
  path.join(EXT, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "msg-probe2",
      version: "1.0",
      permissions: ["storage", "declarativeNetRequest"],
      host_permissions: ["http://localhost/*"],
      background: { service_worker: "bg.js" },
      content_scripts: [{ matches: ["http://localhost/*"], js: ["cs.js"], run_at: "document_idle" }]
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(EXT, "bg.js"),
  `chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.op !== "install") return;
  chrome.declarativeNetRequest
    .updateDynamicRules({ removeRuleIds: [1], addRules: [msg.rule] })
    .then(function () { return chrome.declarativeNetRequest.getDynamicRules(); })
    .then(function (rules) { sendResponse({ ok: rules.length > 0, n: rules.length, rule: rules[0] || null }); })
    .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});
`
);
fs.writeFileSync(
  path.join(EXT, "cs.js"),
  `var b = document.createElement("button");
b.id = "probe-install";
b.textContent = "install";
b.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
b.addEventListener("click", function () {
  var rule = JSON.parse(document.documentElement.getAttribute("data-rule"));
  chrome.runtime.sendMessage({ op: "install", rule: rule }, function (res) {
    document.body.setAttribute("data-result", JSON.stringify({ res: res || null, err: (chrome.runtime.lastError && chrome.runtime.lastError.message) || null }));
  });
});
document.documentElement.appendChild(b);
`
);

const srv = http.createServer((req, res) => {
  if (/\.ts/.test(req.url)) {
    res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    return res.end(/muted/.test(req.url) ? "MUTED" : "ORIGINAL");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<p>probe2</p>");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
const BASE = `http://localhost:${PORT}`;
const PFX = `${BASE}/videos/2926037201/`;
const BS = String.fromCharCode(92);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-msg2"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(`${BASE}/x`);

const rt = ["media", "xmlhttprequest", "other"];
const variants = [
  {
    name: "A regex+regexSubstitution (as in the extension)",
    rule: {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: PFX + BS + "1." + BS + "2" + BS + "3" } },
      condition: { regexFilter: "^" + escRe(PFX) + "(.*)-muted" + BS + ".(ts|m4s|mp4)" + "(.*)$", resourceTypes: rt }
    }
  },
  {
    name: "B urlFilter+redirect.url",
    rule: {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { url: PFX + "801.ts" } },
      condition: { urlFilter: PFX + "801-muted.ts", resourceTypes: rt }
    }
  },
  {
    name: "C regexFilter+redirect.url",
    rule: {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { url: PFX + "802.ts" } },
      condition: { regexFilter: escRe(PFX) + "802-muted" + BS + ".ts", resourceTypes: rt }
    }
  },
  {
    name: "D minimal regex substitution",
    rule: {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: PFX + BS + "1.ts" } },
      condition: { regexFilter: escRe(PFX) + "(" + BS + "d+)-muted" + BS + ".ts", resourceTypes: rt }
    }
  },
  {
    name: "E substitution without anchors, absolute",
    rule: {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: BASE + "/x/" + BS + "1.ts" } },
      condition: { regexFilter: "(" + BS + "d+)-muted" + BS + ".ts", resourceTypes: rt }
    }
  }
];

for (const v of variants) {
  await page.evaluate((rule) => {
    document.documentElement.setAttribute("data-rule", JSON.stringify(rule));
    document.body.removeAttribute("data-result");
  }, v.rule);
  await page.click("#probe-install");
  let out = null;
  for (let i = 0; i < 50 && !out; i++) {
    out = await page.evaluate(() => document.body.getAttribute("data-result"));
    if (!out) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`[${v.name}]`, out);
  if (String(out).includes('"ok":true')) {
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u);
      return { url: new URL(res.url).pathname, body: await res.text() };
    }, `${PFX}805-muted.ts`);
    console.log("   fetch after install:", JSON.stringify(r));
  }
}

/* the cold case: install, let the worker sleep 40 s, then use the rule */
await new Promise((r) => setTimeout(r, 40000));
const cold = await page.evaluate(async (u) => {
  const res = await fetch(u);
  return { url: new URL(res.url).pathname, body: await res.text() };
}, `${PFX}806-muted.ts`);
console.log("[after 40 s sleep] fetch:", JSON.stringify(cold));

await browser.close();
srv.close();
