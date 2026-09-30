const test = require('node:test');
const assert = require('node:assert/strict');
const { shippingCost } = require('./calculator');

test('orders at the documented $100 threshold ship free', () => assert.equal(shippingCost(100), 0));
test('orders below $100 cost $5 to ship', () => assert.equal(shippingCost(99), 5));
test('orders above $100 ship free', () => assert.equal(shippingCost(101), 0));
test('negative and nonfinite amounts are rejected', () => {
  for (const amount of [-1, Infinity, NaN]) assert.throws(() => shippingCost(amount), TypeError);
});
