import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getDatabase, ref as rtdbRef, onValue, off } from 'firebase/database';
import appletConfig from '../firebase-applet-config.json';

const viteEnv = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

/**
 * Live zero-config Firebase wiring backed by the provisioned project in firebase-applet-config.json.
 * Any build-time VITE_FIREBASE_* env variable cleanly overrides the matching default
 * (and automatically targets '(default)' Firestore DB when overriding projectId).
 */
const hasCustomProjectOverride = Boolean(
  viteEnv.VITE_FIREBASE_PROJECT_ID && viteEnv.VITE_FIREBASE_PROJECT_ID !== appletConfig.projectId
);

export const DEFAULT_LIVE_FIREBASE_CONFIG = Object.freeze({
  apiKey: appletConfig.apiKey || '',
  authDomain: appletConfig.authDomain || '',
  databaseURL: appletConfig.databaseURL || '',
  projectId: appletConfig.projectId || '',
  storageBucket: appletConfig.storageBucket || '',
  messagingSenderId: appletConfig.messagingSenderId || '',
  appId: appletConfig.appId || '',
  firestoreDatabaseId: appletConfig.firestoreDatabaseId || '(default)',
});

export const FIREBASE_CONFIG = {
  apiKey: viteEnv.VITE_FIREBASE_API_KEY || DEFAULT_LIVE_FIREBASE_CONFIG.apiKey,
  authDomain: viteEnv.VITE_FIREBASE_AUTH_DOMAIN || DEFAULT_LIVE_FIREBASE_CONFIG.authDomain,
  databaseURL: viteEnv.VITE_FIREBASE_DATABASE_URL || DEFAULT_LIVE_FIREBASE_CONFIG.databaseURL,
  projectId: viteEnv.VITE_FIREBASE_PROJECT_ID || DEFAULT_LIVE_FIREBASE_CONFIG.projectId,
  storageBucket: viteEnv.VITE_FIREBASE_STORAGE_BUCKET || DEFAULT_LIVE_FIREBASE_CONFIG.storageBucket,
  messagingSenderId: viteEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || DEFAULT_LIVE_FIREBASE_CONFIG.messagingSenderId,
  appId: viteEnv.VITE_FIREBASE_APP_ID || DEFAULT_LIVE_FIREBASE_CONFIG.appId,
  firestoreDatabaseId:
    viteEnv.VITE_FIREBASE_DATABASE_ID ||
    (hasCustomProjectOverride ? '(default)' : DEFAULT_LIVE_FIREBASE_CONFIG.firestoreDatabaseId),
};

export const SIM_CHANNEL_NAME = 'arcane_royale_sim';
export const DEV_DEMO_ENABLED = true;

export const SANDBOX_STORAGE_KEYS = Object.freeze({
  users: 'arcane_sandbox_users_v1',
  session: 'arcane_sandbox_session_v1',
  friendCodes: 'arcane_sandbox_friendcodes_v1',
  friends: 'arcane_sandbox_friends_v1',
  requests: 'arcane_sandbox_requests_v1',
  presence: 'arcane_sandbox_presence_v1',
  squads: 'arcane_sandbox_squads_v1',
  invites: 'arcane_sandbox_invites_v1',
  matches: 'arcane_sandbox_matches_v1',
});

export const CLOUD_CACHE_STORAGE_KEYS = Object.freeze({
  profile: 'arcane_cloud_cache_profile_v1',
  meta: 'arcane_cloud_cache_meta_v1',
});

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

const PLACEHOLDER_RE = /your_|placeholder|remixed-project-id|xxxx|replace_me/i;

export function isFirebaseConfigured(cfg = FIREBASE_CONFIG) {
  if (!cfg || typeof cfg !== 'object') return false;
  const apiKey = String(cfg.apiKey || '').trim();
  const projectId = String(cfg.projectId || '').trim();
  const appId = String(cfg.appId || '').trim();
  if (!apiKey || !projectId || !appId) return false;
  if (PLACEHOLDER_RE.test(apiKey) || PLACEHOLDER_RE.test(projectId) || PLACEHOLDER_RE.test(appId)) {
    return false;
  }
  return true;
}

export function isRtdbConfigured(cfg = FIREBASE_CONFIG) {
  if (!isFirebaseConfigured(cfg)) return false;
  const url = String(cfg.databaseURL || '').trim();
  if (!url || PLACEHOLDER_RE.test(url)) return false;
  return /^https:\/\/[a-z0-9.-]+(firebaseio\.com|firebasedatabase\.app)\/?$/i.test(url);
}

export function isSandboxMode(cfg = FIREBASE_CONFIG) {
  return !isFirebaseConfigured(cfg);
}

export function isSimBroadcastEnabled(cfg = FIREBASE_CONFIG) {
  return !isFirebaseConfigured(cfg);
}

let cachedServices = null;

function buildAppInitConfig(cfg) {
  const initCfg = {
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId: cfg.projectId,
    storageBucket: cfg.storageBucket,
    messagingSenderId: cfg.messagingSenderId,
    appId: cfg.appId,
  };
  if (isRtdbConfigured(cfg)) {
    initCfg.databaseURL = cfg.databaseURL;
  }
  return initCfg;
}

function createFirestoreInstance(app, databaseId) {
  // Auto-detect long-polling so normal browsers use fast WebChannel streaming
  // (~150ms) while restricted WebViews/proxies still fall back seamlessly.
  const firestoreSettings =
    typeof window !== 'undefined' ? { experimentalAutoDetectLongPolling: true } : {};
  try {
    return databaseId
      ? initializeFirestore(app, firestoreSettings, databaseId)
      : initializeFirestore(app, firestoreSettings);
  } catch (initErr) {
    console.warn('[FirebaseConfig] initializeFirestore fallback to getFirestore:', {
      code: initErr?.code || 'firestore-init-fallback',
      message: initErr?.message || String(initErr),
      databaseId: databaseId || '(default)',
    });
    return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  }
}

export function getFirebaseServices() {
  if (cachedServices) return cachedServices;
  if (!isFirebaseConfigured(FIREBASE_CONFIG)) {
    console.warn('[FirebaseConfig] Firebase config missing or placeholder; running in Local Sandbox Mode.', {
      projectId: FIREBASE_CONFIG.projectId || null,
      authDomain: FIREBASE_CONFIG.authDomain || null,
    });
    cachedServices = { app: null, auth: null, db: null, rtdb: null, liveFirestore: false, liveRtdb: false };
    return cachedServices;
  }
  try {
    const app = getApps().length ? getApp() : initializeApp(buildAppInitConfig(FIREBASE_CONFIG));
    const auth = getAuth(app);
    const databaseId =
      FIREBASE_CONFIG.firestoreDatabaseId && FIREBASE_CONFIG.firestoreDatabaseId !== '(default)'
        ? FIREBASE_CONFIG.firestoreDatabaseId
        : undefined;
    const db = createFirestoreInstance(app, databaseId);
    let rtdb = null;
    if (isRtdbConfigured(FIREBASE_CONFIG)) {
      try {
        rtdb = getDatabase(app, FIREBASE_CONFIG.databaseURL);
      } catch (rtdbErr) {
        console.warn('[FirebaseConfig] Realtime Database initialization skipped:', {
          code: rtdbErr?.code || 'rtdb-init-error',
          message: rtdbErr?.message || String(rtdbErr),
        });
        rtdb = null;
      }
    }
    cachedServices = {
      app,
      auth,
      db,
      rtdb,
      liveFirestore: Boolean(db),
      liveRtdb: Boolean(rtdb),
    };
    return cachedServices;
  } catch (err) {
    console.error('[FirebaseConfig] Firebase client initialization failed:', {
      code: err?.code || 'firebase-init-error',
      message: err?.message || String(err),
      projectId: FIREBASE_CONFIG.projectId,
      authDomain: FIREBASE_CONFIG.authDomain,
      firestoreDatabaseId: FIREBASE_CONFIG.firestoreDatabaseId,
    });
    cachedServices = { app: null, auth: null, db: null, rtdb: null, liveFirestore: false, liveRtdb: false };
    return cachedServices;
  }
}

function withTimeout(promise, ms, timeoutMessage = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

let connectionCheckPromise = null;

export async function testFirestoreConnection() {
  const { db } = getFirebaseServices();
  if (!db) return false;
  if (connectionCheckPromise) return connectionCheckPromise;
  connectionCheckPromise = (async () => {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      console.info('[FirebaseConfig] Cloud Firestore connection verified.', {
        projectId: FIREBASE_CONFIG.projectId,
        firestoreDatabaseId: FIREBASE_CONFIG.firestoreDatabaseId,
      });
      return true;
    } catch (error) {
      const code = String(error?.code || '');
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'permission-denied' || code === 'not-found') {
        console.info('[FirebaseConfig] Cloud Firestore backend reachable (security rules active).', {
          code,
          projectId: FIREBASE_CONFIG.projectId,
          firestoreDatabaseId: FIREBASE_CONFIG.firestoreDatabaseId,
        });
        return true;
      }
      if (error instanceof Error && message.includes('the client is offline')) {
        console.error('Please check your Firebase configuration.');
      } else {
        console.warn('[FirebaseConfig] Cloud Firestore startup probe did not complete cleanly:', {
          code: code || 'connection-warning',
          message,
          projectId: FIREBASE_CONFIG.projectId,
          firestoreDatabaseId: FIREBASE_CONFIG.firestoreDatabaseId,
        });
      }
      return false;
    } finally {
      connectionCheckPromise = null;
    }
  })();
  return connectionCheckPromise;
}

/**
 * Live Diagnostics Helper for Settings -> Save Data.
 * Tests Auth, Firestore, and Realtime Database live with bounded timeouts
 * so the player sees clear green/red status pills and exact Firebase Console fixes.
 */
export async function runFirebaseDiagnostics() {
  const { auth, db, rtdb } = getFirebaseServices();
  const domain = typeof window !== 'undefined' && window.location ? window.location.hostname : 'localhost';
  const currentUser = auth?.currentUser || null;

  // 1. Auth Check
  const authResult = auth
    ? {
        ok: true,
        label: currentUser
          ? currentUser.isAnonymous
            ? 'Guest Signed In'
            : 'Signed In'
          : 'Ready',
        detail: currentUser
          ? `Authenticated (${currentUser.isAnonymous ? 'Anonymous' : (currentUser.email || 'Google')}) on ${domain}.`
          : `Auth SDK live for ${FIREBASE_CONFIG.projectId} (${domain}). Sign in to verify cloud profile sync.`,
      }
    : {
        ok: false,
        label: 'Not Ready',
        detail: 'Firebase Auth failed to initialize. Check your Firebase web config.',
      };

  // 2 & 3. Run Cloud Firestore and Realtime Database probes in parallel
  const checkFirestore = async () => {
    if (!db) {
      return { ok: false, label: 'Offline', detail: 'Firestore not initialized.' };
    }
    try {
      const probeRef = currentUser ? doc(db, 'users', currentUser.uid) : doc(db, 'test', 'connection');
      await withTimeout(getDocFromServer(probeRef), 10000, 'firestore-timeout');
      return {
        ok: true,
        label: 'Connected',
        detail: currentUser
          ? 'Cloud Firestore read succeeded for your profile.'
          : 'Cloud Firestore backend reachable.',
      };
    } catch (err) {
      const code = String(err?.code || '');
      const msg = String(err?.message || '');
      if (code === 'not-found') {
        return {
          ok: true,
          label: 'Connected',
          detail: 'Cloud Firestore reachable (profile document will auto-create on sign-in).',
        };
      }
      if (code === 'permission-denied') {
        if (!currentUser) {
          return {
            ok: true,
            label: 'Reachable',
            detail: 'Cloud Firestore is online and enforcing security rules (sign in to sync).',
          };
        }
        return {
          ok: false,
          label: 'Rules Blocked',
          detail: 'Firestore permission-denied. Tap "Copy firestore.rules" and publish it in Firebase Console → Firestore → Rules.',
        };
      }
      if (msg === 'firestore-timeout' || msg.includes('offline') || code === 'unavailable') {
        return {
          ok: false,
          label: 'Offline',
          detail: 'Firestore timed out. Make sure Cloud Firestore database is created in Firebase Console.',
        };
      }
      return {
        ok: false,
        label: 'Error',
        detail: `Firestore check failed (${code || msg || 'unknown'}).`,
      };
    }
  };

  const checkRtdb = async () => {
    if (!rtdb) {
      return {
        ok: true,
        label: 'Sim Ready',
        detail: 'Auth & Cloud Firestore are live. Squad rooms run in instant local/sim mode (set optional VITE_FIREBASE_DATABASE_URL for cross-device RTDB).',
      };
    }
    return new Promise((resolve) => {
      let settled = false;
      const connRef = rtdbRef(rtdb, '.info/connected');
      const finish = (res) => {
        if (settled) return;
        settled = true;
        try {
          off(connRef, 'value', handler);
        } catch {}
        clearTimeout(timer);
        resolve(res);
      };
      const handler = (snap) => {
        if (snap.val() === true) {
          finish({
            ok: true,
            label: 'Connected',
            detail: `Realtime Database live (${FIREBASE_CONFIG.databaseURL}).`,
          });
        }
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          label: 'Offline',
          detail: 'Realtime Database did not connect. Enable Realtime Database in Firebase Console and publish database.rules.json.',
        });
      }, 3500);
      try {
        onValue(connRef, handler, (err) => {
          finish({
            ok: false,
            label: 'Error',
            detail: `RTDB error: ${err?.message || 'check database.rules.json'}`,
          });
        });
      } catch (err) {
        finish({
          ok: false,
          label: 'Error',
          detail: `RTDB init error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  };

  const [firestoreResult, rtdbResult] = await Promise.all([checkFirestore(), checkRtdb()]);

  return {
    projectId: FIREBASE_CONFIG.projectId,
    authDomain: FIREBASE_CONFIG.authDomain,
    databaseURL: FIREBASE_CONFIG.databaseURL,
    domain,
    signedIn: Boolean(currentUser),
    uid: currentUser?.uid || null,
    auth: authResult,
    firestore: firestoreResult,
    rtdb: rtdbResult,
    allOk: Boolean(authResult.ok && firestoreResult.ok && rtdbResult.ok),
    checkedAt: Date.now(),
  };
}

export function handleFirestoreError(error, operationType, path) {
  const { auth } = getFirebaseServices();
  const user = auth?.currentUser || null;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid ?? null,
      email: user?.email ?? null,
      emailVerified: user?.emailVerified ?? null,
      isAnonymous: user?.isAnonymous ?? null,
      tenantId: user?.tenantId ?? null,
      providerInfo:
        user?.providerData?.map((p) => ({
          providerId: p.providerId,
          email: p.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
