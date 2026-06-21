import type { ExtensionCredential, RuntimeMessage } from "./shared";
import { generateTotp } from "./totp";

const BUTTON_CLASS = "np-fill-button";

mountFillButtons();
document.addEventListener("submit", captureSubmittedCredential, true);

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
  await fillOtpInputs(form, item);
}

function captureSubmittedCredential(event: Event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const passwordInput = form.querySelector<HTMLInputElement>("input[type='password']");
  if (!passwordInput?.value) return;
  const usernameInput = findUsernameInput(form);

  const item: ExtensionCredential = {
    id: crypto.randomUUID(),
    title: document.title || location.hostname,
    username: usernameInput?.value ?? "",
    password: passwordInput.value,
    url: location.origin,
    updatedAt: Date.now(),
  };

  void sendMessage({ type: "SAVE_CREDENTIAL", item });
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
