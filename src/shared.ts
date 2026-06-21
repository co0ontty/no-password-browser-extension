export type ExtensionCredential = {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  updatedAt: number;
};

export type RuntimeMessage =
  | { type: "GET_ALL" }
  | { type: "UPSERT_ITEM"; item: ExtensionCredential }
  | { type: "GET_CREDENTIALS_FOR_URL"; url: string }
  | { type: "SAVE_CREDENTIAL"; item: ExtensionCredential }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; serverUrl: string }
  | { type: "PASSKEY_BRIDGE_STATUS" };

export type ExtensionSettings = {
  serverUrl: string;
};

export const STORAGE_ITEMS_KEY = "np.extension.items";
export const STORAGE_SETTINGS_KEY = "np.extension.settings";

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function itemMatchesUrl(item: ExtensionCredential, url: string): boolean {
  const itemHost = hostFromUrl(item.url);
  const targetHost = hostFromUrl(url);
  return Boolean(itemHost && targetHost && (targetHost === itemHost || targetHost.endsWith(`.${itemHost}`)));
}

