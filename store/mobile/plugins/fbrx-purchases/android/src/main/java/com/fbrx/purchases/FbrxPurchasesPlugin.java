package com.fbrx.purchases;

import androidx.annotation.NonNull;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/**
 * Subscriptions through Google Play. The app sends each purchase token to the FBRX account, which asks Play about it,
 * acknowledges it and turns the edition on. Purchases carry the FBRX account's id (obfuscatedAccountId), so a
 * purchase always finds its account.
 */
@CapacitorPlugin(name = "FbrxPurchases")
public class FbrxPurchasesPlugin extends Plugin implements PurchasesUpdatedListener {

    private BillingClient billing;
    private PluginCall pendingBuy;

    @Override
    public void load() {
        billing = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build();
    }

    /** Runs once Play is connected (connecting first when needed). */
    private void ready(PluginCall call, Runnable then) {
        if (billing.isReady()) {
            then.run();
            return;
        }
        billing.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) then.run();
                else call.reject("Google Play is not available: " + result.getDebugMessage());
            }

            @Override
            public void onBillingServiceDisconnected() {
                // The next call connects again.
            }
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        out.put("store", "google");
        out.put("testBuild", false);
        call.resolve(out);
    }

    private QueryProductDetailsParams query(List<String> ids) {
        List<QueryProductDetailsParams.Product> list = new ArrayList<>();
        for (String id : ids) {
            list.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(BillingClient.ProductType.SUBS).build());
        }
        return QueryProductDetailsParams.newBuilder().setProductList(list).build();
    }

    @PluginMethod
    public void products(PluginCall call) {
        List<String> ids;
        try {
            ids = call.getArray("ids", new JSArray()).toList();
        } catch (Exception e) {
            call.reject("ids must be a list of product ids");
            return;
        }
        ready(call, () ->
            billing.queryProductDetailsAsync(query(ids), (result, details) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject(result.getDebugMessage());
                    return;
                }
                JSArray products = new JSArray();
                for (ProductDetails d : details.getProductDetailsList()) {
                    JSObject p = new JSObject();
                    p.put("id", d.getProductId());
                    p.put("title", d.getName());
                    List<ProductDetails.SubscriptionOfferDetails> offers = d.getSubscriptionOfferDetails();
                    if (offers != null && !offers.isEmpty()) {
                        List<ProductDetails.PricingPhase> phases = offers.get(0).getPricingPhases().getPricingPhaseList();
                        if (!phases.isEmpty()) p.put("price", phases.get(phases.size() - 1).getFormattedPrice());
                    }
                    products.put(p);
                }
                JSObject out = new JSObject();
                out.put("products", products);
                call.resolve(out);
            })
        );
    }

    @PluginMethod
    public void buy(PluginCall call) {
        String productId = call.getString("productId");
        String accountId = call.getString("accountId");
        String oldToken = call.getString("oldPurchaseToken");
        if (productId == null || accountId == null) {
            call.reject("productId and accountId are needed");
            return;
        }
        if (pendingBuy != null) {
            call.reject("A purchase is already open");
            return;
        }
        ready(call, () ->
            billing.queryProductDetailsAsync(query(List.of(productId)), (result, details) -> {
                List<ProductDetails> list = details.getProductDetailsList();
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || list.isEmpty()) {
                    call.reject("That product is not on Google Play");
                    return;
                }
                ProductDetails d = list.get(0);
                List<ProductDetails.SubscriptionOfferDetails> offers = d.getSubscriptionOfferDetails();
                if (offers == null || offers.isEmpty()) {
                    call.reject("That product has no plan on Google Play");
                    return;
                }
                BillingFlowParams.Builder flow = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(
                        List.of(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(offers.get(0).getOfferToken()).build())
                    )
                    .setObfuscatedAccountId(accountId);
                // Standard to Ultra (or back): Play replaces the old subscription and charges the difference.
                if (oldToken != null && !oldToken.isEmpty()) {
                    flow.setSubscriptionUpdateParams(
                        BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                            .setOldPurchaseToken(oldToken)
                            .setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.CHARGE_PRORATED_PRICE)
                            .build()
                    );
                }
                pendingBuy = call;
                getActivity().runOnUiThread(() -> {
                    BillingResult r = billing.launchBillingFlow(getActivity(), flow.build());
                    if (r.getResponseCode() != BillingClient.BillingResponseCode.OK && pendingBuy != null) {
                        pendingBuy.reject(r.getDebugMessage());
                        pendingBuy = null;
                    }
                });
            })
        );
    }

    private JSObject view(Purchase p) {
        JSObject o = new JSObject();
        o.put("store", "google");
        o.put("productId", p.getProducts().isEmpty() ? null : p.getProducts().get(0));
        o.put("purchaseToken", p.getPurchaseToken());
        o.put("pending", p.getPurchaseState() == Purchase.PurchaseState.PENDING);
        // Not acknowledged yet: the FBRX account has not recorded it (Play refunds it after three days), so send it again.
        o.put("acknowledged", p.isAcknowledged());
        if (p.getAccountIdentifiers() != null) o.put("accountId", p.getAccountIdentifiers().getObfuscatedAccountId());
        return o;
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        PluginCall call = pendingBuy;
        pendingBuy = null;
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            if (call != null) {
                JSObject out = new JSObject();
                out.put("state", "canceled");
                call.resolve(out);
            }
            return;
        }
        if (code != BillingClient.BillingResponseCode.OK || purchases == null) {
            if (call != null) call.reject(result.getDebugMessage());
            return;
        }
        for (Purchase p : purchases) {
            JSObject v = view(p);
            if (call != null) {
                v.put("state", p.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending");
                call.resolve(v);
                call = null;
            } else {
                // A purchase finished later (a pending payment went through): the app sends it to the FBRX account.
                notifyListeners("transaction", v, true);
            }
        }
    }

    /** The subscriptions this Play account has now (to send again, or to replace on an upgrade). */
    @PluginMethod
    public void restore(PluginCall call) {
        ready(call, () ->
            billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(), (result, list) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject(result.getDebugMessage());
                    return;
                }
                JSArray out = new JSArray();
                for (Purchase p : list) if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) out.put(view(p));
                JSObject r = new JSObject();
                r.put("purchases", out);
                call.resolve(r);
            })
        );
    }

    /** Nothing to finish on Android: the FBRX account acknowledges each purchase with Play once it has recorded it. */
    @PluginMethod
    public void finish(PluginCall call) {
        call.resolve();
    }

    /** Google Play's subscriptions page, where a subscription is changed or canceled. */
    @PluginMethod
    public void manage(PluginCall call) {
        String sku = call.getString("productId");
        String url = "https://play.google.com/store/account/subscriptions?package=" + getContext().getPackageName() + (sku != null ? "&sku=" + sku : "");
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
