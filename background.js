// CAP Offline — background (keep-awake + Discord proxy + update remoto)
const KEEP_AWAKE_ALARM = 'cap-offline-keepawake';
const POKE_ALARM = 'cap-offline-poke';
const UPDATE_ALARM = 'cap-offline-update-check';
const UPDATE_CHECK_MINUTES = 5;

function createAlarms() {
  chrome.alarms.create(KEEP_AWAKE_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(POKE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_CHECK_MINUTES });
}

function pokeTabs() {
  chrome.tabs.query({ url: 'https://stonegy-online.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      try { chrome.tabs.sendMessage(tab.id, { tipo: 'pokeReconnect' }).catch(() => {}); } catch (_) {}
    }
  });
}

chrome.runtime.onInstalled.addListener(() => { createAlarms(); });
chrome.runtime.onStartup.addListener(() => { createAlarms(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POKE_ALARM) pokeTabs();
  if (alarm.name === UPDATE_ALARM) {
    checkRemoteVersion().catch(() => {});
  }
});

function verNum(v) {
  const p = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1000000 + (p[1] || 0) * 1000 + (p[2] || 0);
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getUpdateBase() {
  const data = await storageGet(['updateBaseUrl']);
  return String(data.updateBaseUrl || '').replace(/\/+$/, '');
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return await r.text();
}

async function fetchJson(url) {
  const t = await fetchText(url);
  return JSON.parse(t);
}

async function loadLocalBotCode() {
  const url = chrome.runtime.getURL('bot.js');
  const code = await fetchText(url);
  const version = chrome.runtime.getManifest().version;
  return { code, version, source: 'local' };
}

async function checkRemoteVersion() {
  const base = await getUpdateBase();
  if (!base) return null;
  try {
    const info = await fetchJson(base + '/version.json');
    const latest = String(info.version || '').trim();
    if (!latest) return null;
    await storageSet({
      remoteLatest: latest,
      remoteMessage: String(info.message || ''),
      remoteBotFile: String(info.bot || 'bot.js'),
      remoteCheckedAt: Date.now(),
    });
    return info;
  } catch (e) {
    return null;
  }
}

async function downloadRemoteBot() {
  const base = await getUpdateBase();
  if (!base) throw new Error('URL base de update não configurada (cole no popup e Salvar)');
  let info;
  try {
    info = await checkRemoteVersion();
  } catch (e) {
    throw new Error('version.json: ' + (e.message || e));
  }
  if (!info || !info.version) {
    throw new Error('version.json não encontrado em ' + base + '/version.json');
  }
  const file = String(info.bot || 'bot.js');
  let code;
  try {
    code = await fetchText(base + '/' + file);
  } catch (e) {
    throw new Error('Falha ao baixar ' + file + ': ' + (e.message || e));
  }
  if (!code || code.length < 1000) throw new Error('bot remoto inválido (arquivo muito pequeno)');
  const version = String(info.version || '').trim() || '0';
  await storageSet({
    remoteBotCode: code,
    remoteBotVersion: version,
    remoteMessage: String(info.message || ''),
    remoteUpdatedAt: Date.now(),
    preferRemote: true,
  });
  return { version, message: info.message || '', bytes: code.length };
}

async function getBotCode() {
  const local = await loadLocalBotCode();
  const data = await storageGet([
    'preferRemote', 'remoteBotCode', 'remoteBotVersion', 'updateBaseUrl',
  ]);
  if (data.preferRemote && data.remoteBotCode) {
    // Se o pacote local for MAIS NOVO que o remoto cacheado, prefere local
    if (verNum(local.version) > verNum(data.remoteBotVersion)) {
      return local;
    }
    return {
      code: data.remoteBotCode,
      version: data.remoteBotVersion || local.version,
      source: 'remote',
    };
  }
  return local;
}

async function postDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return { ok: false, erro: 'webhook inválido' };
  }
  if (!webhookUrl.startsWith('https://discord.com/api/webhooks/') &&
      !webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
    return { ok: false, erro: 'URL de webhook inválida' };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, erro: e.message || String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.tipo) return;

  if (msg.tipo === 'requestKeepAwake') {
    if (msg.on) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
    return;
  }

  if (msg.tipo === 'discordWebhook') {
    postDiscordWebhook(msg.webhook, msg.payload)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, erro: e.message }));
    return true;
  }

  if (msg.tipo === 'getStatus') {
    storageGet(['remoteBotVersion', 'preferRemote', 'remoteLatest', 'updateBaseUrl', 'remoteMessage'])
      .then((d) => {
        sendResponse({
          ok: true,
          offline: true,
          version: chrome.runtime.getManifest().version,
          runningVersion: d.preferRemote && d.remoteBotVersion ? d.remoteBotVersion : chrome.runtime.getManifest().version,
          remoteLatest: d.remoteLatest || null,
          remoteMessage: d.remoteMessage || '',
          updateBaseUrl: d.updateBaseUrl || '',
          preferRemote: !!d.preferRemote,
        });
      });
    return true;
  }

  if (msg.tipo === 'getBotCode') {
    getBotCode()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, erro: e.message || String(e) }));
    return true;
  }

  if (msg.tipo === 'setUpdateBase') {
    const url = String(msg.url || '').trim().replace(/\/+$/, '');
    storageSet({ updateBaseUrl: url })
      .then(() => sendResponse({ ok: true, url }))
      .catch((e) => sendResponse({ ok: false, erro: e.message }));
    return true;
  }

  if (msg.tipo === 'checkUpdate') {
    checkRemoteVersion()
      .then(async (info) => {
        const local = chrome.runtime.getManifest().version;
        const data = await storageGet(['remoteBotVersion', 'preferRemote']);
        const current = data.preferRemote && data.remoteBotVersion ? data.remoteBotVersion : local;
        const latest = info && info.version ? String(info.version) : null;
        sendResponse({
          ok: true,
          current,
          latest,
          hasUpdate: !!(latest && verNum(latest) > verNum(current)),
          message: (info && info.message) || '',
        });
      })
      .catch((e) => sendResponse({ ok: false, erro: e.message || String(e) }));
    return true;
  }

  if (msg.tipo === 'forceBotUpdate') {
    downloadRemoteBot()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, erro: e.message || String(e) }));
    return true;
  }

  if (msg.tipo === 'cfgGet') {
    chrome.storage.local.get('capCfg', (data) => {
      sendResponse({ cfg: data.capCfg ?? null });
    });
    return true;
  }
  if (msg.tipo === 'cfgSet') {
    chrome.storage.local.set({ capCfg: msg.cfg }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.tipo === 'webhook') {
    fetch(msg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body || {}),
    })
      .then((y) => sendResponse({ ok: y.ok, status: y.status }))
      .catch((y) => sendResponse({ ok: false, erro: y.message }));
    return true;
  }
});
