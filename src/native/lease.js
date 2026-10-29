const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ownedPath, outsideProduct } = require('../autonomy/store');
/** Atomic, fail-closed local device lease. Crashes and uncertain cleanup require operator reset. */
async function deviceLease({ deviceId, root = path.join(__dirname, '../../.qa-local/device-leases'), productRoot }) {
  if (productRoot) await outsideProduct(root, productRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = await ownedPath(root, `${crypto.createHash('sha256').update(deviceId).digest('hex')}.json`);
  const token = crypto.randomUUID();
  try { await fs.writeFile(file, JSON.stringify({deviceId,token,pid:process.pid,createdAt:new Date().toISOString()}), {flag:'wx',mode:0o600}); }
  catch(e) { if (e.code === 'EEXIST') throw new Error('Disposable device is leased or quarantined. Reset it before explicitly clearing its bot lease.'); throw e; }
  return { async release() { const data=JSON.parse(await fs.readFile(file,'utf8')); if(data.token!==token)throw new Error('Device lease ownership changed'); await fs.unlink(file); }, file };
}
module.exports={deviceLease};
