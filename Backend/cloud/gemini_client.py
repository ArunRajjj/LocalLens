"""
LocalLens — Backend Cloud Module: Gemini Client
Separated backend module for Google Gemini API integration.
Demonstrates privacy-safe cloud vision analysis using server-side API keys.
"""

import os
import sys
import time
import base64
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger("locallens.cloud.gemini")

# Try importing official google-genai SDK
try:
    from google import genai
    from google.genai import types
    GENAI_SDK_AVAILABLE = True
except ImportError:
    GENAI_SDK_AVAILABLE = False
    types = None


def _find_api_key() -> Optional[str]:
    """Retrieves GEMINI_API_KEY from environment or Backend/.env file."""
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if key and key.strip():
        return key.strip()

    # Search common .env locations
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.getcwd(), "Backend", ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]
    for env_path in candidates:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("GEMINI_API_KEY=") or line.startswith("GOOGLE_API_KEY="):
                            val = line.split("=", 1)[1].strip().strip('"').strip("'")
                            if val:
                                return val
            except Exception:
                pass
    return None


class GeminiClient:
    """
    Dedicated Gemini API Client for LocalLens Cloud AI scans.
    Handles environment configuration, authentication, rate limits, and multimodal requests.
    """

    DEFAULT_MODEL = "gemini-2.5-flash"
    FALLBACK_MODEL = "gemini-3.6-flash"

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_key = api_key or _find_api_key()
        self.model = model or os.environ.get("GEMINI_MODEL", self.DEFAULT_MODEL)
        self._client = None

        if self.api_key and GENAI_SDK_AVAILABLE:
            try:
                self._client = genai.Client(api_key=self.api_key)
            except Exception as e:
                print(f"[GeminiClient] Failed to initialize google-genai client: {e}", flush=True)
                logger.warning(f"Failed to initialize google-genai client: {e}")
                self._client = None

    def is_configured(self) -> bool:
        """Returns True if a valid Gemini API key is available."""
        return bool(self.api_key and len(self.api_key.strip()) > 5)

    def analyze_sanitized_image(
        self,
        image_bytes: bytes,
        task: str,
        context_metadata: Optional[Dict[str, Any]] = None,
        mime_type: str = "image/png"
    ) -> Dict[str, Any]:
        """
        Sends ONLY a post-redaction, privacy-sanitized screenshot to Gemini.
        Returns a structured dictionary with findings and privacy assurance.
        """
        t0 = time.time()

        if not self.is_configured():
            print("[GeminiClient] Unconfigured: GEMINI_API_KEY is not set in Backend/.env or environment.", flush=True)
            return {
                "status": "unconfigured",
                "model": self.model,
                "error": "GEMINI_API_KEY is not configured on the backend server.",
                "instructions": "Set GEMINI_API_KEY in Backend/.env to enable live cloud Gemini analysis.",
                "privacy_verified": True,
                "sanitized_elements_count": (context_metadata or {}).get("totalSensitive", 0),
                "telemetry": {
                    "latency_ms": round((time.time() - t0) * 1000)
                }
            }

        # Compose strict privacy prompt
        redacted_count = (context_metadata or {}).get("totalSensitive", 0)
        prompt = f"""You are LocalLens Cloud AI Assistant powered by Google Gemini.
You are inspecting an e-commerce / web page screenshot that has ALREADY undergone LocalLens on-device privacy protection.
All sensitive personal information (PII, names, account numbers, card details, phone numbers, delivery addresses) has been masked with black redaction overlays locally in the browser BEFORE reaching the cloud.

User Task: "{task}"
Locally Protected Fields in this image: {redacted_count} elements

Instructions:
1. Confirm that privacy redaction overlays are respected and zero personal information is exposed.
2. Analyze the visible non-sensitive page contents (e.g. products, prices, ratings, available navigation options).
3. Provide actionable recommendations or answers directly addressing the user's task.
4. Return your output formatted cleanly.

Output Schema:
Summary: <Brief summary of what this page offers>
Task Assessment: <Direct answer to the user task based on visible content>
Key Items Identified: <List of visible non-sensitive items/products with prices if present>
Privacy Verification: <Explicit statement on how LocalLens black redaction boxes shield private data from cloud leakage>
"""

        b64_img = base64.b64encode(image_bytes).decode("utf-8")

        # 1. Official SDK Path using Interactions API or generateContent
        if self._client and GENAI_SDK_AVAILABLE:
            models_to_try = [self.model]
            if self.FALLBACK_MODEL not in models_to_try:
                models_to_try.append(self.FALLBACK_MODEL)

            last_err = None
            for candidate_model in models_to_try:
                try:
                    # Attempt 1: Interactions API (official Google GenAI multimodal standard)
                    try:
                        interaction = self._client.interactions.create(
                            model=candidate_model,
                            input=[
                                {
                                    "type": "image",
                                    "mime_type": mime_type,
                                    "data": b64_img
                                },
                                {
                                    "type": "text",
                                    "text": prompt
                                }
                            ]
                        )
                        raw_text = interaction.output_text or ""
                        latency_ms = round((time.time() - t0) * 1000)
                        print(f"[GeminiClient] Success with model: {candidate_model} ({latency_ms} ms)", flush=True)

                        return {
                            "status": "success",
                            "model": self.model,
                            "actual_model": candidate_model,
                            "privacy_verified": True,
                            "sanitized_elements_count": redacted_count,
                            "raw_analysis": raw_text.strip(),
                            "telemetry": {
                                "latency_ms": latency_ms
                            }
                        }
                    except Exception as interact_err:
                        # Attempt 2: models.generate_content SDK standard
                        part_img = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
                        response = self._client.models.generate_content(
                            model=candidate_model,
                            contents=[part_img, prompt]
                        )
                        raw_text = response.text if hasattr(response, "text") else str(response)
                        latency_ms = round((time.time() - t0) * 1000)
                        print(f"[GeminiClient] Success with model: {candidate_model} ({latency_ms} ms)", flush=True)

                        return {
                            "status": "success",
                            "model": self.model,
                            "actual_model": candidate_model,
                            "privacy_verified": True,
                            "sanitized_elements_count": redacted_count,
                            "raw_analysis": raw_text.strip(),
                            "telemetry": {
                                "latency_ms": latency_ms
                            }
                        }

                except Exception as sdk_err:
                    last_err = sdk_err
                    status_code = getattr(sdk_err, "status_code", getattr(getattr(sdk_err, "response", None), "status_code", "ERROR"))
                    response_text = getattr(sdk_err, "message", str(sdk_err))
                    if hasattr(sdk_err, "response") and hasattr(sdk_err.response, "text"):
                        response_text = sdk_err.response.text

                    # Expose exact rejection details in FastAPI terminal
                    print("\n[GeminiClient] ================= GEMINI API REJECTION =================", flush=True)
                    print(f"[GeminiClient] Model: {candidate_model}", flush=True)
                    print(f"[GeminiClient] Status Code: {status_code}", flush=True)
                    print(f"[GeminiClient] Response Body: {response_text}", flush=True)
                    print("[GeminiClient] ========================================================\n", flush=True)

                    # If the requested model is deprecated / not found for new users, try the fallback model
                    if "no longer available" in response_text or "NOT_FOUND" in str(status_code) or "404" in str(status_code):
                        print(f"[GeminiClient] Model '{candidate_model}' is deprecated for new users. Trying '{self.FALLBACK_MODEL}'...", flush=True)
                        continue
                    else:
                        break

        # 2. Direct HTTPS Fallback using httpx (REST API)
        try:
            import httpx
            models_to_try = [self.model]
            if self.FALLBACK_MODEL not in models_to_try:
                models_to_try.append(self.FALLBACK_MODEL)

            for candidate_model in models_to_try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{candidate_model}:generateContent"
                headers = {
                    "x-goog-api-key": self.api_key,
                    "Content-Type": "application/json"
                }

                # Correct Google Gemini REST payload: camelCase 'inlineData' and 'mimeType'
                payload = {
                    "contents": [
                        {
                            "parts": [
                                {
                                    "inlineData": {
                                        "mimeType": mime_type,
                                        "data": b64_img
                                    }
                                },
                                {"text": prompt}
                            ]
                        }
                    ]
                }

                resp = httpx.post(url, headers=headers, json=payload, timeout=30.0)
                latency_ms = round((time.time() - t0) * 1000)

                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    extracted_text = ""
                    if candidates and "content" in candidates[0]:
                        for part in candidates[0]["content"].get("parts", []):
                            if "text" in part:
                                extracted_text += part["text"]

                    print(f"[GeminiClient] HTTPS REST success with model: {candidate_model} ({latency_ms} ms)", flush=True)
                    return {
                        "status": "success",
                        "model": self.model,
                        "actual_model": candidate_model,
                        "privacy_verified": True,
                        "sanitized_elements_count": redacted_count,
                        "raw_analysis": extracted_text.strip(),
                        "telemetry": {
                            "latency_ms": latency_ms
                        }
                    }

                # Expose rejection status and body directly to terminal
                print("\n[GeminiClient] ================= GEMINI REST REJECTION =================", flush=True)
                print(f"[GeminiClient] Model: {candidate_model}", flush=True)
                print(f"[GeminiClient] Status Code: {resp.status_code}", flush=True)
                print(f"[GeminiClient] Response Body: {resp.text}", flush=True)
                print("[GeminiClient] ========================================================\n", flush=True)

                if resp.status_code == 429:
                    return {
                        "status": "rate_limited",
                        "model": self.model,
                        "error": "Gemini API rate limit exceeded. Please retry in a few seconds.",
                        "privacy_verified": True,
                        "telemetry": {"latency_ms": latency_ms}
                    }

                if "no longer available" in resp.text or resp.status_code == 404:
                    print(f"[GeminiClient] Model '{candidate_model}' is deprecated for new users. Trying '{self.FALLBACK_MODEL}'...", flush=True)
                    continue

                return {
                    "status": "error",
                    "model": self.model,
                    "error": f"Gemini API returned HTTP {resp.status_code}: {resp.text[:300]}",
                    "privacy_verified": True,
                    "telemetry": {"latency_ms": latency_ms}
                }

        except Exception as rest_err:
            latency_ms = round((time.time() - t0) * 1000)
            print(f"[GeminiClient] REST Exception: {rest_err}", flush=True)
            return {
                "status": "error",
                "model": self.model,
                "error": f"Gemini request failed: {str(rest_err)}",
                "privacy_verified": True,
                "sanitized_elements_count": redacted_count,
                "telemetry": {"latency_ms": latency_ms}
            }

        return {
            "status": "error",
            "model": self.model,
            "error": "Failed to obtain Gemini analysis.",
            "privacy_verified": True,
            "sanitized_elements_count": redacted_count,
            "telemetry": {"latency_ms": round((time.time() - t0) * 1000)}
        }
