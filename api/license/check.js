const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');

const KEY_RE = /^SO-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // CORS for the Electron app (no browser origin → '*' is fine; key is the secret)
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim().toUpperCase() : '';
  const machineId = typeof body.machineId === 'string' ? body.machineId.trim().slice(0, 128) : '';

  if (!KEY_RE.test(licenseKey)) {
    return json(res, 200, { valid: false, reason: 'invalid_format' });
  }

  try {
    const db = await getDb();
    const licenses = db.collection('licenses');

    const lic = await licenses.findOne({ key: licenseKey });
    if (!lic) return json(res, 200, { valid: false, reason: 'unknown' });
    if (lic.status !== 'active') return json(res, 200, { valid: false, reason: lic.status });

    if (machineId) {
      if (!lic.machineId) {
        await licenses.updateOne(
          { _id: lic._id, machineId: null },
          { $set: { machineId, updatedAt: new Date() } },
        );
      } else if (lic.machineId !== machineId) {
        return json(res, 200, { valid: false, reason: 'machine_mismatch' });
      }
    }

    return json(res, 200, {
      valid: true,
      email: lic.userEmail,
      issuedAt: lic.issuedAt,
      machineId: lic.machineId || machineId || null,
    });
  } catch (err) {
    console.error('[check] error', err);
    return json(res, 500, { valid: false, reason: 'internal_error' });
  }
};
