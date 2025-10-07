# Grails UI - Product Requirements Document

## Executive Summary

This document outlines the requirements for a proof-of-concept frontend application for the Grails ENS marketplace. The application will enable users to view ENS name listings from our backend API and execute purchases through OpenSea's Seaport smart contract. This POC will validate our ability to create valid Seaport orders and serve as the foundation for a full-featured marketplace UI.

## Project Goals

### Primary Objectives
1. **Display ENS Listings**: Fetch and display active ENS name listings from the Grails API
2. **Wallet Integration**: Enable users to connect Ethereum wallets for transaction signing
3. **Order Creation**: Format and build valid Seaport orders from listing data
4. **Order Execution**: Submit signed orders to OpenSea's Seaport contract
5. **Transaction Validation**: Verify successful order fulfillment on-chain

### Success Criteria
- Successfully display listings fetched from Grails API
- User can connect wallet via RainbowKit
- Application can construct valid Seaport order parameters
- User can sign and submit an order that executes on mainnet/testnet
- Transaction completes and ENS name ownership transfers

## Technical Architecture

### Technology Stack

#### Frontend Framework
- **Framework**: Next.js 14 (App Router)
- **Build Tool**: Built-in Next.js/Turbopack
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **State Management**: Zustand or React Context
- **Data Fetching**: TanStack Query (React Query)

#### Web3 Stack
- **Wallet Connection**: RainbowKit + wagmi v2
- **Ethereum Library**: viem
- **Chain Configuration**: Mainnet + Sepolia testnet
- **RPC Providers**: Multiple providers via RainbowKit

#### Development Tools
- **Package Manager**: npm or yarn
- **Linting**: ESLint
- **Formatting**: Prettier
- **Testing**: Jest + React Testing Library
- **E2E Testing**: Playwright (future)

### Directory Structure
```
services/
└── frontend/
    ├── src/
    │   ├── app/                 # Next.js app router pages
    │   │   ├── layout.tsx        # Root layout with providers
    │   │   ├── page.tsx          # Home/listings page
    │   │   └── listings/
    │   │       └── [name]/
    │   │           └── page.tsx  # Individual listing page
    │   ├── components/
    │   │   ├── listings/
    │   │   │   ├── ListingCard.tsx
    │   │   │   ├── ListingGrid.tsx
    │   │   │   └── ListingDetails.tsx
    │   │   ├── orders/
    │   │   │   ├── OrderBuilder.tsx
    │   │   │   └── OrderSummary.tsx
    │   │   └── wallet/
    │   │       └── ConnectButton.tsx
    │   ├── services/
    │   │   ├── api/
    │   │   │   ├── client.ts     # API client setup
    │   │   │   ├── listings.ts   # Listings API calls
    │   │   │   └── types.ts      # API response types
    │   │   └── seaport/
    │   │       ├── orderBuilder.ts
    │   │       ├── orderValidator.ts
    │   │       └── types.ts
    │   ├── hooks/
    │   │   ├── useListings.ts
    │   │   ├── useSeaportOrder.ts
    │   │   └── useTransactionStatus.ts
    │   ├── lib/
    │   │   ├── constants.ts
    │   │   ├── utils.ts
    │   │   └── wagmi.ts         # Wagmi configuration
    │   └── types/
    │       └── index.ts
    ├── public/
    ├── package.json
    ├── tsconfig.json
    ├── next.config.js
    ├── tailwind.config.js
    └── .env.local
```

## Core Features

### Phase 1: Foundation (Week 1)

#### 1.1 Project Setup
- Initialize Next.js project with TypeScript
- Configure Tailwind CSS
- Set up ESLint and Prettier
- Configure environment variables
- Create basic layout structure

#### 1.2 Wallet Integration
- Install and configure RainbowKit
- Set up wagmi with viem
- Configure supported chains (Mainnet, Sepolia)
- Implement wallet connection UI
- Display connected wallet address and balance
- Handle wallet disconnection

#### 1.3 API Integration
- Create API client with proper error handling
- Implement listings fetch with pagination
- Add response caching with React Query
- Handle API errors gracefully
- Create TypeScript types for API responses

### Phase 2: Listings Display (Week 2)

#### 2.1 Listings Page
- Grid view of active listings
- Listing cards showing:
  - ENS name
  - Price in ETH
  - Seller address (truncated)
  - Time remaining (if applicable)
  - Quick buy button
- Pagination controls
- Basic filtering:
  - Price range
  - Sort options (price, name, date)
- Search functionality

#### 2.2 Listing Details Page
- Full ENS name information
- Price and currency details
- Seller information
- Order data display (formatted JSON)
- Token ID and contract address
- Expiry information
- Buy now button
- Transaction history (if available)

### Phase 3: Seaport Integration (Week 3-4)

#### 3.1 Order Builder Service
```typescript
interface OrderBuilderService {
  // Build order parameters from listing data
  buildOrderParameters(listing: Listing): SeaportOrderParameters;

  // Validate order parameters
  validateOrderParameters(params: SeaportOrderParameters): ValidationResult;

  // Format for contract interaction
  formatForContract(params: SeaportOrderParameters): ContractCallData;
}
```

#### 3.2 Order Components
- Order summary modal showing:
  - Item being purchased
  - Total cost (including fees)
  - Gas estimate
  - Recipient address
- Confirmation dialog
- Transaction status tracking
- Success/failure notifications

#### 3.3 Contract Interaction
- Seaport contract ABI integration
- Order fulfillment function calls
- Gas estimation
- Transaction monitoring
- Error handling for common failures:
  - Insufficient balance
  - Order already fulfilled
  - Order expired
  - Invalid signature

## API Integration Requirements

### Endpoints to Integrate

#### Primary Endpoints
1. `GET /api/v1/listings` - Fetch all active listings
2. `GET /api/v1/listings/name/{name}` - Get specific listing
3. `GET /api/v1/listings/search` - Search listings
4. `GET /api/v1/names/{name}` - Get ENS name details

### API Client Configuration
```typescript
const apiClient = {
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
};
```

### Error Handling
- Network errors
- 404 Not Found
- 429 Rate limiting
- 500 Server errors
- Timeout handling

## Seaport Contract Integration

### Contract Details
```typescript
const SEAPORT_ADDRESS = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const ENS_REGISTRAR = "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85";
```

### Order Structure
```typescript
interface SeaportOrder {
  parameters: {
    offerer: string;
    zone: string;
    offer: OfferItem[];
    consideration: ConsiderationItem[];
    orderType: OrderType;
    startTime: bigint;
    endTime: bigint;
    zoneHash: string;
    salt: string;
    conduitKey: string;
    totalOriginalConsiderationItems: number;
  };
  signature: string;
}
```

### Fulfillment Flow
1. Fetch listing from API
2. Parse order_data JSON
3. Validate order parameters
4. Check order status on-chain
5. Build fulfillment transaction
6. Estimate gas
7. Request user signature
8. Submit transaction
9. Monitor for confirmation
10. Update UI with result

## User Experience Requirements

### Design Principles
- **Simple**: Minimal UI focused on core functionality
- **Clear**: Obvious CTAs and transaction flow
- **Informative**: Display all relevant information
- **Responsive**: Mobile-friendly design
- **Fast**: Optimistic updates and loading states

### Key User Flows

#### Flow 1: Browse and Buy
1. User lands on homepage
2. Views grid of available ENS names
3. Clicks on a listing
4. Reviews details
5. Connects wallet
6. Clicks "Buy Now"
7. Reviews order summary
8. Confirms transaction
9. Waits for confirmation
10. Sees success message

#### Flow 2: Search and Filter
1. User enters search term
2. Results update in real-time
3. Applies price filter
4. Sorts by price
5. Finds desired name
6. Proceeds to purchase

### UI Components

#### Essential Components
- Wallet connection button (RainbowKit)
- Listing card
- Listing grid with pagination
- Search bar
- Filter sidebar
- Order modal
- Transaction status indicator
- Error messages
- Loading states

## Security Considerations

### Frontend Security
- Input validation on all forms
- XSS prevention
- Environment variable protection
- Secure RPC endpoints
- No sensitive data in client code

### Transaction Security
- Clear transaction summaries
- Explicit approval amounts
- Warning for high-value transactions
- Simulation before submission (future)

## Testing Strategy

### Unit Tests
- Utility functions
- Order builder logic
- API response parsing
- Error handling

### Integration Tests
- API client functionality
- Wallet connection flow
- Order creation flow

### E2E Tests (Future)
- Complete purchase flow
- Error scenarios
- Wallet interactions

## Environment Configuration

### Required Environment Variables
```env
# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws

# RPC Configuration
NEXT_PUBLIC_ALCHEMY_ID=your-alchemy-key
NEXT_PUBLIC_INFURA_ID=your-infura-key

# Chain Configuration
NEXT_PUBLIC_CHAIN_ID=1  # 1 for mainnet, 11155111 for sepolia

# Contract Addresses
NEXT_PUBLIC_SEAPORT_ADDRESS=0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC
NEXT_PUBLIC_ENS_REGISTRAR=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85

# Features
NEXT_PUBLIC_ENABLE_TESTNETS=false
```

## Development Milestones

### Milestone 1: Basic Setup (Day 1-2)
- [ ] Initialize Next.js project
- [ ] Configure TypeScript and Tailwind
- [ ] Set up RainbowKit
- [ ] Create basic layout
- [ ] Implement wallet connection

### Milestone 2: API Integration (Day 3-4)
- [ ] Create API client
- [ ] Implement listings fetch
- [ ] Create listing components
- [ ] Add pagination
- [ ] Implement search

### Milestone 3: Listing Display (Day 5-6)
- [ ] Design listing cards
- [ ] Create listing grid
- [ ] Build details page
- [ ] Add filtering
- [ ] Implement sorting

### Milestone 4: Order Building (Day 7-10)
- [ ] Study Seaport documentation
- [ ] Create order builder service
- [ ] Parse stored order data
- [ ] Build order parameters
- [ ] Validate orders

### Milestone 5: Transaction Flow (Day 11-14)
- [ ] Create order modal
- [ ] Implement gas estimation
- [ ] Build transaction UI
- [ ] Handle signatures
- [ ] Submit transactions
- [ ] Monitor confirmation

### Milestone 6: Polish (Day 15-16)
- [ ] Error handling
- [ ] Loading states
- [ ] Success messages
- [ ] Basic tests
- [ ] Documentation

## Future Enhancements

### Phase 2 Features
- Advanced filtering (character count, categories)
- Offer creation UI
- Bulk operations
- Watchlist functionality
- Price history charts
- Gas optimization suggestions
- Transaction simulation
- Multi-wallet support

### Phase 3 Features
- Direct listing creation
- P2P offer negotiation
- Bundle purchases
- Collection statistics
- Analytics dashboard
- Social features
- Mobile app

## Dependencies

### Core Dependencies
```json
{
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@rainbow-me/rainbowkit": "^2.0.0",
    "wagmi": "^2.0.0",
    "viem": "^2.0.0",
    "@tanstack/react-query": "^5.0.0",
    "zustand": "^4.4.0",
    "tailwindcss": "^3.4.0",
    "axios": "^1.6.0",
    "ethers": "^6.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0",
    "eslint": "^8.50.0",
    "prettier": "^3.1.0"
  }
}
```

## Deployment Considerations

### Hosting Options
- **Vercel**: Optimal for Next.js
- **Netlify**: Alternative option
- **Self-hosted**: Docker container

### Performance Requirements
- Initial load < 3s
- API response caching
- Image optimization
- Code splitting
- Lazy loading

### Monitoring
- Error tracking (Sentry)
- Analytics (optional)
- Performance monitoring
- Transaction success rates

## Success Metrics

### Technical Metrics
- Successful wallet connections
- API response times < 500ms
- Transaction success rate > 95%
- Zero critical bugs in POC

### User Metrics
- Time to first transaction
- Transaction completion rate
- Error rate < 1%
- Page load times < 2s

## Risk Mitigation

### Technical Risks
1. **Seaport complexity**: Start with simple orders, add complexity gradually
2. **Gas costs**: Implement clear gas estimates and warnings
3. **API reliability**: Add retry logic and fallbacks
4. **Wallet issues**: Support multiple wallet options

### User Risks
1. **Transaction failures**: Clear error messages and recovery options
2. **High gas fees**: Display estimates prominently
3. **Wrong network**: Auto-switch or clear instructions
4. **Order expiry**: Show countdown timers

## Conclusion

This proof of concept will validate our ability to create a functional ENS marketplace interface that integrates with our backend API and executes transactions through OpenSea's Seaport contract. The modular architecture and clear separation of concerns will enable rapid iteration and scaling to a full-featured marketplace application.

The focus on core functionality—viewing listings and executing purchases—will provide immediate value while establishing patterns for future development. Success will be measured by our ability to complete end-to-end transactions from our UI through to on-chain fulfillment.