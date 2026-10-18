const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");

async function startServer() {
  const child = spawn(process.env.GIS_PYTHON || "python",
    [path.join(__dirname, "browser_server.py")],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`测试服务提前退出 ${code}: ${diagnostics}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        const value = Number(output.split("\n")[0].trim());
        if (Number.isInteger(value) && value > 0) resolve(value);
        else reject(new Error(`无法读取测试服务端口：${output} ${diagnostics}`));
      }
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  let timer;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("测试服务未按时退出")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("C 组浏览器流程：字段默认值、绘制、属性、历史、排序定位与无效面", {
  timeout: 90000,
}, async () => {
  const { child, baseUrl } = await startServer();
  let browser;
  try {
    const channel = process.env.GIS_BROWSER_CHANNEL ||
      (process.platform === "win32" ? "msedge" : undefined);
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const rawData = async () => {
      const response = await page.request.get(`${baseUrl}/api/datasets/features`);
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    };

    await page.goto(baseUrl);
    await page.waitForFunction(() => document.getElementById("backendStatus")
      .textContent.includes("服务："));
    const original = await rawData();

    assert.equal(await page.locator(".map-north-arrow").count(), 1);
    assert.equal(await page.locator("#mapScaleLabel").count(), 1);
    await page.waitForFunction(() => document.getElementById("mapScaleLabel")
      .textContent.trim() !== "—");
    const layerCount = await page.locator("#layerList .layer-row").count();
    assert.ok(layerCount > 0, "expected at least one visible data layer");
    await page.locator("#layerList .layer-color-input").first().evaluate((input) => {
      input.value = "#123456";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#layerList input[type=range]").first().evaluate((input) => {
      input.value = "0.8";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (layerCount > 1) {
      await page.locator("#layerList .layer-row").nth(1).evaluate((sourceRow) => {
        const targetRow = document.querySelector("#layerList .layer-row");
        const transfer = new DataTransfer();
        transfer.setData("text/plain", sourceRow.dataset.layer);
        targetRow.dispatchEvent(new DragEvent("drop", {
          bubbles: true, cancelable: true, dataTransfer: transfer,
        }));
      });
    }
    const savedLayerPreferences = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("gis-vector-demo-layer-preferences-v1")));
    assert.ok(savedLayerPreferences.styles);
    const styledLayer = Object.values(savedLayerPreferences.styles)
      .find((style) => style.color === "#123456");
    assert.ok(styledLayer, "custom layer color should be persisted");
    assert.ok(savedLayerPreferences.order.length > 0);

    await page.reload();
    await page.waitForFunction(() => document.getElementById("backendStatus")
      .textContent.includes("服务："));
    const restoredPreferences = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("gis-vector-demo-layer-preferences-v1")));
    assert.deepEqual(restoredPreferences, savedLayerPreferences);
    const firstLayerColor = await page.locator("#layerList .layer-row").first().evaluate((row) => ({
      name: row.dataset.layer,
      color: row.querySelector(".layer-color-input").value,
    }));
    assert.equal(firstLayerColor.color, restoredPreferences.styles[firstLayerColor.name].color);

    await page.locator("#addFieldBtn").click();
    await page.locator("#newFieldName").fill("score");
    await page.locator("#newFieldType").selectOption("number");
    await page.locator("#newFieldDefault").fill("5");
    await page.locator("#confirmFieldBtn").click();
    await page.locator("#addFieldDialog").waitFor({ state: "hidden" });
    const withField = await rawData();
    assert.equal(withField.field_types.score, "number");
    assert.equal(withField.field_defaults.score, 5);

    await page.locator("#snapBtn").click();
    await page.locator('[data-mode="point"]').click();
    await page.locator("#mapCanvas").click({ position: { x: 90, y: 90 } });
    await page.waitForFunction((count) => Number(document.getElementById("featureCount")
      .textContent) === count + 1, original.features.length);
    const drawn = (await rawData()).features.find((feature) =>
      !original.features.some((item) => item.id === feature.id));
    assert.ok(drawn);
    assert.equal(drawn.properties.score, 5);

    await page.locator('#editFieldList input[data-field="score"]').fill("bad");
    await page.locator("#updateFeatureBtn").click();
    await page.waitForFunction(() => document.getElementById("hint")
      .textContent.includes("数字字段"));
    assert.equal((await rawData()).features.find((feature) => feature.id === drawn.id)
      .properties.score, 5);
    await page.locator('#editFieldList input[data-field="score"]').fill("7");
    await page.locator("#updateFeatureBtn").click();
    await page.waitForFunction((id) => document.getElementById("hint")
      .textContent.includes(`已保存 ${id}`), drawn.id);
    assert.equal((await rawData()).features.find((feature) => feature.id === drawn.id)
      .properties.score, 7);
    await page.locator("#undoEditBtn").click();
    await page.waitForFunction(() => document.getElementById("hint").textContent.includes("已撤销"));
    assert.equal((await rawData()).features.find((feature) => feature.id === drawn.id)
      .properties.score, 5);
    await page.locator("#redoEditBtn").click();
    await page.waitForFunction(() => document.getElementById("hint").textContent.includes("已重做"));
    assert.equal((await rawData()).features.find((feature) => feature.id === drawn.id)
      .properties.score, 7);

    await page.reload();
    await page.waitForFunction(() => document.getElementById("backendStatus")
      .textContent.includes("服务："));
    assert.equal((await rawData()).features.find((feature) => feature.id === drawn.id)
      .properties.score, 7);
    assert.equal(await page.locator("#undoEditBtn").isDisabled(), true);

    const nameSort = page.locator('#attributeHead button[data-sort-key="field:name"]');
    await nameSort.click();
    const ascending = await page.locator("#attributeTableBody tr[data-id] td:nth-child(2)")
      .allTextContents();
    await nameSort.click();
    const descending = await page.locator("#attributeTableBody tr[data-id] td:nth-child(2)")
      .allTextContents();
    assert.deepEqual(descending, [...ascending].reverse());

    await page.locator(`#attributeTableBody tr[data-id="${original.features[0].id}"] .row-locate`)
      .click();
    const focused = await page.evaluate((id) => {
      const feature = state.data.features.find((item) => item.id === id);
      const bounds = getBounds(feature);
      const point = worldToScreen([(bounds.minX + bounds.maxX) / 2,
        (bounds.minY + bounds.maxY) / 2]);
      return { selected: state.selectedIds.has(id),
        distance: Math.hypot(point.x - state.viewWidth / 2, point.y - state.viewHeight / 2) };
    }, original.features[0].id);
    assert.equal(focused.selected, true);
    assert.ok(focused.distance < 2, `定位偏差 ${focused.distance}px`);

    await page.locator("#snapBtn").click();
    await page.locator('[data-mode="polygon"]').click();
    const canvas = page.locator("#mapCanvas");
    for (const [x, y] of [[90, 90], [170, 170], [90, 170], [170, 90]]) {
      await canvas.click({ position: { x, y } });
    }
    await page.locator("#finishBtn").click();
    await page.waitForFunction(() => document.getElementById("hint")
      .textContent.includes("画面未保存"));
    assert.equal((await rawData()).features.length, original.features.length + 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    await stopServer(child);
  }
});
