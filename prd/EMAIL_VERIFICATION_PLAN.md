# Email Verification System - Implementation Plan

## Current State Analysis

**Existing Infrastructure:**
- ✅ `users` table with `email` and `email_verified` columns already exists
- ✅ Email service using nodemailer (SMTP) in workers service
- ✅ Notification worker sends emails to users
- ✅ User profile update endpoint (`PATCH /api/v1/users/me`)
- ❌ No verification code/token storage
- ❌ No verification email template
- ❌ No verification endpoint
- ❌ No email_verified check in notification worker

## Architecture Overview

```
User enters email → Send verification email → Click verification link → Update email_verified = true
                                                                             ↓
                                                            Notification worker checks email_verified
```

---

## Implementation Plan

### **Phase 1: Database Schema Updates**

#### 1.1 Create email_verification_tokens table
**File:** `/services/api/migrations/create_email_verification_tokens.sql`

```sql
CREATE TABLE email_verification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,  -- Crypto-random token
  email VARCHAR(255) NOT NULL,         -- Email being verified
  expires_at TIMESTAMP NOT NULL,       -- Tokens expire after 24 hours
  created_at TIMESTAMP DEFAULT NOW(),
  used_at TIMESTAMP                    -- NULL until verified
);

CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token) WHERE used_at IS NULL;
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_expires_at ON email_verification_tokens(expires_at) WHERE used_at IS NULL;

COMMENT ON TABLE email_verification_tokens IS 'Tokens for verifying user email addresses';
COMMENT ON COLUMN email_verification_tokens.token IS 'Cryptographically secure random token (URL-safe)';
COMMENT ON COLUMN email_verification_tokens.used_at IS 'Timestamp when token was used (NULL = unused)';
```

**Migration command:**
```bash
psql -d grails -f services/api/migrations/create_email_verification_tokens.sql
```

---

### **Phase 2: Backend API Updates**

#### 2.1 Update User Profile Endpoint
**File:** `/services/api/src/routes/users.ts`

**Changes needed:**
1. When user updates their email address:
   - Set `email_verified = false`
   - Generate verification token
   - Insert token into `email_verification_tokens` table
   - Publish job to send verification email

**Pseudo-code:**
```typescript
// In PATCH /users/me handler
if (body.email && body.email !== currentUser.email) {
  // Generate crypto-random token
  const token = crypto.randomBytes(32).toString('base64url');

  // Insert token (expires in 24 hours)
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [user.id, token, body.email]
  );

  // Update user email but mark as unverified
  await pool.query(
    `UPDATE users SET email = $1, email_verified = false WHERE id = $2`,
    [body.email, user.id]
  );

  // Publish email job
  await boss.send('send-verification-email', {
    userId: user.id,
    email: body.email,
    token,
  });
}
```

#### 2.2 Create Email Verification Endpoint
**File:** `/services/api/src/routes/verification.ts` (NEW)

```typescript
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';

const VerifyEmailSchema = z.object({
  token: z.string().min(1),
});

export async function verificationRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/verification/email
   * Verify email address using token from verification link
   */
  fastify.post('/email', async (request, reply) => {
    const { token } = VerifyEmailSchema.parse(request.body);

    try {
      // Find unused, non-expired token
      const tokenResult = await pool.query(
        `SELECT id, user_id, email
         FROM email_verification_tokens
         WHERE token = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [token]
      );

      if (tokenResult.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired verification token',
          },
        });
      }

      const { id: tokenId, user_id: userId, email } = tokenResult.rows[0];

      // Update user email_verified
      await pool.query(
        `UPDATE users SET email_verified = true WHERE id = $1 AND email = $2`,
        [userId, email]
      );

      // Mark token as used
      await pool.query(
        `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
        [tokenId]
      );

      const response: APIResponse = {
        success: true,
        data: { message: 'Email verified successfully' },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error verifying email:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'VERIFICATION_FAILED',
          message: 'Failed to verify email',
        },
      });
    }
  });

  /**
   * POST /api/v1/verification/resend
   * Resend verification email (requires auth)
   */
  fastify.post('/resend', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;

    if (!user || !user.email) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'NO_EMAIL',
          message: 'No email address on file',
        },
      });
    }

    if (user.email_verified) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'ALREADY_VERIFIED',
          message: 'Email already verified',
        },
      });
    }

    try {
      // Generate new token
      const token = crypto.randomBytes(32).toString('base64url');

      await pool.query(
        `INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
        [user.id, token, user.email]
      );

      // Publish email job
      const { getQueueClient } = await import('../queue');
      const boss = await getQueueClient();
      await boss.send('send-verification-email', {
        userId: user.id,
        email: user.email,
        token,
      });

      return reply.send({
        success: true,
        data: { message: 'Verification email sent' },
      });
    } catch (error: any) {
      fastify.log.error('Error resending verification:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'RESEND_FAILED',
          message: 'Failed to resend verification email',
        },
      });
    }
  });
}
```

#### 2.3 Register Verification Routes
**File:** `/services/api/src/routes/index.ts`

```typescript
import { verificationRoutes } from './verification';

// In registerRoutes function:
await fastify.register(verificationRoutes, { prefix: '/verification' });
```

---

###  **Phase 3: Worker Updates**

#### 3.1 Add Verification Email Template
**File:** `/services/workers/src/services/email.ts`

```typescript
export function buildEmailVerificationEmail(params: {
  verificationUrl: string;
}): EmailTemplate {
  const { verificationUrl } = params;

  return {
    subject: 'Verify your email address - Grails',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verify Your Email Address</h2>
        <p>Thank you for adding your email address to Grails!</p>
        <p>To receive notifications about your watched ENS names, please verify your email address by clicking the button below:</p>
        <p>
          <a href="${verificationUrl}"
             style="background-color: #7C3AED; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0; font-weight: bold;">
            Verify Email Address
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Or copy and paste this link into your browser:<br>
          <a href="${verificationUrl}" style="color: #7C3AED;">${verificationUrl}</a>
        </p>
        <p style="color: #666; font-size: 14px; margin-top: 30px;">
          This link will expire in 24 hours. If you didn't add this email address to Grails, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `
Verify Your Email Address

Thank you for adding your email address to Grails!

To receive notifications about your watched ENS names, please verify your email address by visiting this link:

${verificationUrl}

This link will expire in 24 hours. If you didn't add this email address to Grails, you can safely ignore this email.
    `.trim(),
  };
}
```

#### 3.2 Create Verification Email Worker
**File:** `/services/workers/src/workers/verification.ts` (NEW)

```typescript
import PgBoss from 'pg-boss';
import { logger } from '../utils/logger';
import { config } from '../../../shared/src';
import { sendEmail, buildEmailVerificationEmail } from '../services/email';

const FRONTEND_URL = config.frontend.url;

export interface SendVerificationEmailJob {
  userId: number;
  email: string;
  token: string;
}

export async function registerVerificationWorker(boss: PgBoss): Promise<void> {
  await boss.work<SendVerificationEmailJob>(
    'send-verification-email',
    {
      teamSize: 3,
      teamConcurrency: 2,
    },
    async (job) => {
      const { userId, email, token } = job.data;

      logger.info({ userId, email }, 'Sending email verification');

      try {
        const verificationUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;

        const emailTemplate = buildEmailVerificationEmail({
          verificationUrl,
        });

        await sendEmail(email, emailTemplate);

        logger.info({ userId, email }, 'Verification email sent successfully');
      } catch (error: any) {
        logger.error({ error, userId, email }, 'Failed to send verification email');
        throw error; // Will be retried by pg-boss
      }
    }
  );

  logger.info('Verification email worker registered');
}
```

#### 3.3 Register Verification Worker
**File:** `/services/workers/src/index.ts`

```typescript
import { registerVerificationWorker } from './workers/verification';

// In main function, after other workers:
await registerVerificationWorker(boss);
```

#### 3.4 Update Notification Worker - Add email_verified Check
**File:** `/services/workers/src/workers/notifications.ts`

**Line 53-64 - Update query to check email_verified:**

```typescript
// Get recipient email if not provided
let recipientEmail = email;
if (!recipientEmail && userId) {
  const userResult = await pool.query(
    'SELECT email, email_verified FROM users WHERE id = $1',  // Add email_verified
    [userId]
  );

  if (userResult.rows.length === 0) {
    logger.warn({ userId }, 'User not found for notification');
    return;
  }

  const user = userResult.rows[0];

  // Check if email is verified
  if (!user.email_verified) {
    logger.info({ userId }, 'User email not verified, skipping notification');
    return;
  }

  recipientEmail = user.email;
}
```

---

### **Phase 4: Frontend Updates**

#### 4.1 Create Email Verification Page
**File:** `/services/frontend/app/verify-email/page.tsx` (NEW)

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError('No verification token provided');
      return;
    }

    const verifyEmail = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/verification/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error?.message || 'Verification failed');
        }

        setStatus('success');

        // Redirect to settings after 3 seconds
        setTimeout(() => {
          router.push('/settings');
        }, 3000);
      } catch (err: any) {
        setStatus('error');
        setError(err.message);
      }
    };

    verifyEmail();
  }, [token, router]);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-lg p-8 max-w-md w-full text-center">
        {status === 'verifying' && (
          <>
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-purple-500 mx-auto mb-4"></div>
            <h2 className="text-2xl font-bold text-white mb-2">Verifying Email</h2>
            <p className="text-gray-400">Please wait...</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Email Verified!</h2>
            <p className="text-gray-400 mb-4">Your email address has been successfully verified.</p>
            <p className="text-sm text-gray-500">Redirecting to settings...</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Verification Failed</h2>
            <p className="text-red-400 mb-6">{error}</p>
            <button
              onClick={() => router.push('/settings')}
              className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg transition"
            >
              Go to Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

#### 4.2 Update Settings Page - Add Email Verification Status
**File:** `/services/frontend/app/settings/page.tsx`

Add display of email verification status and resend button:

```typescript
{user.email && !user.email_verified && (
  <div className="bg-yellow-900/20 border border-yellow-500 rounded-lg p-4 mt-2">
    <p className="text-yellow-400 text-sm mb-2">
      Your email address is not verified. Please check your inbox for a verification link.
    </p>
    <button
      onClick={handleResendVerification}
      className="text-sm text-purple-400 hover:text-purple-300 underline"
    >
      Resend verification email
    </button>
  </div>
)}
```

---

### **Phase 5: Testing & Deployment**

#### 5.1 Testing Checklist

**Unit Tests:**
- [ ] Token generation is cryptographically secure and URL-safe
- [ ] Tokens expire after 24 hours
- [ ] Used tokens cannot be reused
- [ ] Invalid tokens return proper error

**Integration Tests:**
1. **Happy Path:**
   - User updates email → Receives verification email → Clicks link → Email verified

2. **Edge Cases:**
   - Expired token → Shows error
   - Already used token → Shows error
   - Invalid token → Shows error
   - Resend verification → New token generated, old still valid

3. **Notification Filtering:**
   - Unverified email → No notifications sent
   - Verified email → Notifications sent
   - Email changed → Notifications stop until re-verified

**Manual Testing:**
```bash
# 1. Update email
curl -X PATCH http://localhost:3002/api/v1/users/me \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# 2. Check email for verification link

# 3. Verify email
curl -X POST http://localhost:3002/api/v1/verification/email \
  -H "Content-Type: application/json" \
  -d '{"token": "TOKEN_FROM_EMAIL"}'

# 4. Resend verification
curl -X POST http://localhost:3002/api/v1/verification/resend \
  -H "Authorization: Bearer YOUR_JWT"
```

#### 5.2 Deployment Steps

1. **Database Migration:**
   ```bash
   psql -d grails -f services/api/migrations/create_email_verification_tokens.sql
   ```

2. **Deploy Workers Service:**
   ```bash
   cd services/workers
   npm run build
   pm2 restart workers
   ```

3. **Deploy API Service:**
   ```bash
   cd services/api
   npm run build
   pm2 restart api
   ```

4. **Deploy Frontend:**
   ```bash
   cd services/frontend
   npm run build
   pm2 restart frontend
   ```

---

### **Phase 6: Monitoring & Maintenance**

#### 6.1 Monitoring Queries

**Check pending verifications:**
```sql
SELECT COUNT(*) as pending_verifications
FROM email_verification_tokens
WHERE used_at IS NULL AND expires_at > NOW();
```

**Check verification success rate:**
```sql
SELECT
  COUNT(*) FILTER (WHERE used_at IS NOT NULL) as verified,
  COUNT(*) FILTER (WHERE used_at IS NULL AND expires_at < NOW()) as expired,
  COUNT(*) FILTER (WHERE used_at IS NULL AND expires_at > NOW()) as pending
FROM email_verification_tokens
WHERE created_at > NOW() - INTERVAL '7 days';
```

**Users with unverified emails:**
```sql
SELECT COUNT(*) as unverified_users
FROM users
WHERE email IS NOT NULL AND email_verified = FALSE;
```

#### 6.2 Cleanup Job (Optional)

Create periodic job to delete old expired tokens:

```sql
DELETE FROM email_verification_tokens
WHERE expires_at < NOW() - INTERVAL '7 days';
```

---

### **Security Considerations**

1. **Token Security:**
   - Use crypto.randomBytes (not Math.random)
   - Minimum 32 bytes (256 bits of entropy)
   - URL-safe encoding (base64url)
   - Single-use only
   - 24-hour expiration

2. **Rate Limiting:**
   - Limit resend requests (1 per 5 minutes per user)
   - Limit verification attempts (10 per hour per IP)

3. **Email Privacy:**
   - Don't reveal if email exists in system on verification failure
   - Log verification attempts for security monitoring

4. **Data Protection:**
   - Store verification tokens hashed (optional but recommended)
   - Don't log email addresses in plaintext

---

### **Summary of Changes**

| Component | Files Added/Modified | Lines of Code (Est.) |
|-----------|---------------------|---------------------|
| **Database** | 1 migration | 20 |
| **API Routes** | 2 files (1 new, 1 modified) | 150 |
| **Workers** | 2 files (1 new, 1 modified) | 100 |
| **Frontend** | 2 files (1 new, 1 modified) | 150 |
| **Tests** | 3 test files (new) | 200 |
| **Total** | 10 files | ~620 lines |

**Estimated Implementation Time:** 1-2 days

---

## Conclusion

This implementation plan provides a complete, production-ready email verification system that integrates seamlessly with the existing notification infrastructure. The system ensures that users can only receive email notifications after verifying their email address, protecting both the platform and users from spam and abuse.

Key benefits:
- ✅ Secure token-based verification
- ✅ Seamless integration with existing notification system
- ✅ User-friendly verification flow
- ✅ Comprehensive error handling
- ✅ Production-ready monitoring and maintenance tools
