# ENS Marketplace Frontend

A proof-of-concept frontend for the ENS marketplace, built with Next.js, TypeScript, and RainbowKit.

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.local.example .env.local
# Edit .env.local with your settings
```

3. Start development server:
```bash
npm run dev
```

Visit http://localhost:3000

## Tech Stack

- Next.js 14 with App Router
- TypeScript
- Tailwind CSS
- RainbowKit + wagmi + viem
- TanStack Query

## Project Structure

```
frontend/
├── app/                 # Pages and routing
├── components/          # React components
├── services/           # API and Seaport logic
├── hooks/              # Custom hooks
├── lib/                # Utilities
└── types/              # TypeScript types
```

## Environment Variables

- `NEXT_PUBLIC_API_URL`: Backend API URL (default: http://localhost:3002)
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`: WalletConnect project ID

## Features

- Browse ENS listings
- Connect Ethereum wallet
- View listing details
- Purchase ENS names via Seaport

## Development

```bash
npm run dev    # Start dev server
npm run build  # Build for production
npm start      # Run production build
```