# Sign-In With Ethereum (SIWE) Implementation - Product Requirements Document

**Version**: 1.0
**Created**: 2025-10-06
**Status**: Planning
**Owner**: Grails ENS Marketplace

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Goals & Objectives](#goals--objectives)
3. [Technical Architecture](#technical-architecture)
4. [Database Schema](#database-schema)
5. [Authentication Flow](#authentication-flow)
6. [API Endpoints](#api-endpoints)
7. [Frontend Components](#frontend-components)
8. [Security Considerations](#security-considerations)
9. [Implementation Phases](#implementation-phases)
10. [Testing Strategy](#testing-strategy)
11. [Future Enhancements](#future-enhancements)

---

## Executive Summary

This document outlines the implementation of **Sign-In with Ethereum (SIWE)** authentication for the Grails ENS Marketplace. The system will allow users to authenticate using their Ethereum wallet, store user preferences (email, notification settings), and manage a watchlist of ENS names for future notification features.

### Key Features
- 🔐 Wallet-based authentication using SIWE (EIP-4361)
- 👤 User profile management
- 📧 Email storage for notifications
- 👀 ENS name watchlist
- 🔔 Foundation for future notification system
- 🔒 Secure session management

---

## Goals & Objectives

### Primary Goals
1. **User Authentication**: Implement secure, wallet-based authentication
2. **User Profiles**: Allow users to store contact information
3. **Watchlist Management**: Enable users to track ENS names of interest
4. **Future-Ready**: Prepare infrastructure for notifications (email, Telegram, Discord)

### Success Criteria
- Users can sign in with their Ethereum wallet in < 5 seconds
- 100% of SIWE messages pass signature verification
- User sessions persist across browser sessions
- Watchlist operations complete in < 500ms
- Zero unauthorized access to user data

---

## Technical Architecture

### Technology Stack

**Backend**:
- **Framework**: Fastify (existing)
- **Authentication**: SIWE library + viem for signature verification
- **Session Management**: JWT (already configured in shared/config)
- **Database**: PostgreSQL (existing)

**Frontend**:
- **Wallet Integration**: RainbowKit + Wagmi (already integrated)
- **State Management**: TanStack Query (existing)
- **SIWE Client**: siwe library

**Libraries to Add**:
- Backend: `siwe` (npm package for SIWE message parsing and verification)
- Backend: `viem` (already used, will use for ecrecover)
- Frontend: `siwe` (client-side message generation)

### High-Level Architecture

```
┌─────────────────┐
│   Frontend      │
│   (Next.js)     │
│                 │
│  ┌──────────┐   │
│  │ Wallet   │   │  1. Request Nonce
│  │ (wagmi)  │   │  ────────────────▶
│  └──────────┘   │
│                 │  2. Return Nonce
│  ┌──────────┐   │  ◀────────────────
│  │  SIWE    │   │
│  │ Message  │   │  3. Sign Message
│  └──────────┘   │  ────────────────▶
│                 │
└─────────────────┘  4. Verify & Create Session
                     ◀────────────────
         │
         │ JWT Token
         ▼
┌─────────────────┐
│   API Server    │
│   (Fastify)     │
│                 │
│  ┌──────────┐   │
│  │  Auth    │   │
│  │ Routes   │   │
│  └──────────┘   │
│                 │
│  ┌──────────┐   │
│  │  SIWE    │   │
│  │ Verify   │   │
│  └──────────┘   │
│                 │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│   PostgreSQL    │
│                 │
│  - users        │
│  - nonces       │
│  - watchlist    │
└─────────────────┘
```

---

## Database Schema

### 1. `users` Table

Stores authenticated user information.

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) NOT NULL UNIQUE,  -- Ethereum address (checksummed, lowercase)
  email VARCHAR(255),                    -- For email notifications
  telegram VARCHAR(255),                 -- For Telegram notifications (future)
  discord VARCHAR(255),                  -- For Discord notifications (future)
  email_verified BOOLEAN DEFAULT FALSE,  -- Email verification status
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_sign_in TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_address ON users(LOWER(address));
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_created_at ON users(created_at DESC);

-- Comments
COMMENT ON TABLE users IS 'Stores user accounts authenticated via SIWE';
COMMENT ON COLUMN users.address IS 'Ethereum address (stored lowercase for consistency)';
COMMENT ON COLUMN users.email IS 'Email address for notifications (optional)';
COMMENT ON COLUMN users.email_verified IS 'Whether email has been verified via confirmation link';
```

### 2. `nonces` Table

Stores one-time nonces for SIWE authentication to prevent replay attacks.

```sql
CREATE TABLE nonces (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(64) NOT NULL UNIQUE,     -- Random nonce string
  address VARCHAR(42) NOT NULL,          -- Address requesting nonce
  expires_at TIMESTAMP NOT NULL,         -- Expiration time (5 minutes from creation)
  used BOOLEAN DEFAULT FALSE,            -- Whether nonce has been used
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_nonces_nonce ON nonces(nonce) WHERE used = FALSE;
CREATE INDEX idx_nonces_address ON nonces(address);
CREATE INDEX idx_nonces_expires_at ON nonces(expires_at) WHERE used = FALSE;

-- Comments
COMMENT ON TABLE nonces IS 'Stores one-time nonces for SIWE authentication';
COMMENT ON COLUMN nonces.nonce IS 'Random nonce string (min 8 alphanumeric characters)';
COMMENT ON COLUMN nonces.expires_at IS 'Nonce expiration (5 minutes)';
COMMENT ON COLUMN nonces.used IS 'Prevents nonce reuse';

-- Auto-cleanup trigger (delete expired nonces)
CREATE OR REPLACE FUNCTION cleanup_expired_nonces()
RETURNS trigger AS $$
BEGIN
  DELETE FROM nonces WHERE expires_at < NOW() - INTERVAL '1 hour';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_nonces
  AFTER INSERT ON nonces
  EXECUTE FUNCTION cleanup_expired_nonces();
```

### 3. `watchlist` Table

Stores user's ENS name watchlist for notifications.

```sql
CREATE TABLE watchlist (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  notify_on_sale BOOLEAN DEFAULT TRUE,           -- Notify on sales
  notify_on_offer BOOLEAN DEFAULT TRUE,          -- Notify on new offers
  notify_on_listing BOOLEAN DEFAULT TRUE,        -- Notify on new listings
  notify_on_price_change BOOLEAN DEFAULT FALSE,  -- Notify on price changes
  added_at TIMESTAMP DEFAULT NOW(),

  -- Prevent duplicate entries
  UNIQUE(user_id, ens_name_id)
);

-- Indexes
CREATE INDEX idx_watchlist_user_id ON watchlist(user_id);
CREATE INDEX idx_watchlist_ens_name_id ON watchlist(ens_name_id);
CREATE INDEX idx_watchlist_added_at ON watchlist(added_at DESC);

-- Composite index for common query pattern
CREATE INDEX idx_watchlist_user_name ON watchlist(user_id, ens_name_id);

-- Comments
COMMENT ON TABLE watchlist IS 'Stores user watchlists for ENS name notifications';
COMMENT ON COLUMN watchlist.notify_on_sale IS 'Send notification when name is sold';
COMMENT ON COLUMN watchlist.notify_on_offer IS 'Send notification on new offers';
```

### Database Migration Order

1. `create_users_table.sql` - Create users table
2. `create_nonces_table.sql` - Create nonces table with cleanup trigger
3. `create_watchlist_table.sql` - Create watchlist table

---

## Authentication Flow

### 1. Nonce Request Flow

```
┌─────────┐                  ┌─────────┐
│ Frontend│                  │   API   │
└────┬────┘                  └────┬────┘
     │                            │
     │  GET /api/v1/auth/nonce   │
     │  ?address=0x1234...       │
     ├──────────────────────────▶│
     │                            │
     │                            │ Generate random nonce
     │                            │ Store in DB with 5min TTL
     │                            │
     │    { nonce: "abc123..." }  │
     │◀──────────────────────────┤
     │                            │
```

**API Response**:
```json
{
  "nonce": "vQ8bN2mK9pL4xR7w",
  "expiresAt": "2025-10-06T14:05:00.000Z"
}
```

### 2. Sign-In Flow

```
┌─────────┐         ┌─────────┐         ┌─────────┐
│ Frontend│         │ Wallet  │         │   API   │
└────┬────┘         └────┬────┘         └────┬────┘
     │                   │                    │
     │ 1. Get Nonce      │                    │
     ├──────────────────────────────────────▶│
     │                   │                    │
     │ 2. Nonce          │                    │
     │◀──────────────────────────────────────┤
     │                   │                    │
     │ 3. Build SIWE     │                    │
     │    Message        │                    │
     │                   │                    │
     │ 4. Request Sign   │                    │
     ├──────────────────▶│                    │
     │                   │                    │
     │ 5. User Approves  │                    │
     │    in Wallet      │                    │
     │                   │                    │
     │ 6. Signature      │                    │
     │◀──────────────────┤                    │
     │                   │                    │
     │ 7. POST /api/v1/auth/verify            │
     │    { message, signature }              │
     ├──────────────────────────────────────▶│
     │                   │                    │
     │                   │   8. Verify Signature
     │                   │      - Parse SIWE message
     │                   │      - Check nonce validity
     │                   │      - ecrecover address
     │                   │      - Mark nonce as used
     │                   │      - Create/update user
     │                   │      - Generate JWT
     │                   │                    │
     │ 9. JWT Token      │                    │
     │◀──────────────────────────────────────┤
     │                   │                    │
```

**Verify Request**:
```json
{
  "message": "example.com wants you to sign in...",
  "signature": "0xabcdef..."
}
```

**Verify Response**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 123,
    "address": "0x1234...",
    "email": "user@example.com",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

### 3. SIWE Message Format

Following EIP-4361 specification:

```
grails.ethid.org wants you to sign in with your Ethereum account:
0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

Sign in to Grails ENS Marketplace to manage your profile and watchlist.

URI: https://grails.ethid.org
Version: 1
Chain ID: 1
Nonce: vQ8bN2mK9pL4xR7w
Issued At: 2025-10-06T14:00:00.000Z
Expiration Time: 2025-10-06T14:05:00.000Z
```

**Key Components**:
- **Domain**: `grails.ethid.org` (or localhost in dev)
- **Address**: User's Ethereum address (ERC-55 checksummed)
- **Statement**: User-friendly description
- **URI**: Application URL
- **Version**: Always "1"
- **Chain ID**: 1 (Ethereum mainnet)
- **Nonce**: Random 16-character alphanumeric string
- **Issued At**: Current timestamp (RFC 3339)
- **Expiration Time**: 5 minutes from issued at

### 4. Session Management

**JWT Payload**:
```json
{
  "sub": "123",              // User ID
  "address": "0x1234...",    // Ethereum address
  "iat": 1633024800,         // Issued at
  "exp": 1633111200          // Expires at (24 hours)
}
```

**Storage**:
- **Frontend**: Store JWT in `localStorage` or secure cookie
- **Backend**: Stateless JWT validation using shared secret

**Validation Middleware**:
```typescript
// Protect routes that require authentication
fastify.addHook('preHandler', async (request, reply) => {
  const token = request.headers.authorization?.replace('Bearer ', '');
  const decoded = await verifyJWT(token);
  request.user = decoded;
});
```

---

## API Endpoints

### Authentication Endpoints

#### 1. `GET /api/v1/auth/nonce`

**Description**: Request a nonce for SIWE authentication

**Query Parameters**:
- `address` (required): Ethereum address

**Response**:
```json
{
  "nonce": "vQ8bN2mK9pL4xR7w",
  "expiresAt": "2025-10-06T14:05:00.000Z"
}
```

**Logic**:
1. Validate address format (0x + 40 hex chars)
2. Generate random 16-character alphanumeric nonce
3. Store in `nonces` table with 5-minute expiration
4. Return nonce

**Error Cases**:
- 400: Invalid address format
- 500: Database error

---

#### 2. `POST /api/v1/auth/verify`

**Description**: Verify SIWE signature and create session

**Request Body**:
```json
{
  "message": "grails.ethid.org wants you to sign in...",
  "signature": "0xabcdef..."
}
```

**Response**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 123,
    "address": "0x1234...",
    "email": "user@example.com",
    "emailVerified": false,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "lastSignIn": "2025-10-06T14:00:00.000Z"
  }
}
```

**Logic**:
1. Parse SIWE message using `siwe` library
2. Validate message format and required fields
3. Check nonce exists and hasn't expired
4. Verify signature using `viem.verifyMessage()` or ecrecover
5. Ensure recovered address matches message address
6. Mark nonce as used
7. Upsert user record (create if new, update last_sign_in if existing)
8. Generate JWT with user ID and address
9. Return token and user data

**Error Cases**:
- 400: Invalid message format
- 400: Invalid signature
- 401: Signature verification failed
- 401: Nonce expired or already used
- 401: Nonce not found
- 500: Database error

---

#### 3. `GET /api/v1/auth/me`

**Description**: Get current authenticated user

**Headers**:
- `Authorization: Bearer <token>`

**Response**:
```json
{
  "id": 123,
  "address": "0x1234...",
  "email": "user@example.com",
  "emailVerified": false,
  "telegram": null,
  "discord": null,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "lastSignIn": "2025-10-06T14:00:00.000Z"
}
```

**Logic**:
1. Verify JWT from Authorization header
2. Extract user ID from JWT
3. Fetch user from database
4. Return user data

**Error Cases**:
- 401: Missing or invalid token
- 404: User not found

---

#### 4. `POST /api/v1/auth/logout`

**Description**: Logout user (client-side token removal)

**Headers**:
- `Authorization: Bearer <token>`

**Response**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Logic**:
- Since using stateless JWT, logout is primarily client-side
- Could implement token blacklist for enhanced security (future enhancement)
- Update last_activity timestamp

---

### User Profile Endpoints

#### 5. `PATCH /api/v1/users/me`

**Description**: Update current user's profile

**Headers**:
- `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "email": "newemail@example.com",
  "telegram": "@username",
  "discord": "username#1234"
}
```

**Response**:
```json
{
  "success": true,
  "user": {
    "id": 123,
    "address": "0x1234...",
    "email": "newemail@example.com",
    "emailVerified": false,
    "telegram": "@username",
    "discord": "username#1234"
  }
}
```

**Logic**:
1. Verify JWT and extract user ID
2. Validate email format (if provided)
3. Update user record
4. If email changed, set email_verified = false
5. Return updated user data

**Error Cases**:
- 401: Not authenticated
- 400: Invalid email format
- 500: Database error

---

### Watchlist Endpoints

#### 6. `GET /api/v1/watchlist`

**Description**: Get user's watchlist

**Headers**:
- `Authorization: Bearer <token>`

**Query Parameters**:
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)

**Response**:
```json
{
  "success": true,
  "data": {
    "watchlist": [
      {
        "id": 456,
        "userId": 123,
        "ensNameId": 789,
        "ensName": "vitalik.eth",
        "notifyOnSale": true,
        "notifyOnOffer": true,
        "notifyOnListing": true,
        "notifyOnPriceChange": false,
        "addedAt": "2025-10-01T00:00:00.000Z",
        "nameData": {
          "name": "vitalik.eth",
          "tokenId": "...",
          "ownerAddress": "0x...",
          "hasActiveListing": true,
          "listingPrice": "1000000000000000000"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5,
      "totalPages": 1
    }
  }
}
```

---

#### 7. `POST /api/v1/watchlist`

**Description**: Add ENS name to watchlist

**Headers**:
- `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "ensName": "vitalik.eth",
  "notifyOnSale": true,
  "notifyOnOffer": true,
  "notifyOnListing": true,
  "notifyOnPriceChange": false
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": 456,
    "userId": 123,
    "ensNameId": 789,
    "ensName": "vitalik.eth",
    "notifyOnSale": true,
    "addedAt": "2025-10-06T14:00:00.000Z"
  }
}
```

**Logic**:
1. Verify JWT and extract user ID
2. Resolve ENS name to ens_name_id
3. Check if already in watchlist (return existing if duplicate)
4. Insert watchlist entry
5. Return watchlist item

**Error Cases**:
- 401: Not authenticated
- 404: ENS name not found
- 409: Already in watchlist (or return existing)

---

#### 8. `DELETE /api/v1/watchlist/:id`

**Description**: Remove ENS name from watchlist

**Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id`: Watchlist entry ID

**Response**:
```json
{
  "success": true,
  "message": "Removed from watchlist"
}
```

**Logic**:
1. Verify JWT and extract user ID
2. Verify watchlist entry belongs to user
3. Delete entry
4. Return success

**Error Cases**:
- 401: Not authenticated
- 403: Watchlist entry belongs to another user
- 404: Watchlist entry not found

---

#### 9. `PATCH /api/v1/watchlist/:id`

**Description**: Update watchlist notification preferences

**Headers**:
- `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "notifyOnSale": false,
  "notifyOnOffer": true
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": 456,
    "notifyOnSale": false,
    "notifyOnOffer": true,
    "notifyOnListing": true,
    "notifyOnPriceChange": false
  }
}
```

---

## Frontend Components

### 1. Auth Context / Hook

**Purpose**: Manage authentication state globally

**File**: `/hooks/useAuth.ts`

```typescript
interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
  updateProfile: (data: Partial<User>) => Promise<void>;
}

export function useAuth(): AuthContext;
```

**Features**:
- Store JWT in localStorage
- Auto-refresh user data
- Handle sign-in/sign-out
- Provide user state to components

---

### 2. Sign-In Modal

**Purpose**: SIWE authentication flow

**File**: `/components/auth/SignInModal.tsx`

**Features**:
- Connect wallet button (already exists via RainbowKit)
- Request nonce from API
- Build SIWE message
- Request signature from wallet
- Submit to API for verification
- Handle success/error states
- Show loading states

**User Flow**:
1. User clicks "Sign In"
2. Modal opens
3. If not connected, show "Connect Wallet" (RainbowKit)
4. If connected, show "Sign Message" button
5. Click triggers SIWE flow
6. Show signature request in wallet
7. On success, close modal and update auth state
8. On error, show error message

---

### 3. User Profile Page

**Purpose**: Manage user settings and watchlist

**File**: `/app/settings/page.tsx`

**Sections**:

**A. Profile Settings**
- Display connected address
- Email input field
- Telegram input field (disabled/placeholder)
- Discord input field (disabled/placeholder)
- Save button

**B. Watchlist Management**
- Search/add ENS names to watchlist
- List of watched names with:
  - Name display
  - Current price (if listed)
  - Notification toggles
  - Remove button
- Pagination for large lists

**C. Account Actions**
- Sign out button
- Delete account button (future)

---

### 4. Watchlist Components

**File**: `/components/watchlist/WatchlistManager.tsx`

**Features**:
- Add name to watchlist
- Remove name from watchlist
- Toggle notification preferences
- Real-time updates

**File**: `/components/watchlist/AddToWatchlist.tsx`

**Features**:
- Quick add button on name pages
- Shows if already watched
- Optimistic UI updates

---

### 5. Protected Route Wrapper

**File**: `/components/auth/ProtectedRoute.tsx`

**Purpose**: Redirect unauthenticated users

```typescript
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <Loading />;
  if (!isAuthenticated) return <Redirect to="/" />;

  return <>{children}</>;
}
```

---

### 6. Header Updates

**File**: `/components/Header.tsx` (existing, needs update)

**Changes**:
- Show "Sign In" button when not authenticated
- Show user address/ENS when authenticated
- Dropdown menu with:
  - Profile/Settings link
  - Sign Out button

---

## Security Considerations

### 1. Signature Verification

**Implementation**:
```typescript
import { verifyMessage } from 'viem';
import { SiweMessage } from 'siwe';

// Parse SIWE message
const siweMessage = new SiweMessage(message);

// Verify signature
const recoveredAddress = await verifyMessage({
  message: message,
  signature: signature as `0x${string}`,
});

// Ensure recovered address matches message address
if (recoveredAddress.toLowerCase() !== siweMessage.address.toLowerCase()) {
  throw new Error('Signature verification failed');
}
```

**Alternative using ecrecover**:
```typescript
import { recoverMessageAddress } from 'viem';

const recoveredAddress = await recoverMessageAddress({
  message: message,
  signature: signature as `0x${string}`,
});
```

---

### 2. Nonce Management

**Best Practices**:
- Generate cryptographically secure random nonces
- Minimum 16 characters (EIP-4361 requires 8+)
- 5-minute expiration
- Mark as used immediately after verification
- Auto-cleanup expired nonces
- One nonce per address at a time (delete old nonces on new request)

**Implementation**:
```typescript
import crypto from 'crypto';

function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
  // Returns 22-character URL-safe base64 string
}
```

---

### 3. JWT Security

**Best Practices**:
- Use strong secret (min 256 bits)
- Store secret in environment variable
- Short expiration (24 hours)
- Include user ID and address in payload
- Verify on every request
- HTTPS only in production

**JWT Secret Generation**:
```bash
# Generate secure secret
openssl rand -base64 32
```

---

### 4. Input Validation

**All Endpoints**:
- Validate Ethereum addresses (0x + 40 hex chars)
- Validate email format
- Sanitize all string inputs
- Rate limit authentication endpoints
- Prevent SQL injection (use parameterized queries)

**Validation Schema Example**:
```typescript
const UpdateProfileSchema = z.object({
  email: z.string().email().optional(),
  telegram: z.string().max(100).optional(),
  discord: z.string().max(100).optional(),
});
```

---

### 5. CORS & HTTPS

**Configuration**:
- Restrict CORS to known origins
- Require HTTPS in production
- Set secure cookie flags
- Implement CSP headers

---

### 6. Rate Limiting

**Endpoints to Protect**:
- `/auth/nonce`: 10 requests/minute per IP
- `/auth/verify`: 5 requests/minute per IP
- `/auth/me`: 60 requests/minute per user
- `/watchlist/*`: 100 requests/minute per user

---

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Database**:
- [ ] Create migration: `create_users_table.sql`
- [ ] Create migration: `create_nonces_table.sql`
- [ ] Run migrations in production

**Backend - Authentication**:
- [ ] Install `siwe` library
- [ ] Create `/routes/auth.ts`
- [ ] Implement `GET /auth/nonce`
- [ ] Implement `POST /auth/verify`
- [ ] Implement `GET /auth/me`
- [ ] Create JWT middleware for protected routes
- [ ] Add rate limiting to auth endpoints

**Testing**:
- [ ] Test nonce generation and expiration
- [ ] Test signature verification (valid/invalid cases)
- [ ] Test JWT generation and validation
- [ ] Test error cases

---

### Phase 2: Frontend Auth (Week 2)

**Frontend - Authentication**:
- [ ] Install `siwe` library
- [ ] Create `useAuth` hook
- [ ] Create `SignInModal` component
- [ ] Update `Header` component
- [ ] Implement localStorage token storage
- [ ] Add axios interceptor for JWT
- [ ] Test auth flow end-to-end

**Backend - User Management**:
- [ ] Implement `PATCH /users/me`
- [ ] Create email validation
- [ ] Add updated_at trigger to users table

**Testing**:
- [ ] Test sign-in flow
- [ ] Test token refresh
- [ ] Test profile updates
- [ ] Test logout

---

### Phase 3: Watchlist (Week 3)

**Database**:
- [ ] Create migration: `create_watchlist_table.sql`
- [ ] Run migration in production

**Backend - Watchlist**:
- [ ] Create `/routes/watchlist.ts`
- [ ] Implement `GET /watchlist`
- [ ] Implement `POST /watchlist`
- [ ] Implement `DELETE /watchlist/:id`
- [ ] Implement `PATCH /watchlist/:id`
- [ ] Add pagination support
- [ ] Join with ens_names data

**Frontend - Watchlist**:
- [ ] Create `WatchlistManager` component
- [ ] Create `AddToWatchlist` button component
- [ ] Create `/settings` page
- [ ] Add watchlist section to profile
- [ ] Create `useWatchlist` hook
- [ ] Implement optimistic updates

**Testing**:
- [ ] Test add/remove from watchlist
- [ ] Test notification preferences
- [ ] Test pagination
- [ ] Test duplicate prevention

---

### Phase 4: Polish & Deploy (Week 4)

**Security**:
- [ ] Security audit
- [ ] Add comprehensive error handling
- [ ] Implement logging
- [ ] Add monitoring/alerts

**Documentation**:
- [ ] API documentation
- [ ] User guide
- [ ] Admin guide

**Deployment**:
- [ ] Deploy to staging
- [ ] QA testing
- [ ] Deploy to production
- [ ] Monitor for issues

---

## Testing Strategy

### Unit Tests

**Backend**:
- Nonce generation and validation
- SIWE message parsing
- Signature verification
- JWT creation and validation
- Database operations

**Frontend**:
- Auth hook state management
- SIWE message building
- Component rendering
- Form validation

### Integration Tests

**Auth Flow**:
1. Request nonce
2. Sign message
3. Verify signature
4. Receive JWT
5. Make authenticated request
6. Update profile
7. Logout

**Watchlist Flow**:
1. Sign in
2. Add name to watchlist
3. Update notification preferences
4. View watchlist
5. Remove from watchlist

### Security Tests

- [ ] Invalid signature detection
- [ ] Expired nonce rejection
- [ ] Nonce reuse prevention
- [ ] JWT tampering detection
- [ ] Unauthorized access prevention
- [ ] SQL injection attempts
- [ ] XSS attempts
- [ ] CSRF protection

### Performance Tests

- [ ] Auth endpoint response time < 500ms
- [ ] Watchlist operations < 500ms
- [ ] Handle 100 concurrent sign-ins
- [ ] Database query optimization

---

## Future Enhancements

### Notification System (Phase 5)

**Email Notifications**:
- Email verification flow
- Send notifications for watched names:
  - New listing
  - New offer
  - Sale completed
  - Price change
- Email templates
- Unsubscribe links
- Batch notifications (daily digest option)

**Telegram Integration**:
- Telegram bot setup
- Link Telegram account
- Send notifications via bot

**Discord Integration**:
- Discord bot setup
- Link Discord account
- Send notifications via DM or channel

### Enhanced Security

- [ ] 2FA support
- [ ] Session management (revoke tokens)
- [ ] Login history
- [ ] Suspicious activity detection
- [ ] IP whitelisting option

### Social Features

- [ ] Public profiles
- [ ] Follow other users
- [ ] Share watchlists
- [ ] Social activity feed

### Analytics

- [ ] User activity tracking
- [ ] Watchlist analytics
- [ ] Popular names tracking
- [ ] User retention metrics

---

## Technical Decisions & Rationale

### Why SIWE over other auth methods?

1. **Web3 Native**: Aligns with blockchain/ENS ecosystem
2. **No Passwords**: Better UX, no password management
3. **Self-Sovereign**: Users control their identity
4. **Standard**: EIP-4361 is widely adopted
5. **Secure**: Leverages battle-tested crypto

### Why JWT for sessions?

1. **Stateless**: No server-side session storage needed
2. **Scalable**: Works across multiple API servers
3. **Simple**: Already configured in shared config
4. **Performant**: No database lookup per request
5. **Flexible**: Can add claims easily

### Why separate nonces table?

1. **Security**: Prevent replay attacks
2. **Clean**: Auto-cleanup of expired nonces
3. **Auditable**: Track authentication attempts
4. **Scalable**: Can move to Redis later

### Why watchlist vs favorites?

1. **Notification-Ready**: Built for alert system
2. **Granular Control**: Per-name notification settings
3. **Future-Proof**: Can add advanced features
4. **Clear Intent**: "Watch" implies monitoring

---

## Open Questions & Decisions Needed

1. **Email Verification**: Should we verify emails before allowing notifications?
   - **Recommendation**: Yes, send confirmation email with verification link

2. **Watchlist Limit**: Should we limit number of watched names per user?
   - **Recommendation**: Start with 100, can increase later

3. **Token Refresh**: Should we implement refresh tokens?
   - **Recommendation**: Phase 2 enhancement, not MVP

4. **Multi-Device**: How to handle multiple sessions?
   - **Recommendation**: Allow multiple sessions, add session management later

5. **Account Linking**: Should we allow linking multiple addresses to one account?
   - **Recommendation**: Phase 5 enhancement

6. **Data Retention**: How long to keep inactive accounts?
   - **Recommendation**: Never delete, just mark as inactive after 1 year

---

## Success Metrics

### MVP Success Criteria

- [ ] 90%+ of signature verifications succeed
- [ ] Average auth time < 5 seconds
- [ ] Zero security incidents
- [ ] 50+ users sign in within first week
- [ ] Watchlist feature used by 60%+ of authenticated users

### Performance Targets

- Auth endpoints: < 500ms response time (p95)
- Watchlist endpoints: < 300ms response time (p95)
- Zero downtime during deployment
- 99.9% uptime

---

## Appendix

### A. EIP-4361 SIWE Message ABNF Grammar

```abnf
sign-in-with-ethereum =
    domain %s" wants you to sign in with your Ethereum account:" LF
    address LF
    LF
    [ statement LF ]
    LF
    %s"URI: " uri LF
    %s"Version: " version LF
    %s"Chain ID: " chain-id LF
    %s"Nonce: " nonce LF
    %s"Issued At: " issued-at
    [ LF %s"Expiration Time: " expiration-time ]
    [ LF %s"Not Before: " not-before ]
    [ LF %s"Request ID: " request-id ]
    [ LF %s"Resources:"
    resources ]

domain = authority
address = "0x" 40*40HEXDIG
statement = *( reserved / unreserved / " " )
uri = URI
version = "1"
chain-id = 1*DIGIT
nonce = 8*( ALPHA / DIGIT )
issued-at = date-time
expiration-time = date-time
not-before = date-time
request-id = *pchar
resources = *( LF resource )
resource = "- " URI
```

### B. Example SIWE Messages

**Minimal**:
```
grails.ethid.org wants you to sign in with your Ethereum account:
0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

URI: https://grails.ethid.org
Version: 1
Chain ID: 1
Nonce: vQ8bN2mK9pL4xR7w
Issued At: 2025-10-06T14:00:00.000Z
```

**With Statement & Expiration**:
```
grails.ethid.org wants you to sign in with your Ethereum account:
0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

Sign in to Grails ENS Marketplace to manage your profile and watchlist.

URI: https://grails.ethid.org
Version: 1
Chain ID: 1
Nonce: vQ8bN2mK9pL4xR7w
Issued At: 2025-10-06T14:00:00.000Z
Expiration Time: 2025-10-06T14:05:00.000Z
```

### C. Libraries

**Backend**:
- `siwe` - SIWE message parsing and validation
- `viem` - Signature verification and ecrecover
- `jsonwebtoken` - JWT creation and validation

**Frontend**:
- `siwe` - SIWE message generation
- `wagmi` - Wallet connection (already installed)
- `@rainbow-me/rainbowkit` - Wallet UI (already installed)

### D. Environment Variables

Add to `.env`:

```bash
# Authentication
JWT_SECRET=<generate with: openssl rand -base64 32>
JWT_EXPIRES_IN=24h

# SIWE
SIWE_DOMAIN=grails.ethid.org
SIWE_STATEMENT=Sign in to Grails ENS Marketplace to manage your profile and watchlist.
```

---

**End of Document**

---

## Approval & Sign-Off

- [ ] Technical Architecture Approved
- [ ] Security Review Completed
- [ ] Database Schema Approved
- [ ] API Design Approved
- [ ] Frontend Design Approved
- [ ] Ready for Implementation

**Reviewed By**: _________________
**Date**: _________________
**Approved By**: _________________
**Date**: _________________
