import { verifyFirebaseIdToken } from '../auth/firebaseAdmin.js';

function cookieValue(req, name) {
  const cookies = String(req.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export function createRequireAuth({ verifyIdToken = verifyFirebaseIdToken, verifyGuestToken, projectId } = {}) {
  return async function requireAuth(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match && verifyGuestToken) {
      try {
        const guest = verifyGuestToken(cookieValue(req, 'medisage_guest'));
        if (guest?.uid) {
          req.user = { uid: guest.uid, email: null, isAnonymous: true };
          return next();
        }
      } catch {
        /* Invalid or expired guest cookies use the normal controlled 401. */
      }
    }
    if (!match) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Your temporary session is unavailable. Refresh and try again.' }, meta: { requestId: req.requestId } });
    }
    try {
      const decoded = await verifyIdToken(match[1], { projectId });
      if (!decoded?.uid) throw new Error('Token has no user identifier.');
      req.user = {
        uid: decoded.uid,
        email: decoded.email || null,
        isAnonymous: decoded.firebase?.sign_in_provider === 'anonymous',
      };
      return next();
    } catch {
      return res.status(401).json({ success: false, error: { code: 'INVALID_AUTH_TOKEN', message: 'Your session is no longer valid. Sign in again.' }, meta: { requestId: req.requestId } });
    }
  };
}
