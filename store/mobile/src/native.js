// FBRX Mobile in its store app: tells app.js it runs natively, where FBRX accounts live and how to buy in the store.
(function () {
  'use strict';
  var cap = window.capacitorExports;
  if (!cap || !cap.Capacitor.isNativePlatform()) return;
  var cfg = window.FBRX_STORE_CONFIG || {};
  var scanner = cap.registerPlugin('CapacitorBarcodeScanner');
  window.FBRX_NATIVE = {
    platform: cap.Capacitor.getPlatform(),
    version: cfg.version,
    accountServer: cfg.accountServer || '',
    products: cfg.products || [],
    terms: cfg.terms || '',
    privacy: cfg.privacy || '',
    purchases: cap.registerPlugin('FbrxPurchases'),
    /** The camera, for the pairing code the FBRX computer shows (a QR code with its address and the code). */
    scan: function () {
      // hint 0: QR codes only. cameraDirection 1: the back camera. scanOrientation 3: either way up.
      return scanner
        .scanBarcode({ hint: 0, scanInstructions: 'Point the camera at the code on your FBRX computer', scanButton: false, scanText: ' ', cameraDirection: 1, scanOrientation: 3 })
        .then(function (r) {
          return r.ScanResult;
        });
    },
  };
})();
