async function parallelMap(items, concurrency, action) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Parallel execution must use one to eight explicitly enrolled workers');
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => { for (;;) { const index = next++; if (index >= items.length) return; output[index] = await action(items[index], index); } }));
  return output;
}
module.exports = { parallelMap };
