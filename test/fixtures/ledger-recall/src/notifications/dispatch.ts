export function dispatchSettlementNotice(settlementId: string) {
  return `queued:${settlementId}`;
}
