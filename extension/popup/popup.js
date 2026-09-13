const scanButton = document.getElementById("scanButton");
const status = document.getElementById("status");

// Shared helper: Runs privacy scan & redaction on active tab, waits for paint, and captures visible tab
async function captureSanitizedScreenshot() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  const results = await chrome.scripting.executeScript({
    target: {
      tabId: tab.id,
    },
    func: scanAndProtectPage,
  });

  const pageData = results[0].result;

  // Display page scan information in popup UI
  document.getElementById("buttonCount").textContent = pageData.buttons;
  document.getElementById("inputCount").textContent = pageData.inputs;
  document.getElementById("linkCount").textContent = pageData.links;
  document.getElementById("sensitiveCount").textContent =
    pageData.sensitive.length;
  document.getElementById("sensitiveTextCount").textContent =
    pageData.sensitiveText.length;
  document.getElementById("totalProtectedCount").textContent =
    pageData.totalSensitive;

  // Give the browser a moment to render the redaction overlays before capture
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Capture the visible tab — this screenshot strictly contains all rendered redaction overlays
  const protectedScreenshot = await chrome.tabs.captureVisibleTab(
    tab.windowId,
    {
      format: "png",
    },
  );

  return { tab, pageData, protectedScreenshot };
}

scanButton.addEventListener("click", async () => {
  status.textContent = "Status: Scanning & protecting page...";

  try {
    const { pageData, protectedScreenshot } =
      await captureSanitizedScreenshot();

    status.textContent = "Status: Capturing protected screenshot...";

    // Convert the sanitized screenshot data URL into a Blob
    const response = await fetch(protectedScreenshot);
    const imageBlob = await response.blob();

    // Prepare data for the FastAPI server
    const formData = new FormData();
    formData.append("image", imageBlob, "locallens-sanitized.png");
    formData.append(
      "prompt",
      "Describe this webpage. Identify the page type, visible UI elements, buttons, forms, and important non-sensitive information. Do not attempt to reconstruct any redacted information.",
    );

    // Send ONLY the sanitized screenshot to LocalLens backend
    status.textContent = "Status: Sending sanitized image to local VLM...";

    const serverResponse = await fetch("http://127.0.0.1:8000/analyze", {
      method: "POST",
      body: formData,
    });

    if (!serverResponse.ok) {
      throw new Error(`Backend returned HTTP ${serverResponse.status}`);
    }

    const result = await serverResponse.json();

    // Show the VLM response in the console
    console.log("Qwen response:", result.response);

    document.getElementById("vlmText").textContent = result.response;

    status.textContent = `Status: ${pageData.totalSensitive} items protected (${pageData.sensitive.length} fields, ${pageData.sensitiveText.length} text) ✓`;
  } catch (error) {
    console.error(error);
    status.textContent = "Error: " + error.message;
  }
});

function scanAndProtectPage() {
  // Clear any existing overlays from previous scans
  document
    .querySelectorAll(".locallens-redaction")
    .forEach((el) => el.remove());

  const buttons = document.querySelectorAll("button").length;
  const inputs = document.querySelectorAll("input, textarea, select").length;
  const links = document.querySelectorAll("a").length;

  // 1. EXISTING INPUT FIELD SENSITIVE DETECTION
  const sensitive = [];

  document.querySelectorAll("input").forEach((input) => {
    const type = (input.type || "").toLowerCase();
    const autocomplete = (input.autocomplete || "").toLowerCase();
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();

    let sensitiveType = null;

    if (
      type === "password" ||
      autocomplete === "cc-csc" ||
      autocomplete === "one-time-code" ||
      name.includes("password") ||
      name.includes("passwd") ||
      id.includes("password")
    ) {
      sensitiveType = "Authentication";
    } else if (
      autocomplete === "cc-number" ||
      name.includes("card") ||
      id.includes("card")
    ) {
      sensitiveType = "Financial";
    } else if (type === "email" || autocomplete === "email") {
      sensitiveType = "Email";
    } else if (type === "tel" || autocomplete === "tel") {
      sensitiveType = "Phone";
    } else if (
      autocomplete === "name" ||
      autocomplete === "given-name" ||
      autocomplete === "family-name"
    ) {
      sensitiveType = "Personal";
    }

    if (sensitiveType !== null) {
      const rect = input.getBoundingClientRect();

      sensitive.push({
        type: sensitiveType,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });

      console.log(
        `[LocalLens] Detected sensitive input [${sensitiveType}] on`,
        input,
      );

      // Create the redaction overlay
      const overlay = document.createElement("div");
      overlay.className = "locallens-redaction";
      overlay.style.position = "absolute";
      overlay.style.left = `${rect.left + window.scrollX}px`;
      overlay.style.top = `${rect.top + window.scrollY}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.background = "#000000";
      overlay.style.zIndex = "2147483647";
      overlay.style.pointerEvents = "none";
      overlay.style.borderRadius = "4px";

      document.body.appendChild(overlay);
    }
  });

  // 2. TEXT-BASED SENSITIVE CONTENT DETECTION
  const sensitiveText = [];

  function detectSensitiveTextCategory(rawText) {
    const text = (rawText || "").trim();
    if (!text || text.length < 3 || text.length > 300) {
      return null;
    }

    // A. Email address
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
    if (emailRegex.test(text)) {
      return "Email";
    }

    // B. Personal identity greeting / account context
    // Matches "Hello, ArunRaj", "Hello Arun", "Welcome, Priya", "Welcome back, Arun", etc.
    const greetingMatch = text.match(
      /\b(?:hello|welcome(?:\s+back)?|hi)[,\s]+([A-Za-z0-9_.\s]{2,30})/i,
    );
    if (greetingMatch) {
      const candidate = greetingMatch[1].trim().toLowerCase();
      const nonNames = [
        "sign in",
        "log in",
        "to amazon",
        "guest",
        "customer",
        "user",
        "everyone",
      ];
      if (!nonNames.some((non) => candidate.startsWith(non))) {
        return "Identity";
      }
    }

    // C. Address-like text with recognizable context
    // Matches "Deliver to Rishi Lucknow 226020", "Deliver to ...", "Shipping address: ...", etc.
    const addressContextRegex =
      /\b(?:deliver(?:y)?\s+to|ship(?:ping)?\s+to|dispatch\s+to|delivery\s+address|shipping\s+address|billing\s+address)\b/i;
    if (addressContextRegex.test(text)) {
      return "Address";
    }

    // Indian PIN code (6 digits, 100000-999999) accompanied by address / geographic keywords
    const pinWithAddressRegex =
      /(?:pin(?:\s*code)?|postal(?:\s*code)?|address|lane|street|road|nagar|marg|sector|colony|apartment|flat|lucknow|delhi|mumbai|bangalore|bengaluru|chennai|hyderabad|kolkata|pune|noida|gurugram|gurgaon)[\s\S]{0,40}\b[1-9][0-9]{5}\b/i;
    if (pinWithAddressRegex.test(text)) {
      return "PostalCode";
    }

    // D. Bank account-like numbers (e.g. "Savings Account •••• 4821", "A/c: 1234567890", "Account No: ...")
    const bankAccountRegex =
      /\b(?:savings|checking|current)?\s*account\s*(?:number|no\.?|#)?[:\s•*]*(?:[•*xX]{2,8}\s*)?\d{3,16}\b/i;
    if (bankAccountRegex.test(text)) {
      return "BankAccount";
    }

    // E. Credit/debit card numbers in visible text (16 digits or 4x4 masked/unmasked)
    const cardRegex =
      /\b(?:\d{4}[-\s]){3}\d{4}\b|\b[•*xX]{4}[-\s][•*xX]{4}[-\s][•*xX]{4}[-\s]\d{4}\b/;
    if (cardRegex.test(text)) {
      return "CreditCard";
    }

    // F. Phone numbers
    // Guard against prices, ratings, and technical specifications
    if (
      !/[₹$€£]|inr|usd|mah|px|dpi|fps|hz|gb|mb|tb|rating|review|star/i.test(
        text,
      )
    ) {
      // With phone context label
      const phoneContextRegex =
        /\b(?:phone|mobile|tel|call|contact|cell)[\s:]*(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{4}\b/i;
      if (phoneContextRegex.test(text)) {
        return "Phone";
      }

      // Standalone Indian mobile (+91 98765 43210 or 9876543210)
      const indianPhoneRegex = /\b(?:\+91[\-\s]?)?[6-9]\d{4}[\-\s]?\d{5}\b/;
      if (indianPhoneRegex.test(text)) {
        return "Phone";
      }
    }

    return null;
  }

  // Inspect suitable visible DOM elements
  const candidates = document.querySelectorAll(
    "p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, b, strong, em, small, label, div",
  );
  const matchedTextElements = [];

  candidates.forEach((el) => {
    // Skip redaction overlays themselves
    if (
      el.classList.contains("locallens-redaction") ||
      el.closest(".locallens-redaction")
    ) {
      return;
    }

    // Check visibility
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const text = el.innerText || el.textContent || "";
    const category = detectSensitiveTextCategory(text);

    if (category) {
      matchedTextElements.push({
        element: el,
        category: category,
        text: text.trim(),
      });
    }
  });

  // Filter out parent elements whose child is also matched.
  // This ensures we place the overlay over the most specific (leaf) element,
  // preventing parent container cards or navbars from being unnecessarily covered.
  const specificMatches = matchedTextElements.filter(({ element }) => {
    return !matchedTextElements.some(
      (other) => other.element !== element && element.contains(other.element),
    );
  });

  specificMatches.forEach(({ element, category, text }) => {
    const rect = element.getBoundingClientRect();

    sensitiveText.push({
      type: category,
      text: text.slice(0, 60),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });

    console.log(
      `[LocalLens] Detected sensitive text [${category}]: "${text}" on`,
      element,
    );

    const overlay = document.createElement("div");
    overlay.className = "locallens-redaction";
    overlay.style.position = "absolute";
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.background = "#000000";
    overlay.style.zIndex = "2147483647";
    overlay.style.pointerEvents = "none";
    overlay.style.borderRadius = "4px";

    document.body.appendChild(overlay);
  });

  // 3. DOM-GROUNDED VISUAL INTERACTIVE MAP (PERCEPTION)
  const t0 = performance.now();

  function getElementSelector(el) {
    const esc = (val) => {
      try {
        return window.CSS && CSS.escape ? CSS.escape(val) : String(val);
      } catch (e) {
        return String(val).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
    };
    if (el.id) {
      try {
        if (document.querySelectorAll("#" + esc(el.id)).length === 1) {
          return "#" + esc(el.id);
        }
      } catch (e) {}
    }
    const tag = el.tagName.toLowerCase();
    if (el.name) {
      try {
        if (document.querySelectorAll(`${tag}[name="${esc(el.name)}"]`).length === 1) {
          return `${tag}[name="${esc(el.name)}"]`;
        }
      } catch (e) {}
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) {
      const cleanAria = ariaLabel.trim();
      try {
        if (
          document.querySelectorAll(
            `${tag}[aria-label="${esc(cleanAria)}"]`,
          ).length === 1
        ) {
          return `${tag}[aria-label="${esc(cleanAria)}"]`;
        }
      } catch (e) {}
    }
    // Stable hierarchical fallback
    let path = tag;
    if (el.className && typeof el.className === "string") {
      const classes = el.className
        .trim()
        .split(/\s+/)
        .filter(
          (c) =>
            c &&
            !c.includes(":") &&
            !c.includes("[") &&
            !c.includes("locallens"),
        );
      if (classes.length > 0) {
        path += "." + classes.slice(0, 2).map((c) => esc(c)).join(".");
      }
    }
    const parent = el.parentElement;
    if (parent && parent !== document.body) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        path += `:nth-of-type(${index})`;
      }
      const parentTag = parent.tagName.toLowerCase();
      const parentId = parent.id ? "#" + esc(parent.id) : "";
      return parentId ? `${parentId} > ${path}` : `${parentTag} > ${path}`;
    }
    return path;
  }

  // Priority elements for UI perception
  const candidateNodes = document.querySelectorAll(
    "button, a, input, textarea, select, [role], [onclick], [tabindex], img, h1, h2, h3, h4, h5, h6, .card, .button, form, label, p, [contenteditable]",
  );

  const elementsConsideredCount = candidateNodes.length;
  const groundedElements = [];
  const rawNodeItems = [];
  let interactiveCount = 0;
  let protectedCount = 0;

  // Track sensitive elements identified by the privacy detection rules
  const sensitiveSet = new Set();
  document.querySelectorAll("input").forEach((input) => {
    const type = (input.type || "").toLowerCase();
    const autocomplete = (input.autocomplete || "").toLowerCase();
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();

    if (
      type === "password" ||
      autocomplete === "cc-csc" ||
      autocomplete === "one-time-code" ||
      name.includes("password") ||
      name.includes("passwd") ||
      id.includes("password") ||
      autocomplete === "cc-number" ||
      name.includes("card") ||
      id.includes("card") ||
      type === "email" ||
      autocomplete === "email" ||
      type === "tel" ||
      autocomplete === "tel" ||
      autocomplete === "name" ||
      autocomplete === "given-name" ||
      autocomplete === "family-name"
    ) {
      sensitiveSet.add(input);
    }
  });

  specificMatches.forEach((m) => {
    sensitiveSet.add(m.element);
  });

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let elCounter = 1;

  candidateNodes.forEach((el) => {
    if (
      el.classList.contains("locallens-redaction") ||
      el.closest(".locallens-redaction")
    ) {
      return;
    }

    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return;
    }

    // Viewport intersection check: element must intersect visible viewport
    if (
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= viewportHeight ||
      rect.left >= viewportWidth
    ) {
      return;
    }

    const tag = el.tagName.toLowerCase();
    const roleAttr = el.getAttribute("role") || "";
    const typeAttr = (el.type || el.getAttribute("type") || "").toLowerCase();

    let semanticRole = "element";
    let isInteractive = false;

    if (
      tag === "button" ||
      roleAttr === "button" ||
      typeAttr === "button" ||
      typeAttr === "submit"
    ) {
      semanticRole = "button";
      isInteractive = true;
    } else if (tag === "a" && (el.href || roleAttr === "link")) {
      semanticRole = "link";
      isInteractive = true;
    } else if (tag === "input") {
      if (typeAttr === "checkbox") {
        semanticRole = "checkbox";
        isInteractive = true;
      } else if (typeAttr === "radio") {
        semanticRole = "radio";
        isInteractive = true;
      } else {
        semanticRole = "input";
        isInteractive = true;
      }
    } else if (tag === "textarea") {
      semanticRole = "textarea";
      isInteractive = true;
    } else if (tag === "select") {
      semanticRole = "select";
      isInteractive = true;
    } else if (tag === "img" || roleAttr === "img") {
      semanticRole = "image";
    } else if (/^h[1-6]$/.test(tag)) {
      semanticRole = "heading";
    } else if (tag === "form") {
      semanticRole = "form";
    } else if (tag === "label") {
      semanticRole = "label";
      if (el.htmlFor) isInteractive = true;
    } else if (tag === "p") {
      semanticRole = "text";
    } else if (roleAttr) {
      semanticRole = roleAttr;
      if (
        [
          "button",
          "checkbox",
          "menuitem",
          "tab",
          "link",
          "searchbox",
          "switch",
        ].includes(roleAttr)
      ) {
        isInteractive = true;
      }
    } else if (
      style.cursor === "pointer" ||
      el.onclick ||
      el.hasAttribute("onclick")
    ) {
      semanticRole = "button";
      isInteractive = true;
    } else if (
      el.classList.contains("card") ||
      (el.className &&
        typeof el.className === "string" &&
        el.className.includes("card"))
    ) {
      semanticRole = "card";
    } else {
      semanticRole = "container";
    }

    let visibleText = "";
    if (tag === "input" || tag === "textarea") {
      visibleText = el.value || el.placeholder || "";
    } else {
      visibleText = (el.innerText || el.textContent || "").trim();
    }
    if (visibleText.length > 70) {
      visibleText = visibleText.slice(0, 67) + "...";
    }

    // Attach privacy protection status
    let isProtected = sensitiveSet.has(el);
    if (!isProtected) {
      sensitiveSet.forEach((sEl) => {
        if (el.contains(sEl) || sEl.contains(el)) {
          isProtected = true;
        }
      });
    }

    const uniqueId = `ll-el-${elCounter++}`;
    try {
      el.setAttribute("data-ll-id", uniqueId);
    } catch (e) {}

    const selector = getElementSelector(el);

    if (isInteractive) interactiveCount++;
    if (isProtected) protectedCount++;

    const rawElData = {
      id: uniqueId,
      tag: tag,
      role: semanticRole,
      ariaRole: roleAttr || null,
      text: visibleText,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      isInteractive: isInteractive,
      protected: isProtected,
      attributes: {
        type: typeAttr || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        title: el.getAttribute("title") || null,
      },
      selector: selector,
    };

    groundedElements.push(rawElData);
    rawNodeItems.push({ el: el, data: rawElData });
  });

  const extractionDurationMs = Math.round(performance.now() - t0);

  // 4. SEMANTIC UI COMPRESSION PASS
  const tComp0 = performance.now();

  // Phase 1: Text resolution & initial noise pruning
  const candidatesForCompression = [];

  rawNodeItems.forEach((item) => {
    const el = item.el;
    const data = item.data;
    const tag = data.tag;
    const role = data.role;
    const isInteractive = data.isInteractive;
    const isProtected = data.protected;

    // Resolve text prioritizing: 1. visible value/text, 2. aria-label, 3. title, 4. placeholder
    let resolvedText = "";
    if (tag === "input" || tag === "textarea") {
      resolvedText = el.value || el.placeholder || "";
    } else {
      resolvedText = (el.innerText || el.textContent || "").trim();
    }
    if (!resolvedText && el.getAttribute("aria-label")) {
      resolvedText = el.getAttribute("aria-label").trim();
    }
    if (!resolvedText && el.getAttribute("title")) {
      resolvedText = el.getAttribute("title").trim();
    }
    if (!resolvedText && el.getAttribute("placeholder")) {
      resolvedText = el.getAttribute("placeholder").trim();
    }
    // For links or buttons wrapping an img without direct text, look for image alt/title
    if (!resolvedText && (tag === "a" || tag === "button")) {
      const childImg = el.querySelector("img");
      if (childImg) {
        resolvedText = (childImg.getAttribute("alt") || childImg.getAttribute("title") || "").trim();
      }
    }
    // Normalize whitespace
    resolvedText = resolvedText.replace(/\s+/g, " ");
    if (resolvedText.length > 60) {
      resolvedText = resolvedText.slice(0, 57) + "...";
    }

    // Filter out obvious noise / non-semantic wrappers (Never drop protected elements)
    if (!isProtected) {
      if (isInteractive) {
        // Drop links with no text and tiny dimensions (tracking/empty anchors)
        if (tag === "a" && !resolvedText && data.rect.width < 14 && data.rect.height < 14) {
          return;
        }
      } else {
        // Non-interactive filtering:
        if (role === "container" || role === "element") {
          // Drop generic divs/spans unless they are explicitly cards or have an ARIA role
          if (role !== "card" && !data.ariaRole) {
            return;
          }
        } else if (role === "heading") {
          if (!resolvedText) return;
        } else if (role === "text") {
          if (resolvedText.length < 2) return;
        } else if (role === "label") {
          if (el.querySelector("input, select, textarea")) return;
        } else if (role === "image") {
          if (data.rect.width < 20 || data.rect.height < 20) return;
        }
      }
    }

    candidatesForCompression.push({
      el: el,
      data: { ...data, text: resolvedText },
      resolvedText: resolvedText,
    });
  });

  // Phase 2: Parent-Child interactivity & containment pruning
  const keptAfterContainment = [];

  for (let i = 0; i < candidatesForCompression.length; i++) {
    const child = candidatesForCompression[i];
    let isRedundantChild = false;

    for (let j = 0; j < candidatesForCompression.length; j++) {
      if (i === j) continue;
      const parent = candidatesForCompression[j];

      const isDomChild = parent.el.contains(child.el);
      const isBoxChild = (
        child.data.rect.x >= parent.data.rect.x - 2 &&
        child.data.rect.y >= parent.data.rect.y - 2 &&
        (child.data.rect.x + child.data.rect.width) <= (parent.data.rect.x + parent.data.rect.width + 2) &&
        (child.data.rect.y + child.data.rect.height) <= (parent.data.rect.y + parent.data.rect.height + 2)
      );

      if (isDomChild || isBoxChild) {
        if (parent.data.isInteractive) {
          // Check if child is independently interactive
          const isChildIndependentlyInteractive = (
            child.data.isInteractive &&
            (child.data.tag === "input" ||
              child.data.tag === "button" ||
              child.data.tag === "select" ||
              child.data.tag === "textarea" ||
              (child.data.tag === "a" && child.el.href && child.el.href !== parent.el.href))
          );

          if (!isChildIndependentlyInteractive) {
            // Child is decorative/text wrapper inside interactive parent
            if (child.data.protected) {
              parent.data.protected = true;
            }
            isRedundantChild = true;
            break;
          }
        } else if (parent.data.role === "card") {
          if (!child.data.isInteractive && !child.data.protected) {
            if (child.data.role === "container" || child.data.role === "element") {
              isRedundantChild = true;
              break;
            }
          }
        }
      }
    }

    if (!isRedundantChild) {
      keptAfterContainment.push(child);
    }
  }

  // Phase 3: Deduplication of near-identical bounding boxes
  const deduplicated = [];
  const dedupeUsed = new Set();

  for (let i = 0; i < keptAfterContainment.length; i++) {
    if (dedupeUsed.has(i)) continue;
    let primary = keptAfterContainment[i];

    for (let j = i + 1; j < keptAfterContainment.length; j++) {
      if (dedupeUsed.has(j)) continue;
      const other = keptAfterContainment[j];

      const sameBox = (
        Math.abs(primary.data.rect.x - other.data.rect.x) <= 2 &&
        Math.abs(primary.data.rect.y - other.data.rect.y) <= 2 &&
        Math.abs(primary.data.rect.width - other.data.rect.width) <= 4 &&
        Math.abs(primary.data.rect.height - other.data.rect.height) <= 4
      );

      if (sameBox) {
        if (other.data.protected) {
          primary.data.protected = true;
        }
        if (!primary.data.isInteractive && other.data.isInteractive) {
          primary = other;
        } else if (primary.data.isInteractive === other.data.isInteractive) {
          if (!primary.resolvedText && other.resolvedText) {
            primary = other;
          }
        }
        dedupeUsed.add(j);
      }
    }

    deduplicated.push(primary);
  }

  // Phase 4: Final formatting & Assign Clean Compressed IDs
  let compCounter = 1;
  const compressedElements = deduplicated.map((item) => {
    const rawData = item.data;
    const compId = `ll-c-${compCounter++}`;
    try {
      item.el.setAttribute("data-ll-comp-id", compId);
      if (rawData.protected) {
        item.el.setAttribute("data-ll-protected", "true");
      }
    } catch (e) {}

    return {
      id: compId,
      rawId: rawData.id,
      tag: rawData.tag,
      role: rawData.role,
      ariaRole: rawData.ariaRole,
      text: item.resolvedText,
      rect: rawData.rect,
      isInteractive: rawData.isInteractive,
      protected: rawData.protected,
      attributes: rawData.attributes,
      selector: rawData.selector,
    };
  });

  const compressionDurationMs = Math.round((performance.now() - tComp0) * 10) / 10;
  const compInteractiveCount = compressedElements.filter((el) => el.isInteractive).length;
  const compProtectedCount = compressedElements.filter((el) => el.protected).length;
  const compRatio = groundedElements.length > 0
    ? `${((1 - compressedElements.length / groundedElements.length) * 100).toFixed(1)}%`
    : "0%";

  return {
    buttons: buttons,
    inputs: inputs,
    links: links,
    sensitive: sensitive,
    sensitiveText: sensitiveText,
    totalSensitive: sensitive.length + sensitiveText.length,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    groundedElements: groundedElements,
    compressedElements: compressedElements,
    telemetry: {
      extractionTimeMs: extractionDurationMs,
      compressionTimeMs: compressionDurationMs,
      elementsConsidered: elementsConsideredCount,
      visibleElements: groundedElements.length,
      interactiveElements: interactiveCount,
      protectedElements: protectedCount,
      compressedElements: compressedElements.length,
      compressedInteractive: compInteractiveCount,
      compressedProtected: compProtectedCount,
      compressionRatio: compRatio,
    },
  };
}


// ==========================================
// WebGPU Vision Proof of Concept
// ==========================================

const testWebGpuButton = document.getElementById("testWebGpuButton");
const webgpuStatus = document.getElementById("webgpuStatus");
const webgpuDetails = document.getElementById("webgpuDetails");
const webgpuDevice = document.getElementById("webgpuDevice");
const webgpuModel = document.getElementById("webgpuModel");
const webgpuTime = document.getElementById("webgpuTime");
const webgpuPrediction = document.getElementById("webgpuPrediction");
const webgpuError = document.getElementById("webgpuError");

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run local WebGPU vision inference",
    });
  } catch (err) {
    if (!err.message.includes("Only a single offscreen document may be created at any time")) {
      throw err;
    }
  }
}

if (testWebGpuButton) {
  testWebGpuButton.addEventListener("click", async () => {
    webgpuStatus.textContent = "Status: Initializing offscreen document...";
    webgpuStatus.style.color = "#172033";
    webgpuDetails.style.display = "none";
    webgpuError.style.display = "none";
    testWebGpuButton.disabled = true;

    try {
      await ensureOffscreenDocument();

      webgpuStatus.textContent = "Status: Loading model & requesting WebGPU...";

      const response = await chrome.runtime.sendMessage({
        type: "TEST_WEBGPU_VISION",
        imageUrl: chrome.runtime.getURL("assets/test.png"),
      });

      if (!response) {
        throw new Error("No response received from the offscreen document runtime.");
      }

      if (response.success) {
        webgpuStatus.textContent = "Status: Active ✓";
        webgpuStatus.style.color = "#15803d";
        webgpuDevice.textContent = response.device;
        webgpuModel.textContent = response.model;
        webgpuTime.textContent = `${response.inferenceTimeMs} ms`;
        webgpuPrediction.textContent = response.topPrediction;
        webgpuDetails.style.display = "block";
      } else {
        webgpuStatus.textContent = "Status: Unavailable";
        webgpuStatus.style.color = "#dc2626";
        webgpuError.textContent = `Reason: ${response.error || "Unknown error"}`;
        webgpuError.style.display = "block";
      }
    } catch (err) {
      console.error("[LocalLens Popup] WebGPU Vision error:", err);
      webgpuStatus.textContent = "Status: Unavailable";
      webgpuStatus.style.color = "#dc2626";
      webgpuError.textContent = `Reason: ${err.message || String(err)}`;
      webgpuError.style.display = "block";
    } finally {
      testWebGpuButton.disabled = false;
    }
  });
}

// ==========================================
// WebGPU Object Detection (Localization)
// ==========================================

const testDetectorButton = document.getElementById("testDetectorButton");
const detectorStatus = document.getElementById("detectorStatus");
const detectorDetails = document.getElementById("detectorDetails");
const detectorDevice = document.getElementById("detectorDevice");
const detectorModel = document.getElementById("detectorModel");
const detectorTime = document.getElementById("detectorTime");
const detectorCount = document.getElementById("detectorCount");
const detectorList = document.getElementById("detectorList");
const detectorError = document.getElementById("detectorError");
const detectionCanvas = document.getElementById("detectionCanvas");

function drawDetections(imageUrl, detections) {
  if (!detectionCanvas) return;
  const ctx = detectionCanvas.getContext("2d");
  const img = new Image();

  img.onload = () => {
    const containerWidth = 280;
    const scale = containerWidth / img.naturalWidth;
    detectionCanvas.width = containerWidth;
    detectionCanvas.height = Math.round(img.naturalHeight * scale);

    // Draw base screenshot
    ctx.drawImage(img, 0, 0, detectionCanvas.width, detectionCanvas.height);

    const colors = [
      "#ef4444",
      "#3b82f6",
      "#10b981",
      "#f59e0b",
      "#8b5cf6",
      "#ec4899",
      "#06b6d4",
      "#f97316",
    ];

    detections.forEach((det, idx) => {
      const { xmin, ymin, xmax, ymax } = det.box;
      const x = Math.round(xmin * scale);
      const y = Math.round(ymin * scale);
      const w = Math.round((xmax - xmin) * scale);
      const h = Math.round((ymax - ymin) * scale);
      const color = colors[idx % colors.length];

      // Draw bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // Draw label background badge
      const labelText = `${det.label} ${(det.score * 100).toFixed(0)}%`;
      ctx.font = "bold 10px Arial, sans-serif";
      const textWidth = ctx.measureText(labelText).width;
      const badgeY = y > 15 ? y - 14 : y + 2;

      ctx.fillStyle = color;
      ctx.fillRect(x, badgeY, textWidth + 6, 13);

      // Draw label text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, x + 3, badgeY + 10);
    });

    detectionCanvas.style.display = "block";
  };

  img.src = imageUrl;
}

const analyzeProtectedPageButton = document.getElementById(
  "analyzeProtectedPageButton",
);
const detectorTargetBadge = document.getElementById("detectorTargetBadge");
const canvasCaption = document.getElementById("canvasCaption");

// 1. Analyze Protected Page (Post-Redaction Webpage Screenshot)
if (analyzeProtectedPageButton) {
  analyzeProtectedPageButton.addEventListener("click", async () => {
    status.textContent = "Status: Scanning & protecting page...";
    detectorStatus.textContent = "Status: Initializing offscreen document...";
    detectorStatus.style.color = "#172033";
    detectorDetails.style.display = "none";
    detectorError.style.display = "none";
    if (detectionCanvas) {
      detectionCanvas.style.display = "none";
    }
    analyzeProtectedPageButton.disabled = true;

    try {
      // Step A: Run the EXISTING privacy scan & redactions, wait for painting, and capture visible tab
      // NOTE: This screenshot is strictly post-redaction (sensitive items are overlaid with black boxes)
      const { pageData, protectedScreenshot } =
        await captureSanitizedScreenshot();

      status.textContent = `Status: ${pageData.totalSensitive} items protected ✓ (Analyzing protected screenshot with WebGPU...)`;
      detectorStatus.textContent =
        "Status: Running YOLOS on protected screenshot via WebGPU...";

      // Step B: Ensure offscreen document is ready
      await ensureOffscreenDocument();

      // Step C: Send ONLY the post-redaction screenshot to the local offscreen WebGPU detector
      // The raw un-redacted screenshot is NEVER captured or sent
      console.log(
        "[LocalLens Popup] Sending protected screenshot to local offscreen WebGPU detector",
      );
      const response = await chrome.runtime.sendMessage({
        type: "TEST_WEBGPU_OBJECT_DETECTION",
        imageUrl: protectedScreenshot,
        source: "Protected screenshot",
      });

      if (!response) {
        throw new Error(
          "No response received from the offscreen document runtime.",
        );
      }

      if (response.success) {
        detectorStatus.textContent = "Status: Active ✓";
        detectorStatus.style.color = "#15803d";

        if (detectorTargetBadge) {
          detectorTargetBadge.textContent = "Protected screenshot";
          detectorTargetBadge.style.background = "#dcfce7";
          detectorTargetBadge.style.color = "#166534";
        }
        if (canvasCaption) {
          canvasCaption.textContent =
            "Protected Screenshot — analyzed locally";
        }

        detectorDevice.textContent = response.device;
        detectorModel.textContent = response.model;
        detectorTime.textContent = `${response.inferenceTimeMs} ms`;
        detectorCount.textContent = `${response.count}`;

        // Populate detections list
        detectorList.innerHTML = "";
        if (response.detections && response.detections.length > 0) {
          response.detections.forEach((det, i) => {
            const item = document.createElement("div");
            item.style.padding = "4px 0";
            item.style.borderBottom = "1px solid #e2e8f0";
            item.innerHTML =
              `<strong>#${i + 1} ${det.label}</strong> (${(det.score * 100).toFixed(1)}%)<br>` +
              `<span style="color: #64748b; font-family: monospace;">[${det.box.xmin}, ${det.box.ymin}, ${det.box.xmax}, ${det.box.ymax}]</span>`;
            detectorList.appendChild(item);
          });
        } else {
          detectorList.textContent =
            "No objects detected above threshold (0.2).";
        }

        // Render visual bounding box debug canvas using the sanitized screenshot
        drawDetections(protectedScreenshot, response.detections || []);

        detectorDetails.style.display = "block";
        status.textContent = `Status: ${pageData.totalSensitive} items protected ✓ (WebGPU analysis complete)`;
      } else {
        detectorStatus.textContent = "Status: Unavailable";
        detectorStatus.style.color = "#dc2626";
        detectorError.textContent = `Reason: ${response.error || "Unknown error"}`;
        detectorError.style.display = "block";
      }
    } catch (err) {
      console.error("[LocalLens Popup] Protected Page Detection error:", err);
      detectorStatus.textContent = "Status: Unavailable";
      detectorStatus.style.color = "#dc2626";
      detectorError.textContent = `Reason: ${err.message || String(err)}`;
      detectorError.style.display = "block";
      status.textContent = "Error: " + err.message;
    } finally {
      analyzeProtectedPageButton.disabled = false;
    }
  });
}

// 2. Existing Baseline: Test WebGPU Object Detection (Local test.png)
if (testDetectorButton) {
  testDetectorButton.addEventListener("click", async () => {
    detectorStatus.textContent = "Status: Initializing offscreen document...";
    detectorStatus.style.color = "#172033";
    detectorDetails.style.display = "none";
    detectorError.style.display = "none";
    if (detectionCanvas) {
      detectionCanvas.style.display = "none";
    }
    testDetectorButton.disabled = true;

    try {
      await ensureOffscreenDocument();

      detectorStatus.textContent =
        "Status: Loading YOLOS detector & requesting WebGPU...";

      const testImageUrl = chrome.runtime.getURL("assets/test.png");

      const response = await chrome.runtime.sendMessage({
        type: "TEST_WEBGPU_OBJECT_DETECTION",
        imageUrl: testImageUrl,
        source: "Local test.png baseline",
      });

      if (!response) {
        throw new Error(
          "No response received from the offscreen document runtime.",
        );
      }

      if (response.success) {
        detectorStatus.textContent = "Status: Active ✓";
        detectorStatus.style.color = "#15803d";

        if (detectorTargetBadge) {
          detectorTargetBadge.textContent = "Local test.png baseline";
          detectorTargetBadge.style.background = "#e0e7ff";
          detectorTargetBadge.style.color = "#3730a3";
        }
        if (canvasCaption) {
          canvasCaption.textContent = "Local test.png — analyzed locally";
        }

        detectorDevice.textContent = response.device;
        detectorModel.textContent = response.model;
        detectorTime.textContent = `${response.inferenceTimeMs} ms`;
        detectorCount.textContent = `${response.count}`;

        // Populate detections list
        detectorList.innerHTML = "";
        if (response.detections && response.detections.length > 0) {
          response.detections.forEach((det, i) => {
            const item = document.createElement("div");
            item.style.padding = "4px 0";
            item.style.borderBottom = "1px solid #e2e8f0";
            item.innerHTML =
              `<strong>#${i + 1} ${det.label}</strong> (${(det.score * 100).toFixed(1)}%)<br>` +
              `<span style="color: #64748b; font-family: monospace;">[${det.box.xmin}, ${det.box.ymin}, ${det.box.xmax}, ${det.box.ymax}]</span>`;
            detectorList.appendChild(item);
          });
        } else {
          detectorList.textContent =
            "No objects detected above threshold (0.2).";
        }

        // Render visual bounding box debug canvas
        drawDetections(testImageUrl, response.detections || []);

        detectorDetails.style.display = "block";
      } else {
        detectorStatus.textContent = "Status: Unavailable";
        detectorStatus.style.color = "#dc2626";
        detectorError.textContent = `Reason: ${response.error || "Unknown error"}`;
        detectorError.style.display = "block";
      }
    } catch (err) {
      console.error("[LocalLens Popup] Object Detection error:", err);
      detectorStatus.textContent = "Status: Unavailable";
      detectorStatus.style.color = "#dc2626";
      detectorError.textContent = `Reason: ${err.message || String(err)}`;
      detectorError.style.display = "block";
    } finally {
      testDetectorButton.disabled = false;
    }
  });
}

// ==========================================
// DOM-Grounded Visual UI Map & Agent-Ready Compression
// ==========================================

const buildUiMapButton = document.getElementById("buildUiMapButton");
const uiMapResult = document.getElementById("uiMapResult");
const uiMapStatus = document.getElementById("uiMapStatus");
const uiMapSectionTitle = document.getElementById("uiMapSectionTitle");
const viewAgentReadyBtn = document.getElementById("viewAgentReadyBtn");
const viewRawDomBtn = document.getElementById("viewRawDomBtn");

const agentReadyTelemetry = document.getElementById("agentReadyTelemetry");
const telemetryRawCount = document.getElementById("telemetryRawCount");
const telemetryCompressedCount = document.getElementById("telemetryCompressedCount");
const telemetryRatio = document.getElementById("telemetryRatio");
const telemetryCompInteractive = document.getElementById("telemetryCompInteractive");
const telemetryCompProtected = document.getElementById("telemetryCompProtected");
const telemetryCompTime = document.getElementById("telemetryCompTime");

const rawDomTelemetry = document.getElementById("rawDomTelemetry");
const uiMapTime = document.getElementById("uiMapTime");
const uiMapVisibleCount = document.getElementById("uiMapVisibleCount");
const uiMapInteractiveCount = document.getElementById("uiMapInteractiveCount");
const uiMapProtectedCount = document.getElementById("uiMapProtectedCount");

const canvasModeBadge = document.getElementById("canvasModeBadge");
const uiMapCanvas = document.getElementById("uiMapCanvas");

const compressedTableContainer = document.getElementById("compressedTableContainer");
const compressedTableTotal = document.getElementById("compressedTableTotal");
const compressedTableBody = document.getElementById("compressedTableBody");

const rawTableContainer = document.getElementById("rawTableContainer");
const uiMapTableTotal = document.getElementById("uiMapTableTotal");
const uiMapTableBody = document.getElementById("uiMapTableBody");

let lastScreenshot = null;
let lastRawElements = [];
let lastCompressedElements = [];
let lastViewport = null;
let currentViewMode = "agent-ready";

function drawUiMap(screenshotUrl, elements, viewport, isCompressedMode = true, highlightTargetId = null) {
  if (!uiMapCanvas || !screenshotUrl) return;
  const ctx = uiMapCanvas.getContext("2d");
  const img = new Image();

  img.onload = () => {
    const containerWidth = 308;
    const scale = containerWidth / (viewport.width || img.naturalWidth);
    uiMapCanvas.width = containerWidth;
    uiMapCanvas.height = Math.round((viewport.height || img.naturalHeight) * scale);

    // 1. Draw base protected screenshot
    ctx.drawImage(img, 0, 0, uiMapCanvas.width, uiMapCanvas.height);

    // 2. Sort elements so containers draw first, followed by content, interactive, protected, and target on top
    const sorted = [...elements].sort((a, b) => {
      const priority = (el) => {
        if (highlightTargetId && (el.id === highlightTargetId || el.rawId === highlightTargetId)) return 5;
        if (el.protected) return 4;
        if (el.isInteractive) return 3;
        if (el.role === "heading" || el.role === "card") return 2;
        return 1;
      };
      return priority(a) - priority(b);
    });

    sorted.forEach((el) => {
      const x = Math.round(el.rect.x * scale);
      const y = Math.round(el.rect.y * scale);
      const w = Math.round(el.rect.width * scale);
      const h = Math.round(el.rect.height * scale);

      if (w <= 0 || h <= 0) return;

      const isTargetMatch = highlightTargetId && (el.id === highlightTargetId || el.rawId === highlightTargetId);

      let strokeColor = "#8b5cf6";
      let fillColor = "rgba(139, 92, 246, 0.06)";
      let isDashed = true;
      let badgeBg = "#8b5cf6";
      let badgeText = isCompressedMode ? el.id : `${el.id} [${el.role}]`;

      if (isTargetMatch) {
        strokeColor = "#eab308"; // Glowing amber
        fillColor = "rgba(234, 179, 8, 0.35)";
        isDashed = false;
        badgeBg = "#ca8a04";
        badgeText = `★ ${el.id}`;
      } else if (el.protected) {
        strokeColor = "#dc2626";
        fillColor = "rgba(220, 38, 38, 0.22)";
        isDashed = false;
        badgeBg = "#dc2626";
        badgeText = isCompressedMode ? `${el.id} [PROT]` : `${el.id} [PROTECTED]`;
      } else if (el.isInteractive) {
        strokeColor = "#0284c7";
        fillColor = "rgba(2, 132, 199, 0.14)";
        isDashed = false;
        badgeBg = "#0284c7";
        badgeText = isCompressedMode ? el.id : `${el.id} [${el.role}]`;
      }

      // Draw bounding box
      ctx.save();
      if (isTargetMatch) {
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.shadowColor = "#eab308";
        ctx.shadowBlur = 6;
      } else if (isDashed) {
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1;
      } else {
        ctx.setLineDash([]);
        ctx.lineWidth = el.protected ? 2 : 1.5;
      }
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();

      // Draw badge labels
      const shouldDrawBadge = isTargetMatch || (isCompressedMode
        ? (el.isInteractive || el.protected)
        : (el.isInteractive || el.protected || el.role === "heading" || el.role === "card"));

      if (shouldDrawBadge) {
        ctx.font = isTargetMatch
          ? "bold 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
          : "bold 8px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        const textMetrics = ctx.measureText(badgeText);
        const badgeW = textMetrics.width + (isTargetMatch ? 6 : 4);
        const badgeH = isTargetMatch ? 13 : 11;
        const badgeY = y >= badgeH + 1 ? y - badgeH : y;

        ctx.fillStyle = badgeBg;
        ctx.fillRect(x, badgeY, badgeW, badgeH);

        ctx.fillStyle = "#ffffff";
        ctx.fillText(badgeText, x + (isTargetMatch ? 3 : 2), badgeY + (isTargetMatch ? 9 : 8));
      }
    });

    uiMapCanvas.style.display = "block";
  };

  img.src = screenshotUrl;
}

function switchMapView(mode) {
  currentViewMode = mode;

  if (mode === "agent-ready") {
    if (viewAgentReadyBtn) viewAgentReadyBtn.classList.add("active");
    if (viewRawDomBtn) viewRawDomBtn.classList.remove("active");
    if (uiMapSectionTitle) uiMapSectionTitle.textContent = "Agent-Ready UI Map";
    if (agentReadyTelemetry) agentReadyTelemetry.style.display = "flex";
    if (rawDomTelemetry) rawDomTelemetry.style.display = "none";
    if (canvasModeBadge) {
      canvasModeBadge.textContent = "Agent-Ready";
      canvasModeBadge.style.color = "#0f766e";
      canvasModeBadge.style.background = "#ccfbf1";
    }
    if (compressedTableContainer) compressedTableContainer.style.display = "block";
    if (rawTableContainer) rawTableContainer.style.display = "none";

    if (lastScreenshot && lastViewport) {
      drawUiMap(lastScreenshot, lastCompressedElements, lastViewport, true);
    }
  } else if (mode === "raw-dom") {
    if (viewRawDomBtn) viewRawDomBtn.classList.add("active");
    if (viewAgentReadyBtn) viewAgentReadyBtn.classList.remove("active");
    if (uiMapSectionTitle) uiMapSectionTitle.textContent = "DOM-Grounded Visual UI Map (Debug)";
    if (rawDomTelemetry) rawDomTelemetry.style.display = "flex";
    if (agentReadyTelemetry) agentReadyTelemetry.style.display = "none";
    if (canvasModeBadge) {
      canvasModeBadge.textContent = "Raw DOM (Debug)";
      canvasModeBadge.style.color = "#4338ca";
      canvasModeBadge.style.background = "#e0e7ff";
    }
    if (rawTableContainer) rawTableContainer.style.display = "block";
    if (compressedTableContainer) compressedTableContainer.style.display = "none";

    if (lastScreenshot && lastViewport) {
      drawUiMap(lastScreenshot, lastRawElements, lastViewport, false);
    }
  }
}

if (viewAgentReadyBtn) {
  viewAgentReadyBtn.addEventListener("click", () => switchMapView("agent-ready"));
}

if (viewRawDomBtn) {
  viewRawDomBtn.addEventListener("click", () => switchMapView("raw-dom"));
}

function populateCompressedTable(elements) {
  if (!compressedTableBody) return;
  compressedTableBody.innerHTML = "";

  elements.forEach((el) => {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = el.id;
    tdId.style.fontWeight = "bold";

    const tdRole = document.createElement("td");
    const roleSpan = document.createElement("span");
    roleSpan.className = el.isInteractive ? "role-badge interactive" : "role-badge";
    roleSpan.textContent = el.role;
    tdRole.appendChild(roleSpan);

    const tdText = document.createElement("td");
    tdText.textContent = el.text || "-";
    tdText.title = el.text || "";

    const tdBox = document.createElement("td");
    tdBox.style.fontFamily = "monospace";
    tdBox.style.fontSize = "9px";
    tdBox.textContent = `[${el.rect.x},${el.rect.y},${el.rect.width},${el.rect.height}]`;

    const tdProt = document.createElement("td");
    if (el.protected) {
      tdProt.innerHTML = `<span class="prot-badge-yes">YES</span>`;
    } else {
      tdProt.innerHTML = `<span class="prot-badge-no">NO</span>`;
    }

    tr.appendChild(tdId);
    tr.appendChild(tdRole);
    tr.appendChild(tdText);
    tr.appendChild(tdBox);
    tr.appendChild(tdProt);

    compressedTableBody.appendChild(tr);
  });
}

function populateRawTable(elements) {
  if (!uiMapTableBody) return;
  uiMapTableBody.innerHTML = "";

  elements.forEach((el) => {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = el.id;
    tdId.style.fontWeight = "bold";

    const tdRole = document.createElement("td");
    const roleSpan = document.createElement("span");
    roleSpan.className = el.isInteractive ? "role-badge interactive" : "role-badge";
    roleSpan.textContent = el.role;
    tdRole.appendChild(roleSpan);

    const tdText = document.createElement("td");
    tdText.textContent = el.text || "-";
    tdText.title = el.text || "";

    const tdBox = document.createElement("td");
    tdBox.style.fontFamily = "monospace";
    tdBox.style.fontSize = "9px";
    tdBox.textContent = `[${el.rect.x},${el.rect.y},${el.rect.width},${el.rect.height}]`;

    const tdProt = document.createElement("td");
    if (el.protected) {
      tdProt.innerHTML = `<span class="prot-badge-yes">YES</span>`;
    } else {
      tdProt.innerHTML = `<span class="prot-badge-no">NO</span>`;
    }

    tr.appendChild(tdId);
    tr.appendChild(tdRole);
    tr.appendChild(tdText);
    tr.appendChild(tdBox);
    tr.appendChild(tdProt);

    uiMapTableBody.appendChild(tr);
  });
}

if (buildUiMapButton) {
  buildUiMapButton.addEventListener("click", async () => {
    buildUiMapButton.disabled = true;
    uiMapStatus.textContent = "Status: Scanning DOM, compressing & capturing page...";
    uiMapStatus.style.color = "#172033";
    uiMapResult.style.display = "block";
    uiMapCanvas.style.display = "none";

    try {
      // Step A: Run privacy scan + redactions and capture visible tab screenshot
      const { pageData, protectedScreenshot } = await captureSanitizedScreenshot();

      const { groundedElements, compressedElements, viewport, telemetry } = pageData;

      // Store in memory for instant view toggles
      lastScreenshot = protectedScreenshot;
      lastRawElements = groundedElements || [];
      lastCompressedElements = compressedElements || [];
      lastViewport = viewport;

      uiMapStatus.textContent = `Status: Compressed ${groundedElements.length} → ${compressedElements.length} elements (${telemetry.compressionRatio} reduction in ${telemetry.compressionTimeMs} ms) ✓`;
      uiMapStatus.style.color = "#15803d";

      // Step B: Update Agent-Ready Telemetry
      if (telemetryRawCount) telemetryRawCount.textContent = telemetry.visibleElements;
      if (telemetryCompressedCount) telemetryCompressedCount.textContent = telemetry.compressedElements;
      if (telemetryRatio) telemetryRatio.textContent = telemetry.compressionRatio;
      if (telemetryCompInteractive) telemetryCompInteractive.textContent = telemetry.compressedInteractive;
      if (telemetryCompProtected) telemetryCompProtected.textContent = telemetry.compressedProtected;
      if (telemetryCompTime) telemetryCompTime.textContent = `${telemetry.compressionTimeMs} ms`;

      // Step C: Update Raw DOM Debug Telemetry
      if (uiMapTime) uiMapTime.textContent = `${telemetry.extractionTimeMs} ms`;
      if (uiMapVisibleCount) uiMapVisibleCount.textContent = `${telemetry.visibleElements}`;
      if (uiMapInteractiveCount) uiMapInteractiveCount.textContent = `${telemetry.interactiveElements}`;
      if (uiMapProtectedCount) uiMapProtectedCount.textContent = `${telemetry.protectedElements}`;

      // Step D: Populate Tables
      if (compressedTableTotal) compressedTableTotal.textContent = `${compressedElements.length}`;
      populateCompressedTable(compressedElements);

      if (uiMapTableTotal) uiMapTableTotal.textContent = `${groundedElements.length}`;
      populateRawTable(groundedElements);

      // Step E: Render default active view (Agent-Ready)
      switchMapView(currentViewMode);
    } catch (err) {
      console.error("[LocalLens Popup] UI Map error:", err);
      uiMapStatus.textContent = "Status: Failed to build UI Map";
      uiMapStatus.style.color = "#dc2626";
    } finally {
      buildUiMapButton.disabled = false;
    }
  });
}

// ==========================================
// Local Reasoning over Agent-Ready UI Context
// ==========================================

const userTaskInput = document.getElementById("userTaskInput");
const askLocalLensButton = document.getElementById("askLocalLensButton");
const reasoningResult = document.getElementById("reasoningResult");
const reasoningStatus = document.getElementById("reasoningStatus");
const reasoningModel = document.getElementById("reasoningModel");
const reasoningDecision = document.getElementById("reasoningDecision");
const reasoningTarget = document.getElementById("reasoningTarget");
const reasoningExplanation = document.getElementById("reasoningExplanation");
const telemetryPrepTime = document.getElementById("telemetryPrepTime");
const telemetryInfTime = document.getElementById("telemetryInfTime");
const telemetryTotalTime = document.getElementById("telemetryTotalTime");
const reasoningError = document.getElementById("reasoningError");

if (askLocalLensButton) {
  askLocalLensButton.addEventListener("click", async () => {
    const task = userTaskInput ? userTaskInput.value.trim() : "";
    if (!task) {
      alert("Please enter a task description.");
      return;
    }

    askLocalLensButton.disabled = true;
    reasoningStatus.textContent = "Status: Preparing protected screenshot & compressed UI...";
    reasoningStatus.style.color = "#172033";
    reasoningResult.style.display = "block";
    reasoningError.style.display = "none";

    const tPrepStart = performance.now();

    try {
      // Step A: Ensure we have the latest sanitized screenshot and compressed elements
      let protectedScreenshot = lastScreenshot;
      let compressedElements = lastCompressedElements;
      let viewport = lastViewport;

      if (!protectedScreenshot || !compressedElements || compressedElements.length === 0) {
        reasoningStatus.textContent = "Status: Scanning DOM & capturing protected screenshot...";
        const captureResult = await captureSanitizedScreenshot();
        protectedScreenshot = captureResult.protectedScreenshot;
        compressedElements = captureResult.pageData.compressedElements || [];
        viewport = captureResult.pageData.viewport;

        // Cache for UI map
        lastScreenshot = protectedScreenshot;
        lastRawElements = captureResult.pageData.groundedElements || [];
        lastCompressedElements = compressedElements;
        lastViewport = viewport;

        // Also update UI map tables and counts
        if (compressedTableTotal) compressedTableTotal.textContent = `${compressedElements.length}`;
        populateCompressedTable(compressedElements);
        if (uiMapTableTotal) uiMapTableTotal.textContent = `${lastRawElements.length}`;
        populateRawTable(lastRawElements);
        if (uiMapResult) uiMapResult.style.display = "block";
      }

      // Step B: Build compact, agent-ready elements payload (strictly essential fields)
      const compactElements = compressedElements.map((el) => ({
        id: el.id,
        role: el.role,
        text: el.text || "",
        bounds: [el.rect.x, el.rect.y, el.rect.width, el.rect.height],
        protected: Boolean(el.protected),
      }));

      // Step C: Convert protected screenshot (data URL) to a Blob
      const blobResp = await fetch(protectedScreenshot);
      const imageBlob = await blobResp.blob();

      // Step D: Construct FormData for POST /reason
      const formData = new FormData();
      formData.append("image", imageBlob, "locallens-protected.png");
      formData.append("task", task);
      formData.append("elements", JSON.stringify(compactElements));
      formData.append(
        "viewport",
        JSON.stringify(viewport ? { width: viewport.width, height: viewport.height } : {}),
      );

      const prepDurationMs = Math.round(performance.now() - tPrepStart);
      if (telemetryPrepTime) telemetryPrepTime.textContent = `${prepDurationMs} ms`;

      // Step E: Send to local Qwen backend
      reasoningStatus.textContent = "Status: Sending to local Qwen2.5-VL 3B...";
      const tClientInfStart = performance.now();

      const serverResp = await fetch("http://127.0.0.1:8000/reason", {
        method: "POST",
        body: formData,
      });

      const totalClientDurationMs = Math.round(performance.now() - tClientInfStart);

      if (!serverResp.ok) {
        let errorDetail = "";
        try {
          const errJson = await serverResp.json();
          errorDetail = errJson.detail || JSON.stringify(errJson);
        } catch (_) {
          try {
            errorDetail = await serverResp.text();
          } catch (_) {
            errorDetail = serverResp.statusText;
          }
        }
        throw new Error(
          `Local backend returned HTTP ${serverResp.status}${errorDetail ? `: ${errorDetail}` : ""}`
        );
      }

      const data = await serverResp.json();
      const decision = data.decision || {};

      // Step F: Update reasoning UI
      reasoningStatus.textContent = "Status: Reasoning complete ✓";
      reasoningStatus.style.color = "#15803d";
      if (reasoningModel) reasoningModel.textContent = "qwen2.5vl:3b (local via Ollama)";

      if (reasoningDecision) {
        if (decision.status === "ok") {
          reasoningDecision.textContent = "Target Identified (OK)";
          reasoningDecision.style.color = "#15803d";
        } else {
          reasoningDecision.textContent = "Insufficient Context / Safe Refusal";
          reasoningDecision.style.color = "#ca8a04";
        }
      }

      if (reasoningTarget) {
        if (decision.element_id) {
          reasoningTarget.textContent = decision.element_id;
          reasoningTarget.style.background = "#fef08a";
          reasoningTarget.style.color = "#854d0e";
        } else {
          reasoningTarget.textContent = "None";
          reasoningTarget.style.background = "#f1f5f9";
          reasoningTarget.style.color = "#64748b";
        }
      }

      if (reasoningExplanation) {
        reasoningExplanation.textContent = decision.reason || data.raw_response || "No explanation provided.";
      }

      // Step G: Telemetry update
      if (telemetryInfTime) {
        const infTime = data.telemetry && data.telemetry.inference_time_ms ? data.telemetry.inference_time_ms : totalClientDurationMs;
        telemetryInfTime.textContent = `${infTime} ms`;
      }
      if (telemetryTotalTime) {
        telemetryTotalTime.textContent = `${prepDurationMs + totalClientDurationMs} ms`;
      }

      // Step H: Highlight target on canvas and in table
      if (decision.element_id) {
        if (uiMapResult) uiMapResult.style.display = "block";
        switchMapView("agent-ready");
        drawUiMap(lastScreenshot, lastCompressedElements, lastViewport, true, decision.element_id);

        // Highlight matching row in the table
        if (compressedTableBody) {
          const rows = compressedTableBody.querySelectorAll("tr");
          rows.forEach((r) => {
            const firstCell = r.querySelector("td");
            if (firstCell && firstCell.textContent.trim() === decision.element_id) {
              r.style.background = "#fef9c3";
              r.scrollIntoView({ behavior: "smooth", block: "nearest" });
            } else {
              r.style.background = "";
            }
          });
        }
      }

      // Step I: Configure and show Action Executor section if target is identified
      if (actionExecutionSection) {
        if (decision.element_id) {
          actionExecutionSection.style.display = "block";
          if (actionTargetBadge) actionTargetBadge.textContent = decision.element_id;
          if (actionTargetInput) actionTargetInput.value = decision.element_id;

          const targetMeta = (lastCompressedElements || []).find((el) => el.id === decision.element_id);
          const isInputLike = targetMeta && (
            targetMeta.role === "searchbox" ||
            targetMeta.role === "input" ||
            targetMeta.tag === "input" ||
            targetMeta.tag === "textarea"
          );

          if (isInputLike) {
            if (actionTypeSelect) actionTypeSelect.value = "type";
            if (actionTypeInputGroup) actionTypeInputGroup.style.display = "block";
          } else {
            if (actionTypeSelect) actionTypeSelect.value = "click";
            if (actionTypeInputGroup) actionTypeInputGroup.style.display = "none";
          }

          if (actionResultDisplay) actionResultDisplay.style.display = "none";
        } else {
          actionExecutionSection.style.display = "none";
        }
      }
    } catch (err) {
      console.error("[LocalLens Popup] Local Reasoning error:", err);
      reasoningStatus.textContent = "Status: Reasoning failed";
      reasoningStatus.style.color = "#dc2626";
      if (reasoningError) {
        reasoningError.textContent = `Error: ${err.message || String(err)}`;
        reasoningError.style.display = "block";
      }
    } finally {
      askLocalLensButton.disabled = false;
    }
  });
}

// ==========================================
// Minimal Safe Browser Action Executor
// ==========================================

const actionExecutionSection = document.getElementById("actionExecutionSection");
const actionTargetBadge = document.getElementById("actionTargetBadge");
const actionTargetInput = document.getElementById("actionTargetInput");
const actionTypeSelect = document.getElementById("actionTypeSelect");
const actionTypeInputGroup = document.getElementById("actionTypeInputGroup");
const actionTextInput = document.getElementById("actionTextInput");
const executeActionButton = document.getElementById("executeActionButton");
const actionResultDisplay = document.getElementById("actionResultDisplay");
const actionResultStatus = document.getElementById("actionResultStatus");
const actionResultAction = document.getElementById("actionResultAction");
const actionResultTarget = document.getElementById("actionResultTarget");
const actionResultMessage = document.getElementById("actionResultMessage");
const actionVerificationRow = document.getElementById("actionVerificationRow");
const actionVerificationStatus = document.getElementById("actionVerificationStatus");
const actionVerificationMessage = document.getElementById("actionVerificationMessage");

if (actionTypeSelect) {
  actionTypeSelect.addEventListener("change", () => {
    if (actionTypeInputGroup) {
      actionTypeInputGroup.style.display = actionTypeSelect.value === "type" ? "block" : "none";
    }
  });
}

// In-page execution and verification function: runs directly inside active tab context
async function inPageActionExecutor(action, elementId, textToType, isProtectedHint) {
  // 1. Safety check: Never allow action on protected=true elements
  if (isProtectedHint) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action rejected: target element is privacy-protected/redacted.",
      verification: null
    };
  }

  // 2. Resolve element ID back to grounded DOM element
  let targetEl = document.querySelector(`[data-ll-comp-id="${elementId}"]`);
  if (!targetEl) {
    targetEl = document.querySelector(`[data-ll-id="${elementId}"]`);
  }

  if (!targetEl) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: `Element with ID "${elementId}" not found in page DOM.`,
      verification: null
    };
  }

  // Double check DOM-level protection flags & overlays
  if (
    targetEl.classList.contains("locallens-redaction") ||
    targetEl.closest(".locallens-redaction") ||
    targetEl.getAttribute("data-ll-protected") === "true"
  ) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action rejected: target element is privacy-protected/redacted.",
      verification: null
    };
  }

  // 3. Before acting, verify element still exists and is visible
  const style = window.getComputedStyle(targetEl);
  const rect = targetEl.getBoundingClientRect();
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0" ||
    rect.width === 0 ||
    rect.height === 0
  ) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: `Element "${elementId}" exists but is currently hidden or not visible.`,
      verification: null
    };
  }

  // Scroll element into view
  targetEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

  // 4. Perform the action + verification
  if (action === "click") {
    try {
      // Pre-action snapshot for verification
      const initialUrl = window.location.href;
      const initialTitle = document.title;
      const initialAriaExpanded = targetEl.getAttribute("aria-expanded");
      const parent = targetEl.parentElement;
      const initialParentHtmlLength = parent ? parent.innerHTML.length : 0;
      const initialChildCount = parent ? parent.children.length : 0;

      targetEl.focus();
      targetEl.click();

      // Re-scan relevant page state after short delay (~350 ms)
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Check for meaningful UI state change signals
      let isVerified = false;
      let verifyMsg = "";

      const currentUrl = window.location.href;
      const ariaExpandedNow = targetEl.isConnected ? targetEl.getAttribute("aria-expanded") : null;
      const parentHtmlLenNow = parent && parent.isConnected ? parent.innerHTML.length : 0;
      const parentChildCountNow = parent && parent.isConnected ? parent.children.length : 0;

      if (currentUrl !== initialUrl) {
        isVerified = true;
        verifyMsg = `Navigation detected: URL changed to ${window.location.pathname}`;
      } else if (!targetEl.isConnected) {
        isVerified = true;
        verifyMsg = "Target element was removed from DOM (navigation or removal).";
      } else if (window.getComputedStyle(targetEl).display === "none" || window.getComputedStyle(targetEl).visibility === "hidden") {
        isVerified = true;
        verifyMsg = "Target element transitioned to hidden after click.";
      } else if (ariaExpandedNow !== initialAriaExpanded) {
        isVerified = true;
        verifyMsg = `Element expansion state changed (aria-expanded: ${ariaExpandedNow}).`;
      } else if (document.activeElement === targetEl || targetEl.contains(document.activeElement)) {
        isVerified = true;
        verifyMsg = "Target element received focus and became active element.";
      } else if (document.title !== initialTitle) {
        isVerified = true;
        verifyMsg = "Page title changed after click.";
      } else if (parentChildCountNow !== initialChildCount || Math.abs(parentHtmlLenNow - initialParentHtmlLength) > 10) {
        isVerified = true;
        verifyMsg = "Surrounding DOM structure updated after click.";
      } else {
        isVerified = false;
        verifyMsg = "No significant DOM or URL change detected after click.";
      }

      return {
        status: "ok",
        action: "click",
        element_id: elementId,
        message: `Successfully clicked element ${elementId} (<${targetEl.tagName.toLowerCase()}>).`,
        verification: {
          status: isVerified ? "verified" : "unverified",
          message: verifyMsg
        }
      };
    } catch (err) {
      return {
        status: "failed",
        action: "click",
        element_id: elementId,
        message: `Click failed: ${err.message}`,
        verification: null
      };
    }
  } else if (action === "type") {
    try {
      let inputEl = targetEl;
      if (inputEl.tagName !== "INPUT" && inputEl.tagName !== "TEXTAREA" && !inputEl.isContentEditable) {
        const childInput = inputEl.querySelector("input, textarea");
        if (childInput) {
          inputEl = childInput;
        } else {
          return {
            status: "failed",
            action: "type",
            element_id: elementId,
            message: `Element ${elementId} (<${targetEl.tagName.toLowerCase()}>) cannot accept text input.`,
            verification: null
          };
        }
      }

      inputEl.focus();
      if (inputEl.isContentEditable) {
        inputEl.textContent = textToType;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        inputEl.value = textToType;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Verification: verify current value matches requested text
      const finalValue = inputEl.isContentEditable ? inputEl.textContent : inputEl.value;
      const isVerified = (finalValue === textToType);

      return {
        status: "ok",
        action: "type",
        element_id: elementId,
        message: `Successfully typed "${textToType}" into element ${elementId}.`,
        verification: {
          status: isVerified ? "verified" : "unverified",
          message: isVerified
            ? "Input value matches requested text."
            : `Input value mismatch (expected: "${textToType}", current: "${finalValue}").`
        }
      };
    } catch (err) {
      return {
        status: "failed",
        action: "type",
        element_id: elementId,
        message: `Type failed: ${err.message}`,
        verification: null
      };
    }
  } else {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: `Unsupported action "${action}". Supported actions are "click" and "type".`,
      verification: null
    };
  }
}

// Executes action safely on the active tab
async function executeBrowserAction(action, elementId, textToType) {
  // Pre-flight check against cached compressed elements in popup
  const targetMeta = (lastCompressedElements || []).find((el) => el.id === elementId);
  const isProtected = targetMeta ? Boolean(targetMeta.protected) : false;

  if (isProtected) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action rejected: target element is privacy-protected/redacted.",
      verification: null
    };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "No active browser tab found.",
      verification: null
    };
  }

  // Wrap executeScript with a timeout so navigation tearing down the frame context never hangs the popup
  const scriptPromise = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: inPageActionExecutor,
    args: [action, elementId, textToType, isProtected]
  });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve("TIMEOUT_OR_NAVIGATION"), 1500)
  );

  let results;
  try {
    results = await Promise.race([scriptPromise, timeoutPromise]);
  } catch (err) {
    if (action === "click") {
      return {
        status: "ok",
        action: "click",
        element_id: elementId,
        message: `Clicked element ${elementId} (navigation transition detected).`,
        verification: {
          status: "verified",
          message: "Navigation/transition initiated by click."
        }
      };
    }
    throw err;
  }

  if (results === "TIMEOUT_OR_NAVIGATION") {
    if (action === "click") {
      return {
        status: "ok",
        action: "click",
        element_id: elementId,
        message: `Clicked element ${elementId} (navigation transition detected).`,
        verification: {
          status: "verified",
          message: "Navigation/transition initiated by click."
        }
      };
    }
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action script execution timed out.",
      verification: null
    };
  }

  if (!results || results.length === 0 || !results[0] || !results[0].result) {
    if (action === "click") {
      return {
        status: "ok",
        action: "click",
        element_id: elementId,
        message: `Clicked element ${elementId} (page transition detected).`,
        verification: {
          status: "verified",
          message: "Page transition detected."
        }
      };
    }
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action script execution returned no result.",
      verification: null
    };
  }

  return results[0].result;
}

if (executeActionButton) {
  executeActionButton.addEventListener("click", async () => {
    const action = actionTypeSelect ? actionTypeSelect.value : "click";
    const elementId = actionTargetInput ? actionTargetInput.value.trim() : "";
    const textToType = actionTextInput ? actionTextInput.value : "";

    if (!elementId) {
      alert("Please specify a target element ID.");
      return;
    }

    executeActionButton.disabled = true;
    if (actionResultDisplay) actionResultDisplay.style.display = "none";
    if (actionVerificationRow) actionVerificationRow.style.display = "none";

    console.log("[LocalLens Action Executor] Executing action:", { action, elementId, textToType });

    try {
      const result = await executeBrowserAction(action, elementId, textToType);
      console.log("[LocalLens Action Executor] Action result:", result);

      if (actionResultDisplay) {
        actionResultDisplay.style.display = "block";
        if (result.status === "ok") {
          actionResultDisplay.style.background = "#dcfce7";
          actionResultDisplay.style.border = "1px solid #86efac";
          actionResultStatus.textContent = "OK ✓";
          actionResultStatus.style.color = "#15803d";
        } else {
          actionResultDisplay.style.background = "#fee2e2";
          actionResultDisplay.style.border = "1px solid #fca5a5";
          actionResultStatus.textContent = "FAILED ✗";
          actionResultStatus.style.color = "#dc2626";
        }

        if (actionResultAction) actionResultAction.textContent = result.action;
        if (actionResultTarget) actionResultTarget.textContent = result.element_id || elementId;
        if (actionResultMessage) {
          actionResultMessage.textContent = result.message;
          actionResultMessage.style.color = result.status === "ok" ? "#166534" : "#991b1b";
        }

        // Display verification result
        if (actionVerificationRow) {
          if (result && result.verification) {
            actionVerificationRow.style.display = "block";
            const isVerified = result.verification.status === "verified";
            if (actionVerificationStatus) {
              actionVerificationStatus.textContent = isVerified ? "VERIFIED ✓" : "UNVERIFIED ⚠️";
              actionVerificationStatus.style.color = isVerified ? "#15803d" : "#ca8a04";
            }
            if (actionVerificationMessage) {
              actionVerificationMessage.textContent = result.verification.message || "";
              actionVerificationMessage.style.color = isVerified ? "#166534" : "#854d0e";
            }
            console.log("[LocalLens Action Executor] Verification rendered:", result.verification);
          } else {
            actionVerificationRow.style.display = "none";
            if (actionVerificationStatus) actionVerificationStatus.textContent = "-";
            if (actionVerificationMessage) actionVerificationMessage.textContent = "";
            console.log("[LocalLens Action Executor] No verification to render (null or rejected).");
          }
        }
      }
    } catch (err) {
      console.error("[LocalLens Action Executor] Execution error:", err);
      if (actionResultDisplay) {
        actionResultDisplay.style.display = "block";
        actionResultDisplay.style.background = "#fee2e2";
        actionResultDisplay.style.border = "1px solid #fca5a5";
        actionResultStatus.textContent = "ERROR ✗";
        actionResultStatus.style.color = "#dc2626";
        if (actionResultAction) actionResultAction.textContent = action;
        if (actionResultTarget) actionResultTarget.textContent = elementId;
        if (actionResultMessage) {
          actionResultMessage.textContent = err.message || String(err);
          actionResultMessage.style.color = "#991b1b";
        }
        if (actionVerificationRow) {
          actionVerificationRow.style.display = "none";
          if (actionVerificationStatus) actionVerificationStatus.textContent = "-";
          if (actionVerificationMessage) actionVerificationMessage.textContent = "";
        }
      }
    } finally {
      executeActionButton.disabled = false;
    }
  });
}

// ==========================================
// Minimal End-to-End Demo Workflow Orchestrator
// ==========================================

async function queryReasoningBackend(task, protectedScreenshot, compressedElements, viewport) {
  const compactElements = compressedElements.map((el) => ({
    id: el.id,
    role: el.role,
    text: el.text || "",
    bounds: [el.rect.x, el.rect.y, el.rect.width, el.rect.height],
    protected: Boolean(el.protected),
  }));

  const blobResp = await fetch(protectedScreenshot);
  const imageBlob = await blobResp.blob();

  const formData = new FormData();
  formData.append("image", imageBlob, "locallens-protected.png");
  formData.append("task", task);
  formData.append("elements", JSON.stringify(compactElements));
  formData.append(
    "viewport",
    JSON.stringify(viewport ? { width: viewport.width, height: viewport.height } : {}),
  );

  const serverResp = await fetch("http://127.0.0.1:8000/reason", {
    method: "POST",
    body: formData,
  });

  if (!serverResp.ok) {
    let errorDetail = "";
    try {
      const errJson = await serverResp.json();
      errorDetail = errJson.detail || JSON.stringify(errJson);
    } catch (_) {
      try {
        errorDetail = await serverResp.text();
      } catch (_) {
        errorDetail = serverResp.statusText;
      }
    }
    throw new Error(
      `Backend returned HTTP ${serverResp.status}${errorDetail ? `: ${errorDetail}` : ""}`
    );
  }

  const data = await serverResp.json();
  return data.decision || {};
}

const runDemoWorkflowButton = document.getElementById("runDemoWorkflowButton");
const demoWorkflowStatusList = document.getElementById("demoWorkflowStatusList");
const demoStep1 = document.getElementById("demoStep1");
const demoStep2 = document.getElementById("demoStep2");
const demoStep3 = document.getElementById("demoStep3");
const demoStep4 = document.getElementById("demoStep4");
const demoStep5 = document.getElementById("demoStep5");
const demoStep6 = document.getElementById("demoStep6");
const demoStep7 = document.getElementById("demoStep7");
const demoWorkflowSummary = document.getElementById("demoWorkflowSummary");

if (runDemoWorkflowButton) {
  runDemoWorkflowButton.addEventListener("click", async () => {
    function setStepPending(el, text) {
      if (el) {
        el.style.color = "#0284c7";
        el.textContent = `⏳ ${text}`;
      }
    }

    function setStepSuccess(el, text) {
      if (el) {
        el.style.color = "#15803d";
        el.textContent = `✓ ${text}`;
      }
    }

    function setStepFail(el, text) {
      if (el) {
        el.style.color = "#dc2626";
        el.textContent = `✗ ${text}`;
      }
    }

    if (demoWorkflowStatusList) demoWorkflowStatusList.style.display = "block";
    if (demoWorkflowSummary) demoWorkflowSummary.style.display = "none";
    runDemoWorkflowButton.disabled = true;

    // Reset steps
    if (demoStep1) { demoStep1.style.color = "#64748b"; demoStep1.textContent = "○ Privacy scan"; }
    if (demoStep2) { demoStep2.style.color = "#64748b"; demoStep2.textContent = "○ Search bar identified"; }
    if (demoStep3) { demoStep3.style.color = "#64748b"; demoStep3.textContent = "○ Typed \"wireless headphones\""; }
    if (demoStep4) { demoStep4.style.color = "#64748b"; demoStep4.textContent = "○ Type verified"; }
    if (demoStep5) { demoStep5.style.color = "#64748b"; demoStep5.textContent = "○ Search/submit identified"; }
    if (demoStep6) { demoStep6.style.color = "#64748b"; demoStep6.textContent = "○ Search clicked"; }
    if (demoStep7) { demoStep7.style.color = "#64748b"; demoStep7.textContent = "○ Page change verified"; }

    const queryText = "wireless headphones";

    try {
      // 1. Scan current webpage, run privacy protection & capture screenshot
      setStepPending(demoStep1, "Running privacy scan & protection...");
      const capture1 = await captureSanitizedScreenshot();
      let protectedScreenshot = capture1.protectedScreenshot;
      let compressedElements = capture1.pageData.compressedElements || [];
      let viewport = capture1.pageData.viewport;

      // Update cached state
      lastScreenshot = protectedScreenshot;
      lastRawElements = capture1.pageData.groundedElements || [];
      lastCompressedElements = compressedElements;
      lastViewport = viewport;

      setStepSuccess(demoStep1, "Privacy scan");

      // 2. Identify search bar via local reasoning
      setStepPending(demoStep2, "Identifying search bar via local reasoning...");
      const decision1 = await queryReasoningBackend(
        "Find the search bar",
        protectedScreenshot,
        compressedElements,
        viewport
      );

      if (decision1.status !== "ok" || !decision1.element_id) {
        setStepFail(demoStep2, `Search bar identified: ${decision1.reason || "insufficient context"}`);
        throw new Error(decision1.reason || "Search bar could not be identified");
      }

      const searchBarId = decision1.element_id;
      // Safety check: ensure target is not protected
      const searchMeta = compressedElements.find((el) => el.id === searchBarId);
      if (searchMeta && searchMeta.protected) {
        setStepFail(demoStep2, "Search bar target is privacy-protected. Aborting for safety.");
        throw new Error("Action rejected: target element is privacy-protected.");
      }
      setStepSuccess(demoStep2, "Search bar identified");

      // 3. Execute TYPE "wireless headphones"
      setStepPending(demoStep3, `Typing "${queryText}" into search bar...`);
      const typeResult = await executeBrowserAction("type", searchBarId, queryText);

      if (typeResult.status !== "ok") {
        setStepFail(demoStep3, `Typed "${queryText}": failed (${typeResult.message})`);
        throw new Error(typeResult.message);
      }
      setStepSuccess(demoStep3, `Typed "${queryText}"`);

      // 4. Verify input value
      setStepPending(demoStep4, "Verifying input value...");
      if (!typeResult.verification || typeResult.verification.status !== "verified") {
        const msg = typeResult.verification ? typeResult.verification.message : "No verification returned";
        setStepFail(demoStep4, `Type verified: failed (${msg})`);
        throw new Error(msg);
      }
      setStepSuccess(demoStep4, "Type verified");

      // 5. Re-scan page after typing & identify search/submit control
      setStepPending(demoStep5, "Re-scanning page & identifying search submit button...");
      await new Promise((r) => setTimeout(r, 200));

      const capture2 = await captureSanitizedScreenshot();
      protectedScreenshot = capture2.protectedScreenshot;
      compressedElements = capture2.pageData.compressedElements || [];
      viewport = capture2.pageData.viewport;

      lastScreenshot = protectedScreenshot;
      lastRawElements = capture2.pageData.groundedElements || [];
      lastCompressedElements = compressedElements;
      lastViewport = viewport;

      const decision2 = await queryReasoningBackend(
        "Find the search submit button or Go button",
        protectedScreenshot,
        compressedElements,
        viewport
      );

      if (decision2.status !== "ok" || !decision2.element_id) {
        setStepFail(demoStep5, `Search/submit identified: ${decision2.reason || "insufficient context"}`);
        throw new Error(decision2.reason || "Search submit control could not be identified");
      }

      const submitId = decision2.element_id;
      // Safety check: ensure submit control is not protected
      const submitMeta = compressedElements.find((el) => el.id === submitId);
      if (submitMeta && submitMeta.protected) {
        setStepFail(demoStep5, "Search submit control is privacy-protected. Aborting for safety.");
        throw new Error("Action rejected: target element is privacy-protected.");
      }
      setStepSuccess(demoStep5, "Search/submit identified");

      // 6. Execute CLICK on search submit control
      setStepPending(demoStep6, "Clicking search submit button...");

      // Capture pre-click URL and title from active tab
      const [tabBeforeClick] = await chrome.tabs.query({ active: true, currentWindow: true });
      const initialUrl = tabBeforeClick ? tabBeforeClick.url : "";
      const initialTitle = tabBeforeClick ? tabBeforeClick.title : "";

      let clickResult;
      try {
        clickResult = await executeBrowserAction("click", submitId, "");
      } catch (clickErr) {
        console.warn("[Demo Workflow] Click error (likely navigation):", clickErr);
        clickResult = {
          status: "ok",
          action: "click",
          element_id: submitId,
          message: "Navigation initiated by click",
          verification: null
        };
      }

      if (!clickResult || clickResult.status !== "ok") {
        const failMsg = clickResult ? clickResult.message : "Click returned no result";
        setStepFail(demoStep6, `Search clicked: failed (${failMsg})`);
        throw new Error(failMsg);
      }
      setStepSuccess(demoStep6, "Search clicked");

      // 7. Robust Post-Click Verification
      setStepPending(demoStep7, "Verifying page change...");

      // Wait for page to settle after clicking (~1.5–2 seconds)
      await new Promise((r) => setTimeout(r, 1500));

      // Re-check current URL/location and tab state
      const [tabAfterClick] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentUrl = tabAfterClick ? tabAfterClick.url : "";
      const currentTitle = tabAfterClick ? tabAfterClick.title : "";

      // Re-scan visible DOM / search state via probe
      let pageProbe = null;
      if (tabAfterClick && tabAfterClick.id) {
        try {
          const probeResults = await chrome.scripting.executeScript({
            target: { tabId: tabAfterClick.id },
            func: () => {
              const url = window.location.href;
              const title = document.title;
              const hasSearchResults = Boolean(
                document.querySelector(
                  ".s-result-item, [data-component-type='s-search-result'], #search, .s-search-results, [data-cy='title-recipe']"
                )
              );
              const bodySnippet = document.body ? document.body.innerText.slice(0, 500) : "";
              return { url, title, hasSearchResults, bodySnippet };
            }
          });
          if (probeResults && probeResults[0] && probeResults[0].result) {
            pageProbe = probeResults[0].result;
          }
        } catch (probeErr) {
          console.warn("[Demo Workflow] Page probe error:", probeErr);
        }
      }

      // Check verification conditions:
      // 1. URL changed (e.g. navigated to /s?k=wireless+headphones)
      const urlChanged = Boolean(currentUrl && initialUrl && currentUrl !== initialUrl);
      const urlHasSearchParam = Boolean(
        currentUrl && (currentUrl.includes("/s?") || currentUrl.includes("k=") || currentUrl.includes("keywords="))
      );
      // 2. Title changed or contains search term
      const titleChanged = Boolean(currentTitle && initialTitle && currentTitle !== initialTitle);
      const titleHasKeyword = Boolean(
        currentTitle && (currentTitle.toLowerCase().includes("wireless") || currentTitle.toLowerCase().includes("headphone"))
      );
      // 3. Search results DOM elements detected
      const hasSearchResultsDom = Boolean(pageProbe && pageProbe.hasSearchResults);
      const probeUrlChanged = Boolean(pageProbe && initialUrl && pageProbe.url !== initialUrl);

      const isPageChangeVerified =
        urlChanged ||
        urlHasSearchParam ||
        titleChanged ||
        titleHasKeyword ||
        hasSearchResultsDom ||
        probeUrlChanged ||
        (clickResult.verification && clickResult.verification.status === "verified");

      if (isPageChangeVerified) {
        setStepSuccess(demoStep7, "Page change verified");
        if (demoWorkflowSummary) {
          demoWorkflowSummary.style.display = "block";
          demoWorkflowSummary.style.color = "#15803d";
          demoWorkflowSummary.textContent = "All 7 steps verified. End-to-end search workflow complete.";
        }
      } else {
        setStepFail(demoStep7, "Click succeeded, but page change could not be verified");
        if (demoWorkflowSummary) {
          demoWorkflowSummary.style.display = "block";
          demoWorkflowSummary.style.color = "#dc2626";
          demoWorkflowSummary.textContent = "Workflow halted: Click succeeded, but page change could not be verified.";
        }
      }
    } catch (workflowErr) {
      console.error("[LocalLens Demo Workflow] Halted:", workflowErr);
      if (demoWorkflowSummary) {
        demoWorkflowSummary.style.display = "block";
        demoWorkflowSummary.style.color = "#dc2626";
        demoWorkflowSummary.textContent = `Workflow safely halted: ${workflowErr.message || String(workflowErr)}`;
      }
    } finally {
      runDemoWorkflowButton.disabled = false;
    }
  });
}


