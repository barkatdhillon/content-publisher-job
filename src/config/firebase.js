const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

function getProjectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
}

function tryInitWithServiceAccount(projectId) {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64Raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (jsonRaw && String(jsonRaw).trim()) {
    const serviceAccount = JSON.parse(jsonRaw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId
    });
    return true;
  }

  if (b64Raw && String(b64Raw).trim()) {
    const decoded = Buffer.from(String(b64Raw), 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decoded);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId
    });
    return true;
  }

  return false;
}

function initFirebase() {
  const projectId = getProjectId();

  if (!admin.apps.length) {
    const initialized = tryInitWithServiceAccount(projectId);
    if (!initialized) {
      admin.initializeApp({ projectId });
    }
  }

  const db = admin.firestore();
  const storage = new Storage({ projectId });

  return { admin, db, storage, projectId };
}

module.exports = {
  initFirebase
};
