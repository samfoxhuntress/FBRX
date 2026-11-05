# Selling FBRX

The ways FBRX is sold, and billing webhooks. The editions, prices and licenses themselves: [LICENSING.md](../docs/LICENSING.md).

## Ways to sell

| Model | How |
| --- | --- |
| **Hosted (SaaS-style)** | You run one control plane; each customer is a tenant; customer admins get `owner`/`admin` users and manage their own fleet. You publish releases once for everyone. |
| **Customer-hosted** | Ship the control-plane image to the customer. Issue their licenses from *your* control plane (so the key stays with you) and deliver them offline or by importing into theirs. |
| **Standalone desktop** | Sell installers plus an offline key per customer or seat pack; no control plane needed on their side. |
| **White-label builds** | Change `productName`/`appId` in `apps/desktop/electron-builder.yml` and the `build/` icons, bake a provisioning file into `resources/provisioning/`, and ship a customer-specific installer that enrolls itself into the right tenant. |

## Webhooks for billing

The control plane emits `license.issued`, `device.enrolled` and `device.retired` webhooks (HMAC-signed), so a
billing or CRM system can track seats and renewals.
