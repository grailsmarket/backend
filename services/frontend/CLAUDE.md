# Frontend Service - CLAUDE.md

## Service Overview
The Frontend is a Next.js 15 application (with Turbopack) providing a comprehensive user interface for the Grails ENS Marketplace. It enables users to browse ENS listings, connect wallets via SIWE (Sign-In With Ethereum), track names on watchlists, vote on names, view analytics, and purchase ENS names using OpenSea's Seaport 1.6 protocol. The application features real-time activity updates via WebSocket connections.

## Technology Stack
- **Framework**: Next.js 15.5.9 with App Router and Turbopack
- **Language**: TypeScript 5
- **React**: React 19.1.0
- **Styling**: Tailwind CSS 4
- **Web3 Stack**: RainbowKit 2.2.8 + wagmi 2.17.4 + viem 2.37.8
- **State Management**: TanStack Query 5.90.2 + Zustand 5.0.8
- **API Client**: Axios 1.12.2
- **Authentication**: SIWE (Sign-In With Ethereum) 3.0.0
- **Smart Contracts**: OpenSea Seaport JS 4.0.5 + Seaport 1.6 protocol
- **Date Utilities**: date-fns 4.1.0
- **Icons**: Lucide React 0.544.0

## Key Components

### Pages (`app/`)
- **Home Page** (`page.tsx`): Home with trending sections (Most Viewed, Top Sales, Hot)
- **Marketplace** (`marketplace/page.tsx`): Full marketplace with search panel, filters, grid/table views
- **Name Detail** (`names/[name]/page.tsx`): ENS name detail with listing, offers, activity, characteristics
- **Watchlist** (`watchlist/page.tsx`): User's watchlist with search and filters (auth required)
- **Notifications** (`notifications/page.tsx`): User notification center (auth required)
- **Profile** (`profile/[address]/page.tsx`): User profile with owned names and activity
- **Portfolio** (`portfolio/page.tsx`): User's owned names, active listings, received offers (auth required)
- **Offers** (`offers/page.tsx`): User's made offers (auth required)
- **Clubs** (`clubs/page.tsx` and `clubs/[clubName]/page.tsx`): Club browsing and detail
- **Activity** (`activity/page.tsx`): Global activity feed with live WebSocket updates
- **Analytics** (`analytics/page.tsx`): Market analytics: overview, volume, price trends
- **Trending** (`trending/page.tsx`): Trending names by type (hot, views, votes, sales, offers)
- **Leaderboard** (`leaderboard/page.tsx`): Top voted names
- **Settings** (`settings/page.tsx`): Profile settings (email, telegram, discord) (auth required)
- **Verify Email** (`verify-email/page.tsx`): Email verification handler
- **Layout** (`layout.tsx`): Root layout with Inter font, Providers wrapper, Header, dark theme

### Components (`components/`)

#### Authentication
- `SignInModal`: SIWE authentication flow
- Protected routes with auth hydration checks

#### Listings
- `ListingGrid`: Responsive grid of listing cards
- `ListingCard`: Individual listing preview with price and name
- `ListingTable`: Table view with sorting
- `ListingDetails`: Detailed information panel
- `ListingInfo`: Listing card with buy button
- `ViewToggle`: Switch between grid/table view

#### Orders & Offers
- `OrderModal`: Seaport purchase flow with transaction states
- `CreateListingModal`: Create new listing
- `MakeOfferModal`: Make offer on ENS name
- `OfferModal`: Legacy offer modal
- `OffersSection`: Display offers for a name

#### Watchlist
- `AddToWatchlist`: Button to add/remove from watchlist
- `WatchlistManager`: Manage watchlist items
- `WatchlistTable`: Table with notification preferences

#### Notifications
- `NotificationsBell`: Header notification icon with unread count
- Notification list with mark as read functionality

#### Search & Filters
- `SearchPanel`: Advanced search with all filters
  - Price, length, character types, clubs, expiration, sales history

#### Profiles
- `ProfileHeader`: User profile header with ENS data
- `OwnedNames`: List of owned ENS names
- `ProfileActivity`: Activity history for address

#### Activity
- `ActivityHistory`: Activity feed component

#### Votes
- `VoteButtons`: Upvote/downvote buttons for ENS names

#### UI Components
- `Header`: Navigation, wallet connection, user menu
- `Providers`: Context providers wrapper (RainbowKit, Wagmi, React Query, Auth)

### Services (`services/`)

#### API Client
- `api/client.ts`: Axios instance with interceptors
- `api/listings.ts`: Listing CRUD operations
- `api/offers.ts`: Offer management

#### Seaport Integration
- `seaport/orderBuilder.ts`: Builds Seaport orders
  - `parseStoredOrder()`: Extracts order from API data
  - `buildBasicOrderParameters()`: Converts to Seaport 1.6 format
  - `validateOrder()`: Validates order parameters
  - `calculateTotalPayment()`: Computes ETH amount needed

### Hooks (`hooks/`)

#### Authentication
- `useAuth`: Complete SIWE authentication with Zustand persistence, signIn/signOut, token validation

#### Data Fetching (TanStack Query)
- `useListings`: Fetch listings with params (status, sort, price filters)
- `useListingByName`: Fetch listing by ENS name
- `useSearchListings`: Search with comprehensive filters
- `useProfile`: Fetch user profile data
- `useProfileActivity`: Fetch activity for address
- `useTrending`: Fetch trending names (composite, views, watchlist, votes, sales, offers)
- `useMultipleTrending`: Fetch multiple trending types at once
- `useAlsoViewed`: Recommendations based on viewing patterns
- `useMarketAnalytics`: Market overview statistics
- `usePriceTrends`: Price trends over time
- `useVolumeMetrics`: Volume metrics over time

#### Watchlist and Notifications
- `useWatchlist`: Watchlist CRUD operations (add, remove, update preferences)
- `useWatchlistSearch`: Search within user's watchlist with filters
- `useNotifications`: Fetch and manage notifications, unread count, mark as read

#### Seaport Integration
- `useSeaportOrder`: Execute Seaport transactions (fulfillOrder, estimateGas)
- `useSeaportClient`: Full Seaport client (createListing, createOffer, cancelOrders, validateOrder)

#### Other
- `useVotes`: Voting functionality for ENS names

## Environment Variables
```env
# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws

# Chain Configuration
NEXT_PUBLIC_CHAIN_ID=1                    # 1 for mainnet, 11155111 for sepolia
NEXT_PUBLIC_ENABLE_TESTNETS=false

# Contract Addresses
NEXT_PUBLIC_SEAPORT_ADDRESS=0x0000000000000068F116a894984e2DB1123eB395
NEXT_PUBLIC_ENS_REGISTRAR=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
NEXT_PUBLIC_WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
NEXT_PUBLIC_USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Conduit Configuration
NEXT_PUBLIC_CONDUIT_ADDRESS=0x73E9cD721a79C208E2F944910c27196307a2a05D
NEXT_PUBLIC_CONDUIT_KEY=0xC9C3A4337a1bba75D0860A1A81f7B990dc607334000000000000000000000000
NEXT_PUBLIC_USE_CONDUIT=true

# Marketplace Fees
NEXT_PUBLIC_FEE_ENABLED=false
NEXT_PUBLIC_FEE_BASIS_POINTS=250          # 2.5% = 250 basis points

# WalletConnect
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your-project-id
```

## Seaport 1.6 Integration

### Order Flow
1. User clicks "Buy Now" on listing
2. Frontend fetches order data from API
3. `OrderBuilder` parses protocol_data from listing
4. Converts to `BasicOrderParameters` format
5. Calls `fulfillBasicOrder_efficient_6GL6yc` function
6. User signs transaction in wallet
7. Transaction submitted to blockchain

### Key Functions
```typescript
// Build parameters for efficient Seaport 1.6 function
buildBasicOrderParameters(order: SeaportOrder, fulfillerAddress: Address)

// Execute purchase
fulfillBasicOrder_efficient_6GL6yc(parameters: BasicOrderParameters)
```

### Order Structure
```typescript
interface BasicOrderParameters {
  considerationToken: Address;
  considerationIdentifier: bigint;
  considerationAmount: bigint;
  offerer: Address;
  zone: Address;
  offerToken: Address;
  offerIdentifier: bigint;
  offerAmount: bigint;
  basicOrderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: bytes32;
  salt: bigint;
  offererConduitKey: bytes32;
  fulfillerConduitKey: bytes32;
  totalOriginalAdditionalRecipients: bigint;
  additionalRecipients: AdditionalRecipient[];
  signature: bytes;
}
```

## Common Commands
```bash
# Development
npm run dev          # Start dev server (port 3000/3001)
npm run build        # Build for production
npm start           # Run production build

# Code Quality
npm run lint         # Run ESLint
npm run typecheck    # TypeScript validation

# Testing
npm test            # Run tests
npm run test:e2e    # End-to-end tests
```

## Wallet Integration
- **Supported Wallets**: MetaMask, Rainbow, WalletConnect, Coinbase
- **Networks**: Ethereum Mainnet, Sepolia Testnet
- **Auto-connect**: Remembers previous connections
- **Account Display**: Shows address and ENS name if available

## API Integration Pattern
```typescript
// All API calls go through central client
const { data } = await apiClient.get<ListingsResponse>('/listings');

// React Query for caching and state
const { data, isLoading, error } = useQuery({
  queryKey: ['listings', filters],
  queryFn: () => listingsApi.getListings(filters)
});
```

## State Management
- **Server State**: TanStack Query for API data
- **Client State**: Zustand for UI state
- **Wallet State**: wagmi hooks for Web3

## Performance Optimizations
- Image optimization with Next.js Image
- Code splitting with dynamic imports
- API response caching
- Optimistic UI updates
- Debounced search inputs

## Error Handling
- Global error boundary
- Transaction error display
- API error messages
- Wallet connection errors
- Network mismatch warnings

## Testing Checklist
1. Connect wallet (multiple providers)
2. Browse listings (pagination, filters)
3. View listing details
4. Initiate purchase
5. Complete transaction
6. Handle errors gracefully

## Deployment
```bash
# Build optimized production bundle
npm run build

# Run production server
npm start

# Docker deployment
docker build -t ens-frontend .
docker run -p 3000:3000 ens-frontend
```

## Troubleshooting

### Common Issues
1. **Wallet not connecting**: Check WalletConnect project ID
2. **Transaction failing**: Verify Seaport address and chain ID
3. **API errors**: Ensure backend is running on correct port
4. **Order parsing fails**: Check order_data structure from API

### Debug Mode
```typescript
// Enable debug logs in development
if (process.env.NODE_ENV === 'development') {
  console.log('Order data:', listing.order_data);
  console.log('Built parameters:', basicOrderParams);
}
```

## Security Considerations
- Never store private keys
- Validate all transaction parameters
- Use checksummed addresses
- Implement CSP headers
- Sanitize user inputs
- Rate limit API requests