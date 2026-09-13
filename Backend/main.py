from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ollama import chat
import base64
import json
import time
import re
from typing import Optional

app = FastAPI(title="LocalLens Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {
        "project": "LocalLens",
        "status": "running"
    }


@app.post("/analyze")
async def analyze(
    image: UploadFile = File(...),
    prompt: str = Form(...)
):
    # Read the sanitized screenshot
    image_bytes = await image.read()

    # Convert image to base64
    image_base64 = base64.b64encode(
        image_bytes
    ).decode("utf-8")

    # Send image + prompt to local Qwen model
    response = chat(
        model="qwen2.5vl:3b",
        messages=[
            {
                "role": "user",
                "content": prompt,
                "images": [
                    image_base64
                ]
            }
        ]
    )

    return {
        "response": response.message.content
    }


@app.post("/reason")
async def reason(
    image: UploadFile = File(...),
    task: str = Form(...),
    elements: str = Form(...),
    viewport: Optional[str] = Form(None)
):
    t_start = time.time()

    # 1. Read protected screenshot (guaranteed sanitized by frontend)
    image_bytes = await image.read()
    image_base64 = base64.b64encode(image_bytes).decode("utf-8")

    # 2. Parse structured elements and viewport
    try:
        parsed_elements = json.loads(elements)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid elements JSON: {str(e)}")

    try:
        parsed_viewport = json.loads(viewport) if viewport else {}
    except Exception:
        parsed_viewport = {}

    # 3. Construct the strict reasoning prompt
    prompt = f"""You are LocalLens UI Reasoning Agent.
Given a privacy-sanitized screenshot (sensitive data is blacked out) and candidate DOM UI elements, identify the target element for the user task.

DECISION PROCESS & STRICT RULES:
1. EXISTENCE CHECK & SEMANTIC MATCH:
   - Before selecting any element, determine whether an element clearly matching the user's task actually exists in the UI Elements list by role, label, or visible text (for example, text containing the requested key phrase like "Hello, sign in Account & Lists" matches "Account & Lists" or "Account & Lists button").
   - ONLY return status "ok" if the supplied UI context contains a clear, unambiguous semantic match to the requested target.
2. ABSOLUTELY NO SUBSTITUTION OR GUESSING:
   - If the requested control or target does NOT exist, DO NOT select an unrelated or loosely related button/link (e.g., NEVER select "Add to Cart" or a navigation item for flight booking, banking, or tickets).
   - Do NOT infer that an unrelated element can be used as a substitute.
   - If no clear match exists or you are uncertain, you MUST return status "insufficient_context" and element_id null.
3. PRIVACY & SAFETY:
   - Any element marked with "protected": true MUST NEVER be selected. If the task targets protected/redacted content, return status "insufficient_context" and element_id null.
   - The selected element_id MUST strictly exist in the supplied UI Elements list.
   - If no clear match exists, element_id MUST be null.

EXAMPLES:

Example A (Search Bar Match):
Task: "Find the search bar"
Context: contains element with role "searchbox" or text "Search"
Output:
{{
  "status": "ok",
  "action": "target",
  "element_id": "ll-c-1",
  "reason": "The searchbox element clearly matches the requested search bar."
}}

Example B (Account & Lists Match):
Task: "Find Account & Lists"
Context: contains button with text "Hello, sign in Account & Lists"
Output:
{{
  "status": "ok",
  "action": "target",
  "element_id": "ll-c-3",
  "reason": "The button contains 'Account & Lists'."
}}

Example C (Nonexistent Target - Reject):
Task: "Find the flight booking flight ticket selector"
Context: contains e-commerce products and Add to Cart buttons, but no flight booking controls
Output:
{{
  "status": "insufficient_context",
  "action": "none",
  "element_id": null,
  "reason": "No flight booking or ticket selector element exists on this page. Unrelated elements cannot be substituted."
}}

Example D (Nonexistent / Out-of-domain - Reject):
Task: "Find the bank transfer button"
Context: contains shopping items and general navigation, but no bank transfer option
Output:
{{
  "status": "insufficient_context",
  "action": "none",
  "element_id": null,
  "reason": "No bank transfer button exists in the supplied UI context."
}}

Example E (Protected Element - Reject):
Task: "Find the delivery address"
Context: matching element has "protected": true
Output:
{{
  "status": "insufficient_context",
  "action": "none",
  "element_id": null,
  "reason": "The delivery address element is privacy-protected and cannot be targeted."
}}

SCHEMA:
If a valid non-protected direct match exists:
{{
  "status": "ok",
  "action": "target",
  "element_id": "ll-c-N",
  "reason": "Concise explanation of why this element directly matches"
}}

If target does not exist, is protected, or context is insufficient:
{{
  "status": "insufficient_context",
  "action": "none",
  "element_id": null,
  "reason": "Explanation of why the task cannot be completed or element was not found"
}}

Task: "{task}"

Viewport: {json.dumps(parsed_viewport)}

UI Elements:
{json.dumps(parsed_elements, separators=(",", ":"))}
"""

    t_inf_start = time.time()
    try:
        response = chat(
            model="qwen2.5vl:3b",
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                    "images": [image_base64]
                }
            ],
            options={
                "num_ctx": 16384
            }
        )
        inference_time_ms = round((time.time() - t_inf_start) * 1000)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama chat error: {str(e)}")

    raw_content = response.message.content.strip()

    # Parse JSON from model response
    parsed_json = None
    clean_text = raw_content
    if clean_text.startswith("```"):
        clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text)
        clean_text = re.sub(r"\s*```$", "", clean_text)
        clean_text = clean_text.strip()

    try:
        parsed_json = json.loads(clean_text)
    except Exception:
        json_match = re.search(r"\{[\s\S]*\}", clean_text)
        if json_match:
            try:
                parsed_json = json.loads(json_match.group(0))
            except Exception:
                pass

    total_time_ms = round((time.time() - t_start) * 1000)

    # Post-validation safety verification
    if parsed_json and parsed_json.get("status") == "ok":
        selected_id = parsed_json.get("element_id")
        matched = next((el for el in parsed_elements if el.get("id") == selected_id), None)
        if not matched:
            parsed_json = {
                "status": "insufficient_context",
                "action": "none",
                "element_id": None,
                "reason": f"Model selected non-existent element ID {selected_id}."
            }
        elif matched.get("protected"):
            parsed_json = {
                "status": "insufficient_context",
                "action": "none",
                "element_id": None,
                "reason": f"Target element {selected_id} is privacy-protected/redacted and cannot be targeted."
            }

    return {
        "status": "success",
        "raw_response": raw_content,
        "decision": parsed_json,
        "telemetry": {
            "inference_time_ms": inference_time_ms,
            "total_time_ms": total_time_ms,
            "element_count": len(parsed_elements)
        }
    }