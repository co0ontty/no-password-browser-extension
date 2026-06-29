import type { ExtensionCredential, ExtensionSettings, RuntimeMessage } from "./shared";

const ROOT_TAG = "np-autofill-root";
const PASSWORD_LENGTH = 20;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  serverUrl: "https://home.huniu.fun:8182",
  offerFillAndSave: true,
  showInlineMenu: true,
};

let currentSettings: ExtensionSettings = DEFAULT_EXTENSION_SETTINGS;
let settingsLoaded = false;
let lastFilledCredential: Pick<ExtensionCredential, "username" | "password"> | null = null;

const host = document.createElement(ROOT_TAG);
host.style.position = "fixed";
host.style.top = "0";
host.style.left = "0";
host.style.width = "0";
host.style.height = "0";
host.style.pointerEvents = "none";
host.style.zIndex = "2147483647";
const shadow = host.attachShadow({ mode: "closed" });
document.documentElement.append(host);

type UiState = {
  activeInput: HTMLInputElement | null;
  items: ExtensionCredential[];
  menuOpen: boolean;
  stagedPrompt: ExtensionCredential | null;
  notice: string;
};

const ui: UiState = {
  activeInput: null,
  items: [],
  menuOpen: false,
  stagedPrompt: null,
  notice: "",
};

document.addEventListener("focusin", (event) => void handleFocusIn(event), true);
document.addEventListener("pointerdown", handleDocumentPointerDown, true);
document.addEventListener("submit", (event) => void captureSubmittedCredential(event), true);
document.addEventListener("keydown", handleKeyDown, true);
window.addEventListener("scroll", renderShadow, true);
window.addEventListener("resize", renderShadow);

shadow.addEventListener("click", (event) => void handleShadowClick(event));

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type !== "FILL_CREDENTIAL") return undefined;

  void fillCredential(message.item)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unable to fill" }));
  return true;
});

void promptForStagedCredential();
renderShadow();

async function handleFocusIn(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !isCredentialInput(target)) return;

  ui.activeInput = target;
  ui.menuOpen = true;
  ui.notice = "";
  renderShadow();

  await loadSettings();
  if (!currentSettings.offerFillAndSave || !currentSettings.showInlineMenu) {
    ui.menuOpen = false;
    renderShadow();
    return;
  }

  ui.items = await getCredentialsForCurrentUrl();
  ui.menuOpen = true;
  renderShadow();
}

function handleDocumentPointerDown(event: PointerEvent) {
  const path = event.composedPath();
  if (path.includes(host) || (ui.activeInput && path.includes(ui.activeInput))) return;
  ui.activeInput = null;
  ui.menuOpen = false;
  renderShadow();
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  ui.menuOpen = false;
  ui.stagedPrompt = null;
  renderShadow();
}

async function handleShadowClick(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest<HTMLButtonElement>("[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const itemId = button.dataset.itemId;

  if (action === "toggle-menu") {
    ui.menuOpen = !ui.menuOpen;
    if (ui.menuOpen) ui.items = await getCredentialsForCurrentUrl();
    renderShadow();
    return;
  }

  if (action === "fill-credential" && itemId) {
    const item = ui.items.find((current) => current.id === itemId);
    if (item) await fillCredential(item);
    hideInlineUi();
    renderShadow();
    return;
  }

  if (action === "generate-password") {
    fillGeneratedPassword(generatePassword());
    ui.notice = "Suggested password filled";
    hideInlineUi();
    renderShadow();
    return;
  }

  if (action === "save-current") {
    const item = buildCredentialFromActiveForm();
    if (item) await saveCredential(item);
    ui.notice = item ? "Login saved" : "No password found";
    hideInlineUi();
    renderShadow();
    return;
  }

  if (action === "save-staged" && ui.stagedPrompt) {
    await saveCredential(ui.stagedPrompt);
    await discardStagedCredential(ui.stagedPrompt.id);
    ui.stagedPrompt = null;
    ui.notice = "Login saved";
    renderShadow();
    return;
  }

  if (action === "dismiss-staged" && ui.stagedPrompt) {
    await discardStagedCredential(ui.stagedPrompt.id);
    ui.stagedPrompt = null;
    renderShadow();
  }
}

function hideInlineUi() {
  ui.activeInput = null;
  ui.menuOpen = false;
}

async function fillCredential(item: ExtensionCredential) {
  const root = getActiveRoot();
  const usernameInput = findUsernameInput(root);
  if (usernameInput) setInputValue(usernameInput, item.username);

  if (ui.activeInput && isOtpInput(ui.activeInput)) {
    await fillOtpInputs(root, item, ui.activeInput);
    return;
  }

  const passwordInput = findPasswordInputForFill(root);
  if (passwordInput) setInputValue(passwordInput, item.password);
  lastFilledCredential = { username: item.username, password: item.password };
  await fillOtpInputs(root, item);
}

function fillGeneratedPassword(password: string) {
  const activeInput = ui.activeInput;
  if (!activeInput || activeInput.type !== "password") return;

  const root = getActiveRoot();
  const passwordInputs = getPasswordInputs(root);
  const activeIndex = passwordInputs.indexOf(activeInput);
  const targets =
    activeIndex >= 0
      ? passwordInputs.slice(activeIndex, activeIndex + 2).filter((input) => input.autocomplete !== "current-password")
      : [activeInput];

  targets.forEach((input) => setInputValue(input, password));
}

async function fillOtpInputs(root: ParentNode, item: ExtensionCredential, preferredInput?: HTMLInputElement) {
  if (!item.otpSecret) return;
  const totp = await generateTotp(item.otpSecret).catch(() => null);
  if (!totp) return;

  const targets = preferredInput ? [preferredInput] : getAllInputs(root).filter(isOtpInput);
  targets.forEach((input) => setInputValue(input, totp.code));
}

async function captureSubmittedCredential(event: Event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  await loadSettings();
  if (!currentSettings.offerFillAndSave) return;

  const item = buildCredentialFromRoot(form);
  if (!item) return;
  if (lastFilledCredential?.username === item.username && lastFilledCredential.password === item.password) return;

  const response = await sendMessage<{ item: ExtensionCredential | null }>({ type: "STAGE_CREDENTIAL", item }).catch(
    () => null,
  );
  if (!response?.item) return;

  ui.stagedPrompt = response.item;
  ui.notice = "";
  renderShadow();
}

async function promptForStagedCredential() {
  await delay(500);
  await loadSettings();
  if (!currentSettings.offerFillAndSave) return;

  const response = await sendMessage<{ item: ExtensionCredential | null }>({
    type: "GET_STAGED_CREDENTIAL",
    url: location.href,
  }).catch(() => null);

  if (!response?.item) return;
  ui.stagedPrompt = response.item;
  renderShadow();
}

async function saveCredential(item: ExtensionCredential) {
  await sendMessage<{ items: ExtensionCredential[] }>({ type: "SAVE_CREDENTIAL", item });
}

async function discardStagedCredential(id: string) {
  await sendMessage({ type: "DISCARD_STAGED_CREDENTIAL", id });
}

async function getCredentialsForCurrentUrl(): Promise<ExtensionCredential[]> {
  const response = await sendMessage<{ items: ExtensionCredential[] }>({
    type: "GET_CREDENTIALS_FOR_URL",
    url: location.href,
  }).catch(() => ({ items: [] }));
  return response.items;
}

async function loadSettings() {
  if (settingsLoaded) return;
  const response = await sendMessage<{ settings: ExtensionSettings }>({ type: "GET_SETTINGS" }).catch(() => null);
  if (response?.settings) currentSettings = response.settings;
  settingsLoaded = true;
}

function buildCredentialFromActiveForm(): ExtensionCredential | null {
  return buildCredentialFromRoot(getActiveRoot());
}

function buildCredentialFromRoot(root: ParentNode): ExtensionCredential | null {
  const passwordInput = findPasswordInputForSave(root);
  if (!passwordInput?.value) return null;

  const usernameInput = findUsernameInput(root, passwordInput);
  const hostName = hostFromUrl(location.href) || location.hostname;
  return {
    id: crypto.randomUUID(),
    title: document.title || hostName || "Login",
    username: usernameInput?.value.trim() ?? "",
    password: passwordInput.value,
    otpSecret: "",
    url: `${location.origin}${location.pathname}`,
    updatedAt: Date.now(),
  };
}

function getActiveRoot(): ParentNode {
  return ui.activeInput?.form ?? document;
}

function findUsernameInput(root: ParentNode, passwordInput?: HTMLInputElement): HTMLInputElement | null {
  const inputs = getAllInputs(root).filter((input) => isEditableInput(input) && isTextCredentialInput(input));
  const explicit = inputs.find((input) => input.autocomplete === "username");
  if (explicit) return explicit;

  const email = inputs.find((input) => input.type === "email");
  if (email) return email;

  if (passwordInput) {
    const allInputs = getAllInputs(root);
    const passwordIndex = allInputs.indexOf(passwordInput);
    const beforePassword = inputs.filter((input) => allInputs.indexOf(input) < passwordIndex).pop();
    if (beforePassword) return beforePassword;
  }

  return inputs[0] ?? null;
}

function findPasswordInputForFill(root: ParentNode): HTMLInputElement | null {
  const passwords = getPasswordInputs(root);
  if (!passwords.length) return null;
  if (ui.activeInput?.type === "password" && passwords.includes(ui.activeInput)) return ui.activeInput;
  return passwords.find((input) => input.autocomplete !== "new-password") ?? passwords[0];
}

function findPasswordInputForSave(root: ParentNode): HTMLInputElement | null {
  const passwords = getPasswordInputs(root).filter((input) => input.value);
  if (!passwords.length) return null;

  const newPassword = passwords.find((input) => input.autocomplete === "new-password");
  if (newPassword) return newPassword;

  const currentPasswordIndex = passwords.findIndex((input) => input.autocomplete === "current-password");
  if (currentPasswordIndex !== -1 && passwords[currentPasswordIndex + 1]) return passwords[currentPasswordIndex + 1];

  return passwords[0];
}

function getPasswordInputs(root: ParentNode): HTMLInputElement[] {
  return getAllInputs(root).filter((input) => input.type === "password" && isEditableInput(input));
}

function getAllInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>("input"));
}

function isCredentialInput(input: HTMLInputElement): boolean {
  if (!isEditableInput(input)) return false;
  if (input.type === "password" || isOtpInput(input)) return true;
  if (input.autocomplete === "username" || input.type === "email") return true;
  if (!isTextCredentialInput(input)) return false;
  return Boolean(input.form?.querySelector("input[type='password']"));
}

function isTextCredentialInput(input: HTMLInputElement): boolean {
  return ["", "email", "tel", "text", "url"].includes(input.type);
}

function isEditableInput(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly && input.type !== "hidden" && input.getClientRects().length > 0;
}

function isOtpInput(input: HTMLInputElement): boolean {
  const haystack = [
    input.autocomplete,
    input.name,
    input.id,
    input.placeholder,
    input.ariaLabel,
    input.getAttribute("inputmode") ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return (
    input.autocomplete === "one-time-code" ||
    /(?:otp|totp|mfa|2fa|two[- ]factor|one[- ]time|verification|auth.*code|security.*code)/.test(haystack)
  );
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function generatePassword(): string {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*_-+="];
  const allCharacters = groups.join("");
  const password = groups.map((group) => randomCharacter(group));

  while (password.length < PASSWORD_LENGTH) password.push(randomCharacter(allCharacters));

  return shuffle(password).join("");
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

function renderShadow() {
  const activeInput = ui.activeInput;
  const showInline =
    Boolean(activeInput?.isConnected) &&
    currentSettings.offerFillAndSave &&
    currentSettings.showInlineMenu &&
    Boolean(activeInput && isCredentialInput(activeInput));

  shadow.innerHTML = `
    <style>${styles()}</style>
    ${showInline && activeInput ? renderInline(activeInput) : ""}
    ${ui.stagedPrompt ? renderSavePrompt(ui.stagedPrompt) : ""}
    ${ui.notice ? renderNotice(ui.notice) : ""}
  `;
}

function renderInline(input: HTMLInputElement): string {
  const icon = floatingIconPosition(input);
  return `
    <button class="np-icon" style="top:${icon.top}px;left:${icon.left}px" type="button" data-action="toggle-menu" title="NoPassword">
      N
    </button>
    ${ui.menuOpen ? renderMenu(input) : ""}
  `;
}

function renderMenu(input: HTMLInputElement): string {
  const menu = floatingMenuPosition(input);
  const hostName = escapeHtml(hostFromUrl(location.href) || location.hostname);
  const items = ui.items.filter((item) => !isOtpInput(input) || Boolean(item.otpSecret));
  const credentialButtons = items.map((item) => renderCredentialButton(item, input)).join("");
  const canSave = Boolean(buildCredentialFromActiveForm());
  const isPasswordField = input.type === "password";

  return `
    <section class="np-menu" style="top:${menu.top}px;left:${menu.left}px" aria-label="NoPassword">
      <header>
        <strong>NoPassword</strong>
        <span>${hostName}</span>
      </header>
      <div class="np-list">
        ${
          credentialButtons ||
          `<div class="np-empty">
            <strong>No saved login</strong>
            <span>${hostName ? `for ${hostName}` : "for this site"}</span>
          </div>`
        }
      </div>
      <div class="np-actions">
        ${
          isPasswordField
            ? `<button type="button" data-action="generate-password">Use suggested password</button>`
            : ""
        }
        ${
          canSave
            ? `<button type="button" data-action="save-current">Save login from this form</button>`
            : ""
        }
      </div>
    </section>
  `;
}

function renderCredentialButton(item: ExtensionCredential, input: HTMLInputElement): string {
  const title = escapeHtml(item.title || hostFromUrl(item.url) || "Login");
  const username = escapeHtml(item.username || hostFromUrl(item.url) || "No username");
  const action = isOtpInput(input) ? "Fill one-time code" : "Fill login";

  return `
    <button class="np-item" type="button" data-action="fill-credential" data-item-id="${escapeHtml(item.id)}">
      <span>
        <strong>${title}</strong>
        <small>${username}</small>
      </span>
      <em>${action}</em>
    </button>
  `;
}

function renderSavePrompt(item: ExtensionCredential): string {
  const title = escapeHtml(item.title || hostFromUrl(item.url) || "Login");
  const username = escapeHtml(item.username || "No username");
  return `
    <section class="np-prompt" aria-label="Save login">
      <div>
        <strong>Save login?</strong>
        <span>${title}</span>
        <small>${username}</small>
      </div>
      <footer>
        <button type="button" data-action="dismiss-staged">Not now</button>
        <button class="primary" type="button" data-action="save-staged">Save</button>
      </footer>
    </section>
  `;
}

function renderNotice(notice: string): string {
  return `<div class="np-notice">${escapeHtml(notice)}</div>`;
}

function floatingIconPosition(input: HTMLInputElement): { top: number; left: number } {
  const rect = input.getBoundingClientRect();
  return {
    top: clamp(rect.top + rect.height / 2 - 15, 8, window.innerHeight - 38),
    left: clamp(rect.right - 36, 8, window.innerWidth - 38),
  };
}

function floatingMenuPosition(input: HTMLInputElement): { top: number; left: number } {
  const rect = input.getBoundingClientRect();
  return {
    top: clamp(rect.bottom + 8, 8, Math.max(8, window.innerHeight - 346)),
    left: clamp(rect.left, 8, Math.max(8, window.innerWidth - 328)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function generateTotp(value: string, now = Date.now()): Promise<{ code: string; remaining: number } | null> {
  const secret = extractOtpSecret(value);
  if (!secret) return null;

  const keyBytes = decodeBase32(secret);
  if (keyBytes.length === 0) return null;

  const step = 30;
  const counter = Math.floor(now / 1000 / step);
  const remaining = step - (Math.floor(now / 1000) % step);
  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setBigUint64(0, BigInt(counter));

  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return {
    code: String(binary % 1_000_000).padStart(6, "0"),
    remaining,
  };
}

function extractOtpSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.protocol === "otpauth:") {
      return sanitizeBase32(url.searchParams.get("secret") ?? "");
    }
  } catch {
    // Plain Base32 secrets are expected here.
  }

  return sanitizeBase32(trimmed);
}

function sanitizeBase32(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

function decodeBase32(value: string): Uint8Array {
  const bits: number[] = [];
  for (const char of value.replace(/=+$/g, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    for (let bit = 4; bit >= 0; bit -= 1) {
      bits.push((index >> bit) & 1);
    }
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return new Uint8Array(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function styles(): string {
  return `
    :host, * {
      box-sizing: border-box;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    .np-icon,
    .np-menu,
    .np-prompt,
    .np-notice {
      position: fixed;
      z-index: 2147483647;
      color: #142126;
      pointer-events: auto;
    }

    .np-icon {
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, .8);
      border-radius: 999px;
      background: rgba(255, 255, 255, .82);
      box-shadow: 0 8px 22px rgba(24, 41, 48, .18), inset 0 1px 0 rgba(255,255,255,.92);
      color: #0f6358;
      cursor: pointer;
      font-size: 13px;
      font-weight: 900;
      line-height: 1;
      padding: 0;
    }

    .np-menu {
      width: 320px;
      max-height: 338px;
      overflow: auto;
      border: 1px solid rgba(255, 255, 255, .78);
      border-radius: 18px;
      background: rgba(248, 252, 253, .94);
      box-shadow: 0 22px 62px rgba(24, 41, 48, .24), inset 0 1px 0 rgba(255,255,255,.96);
      backdrop-filter: blur(20px) saturate(1.3);
      -webkit-backdrop-filter: blur(20px) saturate(1.3);
      padding: 10px;
    }

    .np-menu header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 4px 4px 10px;
    }

    .np-menu header strong {
      font-size: 13px;
      font-weight: 900;
    }

    .np-menu header span,
    .np-empty span,
    .np-item small,
    .np-prompt span,
    .np-prompt small {
      overflow: hidden;
      color: #69777d;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .np-menu header span {
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
    }

    .np-list,
    .np-actions {
      display: grid;
      gap: 8px;
    }

    .np-actions {
      margin-top: 8px;
      border-top: 1px solid rgba(20, 33, 38, .08);
      padding-top: 8px;
    }

    .np-item,
    .np-actions button,
    .np-prompt button {
      border: 0;
      border-radius: 12px;
      background: rgba(255, 255, 255, .78);
      color: #142126;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }

    .np-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-height: 58px;
      padding: 10px;
      text-align: left;
    }

    .np-item:hover,
    .np-actions button:hover,
    .np-prompt button:hover {
      background: #fff;
    }

    .np-item span {
      display: grid;
      min-width: 0;
      gap: 2px;
    }

    .np-item strong {
      overflow: hidden;
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .np-item small {
      font-size: 12px;
      font-weight: 700;
    }

    .np-item em {
      color: #167467;
      font-size: 11px;
      font-style: normal;
      font-weight: 900;
      white-space: nowrap;
    }

    .np-actions button {
      min-height: 38px;
      padding: 0 12px;
      text-align: left;
    }

    .np-empty {
      display: grid;
      gap: 2px;
      min-height: 58px;
      place-content: center start;
      border-radius: 12px;
      background: rgba(255, 255, 255, .5);
      padding: 10px;
    }

    .np-empty strong {
      font-size: 13px;
    }

    .np-empty span {
      font-size: 12px;
    }

    .np-prompt {
      right: 16px;
      bottom: 16px;
      display: grid;
      width: 320px;
      gap: 12px;
      border: 1px solid rgba(255, 255, 255, .78);
      border-radius: 18px;
      background: rgba(248, 252, 253, .96);
      box-shadow: 0 22px 62px rgba(24, 41, 48, .26);
      padding: 14px;
    }

    .np-prompt div {
      display: grid;
      min-width: 0;
      gap: 3px;
    }

    .np-prompt strong {
      font-size: 14px;
      font-weight: 900;
    }

    .np-prompt footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .np-prompt button {
      min-height: 38px;
    }

    .np-prompt .primary {
      background: #167467;
      color: #fff;
    }

    .np-notice {
      right: 16px;
      bottom: 16px;
      border-radius: 999px;
      background: rgba(22, 116, 103, .94);
      box-shadow: 0 16px 40px rgba(24, 41, 48, .2);
      color: #fff;
      font-size: 13px;
      font-weight: 900;
      padding: 10px 14px;
    }
  `;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function sendMessage<T>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
