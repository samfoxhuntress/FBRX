import Foundation
import Capacitor
import StoreKit

/// Transactions waiting for the FBRX account to record them; finished once it has.
actor Unfinished {
    private var items: [String: Transaction] = [:]
    func put(_ t: Transaction) { items[String(t.id)] = t }
    func take(_ id: String) -> Transaction? { items.removeValue(forKey: id) }
}

/// Subscriptions through the App Store (StoreKit 2). Each purchase carries the FBRX account's app account token, and the
/// app sends the signed transaction to the FBRX account, which checks Apple's signature and turns the edition on. A
/// transaction is finished only after that, so one that could not be sent comes back the next time the app opens.
@objc(FbrxPurchasesPlugin)
public class FbrxPurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FbrxPurchasesPlugin"
    public let jsName = "FbrxPurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise)
    ]
    private let unfinished = Unfinished()
    private var updates: Task<Void, Never>?

    override public func load() {
        // Renewals, purchases approved later (Ask to Buy), refunds, and anything not finished last time.
        updates = Task.detached { [weak self] in
            for await result in Transaction.unfinished { await self?.deliver(result) }
            for await result in Transaction.updates { await self?.deliver(result) }
        }
    }

    deinit { updates?.cancel() }

    private func deliver(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let t) = result else { return }
        await unfinished.put(t)
        // Kept until the app listens, so one that arrives while the app starts up is not lost.
        notifyListeners("transaction", data: ["store": "apple", "productId": t.productID, "transactionId": String(t.id), "signedTransaction": result.jwsRepresentation], retainUntilConsumed: true)
    }

    @objc func status(_ call: CAPPluginCall) {
        Task {
            var test = false
            if #available(iOS 16.0, *), case .verified(let app)? = try? await AppTransaction.shared {
                // TestFlight and Xcode builds buy in the sandbox: nothing is charged.
                test = app.environment != .production
            }
            call.resolve(["available": AppStore.canMakePayments, "store": "apple", "testBuild": test])
        }
    }

    @objc func products(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            do {
                let list = try await Product.products(for: ids)
                call.resolve(["products": list.map { ["id": $0.id, "title": $0.displayName, "price": $0.displayPrice] }])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func buy(_ call: CAPPluginCall) {
        guard let id = call.getString("productId"), let token = call.getString("appAccountToken").flatMap({ UUID(uuidString: $0) }) else {
            return call.reject("productId and appAccountToken are needed")
        }
        Task {
            do {
                guard let product = try await Product.products(for: [id]).first else { return call.reject("That product is not in the App Store") }
                switch try await product.purchase(options: [.appAccountToken(token)]) {
                case .success(let result):
                    guard case .verified(let t) = result else { return call.reject("The App Store could not confirm the purchase") }
                    await unfinished.put(t)
                    call.resolve(["state": "purchased", "store": "apple", "productId": t.productID, "transactionId": String(t.id), "signedTransaction": result.jwsRepresentation])
                case .pending:
                    // Ask to Buy or a payment that needs attention: it arrives later as a "transaction" event.
                    call.resolve(["state": "pending"])
                case .userCancelled:
                    call.resolve(["state": "canceled"])
                @unknown default:
                    call.resolve(["state": "canceled"])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// The subscriptions this Apple Account has now, after asking the App Store (the Restore purchases button).
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            try? await AppStore.sync()
            var out: [[String: Any]] = []
            for await result in Transaction.currentEntitlements {
                guard case .verified(let t) = result else { continue }
                out.append(["store": "apple", "productId": t.productID, "transactionId": String(t.id), "signedTransaction": result.jwsRepresentation])
            }
            call.resolve(["purchases": out])
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId") else { return call.reject("transactionId is needed") }
        Task {
            if let t = await unfinished.take(id) { await t.finish() }
            call.resolve()
        }
    }

    /// The App Store's own sheet to change or cancel a subscription.
    @objc func manage(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else { return call.reject("The app has no window yet") }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
