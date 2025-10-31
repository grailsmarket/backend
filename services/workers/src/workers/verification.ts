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
