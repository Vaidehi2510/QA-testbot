// Synthetic checkout only. Requirement: orders of at least $100 ship free.
function shippingCost(amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError('A nonnegative finite order amount is required');
  return amount >= 100 ? 0 : 5;
}

module.exports = { shippingCost };
