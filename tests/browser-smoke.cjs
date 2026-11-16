const { chromium } = require("playwright");

const APP_URL = "http://127.0.0.1:4173/Global%203D%20Terrain%20Explorer.html";
const failures = [];
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ": " + detail : ""));
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}
async function waitFor(predicate, timeout = 20000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader"
    ]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    const pageErrors = [];
    const geocoderNetwork = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => {
      if (/photon|geocoding-api|geocode\.arcgis/i.test(request.url())) {
        geocoderNetwork.push("FAILED " + request.url() + " :: " + (request.failure()?.errorText || "unknown"));
      }
    });
    page.on("response", response => {
      if (/photon|geocoding-api|geocode\.arcgis/i.test(response.url())) {
        geocoderNetwork.push("HTTP " + response.status() + " " + response.url());
      }
    });
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const webgl = await page.evaluate(() => {
      const canvas = document.getElementById("glCanvas");
      return !!(canvas && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
    });
    check("WebGL context initializes", webgl);
    const initialStatus = await waitFor(async () => {
      const value = await page.locator("#statusPill").textContent();
      return value && !value.includes("Initializing WebGL") ? value : null;
    }, 15000);
    check("Renderer exits initialization state", !!initialStatus, initialStatus || "status did not change");
    check("No shader compile/link error", !!initialStatus && !/shader|program link error/i.test(initialStatus), initialStatus || "");
    const tileStatus = await waitFor(async () => {
      const value = await page.locator("#statusPill").textContent();
      const match = value && value.match(/Tiles:\s*(\d+)/);
      return match && Number(match[1]) > 0 ? value : null;
    }, 25000);
    check("At least one imagery tile loads", !!tileStatus, tileStatus || "no successful imagery tile reported within 25 seconds");

    // Minimize and restore must remain functional.
    await page.locator("#hideToolsBtn").click();
    const hidden = await page.locator("#toolPanel").evaluate(el => getComputedStyle(el).display === "none");
    check("Hide tools panel", hidden);
    await page.locator("#showToolsBtn").click();
    const restored = await page.locator("#toolPanel").evaluate(el => getComputedStyle(el).display !== "none");
    check("Restore tools panel", restored);

    // Zoom controls update the displayed zoom value.
    const zoomBefore = await page.locator("#coordHud").textContent();
    await page.locator("#zoomInBtn").click();
    const zoomAfterIn = await page.locator("#coordHud").textContent();
    await page.locator("#zoomOutBtn").click();
    const zoomAfterOut = await page.locator("#coordHud").textContent();
    check("Zoom in/out controls update camera state",
      zoomBefore !== zoomAfterIn && zoomAfterIn !== zoomAfterOut,
      [zoomBefore, zoomAfterIn, zoomAfterOut].join(" -> "));

    // Coordinate HUD should copy paste-ready decimal lat,lon values.
    await page.locator("#coordHud").click();
    const copyFeedback = await waitFor(async () => {
      const value = await page.locator("#coordHud").textContent();
      return value && value.startsWith("Copied: ") ? value : null;
    }, 3000, 100);
    check("Coordinate HUD copies map center in standard lat, lon format",
      !!copyFeedback && /Copied: -?\d+\.\d{6}, -?\d+\.\d{6}/.test(copyFeedback),
      copyFeedback || "copy feedback was not shown");

    // Stress the high-zoom camera while repeatedly changing pitch. This guards
    // against invalid GL state during the camera/terrain clipping regression.
    for (let i = 0; i < 9; i++) await page.locator("#zoomInBtn").click();
    for (const pitch of ["20", "72", "38", "72", "12", "64", "52"]) {
      await page.locator("#pitchSlider").fill(pitch);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(400);
    const cameraStress = await page.evaluate(() => {
      const canvas = document.getElementById("glCanvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return { available: false, errors: [] };
      const errors = [];
      let error = gl.getError();
      while (error !== gl.NO_ERROR && errors.length < 8) {
        errors.push(error);
        error = gl.getError();
      }
      return { available: true, errors };
    });
    check("High-zoom repeated tilt keeps WebGL error-free",
      cameraStress.available && cameraStress.errors.length === 0,
      JSON.stringify(cameraStress));

    // Camera mode controls update pitch state.
    await page.locator("#btn2D").click();
    const pitch2d = await page.locator("#pitchVal").textContent();
    await page.locator("#btn3D").click();
    const pitch3d = await page.locator("#pitchVal").textContent();
    check("2D/3D controls update pitch", /0/.test(pitch2d) && /54/.test(pitch3d), pitch2d + " -> " + pitch3d);

    // Mouse drag must commit pan on release, not during pointer movement.
    const beforeDrag = await page.locator("#coordHud").textContent();
    const box = await page.locator("#glCanvas").boundingBox();
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.68);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.58, { steps: 8 });
    const duringDrag = await page.locator("#coordHud").textContent();
    await page.mouse.up();
    const afterDrag = await page.locator("#coordHud").textContent();
    check("Mouse pan commits after release", duringDrag === beforeDrag && afterDrag !== beforeDrag,
      beforeDrag + " | during: " + duringDrag + " | after: " + afterDrag);

    // Curated saved-place dropdown should contain requested destinations and navigate on selection.
    const savedPlaceCheck = await page.evaluate(() => {
      const select = document.getElementById("savedLocationSelect");
      const labels = Array.from(select.options).map(option => option.textContent);
      return {
        present: !!select,
        hasEye: labels.includes("Eye of Sahara"),
        hasAndaman: labels.includes("Andaman Islands"),
        hasOxford: labels.includes("University of Oxford"),
        hasLiberty: labels.includes("Statue of Liberty"),
        removedOldPresets: !labels.includes("Grand Canyon") && !labels.includes("Mt. Fuji")
      };
    });
    check("Saved places dropdown contains curated locations", savedPlaceCheck.present &&
      savedPlaceCheck.hasEye && savedPlaceCheck.hasAndaman && savedPlaceCheck.hasOxford &&
      savedPlaceCheck.hasLiberty && savedPlaceCheck.removedOldPresets, JSON.stringify(savedPlaceCheck));
    await page.locator("#savedLocationSelect").selectOption("51.75717365694981,-1.2538370726565802,13");
    const oxfordHud = await waitFor(async () => {
      const value = await page.locator("#coordHud").textContent();
      return value && /Lat 51\./.test(value) ? value : null;
    }, 5000);
    check("Saved place selection starts fly-to", !!oxfordHud, oxfordHud || await page.locator("#coordHud").textContent());

    // Featured-location dropdown contains the requested destinations.
    const savedPlaces = await page.locator("#savedLocationSelect option").allTextContents();
    const expectedPlaces = [
      "Andaman Islands", "Maldives · Malé", "Lake Chad", "Eye of Sahara",
      "Yatan Qitahe", "Gangotri Glacier · Ganges", "Yamunotri Glacier · Yamuna",
      "University of Oxford", "Statue of Unity · Gujarat", "Statue of Liberty"
    ];
    check("Featured locations dropdown includes requested destinations",
      expectedPlaces.every(name => savedPlaces.includes(name)),
      "Missing: " + expectedPlaces.filter(name => !savedPlaces.includes(name)).join(", "));

    // Global search test. Search should resolve a non-preset city.
    await page.locator("#searchInput").fill("Paris");
    await page.locator("#searchBtn").click();
    const searchStatus = await waitFor(async () => {
      const value = await page.locator("#searchStatus").textContent();
      return value && (/Found:|No match found/.test(value)) ? value : null;
    }, 22000);
    check("Global search resolves a non-preset place", !!searchStatus && /Found:/i.test(searchStatus),
      (searchStatus || "search did not return within 22 seconds") + (geocoderNetwork.length ? " | " + geocoderNetwork.join(" ; ") : ""));

    // Mobile layout / touch pan: viewport layout is checked separately from gesture simulation.
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobile.newPage();
    const mobileErrors = [];
    mobilePage.on("pageerror", error => mobileErrors.push(error.message));
    await mobilePage.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    const mobileLayout = await mobilePage.evaluate(() => {
      const panel = document.getElementById("toolPanel");
      const dock = document.getElementById("quickDock");
      const canvas = document.getElementById("glCanvas");
      const statusPill = document.getElementById("statusPill");
      const p = getComputedStyle(panel);
      return {
        panelWithinViewport: panel.getBoundingClientRect().bottom <= innerHeight + 1,
        dockVisible: getComputedStyle(dock).display !== "none",
        secondaryStatusHidden: getComputedStyle(statusPill).display === "none",
        touchAction: getComputedStyle(canvas).touchAction
      };
    });
    check("Mobile viewport layout and touch affordances",
      mobileLayout.panelWithinViewport && mobileLayout.dockVisible && mobileLayout.secondaryStatusHidden && mobileLayout.touchAction === "none",
      JSON.stringify(mobileLayout));

    // Simulate a single-finger pan using browser Touch objects.
    const touchResult = await mobilePage.evaluate(() => {
      const canvas = document.getElementById("glCanvas");
      const before = document.getElementById("coordHud").textContent;
      const makeTouch = (x, y) => new Touch({
        identifier: 1, target: canvas, clientX: x, clientY: y,
        screenX: x, screenY: y, pageX: x, pageY: y
      });
      canvas.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true, cancelable: true, touches: [makeTouch(150, 350)], targetTouches: [makeTouch(150, 350)], changedTouches: [makeTouch(150, 350)]
      }));
      canvas.dispatchEvent(new TouchEvent("touchmove", {
        bubbles: true, cancelable: true, touches: [makeTouch(210, 390)], targetTouches: [makeTouch(210, 390)], changedTouches: [makeTouch(210, 390)]
      }));
      canvas.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [makeTouch(210, 390)]
      }));
      return { before, after: document.getElementById("coordHud").textContent };
    });
    check("Single-finger touch pan commits on release", touchResult.before !== touchResult.after,
      touchResult.before + " -> " + touchResult.after);
    check("No uncaught JavaScript errors", pageErrors.length === 0 && mobileErrors.length === 0,
      [...pageErrors, ...mobileErrors].join(" | ") || "none");

    await mobile.close();
    await context.close();
  } finally {
    await browser.close();
  }

  console.log("\nRegression summary: " + checks.filter(c => c.ok).length + "/" + checks.length + " passed.");
  if (failures.length) {
    console.error("\nFailures:\n" + failures.join("\n"));
    process.exitCode = 1;
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
