import { pipeline, env } from "../libs/transformers.js";

// Ensure ONNX Runtime loads local wasm files from extension/libs/
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("libs/");
env.allowRemoteModels = true;

const MODEL_NAME = "onnx-community/mobilenetv4_conv_small.e2400_r224_in1k";
let classifierPromise = null;

async function checkWebGpu() {
  if (!navigator.gpu) {
    return {
      available: false,
      error: "navigator.gpu is not available in this browser context.",
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        available: false,
        error: "WebGPU adapter request returned null.",
      };
    }

    const device = await adapter.requestDevice();
    if (!device) {
      return {
        available: false,
        error: "WebGPU device request failed.",
      };
    }

    return { available: true, adapterInfo: adapter.info || {} };
  } catch (err) {
    return { available: false, error: err.message || String(err) };
  }
}

async function getClassifier() {
  if (!classifierPromise) {
    console.log(
      `[LocalLens Offscreen] Initializing pipeline (${MODEL_NAME}) on device: webgpu`,
    );
    classifierPromise = pipeline("image-classification", MODEL_NAME, {
      device: "webgpu",
    });
  }
  return await classifierPromise;
}

async function handleWebGpuVisionTest(message) {
  console.log("[LocalLens Offscreen] Starting WebGPU vision test...");

  // 1. Verify that WebGPU hardware access is actually available
  const gpuCheck = await checkWebGpu();
  if (!gpuCheck.available) {
    console.error("[LocalLens Offscreen] WebGPU hardware check failed:", gpuCheck.error);
    return {
      success: false,
      device: "Unavailable",
      error: `WebGPU unavailable: ${gpuCheck.error}`,
    };
  }

  // 2. Initialize classifier using device: "webgpu"
  const imageUrl = message.imageUrl || chrome.runtime.getURL("assets/test.png");
  console.log("[LocalLens Offscreen] Input image URL:", imageUrl);

  const classifier = await getClassifier();

  // 3. Measure inference duration on WebGPU
  console.log("[LocalLens Offscreen] Running model inference on WebGPU...");
  const startTime = performance.now();
  const results = await classifier(imageUrl);
  const endTime = performance.now();
  const inferenceDurationMs = Math.round(endTime - startTime);

  console.log(
    `[LocalLens Offscreen] WebGPU inference completed in ${inferenceDurationMs} ms:`,
    results,
  );

  const top = Array.isArray(results) && results.length > 0 ? results[0] : null;
  const topPrediction = top
    ? `${top.label} (${(top.score * 100).toFixed(1)}%)`
    : "No prediction returned";

  return {
    success: true,
    device: "WebGPU",
    model: MODEL_NAME,
    inferenceTimeMs: inferenceDurationMs,
    topPrediction: topPrediction,
    allPredictions: results,
  };
}

// ----------------------------------------------------
// Object Detection (Localization with Bounding Boxes)
// ----------------------------------------------------
const DETECTOR_MODEL_NAME = "Xenova/yolos-tiny";
let detectorPromise = null;

async function getDetector() {
  if (!detectorPromise) {
    console.log(
      `[LocalLens Offscreen] Initializing object-detection pipeline (${DETECTOR_MODEL_NAME}) on device: webgpu`,
    );
    // Explicitly targeting WebGPU. If WebGPU is unavailable or shader compilation fails,
    // this will throw an error instead of silently falling back to CPU.
    detectorPromise = pipeline("object-detection", DETECTOR_MODEL_NAME, {
      device: "webgpu",
    });
  }
  return await detectorPromise;
}

async function handleWebGpuObjectDetectionTest(message) {
  console.log("[LocalLens Offscreen] Starting WebGPU object detection test...");

  // 1. Verify that WebGPU hardware access is actually available
  const gpuCheck = await checkWebGpu();
  if (!gpuCheck.available) {
    console.error(
      "[LocalLens Offscreen] WebGPU hardware check failed for detector:",
      gpuCheck.error,
    );
    return {
      success: false,
      device: "Unavailable",
      error: `WebGPU unavailable: ${gpuCheck.error}`,
    };
  }

  // 2. Initialize detector using device: "webgpu"
  const imageUrl = message.imageUrl || chrome.runtime.getURL("assets/test.png");
  const sourceLabel =
    message.source ||
    (imageUrl.startsWith("data:")
      ? "Protected screenshot"
      : "Local test.png baseline");
  console.log(`[LocalLens Offscreen] Detector input source: ${sourceLabel}`);

  const detector = await getDetector();

  // 3. Measure inference duration on WebGPU
  console.log(
    `[LocalLens Offscreen] Running object detection on ${sourceLabel} via WebGPU...`,
  );
  const startTime = performance.now();
  // Threshold 0.2 captures visible elements with confident scores
  const rawResults = await detector(imageUrl, { threshold: 0.2 });
  const endTime = performance.now();
  const inferenceDurationMs = Math.round(endTime - startTime);

  console.log(
    `[LocalLens Offscreen] WebGPU object detection completed in ${inferenceDurationMs} ms:`,
    rawResults,
  );

  const detections = (rawResults || []).map((d) => ({
    label: d.label,
    score: Math.round(d.score * 1000) / 1000,
    box: {
      xmin: Math.round(d.box.xmin),
      ymin: Math.round(d.box.ymin),
      xmax: Math.round(d.box.xmax),
      ymax: Math.round(d.box.ymax),
    },
  }));

  return {
    success: true,
    device: "WebGPU",
    model: DETECTOR_MODEL_NAME,
    source: sourceLabel,
    inferenceTimeMs: inferenceDurationMs,
    count: detections.length,
    detections: detections,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "TEST_WEBGPU_VISION") {
    handleWebGpuVisionTest(message)
      .then((res) => sendResponse(res))
      .catch((err) => {
        console.error("[LocalLens Offscreen] Fatal classification error:", err);
        sendResponse({
          success: false,
          device: "WebGPU",
          error: err.message || String(err),
        });
      });

    return true;
  }

  if (message && message.type === "TEST_WEBGPU_OBJECT_DETECTION") {
    handleWebGpuObjectDetectionTest(message)
      .then((res) => sendResponse(res))
      .catch((err) => {
        console.error("[LocalLens Offscreen] Fatal object detection error:", err);
        sendResponse({
          success: false,
          device: "WebGPU",
          error: err.message || String(err),
        });
      });

    return true;
  }
});
