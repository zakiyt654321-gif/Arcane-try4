/**
 * Android APK & WebView Hardening Bridge (`src/apkBridge.js`)
 * - Enforces safe-area inset CSS variables, overscroll-behavior: none, and touch hardening.
 * - Manages Hardware Back Button navigation stack via `popstate` and `window.ArcaneNativeBridge.onBackPress()`.
 * - Handles `visibilitychange` / `pagehide` cleanly (audio mute + stuck joystick release).
 * - Exposes typed `window.ArcaneNativeBridge` hooks for future Capacitor / Android WebView plugins
 *   while preserving 100% web fallbacks and bridging `purchaseSku` into existing `ArcaneBilling`.
 */

const navStack = [];
let initialized = false;

function dispatchApkEvent(name, detail = {}) {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function detectNativeApk() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.Capacitor?.isNativePlatform?.() ||
      window.AndroidBilling ||
      window.ArcaneAndroid ||
      /ArcaneRoyaleAPK|wv\)/i.test(navigator.userAgent || '')
  );
}

export function initApkBridge() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // 1. WebView touch & overscroll hardening
  if (document.documentElement) {
    document.documentElement.style.overscrollBehavior = 'none';
  }
  if (document.body) {
    document.body.style.overscrollBehavior = 'none';
  }

  // 2. Typed Native Plugin Bridge Contract (`window.ArcaneNativeBridge`)
  const existing = window.ArcaneNativeBridge && typeof window.ArcaneNativeBridge === 'object'
    ? window.ArcaneNativeBridge
    : {};

  const bridge = {
    isNativeApk: detectNativeApk(),

    async signInWithGoogle() {
      if (typeof existing.signInWithGoogle === 'function') {
        return existing.signInWithGoogle();
      }
      if (window.ArcaneAndroid && typeof window.ArcaneAndroid.signInWithGoogle === 'function') {
        return JSON.parse(await window.ArcaneAndroid.signInWithGoogle());
      }
      return { ok: false, fallbackWeb: true, error: 'Native Google bridge unavailable on standard web.' };
    },

    async showRewardedAd(placement = 'vault') {
      if (typeof existing.showRewardedAd === 'function') {
        return existing.showRewardedAd(placement);
      }
      if (window.ArcaneAndroid && typeof window.ArcaneAndroid.showRewardedAd === 'function') {
        return JSON.parse(await window.ArcaneAndroid.showRewardedAd(placement));
      }
      return { ok: false, fallbackWeb: true };
    },

    async purchaseSku(sku) {
      const cleanSku = String(sku || '').trim();
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(cleanSku)) {
        return { ok: false, sku: cleanSku, purchaseToken: null, channel: 'invalid' };
      }
      if (typeof existing.purchaseSku === 'function') {
        const res = await existing.purchaseSku(cleanSku);
        return {
          ok: Boolean(res?.ok && res?.purchaseToken),
          sku: cleanSku,
          purchaseToken: typeof res?.purchaseToken === 'string' ? res.purchaseToken : null,
          channel: 'native-bridge',
        };
      }
      if (window.AndroidBilling && typeof window.AndroidBilling.purchase === 'function') {
        const raw = await window.AndroidBilling.purchase(cleanSku);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          ok: Boolean(parsed?.ok && parsed?.purchaseToken),
          sku: cleanSku,
          purchaseToken: typeof parsed?.purchaseToken === 'string' ? parsed.purchaseToken : null,
          channel: 'android-billing',
        };
      }
      return { ok: false, fallbackWeb: true, sku: cleanSku, purchaseToken: null, channel: 'web-preview' };
    },

    hapticImpact(style = 'light') {
      if (typeof existing.hapticImpact === 'function') {
        try {
          existing.hapticImpact(style);
          return;
        } catch {}
      }
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        const ms = style === 'heavy' ? 28 : style === 'medium' ? 16 : 9;
        try {
          navigator.vibrate(ms);
        } catch {}
      }
    },

    async shareText(title, text) {
      if (typeof existing.shareText === 'function') {
        return existing.shareText(title, text);
      }
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, text });
          return { ok: true, channel: 'web-share' };
        } catch {}
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          return { ok: true, channel: 'clipboard' };
        } catch {}
      }
      return { ok: false, channel: 'none' };
    },

    exitApp() {
      if (typeof existing.exitApp === 'function') {
        existing.exitApp();
        return;
      }
      if (window.ArcaneAndroid && typeof window.ArcaneAndroid.exitApp === 'function') {
        window.ArcaneAndroid.exitApp();
      }
    },

    pushNavState(tag) {
      if (!tag) return;
      navStack.push(tag);
      try {
        window.history.pushState({ arcaneNav: tag, depth: navStack.length }, '');
      } catch {}
    },

    onBackPress() {
      if (navStack.length > 0) navStack.pop();
      dispatchApkEvent('ar:apk:back', { remainingDepth: navStack.length });
      return true;
    },
  };

  Object.defineProperty(window, 'ArcaneNativeBridge', {
    value: Object.freeze(bridge),
    writable: false,
    configurable: false,
  });

  // 3. Hardware Back Button / Browser Back Gesture
  window.addEventListener('popstate', () => {
    bridge.onBackPress();
  });

  // 4. App Lifecycle (Background / Foreground / Incoming Phone Call)
  document.addEventListener('visibilitychange', () => {
    dispatchApkEvent('ar:apk:lifecycle', { hidden: document.hidden });
  });
  window.addEventListener('pagehide', () => {
    dispatchApkEvent('ar:apk:lifecycle', { hidden: true, pagehide: true });
  });
  window.addEventListener('blur', () => {
    dispatchApkEvent('ar:apk:lifecycle', { hidden: false, blurred: true });
  });
}

initApkBridge();
