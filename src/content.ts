import type { ExtensionCredential, RuntimeMessage } from "./shared";

const BUTTON_CLASS = "np-fill-button";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CONFIRM_SAVE_MESSAGE = "Save this login to NoPassword?";

let lastFilledCredential: Pick<ExtensionCredential, "username" | "password"> | null = null;

mountFillButtons();
document.addEventListener("submit", captureSubmittedCredential, true);
void promptForStagedCredential();

function mountFillButtons() {
  const fillTargets = [
    ...Array.from(document.querySelectorAll<HTMLInputElement>("input[type='password']")),
    ...Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(isOtpInput),
  ];

  fillTargets.forEach((input) => {
    if (input.dataset.npMounted === "true") return;
    input.dataset.npMounted = "true";

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "NoPassword";
    button.addEventListener("click", () => fillForm(input));

    input.insertAdjacentElement("afterend", button);
  });
}

async function fillForm(input: HTMLInputElement) {
  const response = await sendMessage<{ items: ExtensionCredential[] }>({
    type: "GET_CREDENTIALS_FOR_URL",
    url: location.href,
  });
  const item = response.items[0];
  if (!item) return;

  const form = input.form ?? document;
  const passwordInput = form.querySelector<HTMLInputElement>("input[type='password']");
  const usernameInput = findUsernameInput(form);
  if (usernameInput) setInputValue(usernameInput, item.username);
  if (passwordInput) setInputValue(passwordInput, item.password);
  lastFilledCredential = { username: item.username, password: item.password };
  await fillOtpInputs(form, item);
}

function captureSubmittedCredential(event: Event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const passwordInput = form.querySelector<HTMLInputElement>("input[type='password']");
  if (!passwordInput?.value) return;
  const usernameInput = findUsernameInput(form);
  const username = usernameInput?.value ?? "";
  const password = passwordInput.value;

  if (lastFilledCredential?.username === username && lastFilledCredential.password === password) return;

  const item: ExtensionCredential = {
    id: crypto.randomUUID(),
    title: document.title || location.hostname,
    username,
    password,
    url: `${location.origin}${location.pathname}`,
    updatedAt: Date.now(),
  };

  void sendMessage({ type: "STAGE_CREDENTIAL", item });
}

async function promptForStagedCredential() {
  const response = await sendMessage<{ item: ExtensionCredential | null }>({
    type: "GET_STAGED_CREDENTIAL",
    url: location.href,
  }).catch(() => null);
  const item = response?.item;
  if (!item) return;

  if (window.confirm(CONFIRM_SAVE_MESSAGE)) {
    await sendMessage({ type: "SAVE_CREDENTIAL", item });
  }
  await sendMessage({ type: "DISCARD_STAGED_CREDENTIAL", id: item.id });
}

function findUsernameInput(root: ParentNode): HTMLInputElement | null {
  return (
    root.querySelector<HTMLInputElement>("input[autocomplete='username']") ??
    root.querySelector<HTMLInputElement>("input[type='email']") ??
    root.querySelector<HTMLInputElement>("input[type='text']")
  );
}

async function fillOtpInputs(root: ParentNode, item: ExtensionCredential) {
  if (!item.otpSecret) return;
  const totp = await generateTotp(item.otpSecret).catch(() => null);
  if (!totp) return;

  Array.from(root.querySelectorAll<HTMLInputElement>("input"))
    .filter(isOtpInput)
    .forEach((input) => setInputValue(input, totp.code));
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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function sendMessage<T>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
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

const style = document.createElement("style");
style.textContent = `
  .${BUTTON_CLASS} {
    margin-inline-start: 8px;
    min-height: 34px;
    border: 1px solid rgba(255,255,255,.68);
    border-radius: 999px;
    padding: 0 12px;
    color: #122126;
    background: rgba(255,255,255,.72);
    box-shadow: 0 10px 24px rgba(45,62,70,.16), inset 0 1px 0 rgba(255,255,255,.86);
    backdrop-filter: blur(18px) saturate(1.4);
    -webkit-backdrop-filter: blur(18px) saturate(1.4);
    font: 700 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
  }
`;
document.documentElement.append(style);

const observer = new MutationObserver(() => mountFillButtons());
observer.observe(document.documentElement, { childList: true, subtree: true });
