from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from ollama import chat
import base64
import json
import time
import re
from typing import Optional, Union

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


@app.on_event("startup")
async def startup_warmup():
    """Warms up and preloads Qwen2.5-VL 3B into GPU memory on backend start, keeping it resident."""
    print("[LocalLens] Preloading and warming up Qwen2.5-VL 3B into GPU memory...")
    try:
        chat(
            model="qwen2.5vl:3b",
            messages=[{"role": "user", "content": "ping"}],
            options={"num_ctx": 16384, "num_predict": 1},
            keep_alive=-1
        )
        print("[LocalLens] Qwen2.5-VL 3B warmed up and locked in VRAM.")
    except Exception as e:
        print(f"[LocalLens] Warmup notice: {e}")


@app.get("/warmup")
def warmup():
    """Explicit warmup endpoint callable by frontend on initialization."""
    try:
        t0 = time.time()
        chat(
            model="qwen2.5vl:3b",
            messages=[{"role": "user", "content": "ping"}],
            options={"num_ctx": 16384, "num_predict": 1},
            keep_alive=-1
        )
        return {"status": "ready", "warmup_time_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


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
    viewport: Optional[str] = Form(None),
    history: Optional[str] = Form(None)
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

    parsed_history = []
    history_section = ""
    if history:
        try:
            parsed_history = json.loads(history)
            if parsed_history and isinstance(parsed_history, list):
                history_section = f"""
PREVIOUS ACTION HISTORY:
{json.dumps(parsed_history, indent=2)}

Use this history to avoid repeating already-completed steps and to decide if the task is finished.
"""
        except Exception:
            parsed_history = []

    # 3. Construct the strict reasoning prompt
    prompt = f"""You are LocalLens UI Reasoning Agent.
Given a privacy-sanitized screenshot (sensitive data is blacked out) and candidate DOM UI elements, determine the SINGLE next action to make progress towards the user's task.

DECISION PROCESS & STRICT RULES:
1. SINGLE NEXT ACTION:
   - Choose ONE next action only. Supported actions are "click", "type", "done", and "insufficient_context".
   - "click": Select a visible button, link, or product card to advance the task.
   - "type": Select an input or searchbox, and specify the exact text to enter in "text". Optionally set "press_enter": true if submission/search is needed.
   - "done": Return this if the user's task is ALREADY fully satisfied according to the current page state and action history. element_id must be null.
   - "insufficient_context": Return this if the required element does not exist, the target is protected, or the task cannot proceed. element_id must be null.
2. EXISTENCE CHECK & SEMANTIC MATCH:
   - The selected element_id MUST strictly exist in the supplied UI Elements list.
   - Do NOT invent or hallucinate element IDs.
   - Do NOT select an unrelated element as a substitute.
3. PRIVACY & SAFETY:
   - Any element marked with "protected": true MUST NEVER be selected. If the task requires interacting with protected/redacted content, return action "insufficient_context" and element_id null.

{history_section}

SCHEMA (return strictly valid JSON):
If an actionable non-protected element should be clicked or typed:
{{
  "status": "ok",
  "action": "click" | "type",
  "element_id": "ll-c-N",
  "text": "text to type if action is type, else omit",
  "press_enter": false,
  "reason": "Concise explanation of why this action is taken"
}}

If the task is already completed:
{{
  "status": "ok",
  "action": "done",
  "element_id": null,
  "reason": "Explanation of how the task has been fully accomplished"
}}

If target does not exist, is protected, or context is insufficient:
{{
  "status": "insufficient_context",
  "action": "insufficient_context",
  "element_id": null,
  "reason": "Explanation of why no valid action can be taken"
}}

Task: "{task}"

Viewport: {json.dumps(parsed_viewport)}

UI Elements:
{json.dumps(parsed_elements, separators=(",", ":"))}
"""

    t_inf_start = time.time()
    prep_time_ms = round((t_inf_start - t_start) * 1000)
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
                "num_ctx": 16384,
                "num_predict": 256
            },
            keep_alive=-1
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
    if parsed_json and isinstance(parsed_json, dict):
        act = str(parsed_json.get("action", "")).lower()
        if act in ["target", "click"]:
            parsed_json["action"] = "click"
        elif act in ["type", "input"]:
            parsed_json["action"] = "type"
        elif act in ["done", "complete", "completed"]:
            parsed_json["action"] = "done"
            parsed_json["status"] = "ok"
            parsed_json["element_id"] = None
        elif act in ["none", "insufficient", "insufficient_context"]:
            parsed_json["action"] = "insufficient_context"
            parsed_json["status"] = "insufficient_context"
            parsed_json["element_id"] = None

        if parsed_json.get("action") in ["click", "type"]:
            selected_id = parsed_json.get("element_id")
            matched = next((el for el in parsed_elements if el.get("id") == selected_id), None)
            if not matched:
                parsed_json = {
                    "status": "insufficient_context",
                    "action": "insufficient_context",
                    "element_id": None,
                    "reason": f"Model selected non-existent element ID {selected_id}."
                }
            elif matched.get("protected"):
                parsed_json = {
                    "status": "insufficient_context",
                    "action": "insufficient_context",
                    "element_id": None,
                    "reason": f"Target element {selected_id} is privacy-protected/redacted and cannot be targeted."
                }
            else:
                parsed_json["status"] = "ok"
                if "press_enter" in parsed_json:
                    parsed_json["press_enter"] = bool(parsed_json["press_enter"])
                if parsed_json.get("action") == "type" and "text" not in parsed_json:
                    parsed_json["text"] = ""

    return {
        "status": "success",
        "raw_response": raw_content,
        "decision": parsed_json,
        "telemetry": {
            "prep_time_ms": prep_time_ms,
            "inference_time_ms": inference_time_ms,
            "total_time_ms": total_time_ms,
            "element_count": len(parsed_elements)
        }
    }


@app.post("/compare")
async def compare(
    task: str = Form(...),
    products: str = Form(...)
):
    """Grounded product comparison endpoint.
    Receives compact DOM-grounded product metadata and asks Qwen to compare and rank
    strictly among the provided product IDs with zero hallucination.
    """
    t_start = time.time()
    try:
        parsed_products = json.loads(products)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid products JSON: {str(e)}")

    if not parsed_products:
        return {
            "status": "success",
            "decision": {
                "status": "insufficient_context",
                "recommended_id": None,
                "recommended_product": None,
                "reason": "No grounded products found on the current page to compare.",
                "ranking": []
            },
            "products_evaluated": 0,
            "telemetry": {"total_time_ms": 0, "inference_time_ms": 0}
        }

    # Format compact representation for Qwen
    compact_list = []
    product_map = {}
    for p in parsed_products:
        pid = p.get("id")
        if not pid:
            continue
        product_map[pid] = p
        item = {
            "id": pid,
            "name": p.get("name"),
            "price": p.get("price"),
            "rating": p.get("rating")
        }
        if p.get("review_summary"):
            item["review_summary"] = p.get("review_summary")
        if p.get("positive_themes"):
            item["positive_themes"] = p.get("positive_themes")
        if p.get("negative_themes"):
            item["negative_themes"] = p.get("negative_themes")
        compact_list.append(item)

    prompt = f"""You are LocalLens Product Comparison Agent.
Your task is to compare the available products and select the best recommendation matching the user's request.

STRICT GROUNDING & ZERO-HALLUCINATION RULES:
1. Grounded Source: You must ONLY evaluate the products provided in the list below.
2. DO NOT invent, hallucinate, or alter any product names, prices, ratings, or specifications.
3. Selection: Choose the single best product according to the user's task (e.g. best rating, lowest price, best value, or best based on reviews and customer feedback where provided).
4. When customer review themes are provided, factor them into qualitative evaluations.
5. The "recommended_id" MUST strictly match one of the product IDs in the provided list.
6. If the provided products do not match the task or if information is insufficient, return status "insufficient_context" and recommended_id null.

SCHEMA (return strictly valid JSON):
{{
  "status": "ok",
  "recommended_id": "prod-X",
  "reason": "Clear explanation of why this product is selected based on its actual price, rating, and customer review evidence",
  "ranking": [
    {{
      "rank": 1,
      "id": "prod-X",
      "reason": "Brief rationale for this rank"
    }}
  ]
}}

If context is insufficient:
{{
  "status": "insufficient_context",
  "recommended_id": null,
  "reason": "Explanation of why no matching products could be recommended",
  "ranking": []
}}

User Task: "{task}"

Available Products:
{json.dumps(compact_list, indent=2)}
"""

    t_inf_start = time.time()
    try:
        response = chat(
            model="qwen2.5vl:3b",
            messages=[{"role": "user", "content": prompt}],
            options={"num_ctx": 16384, "num_predict": 512},
            keep_alive=-1
        )
        inference_time_ms = round((time.time() - t_inf_start) * 1000)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama chat error: {str(e)}")

    raw_content = response.message.content.strip()
    clean_text = raw_content
    if clean_text.startswith("```"):
        clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text)
        clean_text = re.sub(r"\s*```$", "", clean_text)
        clean_text = clean_text.strip()

    parsed_json = None
    try:
        parsed_json = json.loads(clean_text)
    except Exception:
        json_match = re.search(r"\{[\s\S]*\}", clean_text)
        if json_match:
            try:
                parsed_json = json.loads(json_match.group(0))
            except Exception:
                pass

    if not parsed_json or not isinstance(parsed_json, dict):
        parsed_json = {
            "status": "insufficient_context",
            "recommended_id": None,
            "reason": "Failed to parse model response as structured JSON.",
            "ranking": []
        }

    # Deterministic Objective Criteria Enforcement (Rule 6):
    # If the user explicitly requested an objective criterion ("cheapest" or "highest rated"),
    # and the model found valid context, ensure the deterministic numeric winner is strictly selected.
    if parsed_json.get("status") != "insufficient_context":
        task_lower = task.lower()
        is_cheapest = any(w in task_lower for w in ["cheapest", "lowest price", "least expensive", "minimum price", "budget"])
        is_highest_rated = any(w in task_lower for w in ["highest-rated", "highest rated", "top rated", "top-rated", "best rating", "highest rating", "best rated"])

        if is_cheapest:
            prods_with_price = []
            for p in parsed_products:
                pnum = p.get("price_num")
                if pnum is None:
                    pstr = str(p.get("price", ""))
                    m = re.search(r"(\d+(?:\.\d+)?)", pstr.replace(",", ""))
                    if m:
                        try:
                            pnum = float(m.group(1))
                        except Exception:
                            pass
                if pnum is not None:
                    prods_with_price.append((pnum, p))
            if prods_with_price:
                prods_with_price.sort(key=lambda x: x[0])
                winner = prods_with_price[0][1]
                parsed_json["recommended_id"] = winner.get("id")
                parsed_json["reason"] = f"Deterministic objective selection: {winner.get('name')} has the lowest numeric price ({winner.get('price')})."

        elif is_highest_rated:
            prods_with_rating = []
            for p in parsed_products:
                rnum = p.get("rating_num")
                if rnum is None:
                    rstr = str(p.get("rating", ""))
                    m = re.search(r"(\d+(?:\.\d+)?)", rstr)
                    if m:
                        try:
                            rnum = float(m.group(1))
                        except Exception:
                            pass
                if rnum is not None:
                    prods_with_rating.append((rnum, p))
            if prods_with_rating:
                prods_with_rating.sort(key=lambda x: x[0], reverse=True)
                winner = prods_with_rating[0][1]
                parsed_json["recommended_id"] = winner.get("id")
                parsed_json["reason"] = f"Deterministic objective selection: {winner.get('name')} has the highest numeric rating ({winner.get('rating')})."

    # Hallucination & Grounding Guard:
    rec_id = parsed_json.get("recommended_id")
    if rec_id and rec_id in product_map:
        rec_product = product_map[rec_id]
        parsed_json["recommended_product"] = {
            "id": rec_id,
            "name": rec_product.get("name"),
            "price": rec_product.get("price"),
            "rating": rec_product.get("rating"),
            "element_id": rec_product.get("element_id"),
            "has_direct_cart": rec_product.get("has_direct_cart", True),
            "detail_link_id": rec_product.get("detail_link_id"),
            "review_summary": rec_product.get("review_summary"),
            "positive_themes": rec_product.get("positive_themes"),
            "negative_themes": rec_product.get("negative_themes")
        }
        parsed_json["status"] = "ok"
    else:
        parsed_json["status"] = "insufficient_context"
        parsed_json["recommended_id"] = None
        parsed_json["recommended_product"] = None
        if not parsed_json.get("reason"):
            parsed_json["reason"] = f"Model recommended invalid or hallucinated ID: '{rec_id}'."

    # Validate ranking IDs
    valid_ranking = []
    for r in parsed_json.get("ranking", []):
        rid = r.get("id")
        if rid in product_map:
            prod_info = product_map[rid]
            valid_ranking.append({
                "rank": r.get("rank", len(valid_ranking) + 1),
                "id": rid,
                "name": prod_info.get("name"),
                "price": prod_info.get("price"),
                "rating": prod_info.get("rating"),
                "element_id": prod_info.get("element_id"),
                "has_direct_cart": prod_info.get("has_direct_cart", True),
                "detail_link_id": prod_info.get("detail_link_id"),
                "review_summary": prod_info.get("review_summary"),
                "positive_themes": prod_info.get("positive_themes"),
                "negative_themes": prod_info.get("negative_themes"),
                "reason": r.get("reason", "")
            })
    parsed_json["ranking"] = valid_ranking

    total_time_ms = round((time.time() - t_start) * 1000)

    return {
        "status": "success",
        "raw_response": raw_content,
        "decision": parsed_json,
        "products_evaluated": len(compact_list),
        "telemetry": {
            "inference_time_ms": inference_time_ms,
            "total_time_ms": total_time_ms
        }
    }


# ==========================================
# Generic Product Customer Review Summarizer
# ==========================================
@app.post("/summarize_reviews")
async def summarize_reviews(
    product_name: str = Form(...),
    reviews: str = Form(...),
    rating: Optional[str] = Form(None)
):
    t_start = time.time()

    # 1. Parse reviews input (JSON array of strings or list of review objects)
    parsed_reviews = []
    try:
        loaded = json.loads(reviews)
        if isinstance(loaded, list):
            for item in loaded:
                if isinstance(item, str) and item.strip():
                    parsed_reviews.append(item.strip())
                elif isinstance(item, dict) and item.get("text"):
                    parsed_reviews.append(str(item["text"]).strip())
        elif isinstance(loaded, str) and loaded.strip():
            parsed_reviews = [loaded.strip()]
    except Exception:
        for line in reviews.split("\n"):
            line = line.strip()
            if line:
                parsed_reviews.append(line)

    # Bound review input to max 10 reviews and max 300 chars each
    parsed_reviews = [r[:300] for r in parsed_reviews[:10]]

    if not parsed_reviews:
        return {
            "status": "reviews_unavailable",
            "product_name": product_name,
            "positive_themes": [],
            "negative_themes": [],
            "summary": "No customer review content available for this product.",
            "confidence": "low",
            "telemetry": {
                "inference_time_ms": 0,
                "total_time_ms": round((time.time() - t_start) * 1000)
            }
        }

    reviews_text = "\n".join([f"- {r}" for r in parsed_reviews])
    rating_context = f"Aggregate Rating: {rating}\n" if rating else ""

    prompt = f"""You are LocalLens Product Review Summarizer.
Analyze the following customer review snippets for "{product_name}".
Extract the key positive themes, negative themes, and a concise overall summary.

STRICT RULES:
1. Use ONLY facts, sentiments, and experiences mentioned in the provided review snippets.
2. DO NOT hallucinate or invent features, defects, or praise not supported by the snippets.
3. Keep themes concise (short phrases) and synthesize a 1-2 sentence neutral summary.
4. Set confidence to "high" (if 3+ detailed reviews with consistent themes), "medium" (if 1-2 reviews), or "low" (if vague/conflicting).

SCHEMA (return strictly valid JSON):
{{
  "status": "ok",
  "positive_themes": ["Clear pro/praise 1", "Clear pro/praise 2"],
  "negative_themes": ["Clear con/criticism 1"],
  "summary": "Concise 1-2 sentence balanced summary of customer feedback.",
  "confidence": "high"
}}

If the snippets are empty, irrelevant, or not reviews:
{{
  "status": "reviews_unavailable",
  "positive_themes": [],
  "negative_themes": [],
  "summary": "Customer review content is insufficient or unavailable.",
  "confidence": "low"
}}

Product: {product_name}
{rating_context}
Customer Review Snippets:
{reviews_text}
"""

    t_inf_start = time.time()
    try:
        response = chat(
            model="qwen2.5vl:3b",
            messages=[{"role": "user", "content": prompt}],
            options={"num_ctx": 4096, "num_predict": 384},
            keep_alive=-1
        )
        inference_time_ms = round((time.time() - t_inf_start) * 1000)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama chat error: {str(e)}")

    raw_content = response.message.content.strip()
    clean_text = raw_content
    if clean_text.startswith("```"):
        clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text)
        clean_text = re.sub(r"\s*```$", "", clean_text)
        clean_text = clean_text.strip()

    parsed_json = None
    try:
        parsed_json = json.loads(clean_text)
    except Exception:
        json_match = re.search(r"\{[\s\S]*\}", clean_text)
        if json_match:
            try:
                parsed_json = json.loads(json_match.group(0))
            except Exception:
                pass

    if not parsed_json or not isinstance(parsed_json, dict):
        parsed_json = {
            "status": "reviews_unavailable",
            "positive_themes": [],
            "negative_themes": [],
            "summary": "Could not parse review summary from model output.",
            "confidence": "low"
        }

    total_time_ms = round((time.time() - t_start) * 1000)

    return {
        "status": parsed_json.get("status", "ok"),
        "product_name": product_name,
        "positive_themes": parsed_json.get("positive_themes", []),
        "negative_themes": parsed_json.get("negative_themes", []),
        "summary": parsed_json.get("summary", ""),
        "confidence": parsed_json.get("confidence", "medium"),
        "reviews_count": len(parsed_reviews),
        "telemetry": {
            "inference_time_ms": inference_time_ms,
            "total_time_ms": total_time_ms
        }
    }


# ==========================================
# Cloud Privacy Demonstration: Gemini 2.5 Flash
# ==========================================
@app.post("/cloud-scan")
async def cloud_scan_endpoint(
    request: Request
):
    """
    Dedicated privacy-preserving cloud scan endpoint.
    Transmits only post-redaction, privacy-sanitized screenshots to Gemini.
    Seamlessly handles multipart/form-data, application/x-www-form-urlencoded, and application/json.
    """
    from cloud.cloud_scan import run_cloud_scan

    content_type = request.headers.get("content-type", "")
    image_str = ""
    task_str = "Analyze page contents and identify key actions."
    context_str = None

    if "application/json" in content_type:
        try:
            body = await request.json()
            image_str = body.get("image", "")
            task_str = body.get("task", task_str)
            context_str = body.get("context")
            if isinstance(context_str, dict):
                context_str = json.dumps(context_str)
        except Exception as e:
            print(f"[cloud-scan] Error parsing JSON: {e}", flush=True)
            raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {str(e)}")
    else:
        try:
            form = await request.form()
            img_val = form.get("image")
            if hasattr(img_val, "read"):
                raw_bytes = await img_val.read()
                image_str = base64.b64encode(raw_bytes).decode("utf-8")
            elif isinstance(img_val, str):
                image_str = img_val
            task_str = form.get("task", task_str)
            context_str = form.get("context")
        except Exception as e:
            print(f"[cloud-scan] Form parse notice, trying body fallback: {e}", flush=True)
            try:
                raw = await request.body()
                body = json.loads(raw.decode("utf-8"))
                image_str = body.get("image", "")
                task_str = body.get("task", task_str)
                context_str = body.get("context")
                if isinstance(context_str, dict):
                    context_str = json.dumps(context_str)
            except Exception:
                raise HTTPException(status_code=400, detail=f"Invalid request payload: {str(e)}")

    if not image_str:
        print("[cloud-scan] Rejection: Missing required 'image' parameter", flush=True)
        raise HTTPException(status_code=400, detail="Missing required 'image' parameter.")

    return await run_cloud_scan(
        image_base64=image_str,
        task=task_str,
        context_data=context_str
    )

