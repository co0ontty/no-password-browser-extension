import {
  ActiveTabContext,
  DEFAULT_SETTINGS,
  ExtensionCredential,
  ExtensionSettings,
  RuntimeMessage,
  STORAGE_ITEMS_KEY,
  STORAGE_SETTINGS_KEY,
  hostFromUrl,
  itemMatchesUrl,
  sortItemsForUrl,
} from "./shared";

const stagedCredentials = new Map<number, ExtensionCredential>();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get([STORAGE_ITEMS_KEY, STORAGE_SETTINGS_KEY]).then((result) => {
    if (!result[STORAGE_ITEMS_KEY]) {
      void chrome.storage.local.set({
        [STORAGE_ITEMS_KEY]: [],
      });
    }
    if (!result[STORAGE_SETTINGS_KEY]) {
      void chrome.storage.local.set({
        [STORAGE_SETTINGS_KEY]: DEFAULT_SETTINGS,
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void handleMessage(message, _sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unknown error" }));
  return true;
});

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "GET_ALL":
      return { items: await getItems() };
    case "UPSERT_ITEM":
    case "SAVE_CREDENTIAL":
      return { items: await upsertItem(message.item) };
    case "DELETE_ITEM":
      return { items: await deleteItem(message.id) };
    case "STAGE_CREDENTIAL":
      return { item: stageCredential(message.item, sender) };
    case "GET_STAGED_CREDENTIAL":
      return { item: getStagedCredential(message.url, sender) };
    case "DISCARD_STAGED_CREDENTIAL":
      return { item: discardStagedCredential(message.id, sender) };
    case "GET_CREDENTIALS_FOR_URL": {
      const items = await getItems();
      return { items: sortItemsForUrl(items, message.url) };
    }
    case "GET_ACTIVE_TAB_CONTEXT":
      return { context: await getActiveTabContext() };
    case "FILL_ACTIVE_TAB":
      return fillActiveTab(message.itemId);
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      return { settings: await saveSettings(message.settings) };
    case "PASSKEY_BRIDGE_STATUS":
      return {
        available: Boolean((chrome as unknown as { webAuthenticationProxy?: unknown }).webAuthenticationProxy),
      };
    default:
      return {};
  }
}

function stageCredential(item: ExtensionCredential, sender: chrome.runtime.MessageSender): ExtensionCredential | null {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return null;
  stagedCredentials.set(tabId, item);
  return item;
}

function getStagedCredential(url: string, sender: chrome.runtime.MessageSender): ExtensionCredential | null {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return null;
  const item = stagedCredentials.get(tabId);
  if (!item || !itemMatchesUrl(item, url)) return null;
  return item;
}

function discardStagedCredential(id: string, sender: chrome.runtime.MessageSender): null {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return null;
  const item = stagedCredentials.get(tabId);
  if (!item || item.id === id) stagedCredentials.delete(tabId);
  return null;
}

async function getItems(): Promise<ExtensionCredential[]> {
  const result = await chrome.storage.local.get(STORAGE_ITEMS_KEY);
  return (result[STORAGE_ITEMS_KEY] ?? []) as ExtensionCredential[];
}

async function upsertItem(item: ExtensionCredential): Promise<ExtensionCredential[]> {
  const items = await getItems();
  const normalized = normalizeCredential(item);
  const existing =
    items.find((current) => current.id === normalized.id) ??
    items.find(
      (current) =>
        current.id !== normalized.id &&
        usernamesMatch(current.username, normalized.username) &&
        itemMatchesUrl(current, normalized.url),
    );
  const nextItem: ExtensionCredential = {
    ...existing,
    ...normalized,
    id: existing?.id ?? normalized.id,
    title: normalized.title || existing?.title || hostFromUrl(normalized.url) || "Login",
    updatedAt: Date.now(),
  };
  const next = [nextItem, ...items.filter((current) => current.id !== nextItem.id)];
  await chrome.storage.local.set({ [STORAGE_ITEMS_KEY]: next });
  return next;
}

async function deleteItem(id: string): Promise<ExtensionCredential[]> {
  const items = (await getItems()).filter((item) => item.id !== id);
  await chrome.storage.local.set({ [STORAGE_ITEMS_KEY]: items });
  return items;
}

async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return normalizeSettings(result[STORAGE_SETTINGS_KEY]);
}

async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const next = normalizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: next });
  return next;
}

async function getActiveTabContext(): Promise<ActiveTabContext> {
  const tab = await getActiveTab();
  const url = tab?.url ?? "";
  const title = tab?.title ?? "";
  const canFill = /^https?:\/\//i.test(url);
  const items = canFill ? sortItemsForUrl(await getItems(), url) : [];

  return {
    url,
    title,
    host: hostFromUrl(url),
    canFill,
    items,
  };
}

async function fillActiveTab(itemId: string): Promise<{ ok: boolean }> {
  const tab = await getActiveTab();
  if (typeof tab?.id !== "number") throw new Error("No active tab available");

  const item = (await getItems()).find((current) => current.id === itemId);
  if (!item) throw new Error("Credential not found");

  await chrome.tabs.sendMessage(tab.id, { type: "FILL_CREDENTIAL", item } satisfies RuntimeMessage);
  return { ok: true };
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function normalizeSettings(value: unknown): ExtensionSettings {
  const input = (value ?? {}) as Partial<ExtensionSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    serverUrl: input.serverUrl?.trim() || DEFAULT_SETTINGS.serverUrl,
    offerFillAndSave: input.offerFillAndSave ?? DEFAULT_SETTINGS.offerFillAndSave,
    showInlineMenu: input.showInlineMenu ?? DEFAULT_SETTINGS.showInlineMenu,
  };
}

function normalizeCredential(item: ExtensionCredential): ExtensionCredential {
  const url = item.url.trim();
  return {
    ...item,
    id: item.id || crypto.randomUUID(),
    title: item.title.trim(),
    username: item.username.trim(),
    password: item.password,
    otpSecret: item.otpSecret?.trim(),
    url,
    updatedAt: item.updatedAt || Date.now(),
  };
}

function usernamesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
