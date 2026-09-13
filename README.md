# LocalLens

LocalLens is a privacy-preserving visual perception layer for browser AI agents. It enables multimodal models to perceive, reason about, and interact with web pages without ever exposing sensitive user data (such as passwords, credit cards, bank accounts, or PII) to the reasoning model or external endpoints.

---

## Architecture

LocalLens operates on a five-stage pipeline:

```
OBSERVE → PROTECT → REASON → ACT → VERIFY
```

1. **OBSERVE**: Extracts interactive and semantic DOM elements with exact viewport coordinates and captures the page view.
2. **PROTECT**: Local client-side privacy firewall identifies sensitive fields and redacts/masks them on an offscreen canvas before any screenshot leaves the browser.
3. **REASON**: Sends the sanitized screenshot and compressed, agent-ready DOM context to a local vision-language model to decide the next action.
4. **ACT**: Executes safe browser actions (such as clicking or typing) on grounded DOM elements while strictly enforcing privacy boundaries.
5. **VERIFY**: Confirms post-action state changes (e.g., verifying typed input values or detecting navigation and DOM updates) before proceeding.

---

## Project Structure

```text
LocalLens/
├── Backend/
│   └── main.py              # FastAPI server connecting to local Ollama (Qwen2.5-VL 3B)
├── extension/               # Chrome Extension (Manifest V3)
│   ├── manifest.json        # Extension manifest configuration
│   ├── popup/               # Popup UI (popup.html, popup.css, popup.js)
│   ├── offscreen/           # Offscreen document for canvas redaction & WebGPU
│   ├── libs/                # Local runtime libraries (Transformers.js, ONNX Runtime Web)
│   └── assets/              # Icons and extension assets
├── test-pages/
│   └── banking.html         # Test page with mock sensitive financial data
├── test.py                  # Standalone test script for Ollama Qwen2.5-VL inference
└── README.md
```

> **Extension Folder**: The Chrome extension source code resides in `extension/`.

---

## System Requirements

- **Operating System**: Windows or Linux
- **Python**: Python 3.10+ recommended
- **Browser**: Google Chrome (supporting Manifest V3)
- **Ollama**: Installed locally
- **Vision Model**: `qwen2.5vl:3b` pulled in Ollama
- **Hardware**: Dedicated GPU with WebGPU support recommended for fast client-side processing

---

## Setup from a Fresh Clone

### 1. Clone the Repository
```bash
git clone https://github.com/your-repo/LocalLens.git
cd LocalLens
```

### 2. Install Python Dependencies
```bash
pip install fastapi uvicorn python-multipart ollama
```

### 3. Pull the Vision Model with Ollama
Make sure Ollama is installed and running, then pull the model:
```bash
ollama pull qwen2.5vl:3b
```

### 4. Start Ollama
Ensure the Ollama service is active (either via the Ollama desktop app or terminal):
```bash
ollama serve
```

### 5. Start the FastAPI Backend
Run the backend server from the project root:
```bash
uvicorn Backend.main:app --reload --port 8000
```
The reasoning engine will now be listening on `http://127.0.0.1:8000`.

### 6. Load the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension/` directory from the LocalLens repository.

---

## Running the Demo Workflow

1. Open Google Chrome and navigate to a shopping page (e.g., [Amazon](https://www.amazon.com)).
2. Click the **LocalLens** extension icon in the Chrome toolbar to open the popup.
3. In the popup, scroll to the **Autonomous Demo Workflow** section.
4. Click **Run Demo: Search for "wireless headphones"**.
5. LocalLens will run through the 7-step pipeline:
   - Scan page and apply privacy firewall
   - Ground DOM elements and identify search bar using local Qwen2.5-VL
   - Type `"wireless headphones"` into the search input
   - Verify that the typed value matches
   - Re-scan page and locate the search submit button
   - Click the search button
   - Verify page navigation / search result transition

---

## Testing Privacy Redaction

To test the privacy firewall on sensitive data without visiting external sites:
1. Open [`test-pages/banking.html`](test-pages/banking.html) in Chrome.
2. Open the LocalLens extension popup.
3. Click **Capture Protected View**.
4. Observe that sensitive account numbers, balances, CVVs, and personal details are redacted before the image or context is processed.

---

## Local Reasoning

All visual reasoning is executed **100% locally**. The Chrome extension communicates with the local FastAPI backend (`http://127.0.0.1:8000/reason`), which queries the local Ollama instance running `qwen2.5vl:3b`. No screenshots, DOM content, or prompts are sent to external cloud APIs.

---

## Current Limitations

- **DOM-Based Privacy Detection**: Sensitive field detection is currently heuristic and DOM-attribute driven (identifying password fields, financial patterns, autocomplete tags, and specific selectors).
- **Supported Actions**: The action executor currently supports `click` and `type` actions.
- **Controlled Demo Workflow**: The current demo is a structured, verified multi-step workflow rather than an open-ended, fully autonomous browser agent loop.
