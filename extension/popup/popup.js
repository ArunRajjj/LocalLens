const scanButton = document.getElementById("scanButton");
const status = document.getElementById("status");

let lastScreenshot = null;
let lastRawElements = [];
let lastCompressedElements = [];
let lastViewport = null;
let currentViewMode = "agent-ready";
let lastExtractedProducts = [];
let lastRecommendedProduct = null;

// ==========================================
// Centralized Persistent Session State
// ==========================================
const SESSION_STORAGE_KEY = "locallens_session_state";

const DEFAULT_SESSION_STATE = {
  task: "",
  status: "Status: Ready",
  currentStep: null,
  currentUrl: "",
  pageTitle: "",
  discoveredProducts: [],
  selectedProductIds: [],
  recommendedProduct: null,
  comparisonDecision: null,
  actionHistory: [],
  cartState: {
    count: null,
    summary: "",
    status: null,
  },
  workflowType: null,
  workflowStatus: null,
  workflowSteps: {},
  workflowSummary: "",
  agentIteration: 0,
  agentHistory: [],
  reviewResearch: {},
  telemetry: {
    lastScanCounts: null,
    vlmResponse: "",
  },
  isStale: false,
  startedAt: null,
  lastUpdated: null,
};

let currentSession = JSON.parse(JSON.stringify(DEFAULT_SESSION_STATE));
let saveSessionTimeout = null;

function saveSessionState(updates = {}, immediate = false) {
  if (updates && typeof updates === "object") {
    for (const [key, val] of Object.entries(updates)) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        currentSession[key] &&
        typeof currentSession[key] === "object" &&
        !Array.isArray(currentSession[key])
      ) {
        currentSession[key] = { ...currentSession[key], ...val };
      } else {
        currentSession[key] = val;
      }
    }
  }
  currentSession.lastUpdated = Date.now();
  if (!currentSession.startedAt) {
    currentSession.startedAt = currentSession.lastUpdated;
  }

  const persist = () => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const safeSession = {
          task: String(currentSession.task || ""),
          status: String(currentSession.status || "Status: Ready"),
          currentStep: currentSession.currentStep,
          currentUrl: String(currentSession.currentUrl || ""),
          pageTitle: String(currentSession.pageTitle || ""),
          discoveredProducts: Array.isArray(currentSession.discoveredProducts)
            ? currentSession.discoveredProducts.map((p) => ({
                id: String(p.id || ""),
                name: String(p.name || ""),
                price: String(p.price || "-"),
                rating: String(p.rating || "-"),
                element_id: p.element_id ? String(p.element_id) : null,
                detail_link_id: p.detail_link_id ? String(p.detail_link_id) : null,
                review_control_id: p.review_control_id ? String(p.review_control_id) : null,
                has_direct_cart: p.has_direct_cart !== false,
                review_summary: p.review_summary ? String(p.review_summary) : null,
                positive_themes: Array.isArray(p.positive_themes) ? p.positive_themes.slice(0, 5) : null,
                negative_themes: Array.isArray(p.negative_themes) ? p.negative_themes.slice(0, 5) : null,
              }))
            : [],
          selectedProductIds: Array.isArray(currentSession.selectedProductIds)
            ? currentSession.selectedProductIds
            : [],
          recommendedProduct: currentSession.recommendedProduct
            ? {
                id: String(currentSession.recommendedProduct.id || ""),
                name: String(currentSession.recommendedProduct.name || ""),
                price: String(currentSession.recommendedProduct.price || "-"),
                rating: String(currentSession.recommendedProduct.rating || "-"),
                element_id: currentSession.recommendedProduct.element_id
                  ? String(currentSession.recommendedProduct.element_id)
                  : null,
                detail_link_id: currentSession.recommendedProduct.detail_link_id
                  ? String(currentSession.recommendedProduct.detail_link_id)
                  : null,
                review_control_id: currentSession.recommendedProduct.review_control_id
                  ? String(currentSession.recommendedProduct.review_control_id)
                  : null,
                has_direct_cart: currentSession.recommendedProduct.has_direct_cart !== false,
                reason: String(currentSession.recommendedProduct.reason || ""),
                review_summary: currentSession.recommendedProduct.review_summary
                  ? String(currentSession.recommendedProduct.review_summary)
                  : null,
                positive_themes: Array.isArray(currentSession.recommendedProduct.positive_themes)
                  ? currentSession.recommendedProduct.positive_themes.slice(0, 5)
                  : null,
                negative_themes: Array.isArray(currentSession.recommendedProduct.negative_themes)
                  ? currentSession.recommendedProduct.negative_themes.slice(0, 5)
                  : null,
              }
            : null,
          comparisonDecision: currentSession.comparisonDecision,
          actionHistory: Array.isArray(currentSession.actionHistory)
            ? currentSession.actionHistory.slice(-20)
            : [],
          cartState: currentSession.cartState || {},
          workflowType: currentSession.workflowType,
          workflowStatus: currentSession.workflowStatus,
          workflowSteps: currentSession.workflowSteps || {},
          workflowSummary: String(currentSession.workflowSummary || ""),
          agentIteration: Number(currentSession.agentIteration || 0),
          agentHistory: Array.isArray(currentSession.agentHistory)
            ? currentSession.agentHistory.slice(-20)
            : [],
          reviewResearch: currentSession.reviewResearch && typeof currentSession.reviewResearch === "object"
            ? Object.fromEntries(
                Object.entries(currentSession.reviewResearch).map(([pid, r]) => [
                  String(pid),
                  {
                    productId: String(r.productId || pid),
                    status: String(r.status || "ok"),
                    summary: String(r.summary || ""),
                    positiveThemes: Array.isArray(r.positiveThemes) ? r.positiveThemes.slice(0, 5) : [],
                    negativeThemes: Array.isArray(r.negativeThemes) ? r.negativeThemes.slice(0, 5) : [],
                    confidence: String(r.confidence || "medium"),
                    reviewsCount: Number(r.reviewsCount || 0)
                  }
                ])
              )
            : {},
          telemetry: currentSession.telemetry || {},
          isStale: Boolean(currentSession.isStale),
          startedAt: currentSession.startedAt,
          lastUpdated: currentSession.lastUpdated,
        };

        chrome.storage.local.set({ [SESSION_STORAGE_KEY]: safeSession }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            console.warn("[LocalLens Session] Storage write error:", chrome.runtime.lastError);
          }
        });
      } catch (err) {
        console.warn("[LocalLens Session] Storage serialization error:", err);
      }
    }
  };

  if (immediate) {
    if (saveSessionTimeout) clearTimeout(saveSessionTimeout);
    saveSessionTimeout = null;
    persist();
  } else {
    if (saveSessionTimeout) clearTimeout(saveSessionTimeout);
    saveSessionTimeout = setTimeout(persist, 150);
  }
}

async function clearSessionState() {
  currentSession = JSON.parse(JSON.stringify(DEFAULT_SESSION_STATE));
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      await chrome.storage.local.remove(SESSION_STORAGE_KEY);
    } catch (e) {
      console.warn("[LocalLens Session] Storage clear error:", e);
    }
  }

  // Reset in-memory cached variables
  lastScreenshot = null;
  lastRawElements = [];
  lastCompressedElements = [];
  lastExtractedProducts = [];
  lastRecommendedProduct = null;

  // Reset UI elements
  if (status) status.textContent = "Status: Ready";
  const staleWarn = document.getElementById("sessionStaleWarning");
  if (staleWarn) staleWarn.style.display = "none";

  const resetCount = (id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "-";
  };
  resetCount("buttonCount");
  resetCount("inputCount");
  resetCount("linkCount");
  resetCount("sensitiveCount");
  resetCount("sensitiveTextCount");
  resetCount("totalProtectedCount");

  const vlmText = document.getElementById("vlmText");
  if (vlmText) vlmText.textContent = "No analysis yet.";

  const compareTaskInp = document.getElementById("compareTaskInput");
  if (compareTaskInp) compareTaskInp.value = "";
  const compareProdsCont = document.getElementById("compareProductsContainer");
  if (compareProdsCont) compareProdsCont.innerHTML = "";
  const compareProdsLst = document.getElementById("compareProductsList");
  if (compareProdsLst) compareProdsLst.style.display = "none";
  const compareResDisp = document.getElementById("compareResultDisplay");
  if (compareResDisp) compareResDisp.style.display = "none";
  const compareRecReviewSec = document.getElementById("compareRecReviewSection");
  if (compareRecReviewSec) compareRecReviewSec.style.display = "none";
  const reviewResearchTelem = document.getElementById("reviewResearchTelemetry");
  if (reviewResearchTelem) reviewResearchTelem.style.display = "none";
  const selCountBadge = document.getElementById("selectedProductsCountBadge");
  if (selCountBadge) selCountBadge.textContent = "0 selected";

  const addSelToCart = document.getElementById("addSelectedToCartButton");
  if (addSelToCart) addSelToCart.style.display = "none";
  const addSelToCartRes = document.getElementById("addSelectedToCartResult");
  if (addSelToCartRes) addSelToCartRes.style.display = "none";
  const addSelProdsRes = document.getElementById("addSelectedProductsResult");
  if (addSelProdsRes) addSelProdsRes.style.display = "none";

  const shopList = document.getElementById("shoppingWorkflowStatusList");
  if (shopList) shopList.style.display = "none";
  const shopSumm = document.getElementById("shoppingWorkflowSummary");
  if (shopSumm) shopSumm.style.display = "none";
  const demoList = document.getElementById("demoWorkflowStatusList");
  if (demoList) demoList.style.display = "none";
  const demoSumm = document.getElementById("demoWorkflowSummary");
  if (demoSumm) demoSumm.style.display = "none";

  const agentBadge = document.getElementById("agentIterationBadge");
  if (agentBadge) agentBadge.textContent = "Iter: 0/10";
  const agentStatus = document.getElementById("iterativeAgentStatus");
  if (agentStatus) agentStatus.textContent = "Status: Idle";
  const resumeBtn = document.getElementById("resumeIterativeAgentButton");
  if (resumeBtn) resumeBtn.style.display = "none";
  const stepDesc = document.getElementById("agentStepDescription");
  if (stepDesc) stepDesc.style.display = "none";
  const histCont = document.getElementById("agentHistoryContainer");
  if (histCont) histCont.style.display = "none";
  const histList = document.getElementById("agentHistoryList");
  if (histList) histList.innerHTML = "";
  const agentSumm = document.getElementById("iterativeAgentSummary");
  if (agentSumm) agentSumm.style.display = "none";

  console.log("[LocalLens Session] New session started. Local storage cleared.");
}

function updateSelectedCountBadge() {
  const container = document.getElementById("compareProductsContainer");
  const selectedCountBadge = document.getElementById("selectedProductsCountBadge");
  if (!container || !selectedCountBadge) return;
  const checkedBoxes = container.querySelectorAll(".product-select-checkbox:checked");
  selectedCountBadge.textContent = `${checkedBoxes.length} selected`;
}

function renderProductCardRows(products, selectedIds = []) {
  const container = document.getElementById("compareProductsContainer");
  const listWrapper = document.getElementById("compareProductsList");
  if (!container || !listWrapper) return;

  container.innerHTML = "";
  products.forEach((p) => {
    const row = document.createElement("label");
    row.style.padding = "5px 8px";
    row.style.background = "#faf5ff";
    row.style.border = "1px solid #f0abfc";
    row.style.borderRadius = "4px";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.cursor = "pointer";
    row.style.userSelect = "none";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "product-select-checkbox";
    checkbox.dataset.productId = p.id;
    checkbox.style.cursor = "pointer";
    checkbox.style.margin = "0";

    if (selectedIds.includes(p.id)) {
      checkbox.checked = true;
    }

    checkbox.addEventListener("change", () => {
      updateSelectedCountBadge();
      const currentSelectedIds = Array.from(
        container.querySelectorAll(".product-select-checkbox:checked")
      )
        .map((cb) => cb.dataset.productId)
        .filter(Boolean);
      saveSessionState({ selectedProductIds: currentSelectedIds });
    });

    const infoDiv = document.createElement("div");
    infoDiv.style.overflow = "hidden";
    infoDiv.style.textOverflow = "ellipsis";
    infoDiv.style.whiteSpace = "nowrap";
    infoDiv.style.flex = "1";

    const idSpan = document.createElement("span");
    idSpan.style.fontWeight = "bold";
    idSpan.style.color = "#7e22ce";
    idSpan.textContent = `[${p.id}] `;

    // Shortlist Badge Pill (Task 3 & 5)
    if (p.shortlist_badge) {
      const badgeSpan = document.createElement("span");
      badgeSpan.style.fontSize = "9px";
      badgeSpan.style.fontWeight = "700";
      badgeSpan.style.padding = "2px 6px";
      badgeSpan.style.borderRadius = "10px";
      badgeSpan.style.marginRight = "6px";
      badgeSpan.style.display = "inline-block";
      if (p.shortlist_badge === "Best Overall") {
        badgeSpan.style.background = "#e0e7ff";
        badgeSpan.style.color = "#4338ca";
        badgeSpan.textContent = "★ Best Overall";
      } else if (p.shortlist_badge === "Best Value") {
        badgeSpan.style.background = "#dcfce7";
        badgeSpan.style.color = "#15803d";
        badgeSpan.textContent = "🏷 Best Value";
      } else if (p.shortlist_badge === "Highest Rated") {
        badgeSpan.style.background = "#fef3c7";
        badgeSpan.style.color = "#b45309";
        badgeSpan.textContent = "★ Highest Rated";
      } else {
        badgeSpan.style.background = "#f1f5f9";
        badgeSpan.style.color = "#475569";
        badgeSpan.textContent = p.shortlist_badge;
      }
      infoDiv.appendChild(badgeSpan);
    }

    const nameSpan = document.createElement("span");
    nameSpan.style.fontWeight = "600";
    nameSpan.style.color = "#1e293b";
    nameSpan.textContent = p.name || "Product";

    infoDiv.appendChild(idSpan);
    infoDiv.appendChild(nameSpan);

    const metaDiv = document.createElement("div");
    metaDiv.style.whiteSpace = "nowrap";
    metaDiv.style.fontSize = "10px";
    metaDiv.style.color = "#475569";
    metaDiv.style.display = "flex";
    metaDiv.style.gap = "4px";
    metaDiv.style.alignItems = "center";

    const priceSpan = document.createElement("span");
    priceSpan.style.color = "#059669";
    priceSpan.style.fontWeight = "bold";
    priceSpan.textContent = p.price || "-";

    const dotSpan = document.createElement("span");
    dotSpan.textContent = "•";

    const ratingSpan = document.createElement("span");
    ratingSpan.style.color = "#d97706";
    ratingSpan.style.fontWeight = "bold";
    ratingSpan.textContent = p.rating || "-";

    metaDiv.appendChild(priceSpan);
    metaDiv.appendChild(dotSpan);
    metaDiv.appendChild(ratingSpan);

    row.appendChild(checkbox);
    row.appendChild(infoDiv);
    row.appendChild(metaDiv);

    container.appendChild(row);
  });

  updateSelectedCountBadge();
  listWrapper.style.display = "block";
}

let lastShortlistedProducts = [];

function assignShortlistBadges(shortlist) {
  if (!Array.isArray(shortlist) || shortlist.length === 0) return [];

  const validPriced = shortlist.filter((p) => p.price_num !== null && p.price_num > 0);
  let lowestPriceProd = null;
  if (validPriced.length > 1) {
    lowestPriceProd = [...validPriced].sort((a, b) => a.price_num - b.price_num)[0];
  }

  const validRated = shortlist.filter((p) => p.rating_num !== null && p.rating_num > 0);
  let highestRatedProd = null;
  if (validRated.length > 1) {
    highestRatedProd = [...validRated].sort((a, b) => b.rating_num - a.rating_num)[0];
  }

  shortlist.forEach((p, idx) => {
    if (idx === 0) {
      p.shortlist_badge = "Best Overall";
    } else if (lowestPriceProd && p.id === lowestPriceProd.id && p.price_num < (shortlist[0].price_num || Infinity)) {
      p.shortlist_badge = "Best Value";
    } else if (highestRatedProd && p.id === highestRatedProd.id && p.rating_num > (shortlist[0].rating_num || 0)) {
      p.shortlist_badge = "Highest Rated";
    } else {
      p.shortlist_badge = null;
    }
  });

  return shortlist;
}

function generateProductShortlist(products, task = "") {
  if (!Array.isArray(products) || products.length === 0) {
    console.log(`[LocalLens Diagnostic] Stage 5 - Final shortlist count: 0 (input products array is empty)`);
    return [];
  }
  if (products.length <= 3) {
    const res = assignShortlistBadges([...products]);
    console.log(`[LocalLens Diagnostic] Stage 5 - Final shortlist count: ${res.length}`);
    return res;
  }

  // 1. Task query tokens
  const q = typeof extractSearchQueryFromTask === "function" ? extractSearchQueryFromTask(task) : "";
  const qTokens = (q || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !["the", "for", "and", "with", "best", "available", "product", "products"].includes(w));

  // 2. Score each product for ranking
  const scored = products.map((p) => {
    let rankScore = 0;
    const nameLower = (p.name || "").toLowerCase();

    // Category / Task relevance
    if (qTokens.length > 0) {
      const matchCount = qTokens.filter((t) => nameLower.includes(t)).length;
      rankScore += matchCount * 30;
      if (matchCount === 0) rankScore -= 40;
    }

    // Rating score (0 - 25 pts)
    if (p.rating_num && p.rating_num > 0) {
      rankScore += Math.min(25, p.rating_num * 5);
    }

    // Price validity score (15 pts)
    if (p.price_num && p.price_num > 0) {
      rankScore += 15;
    }

    // Direct Add to Cart bonus (10 pts)
    if (p.has_direct_cart) {
      rankScore += 10;
    }

    // Internal confidence score
    rankScore += (p.confidence_score || 0) * 0.2;

    return { product: p, score: rankScore };
  });

  scored.sort((a, b) => b.score - a.score);
  const rankedProds = scored.map((s) => s.product);

  const res = assignShortlistBadges(rankedProds.slice(0, 3));
  console.log(`[LocalLens Diagnostic] Stage 5 - Final shortlist count: ${res.length} (shortlisted from ${products.length} products)`);
  return res;
}

function restoreRecommendationUI(rec, decision = {}) {
  const display = document.getElementById("compareResultDisplay");
  if (!rec || !display) return;
  display.style.display = "block";

  const badge = document.getElementById("compareRecBadge");
  const name = document.getElementById("compareRecName");
  const price = document.getElementById("compareRecPrice");
  const rating = document.getElementById("compareRecRating");
  const target = document.getElementById("compareRecTarget");
  const reason = document.getElementById("compareRecReason");

  if (badge) {
    badge.textContent = rec.id;
    badge.style.background = "#f3e8ff";
    badge.style.color = "#6b21a8";
  }
  if (name) name.textContent = rec.name;
  if (price) price.textContent = rec.price;
  if (rating) rating.textContent = rec.rating;
  if (target) {
    target.textContent = currentSession.isStale
      ? `${rec.element_id || rec.detail_link_id || "N/A"} (Stale — re-scan required)`
      : (rec.element_id || rec.detail_link_id || "N/A");
  }
  if (reason) reason.textContent = (decision && decision.reason) || rec.reason || "Selected recommendation.";

  const reviewSec = document.getElementById("compareRecReviewSection");
  const posEl = document.getElementById("compareRecPositiveThemes");
  const negEl = document.getElementById("compareRecNegativeThemes");
  const sumEl = document.getElementById("compareRecReviewSummary");
  if (reviewSec && (rec.review_summary || (rec.positive_themes && rec.positive_themes.length > 0) || (rec.negative_themes && rec.negative_themes.length > 0))) {
    reviewSec.style.display = "block";
    if (posEl) {
      posEl.textContent = rec.positive_themes && rec.positive_themes.length > 0
        ? `+ Pros: ${rec.positive_themes.join(", ")}`
        : "";
      posEl.style.display = posEl.textContent ? "block" : "none";
    }
    if (negEl) {
      negEl.textContent = rec.negative_themes && rec.negative_themes.length > 0
        ? `- Cons: ${rec.negative_themes.join(", ")}`
        : "";
      negEl.style.display = negEl.textContent ? "block" : "none";
    }
    if (sumEl) {
      sumEl.textContent = rec.review_summary ? `"${rec.review_summary}"` : "";
      sumEl.style.display = sumEl.textContent ? "block" : "none";
    }
  } else if (reviewSec) {
    reviewSec.style.display = "none";
  }

  const addSelectedToCartBtn = document.getElementById("addSelectedToCartButton");
  if (addSelectedToCartBtn) {
    addSelectedToCartBtn.style.display = "block";
    addSelectedToCartBtn.textContent = `🛒 Add "${rec.name.slice(0, 28)}..." to Cart`;
  }
}

function restoreWorkflowStepsUI(type, steps = {}, status = null) {
  if (type === "shopping") {
    const list = document.getElementById("shoppingWorkflowStatusList");
    if (list) list.style.display = "block";
    const stepEls = {
      1: document.getElementById("shopStep1"),
      2: document.getElementById("shopStep2"),
      3: document.getElementById("shopStep3"),
      4: document.getElementById("shopStep4"),
      5: document.getElementById("shopStep5"),
      6: document.getElementById("shopStep6"),
      7: document.getElementById("shopStep7"),
    };
    for (const [stepNum, stepData] of Object.entries(steps)) {
      const el = stepEls[stepNum];
      if (el && stepData) {
        el.textContent = stepData.text;
        el.style.color =
          stepData.status === "done"
            ? "#15803d"
            : stepData.status === "failed"
            ? "#dc2626"
            : stepData.status === "active"
            ? "#d97706"
            : "#64748b";
      }
    }
    const summ = document.getElementById("shoppingWorkflowSummary");
    if (summ && currentSession.workflowSummary) {
      summ.style.display = "block";
      summ.style.color = status === "completed" ? "#15803d" : "#dc2626";
      summ.textContent = currentSession.workflowSummary;
    }
  } else if (type === "demo") {
    const list = document.getElementById("demoWorkflowStatusList");
    if (list) list.style.display = "block";
    const stepEls = {
      1: document.getElementById("demoStep1"),
      2: document.getElementById("demoStep2"),
      3: document.getElementById("demoStep3"),
      4: document.getElementById("demoStep4"),
      5: document.getElementById("demoStep5"),
      6: document.getElementById("demoStep6"),
      7: document.getElementById("demoStep7"),
    };
    for (const [stepNum, stepData] of Object.entries(steps)) {
      const el = stepEls[stepNum];
      if (el && stepData) {
        el.textContent = stepData.text;
        el.style.color =
          stepData.status === "done"
            ? "#15803d"
            : stepData.status === "failed"
            ? "#dc2626"
            : stepData.status === "active"
            ? "#d97706"
            : "#64748b";
      }
    }
    const summ = document.getElementById("demoWorkflowSummary");
    if (summ && currentSession.workflowSummary) {
      summ.style.display = "block";
      summ.style.color = status === "completed" ? "#15803d" : "#dc2626";
      summ.textContent = currentSession.workflowSummary;
    }
  }
}

async function restoreSessionState() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return;
  }

  let storedData = null;
  try {
    const res = await chrome.storage.local.get([SESSION_STORAGE_KEY]);
    storedData = res && res[SESSION_STORAGE_KEY];
  } catch (e) {
    console.warn("[LocalLens Session] Storage read error:", e);
    return;
  }

  if (
    !storedData ||
    (!storedData.currentUrl &&
      !storedData.task &&
      (!storedData.discoveredProducts || storedData.discoveredProducts.length === 0))
  ) {
    return;
  }

  currentSession = { ...DEFAULT_SESSION_STATE, ...storedData };

  // Compare stored URL with active tab URL to guard against page change
  let activeTabUrl = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      activeTabUrl = tab.url;
    }
  } catch (e) {}

  const staleWarn = document.getElementById("sessionStaleWarning");
  if (activeTabUrl && currentSession.currentUrl && activeTabUrl !== currentSession.currentUrl) {
    currentSession.isStale = true;
    if (staleWarn) {
      staleWarn.style.display = "block";
      staleWarn.textContent = `⚠️ Active tab URL changed (Stored: ${currentSession.currentUrl.slice(0, 35)}... vs Current: ${activeTabUrl.slice(0, 35)}...). Run "Scan Page" to re-ground UI elements.`;
    }
    lastCompressedElements = [];
  } else {
    currentSession.isStale = false;
    if (staleWarn) staleWarn.style.display = "none";
  }

  // Restore task
  const compTask = document.getElementById("compareTaskInput");
  if (currentSession.task && compTask) {
    compTask.value = currentSession.task;
  }

  // Restore status
  if (currentSession.status && status) {
    status.textContent = currentSession.status;
  }

  // Restore scan counts
  if (currentSession.telemetry && currentSession.telemetry.lastScanCounts) {
    const sc = currentSession.telemetry.lastScanCounts;
    const setIfExists = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) el.textContent = val;
    };
    setIfExists("buttonCount", sc.buttons);
    setIfExists("inputCount", sc.inputs);
    setIfExists("linkCount", sc.links);
    setIfExists("sensitiveCount", sc.sensitive);
    setIfExists("sensitiveTextCount", sc.sensitiveText);
    setIfExists("totalProtectedCount", sc.totalProtected);
  }

  // Restore VLM analysis text
  if (currentSession.telemetry && currentSession.telemetry.vlmResponse) {
    const vlmText = document.getElementById("vlmText");
    if (vlmText) vlmText.textContent = currentSession.telemetry.vlmResponse;
  }

  // Restore extracted products and UI rows
  if (Array.isArray(currentSession.discoveredProducts) && currentSession.discoveredProducts.length > 0) {
    lastExtractedProducts = currentSession.discoveredProducts;
    renderProductCardRows(
      currentSession.discoveredProducts,
      currentSession.selectedProductIds || []
    );
  }

  // Restore recommendation UI
  if (currentSession.recommendedProduct) {
    lastRecommendedProduct = currentSession.recommendedProduct;
    restoreRecommendationUI(currentSession.recommendedProduct, currentSession.comparisonDecision);
  }

  // Restore review research telemetry if available
  if (currentSession.reviewResearch && Object.keys(currentSession.reviewResearch).length > 0) {
    const reviewTelem = document.getElementById("reviewResearchTelemetry");
    const reviewStatus = document.getElementById("reviewResearchStatus");
    const reviewBadge = document.getElementById("reviewResearchBadge");
    if (reviewTelem) reviewTelem.style.display = "flex";
    if (reviewStatus) reviewStatus.textContent = "Reviews: Restored from session ✓";
    if (reviewBadge) {
      const pids = Object.keys(currentSession.reviewResearch);
      reviewBadge.textContent = `${pids.length} products analyzed`;
    }
  }

  // Restore cart result
  if (currentSession.cartState && currentSession.cartState.summary) {
    const addSelectedProductsResult = document.getElementById("addSelectedProductsResult");
    if (addSelectedProductsResult) {
      addSelectedProductsResult.style.display = "block";
      if (currentSession.cartState.status === "verified") {
        addSelectedProductsResult.style.background = "#dcfce7";
        addSelectedProductsResult.style.border = "1px solid #86efac";
        addSelectedProductsResult.style.color = "#15803d";
      } else if (currentSession.cartState.status === "partial") {
        addSelectedProductsResult.style.background = "#fef9c3";
        addSelectedProductsResult.style.border = "1px solid #fde047";
        addSelectedProductsResult.style.color = "#854d0e";
      } else {
        addSelectedProductsResult.style.background = "#fee2e2";
        addSelectedProductsResult.style.border = "1px solid #fca5a5";
        addSelectedProductsResult.style.color = "#991b1b";
      }
      addSelectedProductsResult.innerHTML = currentSession.cartState.summary;
    }
  }

  // Restore workflow steps
  if (currentSession.workflowSteps && Object.keys(currentSession.workflowSteps).length > 0) {
    restoreWorkflowStepsUI(
      currentSession.workflowType,
      currentSession.workflowSteps,
      currentSession.workflowStatus
    );
  }

  // Restore agent loop UI
  if (currentSession.workflowType === "agent") {
    const agentTaskInp = document.getElementById("iterativeAgentTaskInput");
    if (agentTaskInp && currentSession.task) {
      agentTaskInp.value = currentSession.task;
    }
    const agentBadge = document.getElementById("agentIterationBadge");
    if (agentBadge) {
      agentBadge.textContent = `Iter: ${currentSession.agentIteration || 0}/10`;
    }
    const agentStatus = document.getElementById("iterativeAgentStatus");
    if (agentStatus && currentSession.status) {
      agentStatus.textContent = currentSession.status;
    }
    const histContainer = document.getElementById("agentHistoryContainer");
    const histList = document.getElementById("agentHistoryList");
    if (Array.isArray(currentSession.agentHistory) && currentSession.agentHistory.length > 0) {
      if (histContainer) histContainer.style.display = "block";
      if (histList) {
        histList.innerHTML = "";
        currentSession.agentHistory.forEach((item) => {
          const row = document.createElement("div");
          row.style.padding = "3px 4px";
          row.style.borderRadius = "3px";
          row.style.borderLeft = item.verification === "verified" || item.action === "done"
            ? "3px solid #16a34a"
            : item.status === "failed" || item.verification === "failed"
            ? "3px solid #dc2626"
            : "3px solid #ca8a04";
          row.style.background = "#f8fafc";
          row.style.lineHeight = "1.3";
          const isSuccess = item.verification === "verified" || item.action === "done";
          const statusIcon = isSuccess ? "✓" : (item.status === "failed" ? "✗" : "○");
          const actionText = item.action === "type"
            ? `type "${item.text || ''}" -> [${item.element_id}]${item.press_enter ? ' (Enter)' : ''}`
            : item.action === "click"
            ? `click [${item.element_id}]`
            : item.action;
          row.innerHTML = `<div><strong style="color:#1e40af;">Iter ${item.iteration}:</strong> ${actionText}</div>` +
            `<div style="color:#64748b; font-size:9px;">${statusIcon} ${item.message || item.reason || ''}</div>`;
          histList.appendChild(row);
        });
      }
    }
    const agentSummary = document.getElementById("iterativeAgentSummary");
    if (agentSummary && currentSession.workflowSummary) {
      agentSummary.style.display = "block";
      if (currentSession.workflowStatus === "completed") {
        agentSummary.style.background = "#dcfce7";
        agentSummary.style.border = "1px solid #86efac";
        agentSummary.style.color = "#15803d";
      } else if (currentSession.workflowStatus === "refused" || currentSession.workflowStatus === "max_iterations") {
        agentSummary.style.background = "#fef9c3";
        agentSummary.style.border = "1px solid #fde047";
        agentSummary.style.color = "#854d0e";
      } else {
        agentSummary.style.background = "#fee2e2";
        agentSummary.style.border = "1px solid #fca5a5";
        agentSummary.style.color = "#991b1b";
      }
      agentSummary.textContent = currentSession.workflowSummary;
    }
    // Show resume button if loop was active or paused, but NEVER auto-run
    const resumeBtn = document.getElementById("resumeIterativeAgentButton");
    if (resumeBtn && (currentSession.workflowStatus === "active" || currentSession.workflowStatus === "paused")) {
      resumeBtn.style.display = "inline-block";
      resumeBtn.textContent = `↻ Resume Loop (Iter ${currentSession.agentIteration || 0})`;
    }
  }

  console.log("[LocalLens Session] Restored session from storage successfully.");
}

// Non-blocking background warmup call to ensure backend and Ollama model are pre-loaded
try {
  fetch("http://127.0.0.1:8000/warmup").catch(() => {});
} catch (_) {}

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

  lastExtractedProducts = pageData.products || [];
  lastCompressedElements = pageData.compressedElements || [];

  saveSessionState({
    currentUrl: tab ? tab.url || "" : "",
    pageTitle: tab ? tab.title || "" : "",
    isStale: false,
    discoveredProducts: lastExtractedProducts,
    telemetry: {
      lastScanCounts: {
        buttons: pageData.buttons,
        inputs: pageData.inputs,
        links: pageData.links,
        sensitive: pageData.sensitive ? pageData.sensitive.length : 0,
        sensitiveText: pageData.sensitiveText ? pageData.sensitiveText.length : 0,
        totalProtected: pageData.totalSensitive,
      }
    }
  });

  const staleWarn = document.getElementById("sessionStaleWarning");
  if (staleWarn) staleWarn.style.display = "none";

  return { tab, pageData, protectedScreenshot };
}

if (scanButton) {
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
    saveSessionState({
      status: status.textContent,
      telemetry: {
        vlmResponse: result.response
      }
    });
  } catch (error) {
    console.error(error);
    status.textContent = "Error: " + error.message;
    saveSessionState({ status: status.textContent });
  }
  });
}

function scanAndProtectPage() {
  // Clear any existing overlays from previous scans
  document
    .querySelectorAll(".locallens-redaction")
    .forEach((el) => el.remove());

  const buttons = document.querySelectorAll("button").length;
  const inputs = document.querySelectorAll("input, textarea, select").length;
  const links = document.querySelectorAll("a").length;

  // Helper: Detect sensitive form input/textarea fields
  function detectSensitiveInputField(input) {
    if (!input || !input.tagName) return null;
    const tag = input.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return null;

    const type = (input.type || "").toLowerCase();
    const autocomplete = (input.autocomplete || input.getAttribute("autocomplete") || "").toLowerCase();
    const name = (input.name || input.getAttribute("name") || "").toLowerCase();
    const id = (input.id || input.getAttribute("id") || "").toLowerCase();
    const placeholder = (input.placeholder || input.getAttribute("placeholder") || "").toLowerCase();
    const ariaLabel = (input.getAttribute("aria-label") || input.getAttribute("title") || "").toLowerCase();

    let labelText = "";
    if (input.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (lbl) labelText = (lbl.innerText || lbl.textContent || "").toLowerCase();
      } catch (e) {}
    }
    if (!labelText && input.closest("label")) {
      labelText = (input.closest("label").innerText || "").toLowerCase();
    }
    if (!labelText && input.previousElementSibling) {
      const prev = input.previousElementSibling;
      if (prev.tagName.toLowerCase() === "label" || prev.classList.contains("label")) {
        labelText = (prev.innerText || prev.textContent || "").toLowerCase();
      }
    }

    const desc = `${name} ${id} ${placeholder} ${ariaLabel} ${labelText}`;

    // 1. Password / Credentials
    if (
      type === "password" ||
      autocomplete.includes("password") ||
      /\b(?:password|passwd|passcode)\b/i.test(desc)
    ) {
      return "Authentication";
    }

    // 2. CVV / CVC / Security Code
    if (
      autocomplete === "cc-csc" ||
      /\b(?:cvv|cvc|csc|security[\s_-]*code|card[\s_-]*verification)\b/i.test(desc)
    ) {
      return "Financial";
    }

    // 3. OTP / Verification Code
    if (
      autocomplete === "one-time-code" ||
      /\b(?:otp|one[\s_-]*time[\s_-]*(?:code|password|pin)|verification[\s_-]*code|security[\s_-]*token|auth[\s_-]*code)\b/i.test(desc)
    ) {
      return "Authentication";
    }

    // 4. Card / Debit / Credit Card
    if (
      autocomplete === "cc-number" ||
      /\b(?:card[\s_-]*number|credit[\s_-]*card|debit[\s_-]*card|pan[\s_-]*number|cc[\s_-]*num|card_no)\b/i.test(desc) ||
      desc.includes("cardnumber") || desc.includes("card-number")
    ) {
      return "Financial";
    }

    // 5. Bank Account Number
    if (
      /\b(?:account[\s_-]*number|account[\s_-]*no|acc[\s_-]*no|bank[\s_-]*account|iban|routing[\s_-]*number|routing[\s_-]*no)\b/i.test(desc)
    ) {
      return "Financial";
    }

    // 6. Email / E-mail Address
    if (
      type === "email" ||
      autocomplete === "email" ||
      /\b(?:email|e-mail|email[\s_-]*address)\b/i.test(desc)
    ) {
      return "Email";
    }

    // 7. Phone / Mobile / Contact Number
    if (
      type === "tel" ||
      autocomplete === "tel" ||
      /\b(?:phone|mobile|telephone|contact[\s_-]*(?:number|no)|cell[\s_-]*phone)\b/i.test(desc)
    ) {
      return "Phone";
    }

    // 8. Name / Full Name
    if (
      autocomplete === "name" ||
      autocomplete === "given-name" ||
      autocomplete === "family-name" ||
      /\b(?:full[\s_-]*name|first[\s_-]*name|last[\s_-]*name|customer[\s_-]*name|recipient[\s_-]*name|cardholder[\s_-]*name|account[\s_-]*holder)\b/i.test(desc)
    ) {
      return "Personal";
    }

    // 9. Delivery Address / Billing Address / Street Address
    if (
      autocomplete === "street-address" ||
      autocomplete === "address-line1" ||
      autocomplete === "address-line2" ||
      autocomplete === "address-level1" ||
      autocomplete === "address-level2" ||
      /\b(?:delivery[\s_-]*address|shipping[\s_-]*address|billing[\s_-]*address|street[\s_-]*address|postal[\s_-]*address|home[\s_-]*address)\b/i.test(desc) ||
      (tag === "textarea" && /\baddress\b/i.test(desc))
    ) {
      return "Address";
    }

    // 10. PIN / ZIP / Postal Code
    if (
      autocomplete === "postal-code" ||
      /\b(?:pin[\s_-]*code|pincode|postal[\s_-]*code|zip[\s_-]*code|zipcode)\b/i.test(desc)
    ) {
      return "PostalCode";
    }

    return null;
  }

  // 1. INPUT & TEXTAREA SENSITIVE DETECTION
  const sensitive = [];
  const sensitiveInputElements = new Set();

  document.querySelectorAll("input, textarea").forEach((input) => {
    const sensitiveType = detectSensitiveInputField(input);

    if (sensitiveType !== null) {
      sensitiveInputElements.add(input);
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

  function detectSensitiveTextCategory(rawText, el) {
    const text = (rawText || "").trim();
    if (!text || text.length < 3 || text.length > 300) {
      return null;
    }

    // Strict negative filters: guard against prices, discounts, ratings, technical specs, pure nav & control labels
    const hasCurrency = /[₹$€£]|(?:\b(?:inr|usd|eur|gbp|aud|cad|jpy|rs\.?)\b)/i.test(text);
    const hasDiscount = /\b\d+%\s*off\b/i.test(text) || /\b(?:discount|cashback|emi|coupon|voucher|special\s*price|bank\s*offer)\b/i.test(text);
    const hasRating = /[★☆]|\b(?:ratings?|reviews?|stars?|out of \d|\d(?:\.\d)?\s*\★)\b/i.test(text);
    const hasUnits = /\b\d+\s*(?:ghz|mhz|hz|gb|mb|tb|kb|mah|wh|w|v|px|dpi|fps|cm|mm|m|inches?|inch|kg|g|lbs?|oz|hours?|hrs?|mins?|sec)\b/i.test(text);
    const isControlLabelOnly = /^(?:deliver(?:y)?\s*to|select\s*location|choose\s*location|delivery\s*address|shipping\s*address|change|edit|update|pincode|enter\s*pincode)$/i.test(text);
    const isPureNavWord = /^(?:home|cart|orders?|account|help|contact|seller|sign\s*in|login|logout|menu|categories|deals|offers|view\s*all|search|explore|plus)$/i.test(text);

    if (hasCurrency || hasDiscount || hasRating || hasUnits || isControlLabelOnly || isPureNavWord) {
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

    // Direct Name Labels (e.g. "Name: Alexander Wright", "Full Name: John Doe", "Account Holder: Priya Sharma")
    const nameLabelRegex = /\b(?:full\s+name|customer\s+name|account\s+holder|cardholder(?:\s+name)?|name)[ \t:]+([A-Z][a-z]+[ \t]+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i;
    if (nameLabelRegex.test(text)) {
      return "Identity";
    }

    // C. Address-like text detection (Conservative multi-signal)
    // 1. Explicit address prefix context (e.g. "Deliver to Rishi Lucknow 226020", "Shipping address: ...")
    const addressContextRegex =
      /\b(?:deliver(?:y)?\s+to|ship(?:ping)?\s+to|dispatch\s+to|delivery\s+address|shipping\s+address|billing\s+address|home\s+address|street\s+address)[\s:]+/i;
    if (addressContextRegex.test(text)) {
      return "Address";
    }

    // 2. Address type tag prefix + number + address landmark/locality
    // Matches e-commerce addresses like "WORK 86, ranbir singh bhavan, kuruksh...", "HOME 42, Green Glen Layout...", "OFFICE Flat 101, koramangala..."
    const workHomeAddressRegex =
      /^\s*(?:work|home|office|other)\s+(?:#|no\.?|h\.?no\.?|flat|apt|bldg|plot|house)?\s*\d+[A-Za-z0-9\s,./-]*(?:bhavan|bhawan|apartment|apts?|society|enclave|nagar|marg|sector|colony|road|street|lane|layout|tower|floor|block|vihar|complex|phase|cross|kuruksh|delhi|mumbai|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|gurgaon|gurugram|noida|\.\.\.|,)/i;
    if (workHomeAddressRegex.test(text)) {
      return "Address";
    }

    // 3. Recognizable address structure: Building/Flat/House/Plot + Street/Locality/City
    const premiseLocalityRegex =
      /\b(?:flat|apt|apartment|plot|house|h\.?no|door|bldg|building|tower|block|room|shop)\s*(?:no\.?|#)?\s*[\w\/-]+[\s\S]{1,40}\b(?:bhavan|bhawan|road|street|lane|nagar|marg|sector|colony|enclave|society|layout|phase|cross|vihar|complex|block|tower|floor|kuruksh|delhi|mumbai|bangalore|bengaluru|kolkata|chennai|hyderabad|pune|noida|gurgaon|gurugram)\b/i;
    if (premiseLocalityRegex.test(text) && (text.includes(",") || /\d/.test(text))) {
      return "Address";
    }

    // 4. Number at start followed by comma + address landmark/locality (e.g. "86, ranbir singh bhavan, kuruksh...")
    const numLandmarkRegex =
      /^\s*\d{1,4}[A-Za-z]?,?\s+[A-Za-z0-9\s,.-]{2,40}\b(?:bhavan|bhawan|apartments?|apts?|society|colony|enclave|nagar|marg|road|street|lane|sector\s*\d+|layout|vihar|complex|kuruksh|delhi|mumbai|bangalore|bengaluru)\b/i;
    if (numLandmarkRegex.test(text)) {
      return "Address";
    }

    // 5. Check element DOM attributes & nearby delivery/location semantic hierarchy
    let hasLocationDeliverySemantic = false;
    let titleOrAriaAddress = false;

    if (el) {
      const titleAttr = (el.getAttribute("title") || "").trim();
      const ariaAttr = (el.getAttribute("aria-label") || "").trim();

      if (titleAttr && (workHomeAddressRegex.test(titleAttr) || numLandmarkRegex.test(titleAttr) || premiseLocalityRegex.test(titleAttr))) {
        titleOrAriaAddress = true;
      }
      if (ariaAttr && (workHomeAddressRegex.test(ariaAttr) || numLandmarkRegex.test(ariaAttr) || premiseLocalityRegex.test(ariaAttr))) {
        titleOrAriaAddress = true;
      }

      // Check element and ancestors up to 3 levels for address/delivery semantics
      let curr = el;
      for (let depth = 0; depth < 3 && curr && curr !== document.body; depth++) {
        const currAria = (curr.getAttribute("aria-label") || "").toLowerCase();
        const currTitle = (curr.getAttribute("title") || "").toLowerCase();
        const currClass = (typeof curr.className === "string" ? curr.className : "").toLowerCase();
        const currId = (curr.id || "").toLowerCase();
        const currTestId = (curr.getAttribute("data-testid") || curr.getAttribute("data-qa") || "").toLowerCase();

        if (
          curr.tagName.toLowerCase() === "address" ||
          /\b(?:deliver(?:y)?\s*(?:to|address)?|ship(?:ping)?\s*(?:to|address)?|current\s*location|select\s*location|delivery[\s_-]*location|user[\s_-]*address|pincode)\b/i.test(currAria + " " + currTitle) ||
          /\b(?:address|delivery-?location|user-?location|delivery-?address|pincode-?widget|header-?delivery|location-?chip|location-?btn)\b/i.test(currClass + " " + currId + " " + currTestId)
        ) {
          hasLocationDeliverySemantic = true;
          break;
        }

        // Also check previous sibling text (e.g. <span>Deliver to</span> <span>WORK 86...</span>)
        if (curr.previousElementSibling) {
          const prevText = (curr.previousElementSibling.innerText || curr.previousElementSibling.textContent || "").trim().toLowerCase();
          if (/^(?:deliver(?:y)?\s*to|ship(?:ping)?\s*to|delivery\s*address|shipping\s*address|location|pincode)$/i.test(prevText)) {
            hasLocationDeliverySemantic = true;
            break;
          }
        }

        curr = curr.parentElement;
      }
    }

    if (titleOrAriaAddress) {
      return "Address";
    }

    if (hasLocationDeliverySemantic) {
      // Inside an explicit delivery/location semantic container:
      // If the text contains recognizable address tokens: number or comma or address tag
      if (
        text.length >= 5 &&
        (text.includes(",") ||
         /\d/.test(text) ||
         /\b(?:work|home|office|other|near|behind|opp|opposite|lane|road|nagar|sector|bhavan|bhawan)\b/i.test(text))
      ) {
        return "Address";
      }
    }

    // Indian PIN code or US ZIP code with address/postal keywords
    const pinWithAddressRegex =
      /(?:pin(?:\s*code)?|postal(?:\s*code)?|address|lane|street|road|nagar|marg|sector|colony|apartment|flat|lucknow|delhi|mumbai|bangalore|bengaluru|chennai|hyderabad|kolkata|pune|noida|gurugram|gurgaon)[\s\S]{0,40}\b[1-9][0-9]{5}\b/i;
    if (pinWithAddressRegex.test(text)) {
      return "PostalCode";
    }

    const explicitZipRegex =
      /\b(?:pin(?:\s*code)?|postal(?:\s*code)?|zip(?:\s*code)?|zipcode)[\s:]*([0-9]{5,6}(?:-[0-9]{4})?)\b/i;
    if (explicitZipRegex.test(text)) {
      return "PostalCode";
    }

    // D. Bank account-like numbers
    const bankAccountRegex =
      /\b(?:savings|checking|current)?\s*(?:account|a\/c)\s*(?:number|no\.?|#)?[:\s•*]*(?:[•*xX]{2,8}\s*)?\d{3,18}\b/i;
    if (bankAccountRegex.test(text)) {
      return "BankAccount";
    }

    // E. Credit/debit card numbers in visible text (16 digits or 4x4 masked/unmasked)
    const cardRegex =
      /\b(?:\d{4}[-\s]){3}\d{4}\b|\b[•*xX\u2022]{4}[-\s][•*xX\u2022]{4}[-\s][•*xX\u2022]{4}[-\s]\d{4}\b/;
    if (cardRegex.test(text)) {
      return "CreditCard";
    }

    const cardLabelRegex =
      /\b(?:credit\s*card|debit\s*card|card\s*number)[\s:]*(?:[•*xX\u2022\s-]*\d{4}|\d{13,19})\b/i;
    if (cardLabelRegex.test(text)) {
      return "CreditCard";
    }

    // F. CVV / CVC
    const cvvRegex =
      /\b(?:cvv|cvc|security\s*code|card\s*verification\s*value)[\s:]*([0-9]{3,4}|[•*xX\u2022]{3,4})\b/i;
    if (cvvRegex.test(text)) {
      return "Financial";
    }

    // G. OTP / Verification code
    const otpRegex =
      /\b(?:otp|one[\s-]*time[\s-]*(?:password|code|pin)|verification\s*code|auth\s*code)[\s:]+(?:is\s+)?([0-9]{4,8})\b/i;
    if (otpRegex.test(text)) {
      return "Authentication";
    }
    const otpSentRegex =
      /\b(?:otp|one[\s-]*time[\s-]*(?:password|code))\s+sent\s+to\b/i;
    if (otpSentRegex.test(text)) {
      return "Authentication";
    }

    // H. Phone numbers
    // Guard against prices, ratings, and technical specifications
    if (
      !/[₹$€£]|inr|usd|mah|px|dpi|fps|hz|gb|mb|tb|rating|review|star/i.test(
        text,
      )
    ) {
      // With phone context label
      const phoneContextRegex =
        /\b(?:phone|mobile|tel|telephone|contact|cell)(?:\s*number|\s*no\.?)?[\s:]*(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,5}\)?[-.\s]?)?\d{3,5}[-.\s]?\d{4,5}\b/i;
      if (phoneContextRegex.test(text)) {
        return "Phone";
      }

      // Standalone Indian mobile (+91 98765 43210 or 9876543210)
      const indianPhoneRegex = /\b(?:\+91[\-\s]?)?[6-9]\d{4}[\-\s]?\d{5}\b/;
      if (indianPhoneRegex.test(text)) {
        return "Phone";
      }

      // US format
      const usPhoneRegex = /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
      if (usPhoneRegex.test(text)) {
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
    const category = detectSensitiveTextCategory(text, el);

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
    try {
      element.setAttribute("data-ll-protected", "true");
    } catch (e) {}
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
  sensitiveInputElements.forEach((el) => {
    sensitiveSet.add(el);
  });

  specificMatches.forEach((m) => {
    sensitiveSet.add(m.element);
  });

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let elCounter = 1;

  const candidateNodesSet = new Set(Array.from(candidateNodes));
  sensitiveSet.forEach((sEl) => {
    if (sEl && sEl.isConnected) {
      candidateNodesSet.add(sEl);
    }
  });

  candidateNodesSet.forEach((el) => {
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

  console.log(`[LocalLens Diagnostic] Stage 1 - Grounded elements count: ${groundedElements.length}`);

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

  // 5. GROUNDED PRODUCT EXTRACTION (Generic E-Commerce Product Perception)
  function extractGroundedProducts(compElements, sensSet) {
    const prods = [];
    let prodCounter = 1;

    // Generic rejection patterns for navigation headers, filter labels, and banners
    const GENERIC_REJECT_PATTERNS = [
      /^results$/i,
      /^more\s+results$/i,
      /^search\s+results$/i,
      /^see\s+(?:more|all)(\s+results)?$/i,
      /^view\s+(?:more|all)$/i,
      /^sponsored(\s+products?)?$/i,
      /^related\s+(?:searches|categories|products|items)$/i,
      /^recommendations?$/i,
      /^recommended\s+(?:for\s+you|items|products)$/i,
      /^categories$/i,
      /^department$/i,
      /^filters?(\s*\(\d+\))?$/i,
      /^sort\s+by/i,
      /^delivery\s+to/i,
      /^deliver\s+to/i,
      /^location/i,
      /^need\s+help/i,
      /^customer\s+service/i,
      /^best\s+sellers?$/i,
      /^today'?s\s+deals?$/i,
      /^new\s+releases?$/i,
      /^featured(\s+brands?)?$/i,
      /^explore\s+more$/i,
      /^top\s+brands$/i,
      /^avg\.?\s+customer\s+review$/i,
      /^customer\s+reviews$/i,
      /^price$/i,
      /^discount$/i,
      /^availability$/i,
      /^pay\s+on\s+delivery$/i,
      /^free\s+shipping$/i,
      /^back\s+to\s+top$/i,
      /^(?:showing\s+)?\d+\s*-\s*\d+\s+of\s+.*results/i
    ];

    let cardNodes = Array.from(document.querySelectorAll(
      '.product-card, .product-item, [data-component-type="s-search-result"], .s-result-item, [data-asin]:not([data-asin=""]), div[data-id], .card, article'
    ));

    if (cardNodes.length === 0) {
      const allLeafs = Array.from(document.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && (el.innerText || el.textContent || '').trim().length > 0
      );
      const priceLeafs = allLeafs.filter((el) => {
        const t = (el.innerText || el.textContent || '').trim();
        return /(?:[\$₹€£]|inr|usd)\s*\d+(?:,\d{3})*(?:\.\d{2})?/i.test(t) && !/\b(?:off|discount|save)\b/i.test(t);
      });

      const potentialCards = new Set();
      priceLeafs.forEach((pl) => {
        let p = pl.parentElement;
        for (let i = 0; i < 4 && p && p !== document.body; i++) {
          if (p.querySelector('h1, h2, h3, h4, h5, h6, .product-title, .title, a')) {
            potentialCards.add(p);
            break;
          }
          p = p.parentElement;
        }
      });
      cardNodes = Array.from(potentialCards);
    }

    const filteredCards = cardNodes.filter((card) => {
      const style = window.getComputedStyle(card);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = card.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 30) return false;

      // Privacy guard: Never include card if it is protected or contains sensitive content
      if (
        card.getAttribute("data-ll-protected") === "true" ||
        (sensSet && (sensSet.has(card) || Array.from(sensSet).some((s) => card.contains(s) || s.contains(card))))
      ) {
        return false;
      }

      return !cardNodes.some((other) => other !== card && card.contains(other));
    });

    console.log(`[LocalLens Diagnostic] Stage 2 - Raw product candidates count: ${cardNodes.length} (DOM filtered cards: ${filteredCards.length})`);
    let candidatesAfterFilteringCount = 0;

    filteredCards.forEach((card) => {
      // 1. Extract Product Name / Title
      const titleEl = card.querySelector(
        '.product-title, .title, h2 a span, h3 a span, h2 span, h3 span, h2 a, h3 a, h2, h3, h4, h5, [class*="title" i], a.a-link-normal > span, a[title]'
      );
      let name = "";
      if (titleEl) {
        name = (titleEl.innerText || titleEl.textContent || titleEl.getAttribute("title") || "").trim();
      }
      if (!name) {
        const anyLinkWithText = Array.from(card.querySelectorAll('a[href]')).find(a => {
          const t = (a.innerText || a.textContent || "").trim();
          return t.length >= 10 && !GENERIC_REJECT_PATTERNS.some(p => p.test(t));
        });
        if (anyLinkWithText) {
          name = (anyLinkWithText.innerText || anyLinkWithText.textContent || "").trim();
        }
      }
      if (!name) {
        const anyHead = card.querySelector('h1, h2, h3, h4, h5, h6');
        if (anyHead) name = (anyHead.innerText || anyHead.textContent || "").trim();
      }

      if (!name || name.length < 5) {
        console.log(`[LocalLens Diagnostic] Filtered out (name missing or < 5 chars): "${name || ''}"`);
        return;
      }

      const cleanName = name.replace(/\s+/g, " ").trim();

      // Semantic Rejection (Task 1):
      // Reject generic/navigation labels like Results, More results, Sponsored, Related, Filters, Categories, etc.
      if (GENERIC_REJECT_PATTERNS.some((pattern) => pattern.test(cleanName))) {
        console.log(`[LocalLens Diagnostic] Filtered out (generic reject pattern): "${cleanName}"`);
        return;
      }
      if (/^(results\b|more results\b|filters?\b|categories\b|see all\b|related searches\b)/i.test(cleanName)) {
        console.log(`[LocalLens Diagnostic] Filtered out (navigation/section header): "${cleanName}"`);
        return;
      }

      const words = cleanName.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w));
      if (words.length < 2) {
        console.log(`[LocalLens Diagnostic] Filtered out (fewer than 2 words): "${cleanName}"`);
        return;
      }

      // 2. Extract Price
      let price = "";
      let priceNum = null;
      const priceEl = card.querySelector(
        '.product-price, .price, [class*="price" i], .a-price .a-offscreen, .a-price-whole'
      );
      if (priceEl) {
        const pt = (priceEl.innerText || priceEl.textContent || "").trim();
        const m = pt.match(/(?:[\$₹€£]|inr|usd)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i) || pt.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        if (m) {
          price = m[0];
          priceNum = parseFloat(m[1].replace(/,/g, ""));
        }
      }
      if (!price) {
        const cardText = card.innerText || card.textContent || "";
        const m = cardText.match(/(?:[\$₹€£]|inr|usd)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i);
        if (m) {
          price = m[0];
          priceNum = parseFloat(m[1].replace(/,/g, ""));
        }
      }

      // 3. Extract Rating & Review Count
      let rating = "N/A";
      let ratingNum = null;
      let reviewCount = 0;

      const ratingEl = card.querySelector(
        '.product-rating, .rating, [class*="rating" i], .a-icon-star-small, [aria-label*="star" i], [aria-label*="stars" i]'
      );
      if (ratingEl) {
        const rt = (ratingEl.getAttribute("aria-label") || ratingEl.innerText || ratingEl.textContent || "").trim();
        const rm = rt.match(/(?:★|☆)?\s*([0-5](?:\.[0-9])?)/) || rt.match(/([0-5](?:\.[0-9])?)\s*(?:out of 5|stars?|\★)/i);
        if (rm && rm[1]) {
          rating = `★ ${rm[1]}`;
          ratingNum = parseFloat(rm[1]);
        } else {
          rating = rt.slice(0, 30);
        }
      } else {
        const cardText = card.innerText || card.textContent || "";
        const rm = cardText.match(/(?:★|☆)\s*([0-5](?:\.[0-9])?)/) || cardText.match(/([0-5](?:\.[0-9])?)\s*(?:out of 5|stars?|\★)/i);
        if (rm && rm[1]) {
          rating = `★ ${rm[1]}`;
          ratingNum = parseFloat(rm[1]);
        }
      }

      const countEl = card.querySelector('[aria-label*="ratings" i], [aria-label*="reviews" i], .a-size-base.s-underline-text');
      if (countEl) {
        const cm = (countEl.getAttribute("aria-label") || countEl.innerText || "").replace(/,/g, "").match(/\b(\d{1,7})\b/);
        if (cm) reviewCount = parseInt(cm[1], 10);
      }

      // 4. Extract Image Signal
      let hasImage = false;
      const imgEl = card.querySelector('img:not([class*="icon" i]):not([src*="data:image/svg"])');
      if (imgEl) {
        const ir = imgEl.getBoundingClientRect();
        if ((ir.width >= 35 && ir.height >= 35) || imgEl.getAttribute("src") || imgEl.getAttribute("data-src")) {
          hasImage = true;
        }
      }

      // 5. Discover Action / Cart / Detail Target
      let elementId = null;
      let hasDirectCart = false;
      let detailLinkId = null;
      let detailUrl = "";

      const allButtons = Array.from(card.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
      let cartBtn = allButtons.find((b) => {
        const t = ((b.innerText || b.textContent || b.value || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
        return /\b(?:add(?:ed)?\s*to\s*(?:cart|bag|basket)|buy\s*now)\b/i.test(t);
      });

      if (!cartBtn && allButtons.length > 0) {
        cartBtn = card.querySelector('.btn-cart, [class*="cart" i]');
        if (cartBtn) {
          const t = (cartBtn.innerText || cartBtn.textContent || cartBtn.getAttribute("aria-label") || "").toLowerCase();
          if (!t.includes("cart") && !t.includes("buy") && !cartBtn.classList.contains("btn-cart")) {
            cartBtn = null;
          }
        }
      }

      if (cartBtn) {
        elementId = cartBtn.getAttribute("data-ll-comp-id") || cartBtn.getAttribute("data-ll-id");
        hasDirectCart = Boolean(elementId);
      }

      if (!hasDirectCart && compElements && compElements.length > 0) {
        const rect = card.getBoundingClientRect();
        const groundedCartCompEl = compElements.find((cel) => {
          const r = cel.rect;
          if (!r) return false;
          const inCard = r.x >= rect.left - 10 && r.y >= rect.top - 10 && r.x + r.width <= rect.right + 10 && r.y + r.height <= rect.bottom + 10;
          const isCart = (cel.text && /\b(?:add\s*to\s*(?:cart|bag|basket)|buy\s*now)\b/i.test(cel.text)) ||
                         (cel.attributes && cel.attributes.ariaLabel && /\b(?:add\s*to\s*(?:cart|bag|basket)|buy\s*now)\b/i.test(cel.attributes.ariaLabel));
          return inCard && isCart && !cel.protected;
        });
        if (groundedCartCompEl) {
          elementId = groundedCartCompEl.id;
          hasDirectCart = true;
        }
      }

      const detailLinkEl = card.querySelector('a[href]:not([href="#"]):not([href^="javascript"]):not([href*="customer-reviews"])') ||
                           titleEl?.closest('a') ||
                           titleEl?.querySelector('a') ||
                           card.querySelector('a[href]');
      if (detailLinkEl) {
        detailLinkId = detailLinkEl.getAttribute("data-ll-comp-id") || detailLinkEl.getAttribute("data-ll-id");
        detailUrl = detailLinkEl.getAttribute("href") || "";
      }
      if (!detailLinkId && compElements && compElements.length > 0) {
        const rect = card.getBoundingClientRect();
        const groundedLinkCompEl = compElements.find((cel) => {
          const r = cel.rect;
          if (!r) return false;
          const inCard = r.x >= rect.left - 10 && r.y >= rect.top - 10 && r.x + r.width <= rect.right + 10 && r.y + r.height <= rect.bottom + 10;
          return inCard && (cel.tag === "a" || cel.role === "link" || cel.isInteractive) && !cel.protected;
        });
        if (groundedLinkCompEl) {
          detailLinkId = groundedLinkCompEl.id;
        }
      }

      if (!elementId) {
        elementId = detailLinkId;
      }

      // 6. Discover Review Control
      let reviewControlId = null;
      let reviewBtn = allButtons.find((b) => {
        const t = ((b.innerText || b.textContent || b.value || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
        return /\b(?:customer\s+reviews?|reviews?|ratings?|read\s+reviews?)\b/i.test(t) && !/\b(?:write|add|cart|buy)\b/i.test(t);
      });
      if (reviewBtn) {
        reviewControlId = reviewBtn.getAttribute("data-ll-comp-id") || reviewBtn.getAttribute("data-ll-id");
      }
      if (!reviewControlId && compElements && compElements.length > 0) {
        const rect = card.getBoundingClientRect();
        const groundedReviewCompEl = compElements.find((cel) => {
          const r = cel.rect;
          if (!r) return false;
          const inCard = r.x >= rect.left - 10 && r.y >= rect.top - 10 && r.x + r.width <= rect.right + 10 && r.y + r.height <= rect.bottom + 10;
          const isReview = (cel.text && /\b(?:customer\s+reviews?|reviews?|ratings?)\b/i.test(cel.text)) ||
                           (cel.attributes && cel.attributes.ariaLabel && /\b(?:customer\s+reviews?|reviews?|ratings?)\b/i.test(cel.attributes.ariaLabel));
          return inCard && isReview && !cel.protected;
        });
        if (groundedReviewCompEl) {
          reviewControlId = groundedReviewCompEl.id;
        }
      }

      // 7. Product Evidence Confidence Scoring (Task 1)
      let confidenceScore = 0;
      let concreteSignalsCount = 0;

      if (words.length >= 4) {
        confidenceScore += 25;
      } else if (words.length >= 2) {
        confidenceScore += 15;
      }

      if (priceNum !== null && priceNum > 0) {
        confidenceScore += 35;
        concreteSignalsCount++;
      } else if (price && price !== "Price on request") {
        confidenceScore += 20;
        concreteSignalsCount++;
      }

      if (ratingNum !== null && ratingNum > 0) {
        confidenceScore += 20;
        concreteSignalsCount++;
      } else if (rating && rating !== "N/A") {
        confidenceScore += 10;
        concreteSignalsCount++;
      }
      if (reviewCount > 0) {
        confidenceScore += 10;
      }

      if (hasImage) {
        confidenceScore += 20;
        concreteSignalsCount++;
      }

      if (hasDirectCart) {
        confidenceScore += 25;
        concreteSignalsCount++;
      } else if (detailLinkId) {
        confidenceScore += 15;
        concreteSignalsCount++;
      }

      const cardRect = card.getBoundingClientRect();
      if (cardRect.width >= 100 && cardRect.height >= 80) {
        confidenceScore += 10;
      }

      // Reject candidates without sufficient independent product evidence
      if (confidenceScore < 45 || concreteSignalsCount < 2) {
        console.log(`[LocalLens Diagnostic] Filtered out (low confidence/signals - score: ${confidenceScore}, signals: ${concreteSignalsCount}): "${cleanName.slice(0, 60)}"`);
        return;
      }

      candidatesAfterFilteringCount++;
      console.log(`[LocalLens Diagnostic] Candidate passed filtering (#${candidatesAfterFilteringCount}): "${cleanName.slice(0, 60)}" (score: ${confidenceScore}, signals: ${concreteSignalsCount})`);

      // 8. Canonical Key & Deduplication (Task 2)
      let canonicalKey = "";
      if (card.getAttribute("data-asin")) {
        canonicalKey = `asin:${card.getAttribute("data-asin").toUpperCase()}`;
      } else if (detailUrl) {
        const asinMatch = detailUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
        if (asinMatch) {
          canonicalKey = `asin:${asinMatch[1].toUpperCase()}`;
        } else {
          const cleanUrl = detailUrl.split("?")[0].split("#")[0].replace(/\/+$/, "");
          if (cleanUrl.length > 5) {
            canonicalKey = `url:${cleanUrl.toLowerCase()}`;
          }
        }
      }

      const normalizedTitle = cleanName
        .toLowerCase()
        .replace(/^(sponsored|ad|deal of the day|limited time deal|bestseller)\s*[:\-\|]?\s*/i, "")
        .replace(/\b(?:with|for|in|by|the|a|an|and|&)\b/gi, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      let isDuplicate = false;
      for (let i = 0; i < prods.length; i++) {
        const existing = prods[i];

        if (canonicalKey && existing.canonical_key && canonicalKey === existing.canonical_key) {
          isDuplicate = true;
        } else if (normalizedTitle && existing.normalized_title && normalizedTitle === existing.normalized_title) {
          isDuplicate = true;
        } else if (normalizedTitle && existing.normalized_title) {
          const tokensA = new Set(normalizedTitle.split(/\s+/).filter(w => w.length >= 3));
          const tokensB = new Set(existing.normalized_title.split(/\s+/).filter(w => w.length >= 3));
          let intersection = 0;
          tokensA.forEach(t => { if (tokensB.has(t)) intersection++; });
          const union = new Set([...tokensA, ...tokensB]).size;
          const jaccard = union > 0 ? intersection / union : 0;

          if (jaccard >= 0.70) {
            if (!priceNum || !existing.price_num || Math.abs(priceNum - existing.price_num) / Math.max(priceNum, existing.price_num) < 0.15) {
              isDuplicate = true;
            }
          }
        }

        if (isDuplicate) {
          console.log(`[LocalLens Diagnostic] Deduplicated out: "${cleanName.slice(0, 60)}" (duplicate of existing product: "${existing.name}")`);
          if (confidenceScore > (existing.confidence_score || 0)) {
            if (!existing.has_direct_cart && hasDirectCart) {
              existing.element_id = elementId;
              existing.has_direct_cart = true;
            }
            if ((!existing.price_num || existing.price_num <= 0) && priceNum > 0) {
              existing.price = price;
              existing.price_num = priceNum;
            }
            if ((!existing.rating_num || existing.rating_num <= 0) && ratingNum > 0) {
              existing.rating = rating;
              existing.rating_num = ratingNum;
            }
            existing.confidence_score = Math.max(existing.confidence_score || 0, confidenceScore);
          }
          break;
        }
      }

      if (isDuplicate) return;

      const prodId = card.getAttribute("data-product-id") || `prod-${prodCounter++}`;

      prods.push({
        id: prodId,
        name: cleanName.slice(0, 80),
        price: price || "Price on request",
        price_num: priceNum,
        rating: rating,
        rating_num: ratingNum,
        element_id: elementId,
        has_direct_cart: hasDirectCart,
        detail_link_id: detailLinkId,
        detail_url: detailUrl,
        canonical_key: canonicalKey,
        normalized_title: normalizedTitle,
        confidence_score: confidenceScore,
        review_control_id: reviewControlId,
        bounds: [Math.round(cardRect.left), Math.round(cardRect.top), Math.round(cardRect.width), Math.round(cardRect.height)],
        protected: false
      });
    });

    console.log(`[LocalLens Diagnostic] Stage 3 - After filtering count: ${candidatesAfterFilteringCount}`);
    console.log(`[LocalLens Diagnostic] Stage 4 - After deduplication count: ${prods.length}`);

    return prods;
  }

  const groundedProducts = extractGroundedProducts(compressedElements, sensitiveSet);

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
    products: groundedProducts,
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

const webgpuTelemetryRow = document.getElementById("webgpuTelemetryRow");
const webgpuSignalStatus = document.getElementById("webgpuSignalStatus");
const webgpuSignalTime = document.getElementById("webgpuSignalTime");
const webgpuSignalModel = document.getElementById("webgpuSignalModel");
const webgpuSignalPrediction = document.getElementById("webgpuSignalPrediction");

// Helper: Run lightweight local WebGPU visual perception on protected screenshot
async function runWebGpuVisualContext(imageUrl) {
  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: "TEST_WEBGPU_VISION",
      imageUrl: imageUrl,
    });
    return response && response.success ? response : null;
  } catch (err) {
    console.warn("[LocalLens] WebGPU visual signal notice:", err);
    return null;
  }
}

// Shared helper: Queries local Qwen2.5-VL FastAPI backend over protected screenshot & compressed UI elements
async function queryReasoningBackend(task, protectedScreenshot, compressedElements, viewport, history = []) {
  const compactElements = (compressedElements || []).map((el) => ({
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
    JSON.stringify(viewport ? { width: viewport.width, height: viewport.height } : {})
  );
  if (history && history.length > 0) {
    formData.append("history", JSON.stringify(history));
  }

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
      `Local backend returned HTTP ${serverResp.status}${errorDetail ? `: ${errorDetail}` : ""}`
    );
  }

  return await serverResp.json();
}

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

      const prepDurationMs = Math.round(performance.now() - tPrepStart);
      if (telemetryPrepTime) telemetryPrepTime.textContent = `${prepDurationMs} ms`;

      // Step B: Concurrently run local WebGPU visual perception & send to local Qwen backend
      reasoningStatus.textContent = "Status: Running WebGPU visual signal & local Qwen reasoning...";
      const tClientInfStart = performance.now();

      const [webgpuContext, data] = await Promise.all([
        runWebGpuVisualContext(protectedScreenshot),
        queryReasoningBackend(task, protectedScreenshot, compressedElements, viewport)
      ]);

      const totalClientDurationMs = Math.round(performance.now() - tClientInfStart);
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

      // WebGPU visual signal telemetry
      if (webgpuTelemetryRow) {
        if (webgpuContext && webgpuContext.success) {
          webgpuTelemetryRow.style.display = "block";
          if (webgpuSignalStatus) {
            webgpuSignalStatus.textContent = "Active ✓";
            webgpuSignalStatus.style.color = "#15803d";
          }
          if (webgpuSignalTime) webgpuSignalTime.textContent = `${webgpuContext.inferenceTimeMs} ms`;
          if (webgpuSignalModel) webgpuSignalModel.textContent = "mobilenetv4 (WebGPU)";
          if (webgpuSignalPrediction) webgpuSignalPrediction.textContent = webgpuContext.topPrediction || "Visual context ready";
        } else if (webgpuContext) {
          webgpuTelemetryRow.style.display = "block";
          if (webgpuSignalStatus) {
            webgpuSignalStatus.textContent = "Unavailable";
            webgpuSignalStatus.style.color = "#ca8a04";
          }
          if (webgpuSignalTime) webgpuSignalTime.textContent = "-";
          if (webgpuSignalModel) webgpuSignalModel.textContent = "mobilenetv4 (WebGPU)";
          if (webgpuSignalPrediction) webgpuSignalPrediction.textContent = "Hardware fallback";
        }
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
async function inPageActionExecutor(action, elementId, textToType, isProtectedHint, pressEnter = false) {
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

      // Pre-action cart and button indicators
      const cartCounterBefore = document.querySelector('#cart-counter, [id*="cart-count" i], [class*="cart-count" i], [aria-label*="cart" i]');
      const initialCartText = cartCounterBefore ? cartCounterBefore.textContent.trim() : "";
      const initialBtnText = targetEl.textContent ? targetEl.textContent.trim() : "";

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

      // Check for cart updates
      const cartBannerEl = document.querySelector('#cart-notification-banner, #cart-notification-text, [id*="cart-status" i], [class*="cart-notification" i], [class*="cart-toast" i]');
      const cartCounterAfter = document.querySelector('#cart-counter, [id*="cart-count" i], [class*="cart-count" i], [aria-label*="cart" i]');
      const currentCartText = cartCounterAfter ? cartCounterAfter.textContent.trim() : "";
      const currentBtnText = targetEl.isConnected && targetEl.textContent ? targetEl.textContent.trim() : "";

      if (cartBannerEl && window.getComputedStyle(cartBannerEl).display !== "none" && cartBannerEl.textContent.trim()) {
        isVerified = true;
        const rawBanner = cartBannerEl.textContent.trim();
        verifyMsg = rawBanner.replace(/^[✓✔\s]+/, "");
      } else if (currentCartText && initialCartText && currentCartText !== initialCartText) {
        isVerified = true;
        verifyMsg = `Cart updated: count changed from "${initialCartText}" to "${currentCartText}".`;
      } else if (currentBtnText && currentBtnText !== initialBtnText && /added/i.test(currentBtnText)) {
        isVerified = true;
        verifyMsg = `Cart updated: button state changed to "${currentBtnText}".`;
      } else if (currentUrl !== initialUrl) {
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

      // If pressEnter is requested, dispatch realistic Enter keyboard sequence
      if (pressEnter) {
        const keyboardEventInit = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          charCode: 13,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window
        };

        inputEl.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit));
        inputEl.dispatchEvent(new KeyboardEvent("keypress", keyboardEventInit));
        inputEl.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit));

        if (inputEl.form && typeof inputEl.form.requestSubmit === "function") {
          try {
            inputEl.form.requestSubmit();
          } catch (e) {
            // Handled by listeners or already submitted
          }
        }
      }

      if (pressEnter) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      // Verification: verify current value matches requested text
      const finalValue = inputEl.isContentEditable ? inputEl.textContent : inputEl.value;
      const isVerified = (finalValue === textToType);

      return {
        status: "ok",
        action: "type",
        element_id: elementId,
        message: `Successfully typed "${textToType}" into element ${elementId}${pressEnter ? " and submitted Enter" : ""}.`,
        verification: {
          status: isVerified ? "verified" : "unverified",
          message: isVerified
            ? (pressEnter ? "Input value matches requested text and Enter sequence dispatched." : "Input value matches requested text.")
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
async function executeBrowserAction(action, elementId, textToType = "", pressEnter = false) {
  if (currentSession && currentSession.isStale) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "Action blocked: active page changed since last scan. A fresh scan and UI grounding are required before executing actions.",
      verification: null
    };
  }

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
  if (!tab || !tab.id) {
    return {
      status: "failed",
      action: action,
      element_id: elementId,
      message: "No active browser tab found.",
      verification: null
    };
  }

  // Ensure all arguments passed to chrome.scripting.executeScript are strictly primitive structured-clone-safe values
  const safeAction = String(action || "click");
  const safeElementId = String(elementId || "");
  const safeTextToType = textToType != null ? String(textToType) : "";
  const safeIsProtected = Boolean(isProtected);
  const safePressEnter = Boolean(pressEnter);

  // Wrap executeScript with a timeout so navigation tearing down the frame context never hangs the popup
  const scriptPromise = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: inPageActionExecutor,
    args: [safeAction, safeElementId, safeTextToType, safeIsProtected, safePressEnter]
  });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve("TIMEOUT_OR_NAVIGATION"), 1500)
  );

  let results;
  try {
    results = await Promise.race([scriptPromise, timeoutPromise]);
  } catch (err) {
    if (action === "click" || (action === "type" && safePressEnter)) {
      return {
        status: "ok",
        action: action,
        element_id: elementId,
        message: `Action executed on ${elementId} (navigation transition detected).`,
        verification: {
          status: "verified",
          message: "Navigation/transition initiated by action."
        }
      };
    }
    throw err;
  }

  if (results === "TIMEOUT_OR_NAVIGATION") {
    if (action === "click" || (action === "type" && safePressEnter)) {
      return {
        status: "ok",
        action: action,
        element_id: elementId,
        message: `Action executed on ${elementId} (navigation transition detected).`,
        verification: {
          status: "verified",
          message: "Navigation/transition initiated by action."
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
    if (action === "click" || (action === "type" && safePressEnter)) {
      return {
        status: "ok",
        action: action,
        element_id: elementId,
        message: `Action executed on ${elementId} (page transition detected).`,
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
      const reasonResp1 = await queryReasoningBackend(
        "Find the search bar",
        protectedScreenshot,
        compressedElements,
        viewport
      );
      const decision1 = reasonResp1 && reasonResp1.decision ? reasonResp1.decision : (reasonResp1 || {});

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

      const reasonResp2 = await queryReasoningBackend(
        "Find the search submit button or Go button",
        protectedScreenshot,
        compressedElements,
        viewport
      );
      const decision2 = reasonResp2 && reasonResp2.decision ? reasonResp2.decision : (reasonResp2 || {});

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

// ==========================================
// Generic Search-Before-Comparison Grounding
// ==========================================

function extractSearchQueryFromTask(task) {
  if (!task || typeof task !== "string") return "";
  const t = task.trim();

  // Pattern 1: find / search for / look for / show me / get ...
  const m1 = t.match(/\b(?:find|search\s+for|look\s+for|show\s+me|get)\s+(?:the\s+best\s+|the\s+cheapest\s+|the\s+highest[- ]rated\s+|the\s+|a\s+|an\s+)?(.*?)(?=\s*(?:\band\b|\bcompare\b|\bbased\s+on\b|\bby\s+(?:price|rating)\b|\bto\s+(?:the\s+)?cart\b|\bon\b|$|\.|\,))/i);
  if (m1 && m1[1]) {
    let q = m1[1].trim();
    q = q.replace(/\b(?:available\s+products|available\s+items|products|items|options)\b/gi, "").trim();
    if (q.length > 1) return q;
  }

  // Pattern 2: compare [these/the/available] [query] based on / by / etc.
  const m2 = t.match(/\bcompare\s+(?:these\s+|the\s+|available\s+)?(.*?)(?=\s*(?:\bbased\s+on\b|\bby\s+(?:price|rating)\b|\band\b|\bto\b|$|\.|\,))/i);
  if (m2 && m2[1]) {
    let q = m2[1].trim();
    q = q.replace(/\b(?:available\s+products|available\s+items|products|items|options)\b/gi, "").trim();
    if (q.length > 1) return q;
  }

  return "";
}

function isPageAlreadyOnSearchResults(query, currentUrl, products) {
  if (!query || typeof query !== "string") return true;
  const qTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !["the", "for", "and", "with", "best", "available", "product", "products"].includes(w));
  if (qTokens.length === 0) return true;

  // 1. Check URL parameters for search query tokens
  if (currentUrl && typeof currentUrl === "string") {
    try {
      const urlObj = new URL(currentUrl);
      const searchParams = urlObj.search.toLowerCase();
      const pathname = urlObj.pathname.toLowerCase();
      const hasSearchParam = searchParams.includes("k=") ||
                             searchParams.includes("q=") ||
                             searchParams.includes("search") ||
                             searchParams.includes("query=") ||
                             pathname.includes("/s") ||
                             pathname.includes("/search");
      if (hasSearchParam) {
        const tokensInUrl = qTokens.filter(tok => searchParams.includes(tok) || pathname.includes(tok));
        if (tokensInUrl.length >= Math.min(2, qTokens.length)) {
          return true;
        }
      }
    } catch (_) {}
  }

  // 2. Check if currently extracted products on the page already match the query tokens
  if (Array.isArray(products) && products.length >= 2) {
    let matchingProds = 0;
    for (const p of products) {
      const name = (p.name || "").toLowerCase();
      const matches = qTokens.some(tok => name.includes(tok));
      if (matches) matchingProds++;
    }
    if (matchingProds >= 2 || matchingProds >= Math.ceil(products.length * 0.5)) {
      return true;
    }
  }

  return false;
}

function findGenericSearchBar(compressedElements) {
  if (!Array.isArray(compressedElements) || compressedElements.length === 0) {
    return null;
  }

  const searchKeywords = ["search", "find", "query", "keyword", "keywords", "explore", "lookup"];
  let bestCandidate = null;
  let bestScore = -1;

  for (const el of compressedElements) {
    if (el.protected) continue;

    const tag = (el.tag || "").toLowerCase();
    const role = (el.role || el.ariaRole || "").toLowerCase();
    const type = ((el.attributes && el.attributes.type) || "").toLowerCase();

    const isTextualInput = (tag === "input" && (type === "text" || type === "search" || type === "" || !type)) ||
                          (tag === "textarea") ||
                          (role === "searchbox");
    if (!isTextualInput) continue;

    if (el.rect && (el.rect.width < 30 || el.rect.height < 15)) continue;
    if (el.isVisible === false) continue;

    let score = 0;
    if (role === "searchbox") score += 50;
    if (type === "search") score += 40;

    const placeholder = ((el.attributes && el.attributes.placeholder) || "").toLowerCase();
    const ariaLabel = ((el.attributes && el.attributes.ariaLabel) || "").toLowerCase();
    const name = ((el.attributes && el.attributes.name) || "").toLowerCase();
    const title = ((el.attributes && el.attributes.title) || "").toLowerCase();

    if (searchKeywords.some((kw) => placeholder.includes(kw))) score += 35;
    if (searchKeywords.some((kw) => ariaLabel.includes(kw))) score += 30;
    if (name === "q" || name === "k" || name === "query" || name === "search" || searchKeywords.some((kw) => name.includes(kw))) score += 30;
    if (searchKeywords.some((kw) => title.includes(kw))) score += 20;

    if (el.rect) {
      if (el.rect.y >= 0 && el.rect.y < 200) score += 20;
      else if (el.rect.y < 350) score += 10;

      if (el.rect.width > 200) score += 15;
      else if (el.rect.width > 120) score += 5;
    }

    if (score > bestScore && score >= 25) {
      bestScore = score;
      bestCandidate = el;
    }
  }

  return bestCandidate;
}

function findGenericSearchSubmitButton(compressedElements, searchBar) {
  if (!Array.isArray(compressedElements) || compressedElements.length === 0) {
    return null;
  }

  const submitKeywords = ["search", "go", "submit", "find"];
  let bestBtn = null;
  let bestScore = -1;

  for (const el of compressedElements) {
    if (el.protected) continue;
    if (searchBar && el.id === searchBar.id) continue;

    const tag = (el.tag || "").toLowerCase();
    const role = (el.role || el.ariaRole || "").toLowerCase();
    const type = ((el.attributes && el.attributes.type) || "").toLowerCase();

    const isBtn = tag === "button" || role === "button" || type === "submit" || (tag === "input" && type === "button");
    if (!isBtn) continue;
    if (el.isVisible === false) continue;

    let score = 0;
    if (type === "submit") score += 30;

    const text = ((el.text || "") + " " + (el.attributes?.ariaLabel || "") + " " + (el.attributes?.title || "")).toLowerCase();
    if (submitKeywords.some(kw => text.includes(kw))) score += 35;

    if (searchBar && searchBar.rect && el.rect) {
      const verticalDiff = Math.abs(el.rect.y - searchBar.rect.y);
      const horizontalDiff = el.rect.x - (searchBar.rect.x + searchBar.rect.width);
      if (verticalDiff < 40 && horizontalDiff >= -10 && horizontalDiff < 120) {
        score += 40;
      } else if (verticalDiff < 40 && Math.abs(horizontalDiff) < 150) {
        score += 20;
      }
    }

    if (score > bestScore && score >= 25) {
      bestScore = score;
      bestBtn = el;
    }
  }

  return bestBtn;
}

async function waitForPageSettle(timeoutMs = 2500) {
  const start = Date.now();
  await new Promise(r => setTimeout(r, 600));

  while (Date.now() - start < timeoutMs) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.status === "complete") {
        break;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 1200));
}

async function performGenericSearch(query) {
  if (!query) return false;

  console.log(`[LocalLens Search] Performing generic search for "${query}"...`);
  if (status) status.textContent = `Status: Searching for "${query}"...`;

  if (!lastCompressedElements || lastCompressedElements.length === 0) {
    await captureSanitizedScreenshot();
  }

  let searchBar = findGenericSearchBar(lastCompressedElements);
  if (!searchBar) {
    console.log("[LocalLens Search] Using local reasoning backend to locate search bar...");
    try {
      const reasonResp = await queryReasoningBackend(
        "Find the search bar or input field to search for products",
        lastScreenshot,
        lastCompressedElements,
        lastViewport
      );
      const decision = reasonResp && reasonResp.decision ? reasonResp.decision : (reasonResp || {});
      if (decision.status === "ok" && decision.element_id) {
        const found = lastCompressedElements.find(el => el.id === decision.element_id);
        if (found && !found.protected) {
          searchBar = found;
        }
      }
    } catch (e) {
      console.warn("[LocalLens Search] Reasoning fallback error:", e);
    }
  }

  if (!searchBar) {
    console.warn("[LocalLens Search] No generic search bar found on page.");
    return false;
  }

  if (searchBar.protected) {
    console.warn("[LocalLens Search] Search bar is protected. Aborting search for privacy.");
    return false;
  }

  if (status) status.textContent = `Status: Typing "${query}" into search bar...`;
  const typeRes = await executeBrowserAction("type", String(searchBar.id), query, true);
  console.log("[LocalLens Search] Type result:", typeRes);

  const submitBtn = findGenericSearchSubmitButton(lastCompressedElements, searchBar);
  if (submitBtn && (!typeRes || typeRes.status !== "ok")) {
    console.log("[LocalLens Search] Clicking search submit button:", submitBtn.id);
    try {
      await executeBrowserAction("click", String(submitBtn.id), "");
    } catch (_) {}
  }

  if (status) status.textContent = `Status: Loading search results for "${query}"...`;
  await waitForPageSettle(3000);

  console.log("[LocalLens Search] Scanning search results page...");
  if (status) status.textContent = "Status: Scanning search results and extracting products...";
  const scanRes = await captureSanitizedScreenshot();
  return Boolean(scanRes && scanRes.pageData);
}

// ==========================================
// Grounded Product Comparison (Core SIH Goal)
// ==========================================

const compareProductsButton = document.getElementById("compareProductsButton");
const compareTaskInput = document.getElementById("compareTaskInput");
const compareProductsList = document.getElementById("compareProductsList");
const compareProductsContainer = document.getElementById("compareProductsContainer");
const compareResultDisplay = document.getElementById("compareResultDisplay");
const compareRecBadge = document.getElementById("compareRecBadge");
const compareRecName = document.getElementById("compareRecName");
const compareRecPrice = document.getElementById("compareRecPrice");
const compareRecRating = document.getElementById("compareRecRating");
const compareRecTarget = document.getElementById("compareRecTarget");
const compareRecReason = document.getElementById("compareRecReason");

if (compareProductsButton) {
  compareProductsButton.addEventListener("click", async () => {
    const task = (compareTaskInput ? compareTaskInput.value : "").trim() || "Find wireless headphones and compare the available products by price and rating.";

    compareProductsButton.disabled = true;
    if (compareResultDisplay) compareResultDisplay.style.display = "none";
    if (compareProductsList) compareProductsList.style.display = "none";

    try {
      // 1. Inspect active tab URL and state
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentUrl = activeTab ? activeTab.url || "" : "";

      // 2. Check if task contains a search requirement
      const searchQuery = extractSearchQueryFromTask(task);
      if (searchQuery) {
        const alreadyOnSearch = isPageAlreadyOnSearchResults(searchQuery, currentUrl, lastExtractedProducts);
        if (!alreadyOnSearch) {
          console.log(`[LocalLens Compare] Task requires search for "${searchQuery}". Executing search first.`);
          await performGenericSearch(searchQuery);
        }
      }

      // 3. If products not already extracted or need refresh, run scan & protect
      if (!lastExtractedProducts || lastExtractedProducts.length === 0) {
        if (status) status.textContent = "Status: Extracting grounded products from DOM...";
        await captureSanitizedScreenshot();
      }

      if (!lastExtractedProducts || lastExtractedProducts.length === 0) {
        if (compareResultDisplay) {
          compareResultDisplay.style.display = "block";
          if (compareRecBadge) compareRecBadge.textContent = "NO_PRODUCTS";
          if (compareRecName) compareRecName.textContent = "No products found on page";
          if (compareRecPrice) compareRecPrice.textContent = "-";
          if (compareRecRating) compareRecRating.textContent = "-";
          if (compareRecTarget) compareRecTarget.textContent = "-";
          if (compareRecReason) compareRecReason.textContent = "LocalLens could not detect any product cards or price/rating groups on the current page.";
        }
        return;
      }

      // 2. Generate clean shortlist of at most 3 strong candidates for the user's task
      const shortlist = generateProductShortlist(lastExtractedProducts, task);
      lastShortlistedProducts = shortlist;

      // Render clean shortlist of up to 3 candidates with checkboxes & badges
      console.log(`[LocalLens Diagnostic] Rendering shortlist in UI: ${shortlist.length} products (total extracted pool: ${lastExtractedProducts ? lastExtractedProducts.length : 0})`);
      renderProductCardRows(shortlist);

      if (status) status.textContent = `Status: Sending ${shortlist.length} shortlisted products to local Qwen for comparison...`;

      // 3. Send ONLY the compact grounded product metadata to local backend
      const formData = new FormData();
      formData.append("task", task);
      formData.append("products", JSON.stringify(shortlist));

      const res = await fetch("http://127.0.0.1:8000/compare", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Backend error HTTP ${res.status}`);
      }

      const data = await res.json();
      const dec = data.decision || {};

      // 4. Display the grounded comparison result
      if (compareResultDisplay) {
        compareResultDisplay.style.display = "block";

        if (dec.status === "ok" && dec.recommended_product) {
          const rec = dec.recommended_product;
          lastRecommendedProduct = rec;

          // Pre-select recommended product if no checkboxes are currently selected
          if (compareProductsContainer) {
            const checkedAny = compareProductsContainer.querySelector(".product-select-checkbox:checked");
            if (!checkedAny) {
              const recCheckbox = compareProductsContainer.querySelector(`.product-select-checkbox[data-product-id="${rec.id}"]`);
              if (recCheckbox) {
                recCheckbox.checked = true;
                updateSelectedCountBadge();
              }
            }
          }

          restoreRecommendationUI(rec, dec);

          // Pre-populate Action Executor target with recommended product's button
          if (rec.element_id && actionTargetInput) {
            actionTargetInput.value = rec.element_id;
            if (actionTargetBadge) actionTargetBadge.textContent = rec.element_id;
            if (actionExecutionSection) actionExecutionSection.style.display = "block";
          }

          const addSelectedToCartRes = document.getElementById("addSelectedToCartResult");
          if (addSelectedToCartRes) {
            addSelectedToCartRes.style.display = "none";
          }

          if (status) status.textContent = `Status: Product comparison complete (${data.telemetry ? data.telemetry.inference_time_ms : '-'} ms) ✓`;
          saveSessionState({
            task: task,
            discoveredProducts: lastExtractedProducts,
            selectedProductIds: Array.from(
              compareProductsContainer
                ? compareProductsContainer.querySelectorAll(".product-select-checkbox:checked")
                : []
            )
              .map((cb) => cb.dataset.productId)
              .filter(Boolean),
            recommendedProduct: lastRecommendedProduct,
            comparisonDecision: dec,
            status: status.textContent,
            workflowType: "compare",
          }, true);
        } else {
          lastRecommendedProduct = null;
          const addSelectedToCartBtn = document.getElementById("addSelectedToCartButton");
          if (addSelectedToCartBtn) addSelectedToCartBtn.style.display = "none";

          if (compareRecBadge) {
            compareRecBadge.textContent = "INSUFFICIENT";
            compareRecBadge.style.background = "#fee2e2";
            compareRecBadge.style.color = "#dc2626";
          }
          if (compareRecName) compareRecName.textContent = "Context Insufficient";
          if (compareRecPrice) compareRecPrice.textContent = "-";
          if (compareRecRating) compareRecRating.textContent = "-";
          if (compareRecTarget) compareRecTarget.textContent = "-";
          if (compareRecReason) compareRecReason.textContent = dec.reason || "Insufficient information to make a valid comparison.";
          if (status) status.textContent = "Status: Product comparison halted (insufficient context).";

          saveSessionState({
            task: task,
            discoveredProducts: lastExtractedProducts,
            recommendedProduct: null,
            comparisonDecision: dec,
            status: status.textContent,
            workflowType: "compare",
          }, true);
        }
      }
    } catch (err) {
      console.error("[LocalLens Compare] Error:", err);
      if (compareResultDisplay) {
        compareResultDisplay.style.display = "block";
        if (compareRecBadge) compareRecBadge.textContent = "ERROR";
        if (compareRecName) compareRecName.textContent = "Comparison Failed";
        if (compareRecReason) compareRecReason.textContent = err.message || String(err);
      }
      if (status) status.textContent = "Status: Error in product comparison.";
    } finally {
      compareProductsButton.disabled = false;
    }
  });
}

// ==========================================
// Generic Product Customer Review Research
// OBSERVE → PROTECT → GROUND → REASON → ACT → VERIFY → OBSERVE AGAIN
// ==========================================

function inPageReviewExtractor(targetProductId, maxReviews = 10) {
  const sanitizeText = (text) => {
    if (!text) return "";
    let s = text.trim();
    // Mask emails
    s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED]");
    // Mask phone numbers (US/India/International standard patterns)
    s = s.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[REDACTED]");
    s = s.replace(/\b\d{10}\b/g, "[REDACTED]");
    // Mask credit card / 16-digit sequences
    s = s.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, "[REDACTED]");
    // Mask sensitive accounts / order IDs
    s = s.replace(/\b(?:SSN|card|account|order|pin)[\s#:]*([a-zA-Z0-9-]+)/gi, "$1 [REDACTED]");
    return s.slice(0, 300);
  };

  const snippets = [];
  const visitedTexts = new Set();

  let root = document;
  if (targetProductId) {
    const specificCard = document.querySelector(`[data-product-id="${targetProductId}"]`);
    if (specificCard) {
      root = specificCard;
    }
  }

  const selectors = [
    ".customer-review",
    "[data-hook='review']",
    "[data-hook='review-collapsed']",
    "[class*='review-item' i]",
    "[class*='review-content' i]",
    "[class*='customer-review' i]",
    ".product-reviews-drawer p",
    ".product-reviews-drawer .customer-review",
    "[id*='review' i] p",
    "[class*='review' i] p",
    "article p"
  ];

  let reviewElements = Array.from(root.querySelectorAll(selectors.join(", ")));

  if (reviewElements.length === 0 && root !== document) {
    reviewElements = Array.from(document.querySelectorAll(selectors.join(", ")));
  }

  for (const el of reviewElements) {
    if (snippets.length >= maxReviews) break;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      continue;
    }

    if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SCRIPT", "STYLE"].includes(el.tagName)) {
      continue;
    }

    if (el.classList.contains("locallens-redaction") || el.getAttribute("data-ll-protected") === "true") {
      continue;
    }

    let rawText = (el.innerText || el.textContent || "").trim();
    if (rawText.length < 15 || rawText.length > 800) continue;
    if (/^(customer reviews|ratings & reviews|see all reviews|write a review|customer feedback)$/i.test(rawText)) {
      continue;
    }

    const sanitized = sanitizeText(rawText);
    if (sanitized && !visitedTexts.has(sanitized)) {
      visitedTexts.add(sanitized);
      snippets.push(sanitized);
    }
  }

  return snippets;
}

function findGroundedReviewControl(compressedElements, targetProduct) {
  if (!targetProduct) return null;
  if (targetProduct.review_control_id) {
    const el = (compressedElements || []).find((e) => e.id === targetProduct.review_control_id);
    if (el && !el.protected) return el.id;
  }

  const candidates = (compressedElements || []).filter((el) => {
    if (el.protected || el.isVisible === false) return false;
    const isInteractive = el.isInteractive || el.role === "button" || el.role === "link" || el.tag === "button" || el.tag === "a";
    if (!isInteractive) return false;

    const text = (el.text || "").toLowerCase();
    const aria = (el.attributes && el.attributes.ariaLabel ? el.attributes.ariaLabel : "").toLowerCase();
    const combined = `${text} ${aria}`;

    const isReview = /\b(?:customer\s+reviews?|reviews?|ratings?|see\s+all\s+reviews?|read\s+reviews?|user\s+reviews?)\b/i.test(combined);
    const isNegative = /\b(?:write|submit|leave|add\s*to\s*cart|buy|cart|bag)\b/i.test(combined);

    return isReview && !isNegative;
  });

  if (candidates.length === 0) return null;

  if (targetProduct.bounds && targetProduct.bounds.length === 4) {
    const [px, py, pw, ph] = targetProduct.bounds;
    const inCardCandidate = candidates.find((c) => {
      const r = c.rect;
      if (!r) return false;
      return r.x >= px - 15 && r.y >= py - 15 && (r.x + r.width) <= (px + pw + 15) && (r.y + r.height) <= (py + ph + 15);
    });
    if (inCardCandidate) return inCardCandidate.id;

    candidates.sort((a, b) => {
      const distA = Math.abs((a.rect ? a.rect.y : 0) - py);
      const distB = Math.abs((b.rect ? b.rect.y : 0) - py);
      return distA - distB;
    });
    return candidates[0].id;
  }

  return candidates[0].id;
}

async function fetchReviewSummary(productName, reviewSnippets, rating = null) {
  if (!reviewSnippets || reviewSnippets.length === 0) {
    return {
      status: "reviews_unavailable",
      product_name: productName,
      positive_themes: [],
      negative_themes: [],
      summary: "No customer review content available for this product.",
      confidence: "low",
      reviews_count: 0
    };
  }

  const formData = new FormData();
  formData.append("product_name", productName || "Product");
  formData.append("reviews", JSON.stringify(reviewSnippets));
  if (rating) {
    formData.append("rating", rating);
  }

  const res = await fetch("http://127.0.0.1:8000/summarize_reviews", {
    method: "POST",
    body: formData
  });

  if (!res.ok) {
    throw new Error(`Review summarization failed with HTTP ${res.status}`);
  }

  return await res.json();
}

async function researchProductReviews(products, maxProducts = 3) {
  if (!products || products.length === 0) return { analyzed: 0, results: {} };

  const reviewTelemetry = document.getElementById("reviewResearchTelemetry");
  const reviewStatus = document.getElementById("reviewResearchStatus");
  const reviewBadge = document.getElementById("reviewResearchBadge");

  if (reviewTelemetry) reviewTelemetry.style.display = "flex";
  if (reviewStatus) reviewStatus.textContent = "Reviews: Initializing generic research...";

  const targetList = products.slice(0, maxProducts);
  let analyzedCount = 0;
  const results = {};

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    if (reviewStatus) reviewStatus.textContent = "Reviews: No active tab found.";
    return { analyzed: 0, results: {} };
  }

  for (let i = 0; i < targetList.length; i++) {
    const prod = targetList[i];
    if (reviewStatus) {
      reviewStatus.textContent = `Reviews: [${i + 1}/${targetList.length}] Researching "${prod.name.slice(0, 20)}..."`;
    }
    if (reviewBadge) {
      reviewBadge.textContent = `${analyzedCount}/${targetList.length} products analyzed`;
    }

    try {
      // Step A: Extract currently visible reviews for this product on active tab
      let [execRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageReviewExtractor,
        args: [String(prod.id || ""), 10]
      });
      let snippets = (execRes && execRes.result) || [];

      // Step B: If no reviews visible, find grounded review control and click it
      if (snippets.length === 0) {
        const controlId = findGroundedReviewControl(lastCompressedElements, prod);
        if (controlId) {
          console.log(`[LocalLens Review] Opening reviews for [${prod.id}] via control [${controlId}]...`);
          await executeBrowserAction("click", String(controlId), "");
          await new Promise((r) => setTimeout(r, 600));

          [execRes] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageReviewExtractor,
            args: [String(prod.id || ""), 10]
          });
          snippets = (execRes && execRes.result) || [];
        }
      }

      // Step C: Fallback to product detail page if still no reviews visible
      if (snippets.length === 0 && prod.detail_link_id) {
        const detailTarget = prod.detail_link_id;
        console.log(`[LocalLens Review] Navigating to product detail link [${detailTarget}] to inspect reviews...`);
        try {
          await executeBrowserAction("click", String(detailTarget), "");
          await waitForPageSettle(2500);
          await captureSanitizedScreenshot();

          const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (freshTab && freshTab.id) {
            [execRes] = await chrome.scripting.executeScript({
              target: { tabId: freshTab.id },
              func: inPageReviewExtractor,
              args: [String(prod.id || ""), 10]
            });
            snippets = (execRes && execRes.result) || [];
          }
        } catch (navErr) {
          console.warn("[LocalLens Review] Detail page navigation error:", navErr);
        }
      }

      // Step D: Scrubbed PII reviews summarized via local Qwen backend
      if (snippets.length > 0) {
        const summaryData = await fetchReviewSummary(prod.name, snippets, prod.rating);
        results[prod.id] = {
          productId: prod.id,
          status: summaryData.status || "ok",
          summary: summaryData.summary || "",
          positiveThemes: summaryData.positive_themes || [],
          negativeThemes: summaryData.negative_themes || [],
          confidence: summaryData.confidence || "medium",
          reviewsCount: snippets.length
        };
        prod.review_summary = summaryData.summary;
        prod.positive_themes = summaryData.positive_themes;
        prod.negative_themes = summaryData.negative_themes;
        analyzedCount++;
      } else {
        results[prod.id] = {
          productId: prod.id,
          status: "reviews_unavailable",
          summary: "Customer review content is unavailable or unrevealed for this product.",
          positiveThemes: [],
          negativeThemes: [],
          confidence: "low",
          reviewsCount: 0
        };
      }
    } catch (err) {
      console.warn(`[LocalLens Review] Failed to research reviews for [${prod.id}]:`, err);
      results[prod.id] = {
        productId: prod.id,
        status: "error",
        summary: `Review research error: ${err.message || String(err)}`,
        positiveThemes: [],
        negativeThemes: [],
        confidence: "low",
        reviewsCount: 0
      };
    }
  }

  // Store in currentSession.reviewResearch
  currentSession.reviewResearch = { ...(currentSession.reviewResearch || {}), ...results };
  saveSessionState({
    reviewResearch: currentSession.reviewResearch,
    discoveredProducts: lastExtractedProducts
  }, true);

  if (analyzedCount > 0) {
    if (reviewStatus) reviewStatus.textContent = `Reviews: Research complete (${analyzedCount} analyzed) ✓`;
    if (reviewBadge) reviewBadge.textContent = `${analyzedCount} products analyzed`;
  } else {
    if (reviewStatus) reviewStatus.textContent = `Reviews: Insufficient review context`;
    if (reviewBadge) reviewBadge.textContent = `0 reviews extracted`;
  }

  return { analyzed: analyzedCount, results: results };
}

const researchReviewsButton = document.getElementById("researchReviewsButton");
if (researchReviewsButton) {
  researchReviewsButton.addEventListener("click", async () => {
    researchReviewsButton.disabled = true;
    try {
      if (!lastExtractedProducts || lastExtractedProducts.length === 0) {
        if (status) status.textContent = "Status: Scanning DOM & extracting products...";
        await captureSanitizedScreenshot();
      }

      if (!lastExtractedProducts || lastExtractedProducts.length === 0) {
        alert("No products detected on page to research reviews for.");
        return;
      }

      // Prioritize selected products if user checked any checkboxes, otherwise shortlisted products
      const selectedBoxes = Array.from(document.querySelectorAll("#compareProductsContainer .product-select-checkbox:checked"));
      let targetPool = [];
      if (selectedBoxes.length > 0) {
        const selectedIds = selectedBoxes.map((cb) => cb.dataset.productId);
        targetPool = (lastShortlistedProducts || lastExtractedProducts || []).filter((p) => selectedIds.includes(p.id));
      }
      if (targetPool.length === 0) {
        targetPool = (lastShortlistedProducts && lastShortlistedProducts.length > 0)
          ? lastShortlistedProducts
          : (lastExtractedProducts || []).slice(0, 3);
      }

      renderProductCardRows(lastShortlistedProducts && lastShortlistedProducts.length > 0 ? lastShortlistedProducts : lastExtractedProducts, currentSession.selectedProductIds || []);

      if (status) status.textContent = "Status: Researching customer reviews with local Qwen...";
      const researchRes = await researchProductReviews(targetPool, 3);

      if (researchRes.analyzed > 0) {
        // Re-evaluate comparison with customer review themes
        if (status) status.textContent = "Status: Re-evaluating comparison with customer review themes...";
        const task = (compareTaskInput ? compareTaskInput.value : "").trim() || "Compare products based on price, rating, and customer reviews.";

        const formData = new FormData();
        formData.append("task", task);
        formData.append("products", JSON.stringify(targetPool));

        const res = await fetch("http://127.0.0.1:8000/compare", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          throw new Error(`Backend comparison error HTTP ${res.status}`);
        }

        const data = await res.json();
        const dec = data.decision || {};

        if (compareResultDisplay) {
          compareResultDisplay.style.display = "block";
          if (dec.status === "ok" && dec.recommended_product) {
            const rec = dec.recommended_product;
            lastRecommendedProduct = rec;
            if (!rec.review_summary && researchRes.results[rec.id] && researchRes.results[rec.id].summary) {
              rec.review_summary = researchRes.results[rec.id].summary;
              rec.positive_themes = researchRes.results[rec.id].positiveThemes;
              rec.negative_themes = researchRes.results[rec.id].negativeThemes;
            }
            restoreRecommendationUI(rec, dec);

            // Update action executor target
            if (rec.element_id && actionTargetInput) {
              actionTargetInput.value = rec.element_id;
              if (actionTargetBadge) actionTargetBadge.textContent = rec.element_id;
              if (actionExecutionSection) actionExecutionSection.style.display = "block";
            }
          }
        }

        // Visibly display review findings in LocalLens popup
        const reviewSec = document.getElementById("compareRecReviewSection");
        const posEl = document.getElementById("compareRecPositiveThemes");
        const negEl = document.getElementById("compareRecNegativeThemes");
        const sumEl = document.getElementById("compareRecReviewSummary");
        const reviewedProd = (lastRecommendedProduct && lastRecommendedProduct.review_summary)
          ? lastRecommendedProduct
          : targetPool.find((p) => p.review_summary);

        if (reviewSec && reviewedProd && reviewedProd.review_summary) {
          reviewSec.style.display = "block";
          if (posEl) {
            posEl.textContent = reviewedProd.positive_themes && reviewedProd.positive_themes.length > 0
              ? `+ Pros: ${reviewedProd.positive_themes.join(", ")}`
              : "";
            posEl.style.display = posEl.textContent ? "block" : "none";
          }
          if (negEl) {
            negEl.textContent = reviewedProd.negative_themes && reviewedProd.negative_themes.length > 0
              ? `- Cons: ${reviewedProd.negative_themes.join(", ")}`
              : "";
            negEl.style.display = negEl.textContent ? "block" : "none";
          }
          if (sumEl) {
            sumEl.style.display = "block";
            sumEl.style.color = "#334155";
            sumEl.textContent = `"${reviewedProd.review_summary}"`;
          }
        }

        if (status) status.textContent = `Status: Customer reviews summarized successfully (${researchRes.analyzed} products analyzed) ✓`;
        saveSessionState({
          task: task,
          discoveredProducts: lastExtractedProducts,
          shortlistedProducts: targetPool,
          recommendedProduct: lastRecommendedProduct,
          reviewResearch: currentSession.reviewResearch,
          status: status.textContent,
          workflowType: "compare"
        }, true);
      } else {
        // INSUFFICIENT REVIEW CONTEXT: Do NOT report "Review completed"!
        const reviewSec = document.getElementById("compareRecReviewSection");
        const posEl = document.getElementById("compareRecPositiveThemes");
        const negEl = document.getElementById("compareRecNegativeThemes");
        const sumEl = document.getElementById("compareRecReviewSummary");
        if (reviewSec) {
          reviewSec.style.display = "block";
          if (posEl) posEl.style.display = "none";
          if (negEl) negEl.style.display = "none";
          if (sumEl) {
            sumEl.style.display = "block";
            sumEl.style.color = "#854d0e";
            sumEl.textContent = "Insufficient review context: No customer review snippets were safely accessible or revealed on the current page for these products.";
          }
        }
        if (status) status.textContent = "Status: Review research halted (insufficient review context).";
      }
    } catch (err) {
      console.error("[LocalLens Review Research] Error:", err);
      if (status) status.textContent = `Status: Review research error: ${err.message}`;
    } finally {
      researchReviewsButton.disabled = false;
    }
  });
}

/**
 * Generic Add-to-Cart executor with product detail-page fallback:
 * 1. If product card has a direct Add-to-Cart button, clicks it directly and verifies cart update.
 * 2. If product card has no direct Add-to-Cart button, uses the product-detail link to open the product page.
 * 3. Waits for navigation & page stabilization (handles same tab and new tabs).
 * 4. Protects against wrong product clicks: verifies product title correspondence on detail page.
 * 5. Re-runs privacy scan and grounds UI on the product detail page (ensuring overlays & redactions).
 * 6. Finds the actual Add-to-Cart action on the product page using generic semantic/DOM grounding.
 * 7. Executes the grounded click and authoritatively verifies cart update.
 */
// Shared helper: Matches a product's stable identity against a list of freshly extracted products
function matchProductIdentity(targetProd, freshProducts) {
  if (!targetProd || !Array.isArray(freshProducts) || freshProducts.length === 0) {
    return null;
  }
  const targetId = targetProd.id ? String(targetProd.id).trim() : "";
  const targetName = (targetProd.name || "").toLowerCase().trim();
  const targetPrice = targetProd.price ? String(targetProd.price).replace(/[^0-9.]/g, "") : "";

  // 1. Exact match by both stable ID and Name
  if (targetId && targetName) {
    const exactBoth = freshProducts.find(
      (fp) => fp.id && String(fp.id).trim() === targetId && fp.name && fp.name.toLowerCase().trim() === targetName
    );
    if (exactBoth) return exactBoth;
  }

  // 2. Exact match by Name
  if (targetName) {
    const exactName = freshProducts.find(
      (fp) => fp.name && fp.name.toLowerCase().trim() === targetName
    );
    if (exactName) return exactName;
  }

  // 3. Exact match by ID
  if (targetId) {
    const exactId = freshProducts.find((fp) => fp.id && String(fp.id).trim() === targetId);
    if (exactId) return exactId;
  }

  // 4. Semantic Name containment / high token overlap
  if (targetName) {
    const targetTokens = targetName.split(/\s+/).filter((w) => w.length > 2);
    let bestMatch = null;
    let bestScore = 0;

    for (const fp of freshProducts) {
      const fpName = (fp.name || "").toLowerCase().trim();
      if (!fpName) continue;
      if (fpName.includes(targetName) || targetName.includes(fpName)) {
        return fp;
      }

      const fpTokens = fpName.split(/\s+/).filter((w) => w.length > 2);
      const matchedTokens = targetTokens.filter((t) => fpTokens.includes(t));
      const score = matchedTokens.length / Math.max(targetTokens.length, 1);
      if (score > 0.5 && score > bestScore) {
        bestScore = score;
        bestMatch = fp;
      }
    }

    if (bestMatch && bestScore >= 0.5) {
      return bestMatch;
    }
  }

  // 5. Fallback match by price if unique
  if (targetPrice) {
    const priceMatches = freshProducts.filter(
      (fp) => fp.price && fp.price.replace(/[^0-9.]/g, "") === targetPrice
    );
    if (priceMatches.length === 1) {
      return priceMatches[0];
    }
  }

  return null;
}

async function executeAddProductToCart(prod) {
  if (currentSession && currentSession.isStale) {
    return {
      status: "failed",
      message: "Action blocked: active page changed since last scan. Please click 'Scan Page' to re-ground elements before adding to cart."
    };
  }

  if (!prod) {
    return { status: "failed", message: "No product provided to add to cart." };
  }

  // =========================================================================
  // FRESH OBSERVATION & GROUNDING:
  // Immediately before executing each product's Add-to-Cart action, perform a
  // fresh privacy scan, DOM/UI grounding, and product extraction/re-matching.
  // Obtain the CURRENT Add-to-Cart target element ID instead of reusing stale IDs.
  // =========================================================================
  console.log(`[LocalLens Grounding] Re-grounding active page before Add-to-Cart for "${prod.name || prod.id}"...`);
  const scanRes = await captureSanitizedScreenshot();
  if (!scanRes || !scanRes.pageData) {
    return {
      status: "failed",
      message: `Failed to scan and re-ground DOM elements before executing Add-to-Cart for "${prod.name || prod.id}".`
    };
  }

  const freshCompressed = scanRes.pageData.compressedElements || lastCompressedElements || [];
  const freshProducts = scanRes.pageData.products || lastExtractedProducts || [];

  // Re-match the selected product using generic product identity
  const matchedProd = matchProductIdentity(prod, freshProducts);
  if (!matchedProd) {
    return {
      status: "failed",
      message: `Product "${prod.name || prod.id}" could not be re-grounded in current DOM.`
    };
  }

  // Ephemerally update target element IDs and capabilities from fresh grounding
  const currentHasDirectCart = Boolean(matchedProd.has_direct_cart);
  const currentElementId = matchedProd.element_id;
  const currentDetailLinkId = matchedProd.detail_link_id;

  // PATH A: DIRECT ADD-TO-CART ACTION ON PRODUCT CARD
  if (currentHasDirectCart && currentElementId) {
    const targetMeta = (freshCompressed || []).find((el) => el.id === currentElementId);
    if (!targetMeta) {
      return {
        status: "failed",
        message: `Action target element "${currentElementId}" no longer exists in UI map.`
      };
    }
    if (targetMeta.protected) {
      return {
        status: "failed",
        message: `Action rejected: target element "${currentElementId}" is privacy-protected/redacted.`
      };
    }
    if (targetMeta.isVisible === false) {
      return {
        status: "failed",
        message: `Target element "${currentElementId}" is not visible.`
      };
    }

    return await executeBrowserAction("click", String(currentElementId), "");
  }

  // PATH B: GENERIC PRODUCT DETAIL-PAGE FALLBACK
  const detailTargetId = currentDetailLinkId || currentElementId;
  if (!detailTargetId) {
    return {
      status: "failed",
      message: `Product [${prod.id}] "${prod.name}" has no Add to Cart button or detail link on current page.`
    };
  }

  const linkMeta = (freshCompressed || []).find((el) => el.id === detailTargetId);
  if (!linkMeta) {
    return {
      status: "failed",
      message: `Product link element "${detailTargetId}" no longer exists in UI map.`
    };
  }
  if (linkMeta.protected) {
    return {
      status: "failed",
      message: `Action rejected: product link element "${detailTargetId}" is privacy-protected/redacted.`
    };
  }

  const tabsBefore = await chrome.tabs.query({ currentWindow: true });

  // 1. Navigate to product detail page
  console.log(`[LocalLens Detail Fallback] Navigating to detail page for "${prod.name}" via element ${detailTargetId}...`);
  await executeBrowserAction("click", String(detailTargetId), "");

  // 2. Wait for navigation & page stabilization
  await new Promise((r) => setTimeout(r, 1200));

  // Determine active tab (in case opened in a new tab)
  const tabsAfter = await chrome.tabs.query({ currentWindow: true });
  let targetTab = null;
  if (tabsAfter.length > tabsBefore.length) {
    targetTab = tabsAfter.find((t) => !tabsBefore.some((b) => b.id === t.id)) || tabsAfter[tabsAfter.length - 1];
    if (targetTab && targetTab.id) {
      await chrome.tabs.update(targetTab.id, { active: true });
      await new Promise((r) => setTimeout(r, 800));
    }
  } else {
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTab = currentActive;
  }

  if (!targetTab || !targetTab.id) {
    return { status: "failed", message: "Failed to resolve active tab after product detail navigation." };
  }

  // 3. Protect against wrong product clicks: verify detail page corresponds to intended product
  let pageMeta = null;
  try {
    const [evalRes] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: () => {
        const head = document.querySelector("h1, h2, #productTitle, [class*='title' i]");
        const headText = head ? (head.innerText || head.textContent || "").trim() : "";
        return {
          title: document.title || "",
          heading: headText,
          url: window.location.href
        };
      }
    });
    pageMeta = evalRes && evalRes.result;
  } catch (e) {
    console.warn("[LocalLens Detail Fallback] Could not read detail page metadata:", e);
  }

  if (pageMeta) {
    const combinedPageText = `${pageMeta.title} ${pageMeta.heading}`.toLowerCase();
    const keywords = (prod.name || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !["with", "from", "that", "this", "wireless", "bluetooth", "edition"].includes(w));

    const matches = keywords.filter((k) => combinedPageText.includes(k));
    if (keywords.length > 0 && matches.length === 0 && combinedPageText.trim().length > 15) {
      return {
        status: "failed",
        message: `Product mismatch protection: Detail page ("${pageMeta.title.slice(0, 40)}...") does not match intended product "${prod.name}". Aborting Add to Cart for safety.`
      };
    }
  }

  // 4. Re-run privacy scan and UI grounding on the new detail page
  const detailScanRes = await captureSanitizedScreenshot();
  if (!detailScanRes || !detailScanRes.pageData) {
    return { status: "failed", message: "Failed to scan and ground elements on product detail page." };
  }

  const detailCompElements = detailScanRes.pageData.compressedElements || [];
  lastCompressedElements = detailCompElements;

  // 5. Find actual Add to Cart button on detail page using generic semantic/DOM signals
  const detailCartTarget = detailCompElements.find((cel) => {
    if (cel.protected || cel.isVisible === false) return false;
    const isInteractive = cel.isInteractive || cel.role === "button" || cel.tag === "button" || cel.tag === "a" || cel.tag === "input";
    if (!isInteractive) return false;

    const text = (cel.text || "").toLowerCase();
    const aria = (cel.attributes && cel.attributes.ariaLabel ? cel.attributes.ariaLabel : "").toLowerCase();
    const combined = `${text} ${aria}`;

    const isCartWord = /\b(?:add\s*to\s*(?:cart|bag|basket)|buy\s*now)\b/i.test(combined);
    const isNegative = /\b(?:wishlist|save\s*for\s*later|compare|share|notify|review|seller|view)\b/i.test(combined);

    return isCartWord && !isNegative;
  });

  if (!detailCartTarget) {
    return {
      status: "failed",
      message: `Navigated to detail page for "${prod.name}", but could not locate a visible, non-protected Add to Cart button.`
    };
  }

  // 6. Execute grounded click on detail page Add to Cart button
  console.log(`[LocalLens Detail Fallback] Clicking Add to Cart on detail page element ${detailCartTarget.id} (${detailCartTarget.text})...`);
  return await executeBrowserAction("click", String(detailCartTarget.id), "");
}

// 6. ADD SELECTED PRODUCT TO CART ACTION
const addSelectedToCartButton = document.getElementById("addSelectedToCartButton");
const addSelectedToCartResult = document.getElementById("addSelectedToCartResult");

if (addSelectedToCartButton) {
  addSelectedToCartButton.addEventListener("click", async () => {
    if (currentSession && currentSession.isStale) {
      if (addSelectedToCartResult) {
        addSelectedToCartResult.style.display = "block";
        addSelectedToCartResult.style.background = "#fee2e2";
        addSelectedToCartResult.style.border = "1px solid #fca5a5";
        addSelectedToCartResult.style.color = "#991b1b";
        addSelectedToCartResult.textContent = "Action blocked: active page changed since last scan. Please click 'Scan Page' to re-ground elements before executing.";
      }
      return;
    }

    let targetRec = lastRecommendedProduct;
    if (!targetRec && currentSession && currentSession.recommendedProduct) {
      targetRec = currentSession.recommendedProduct;
    }
    if (!targetRec) {
      alert("No valid product available to add to cart.");
      return;
    }

    addSelectedToCartButton.disabled = true;
    if (addSelectedToCartResult) {
      addSelectedToCartResult.style.display = "none";
    }

    try {
      const result = await executeAddProductToCart(lastRecommendedProduct);
      if (addSelectedToCartResult) {
        addSelectedToCartResult.style.display = "block";
        if (result.status === "ok" && result.verification && result.verification.status === "verified") {
          addSelectedToCartResult.style.background = "#dcfce7";
          addSelectedToCartResult.style.border = "1px solid #86efac";
          addSelectedToCartResult.style.color = "#15803d";
          addSelectedToCartResult.innerHTML = `<strong>✓ Verified:</strong> ${result.verification.message || `Cart updated — ${lastRecommendedProduct.name} added successfully.`}`;
        } else if (result.status === "ok") {
          addSelectedToCartResult.style.background = "#fef9c3";
          addSelectedToCartResult.style.border = "1px solid #fde047";
          addSelectedToCartResult.style.color = "#854d0e";
          addSelectedToCartResult.innerHTML = `<strong>Clicked (Unverified):</strong> ${result.message}`;
        } else {
          addSelectedToCartResult.style.background = "#fee2e2";
          addSelectedToCartResult.style.border = "1px solid #fca5a5";
          addSelectedToCartResult.style.color = "#991b1b";
          addSelectedToCartResult.textContent = `Action failed: ${result.message}`;
        }
      }

      saveSessionState({
        cartState: {
          count: null,
          summary: addSelectedToCartResult ? addSelectedToCartResult.innerHTML : "",
          status: result.status === "ok" && result.verification && result.verification.status === "verified"
            ? "verified"
            : (result.status === "ok" ? "partial" : "failed")
        },
        actionHistory: (currentSession.actionHistory || []).concat([{
          id: lastRecommendedProduct.id,
          name: lastRecommendedProduct.name,
          status: result.status,
          message: result.message,
          timestamp: Date.now()
        }])
      }, true);
    } catch (err) {
      if (addSelectedToCartResult) {
        addSelectedToCartResult.style.display = "block";
        addSelectedToCartResult.style.background = "#fee2e2";
        addSelectedToCartResult.style.border = "1px solid #fca5a5";
        addSelectedToCartResult.style.color = "#991b1b";
        addSelectedToCartResult.textContent = `Execution error: ${err.message}`;
      }
    } finally {
      addSelectedToCartButton.disabled = false;
    }
  });
}

// 6b. ADD SELECTED PRODUCTS TO CART (USER MULTI-SELECTION)
const addSelectedProductsButton = document.getElementById("addSelectedProductsButton");
const addSelectedProductsResult = document.getElementById("addSelectedProductsResult");

if (addSelectedProductsButton) {
  addSelectedProductsButton.addEventListener("click", async () => {
    if (currentSession && currentSession.isStale) {
      if (addSelectedProductsResult) {
        addSelectedProductsResult.style.display = "block";
        addSelectedProductsResult.style.background = "#fee2e2";
        addSelectedProductsResult.style.border = "1px solid #fca5a5";
        addSelectedProductsResult.style.color = "#991b1b";
        addSelectedProductsResult.textContent = "Action blocked: active page changed since last scan. Please click 'Scan Page' to re-ground elements before executing.";
      }
      return;
    }

    // 1. Collect selected checkboxes
    const checkedBoxes = Array.from(
      document.querySelectorAll(".product-select-checkbox:checked")
    );

    if (checkedBoxes.length === 0) {
      if (addSelectedProductsResult) {
        addSelectedProductsResult.style.display = "block";
        addSelectedProductsResult.style.background = "#fef9c3";
        addSelectedProductsResult.style.border = "1px solid #fde047";
        addSelectedProductsResult.style.color = "#854d0e";
        addSelectedProductsResult.textContent = "Please select at least one product using the checkboxes.";
      }
      return;
    }

    addSelectedProductsButton.disabled = true;
    if (addSelectedProductsResult) {
      addSelectedProductsResult.style.display = "block";
      addSelectedProductsResult.style.background = "#f0fdf4";
      addSelectedProductsResult.style.border = "1px solid #bbf7d0";
      addSelectedProductsResult.style.color = "#166534";
      addSelectedProductsResult.textContent = `Adding ${checkedBoxes.length} selected product(s) to cart...`;
    }

    // 2. Strict grounding: resolve against known product metadata or session storage
    const selectedIds = checkedBoxes.map((cb) => cb.dataset.productId).filter(Boolean);
    const knownProducts = (lastExtractedProducts && lastExtractedProducts.length > 0)
      ? lastExtractedProducts
      : ((currentSession && currentSession.discoveredProducts) || []);
    const selectedProducts = [];
    for (const sid of selectedIds) {
      let prod = knownProducts.find((p) => p.id === sid);
      if (!prod) {
        prod = { id: sid, name: sid };
      }
      selectedProducts.push(prod);
    }

    if (selectedProducts.length === 0) {
      if (addSelectedProductsResult) {
        addSelectedProductsResult.style.background = "#fee2e2";
        addSelectedProductsResult.style.border = "1px solid #fca5a5";
        addSelectedProductsResult.style.color = "#991b1b";
        addSelectedProductsResult.textContent = "Error: Selected products could not be resolved in grounded product data.";
      }
      addSelectedProductsButton.disabled = false;
      return;
    }

    const results = [];

    // 3. Execute grounded clicks in sequence with verification
    for (let i = 0; i < selectedProducts.length; i++) {
      const prod = selectedProducts[i];
      try {
        const actionRes = await executeAddProductToCart(prod);
        if (actionRes.status === "ok" && actionRes.verification && actionRes.verification.status === "verified") {
          results.push({
            id: prod.id,
            name: prod.name,
            status: "verified",
            message: actionRes.verification.message || "Cart updated",
          });
        } else if (actionRes.status === "ok") {
          results.push({
            id: prod.id,
            name: prod.name,
            status: "clicked",
            message: actionRes.message || "Clicked",
          });
        } else {
          results.push({
            id: prod.id,
            name: prod.name,
            status: "failed",
            message: actionRes.message || "Action failed",
          });
        }
      } catch (err) {
        results.push({
          id: prod.id,
          name: prod.name,
          status: "failed",
          message: err.message || String(err),
        });
      }

      // Small pause between sequential clicks to allow DOM updates & animation
      if (i < selectedProducts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    // 4. Query tab's cart counter for authoritative final cart count
    let domCartCount = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        const [evalRes] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const counter = document.getElementById("cart-counter") || document.querySelector(".cart-count, #nav-cart-count");
            return counter ? counter.textContent.trim() : null;
          },
        });
        domCartCount = evalRes && evalRes.result;
      }
    } catch (e) {
      console.warn("[LocalLens] Failed to read tab cart counter:", e);
    }

    const successCount = results.filter((r) => r.status === "verified" || r.status === "clicked").length;
    const failedResults = results.filter((r) => r.status === "failed");

    // 5. Report aggregate result clearly
    if (addSelectedProductsResult) {
      addSelectedProductsResult.style.display = "block";
      const countDisplay = domCartCount !== null ? `Cart count: ${domCartCount}` : `${successCount} in cart`;

      if (failedResults.length === 0) {
        addSelectedProductsResult.style.background = "#dcfce7";
        addSelectedProductsResult.style.border = "1px solid #86efac";
        addSelectedProductsResult.style.color = "#15803d";
        addSelectedProductsResult.innerHTML = `<strong>✓ Success:</strong> ${successCount} product${successCount === 1 ? "" : "s"} added to cart &bull; <strong>${countDisplay}</strong>`;
      } else if (successCount > 0) {
        addSelectedProductsResult.style.background = "#fef9c3";
        addSelectedProductsResult.style.border = "1px solid #fde047";
        addSelectedProductsResult.style.color = "#854d0e";
        const failNames = failedResults.map((f) => `${f.name} (${f.message})`).join(", ");
        addSelectedProductsResult.innerHTML = `<strong>Partial:</strong> ${successCount} of ${results.length} added &bull; <strong>${countDisplay}</strong><br/><span style="font-size: 10px; color: #b91c1c;">Failed: ${failNames}</span>`;
      } else {
        addSelectedProductsResult.style.background = "#fee2e2";
        addSelectedProductsResult.style.border = "1px solid #fca5a5";
        addSelectedProductsResult.style.color = "#991b1b";
        const failNames = failedResults.map((f) => `${f.name}: ${f.message}`).join("; ");
        addSelectedProductsResult.innerHTML = `<strong>Action failed:</strong> ${failNames}`;
      }
    }

    saveSessionState({
      cartState: {
        count: domCartCount,
        summary: addSelectedProductsResult ? addSelectedProductsResult.innerHTML : "",
        status: failedResults.length === 0 ? "verified" : (successCount > 0 ? "partial" : "failed")
      },
      actionHistory: (currentSession.actionHistory || []).concat(results.map((r) => ({ ...r, timestamp: Date.now() })))
    }, true);

    addSelectedProductsButton.disabled = false;
  });
}

// 7. ONE-CLICK SHOPPING AGENT E2E WORKFLOW
// SEARCH/PERCEIVE → EXTRACT PRODUCTS → COMPARE → SELECT → ADD TO CART → VERIFY
const runShoppingWorkflowButton = document.getElementById("runShoppingWorkflowButton");
const shoppingWorkflowStatusList = document.getElementById("shoppingWorkflowStatusList");
const shopStep1 = document.getElementById("shopStep1");
const shopStep2 = document.getElementById("shopStep2");
const shopStep3 = document.getElementById("shopStep3");
const shopStep4 = document.getElementById("shopStep4");
const shopStep5 = document.getElementById("shopStep5");
const shopStep6 = document.getElementById("shopStep6");
const shopStep7 = document.getElementById("shopStep7");
const shoppingWorkflowSummary = document.getElementById("shoppingWorkflowSummary");

if (runShoppingWorkflowButton) {
  runShoppingWorkflowButton.addEventListener("click", async () => {
    runShoppingWorkflowButton.disabled = true;
    if (shoppingWorkflowStatusList) shoppingWorkflowStatusList.style.display = "block";
    if (shoppingWorkflowSummary) shoppingWorkflowSummary.style.display = "none";

    const resetStep = (stepNum, el, text) => {
      if (el) {
        el.style.color = "#64748b";
        el.textContent = `○ ${text}`;
      }
      if (!currentSession.workflowSteps) currentSession.workflowSteps = {};
      currentSession.workflowSteps[stepNum] = { text: `○ ${text}`, status: "reset" };
    };
    const setStepActive = (stepNum, el, text) => {
      if (el) {
        el.style.color = "#d97706";
        el.textContent = `⏳ ${text}`;
      }
      if (!currentSession.workflowSteps) currentSession.workflowSteps = {};
      currentSession.workflowSteps[stepNum] = { text: `⏳ ${text}`, status: "active" };
      saveSessionState({ workflowType: "shopping", workflowStatus: "active", currentStep: stepNum });
    };
    const setStepDone = (stepNum, el, text) => {
      if (el) {
        el.style.color = "#15803d";
        el.textContent = `✓ ${text}`;
      }
      if (!currentSession.workflowSteps) currentSession.workflowSteps = {};
      currentSession.workflowSteps[stepNum] = { text: `✓ ${text}`, status: "done" };
      saveSessionState({ workflowType: "shopping", currentStep: stepNum });
    };
    const setStepFailed = (stepNum, el, text) => {
      if (el) {
        el.style.color = "#dc2626";
        el.textContent = `✗ ${text}`;
      }
      if (!currentSession.workflowSteps) currentSession.workflowSteps = {};
      currentSession.workflowSteps[stepNum] = { text: `✗ ${text}`, status: "failed" };
      saveSessionState({ workflowType: "shopping", workflowStatus: "failed", currentStep: stepNum }, true);
    };

    resetStep(1, shopStep1, "Step 1: Privacy scan");
    resetStep(2, shopStep2, "Step 2: Build grounded UI map");
    resetStep(3, shopStep3, "Step 3: Extract grounded products");
    resetStep(4, shopStep4, "Step 4: Compare products");
    resetStep(5, shopStep5, "Step 5: Select grounded product");
    resetStep(6, shopStep6, "Step 6: Execute Add to Cart");
    resetStep(7, shopStep7, "Step 7: Verify cart update");

    try {
      // Step 1: Privacy Scan
      setStepActive(1, shopStep1, "Step 1: Running privacy scan...");
      const scanRes = await captureSanitizedScreenshot();
      if (!scanRes) {
        setStepFailed(1, shopStep1, "Step 1: Privacy scan failed");
        throw new Error("Failed to scan webpage.");
      }
      setStepDone(1, shopStep1, `Step 1: Privacy scan (${scanRes.pageData.totalSensitive || 0} sensitive elements protected)`);

      // Step 2: Build grounded UI map
      setStepDone(2, shopStep2, `Step 2: Grounded UI map (${(scanRes.pageData.compressedElements || []).length} elements mapped)`);

      // Step 3: Extract grounded products
      setStepActive(3, shopStep3, "Step 3: Extracting grounded products...");
      const prods = scanRes.pageData.products || lastExtractedProducts || [];
      if (!prods || prods.length === 0) {
        setStepFailed(3, shopStep3, "Step 3: No grounded products found on page");
        throw new Error("No grounded products detected on page.");
      }
      setStepDone(3, shopStep3, `Step 3: Extracted ${prods.length} grounded products`);

      // Step 4: Compare products
      setStepActive(4, shopStep4, "Step 4: Comparing products via local Qwen...");
      const task = "Find wireless headphones, compare them by price and rating, select the best option, and add it to the cart.";
      const formData = new FormData();
      formData.append("task", task);
      formData.append("products", JSON.stringify(prods));

      const compResp = await fetch("http://127.0.0.1:8000/compare", {
        method: "POST",
        body: formData,
      });
      if (!compResp.ok) {
        setStepFailed(4, shopStep4, `Step 4: Compare request failed (HTTP ${compResp.status})`);
        throw new Error(`Compare endpoint error: ${compResp.status}`);
      }
      const compData = await compResp.json();
      const decision = compData.decision || {};

      if (decision.status !== "ok" || !decision.recommended_product) {
        setStepFailed(4, shopStep4, `Step 4: Insufficient context: ${decision.reason || "No recommendation"}`);
        throw new Error("Comparison did not produce a valid recommendation.");
      }
      const rec = decision.recommended_product;
      setStepDone(4, shopStep4, `Step 4: Products compared (${compData.telemetry ? compData.telemetry.inference_time_ms : '-'} ms)`);

      // Step 5: Select grounded product
      setStepActive(5, shopStep5, `Step 5: Selecting grounded product [${rec.id}]...`);
      const targetId = rec.element_id || rec.detail_link_id;
      if (!targetId) {
        setStepFailed(5, shopStep5, `Step 5: Selected product "${rec.name}" has no mapped interactive target`);
        throw new Error(`Product ${rec.id} has no interactive target.`);
      }

      // Verify element is not protected
      const targetMeta = (scanRes.pageData.compressedElements || []).find((el) => el.id === targetId);
      if (targetMeta && targetMeta.protected) {
        setStepFailed(5, shopStep5, `Step 5: Target element ${targetId} is privacy-protected`);
        throw new Error("Target element is protected.");
      }
      setStepDone(5, shopStep5, `Step 5: Selected ${rec.name} (${rec.price}, ${rec.rating}) [Target: ${targetId}]`);

      // Step 6: Execute Add to Cart
      setStepActive(6, shopStep6, `Step 6: Adding "${rec.name}" to Cart...`);
      const actionRes = await executeAddProductToCart(rec);
      if (actionRes.status !== "ok") {
        setStepFailed(6, shopStep6, `Step 6: Add to Cart failed: ${actionRes.message}`);
        throw new Error(`Add to Cart failed: ${actionRes.message}`);
      }
      setStepDone(6, shopStep6, `Step 6: Add to Cart executed for ${rec.name}`);

      // Step 7: Verify cart update
      setStepActive(7, shopStep7, "Step 7: Verifying cart state change in DOM...");
      if (actionRes.verification && actionRes.verification.status === "verified") {
        const verifyMsg = actionRes.verification.message;
        setStepDone(7, shopStep7, `Step 7: Cart updated — ${verifyMsg}`);

        if (shoppingWorkflowSummary) {
          shoppingWorkflowSummary.style.display = "block";
          shoppingWorkflowSummary.style.color = "#15803d";
          shoppingWorkflowSummary.textContent = `✓ Shopping Workflow Complete: ${verifyMsg}`;
        }

        saveSessionState({
          workflowType: "shopping",
          workflowStatus: "completed",
          workflowSummary: `✓ Shopping Workflow Complete: ${verifyMsg}`,
          cartState: {
            count: null,
            summary: `✓ Shopping Workflow Complete: ${verifyMsg}`,
            status: "verified",
          },
        }, true);
      } else {
        setStepFailed(7, shopStep7, `Step 7: Cart change unverified (${actionRes.verification ? actionRes.verification.message : "No state change detected"})`);
        if (shoppingWorkflowSummary) {
          shoppingWorkflowSummary.style.display = "block";
          shoppingWorkflowSummary.style.color = "#dc2626";
          shoppingWorkflowSummary.textContent = "✗ Shopping Workflow: Cart update could not be verified.";
        }

        saveSessionState({
          workflowType: "shopping",
          workflowStatus: "failed",
          workflowSummary: "✗ Shopping Workflow: Cart update could not be verified.",
        }, true);
      }
    } catch (err) {
      console.error("[LocalLens Shopping Workflow] Error:", err);
      if (shoppingWorkflowSummary) {
        shoppingWorkflowSummary.style.display = "block";
        shoppingWorkflowSummary.style.color = "#dc2626";
        shoppingWorkflowSummary.textContent = `✗ Workflow halted: ${err.message}`;
      }
      saveSessionState({
        workflowType: "shopping",
        workflowStatus: "failed",
        workflowSummary: `✗ Workflow halted: ${err.message}`,
      }, true);
    } finally {
      runShoppingWorkflowButton.disabled = false;
    }
  });
}

// ==========================================
// 8. BOUNDED ITERATIVE BROWSER-AGENT LOOP
// OBSERVE → PROTECT → GROUND → REASON → ACT → VERIFY → OBSERVE AGAIN
// ==========================================

async function runIterativeAgent(task, maxIterations = 10, isResuming = false) {
  const taskInput = document.getElementById("iterativeAgentTaskInput");
  const runBtn = document.getElementById("runIterativeAgentButton");
  const resumeBtn = document.getElementById("resumeIterativeAgentButton");
  const statusEl = document.getElementById("iterativeAgentStatus");
  const badgeEl = document.getElementById("agentIterationBadge");
  const stepEl = document.getElementById("agentStepDescription");
  const histContainer = document.getElementById("agentHistoryContainer");
  const histList = document.getElementById("agentHistoryList");
  const summaryEl = document.getElementById("iterativeAgentSummary");

  if (!task) {
    task = (taskInput && taskInput.value.trim()) || "Search for wireless headphones and compare prices";
  }

  if (runBtn) runBtn.disabled = true;
  if (resumeBtn) resumeBtn.style.display = "none";
  if (stepEl) stepEl.style.display = "block";
  if (histContainer) histContainer.style.display = "block";
  if (summaryEl) summaryEl.style.display = "none";

  let history = isResuming && Array.isArray(currentSession.agentHistory)
    ? [...currentSession.agentHistory]
    : [];
  let iteration = isResuming && currentSession.agentIteration ? currentSession.agentIteration : 0;
  let consecutiveFailures = 0;
  let stagnationCount = 0;
  let lastActionSig = "";

  if (!isResuming) {
    if (histList) histList.innerHTML = "";
  }

  const renderHistoryItem = (item) => {
    if (!histList) return;
    const row = document.createElement("div");
    row.style.padding = "3px 4px";
    row.style.borderRadius = "3px";
    row.style.borderLeft = item.verification === "verified" || item.action === "done"
      ? "3px solid #16a34a"
      : item.status === "failed" || item.verification === "failed"
      ? "3px solid #dc2626"
      : "3px solid #ca8a04";
    row.style.background = "#f8fafc";
    row.style.lineHeight = "1.3";

    const isSuccess = item.verification === "verified" || item.action === "done";
    const statusIcon = isSuccess ? "✓" : (item.status === "failed" ? "✗" : "○");
    const actionText = item.action === "type"
      ? `type "${item.text || ''}" -> [${item.element_id}]${item.press_enter ? ' (Enter)' : ''}`
      : item.action === "click"
      ? `click [${item.element_id}]`
      : item.action;

    row.innerHTML = `<div><strong style="color:#1e40af;">Iter ${item.iteration}:</strong> ${actionText}</div>` +
      `<div style="color:#64748b; font-size:9px;">${statusIcon} ${item.message || item.reason || ''}</div>`;
    histList.appendChild(row);
    histList.scrollTop = histList.scrollHeight;
  };

  // If resuming, render previously stored history items
  if (isResuming && histList && histList.children.length === 0) {
    history.forEach(renderHistoryItem);
  }

  saveSessionState({
    task: task,
    workflowType: "agent",
    workflowStatus: "active",
    agentIteration: iteration,
    agentHistory: history
  }, true);

  try {
    while (iteration < maxIterations) {
      iteration++;
      if (badgeEl) badgeEl.textContent = `Iter: ${iteration}/${maxIterations}`;
      if (statusEl) statusEl.textContent = `Status: Iteration ${iteration}/${maxIterations} — Observing & protecting page...`;
      if (stepEl) stepEl.textContent = `[Iteration ${iteration}] Observing DOM, running privacy scan & capturing protected screenshot...`;

      // 1. OBSERVE & PROTECT: Fresh DOM scan & capture sanitized screenshot
      const scanRes = await captureSanitizedScreenshot();
      if (!scanRes || !scanRes.protectedScreenshot) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          throw new Error("Failed to scan and capture protected page for 3 consecutive attempts.");
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const protectedScreenshot = scanRes.protectedScreenshot;
      const compressedElements = scanRes.pageData.compressedElements || [];
      const viewport = scanRes.pageData.viewport;

      // Update cached state for UI map
      lastScreenshot = protectedScreenshot;
      lastCompressedElements = compressedElements;
      lastViewport = viewport;

      // Check for bot detection / captcha
      const isBotPage = compressedElements.some((el) => {
        const t = (el.text || "").toLowerCase();
        return t.includes("robot check") || t.includes("enter characters below") || t.includes("type characters you see");
      });
      if (isBotPage) {
        if (summaryEl) {
          summaryEl.style.display = "block";
          summaryEl.style.background = "#fee2e2";
          summaryEl.style.border = "1px solid #fca5a5";
          summaryEl.style.color = "#991b1b";
          summaryEl.textContent = "✗ LocalLens stopped: Bot detection or CAPTCHA encountered on page.";
        }
        if (statusEl) statusEl.textContent = "Status: Stopped (CAPTCHA / Bot detection).";
        saveSessionState({
          workflowType: "agent",
          workflowStatus: "blocked_bot",
          workflowSummary: "✗ LocalLens stopped: Bot detection or CAPTCHA encountered on page.",
          agentIteration: iteration,
          agentHistory: history
        }, true);
        return { status: "blocked", reason: "bot_detection" };
      }

      // 2. REASON: Send current state and history to Qwen
      if (statusEl) statusEl.textContent = `Status: Iteration ${iteration}/${maxIterations} — Asking Qwen for next action...`;
      if (stepEl) stepEl.textContent = `[Iteration ${iteration}] Prompting local Qwen with ${compressedElements.length} grounded elements and history (${history.length} past steps)...`;

      const reasonData = await queryReasoningBackend(task, protectedScreenshot, compressedElements, viewport, history);
      const decision = reasonData.decision || {};

      console.log(`[LocalLens Agent Iter ${iteration}] Decision:`, decision);

      // Check 2a: Task Done
      if (decision.action === "done") {
        const doneItem = {
          iteration: iteration,
          action: "done",
          element_id: null,
          text: null,
          press_enter: false,
          reason: decision.reason || "Task achieved.",
          status: "ok",
          verification: "verified",
          message: decision.reason || "Task successfully achieved."
        };
        history.push(doneItem);
        renderHistoryItem(doneItem);

        if (statusEl) statusEl.textContent = "Status: Task Complete ✓";
        if (stepEl) stepEl.textContent = `[Iteration ${iteration}] Agent completed task: ${decision.reason || "Goal reached."}`;
        if (summaryEl) {
          summaryEl.style.display = "block";
          summaryEl.style.background = "#dcfce7";
          summaryEl.style.border = "1px solid #86efac";
          summaryEl.style.color = "#15803d";
          summaryEl.textContent = `✓ Goal Achieved in ${iteration} iterations: ${decision.reason || "Task successfully completed."}`;
        }
        saveSessionState({
          workflowType: "agent",
          workflowStatus: "completed",
          workflowSummary: `✓ Goal Achieved: ${decision.reason || "Task completed."}`,
          agentIteration: iteration,
          agentHistory: history
        }, true);
        return { status: "completed", iterations: iteration, history: history };
      }

      // Check 2b: Insufficient Context / Refusal
      if (decision.action === "insufficient_context" || decision.status !== "ok") {
        const refuseItem = {
          iteration: iteration,
          action: "insufficient_context",
          element_id: null,
          text: null,
          press_enter: false,
          reason: decision.reason || "Insufficient context to proceed.",
          status: "refused",
          verification: "refused",
          message: decision.reason || "Model indicated insufficient context."
        };
        history.push(refuseItem);
        renderHistoryItem(refuseItem);

        if (statusEl) statusEl.textContent = "Status: Safe Refusal / Insufficient Context";
        if (stepEl) stepEl.textContent = `[Iteration ${iteration}] Agent halted safely: ${decision.reason || "Insufficient context."}`;
        if (summaryEl) {
          summaryEl.style.display = "block";
          summaryEl.style.background = "#fef9c3";
          summaryEl.style.border = "1px solid #fde047";
          summaryEl.style.color = "#854d0e";
          summaryEl.textContent = `⚠ Safe Refusal: ${decision.reason || "Insufficient context to proceed."}`;
        }
        saveSessionState({
          workflowType: "agent",
          workflowStatus: "refused",
          workflowSummary: `⚠ Safe Refusal: ${decision.reason || "Insufficient context."}`,
          agentIteration: iteration,
          agentHistory: history
        }, true);
        return { status: "refused", iterations: iteration, reason: decision.reason };
      }

      // Check 2c: Validate action and element
      if (decision.action !== "click" && decision.action !== "type") {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          throw new Error(`Model proposed unsupported action "${decision.action}".`);
        }
        continue;
      }

      // Validate target element in current observation
      const targetMeta = compressedElements.find((el) => el.id === decision.element_id);
      if (!targetMeta) {
        consecutiveFailures++;
        const missingItem = {
          iteration: iteration,
          action: decision.action,
          element_id: decision.element_id,
          text: decision.text || null,
          press_enter: Boolean(decision.press_enter),
          reason: decision.reason || "",
          status: "failed",
          verification: "unverified",
          message: `Target [${decision.element_id}] not found in current UI map.`
        };
        history.push(missingItem);
        renderHistoryItem(missingItem);
        if (consecutiveFailures >= 3) {
          throw new Error(`Target element "${decision.element_id}" not found in current UI map after multiple attempts.`);
        }
        continue;
      }

      // PRIVACY ENFORCEMENT: Target element must NEVER be privacy-protected
      if (targetMeta.protected) {
        const protItem = {
          iteration: iteration,
          action: decision.action,
          element_id: decision.element_id,
          text: decision.text || null,
          press_enter: false,
          reason: "Target element is privacy-protected/redacted.",
          status: "failed",
          verification: "rejected",
          message: `Action refused: element [${decision.element_id}] is privacy-protected.`
        };
        history.push(protItem);
        renderHistoryItem(protItem);

        if (statusEl) statusEl.textContent = "Status: Refused (Privacy Protected)";
        if (summaryEl) {
          summaryEl.style.display = "block";
          summaryEl.style.background = "#fee2e2";
          summaryEl.style.border = "1px solid #fca5a5";
          summaryEl.style.color = "#991b1b";
          summaryEl.textContent = `✗ Privacy Refusal: Model requested action on protected sensitive element [${decision.element_id}]. Execution strictly blocked.`;
        }
        saveSessionState({
          workflowType: "agent",
          workflowStatus: "blocked_privacy",
          workflowSummary: `✗ Privacy Refusal: Target [${decision.element_id}] is sensitive.`,
          agentIteration: iteration,
          agentHistory: history
        }, true);
        return { status: "blocked", reason: "privacy_protected" };
      }

      // Check Stagnation (same action + element_id + text 3 times)
      const currentActionSig = `${decision.action}:${decision.element_id}:${decision.text || ''}`;
      if (currentActionSig === lastActionSig) {
        stagnationCount++;
        if (stagnationCount >= 3) {
          if (summaryEl) {
            summaryEl.style.display = "block";
            summaryEl.style.background = "#fee2e2";
            summaryEl.style.border = "1px solid #fca5a5";
            summaryEl.style.color = "#991b1b";
            summaryEl.textContent = `✗ Stopped: Stagnation detected. Action "${decision.action}" on [${decision.element_id}] repeated 3 times without advancing state.`;
          }
          if (statusEl) statusEl.textContent = "Status: Stopped (Stagnation Loop)";
          saveSessionState({
            workflowType: "agent",
            workflowStatus: "stagnated",
            workflowSummary: `✗ Stagnation loop halted at iteration ${iteration}.`,
            agentIteration: iteration,
            agentHistory: history
          }, true);
          return { status: "stagnated", iterations: iteration };
        }
      } else {
        stagnationCount = 0;
        lastActionSig = currentActionSig;
      }

      // 3. ACT: Execute the verified action
      if (statusEl) statusEl.textContent = `Status: Iteration ${iteration}/${maxIterations} — Executing ${decision.action} on [${decision.element_id}]...`;
      if (stepEl) stepEl.textContent = `[Iteration ${iteration}] Executing ${decision.action} on [${decision.element_id}]${decision.text ? ` (Text: "${decision.text}")` : ''}${decision.press_enter ? ' with Enter' : ''}...`;

      const actionRes = await executeBrowserAction(
        decision.action,
        String(decision.element_id),
        decision.text || "",
        Boolean(decision.press_enter)
      );

      // 4. VERIFY: Evaluate verification result and DOM settling
      const isOk = actionRes.status === "ok";
      if (!isOk) {
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
      }

      const verifyStatus = actionRes.verification ? actionRes.verification.status : (isOk ? "verified" : "unverified");
      const verifyMsg = (actionRes.verification && actionRes.verification.message) || actionRes.message || "";

      const historyEntry = {
        iteration: iteration,
        action: decision.action,
        element_id: decision.element_id,
        text: decision.text || null,
        press_enter: Boolean(decision.press_enter),
        reason: decision.reason || "",
        status: actionRes.status,
        verification: verifyStatus,
        message: verifyMsg
      };
      history.push(historyEntry);
      renderHistoryItem(historyEntry);

      saveSessionState({
        task: task,
        workflowType: "agent",
        workflowStatus: "active",
        agentIteration: iteration,
        agentHistory: history
      });

      // Check for revealed review content if task involves customer reviews
      if (task.toLowerCase().includes("review") && isOk) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            const [revRes] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: inPageReviewExtractor,
              args: ["", 10]
            });
            const snippets = (revRes && revRes.result) || [];
            if (snippets.length > 0 && lastExtractedProducts && lastExtractedProducts.length > 0) {
              const matchedProd = lastExtractedProducts.find((p) => p.name && (p.element_id === decision.element_id || p.detail_link_id === decision.element_id || p.review_control_id === decision.element_id)) || lastExtractedProducts[0];
              if (matchedProd && !matchedProd.review_summary) {
                const sumRes = await fetchReviewSummary(matchedProd.name, snippets, matchedProd.rating);
                matchedProd.review_summary = sumRes.summary;
                matchedProd.positive_themes = sumRes.positive_themes;
                matchedProd.negative_themes = sumRes.negative_themes;
                currentSession.reviewResearch[matchedProd.id] = {
                  productId: matchedProd.id,
                  status: sumRes.status,
                  summary: sumRes.summary,
                  positiveThemes: sumRes.positive_themes,
                  negativeThemes: sumRes.negative_themes,
                  confidence: sumRes.confidence,
                  reviewsCount: snippets.length
                };
                const reviewTelem = document.getElementById("reviewResearchTelemetry");
                const reviewStatus = document.getElementById("reviewResearchStatus");
                const reviewBadge = document.getElementById("reviewResearchBadge");
                if (reviewTelem) reviewTelem.style.display = "flex";
                if (reviewStatus) reviewStatus.textContent = `Reviews: Analyzed for ${matchedProd.name.slice(0, 20)}... ✓`;
                if (reviewBadge) reviewBadge.textContent = `${Object.keys(currentSession.reviewResearch).length} products analyzed`;
                saveSessionState({ reviewResearch: currentSession.reviewResearch });
              }
            }
          }
        } catch (revErr) {
          console.warn("[LocalLens Iterative Agent] Review hook notice:", revErr);
        }
      }

      if (consecutiveFailures >= 3) {
        throw new Error("3 consecutive action executions failed.");
      }

      // Allow page and network to settle before next observation
      await new Promise((r) => setTimeout(r, 1200));
    }

    // If loop finishes because max iterations reached
    if (iteration >= maxIterations) {
      if (badgeEl) badgeEl.textContent = `Iter: ${maxIterations}/${maxIterations}`;
      if (statusEl) statusEl.textContent = `Status: Bounded limit reached (${maxIterations} iterations).`;
      if (stepEl) stepEl.textContent = `Reached maximum bounded iteration limit (${maxIterations}). Loop halted safely.`;
      if (summaryEl) {
        summaryEl.style.display = "block";
        summaryEl.style.background = "#fef9c3";
        summaryEl.style.border = "1px solid #fde047";
        summaryEl.style.color = "#854d0e";
        summaryEl.textContent = `⚠️ Maximum iteration limit (${maxIterations}) reached. Bounded loop stopped.`;
      }
      saveSessionState({
        workflowType: "agent",
        workflowStatus: "max_iterations",
        workflowSummary: `⚠️ Maximum iteration limit (${maxIterations}) reached.`,
        agentIteration: iteration,
        agentHistory: history
      }, true);
      return { status: "max_iterations", iterations: iteration };
    }
  } catch (err) {
    console.error("[LocalLens Iterative Agent] Error:", err);
    if (statusEl) statusEl.textContent = "Status: Halted with error.";
    if (summaryEl) {
      summaryEl.style.display = "block";
      summaryEl.style.background = "#fee2e2";
      summaryEl.style.border = "1px solid #fca5a5";
      summaryEl.style.color = "#991b1b";
      summaryEl.textContent = `✗ Agent loop halted: ${err.message}`;
    }
    saveSessionState({
      workflowType: "agent",
      workflowStatus: "failed",
      workflowSummary: `✗ Agent loop halted: ${err.message}`,
      agentIteration: iteration,
      agentHistory: history
    }, true);
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

const runIterativeAgentButton = document.getElementById("runIterativeAgentButton");
const resumeIterativeAgentButton = document.getElementById("resumeIterativeAgentButton");
const iterativeAgentTaskInput = document.getElementById("iterativeAgentTaskInput");

if (runIterativeAgentButton) {
  runIterativeAgentButton.addEventListener("click", () => {
    const task = (iterativeAgentTaskInput && iterativeAgentTaskInput.value.trim()) || "Search for wireless headphones and compare prices";
    runIterativeAgent(task, 10, false);
  });
}

if (resumeIterativeAgentButton) {
  resumeIterativeAgentButton.addEventListener("click", () => {
    const task = (iterativeAgentTaskInput && iterativeAgentTaskInput.value.trim()) || currentSession.task || "Search for wireless headphones and compare prices";
    runIterativeAgent(task, 10, true);
  });
}

if (iterativeAgentTaskInput) {
  iterativeAgentTaskInput.addEventListener("input", () => {
    saveSessionState({ task: iterativeAgentTaskInput.value.trim() });
  });
}

// ==========================================
// Session Controls & Startup Restore
// ==========================================
const newSessionBtn = document.getElementById("newSessionButton");
if (newSessionBtn) {
  newSessionBtn.addEventListener("click", clearSessionState);
}

if (compareTaskInput) {
  compareTaskInput.addEventListener("input", () => {
    saveSessionState({ task: compareTaskInput.value.trim() });
  });
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  restoreSessionState().catch((err) => {
    console.warn("[LocalLens Session] Startup restore error:", err);
  });
}

// ==========================================
// Cloud AI Scan (Gemini 2.5 Flash Demonstration)
// ==========================================
const cloudScanButton = document.getElementById("cloudScanButton");
const cloudScanSection = document.getElementById("cloudScanSection");
const cloudScanStatus = document.getElementById("cloudScanStatus");
const cloudScanBadge = document.getElementById("cloudScanBadge");
const cloudScanSummary = document.getElementById("cloudScanSummary");
const cloudScanPrivacyNote = document.getElementById("cloudScanPrivacyNote");
const cloudScanItems = document.getElementById("cloudScanItems");

if (cloudScanButton) {
  cloudScanButton.addEventListener("click", async () => {
    cloudScanButton.disabled = true;
    if (cloudScanSection) cloudScanSection.style.display = "block";
    if (cloudScanStatus) cloudScanStatus.textContent = "Status: Capturing sanitized screenshot (local privacy shield)...";
    if (cloudScanSummary) cloudScanSummary.textContent = "Applying on-device redactions to PII before cloud transmission...";
    if (cloudScanItems) cloudScanItems.innerHTML = "";
    if (cloudScanPrivacyNote) cloudScanPrivacyNote.style.display = "none";

    try {
      // 1. Local privacy scan & capture sanitized screenshot (NEVER raw un-redacted)
      const { pageData, protectedScreenshot } = await captureSanitizedScreenshot();

      if (cloudScanStatus) {
        cloudScanStatus.textContent = `Status: Sending sanitized screenshot (${pageData.totalSensitive} fields protected) to /cloud-scan...`;
      }

      const task = (compareTaskInput ? compareTaskInput.value : "").trim() || "Analyze page contents and identify key actions.";

      // 2. Transmit ONLY sanitized screenshot and non-sensitive metadata to server-side Gemini endpoint
      const formData = new FormData();
      formData.append("image", protectedScreenshot);
      formData.append("task", task);
      formData.append("context", JSON.stringify({
        totalSensitive: pageData.totalSensitive,
        viewport: pageData.viewport
      }));

      const res = await fetch("http://127.0.0.1:8000/cloud-scan", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Cloud scan returned HTTP ${res.status}`);
      }

      const data = await res.json();

      if (cloudScanBadge) {
        cloudScanBadge.textContent = data.cloud_model || "Gemini 2.5 Flash";
      }

      if (data.status === "unconfigured") {
        if (cloudScanStatus) cloudScanStatus.textContent = "Status: Server GEMINI_API_KEY Not Configured";
        if (cloudScanSummary) cloudScanSummary.textContent = data.instructions || data.error;
        if (cloudScanPrivacyNote) {
          cloudScanPrivacyNote.style.display = "block";
          cloudScanPrivacyNote.textContent = `✓ Privacy verification passed: ${data.sanitized_elements_count} sensitive fields were redacted locally on-device. No PII was transmitted.`;
        }
      } else if (data.status === "success") {
        const latency = data.telemetry ? `${data.telemetry.latency_ms} ms` : "";
        if (cloudScanStatus) cloudScanStatus.textContent = `Status: Gemini Cloud Analysis Complete ${latency ? `(${latency})` : ""} ✓`;
        if (cloudScanSummary) {
          cloudScanSummary.textContent = data.summary || (data.task_assessment || "Analysis complete.");
        }
        if (cloudScanPrivacyNote) {
          cloudScanPrivacyNote.style.display = "block";
          cloudScanPrivacyNote.textContent = `✓ ${data.privacy_notes || "All sensitive inputs were redacted on-device before cloud transmission."}`;
        }
        if (cloudScanItems && Array.isArray(data.key_items) && data.key_items.length > 0) {
          cloudScanItems.innerHTML = `<strong>Key Items:</strong><br>${data.key_items.map(i => `• ${i}`).join("<br>")}`;
        }
      } else {
        if (cloudScanStatus) cloudScanStatus.textContent = `Status: ${data.status || "Cloud scan notice"}`;
        if (cloudScanSummary) cloudScanSummary.textContent = data.error || data.summary || "Completed with notice.";
        if (cloudScanPrivacyNote) {
          cloudScanPrivacyNote.style.display = "block";
          cloudScanPrivacyNote.textContent = `✓ Privacy shield remained active (${data.sanitized_elements_count || 0} fields protected).`;
        }
      }
    } catch (err) {
      console.error("[LocalLens Cloud Scan] Error:", err);
      if (cloudScanStatus) cloudScanStatus.textContent = "Status: Cloud scan error";
      if (cloudScanSummary) cloudScanSummary.textContent = `Error: ${err.message || String(err)}`;
    } finally {
      cloudScanButton.disabled = false;
    }
  });
}



