# Grails Frontend

Next.js 14 application for the Grails ENS marketplace, featuring wallet connection, advanced search, watchlists, and Seaport 1.6 integration for purchases.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.local.example .env.local
# Edit .env.local with your settings

# Start development server
npm run dev
```

Visit http://localhost:3000

## What This App Provides

- **Marketplace Browsing**: Search and filter ENS names with advanced criteria
- **Wallet Connection**: RainbowKit integration (MetaMask, Rainbow, WalletConnect, Coinbase)
- **Authentication**: Sign-In With Ethereum (SIWE) for protected features
- **Watchlists**: Track ENS names with customizable notification preferences
- **Notifications**: Real-time alerts for watched names
- **User Profiles**: View ENS records and owned names for any address
- **Clubs**: Browse and join ENS name clubs (10k Club, 999 Club, etc.)
- **Voting**: Upvote/downvote ENS names
- **Sales History**: View sales analytics for any name
- **Activity Feed**: Track marketplace activity
- **Purchasing**: Buy ENS names via Seaport 1.6 protocol

## Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Web3**: RainbowKit + wagmi v2 + viem
- **State**: TanStack Query (React Query) + Zustand
- **Smart Contracts**: Seaport 1.6 protocol

## Project Structure

```
frontend/
├── app/                    # Pages (Next.js App Router)
│   ├── page.tsx           # Homepage (marketplace)
│   ├── names/[name]/      # ENS name detail pages
│   ├── watchlist/         # User watchlist
│   ├── notifications/     # User notifications
│   ├── profile/[address]/ # User profiles
│   ├── clubs/             # Club pages
│   └── settings/          # User settings
├── components/            # React components
│   ├── auth/             # SIWE authentication
│   ├── listings/         # Listing cards/tables
│   ├── offers/           # Offer components
│   ├── orders/           # Seaport order modals
│   ├── watchlist/        # Watchlist management
│   ├── notifications/    # Notification bell & list
│   ├── search/           # Search panel with filters
│   └── ui/               # Shared UI components
├── hooks/                 # Custom React hooks
│   ├── useAuth.ts        # Authentication state
│   ├── useWatchlist.ts   # Watchlist operations
│   ├── useNotifications.ts
│   └── useSearch.ts      # Search with filters
├── services/             # API clients
└── types/                # TypeScript types
```

## Environment Variables

```env
# Required
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id

# Optional
NEXT_PUBLIC_CHAIN_ID=1  # 1 for mainnet, 11155111 for sepolia
```

## Key Features Explained

### Advanced Search & Filters
- Price range (min/max in ETH)
- Name length filters
- Character filters (numbers, emoji)
- Club membership
- Expiration status (grace period, premium period)
- Sales history filters

### Watchlist System
- Add any ENS name to watchlist
- Granular notification preferences per name:
  - New listings
  - Price changes
  - Sales
  - New offers
- Search and filter your watchlist

### Seaport 1.6 Integration
- Purchase ENS names listed on OpenSea
- Efficient gas usage with `fulfillBasicOrder_efficient_6GL6yc`
- Real-time order validation
- Transaction status tracking

### Authentication Flow
1. User clicks "Sign In With Ethereum"
2. Connects wallet via RainbowKit
3. Signs EIP-4361 message
4. Receives JWT token (stored in Zustand)
5. Token persists across sessions (localStorage)

## Development

```bash
npm run dev        # Start dev server (:3000)
npm run build      # Build for production
npm start          # Run production build
npm run lint       # ESLint
npm run typecheck  # TypeScript validation
```

## Common Issues

### Wallet Not Connecting
- Check `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set
- Clear browser cache and try again
- Ensure MetaMask/wallet is unlocked

### Authentication Issues
- Check API is running on correct URL
- Verify JWT token in localStorage hasn't expired (7 days)
- Try signing out and back in

### Search Not Working
- Verify API is running
- Check Elasticsearch is synced (via WAL Listener)
- Check browser console for API errors

### Transaction Failures
- Ensure wallet has sufficient ETH for gas + purchase
- Verify listing hasn't expired
- Check Seaport contract address is correct

## Documentation

- **Component Architecture**: See `CLAUDE.md` in this directory
- **API Integration**: See `/services/api/README.md`
- **Seaport Protocol**: See `components/orders/OrderModal.tsx`