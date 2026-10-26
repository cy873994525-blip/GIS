const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "backstrip.js"), "utf8");
const context = vm.createContext({ window: {} });
vm.runInContext(source, context, { filename: "static/backstrip.js" });
const backstrip = context.window.Backstrip.backstrip;

const formations = [
  { name: "Older", topDepth: 1000, bottomDepth: 2000, age: 100, lithology: "sandstone" },
  { name: "Younger", topDepth: 0, bottomDepth: 1000, age: 50, lithology: "shale" },
];

test("sorts ages and keeps option arrays attached to the original formation", () => {
  const result = backstrip(formations, { paleoWaterDepth: [80, 20], seaLevel: [4, 1] });
  assert.deepEqual(Array.from(result.burialHistory, (item) => item.age), [50, 100]);
  assert.deepEqual(Array.from(result.burialHistory, (item) => item.waterDepth), [20, 80]);
  assert.equal(result.diagnostics.inputOrderWasResorted, true);
});

test("load plus tectonic subsidence closes to total subsidence", () => {
  const result = backstrip([
    { name: "Layer", topDepth: 0, bottomDepth: 1500, age: 80, lithology: "limestone" },
  ], { paleoWaterDepth: [30], seaLevel: [5] });
  const item = result.tectonicSubsidence[0];
  assert.ok(Math.abs(item.totalSubsidence - item.tectonicSubsidence - item.loadSubsidence) < 1e-9);
  assert.equal(result.rates.length, 0);
});

test("thin intervals remain finite and report no artificial clamp", () => {
  const result = backstrip([
    { name: "Thin", topDepth: 1000, bottomDepth: 1000.001, age: 10, lithology: "shale" },
  ]);
  const formation = result.formationResults[0];
  assert.ok(Number.isFinite(formation.phiAverage));
  assert.ok(Number.isFinite(formation.originalThickness));
  assert.equal(result.diagnostics.clampedPorosityIntervals.length, 0);
});

test("reports stratigraphic gaps and rejects mismatched option arrays", () => {
  const result = backstrip([
    { name: "Young", topDepth: 0, bottomDepth: 500, age: 20, lithology: "sandstone" },
    { name: "Old", topDepth: 700, bottomDepth: 1200, age: 40, lithology: "sandstone" },
  ]);
  assert.equal(result.diagnostics.stratigraphicGaps[0].gap, 200);
  assert.throws(() => backstrip(formations, { seaLevel: [0] }), /长度必须与 formations 一致/);
  assert.throws(() => backstrip(formations, { density: { mantle: 2000 } }), /rhoM > rhoS > rhoW/);
});
