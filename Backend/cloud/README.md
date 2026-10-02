# Cloud Privacy Demonstration

This module provides a clearly separated Google Gemini Cloud AI integration for LocalLens, designed for independent architectural and privacy inspection by judges and developers.

---

## Privacy-Preserving Pipeline

```
Browser page
    │
    ▼
LocalLens privacy scan (on-device regex, heuristics & DOM tree analysis)
    │
    ▼
Local PII redaction (black overlay boxes placed over names, accounts, passwords, cards, addresses)
    │
    ▼
Sanitized screenshot (post-redaction visual frame only)
    │
    ▼
POST /cloud-scan (FastAPI Backend)
    │
    ▼
Gemini 2.5 Flash (Google Cloud AI)
    │
    ▼
Result displayed in LocalLens popup
```

---

## Security & Privacy Guarantees

1. **Server-Side API Key Security**:
   - The Gemini API key (`GEMINI_API_KEY`) is managed exclusively on the backend server environment.
   - It is never embedded in extension client bundles, never passed through Chrome extension messages, and never exposed in browser developer tools.

2. **Zero Raw PII Cloud Transmission**:
   - The raw, un-redacted webpage screenshot is **never** sent to Gemini or any cloud service.
   - All sensitive data is intercepted and masked on-device within the browser context before the screenshot is captured.

3. **Strict Sanitized Boundary**:
   - Only the privacy-sanitized screenshot (where personal information appears as solid black redaction blocks) and sanitized context metadata are transmitted to `/cloud-scan`.
   - The cloud model analyzes non-sensitive layout, product pricing, ratings, and navigation while remaining completely blind to private user credentials and identity.

---

## Module Structure

- **`gemini_client.py`**:
  - Encapsulates the Google Gemini API client (`google-genai` SDK with HTTPS fallback).
  - Handles environment keys (`GEMINI_API_KEY` / `GOOGLE_API_KEY`).
  - Manages multimodal requests, rate limiting (429), auth errors, and timeouts.

- **`cloud_scan.py`**:
  - Validates that incoming requests contain sanitized images.
  - Formats the privacy-aware prompt instructing Gemini to respect redaction boundaries.
  - Parses and returns structured insights for the LocalLens frontend.
