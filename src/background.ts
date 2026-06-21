import {
  ExtensionCredential,
  ExtensionSettings,
  RuntimeMessage,
  STORAGE_ITEMS_KEY,
  STORAGE_SETTINGS_KEY,
  itemMatchesUrl,
} from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get([STORAGE_ITEMS_KEY, STORAGE_SETTINGS_KEY]).then((result) => {
    if (!result[STORAGE_ITEMS_KEY]) {
      void chrome.storage.local.set({
        [STORAGE_ITEMS_KEY]: [
          {
            id: crypto.randomUUID(),
            title: "GitHub",
            username: "alex@example.com",
            password: "Z8q!uQ4p@qN7vL2s",
            url: "https://github.com",
            updatedAt: Date.now(),
          },
        ],
      });
    }
    if (!result[STORAGE_SETTINGS_KEY]) {
      void chrome.storage.local.set({
        [STORAGE_SETTINGS_KEY]: {
          serverUrl: "http://127.0.0.1:8080",
        },
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unknown error" }));
  return true;
});

async function handleMessage(message: RuntimeMessage) {
  switch (message.type) {
    case "GET_ALL":
      return { items: await getItems() };
    case "UPSERT_ITEM":
    case "SAVE_CREDENTIAL":
      return { items: await upsertItem(message.item) };
    case "GET_CREDENTIALS_FOR_URL": {
      const items = await getItems();
      return { items: items.filter((item) => itemMatchesUrl(item, message.url)) };
    }
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      return { settings: await saveSettings({ serverUrl: message.serverUrl }) };
    case "PASSKEY_BRIDGE_STATUS":
      return {
        available: Boolean((chrome as unknown as { webAuthenticationProxy?: unknown }).webAuthenticationProxy),
      };
    default:
      return {};
  }
}

async function getItems(): Promise<ExtensionCredential[]> {
  const result = await chrome.storage.local.get(STORAGE_ITEMS_KEY);
  return (result[STORAGE_ITEMS_KEY] ?? []) as ExtensionCredential[];
}

async function upsertItem(item: ExtensionCredential): Promise<ExtensionCredential[]> {
  const items = await getItems();
  const next = [item, ...items.filter((current) => current.id !== item.id)];
  await chrome.storage.local.set({ [STORAGE_ITEMS_KEY]: next });
  return next;
}

async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return (result[STORAGE_SETTINGS_KEY] ?? { serverUrl: "http://127.0.0.1:8080" }) as ExtensionSettings;
}

async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: settings });
  return settings;
}

