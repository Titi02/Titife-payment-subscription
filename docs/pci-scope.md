# PCI DSS Scope Reasoning

This document explains why the Titife Payment Subscription Slice is classified under the lightest-weight **SAQ A** PCI DSS compliance category and how we maintain this boundary.

## 1. Zero Card Data Transmission or Storage
No raw cardholder data (Primary Account Number (PAN), expiration date, or Card Verification Code (CVC)) ever touches this application's servers, databases, or frontend code. 

- **Frontend Isolation**: All card entry happens exclusively via Paystack's hosted checkout page (invoked via the Initialize Transaction flow). The application does not render any custom payment forms or iframes.
- **Backend Isolation**: Webhooks and API responses from Paystack contain opaque identifiers (e.g., `authorization_code`, `customer_code`, `reference`), but never the full raw card data.

## 2. Outsourced Cardholder Data Environment (CDE)
By entirely outsourcing the collection, processing, and transmission of cardholder data to Paystack, we eliminate the Cardholder Data Environment (CDE) from our infrastructure. Because our application servers never process the data, we avoid the more rigorous **SAQ A-EP** and **SAQ D** requirements.

## 3. Safe Identifiers and Tokenization
The only identifiers we store in the `Subscription` and `PaymentLog` databases are:
- **`paystackAuthorizationCode`**: A tokenized reference to a vaulted card, bound to our specific Paystack integration and returned by Paystack's hosted checkout. It is stored for identification/audit and is useless to an attacker on its own; it cannot be reversed to reveal the PAN. (This build never initiates off-session charges; all charges go through hosted checkout.)
- **`providerReference` / `paystackTransactionId`**: Transaction identifiers used exclusively for idempotency and audit trails.

## 4. Payment Lifecycle Separation
Our payment logging system separates every mutation into strict, immutable events (`INITIATION`, `VERIFICATION`, `FULFILMENT`). We enforce that entitlement is **never** granted on frontend redirect. It is only granted after a server-to-server call directly to Paystack verifying the `reference`, guaranteeing that the payment state is insulated from client-side manipulation.
