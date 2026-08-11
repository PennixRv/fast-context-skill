export const priceForTier = (tier: "starter" | "pro") => {
  return tier === "pro" ? 120 : 40;
};
