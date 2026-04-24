import { Bot } from 'grammy';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const FRONTEND_URL = config.frontend.url;

let bot: Bot | null = null;

/**
 * Initialize the Telegram bot with /start and /reg command handlers.
 * The bot runs via long polling inside the workers service.
 */
export async function initTelegramBot(): Promise<void> {
  if (!config.telegram.botToken || !config.telegram.enabled) {
    logger.warn('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
    return;
  }

  bot = new Bot(config.telegram.botToken);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Welcome to the Grails ENS Marketplace bot!\n\n' +
      'To connect your account, use: /reg <your-verification-code>\n\n' +
      'You can get a verification code from your Grails settings page.'
    );
  });

  bot.command('reg', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply('Usage: /reg <verification-code>');
      return;
    }

    const chatId = ctx.chat.id;
    const pool = getPostgresPool();

    try {
      const result = await pool.query(
        `SELECT id, user_id, telegram_username
         FROM telegram_verification_codes
         WHERE code = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [code]
      );

      if (result.rows.length === 0) {
        await ctx.reply('Invalid or expired verification code. Please generate a new one from your Grails settings.');
        return;
      }

      const { id: codeId, user_id: userId } = result.rows[0];

      await pool.query(
        `UPDATE users SET telegram_connected = TRUE, telegram_chat_id = $1 WHERE id = $2`,
        [chatId, userId]
      );

      await pool.query(
        `UPDATE telegram_verification_codes SET used_at = NOW() WHERE id = $1`,
        [codeId]
      );

      await ctx.reply('Your Telegram account is now connected to Grails! You will receive marketplace notifications here.');
      logger.info({ userId, chatId }, 'Telegram account connected');
    } catch (error) {
      logger.error({ error, chatId, code }, 'Error processing /reg command');
      await ctx.reply('Something went wrong. Please try again later.');
    }
  });

  // Start long polling (non-blocking)
  bot.start({
    onStart: () => logger.info('Telegram bot started (long polling)'),
  });
}

/**
 * Gracefully stop the Telegram bot.
 */
export async function stopTelegramBot(): Promise<void> {
  if (bot) {
    bot.stop();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

// -------------------------------------------------------------------
// Message sending
// -------------------------------------------------------------------

export interface TelegramMessage {
  chatId: number;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}

/**
 * Send a Telegram notification message to a user.
 */
export async function sendTelegramMessage(msg: TelegramMessage): Promise<void> {
  if (!bot) {
    logger.warn('Telegram bot not initialized, skipping message');
    return;
  }

  await bot.api.sendMessage(msg.chatId, msg.text, {
    parse_mode: msg.parseMode || 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// -------------------------------------------------------------------
// Notification message builders (parallel to email.ts templates)
// -------------------------------------------------------------------

export function buildNewListingTelegram(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
}): string {
  return (
    `<b>New Listing</b>\n\n` +
    `<b>${escapeHtml(params.ensName)}</b> has been listed for <b>${params.priceEth} ETH</b>.\n\n` +
    `<a href="${params.listingUrl}">View Listing</a>`
  );
}

export function buildPriceChangeTelegram(params: {
  ensName: string;
  oldPriceEth: string;
  newPriceEth: string;
  listingUrl: string;
}): string {
  const direction = parseFloat(params.newPriceEth) < parseFloat(params.oldPriceEth) ? 'decreased' : 'increased';
  return (
    `<b>Price Change</b>\n\n` +
    `The price for <b>${escapeHtml(params.ensName)}</b> has ${direction}.\n\n` +
    `Old Price: ${params.oldPriceEth} ETH\n` +
    `New Price: <b>${params.newPriceEth} ETH</b>\n\n` +
    `<a href="${params.listingUrl}">View Listing</a>`
  );
}

export function buildSaleTelegram(params: {
  ensName: string;
  priceEth: string;
  listingUrl: string;
}): string {
  return (
    `<b>ENS Name Sold</b>\n\n` +
    `<b>${escapeHtml(params.ensName)}</b> has been sold for <b>${params.priceEth} ETH</b>.\n\n` +
    `<a href="${params.listingUrl}">View Details</a>`
  );
}

export function buildNewOfferTelegram(params: {
  ensName: string;
  priceEth: string;
  offerUrl: string;
}): string {
  return (
    `<b>New Offer</b>\n\n` +
    `A new offer has been made on <b>${escapeHtml(params.ensName)}</b> for <b>${params.priceEth} ETH</b>.\n\n` +
    `<a href="${params.offerUrl}">View Offer</a>`
  );
}

export function buildOfferReceivedTelegram(params: {
  ensName: string;
  priceEth: string;
  offerUrl: string;
}): string {
  return (
    `<b>Offer Received!</b>\n\n` +
    `Someone made an offer on your ENS name <b>${escapeHtml(params.ensName)}</b> for <b>${params.priceEth} ETH</b>.\n\n` +
    `<a href="${params.offerUrl}">View Offer</a>`
  );
}

export function buildListingSoldTelegram(params: {
  ensName: string;
  priceEth: string;
  saleUrl: string;
}): string {
  return (
    `<b>Your Listing Was Sold!</b>\n\n` +
    `Your listing for <b>${escapeHtml(params.ensName)}</b> has been sold for <b>${params.priceEth} ETH</b>.\n\n` +
    `<a href="${params.saleUrl}">View Sale Details</a>`
  );
}

export function buildListingCancelledTelegram(params: {
  ensName: string;
  listingUrl: string;
}): string {
  return (
    `<b>Listing Cancelled</b>\n\n` +
    `The listing for <b>${escapeHtml(params.ensName)}</b> has been cancelled due to an ownership change.\n\n` +
    `<a href="${params.listingUrl}">View Details</a>`
  );
}

/**
 * Build a Telegram notification message for the given notification type.
 * Returns the message text or null if the type is unknown.
 */
export function buildTelegramNotification(
  type: string,
  ensName: string,
  metadata: Record<string, any> | undefined,
  formatEther: (wei: string) => string,
): string | null {
  switch (type) {
    case 'new-listing': {
      const priceEth = formatEther(metadata?.priceWei || '0');
      return buildNewListingTelegram({
        ensName,
        priceEth,
        listingUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'price-change': {
      const oldPriceEth = formatEther(metadata?.oldPriceWei || '0');
      const newPriceEth = formatEther(metadata?.newPriceWei || '0');
      return buildPriceChangeTelegram({
        ensName,
        oldPriceEth,
        newPriceEth,
        listingUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'sale': {
      const priceEth = formatEther(metadata?.priceWei || '0');
      return buildSaleTelegram({
        ensName,
        priceEth,
        listingUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'new-offer': {
      const priceEth = formatEther(metadata?.offerAmountWei || '0');
      return buildNewOfferTelegram({
        ensName,
        priceEth,
        offerUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'offer-received': {
      const priceEth = formatEther(metadata?.offerAmountWei || '0');
      return buildOfferReceivedTelegram({
        ensName,
        priceEth,
        offerUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'listing-sold': {
      const priceEth = formatEther(metadata?.priceWei || '0');
      return buildListingSoldTelegram({
        ensName,
        priceEth,
        saleUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    case 'listing-cancelled-ownership-change': {
      return buildListingCancelledTelegram({
        ensName,
        listingUrl: `${FRONTEND_URL}/${ensName}`,
      });
    }
    default:
      return null;
  }
}

export function buildAdminBroadcastTelegram(params: {
  title: string;
  body: string;
  linkUrl?: string;
}): string {
  const header = `<b>${escapeHtml(params.title)}</b>`;
  const body = escapeHtml(params.body);
  const link = params.linkUrl ? `\n\n<a href="${escapeHtml(params.linkUrl)}">Learn more</a>` : '';
  return `${header}\n\n${body}${link}`;
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
