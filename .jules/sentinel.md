## 2026-04-10 - Insecure Randomness in Invite Code Generation
**Vulnerability:** The application used Math.random() for generating invite registration codes, which is cryptographically weak and predictable.
**Learning:** Standard Math.random() is inadequate for security-related generation like passwords or auth tokens as it is not cryptographically secure.
**Prevention:** Always use the built-in 'crypto' module in Node.js (crypto.randomInt or crypto.randomBytes) and 'window.crypto.getRandomValues' in the browser for generating sensitive codes or secrets.
