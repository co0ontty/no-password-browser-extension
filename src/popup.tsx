import React, { FormEvent, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Check,
  Clipboard,
  Fingerprint,
  Globe2,
  KeyRound,
  LogIn,
  Plus,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  ActiveTabContext,
  DEFAULT_SETTINGS,
  ExtensionCredential,
  ExtensionSettings,
  RuntimeMessage,
  hostFromUrl,
} from "./shared";
import { generateTotp } from "./totp";
import "./popup.css";

type ConnectionState = {
  label: string;
  tone: "checking" | "secure" | "warning" | "danger";
};

const EMPTY_CONTEXT: ActiveTabContext = {
  url: "",
  title: "",
  host: "",
  canFill: false,
  items: [],
};

function Popup() {
  const [items, setItems] = useState<ExtensionCredential[]>([]);
  const [activeContext, setActiveContext] = useState<ActiveTabContext>(EMPTY_CONTEXT);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ExtensionCredential | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [otpCode, setOtpCode] = useState<{ code: string; remaining: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState<ConnectionState>({ label: "Checking server", tone: "checking" });

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [all, nextSettings, context, bridge] = await Promise.all([
        send<{ items: ExtensionCredential[] }>({ type: "GET_ALL" }).catch(() => ({ items: [] })),
        send<{ settings: ExtensionSettings }>({ type: "GET_SETTINGS" }).catch(() => ({ settings: DEFAULT_SETTINGS })),
        send<{ context: ActiveTabContext }>({ type: "GET_ACTIVE_TAB_CONTEXT" }).catch(() => ({ context: EMPTY_CONTEXT })),
        send<{ available: boolean }>({ type: "PASSKEY_BRIDGE_STATUS" }).catch(() => ({ available: false })),
      ]);

      if (cancelled) return;
      setItems(all.items);
      setSettings(nextSettings.settings);
      setActiveContext(context.context);
      setBridgeAvailable(bridge.available);
      setSelectedId(context.context.items[0]?.id ?? all.items[0]?.id ?? "");
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selected?.id, selected?.updatedAt]);

  useEffect(() => {
    let cancelled = false;
    const updateOtp = async () => {
      if (!draft?.otpSecret) {
        setOtpCode(null);
        return;
      }
      const next = await generateTotp(draft.otpSecret).catch(() => null);
      if (!cancelled) setOtpCode(next);
    };
    void updateOtp();
    const handle = window.setInterval(updateOtp, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [draft?.id, draft?.otpSecret]);

  useEffect(() => {
    let cancelled = false;
    setConnection({ label: "Checking server", tone: "checking" });
    void probeConnection(settings.serverUrl).then((next) => {
      if (!cancelled) setConnection(next);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.serverUrl]);

  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    if (!needle) return items;
    return items.filter((item) => [item.title, item.username, item.url].join(" ").toLowerCase().includes(needle));
  }, [items, query]);

  async function refreshContext() {
    const response = await send<{ context: ActiveTabContext }>({ type: "GET_ACTIVE_TAB_CONTEXT" }).catch(() => ({
      context: EMPTY_CONTEXT,
    }));
    setActiveContext(response.context);
  }

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;

    const item: ExtensionCredential = {
      ...draft,
      title: draft.title.trim() || hostFromUrl(draft.url) || "Login",
      username: draft.username.trim(),
      otpSecret: draft.otpSecret?.trim(),
      url: draft.url.trim(),
      updatedAt: Date.now(),
    };
    const response = await send<{ items: ExtensionCredential[] }>({ type: "UPSERT_ITEM", item });
    setItems(response.items);
    setSelectedId(response.items[0]?.id ?? item.id);
    setNotice("Login saved");
    await refreshContext();
  }

  async function deleteSelected() {
    if (!selected) return;
    const response = await send<{ items: ExtensionCredential[] }>({ type: "DELETE_ITEM", id: selected.id });
    setItems(response.items);
    setSelectedId(response.items[0]?.id ?? "");
    setNotice("Login deleted");
    await refreshContext();
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await send<{ settings: ExtensionSettings }>({ type: "SAVE_SETTINGS", settings });
    setSettings(response.settings);
    setNotice("Settings saved");
  }

  async function fillActiveTab(itemId: string) {
    if (!activeContext.canFill) {
      setNotice("Open an HTTP or HTTPS page to fill");
      return;
    }

    const response = await send<{ ok?: boolean; error?: string }>({ type: "FILL_ACTIVE_TAB", itemId }).catch((error) => ({
      error: error instanceof Error ? error.message : "Unable to fill this page",
    }));
    if (response.error) {
      setNotice(response.error);
      return;
    }
    window.close();
  }

  function addItem() {
    const item: ExtensionCredential = {
      id: crypto.randomUUID(),
      title: activeContext.title || activeContext.host || "New Login",
      username: "",
      password: "",
      otpSecret: "",
      url: activeContext.canFill ? pageCredentialUrl(activeContext.url) : "https://",
      updatedAt: Date.now(),
    };
    setItems((current) => [item, ...current]);
    setSelectedId(item.id);
    setNotice("");
  }

  function updateDraft<K extends keyof ExtensionCredential>(key: K, value: ExtensionCredential[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function generatePasswordForDraft() {
    updateDraft("password", generatePassword());
  }

  async function copyValue(value: string, label: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied`);
  }

  return (
    <main className="popup-shell">
      <section className="liquid-panel">
        <header className="popup-header">
          <div className="brand-mark">
            <ShieldCheck size={20} />
          </div>
          <div className="brand-copy">
            <p>NoPassword</p>
            <strong>Browser extension</strong>
          </div>
          <span className={`security-pill ${connection.tone}`}>{connection.label}</span>
        </header>

        {notice && <div className="notice-row">{notice}</div>}

        <section className="current-site">
          <div className="section-title">
            <Globe2 size={16} />
            <span>{activeContext.host || "Current page"}</span>
          </div>
          {activeContext.canFill ? (
            activeContext.items.length ? (
              <div className="site-items">
                {activeContext.items.map((item) => (
                  <div className="site-item" key={item.id}>
                    <button className="item-main" type="button" onClick={() => setSelectedId(item.id)}>
                      <KeyRound size={16} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.username || "No username"}</small>
                      </span>
                    </button>
                    <button className="fill-button" type="button" onClick={() => void fillActiveTab(item.id)}>
                      <LogIn size={15} />
                      Fill
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <span>No login saved for this site.</span>
                <button type="button" onClick={addItem}>
                  <Plus size={15} />
                  Add login
                </button>
              </div>
            )
          ) : (
            <div className="empty-state">
              <span>This page cannot be filled by an extension.</span>
            </div>
          )}
        </section>

        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search logins" />
          <button title="Add credential" type="button" onClick={addItem}>
            <Plus size={16} />
          </button>
        </div>

        <div className="content-grid">
          <nav className="item-list" aria-label="Saved logins">
            {filtered.map((item) => (
              <button
                key={item.id}
                className={selected?.id === item.id ? "active" : ""}
                type="button"
                onClick={() => setSelectedId(item.id)}
              >
                <KeyRound size={16} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.username || hostFromUrl(item.url)}</small>
                </span>
              </button>
            ))}
            {!filtered.length && <div className="list-empty">No matching logins</div>}
          </nav>

          {draft ? (
            <form className="editor" onSubmit={saveItem}>
              <label>
                <span>Title</span>
                <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} />
              </label>
              <label>
                <span>Website</span>
                <input value={draft.url} onChange={(event) => updateDraft("url", event.target.value)} />
              </label>
              <label>
                <span>Username</span>
                <div className="input-action">
                  <input value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} />
                  <button type="button" title="Copy username" onClick={() => void copyValue(draft.username, "Username")}>
                    <Clipboard size={15} />
                  </button>
                </div>
              </label>
              <label>
                <span>Password</span>
                <div className="input-action">
                  <input value={draft.password} onChange={(event) => updateDraft("password", event.target.value)} />
                  <button type="button" title="Generate password" onClick={generatePasswordForDraft}>
                    <Sparkles size={15} />
                  </button>
                  <button type="button" title="Copy password" onClick={() => void copyValue(draft.password, "Password")}>
                    <Clipboard size={15} />
                  </button>
                </div>
              </label>
              <label>
                <span>One-time password</span>
                <input
                  value={draft.otpSecret ?? ""}
                  onChange={(event) => updateDraft("otpSecret", event.target.value)}
                  placeholder="OTP secret or otpauth:// URI"
                />
              </label>
              <div className="otp-card">
                <span>{otpCode?.code ?? "OTP"}</span>
                <button
                  type="button"
                  disabled={!otpCode}
                  title="Copy OTP"
                  onClick={() => otpCode && void copyValue(otpCode.code, "OTP")}
                >
                  {otpCode ? `${otpCode.remaining}s` : "--"}
                </button>
              </div>
              <div className="editor-actions">
                <button className="danger-action" type="button" onClick={() => void deleteSelected()}>
                  <Trash2 size={16} />
                  Delete
                </button>
                <button className="primary-action" type="submit">
                  <Save size={16} />
                  Save
                </button>
              </div>
            </form>
          ) : (
            <div className="empty-editor">
              <span>Select a login or add one for this site.</span>
            </div>
          )}
        </div>

        <form className="settings-row" onSubmit={saveSettings}>
          <div className="settings-heading">
            <Settings size={16} />
            <span>Settings</span>
            <button title="Save settings">
              <Check size={16} />
            </button>
          </div>
          <input
            name="serverUrl"
            value={settings.serverUrl}
            onChange={(event) => setSettings((current) => ({ ...current, serverUrl: event.target.value }))}
          />
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.offerFillAndSave}
              onChange={(event) => setSettings((current) => ({ ...current, offerFillAndSave: event.target.checked }))}
            />
            <span>Offer to fill and save</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.showInlineMenu}
              onChange={(event) => setSettings((current) => ({ ...current, showInlineMenu: event.target.checked }))}
            />
            <span>Show field menu</span>
          </label>
        </form>

        <div className="bridge-row">
          <Fingerprint size={16} />
          <span>Passkey bridge</span>
          <strong>{bridgeAvailable ? "Available" : "Unavailable"}</strong>
        </div>
      </section>
    </main>
  );
}

function send<T>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function pageCredentialUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function generatePassword(): string {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*_-+="];
  const all = groups.join("");
  const chars = groups.map((group) => randomCharacter(group));

  while (chars.length < 20) chars.push(randomCharacter(all));

  return shuffle(chars).join("");
}

function randomCharacter(characters: string): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return characters[bytes[0] % characters.length];
}

function shuffle(values: string[]): string[] {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const swapIndex = bytes[0] % (index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

async function probeConnection(serverUrl: string): Promise<ConnectionState> {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return { label: "Invalid server URL", tone: "danger" };
  }

  if (url.protocol === "http:") return { label: "Insecure HTTP", tone: "danger" };
  if (url.protocol !== "https:") return { label: "Invalid server URL", tone: "danger" };

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(new URL("/healthz", url.origin), {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok
      ? { label: "Trusted HTTPS", tone: "secure" }
      : { label: "HTTPS server error", tone: "warning" };
  } catch {
    return { label: "HTTPS not trusted", tone: "warning" };
  } finally {
    window.clearTimeout(timeout);
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
