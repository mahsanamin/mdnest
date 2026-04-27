// Firebase SDK bootstrap.
// Initialized lazily — only when USER_PROVIDER=firebase servers load the app.
// Config is pulled from /api/config at runtime (backend embeds the web config
// there) so the same frontend bundle works on both local-mode and Firebase
// mode deployments without a rebuild.

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';

let _auth = null;
let _provider = null;

/**
 * Call once on app bootstrap with the `firebaseWebConfig` object returned
 * from /api/config. Safe to call multiple times — subsequent calls no-op.
 */
export function initFirebase(webConfig) {
  if (!webConfig || typeof webConfig !== 'object') return null;
  if (getApps().length === 0) {
    initializeApp(webConfig);
  }
  if (!_auth) {
    _auth = getAuth();
    _provider = new GoogleAuthProvider();
  }
  return _auth;
}

/**
 * Pop up the Google sign-in dialog. Returns a Firebase ID token on success.
 * Errors bubble up to the caller so the UI can display them.
 */
export async function signInWithGoogle() {
  if (!_auth) throw new Error('Firebase not initialized');
  const result = await signInWithPopup(_auth, _provider);
  const idToken = await result.user.getIdToken();
  return { idToken, user: result.user };
}

/**
 * Local Firebase sign-out — forgets the Google sign-in in *this* tab only.
 * Does NOT revoke the user's Google session globally. That's deliberate —
 * logging out of mdnest should not sign the user out of Google services.
 */
export async function signOutFirebase() {
  if (!_auth) return;
  try {
    await signOut(_auth);
  } catch {
    // Ignore — we're tearing down anyway.
  }
}

/**
 * Subscribe to Firebase auth state. Returns an unsubscribe fn.
 * Currently unused by App.jsx (mdnest has its own JWT and doesn't re-sync
 * from Firebase), but exported for future integrations.
 */
export function onFirebaseAuthStateChanged(cb) {
  if (!_auth) return () => {};
  return onAuthStateChanged(_auth, cb);
}
