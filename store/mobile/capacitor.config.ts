import type { CapacitorConfig } from '@capacitor/cli';

// FBRX Mobile in the app stores. The app id is fixed in the native projects (ios/, android/) once they exist: change it
// there too (docs/STORES.md).
const config: CapacitorConfig = {
  appId: 'com.fbrx.mobile',
  appName: 'FBRX',
  webDir: 'www',
  backgroundColor: '#0a0a0a',
  ios: { contentInset: 'never' },
  plugins: {
    // Native networking for fetch: the phone reaches the computer at its local address (plain http, every request
    // sealed end to end by FBRX Mobile itself) and the FBRX account, without the web view's cross-origin rules.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
