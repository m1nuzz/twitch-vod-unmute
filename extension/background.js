/* Owns the redirect rules. Must live in the service worker: content scripts have
   no chrome.declarativeNetRequest. The desired rules are kept in chrome.storage.local,
   written by the content script and re-applied here on every wake — no message
   round-trip needed, and the rules survive browser restarts. */

var KEY = "vxrRules";
var MAX_RULES = 3000;

function buildRules(want) {
  return (want || [])
    .filter(function (r) {
      return r && r.url && r.redirect;
    })
    .slice(0, MAX_RULES)
    .map(function (r, i) {
      return {
        id: i + 1,
        priority: 1,
        action: { type: "redirect", redirect: { url: r.redirect } },
        condition: { urlFilter: "|" + r.url + "|", resourceTypes: ["media", "xmlhttprequest", "other"] }
      };
    });
}

function applyRules(want) {
  return chrome.declarativeNetRequest.getDynamicRules().then(function (current) {
    var ids = current.map(function (r) {
      return r.id;
    });
    var add = buildRules(want);
    if (!add.length && !ids.length) return null;
    return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: add });
  });
}

function sync() {
  chrome.storage.local.get(KEY, function (data) {
    applyRules(data[KEY]).then(
      function () {
        chrome.storage.local.remove("vxrRuleError");
      },
      function (e) {
        chrome.storage.local.set({ vxrRuleError: String((e && e.message) || e) });
      }
    );
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || (msg.op !== "cdnSync" && msg.op !== "cdnInstall")) return;
  if (msg.op === "cdnInstall" && Array.isArray(msg.rules)) {
    applyRules(msg.rules).then(
      function () {
        chrome.storage.local.set({ vxrRules: msg.rules });
        sendResponse({ ok: true });
      },
      function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    );
    return true;
  }
  sync();
  sendResponse({ ok: true });
  return false;
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && KEY in changes) sync();
});

chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
sync();
