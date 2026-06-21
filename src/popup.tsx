import React, { FormEvent, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { Check, Fingerprint, KeyRound, Plus, Save, Search, Settings, ShieldCheck, Trash2 } from "lucide-react";
import type { ExtensionCredential, ExtensionSettings, RuntimeMessage } from "./shared";
import "./popup.css";

function Popup() {
  const [items, setItems] = useState<ExtensionCredential[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<ExtensionSettings>({ serverUrl: "http://127.0.0.1:8080" });
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  useEffect(() => {
    void send<{ items: ExtensionCredential[] }>({ type: "GET_ALL" }).then((response) => {
      setItems(response.items);
      setSelectedId(response.items[0]?.id ?? "");
    });
    void send<{ settings: ExtensionSettings }>({ type: "GET_SETTINGS" }).then((response) => setSettings(response.settings));
    void send<{ available: boolean }>({ type: "PASSKEY_BRIDGE_STATUS" }).then((response) =>
      setBridgeAvailable(response.available),
    );
  }, []);

  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return items.filter((item) => [item.title, item.username, item.url].join(" ").toLowerCase().includes(needle));
  }, [items, query]);

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const item: ExtensionCredential = {
      ...selected,
      title: String(form.get("title") ?? ""),
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
      url: String(form.get("url") ?? ""),
      updatedAt: Date.now(),
    };
    const response = await send<{ items: ExtensionCredential[] }>({ type: "UPSERT_ITEM", item });
    setItems(response.items);
    setSelectedId(item.id);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const serverUrl = String(form.get("serverUrl") ?? "");
    const response = await send<{ settings: ExtensionSettings }>({ type: "SAVE_SETTINGS", serverUrl });
    setSettings(response.settings);
  }

  function addItem() {
    const item: ExtensionCredential = {
      id: crypto.randomUUID(),
      title: "New Login",
      username: "",
      password: "",
      url: "https://",
      updatedAt: Date.now(),
    };
    setItems((current) => [item, ...current]);
    setSelectedId(item.id);
  }

  return (
    <main className="popup-shell">
      <section className="liquid-panel">
        <header className="popup-header">
          <div className="brand-mark">
            <ShieldCheck size={20} />
          </div>
          <div>
            <p>NoPassword</p>
            <strong>Extension</strong>
          </div>
        </header>

        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
          <button title="Add credential" onClick={addItem}>
            <Plus size={16} />
          </button>
        </div>

        <div className="content-grid">
          <nav className="item-list">
            {filtered.map((item) => (
              <button key={item.id} className={selected?.id === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                <KeyRound size={16} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.username}</small>
                </span>
              </button>
            ))}
          </nav>

          {selected && (
            <form className="editor" onSubmit={saveItem}>
              <input name="title" defaultValue={selected.title} />
              <input name="url" defaultValue={selected.url} />
              <input name="username" defaultValue={selected.username} />
              <input name="password" defaultValue={selected.password} />
              <button className="primary-action" type="submit">
                <Save size={16} />
                Save
              </button>
            </form>
          )}
        </div>

        <form className="settings-row" onSubmit={saveSettings}>
          <Settings size={16} />
          <input name="serverUrl" defaultValue={settings.serverUrl} />
          <button title="Save server URL">
            <Check size={16} />
          </button>
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);

