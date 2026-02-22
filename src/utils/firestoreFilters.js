function parseCsvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyStatusFilter(query, statuses) {
  const list = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
  if (list.length <= 1) {
    return query.where('status', '==', list[0] || '');
  }
  if (list.length > 10) {
    throw new Error('Too many statuses for Firestore in-query (max 10)');
  }
  return query.where('status', 'in', list);
}

module.exports = {
  parseCsvEnv,
  applyStatusFilter
};
