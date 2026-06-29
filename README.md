# NoPassword Browser Extension

Chromium MV3 client for NoPassword.

## Scope

- Popup vault surface focused on the current tab, matching logins, editing, generation, and fill controls.
- Content script field menu, form detection, password fill, OTP fill, password generation, and save/update prompt.
- Background service worker storage, active-tab fill routing, and settings plumbing.
- Passkey bridge capability probe for future WebAuthn provider work.

## Commands

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension in Chromium-based browsers.
