# @grails/sdk

TypeScript SDK for the Grails ENS Marketplace API.

## Installation

```bash
npm install @grails/sdk
# or
yarn add @grails/sdk
# or
pnpm add @grails/sdk
```

## Quick Start

```typescript
import { GrailsClient } from '@grails/sdk';

// Create a client
const grails = new GrailsClient();

// Search for names
const results = await grails.search.search({
  q: 'vitalik',
  showListings: true,
  minLength: 3,
});

console.log(results.results);
```

## Authentication

The SDK supports Sign-In With Ethereum (SIWE) for authentication:

```typescript
import { GrailsClient, createViemSigner } from '@grails/sdk';
import { createWalletClient, custom } from 'viem';
import { mainnet } from 'viem/chains';

const grails = new GrailsClient();

// Create a viem wallet client
const walletClient = createWalletClient({
  chain: mainnet,
  transport: custom(window.ethereum),
});

// Create a signer
const signer = createViemSigner(walletClient);

// Sign in
const [address] = await walletClient.getAddresses();
const { token, user } = await grails.auth.signIn(address, signer);

console.log(`Logged in as ${user.address}`);
```

### Using with wagmi/RainbowKit

```typescript
import { GrailsClient, createWagmiSigner } from '@grails/sdk';
import { useSignMessage, useAccount } from 'wagmi';

function LoginButton() {
  const { signMessageAsync } = useSignMessage();
  const { address } = useAccount();

  const grails = new GrailsClient();
  const signer = createWagmiSigner(signMessageAsync);

  const handleLogin = async () => {
    await grails.auth.signIn(address, signer);
  };

  return <button onClick={handleLogin}>Sign In</button>;
}
```

## API Reference

### Search

```typescript
// Search with filters
const results = await grails.search.search({
  q: 'hello',                    // Search query
  minLength: 3,                  // Minimum name length
  maxLength: 5,                  // Maximum name length
  showListings: true,            // Only names with listings
  clubs: ['999', '10k'],         // Filter by clubs
  sortBy: 'price',               // Sort field
  sortOrder: 'asc',              // Sort order
  page: 1,                       // Page number
  limit: 20,                     // Results per page
});

// Bulk exact search
const bulkResults = await grails.search.bulkExact({
  terms: ['vitalik', 'ethereum', 'wallet'],
});

// Bulk search with filters
const filteredResults = await grails.search.bulkFilters({
  terms: ['name1', 'name2', 'name3'],
  showListings: true,
  minPrice: '1000000000000000000', // 1 ETH
});
```

### Listings

```typescript
// List all listings
const listings = await grails.listings.list({
  status: 'active',
  sort: 'price',
  order: 'asc',
});

// Get listings for a name
const nameListings = await grails.listings.getByName('vitalik.eth');

// Get single listing
const listing = await grails.listings.get(123);

// Create listing (requires auth)
const newListing = await grails.listings.create({
  ensNameId: 123,
  sellerAddress: '0x...',
  priceWei: '1000000000000000000',
  orderData: { /* Seaport order */ },
});

// Cancel listing
await grails.listings.cancel(123);
```

### Offers

```typescript
// Get offers for a name
const offers = await grails.offers.getByName('vitalik.eth');

// Get offers by buyer
const myOffers = await grails.offers.getByBuyer('0x...');

// Get offers received (as owner)
const receivedOffers = await grails.offers.getByOwner('0x...');

// Create offer (requires auth)
const offer = await grails.offers.create({
  ensNameId: 123,
  buyerAddress: '0x...',
  offerAmountWei: '500000000000000000',
  orderData: { /* Seaport order */ },
});
```

### Names

```typescript
// List names
const names = await grails.names.list({
  owner: '0x...',
  status: 'listed',
});

// Get name details
const name = await grails.names.get('vitalik.eth');

// Get fresh metadata
const metadata = await grails.names.getMetadata('vitalik.eth');
```

## Seaport Integration

Build Seaport orders for listings and offers:

```typescript
import { SeaportOrderBuilder, SeaportOrderFulfiller } from '@grails/sdk';

const orderBuilder = new SeaportOrderBuilder();

// Build a listing order
const listingOrder = orderBuilder.buildListingOrder({
  tokenId: '12345678901234567890',
  priceWei: '1000000000000000000', // 1 ETH
  offerer: '0x...',
  durationDays: 7,
  platformFeeRecipient: '0x...', // Optional
  platformFeeBps: 250,            // 2.5%
});

// Validate the order
const { valid, errors } = orderBuilder.validate(listingOrder);

// Build an offer order
const offerOrder = orderBuilder.buildOfferOrder({
  tokenId: '12345678901234567890',
  offerAmountWei: '500000000000000000', // 0.5 WETH
  offerer: '0x...',
  durationDays: 7,
});
```

### Fulfilling Orders

```typescript
import { SeaportOrderFulfiller } from '@grails/sdk';

const fulfiller = new SeaportOrderFulfiller();

// Get listing from API
const listing = await grails.listings.get(123);

// Build fulfillment parameters
const params = fulfiller.buildBasicOrderParameters(listing.order_data);

// Calculate value to send
const value = fulfiller.calculateValue(listing.order_data);

// Execute on-chain
await walletClient.writeContract({
  address: fulfiller.getSeaportAddress(),
  abi: SeaportOrderFulfiller.getFulfillBasicOrderAbi(),
  functionName: 'fulfillBasicOrder_efficient_6GL6yc',
  args: [params],
  value,
});
```

## Error Handling

The SDK provides typed errors for common scenarios:

```typescript
import {
  GrailsAPIError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  RateLimitError,
} from '@grails/sdk';

try {
  const name = await grails.names.get('nonexistent.eth');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Name not found');
  } else if (error instanceof UnauthorizedError) {
    console.log('Please sign in');
  } else if (error instanceof RateLimitError) {
    console.log(`Rate limited. Retry after ${error.retryAfter}s`);
  } else if (error instanceof GrailsAPIError) {
    console.log(`API error: ${error.code} - ${error.message}`);
  }
}
```

## Configuration

```typescript
import { GrailsClient, MemoryTokenStorage } from '@grails/sdk';

const grails = new GrailsClient({
  // API base URL (default: https://api.grails.app)
  baseUrl: 'https://api.grails.app',

  // API version (default: 'v1')
  apiVersion: 'v1',

  // Request timeout in ms (default: 30000)
  timeout: 30000,

  // Number of retries (default: 3)
  retries: 3,

  // Custom token storage
  tokenStorage: new MemoryTokenStorage(),

  // Custom fetch implementation (for SSR)
  fetch: customFetch,
});
```

## Utilities

```typescript
import {
  isValidAddress,
  normalizeAddress,
  isValidENSName,
  normalizeENSName,
  isValidWeiAmount,
} from '@grails/sdk';

// Validate addresses
isValidAddress('0x...'); // true/false

// Normalize addresses (lowercase)
normalizeAddress('0xAbC...'); // '0xabc...'

// Validate ENS names
isValidENSName('vitalik.eth'); // true

// Normalize ENS names (lowercase, add .eth)
normalizeENSName('VITALIK'); // 'vitalik.eth'
```

## Contract Addresses

```typescript
import {
  SEAPORT_ADDRESS,
  ENS_REGISTRAR_ADDRESS,
  WETH_ADDRESS,
} from '@grails/sdk';

console.log(SEAPORT_ADDRESS);       // 0x0000000000000068F116a894984e2DB1123eB395
console.log(ENS_REGISTRAR_ADDRESS); // 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
console.log(WETH_ADDRESS);          // 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
```

## TypeScript Support

The SDK is written in TypeScript and exports all types:

```typescript
import type {
  ENSName,
  Listing,
  Offer,
  SearchResult,
  SearchFilters,
  SeaportOrder,
} from '@grails/sdk';
```

## License

MIT
