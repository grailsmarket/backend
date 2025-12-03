import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

export type ActivityEventType =
  | 'listed'
  | 'listing_updated'
  | 'offer_made'
  | 'bought'
  | 'sold'
  | 'offer_accepted'
  | 'listing_cancelled'
  | 'offer_cancelled'
  | 'cancelled' // Deprecated - kept for backwards compatibility
  | 'mint'
  | 'burn'
  | 'sent'
  | 'received';

interface ActivityHistoryParams {
  ens_name_id: number;
  event_type: ActivityEventType;
  actor_address: string;
  counterparty_address?: string;
  platform: string;
  chain_id?: number;
  price_wei?: string;
  currency_address?: string;
  transaction_hash?: string;
  block_number?: number;
  metadata?: Record<string, any>;
  event_date?: Date; // Blockchain timestamp of the event (defaults to NOW() if not provided)
}

export class ActivityHistoryService {
  private pool = getPostgresPool();
  private client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  /**
   * Create a new activity history record
   */
  async createActivityRecord(params: ActivityHistoryParams): Promise<void> {
    const {
      ens_name_id,
      event_type,
      actor_address,
      counterparty_address,
      platform,
      chain_id = 1,
      price_wei,
      currency_address,
      transaction_hash,
      block_number,
      metadata = {},
      event_date,
    } = params;

    try {
      // For blockchain events (with transaction_hash and block_number),
      // check if this event already exists to prevent duplicates
      if (transaction_hash && block_number) {
        const existingEvent = await this.pool.query(
          `SELECT id FROM activity_history
           WHERE ens_name_id = $1
             AND event_type = $2
             AND transaction_hash = $3
             AND block_number = $4
             AND actor_address = $5
           LIMIT 1`,
          [ens_name_id, event_type, transaction_hash, block_number, actor_address]
        );

        if (existingEvent.rows.length > 0) {
          logger.debug(
            `Skipping duplicate activity record: ${event_type} for ENS name ID ${ens_name_id}, tx ${transaction_hash}`
          );
          return;
        }
      }

      // For non-blockchain events (listings, offers), check for duplicates based on metadata
      // to prevent duplicate activity records from WAL trigger re-execution
      if (!transaction_hash && !block_number) {
        const listingId = metadata?.listing_id;
        const offerId = metadata?.offer_id;

        // For listing/offer events, check if we already have a recent record with same ID
        if (listingId || offerId) {
          const duplicateCheck = await this.pool.query(
            `SELECT id FROM activity_history
             WHERE ens_name_id = $1
               AND event_type = $2
               AND actor_address = $3
               AND (
                 (metadata->>'listing_id')::integer = $4
                 OR (metadata->>'offer_id')::integer = $5
               )
               AND created_at > NOW() - INTERVAL '1 minute'
             LIMIT 1`,
            [ens_name_id, event_type, actor_address, listingId || null, offerId || null]
          );

          if (duplicateCheck.rows.length > 0) {
            logger.debug(
              `Skipping duplicate activity record: ${event_type} for ENS name ID ${ens_name_id}, listing_id ${listingId}, offer_id ${offerId}`
            );
            return;
          }
        }
      }

      const result = await this.pool.query(
        `INSERT INTO activity_history (
          ens_name_id,
          event_type,
          actor_address,
          counterparty_address,
          platform,
          chain_id,
          price_wei,
          currency_address,
          transaction_hash,
          block_number,
          metadata,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id`,
        [
          ens_name_id,
          event_type,
          actor_address,
          counterparty_address || null,
          platform,
          chain_id,
          price_wei || null,
          currency_address || null,
          transaction_hash || null,
          block_number || null,
          JSON.stringify(metadata),
          event_date || new Date(),
        ]
      );

      logger.debug(`Created activity history: ${event_type} for ENS name ID ${ens_name_id}`);

      // Emit PostgreSQL notification for real-time WebSocket broadcasts
      const activityId = result.rows[0].id;
      await this.pool.query(
        `SELECT pg_notify('activity_created', $1)`,
        [JSON.stringify({ activity_id: activityId })]
      );
    } catch (error) {
      logger.error('Failed to create activity history record:', error);
      throw error;
    }
  }

  /**
   * Create dual buy/sell records for a sale transaction
   */
  async createSaleRecords(params: {
    ens_name_id: number;
    buyer_address: string;
    seller_address: string;
    platform: string;
    chain_id?: number;
    price_wei: string;
    currency_address: string;
    transaction_hash?: string;
    block_number?: number;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const {
      ens_name_id,
      buyer_address,
      seller_address,
      platform,
      chain_id = 1,
      price_wei,
      currency_address,
      transaction_hash,
      block_number,
      metadata = {},
    } = params;

    // Create 'bought' record for buyer
    await this.createActivityRecord({
      ens_name_id,
      event_type: 'bought',
      actor_address: buyer_address,
      counterparty_address: seller_address,
      platform,
      chain_id,
      price_wei,
      currency_address,
      transaction_hash,
      block_number,
      metadata: { ...metadata, role: 'buyer' },
    });

    // Create 'sold' record for seller
    await this.createActivityRecord({
      ens_name_id,
      event_type: 'sold',
      actor_address: seller_address,
      counterparty_address: buyer_address,
      platform,
      chain_id,
      price_wei,
      currency_address,
      transaction_hash,
      block_number,
      metadata: { ...metadata, role: 'seller' },
    });

    logger.info(`Created buy/sell activity records for ENS name ID ${ens_name_id}`);
  }

  /**
   * Handle new listing creation
   */
  async handleListingCreated(listing: any): Promise<void> {
    if (!listing.ens_name_id || !listing.seller_address) {
      logger.warn('Missing required fields for listing created event');
      return;
    }

    await this.createActivityRecord({
      ens_name_id: listing.ens_name_id,
      event_type: 'listed',
      actor_address: listing.seller_address,
      platform: listing.source || 'grails',
      price_wei: listing.price_wei,
      currency_address: listing.currency_address,
      metadata: {
        listing_id: listing.id,
        order_hash: listing.order_hash,
      },
    });
  }

  /**
   * Handle listing price update
   */
  async handleListingUpdated(oldListing: any, newListing: any): Promise<void> {
    if (!newListing.ens_name_id || !newListing.seller_address) {
      logger.warn('Missing required fields for listing updated event');
      return;
    }

    // Only create activity if price changed
    if (oldListing.price_wei !== newListing.price_wei) {
      await this.createActivityRecord({
        ens_name_id: newListing.ens_name_id,
        event_type: 'listing_updated',
        actor_address: newListing.seller_address,
        platform: newListing.source || 'grails',
        price_wei: newListing.price_wei,
        currency_address: newListing.currency_address,
        metadata: {
          listing_id: newListing.id,
          old_price_wei: oldListing.price_wei,
          new_price_wei: newListing.price_wei,
        },
      });
    }
  }

  /**
   * Handle listing cancellation
   */
  async handleListingCancelled(listing: any): Promise<void> {
    if (!listing.ens_name_id || !listing.seller_address) {
      logger.warn('Missing required fields for listing cancelled event');
      return;
    }

    await this.createActivityRecord({
      ens_name_id: listing.ens_name_id,
      event_type: 'listing_cancelled',
      actor_address: listing.seller_address,
      platform: listing.source || 'grails',
      price_wei: listing.price_wei,
      currency_address: listing.currency_address,
      metadata: {
        listing_id: listing.id,
        cancelled_type: 'listing',
      },
    });
  }

  /**
   * Handle new offer creation
   */
  async handleOfferCreated(offer: any): Promise<void> {
    if (!offer.ens_name_id || !offer.buyer_address) {
      logger.warn('Missing required fields for offer created event');
      return;
    }

    await this.createActivityRecord({
      ens_name_id: offer.ens_name_id,
      event_type: 'offer_made',
      actor_address: offer.buyer_address,
      platform: offer.source || 'grails',
      price_wei: offer.offer_amount_wei,
      currency_address: offer.currency_address,
      metadata: {
        offer_id: offer.id,
      },
    });
  }

  /**
   * Handle offer acceptance (creates buy/sell records)
   */
  async handleOfferAccepted(offer: any, seller_address: string): Promise<void> {
    if (!offer.ens_name_id || !offer.buyer_address) {
      logger.warn('Missing required fields for offer accepted event');
      return;
    }

    // Create the offer_accepted record
    await this.createActivityRecord({
      ens_name_id: offer.ens_name_id,
      event_type: 'offer_accepted',
      actor_address: seller_address,
      counterparty_address: offer.buyer_address,
      platform: offer.source || 'grails',
      price_wei: offer.offer_amount_wei,
      currency_address: offer.currency_address,
      metadata: {
        offer_id: offer.id,
      },
    });

    // Create buy/sell records
    await this.createSaleRecords({
      ens_name_id: offer.ens_name_id,
      buyer_address: offer.buyer_address,
      seller_address: seller_address,
      platform: offer.source || 'grails',
      price_wei: offer.offer_amount_wei,
      currency_address: offer.currency_address,
      metadata: {
        offer_id: offer.id,
        sale_type: 'offer_accepted',
      },
    });
  }

  /**
   * Handle listing fulfillment (direct purchase - creates buy/sell records)
   */
  async handleListingFulfilled(listing: any, buyer_address: string, transaction_hash?: string): Promise<void> {
    if (!listing.ens_name_id || !listing.seller_address) {
      logger.warn('Missing required fields for listing fulfilled event');
      return;
    }

    await this.createSaleRecords({
      ens_name_id: listing.ens_name_id,
      buyer_address: buyer_address,
      seller_address: listing.seller_address,
      platform: listing.source || 'grails',
      price_wei: listing.price_wei,
      currency_address: listing.currency_address,
      transaction_hash,
      metadata: {
        listing_id: listing.id,
        sale_type: 'listing_fulfilled',
      },
    });
  }

  /**
   * Handle offer cancellation
   */
  async handleOfferCancelled(offer: any): Promise<void> {
    if (!offer.ens_name_id || !offer.buyer_address) {
      logger.warn('Missing required fields for offer cancelled event');
      return;
    }

    await this.createActivityRecord({
      ens_name_id: offer.ens_name_id,
      event_type: 'offer_cancelled',
      actor_address: offer.buyer_address,
      platform: offer.source || 'grails',
      price_wei: offer.offer_amount_wei,
      currency_address: offer.currency_address,
      metadata: {
        offer_id: offer.id,
        cancelled_type: 'offer',
      },
    });
  }

  /**
   * Handle ENS name minting (transfer from zero address)
   */
  async handleMint(params: {
    ens_name_id: number;
    recipient_address: string;
    token_id: string;
    transaction_hash?: string;
    block_number?: number;
  }): Promise<void> {
    const { ens_name_id, recipient_address, token_id, transaction_hash, block_number } = params;

    await this.createActivityRecord({
      ens_name_id,
      event_type: 'mint',
      actor_address: recipient_address,
      platform: 'blockchain',
      transaction_hash,
      block_number,
      metadata: {
        token_id,
        from_address: '0x0000000000000000000000000000000000000000',
      },
    });

    logger.info(`Created mint activity record for ENS name ID ${ens_name_id}`);
  }

  /**
   * Handle ENS name burning (transfer to zero address)
   */
  async handleBurn(params: {
    ens_name_id: number;
    sender_address: string;
    token_id: string;
    transaction_hash?: string;
    block_number?: number;
  }): Promise<void> {
    const { ens_name_id, sender_address, token_id, transaction_hash, block_number } = params;

    // Fetch block timestamp if block_number is provided
    let event_date: Date | undefined;
    if (block_number) {
      try {
        const block = await this.client.getBlock({ blockNumber: BigInt(block_number) });
        event_date = new Date(Number(block.timestamp) * 1000);
        logger.debug(`Fetched block timestamp for burn event: ${event_date.toISOString()}`);
      } catch (error: any) {
        logger.error(`Failed to fetch block ${block_number} timestamp:`, error.message);
        // Continue without event_date, will default to NOW()
      }
    }

    await this.createActivityRecord({
      ens_name_id,
      event_type: 'burn',
      actor_address: sender_address,
      platform: 'blockchain',
      transaction_hash,
      block_number,
      metadata: {
        token_id,
        to_address: '0x0000000000000000000000000000000000000000',
      },
      event_date,
    });

    logger.info(`Created burn activity record for ENS name ID ${ens_name_id}`);
  }

  /**
   * Handle ENS name transfer (creates both sent and received records)
   */
  async handleTransfer(params: {
    ens_name_id: number;
    from_address: string;
    to_address: string;
    token_id: string;
    transaction_hash?: string;
    block_number?: number;
  }): Promise<void> {
    const { ens_name_id, from_address, to_address, token_id, transaction_hash, block_number } = params;

    // Fetch block timestamp if block_number is provided
    let event_date: Date | undefined;
    if (block_number) {
      try {
        const block = await this.client.getBlock({ blockNumber: BigInt(block_number) });
        event_date = new Date(Number(block.timestamp) * 1000);
        logger.debug(`Fetched block timestamp for transfer event: ${event_date.toISOString()}`);
      } catch (error: any) {
        logger.error(`Failed to fetch block ${block_number} timestamp:`, error.message);
        // Continue without event_date, will default to NOW()
      }
    }

    // Create 'sent' record for sender
    await this.createActivityRecord({
      ens_name_id,
      event_type: 'sent',
      actor_address: from_address,
      counterparty_address: to_address,
      platform: 'blockchain',
      transaction_hash,
      block_number,
      metadata: {
        token_id,
        role: 'sender',
      },
      event_date,
    });

    // Create 'received' record for recipient
    await this.createActivityRecord({
      ens_name_id,
      event_type: 'received',
      actor_address: to_address,
      counterparty_address: from_address,
      platform: 'blockchain',
      transaction_hash,
      block_number,
      metadata: {
        token_id,
        role: 'recipient',
      },
      event_date,
    });

    logger.info(`Created transfer activity records for ENS name ID ${ens_name_id} from ${from_address} to ${to_address}`);
  }
}
