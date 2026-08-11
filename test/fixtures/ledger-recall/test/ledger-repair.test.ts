import assert from "node:assert/strict";
import test from "node:test";
import { repairOrphanedSettlements } from "../src/ledger/repair.js";
test("resumes half-applied settlements", () => {
  const ledger = { records: [{ id: "a", state: "half_applied" as const }] };
  const result = repairOrphanedSettlements(ledger);
  assert.deepEqual(result.repaired, ["a"]);
  assert.equal(result.status, "resumed");
  assert.equal(ledger.records[0].state, "posted");
});
// This fixture intentionally mirrors the bounded ledger recall scenario.
