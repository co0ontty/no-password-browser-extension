export type ExtensionCredential = {
  id: string;
  title: string;
  username: string;
  password: string;
  otpSecret?: string;
  url: string;
  updatedAt: number;
};

export type ActiveTabContext = {
  url: string;
  title: string;
  host: string;
  canFill: boolean;
  items: ExtensionCredential[];
};

export type RuntimeMessage =
  | { type: "GET_ALL" }
  | { type: "UPSERT_ITEM"; item: ExtensionCredential }
  | { type: "DELETE_ITEM"; id: string }
  | { type: "GET_CREDENTIALS_FOR_URL"; url: string }
  | { type: "GET_ACTIVE_TAB_CONTEXT" }
  | { type: "FILL_ACTIVE_TAB"; itemId: string }
  | { type: "FILL_CREDENTIAL"; item: ExtensionCredential }
  | { type: "SAVE_CREDENTIAL"; item: ExtensionCredential }
  | { type: "STAGE_CREDENTIAL"; item: ExtensionCredential }
  | { type: "GET_STAGED_CREDENTIAL"; url: string }
  | { type: "DISCARD_STAGED_CREDENTIAL"; id: string }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "PASSKEY_BRIDGE_STATUS" };

export type ExtensionSettings = {
  serverUrl: string;
  offerFillAndSave: boolean;
  showInlineMenu: boolean;
};

export const STORAGE_ITEMS_KEY = "np.extension.items";
export const STORAGE_SETTINGS_KEY = "np.extension.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "https://home.huniu.fun:8182",
  offerFillAndSave: true,
  showInlineMenu: true,
};

export function hostFromUrl(url: string): string {
  return parseUrlMatchParts(url)?.host ?? "";
}

export function itemMatchesUrl(item: ExtensionCredential, url: string): boolean {
  return getUrlMatchScore(item.url, url) > 0;
}

export function sortItemsForUrl<T extends ExtensionCredential>(items: T[], url: string): T[] {
  return items
    .map((item) => ({ item, score: getUrlMatchScore(item.url, url) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
    .map(({ item }) => item);
}

function getUrlMatchScore(itemUrl: string, targetUrl: string): number {
  const item = parseUrlMatchParts(itemUrl);
  const target = parseUrlMatchParts(targetUrl);
  if (!item || !target) return 0;

  if (item.fullUrl === target.fullUrl) return 400;

  const parentIndex = target.pathUrls.indexOf(item.pathUrl);
  if (parentIndex !== -1) return 300 - parentIndex;

  if (item.hostPort === target.hostPort) return 200;
  if (hostMatches(item.host, target.host)) return 100;
  return 0;
}

function parseUrlMatchParts(value: string):
  | {
      fullUrl: string;
      pathUrl: string;
      pathUrls: string[];
      host: string;
      hostPort: string;
    }
  | null {
  const url = parseUrl(value);
  if (!url) return null;

  const host = normalizeHost(url.hostname);
  if (!host) return null;

  const hostPort = url.port ? `${host}:${url.port}` : host;
  const path = normalizePath(url.pathname);
  const base = `${url.protocol}//${hostPort}`;
  return {
    fullUrl: `${base}${path}${url.search}`,
    pathUrl: `${base}${path}`,
    pathUrls: buildPathUrls(base, path),
    host,
    hostPort,
  };
}

function parseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "https://" || trimmed === "http://") return null;

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function normalizePath(path: string): string {
  if (!path || path === "/") return "";
  return path.replace(/\/+$/g, "");
}

function buildPathUrls(base: string, path: string): string[] {
  if (!path) return [];

  const urls: string[] = [];
  const parts = path.split("/").filter(Boolean);
  for (let index = parts.length; index > 0; index -= 1) {
    urls.push(`${base}/${parts.slice(0, index).join("/")}`);
  }
  return urls;
}

function hostMatches(itemHost: string, targetHost: string): boolean {
  return targetHost === itemHost || targetHost.endsWith(`.${itemHost}`);
}
