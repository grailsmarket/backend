# SDK Service - CLAUDE.md

## Service Overview

The `@grails/sdk` is a TypeScript SDK for external developers to interact with the Grails ENS Marketplace API. It provides type-safe access to listings, offers, orders, SIWE authentication, and Seaport order building utilities.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Wallet Support**: viem only (modern, TypeScript-first)
- **Authentication**: SIWE (Sign-In With Ethereum)
- **Protocol**: Seaport 1.6
- **Build**: Dual ESM/CJS output

## Directory Structure

```
src/
  index.ts                    # Main entry, re-exports
  client.ts                   # GrailsClient main class
  config.ts                   # SDK configuration

  api/                        # API resource modules
    auth.ts                   # Auth (nonce, verify, me)
    listings.ts               # Listings CRUD
    offers.ts                 # Offers CRUD
    orders.ts                 # Seaport orders
    names.ts                  # ENS names
    search.ts                 # Search with filters

  auth/                       # Authentication utilities
    siwe.ts                   # SIWE message building
    session.ts                # Token management
    wallet-adapter.ts         # viem adapter

  seaport/                    # Seaport utilities
    types.ts                  # Seaport types
    constants.ts              # Contract addresses
    order-builder.ts          # Build listing/offer orders
    order-fulfiller.ts        # Fulfill orders on-chain

  types/                      # TypeScript definitions
    api.ts                    # Request/response types
    models.ts                 # ENSName, Listing, Offer
    filters.ts                # Search filter types

  errors/                     # Error classes
    api-error.ts              # GrailsAPIError, NotFoundError, etc.
    auth-error.ts             # NonceExpiredError, etc.

  utils/
    http.ts                   # HTTP client wrapper
    validation.ts             # Input validation

tests/                        # Unit tests
examples/                     # Usage examples
```

## Key Files

| File | Purpose |
|------|---------|
| `src/client.ts` | Main GrailsClient class |
| `src/api/auth.ts` | SIWE authentication flow |
| `src/api/search.ts` | Search with 25+ filters |
| `src/seaport/order-builder.ts` | Build Seaport orders |
| `src/seaport/order-fulfiller.ts` | Fulfill orders on-chain |
| `src/auth/wallet-adapter.ts` | viem/wagmi integration |

## API Endpoints Covered

| SDK Module | API Endpoint |
|------------|--------------|
| `auth.getNonce()` | `GET /api/v1/auth/nonce` |
| `auth.verify()` | `POST /api/v1/auth/verify` |
| `auth.me()` | `GET /api/v1/auth/me` |
| `listings.list()` | `GET /api/v1/listings` |
| `listings.get()` | `GET /api/v1/listings/:id` |
| `listings.getByName()` | `GET /api/v1/listings/name/:name` |
| `listings.create()` | `POST /api/v1/listings` |
| `offers.getByName()` | `GET /api/v1/offers/name/:name` |
| `offers.getByBuyer()` | `GET /api/v1/offers/buyer/:address` |
| `orders.save()` | `POST /api/v1/orders` |
| `orders.create()` | `POST /api/v1/orders/create` |
| `orders.bulkSave()` | `POST /api/v1/orders/bulk` |
| `names.get()` | `GET /api/v1/names/:name` |
| `names.getMetadata()` | `GET /api/v1/names/:name/metadata` |
| `search.search()` | `GET /api/v1/search` |
| `search.bulkExact()` | `POST /api/v1/search/bulk` |
| `search.bulkFilters()` | `POST /api/v1/search/bulk-filters` |

## Contract Addresses (Mainnet)

| Contract | Address |
|----------|---------|
| ENS Registrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` |
| ENS Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| Name Wrapper | `0xD4416b13d2b3a9AbAe7AcD5D6C2BbDBE25686401` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

## Common Commands

```bash
# Development
npm run dev          # Watch mode
npm run build        # Build all outputs
npm run typecheck    # Type checking

# Testing
npm test             # Run tests
npm run test:watch   # Watch mode

# Linting
npm run lint         # ESLint check
```

## Usage Examples

### Basic Search

```typescript
import { GrailsClient } from '@grails/sdk';

const grails = new GrailsClient();
const results = await grails.search.search({
  q: 'vitalik',
  showListings: true,
  minLength: 3,
});
```

### Authentication with viem

```typescript
import { GrailsClient, createViemSigner } from '@grails/sdk';

const grails = new GrailsClient();
const signer = createViemSigner(walletClient);
await grails.auth.signIn(address, signer);
```

### Create Listing

```typescript
import { GrailsClient, SeaportOrderBuilder } from '@grails/sdk';

const orderBuilder = new SeaportOrderBuilder();
const order = orderBuilder.buildListingOrder({
  tokenId: name.tokenId,
  priceWei: '1000000000000000000',
  offerer: address,
});
// Sign order, then save to Grails
```

### Buy Name (Fulfill Listing)

```typescript
import { SeaportOrderFulfiller } from '@grails/sdk';

const fulfiller = new SeaportOrderFulfiller();
const params = fulfiller.buildBasicOrderParameters(listing.orderData);
await walletClient.writeContract({
  address: fulfiller.getSeaportAddress(),
  abi: SeaportOrderFulfiller.getFulfillBasicOrderAbi(),
  functionName: 'fulfillBasicOrder_efficient_6GL6yc',
  args: [params],
  value: BigInt(listing.priceWei),
});
```

## Error Handling

The SDK provides typed errors:

- `GrailsAPIError` - Base API error
- `NotFoundError` - 404 errors
- `UnauthorizedError` - 401 errors
- `ValidationError` - 400 errors
- `RateLimitError` - 429 errors
- `NonceExpiredError` - SIWE nonce expired
- `InvalidSignatureError` - SIWE signature invalid
- `TokenExpiredError` - JWT token expired

## Dependencies

```json
{
  "dependencies": {
    "siwe": "^2.3.2",
    "viem": "^2.21.0"
  }
}
```

## Integration Points

- **API Service**: Consumes REST API endpoints
- **Frontend**: Can be used in browser with wallet extensions
- **Server**: Can be used in Node.js with private key signing

## Troubleshooting

### Common Issues

1. **SIWE signature fails**
   - Verify address matches wallet
   - Check nonce hasn't expired (5 minutes)
   - Ensure message format matches server expectations

2. **Order validation fails**
   - Check timing (start < end, not too far future)
   - Verify addresses are checksummed
   - Ensure amounts are positive strings

3. **Fulfillment fails**
   - Verify order hasn't expired
   - Check sufficient ETH/WETH balance
   - Ensure NFT approval for Seaport

4. **Rate limiting**
   - SDK has built-in retry with exponential backoff
   - Check `RateLimitError.retryAfter` for delay
