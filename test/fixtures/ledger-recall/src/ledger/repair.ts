export type Settlement = {
  id: string;
  state: "half_applied" | "posted";
};

type Ledger = { records: Settlement[] };

export function repairOrphanedSettlements(ledger: Ledger) {
  const repaired: string[] = [];

  for (const record of ledger.records) {
    if (record.state === "half_applied") {
      record.state = "posted";
      repaired.push(record.id);
    }
  }

  return {
    repaired,
    status: repaired.length === 0 ? "unchanged" : "resumed",
  };
}

export const settlementStates = ["half_applied", "posted"] as const;
