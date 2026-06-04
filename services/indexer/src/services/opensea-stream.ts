import WebSocket from 'ws';
import { config, getPostgresPool, createSale, isEthOrWeth, safeNormalize, isPlaceholderName } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';
import { safePublishJob, QUEUE_NAMES } from '../queue';

// Name Wrapper contract address - never store this as owner
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

interface PhoenixMessage {
  // OpenSea occasionally sends messages without a topic (e.g. control/keepalive
  // frames), so this is optional and must be guarded before use.
  topic?: string;
  event: string;
  payload: any;
  ref: number;
}

interface OpenSeaEvent {
  event_type: string;
  payload: any;
  sent_at: string;
  event_timestamp: number;
}

export class OpenSeaStreamListener {
  private ws: WebSocket | null = null;
  private pool = getPostgresPool();
  private resolver = new ENSResolver();
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectInterval = 5000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private ref = 0;

  // Event deduplication cache - tracks recently processed events
  private processedEvents: Map<string, number> = new Map();
  private readonly EVENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private dedupeCleanupInterval: NodeJS.Timeout | null = null;

  // Reconnection catch-up tracking
  private lastEventTimestamp: Date | null = null;
  private disconnectedAt: Date | null = null;
  private readonly CATCHUP_WINDOW_MS = 10 * 60 * 1000; // Max 10 minutes to catch up

  async start() {
    if (!config.opensea.apiKey) {
      logger.warn('OpenSea API key not configured, skipping stream listener');
      return;
    }

    logger.info('Starting OpenSea Stream listener...');

    if (!config.opensea.apiKey) {
      logger.warn('OpenSea API key not configured, skipping WebSocket connection');
      return;
    }

    logger.info(`Connecting to OpenSea WebSocket at: ${config.opensea.streamUrl}`);

    this.isRunning = true;
    this.startDedupeCleanup();
    this.connect();
  }

  /**
   * Starts periodic cleanup of the event deduplication cache
   */
  private startDedupeCleanup() {
    if (this.dedupeCleanupInterval) {
      clearInterval(this.dedupeCleanupInterval);
    }

    // Clean up expired entries every minute
    this.dedupeCleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, timestamp] of this.processedEvents) {
        if (now - timestamp > this.EVENT_CACHE_TTL_MS) {
          this.processedEvents.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug(`Cleaned ${cleaned} expired entries from event deduplication cache`);
      }
    }, 60000);
  }

  /**
   * Checks if an event has already been processed and marks it as processed if not
   * Returns true if this is a duplicate event that should be skipped
   *
   * @param eventType - The type of event (e.g., 'item_transferred', 'item_listed')
   * @param orderHash - The order hash (for marketplace events)
   * @param nftId - The NFT identifier
   * @param fromAddress - Optional: the 'from' address for transfer events
   * @param toAddress - Optional: the 'to' address for transfer events
   */
  private isDuplicateEvent(
    eventType: string,
    orderHash: string | null,
    nftId: string | null,
    fromAddress?: string | null,
    toAddress?: string | null
  ): boolean {
    // Create a unique key for this event
    // For transfer events, include from/to addresses to distinguish multiple transfers
    // in the same transaction (e.g., burn -> mint -> final transfer during premium registration)
    let key = `${eventType}:${orderHash || 'no-hash'}:${nftId || 'no-nft'}`;

    if (eventType === 'item_transferred' && (fromAddress || toAddress)) {
      key += `:${fromAddress || 'unknown'}:${toAddress || 'unknown'}`;
    }

    if (this.processedEvents.has(key)) {
      logger.debug(`Duplicate event detected, skipping: ${key}`);
      return true;
    }

    // Mark as processed
    this.processedEvents.set(key, Date.now());
    return false;
  }

  async stop() {
    logger.info('Stopping OpenSea Stream listener...');
    this.isRunning = false;
    this.stopHeartbeat();
    if (this.dedupeCleanupInterval) {
      clearInterval(this.dedupeCleanupInterval);
      this.dedupeCleanupInterval = null;
    }
    this.processedEvents.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect() {
    if (!this.isRunning) return;

    try {
      // Construct WebSocket URL with API key as token parameter
      const wsUrl = `${config.opensea.streamUrl}?token=${config.opensea.apiKey}`;
      logger.info(`Attempting to connect to OpenSea WebSocket...`);

      this.ws = new WebSocket(wsUrl);
    } catch (error: any) {
      logger.error(`Failed to create WebSocket connection: ${error.message}`);
      this.handleReconnect();
      return;
    }

    this.ws.on('open', async () => {
      logger.info('Connected to OpenSea Stream API');
      const wasReconnection = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      this.subscribe();
      this.startHeartbeat();

      // If this was a reconnection, catch up on missed events
      if (wasReconnection && this.disconnectedAt) {
        await this.catchUpMissedEvents();
      }
      this.disconnectedAt = null;
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = this.normalizePhoenixMessage(JSON.parse(data.toString()));

        // Log the message structure for debugging
        logger.debug(`Received Phoenix message - Topic: ${message.topic}, Event: ${message.event}`);

        // Handle Phoenix protocol messages
        if (message.event === 'phx_reply') {
          // Replies to our own phx_join (collection:ens) and heartbeat (phoenix) sends.
          // Heartbeat replies arrive every ~30s, so only surface subscription replies.
          if (message.payload?.status === 'error') {
            logger.error('Failed to subscribe to topic:', message.topic, message.payload);
          } else if (message.topic !== 'phoenix') {
            logger.info('Successfully subscribed to topic:', message.topic);
          }
        } else if (message.event === 'phx_error') {
          logger.error('Phoenix error:', message.payload);
        } else if (message.event === 'phx_close') {
          logger.warn('Phoenix channel closed:', message.topic);
        } else if (typeof message.topic === 'string' && message.topic.startsWith('collection:') && message.event !== 'phx_reply') {
          // Filter out high-volume events we don't act on, early, so they can't flood
          // the stream and block important events like transfers:
          //  - item_metadata_updated: bulk metadata refreshes
          //  - order_invalidate / order_revalidate: order fulfillability changes we
          //    intentionally don't track yet (see OpenSea v2 stream events)
          if (
            message.event === 'item_metadata_updated' ||
            message.event === 'order_invalidate' ||
            message.event === 'order_revalidate'
          ) {
            return;
          }

          // This is an actual OpenSea event
          logger.info(`Received OpenSea event: ${message.event} for topic: ${message.topic}`);
          this.handlePhoenixEvent(message).catch(err => {
            logger.error({
              event: message.event,
              error: err?.message || String(err),
              stack: err?.stack,
              code: err?.code,
            }, `Error handling OpenSea event ${message.event}`);
          });
        } else {
          // Catch-all for unrecognized messages — including frames with no topic,
          // which previously crashed `message.topic.startsWith(...)` and produced a
          // flood of "Failed to parse OpenSea message" errors. Surface the shape so
          // we can identify new/changed OpenSea message types from production logs.
          logger.warn(
            { topic: message?.topic, event: message?.event, raw: data.toString().slice(0, 500) },
            'Unrecognized OpenSea message (no matching handler)'
          );
        }
      } catch (error: any) {
        logger.error(
          { error: error?.message, raw: data.toString().slice(0, 500) },
          `Failed to parse OpenSea message: ${error?.message}`
        );
      }
    });

    this.ws.on('error', (error: any) => {
      logger.error(`OpenSea WebSocket error: ${error.message || error}`);
      if (error.code) {
        logger.error(`Error code: ${error.code}`);
      }
      if (error.stack) {
        logger.debug('Stack trace:', error.stack);
      }
    });

    this.ws.on('close', () => {
      logger.warn('OpenSea WebSocket connection closed');
      this.disconnectedAt = new Date();
      this.stopHeartbeat();
      this.handleReconnect();
    });

    this.ws.on('ping', () => {
      this.ws?.pong();
    });
  }

  /**
   * Normalizes an incoming Phoenix frame into the object shape the handlers expect.
   *
   * OpenSea upgraded their Phoenix socket to the v2 serializer, which encodes
   * messages as arrays `[join_ref, ref, topic, event, payload]` instead of the
   * v1 object `{ topic, event, payload, ref }`. Reading `.topic`/`.event` off an
   * array yields `undefined`, which silently dropped every event (listings, sales,
   * transfers, bids, cancellations) and crashed `topic.startsWith(...)`.
   *
   * We accept both formats so the indexer keeps working regardless of which
   * serializer OpenSea sends.
   */
  private normalizePhoenixMessage(parsed: any): PhoenixMessage {
    if (Array.isArray(parsed)) {
      // Phoenix v2 array serializer: [join_ref, ref, topic, event, payload]
      const [joinRef, ref, topic, event, payload] = parsed;
      return {
        topic,
        event,
        payload,
        ref: ref ?? joinRef,
      };
    }
    // Phoenix v1 object serializer (legacy)
    return parsed as PhoenixMessage;
  }

  private subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to ENS collection events using Phoenix protocol
    const subscriptionMessage = {
      topic: 'collection:ens',
      event: 'phx_join',
      payload: {},
      ref: this.ref++,
    };

    this.ws.send(JSON.stringify(subscriptionMessage));
    logger.info('Subscribed to ENS collection events');
  }

  private startHeartbeat() {
    // Clear existing heartbeat if any
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const heartbeatMessage = {
          topic: 'phoenix',
          event: 'heartbeat',
          payload: {},
          ref: this.ref++,
        };

        this.ws.send(JSON.stringify(heartbeatMessage));
        logger.debug('Sent heartbeat to OpenSea');
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async handlePhoenixEvent(message: PhoenixMessage) {
    try {
      // Track when we last received an event (for reconnection catch-up)
      this.lastEventTimestamp = new Date();

      // Extract deduplication keys from payload
      const eventData = message.payload?.payload || message.payload;
      const orderHash = eventData?.order_hash || null;
      const nftId = eventData?.item?.nft_id || null;

      // For item_transferred events, extract from/to addresses to distinguish
      // multiple transfers in the same transaction (e.g., during premium registration:
      // burn old -> mint to controller -> transfer to registrant)
      const fromAddress = eventData?.from_account?.address || null;
      const toAddress = eventData?.to_account?.address || null;

      // Check for duplicate events (skip collection_offer as they don't have unique identifiers)
      // Note: item_metadata_updated events are filtered out earlier in the message handler
      if (message.event !== 'collection_offer') {
        if (this.isDuplicateEvent(message.event, orderHash, nftId, fromAddress, toAddress)) {
          return;
        }
      }

      // Phoenix events come as the event name directly
      switch (message.event) {
        case 'item_listed':
          await this.handleItemListed(message.payload);
          break;
        case 'item_sold':
          await this.handleItemSold(message.payload);
          break;
        case 'item_transferred':
          await this.handleItemTransferred(message.payload);
          break;
        case 'item_cancelled':
          await this.handleItemCancelled(message.payload);
          break;
        case 'item_received_bid':
          await this.handleItemReceivedBid(message.payload);
          break;
        case 'collection_offer':
          await this.handleCollectionOffer(message.payload);
          break;
        // Note: item_metadata_updated events are filtered out early in the message handler
        // to prevent flooding during bulk metadata refreshes
        default:
          logger.debug(`Unhandled event type: ${message.event}`);
          logger.debug('Event payload:', JSON.stringify(message.payload, null, 2));
      }
    } catch (error: any) {
      logger.error(`Error handling OpenSea event ${message.event}: ${error.message}`);
      logger.debug('Event payload:', JSON.stringify(message.payload, null, 2));
    }
  }

  private async handleItemListed(payload: any) {
    try {
      // Log the entire payload structure to understand what we're receiving
      logger.debug('Full item_listed payload:', JSON.stringify(payload, null, 2));

      // The payload structure might be nested - check for payload.payload
      const eventData = payload.payload || payload;

      logger.info('Processing item_listed event:', {
        item: eventData.item?.nft_id,
        price: eventData.base_price,
        maker: eventData.maker?.address
      });

      const { item, base_price, payment_token, maker, listing_date, expiration_date, order_hash } = eventData;

      if (!item?.nft_id || !maker?.address) {
        logger.error('Missing required fields in item_listed payload:', {
          hasItem: !!item,
          hasNftId: !!item?.nft_id,
          hasMaker: !!maker,
          hasMakerAddress: !!maker?.address,
          actualPayload: JSON.stringify(eventData, null, 2).substring(0, 500)
        });
        return;
      }

      // Validate order_hash - required for proper upsert logic
      if (!order_hash) {
        logger.error('Missing order_hash in item_listed payload - cannot process listing without it:', {
          item: item?.nft_id,
          maker: maker?.address,
        });
        return;
      }

      // Validate base_price - reject listings with missing or zero price
      if (!base_price || base_price === '0') {
        logger.error('Missing or zero base_price in item_listed payload:', {
          item: item?.nft_id,
          base_price,
          order_hash,
        });
        return;
      }

      // Extract token ID from nft_id (format might be like "ethereum/0x.../tokenId")
      const tokenId = item.nft_id.split('/').pop();

      logger.info(`Creating listing for token ID: ${tokenId}`);

      // Always resolve the token ID via The Graph to get authoritative data
      // This also detects non-normalized registrations (e.g., "Vitalik.eth" vs "vitalik.eth")
      let nameToStore = item.metadata?.name ? safeNormalize(item.metadata.name) : null;
      // Don't trust placeholder names from OpenSea metadata (e.g., "[hash].eth")
      if (nameToStore && isPlaceholderName(nameToStore)) {
        nameToStore = null;
      }
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let creationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id
      let isNormalizedRegistration = true; // Assume normalized unless proven otherwise

      // Always resolve via The Graph to verify the registration
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
      if (resolvedData) {
        // Check if this is a non-normalized registration (e.g., "Vitalik.eth" with capital V)
        if (!resolvedData.isNormalized) {
          logger.warn(`Skipping listing for non-normalized ENS registration: "${resolvedData.originalName}" (normalized: "${resolvedData.name}"). Token ID: ${tokenId}, Seller: ${maker.address}`);
          // Skip this listing - it's trying to impersonate a legitimate name
          return;
        }

        nameToStore = resolvedData.name;
        correctTokenId = resolvedData.correctTokenId;
        expiryDate = resolvedData.expiryDate;
        resolvedOwner = resolvedData.ownerAddress;
        registrationDate = resolvedData.registrationDate;
        creationDate = resolvedData.creationDate;
        textRecords = resolvedData.textRecords;
        isNormalizedRegistration = resolvedData.isNormalized;
        logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
      } else if (!nameToStore || !nameToStore.endsWith('.eth')) {
        // Couldn't resolve and no valid name from metadata - use placeholder
        nameToStore = `token-${tokenId}`;
      }

      logger.info(`Storing ENS name: ${nameToStore} for token ID: ${tokenId} (corrected: ${correctTokenId})`);

      // Use maker address as the owner (they are listing their own item)
      const ownerAddress = maker.address.toLowerCase();
      const ensNameId = await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, false, expiryDate, registrationDate, textRecords, creationDate);

      // Create or update listing
      // First, cancel any existing active OpenSea listings for this ENS name and seller
      // IMPORTANT: Only cancel listings from the same source (opensea) to avoid
      // cancelling Grails listings when a user lists on both marketplaces
      // Note: We cancel listings with different order_hash OR NULL order_hash (legacy data)
      const cancelExistingQuery = `
        UPDATE listings
        SET status = 'cancelled', updated_at = NOW()
        WHERE ens_name_id = $1
        AND seller_address = $2
        AND status = 'active'
        AND source = 'opensea'
        AND (order_hash IS NULL OR order_hash IS DISTINCT FROM $3)
      `;

      await this.pool.query(cancelExistingQuery, [
        ensNameId,
        maker.address.toLowerCase(),
        order_hash
      ]);

      // Now insert the new listing (using order_hash + source as the unique constraint)
      const listingQuery = `
        INSERT INTO listings (
          ens_name_id,
          seller_address,
          price_wei,
          currency_address,
          order_hash,
          order_data,
          status,
          source,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', 'opensea', $7)
        ON CONFLICT (order_hash, source)
        DO UPDATE SET
          price_wei = EXCLUDED.price_wei,
          expires_at = EXCLUDED.expires_at,
          status = 'active',
          updated_at = NOW()
      `;

      // Parse expiration date - it might be a timestamp, ISO string, or already a Date
      let expiresAt = null;
      if (expiration_date) {
        try {
          if (typeof expiration_date === 'number') {
            // Unix timestamp - multiply by 1000 if it's in seconds
            expiresAt = new Date(expiration_date > 10000000000 ? expiration_date : expiration_date * 1000);
          } else if (typeof expiration_date === 'string') {
            // ISO date string
            expiresAt = new Date(expiration_date);
          }
          // Validate the date
          if (expiresAt && isNaN(expiresAt.getTime())) {
            logger.warn(`Invalid expiration date: ${expiration_date}`);
            expiresAt = null;
          }
        } catch (err) {
          logger.warn(`Failed to parse expiration date: ${expiration_date}`);
          expiresAt = null;
        }
      }

      const insertParams = [
        ensNameId,
        maker.address.toLowerCase(),
        base_price,
        payment_token?.address || '0x0000000000000000000000000000000000000000',
        order_hash,
        JSON.stringify(eventData),
        expiresAt,
      ];

      logger.debug('Inserting listing with params:', {
        ensNameId,
        sellerAddress: insertParams[1],
        priceWei: insertParams[2],
        priceWeiLength: insertParams[2]?.length,
        currencyAddress: insertParams[3],
        orderHash: insertParams[4],
        orderHashLength: insertParams[4]?.length,
        expiresAt: insertParams[6],
      });

      await this.pool.query(listingQuery, insertParams);

      logger.info(`Listing created/updated for ENS name ID ${ensNameId} (token ${tokenId})`);

      // Update club floor price if this ENS name is in any clubs
      // Only for valid names (not expired, not placeholder, not subname)
      try {
        const clubsResult = await this.pool.query(
          `SELECT clubs, name, expiry_date FROM ens_names WHERE id = $1`,
          [ensNameId]
        );
        const row = clubsResult.rows[0];
        const clubs = row?.clubs || [];
        const name = row?.name || '';
        const expiryDate = row?.expiry_date;

        // Skip if name is invalid for floor calculation
        const isPlaceholder = name.startsWith('token-');
        const isSubname = (name.match(/\./g) || []).length > 1;
        const isExpired = expiryDate && new Date(expiryDate) < new Date();

        if (clubs.length > 0 && base_price && !isPlaceholder && !isSubname && !isExpired) {
          const published = await safePublishJob(QUEUE_NAMES.UPDATE_CLUB_FLOOR_PRICE, {
            clubNames: clubs,
            eventType: 'create',
            listingPrice: base_price,
          }, 'item_listed');

          if (published) {
            logger.info({ ensNameId, clubs, listingPrice: base_price }, 'Published club floor price update (OpenSea listing)');
          }
        } else if (clubs.length > 0 && (isPlaceholder || isSubname || isExpired)) {
          logger.debug({ ensNameId, name, isPlaceholder, isSubname, isExpired }, 'Skipping floor price update for invalid name');
        }
      } catch (queueError: any) {
        logger.error({ error: queueError.message, ensNameId }, 'Failed to publish club floor price update');
      }
    } catch (error: any) {
      logger.error(`Failed to handle item_listed: ${error.message}`);
      logger.error('Stack trace:', error.stack);
      logger.error('Error details:', {
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        column: error.column,
        table: error.table,
      });
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private async handleItemSold(payload: any) {
    try {
      logger.debug('Processing item_sold event');
      logger.debug('Full item_sold payload:', JSON.stringify(payload, null, 2));

      // The payload might be nested
      const eventData = payload.payload || payload;

      // According to OpenSea docs: maker is seller, taker is buyer
      const { item, sale_price, maker, taker, transaction } = eventData;

      if (!item?.nft_id) {
        logger.warn('Missing item.nft_id in sold event, skipping');
        return;
      }

      const tokenId = item.nft_id.split('/').pop();

      // Always resolve via The Graph to verify the registration and detect non-normalized names
      let nameToStore = item.metadata?.name ? safeNormalize(item.metadata.name) : null;
      // Don't trust placeholder names from OpenSea metadata (e.g., "[hash].eth")
      if (nameToStore && isPlaceholderName(nameToStore)) {
        nameToStore = null;
      }
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let creationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Always resolve via The Graph to verify the registration
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
      if (resolvedData) {
        // Check if this is a non-normalized registration (e.g., "Vitalik.eth" with capital V)
        if (!resolvedData.isNormalized) {
          logger.warn(`Skipping sale for non-normalized ENS registration: "${resolvedData.originalName}" (normalized: "${resolvedData.name}"). Token ID: ${tokenId}`);
          // Skip this sale - it's for a non-normalized name that shouldn't affect legitimate names
          return;
        }

        nameToStore = resolvedData.name;
        correctTokenId = resolvedData.correctTokenId;
        expiryDate = resolvedData.expiryDate;
        resolvedOwner = resolvedData.ownerAddress;
        registrationDate = resolvedData.registrationDate;
        creationDate = resolvedData.creationDate;
        textRecords = resolvedData.textRecords;
        logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
      } else if (!nameToStore || nameToStore.startsWith('#') || !nameToStore.endsWith('.eth')) {
        // Couldn't resolve and no valid name from metadata - use placeholder
        nameToStore = `token-${tokenId}`;
      }

      logger.info(`Processing sale for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // First ensure the ENS name exists
      const buyerAddress = taker?.address?.toLowerCase() || null;
      const sellerAddress = maker?.address?.toLowerCase() || null;

      // After a sale, the buyer is the new owner
      let ownerAddress = buyerAddress || '0x0000000000000000000000000000000000000000';

      // If buyer is Name Wrapper, query the contract for the real owner
      if (buyerAddress === NAME_WRAPPER_ADDRESS.toLowerCase() && nameToStore && nameToStore.endsWith('.eth') && !nameToStore.startsWith('token-')) {
        const wrappedOwner = await this.resolver.getWrappedNameOwner(nameToStore);
        if (wrappedOwner) {
          ownerAddress = wrappedOwner;
          logger.info(`Sale to Name Wrapper for ${nameToStore}: got owner from contract: ${ownerAddress}`);
        } else if (resolvedOwner && resolvedOwner !== NAME_WRAPPER_ADDRESS.toLowerCase()) {
          ownerAddress = resolvedOwner;
          logger.info(`Sale to Name Wrapper for ${nameToStore}: using resolved owner: ${ownerAddress}`);
        } else {
          // Can't determine real owner - use seller as fallback (they still own it until wrapper processes)
          ownerAddress = sellerAddress || ownerAddress;
          logger.warn(`Sale to Name Wrapper for ${nameToStore}: cannot determine real owner, using seller: ${ownerAddress}`);
        }
      }

      // Final safety check: never store Name Wrapper as owner
      if (ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase()) {
        logger.warn(`Refusing to store Name Wrapper as owner for ${nameToStore} sale, using seller`);
        ownerAddress = sellerAddress || '0x0000000000000000000000000000000000000000';
      }

      const ensNameId = await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, true, expiryDate, registrationDate, textRecords, creationDate);

      // Find the listing that's being sold and get its source
      // Include recently-sold listings in case the Seaport indexer already marked it as sold
      let listingId: number | undefined;
      let listingSource: string | null = null;
      if (sellerAddress) {
        const findListingQuery = `
          SELECT id, source, status FROM listings
          WHERE ens_name_id = $1
          AND seller_address = $2
          AND status IN ('active', 'sold')
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1
        `;

        const listingResult = await this.pool.query(findListingQuery, [
          ensNameId,
          sellerAddress,
        ]);

        if (listingResult.rows.length > 0) {
          listingId = listingResult.rows[0].id;
          listingSource = listingResult.rows[0].source;
        }
      }

      // Always check for matching offer (not just when no listing found).
      // For offer acceptances, the offer source is the authoritative platform.
      let offerId: number | undefined;
      let offerSource: string | null = null;
      if (buyerAddress) {
        const findOfferQuery = `
          SELECT id, source FROM offers
          WHERE ens_name_id = $1
          AND buyer_address = $2
          AND status IN ('pending', 'accepted')
          ORDER BY created_at DESC
          LIMIT 1
        `;

        const offerResult = await this.pool.query(findOfferQuery, [
          ensNameId,
          buyerAddress,
        ]);

        if (offerResult.rows.length > 0) {
          offerId = offerResult.rows[0].id;
          offerSource = offerResult.rows[0].source;
        }
      }

      // For offer-driven sales, use the offer source (it tells us which platform facilitated the sale).
      // For direct listing purchases, use the listing source.
      const saleSource = offerId
        ? (offerSource || listingSource || 'opensea')
        : (listingSource || offerSource || 'opensea');
      const txHash = transaction?.hash || `opensea_${Date.now()}`;
      let saleAlreadyExists = false;

      // Check if a sale already exists for this order_hash or transaction_hash
      // (mirrors the dedup check in the Seaport indexer)
      if (buyerAddress && sellerAddress) {
        try {
          const existingSaleQuery = `
            SELECT id, source FROM sales
            WHERE (order_hash IS NOT NULL AND order_hash = $1) OR transaction_hash = $2
            LIMIT 1
          `;
          const existingSaleResult = await this.pool.query(existingSaleQuery, [
            eventData.order_hash || null,
            txHash,
          ]);
          if (existingSaleResult.rows.length > 0) {
            saleAlreadyExists = true;
            logger.info(`Sale already exists for order_hash ${eventData.order_hash} or tx ${txHash} (source: ${existingSaleResult.rows[0].source}), skipping sale creation in OpenSea stream`);
          }
        } catch (error: any) {
          logger.error(`Failed to check existing sale: ${error.message}`);
        }
      }

      if (buyerAddress && sellerAddress && !saleAlreadyExists) {
        try {
          const sale = await createSale({
            ensNameId,
            sellerAddress,
            buyerAddress,
            salePriceWei: sale_price || '0',
            currencyAddress: eventData.payment_token?.address,
            listingId,
            offerId,
            transactionHash: txHash,
            blockNumber: transaction?.block_number || 0,
            orderHash: eventData.order_hash,
            orderData: eventData,
            source: saleSource,
            platformFeeWei: eventData.protocol_fee?.value,
            creatorFeeWei: eventData.creator_fee?.value,
            metadata: {
              collection: eventData.collection,
              item_metadata: item.metadata,
              payment_token_decimals: eventData.payment_token?.decimals,
              payment_token_symbol: eventData.payment_token?.symbol,
            },
            saleDate: new Date(),
          });

          logger.info(`Sale created in sales table for token ${tokenId}`);

          // Publish club sales stats job if sale has clubs and currency is ETH or WETH
          if (sale?.clubs && Array.isArray(sale.clubs) && sale.clubs.length > 0) {
            const currencyAddress = eventData.payment_token?.address || '0x0000000000000000000000000000000000000000';
            if (isEthOrWeth(currencyAddress)) {
              const published = await safePublishJob(QUEUE_NAMES.UPDATE_CLUB_SALES_STATS, {
                clubNames: sale.clubs,
                salePriceWei: sale_price || '0',
              }, 'item_sold');

              if (published) {
                logger.info(`Published club sales stats job for clubs: ${sale.clubs.join(', ')}`);
              }
            }
          }
        } catch (error: any) {
          logger.error(`Failed to create sale record: ${error.message}`);
          // Don't fail the entire handler if sale recording fails
        }
      }

      // Update listing status (this is done by the trigger, but we'll keep it for backwards compatibility)
      if (sellerAddress && listingId) {
        const updateListingQuery = `
          UPDATE listings
          SET status = 'sold', updated_at = NOW()
          WHERE id = $1
          AND status = 'active'
        `;

        await this.pool.query(updateListingQuery, [listingId]);
      }

      // Cancel all other active listings for this ENS name
      // After a sale, ownership has transferred, so all other listings from the seller are invalid
      const orderHash = eventData.order_hash;
      const cancelOtherListingsQuery = `
        UPDATE listings
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE ens_name_id = $1
          AND status = 'active'
          AND (order_hash IS NULL OR order_hash IS DISTINCT FROM $2)
        RETURNING id, source
      `;

      const cancelledListings = await this.pool.query(cancelOtherListingsQuery, [ensNameId, orderHash]);

      if (cancelledListings.rows.length > 0) {
        logger.info(`Cancelled ${cancelledListings.rows.length} other active listings for ENS after OpenSea sale (sources: ${cancelledListings.rows.map((r: any) => r.source).join(', ')})`);
      }

      // Record transaction
      if (buyerAddress && sellerAddress) {
        const txQuery = `
          INSERT INTO transactions (
            ens_name_id,
            transaction_hash,
            block_number,
            from_address,
            to_address,
            price_wei,
            transaction_type,
            timestamp
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'sale', $7)
          ON CONFLICT (transaction_hash) DO NOTHING
        `;

        await this.pool.query(txQuery, [
          ensNameId,
          txHash,
          transaction?.block_number || 0,
          sellerAddress,
          buyerAddress,
          sale_price || '0',
          new Date(),
        ]);
      }

      logger.info(`Sale recorded for token ${tokenId}`);

      // Recalculate club floor price since a listing was sold
      try {
        const clubsResult = await this.pool.query(
          'SELECT clubs FROM ens_names WHERE id = $1',
          [ensNameId]
        );
        const clubs = clubsResult.rows[0]?.clubs || [];

        if (clubs.length > 0) {
          const published = await safePublishJob(QUEUE_NAMES.UPDATE_CLUB_FLOOR_PRICE, {
            clubNames: clubs,
            eventType: 'delete', // Triggers full recalculation since listing is no longer active
          }, 'item_sold');

          if (published) {
            logger.info({ ensNameId, clubs }, 'Published club floor price recalculation (OpenSea sale)');
          }
        }
      } catch (queueError: any) {
        logger.error({ error: queueError.message, ensNameId }, 'Failed to publish club floor price recalculation');
      }
    } catch (error: any) {
      logger.error(`Failed to handle item_sold: ${error.message}`);
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private async handleItemTransferred(payload: any) {
    try {
      logger.debug('Processing item_transferred event');
      logger.debug('Full item_transferred payload:', JSON.stringify(payload, null, 2));

      // The payload might be nested
      const eventData = payload.payload || payload;

      const { item, from_account, to_account, transaction } = eventData;
      // Check if required fields exist
      if (!item?.nft_id) {
        logger.warn('Missing item.nft_id in transfer event, skipping');
        return;
      }

      if (!to_account?.address) {
        logger.warn('Missing to_account.address in transfer event, skipping');
        return;
      }

      const tokenId = item.nft_id.split('/').pop();
      const newOwner = to_account.address.toLowerCase();

      // Always resolve via The Graph to verify the registration and detect non-normalized names
      let nameToStore = item.metadata?.name ? safeNormalize(item.metadata.name) : null;
      // Don't trust placeholder names from OpenSea metadata (e.g., "[hash].eth")
      if (nameToStore && isPlaceholderName(nameToStore)) {
        nameToStore = null;
      }
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Always resolve via The Graph to verify the registration
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
      if (resolvedData) {
        // Check if this is a non-normalized registration (e.g., "Vitalik.eth" with capital V)
        if (!resolvedData.isNormalized) {
          logger.warn(`Skipping transfer for non-normalized ENS registration: "${resolvedData.originalName}" (normalized: "${resolvedData.name}"). Token ID: ${tokenId}`);
          // Skip this transfer - it's for a non-normalized name that shouldn't affect legitimate names
          return;
        }

        nameToStore = resolvedData.name;
        correctTokenId = resolvedData.correctTokenId;
        expiryDate = resolvedData.expiryDate;
        resolvedOwner = resolvedData.ownerAddress;
        registrationDate = resolvedData.registrationDate;
        textRecords = resolvedData.textRecords;
        logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
      } else if (!nameToStore || nameToStore.startsWith('#') || !nameToStore.endsWith('.eth')) {
        // Couldn't resolve and no valid name from metadata - use placeholder
        nameToStore = `token-${tokenId}`;
      }

      logger.info(`Processing transfer for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // Determine the correct owner to store
      const fromAddress = from_account?.address?.toLowerCase() || '';
      const isNameWrapperInvolved = newOwner === NAME_WRAPPER_ADDRESS.toLowerCase() ||
                                     fromAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

      let ownerAddress = newOwner;

      // If Name Wrapper is involved, query the contract directly for the real owner
      if (isNameWrapperInvolved && nameToStore && nameToStore.endsWith('.eth') && !nameToStore.startsWith('token-')) {
        const wrappedOwner = await this.resolver.getWrappedNameOwner(nameToStore);
        if (wrappedOwner) {
          ownerAddress = wrappedOwner;
          logger.info(`Name Wrapper transfer for ${nameToStore}: got owner from contract: ${ownerAddress}`);
        } else if (newOwner === NAME_WRAPPER_ADDRESS.toLowerCase()) {
          // Wrapping but can't get wrapped owner - use resolved owner from The Graph if available
          if (resolvedOwner && resolvedOwner !== NAME_WRAPPER_ADDRESS.toLowerCase()) {
            ownerAddress = resolvedOwner;
            logger.info(`Name Wrapper transfer for ${nameToStore}: using resolved owner: ${ownerAddress}`);
          } else {
            // Can't determine real owner - skip this transfer to avoid storing Name Wrapper as owner
            logger.warn(`Name Wrapper transfer for ${nameToStore}: cannot determine real owner, skipping`);
            return;
          }
        }
        // For unwrapping (from = Name Wrapper), newOwner is correct if contract query failed
      }

      // Final safety check: never store Name Wrapper as owner
      if (ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase()) {
        logger.warn(`Refusing to store Name Wrapper as owner for ${nameToStore}, skipping`);
        return;
      }

      await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, true, expiryDate, registrationDate, textRecords);

      logger.info(`Transfer recorded for token ${tokenId} to ${ownerAddress}`);
    } catch (error: any) {
      logger.error(`Failed to handle item_transferred: ${error.message}`);
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private async handleItemCancelled(payload: any) {
    try {
      logger.debug('Processing item_cancelled event');
      logger.debug('Full item_cancelled payload:', JSON.stringify(payload, null, 2));

      // The payload might be nested
      const eventData = payload.payload || payload;

      // According to OpenSea docs: item_cancelled has order_hash, not item.nft_id
      const { order_hash, maker, base_price, payment_token, collection } = eventData;

      if (!order_hash) {
        logger.warn('Missing order_hash in cancelled event, skipping');
        return;
      }

      if (!maker?.address) {
        logger.warn('Missing maker.address in cancelled event, skipping');
        return;
      }

      const sellerAddress = maker.address.toLowerCase();

      // For cancellations, we need to find the listing by order_hash
      // OpenSea doesn't provide the token_id directly in cancel events
      const updateQuery = `
        UPDATE listings
        SET status = 'cancelled', updated_at = NOW()
        WHERE order_hash = $1
        AND seller_address = $2
        AND status = 'active'
        RETURNING ens_name_id
      `;

      const result = await this.pool.query(updateQuery, [
        order_hash,
        sellerAddress,
      ]);

      if (result && result.rowCount !== null && result.rowCount > 0) {
        logger.info(`Listing cancelled for order_hash ${order_hash}`);

        // Recalculate club floor price since a listing was cancelled
        const ensNameId = result.rows[0].ens_name_id;
        try {
          const clubsResult = await this.pool.query(
            'SELECT clubs FROM ens_names WHERE id = $1',
            [ensNameId]
          );
          const clubs = clubsResult.rows[0]?.clubs || [];

          if (clubs.length > 0) {
            const published = await safePublishJob(QUEUE_NAMES.UPDATE_CLUB_FLOOR_PRICE, {
              clubNames: clubs,
              eventType: 'delete', // Triggers full recalculation since listing is no longer active
            }, 'item_cancelled');

            if (published) {
              logger.info({ ensNameId, clubs }, 'Published club floor price recalculation (OpenSea cancellation)');
            }
          }
        } catch (queueError: any) {
          logger.error({ error: queueError.message, ensNameId }, 'Failed to publish club floor price recalculation');
        }
      } else {
        logger.debug(`No active listing found for order_hash ${order_hash}`);
      }
    } catch (error: any) {
      logger.error(`Failed to handle item_cancelled: ${error.message}`);
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private async handleItemReceivedBid(payload: any) {
    try {
      logger.debug('Processing item_received_bid event');
      logger.debug('Full item_received_bid payload:', JSON.stringify(payload, null, 2));

      // The payload might be nested
      const eventData = payload.payload || payload;

      // According to OpenSea docs: item_received_bid uses base_price for the bid amount
      const { item, base_price, maker, created_date, expiration_date, order_hash, payment_token } = eventData;

      // Check required fields - use base_price instead of bid_amount
      if (!item) {
        logger.warn('Missing item in bid event, skipping');
        return;
      }

      // Extract token ID - should be in item.nft_id
      if (!item.nft_id) {
        logger.warn('Missing item.nft_id in bid event');
        logger.debug(`Item metadata: ${JSON.stringify(item.metadata)}`);
        return;
      }

      const tokenId = item.nft_id.split('/').pop();

      if (!base_price) {
        logger.warn('Missing base_price in bid event, skipping');
        return;
      }

      // The bidder address is in maker.address according to docs
      const bidderAddress = maker?.address;

      if (!bidderAddress) {
        logger.warn('Missing maker.address in bid event, skipping');
        return;
      }

      // Always resolve via The Graph to verify the registration and detect non-normalized names
      let nameToStore = item.metadata?.name ? safeNormalize(item.metadata.name) : null;
      // Don't trust placeholder names from OpenSea metadata (e.g., "[hash].eth")
      if (nameToStore && isPlaceholderName(nameToStore)) {
        nameToStore = null;
      }
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Always resolve via The Graph to verify the registration
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
      if (resolvedData) {
        // Check if this is a non-normalized registration (e.g., "Vitalik.eth" with capital V)
        if (!resolvedData.isNormalized) {
          logger.warn(`Skipping bid for non-normalized ENS registration: "${resolvedData.originalName}" (normalized: "${resolvedData.name}"). Token ID: ${tokenId}`);
          // Skip this bid - it's for a non-normalized name that shouldn't affect legitimate names
          return;
        }

        nameToStore = resolvedData.name;
        correctTokenId = resolvedData.correctTokenId;
        expiryDate = resolvedData.expiryDate;
        resolvedOwner = resolvedData.ownerAddress;
        registrationDate = resolvedData.registrationDate;
        textRecords = resolvedData.textRecords;
        logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
      } else if (!nameToStore || nameToStore.startsWith('#') || !nameToStore.endsWith('.eth')) {
        // Couldn't resolve and no valid name from metadata - use placeholder
        nameToStore = `token-${tokenId}`;
      }

      logger.info(`Processing bid for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // For offers, we should NOT update the owner - only ensure the ENS name exists in the database
      // The owner should only be updated by blockchain Transfer events
      let ensNameId: number;

      // First, try to get existing ENS name by token_id
      const existingNameResult = await this.pool.query(
        'SELECT id, token_id FROM ens_names WHERE token_id = $1',
        [correctTokenId]
      );

      if (existingNameResult.rows.length > 0) {
        // Name exists, use its ID
        ensNameId = existingNameResult.rows[0].id;

        // Update name if it's still a placeholder (but don't touch owner!)
        if (nameToStore && !nameToStore.startsWith('token-') && !nameToStore.startsWith('#')) {
          await this.pool.query(
            `UPDATE ens_names SET
              name = CASE
                WHEN name LIKE 'token-%' OR name LIKE '#%' THEN $1
                ELSE name
              END,
              expiry_date = COALESCE($2, expiry_date),
              registration_date = COALESCE($3, registration_date),
              metadata = COALESCE($4, metadata),
              updated_at = NOW()
            WHERE token_id = $5`,
            [nameToStore, expiryDate, registrationDate, JSON.stringify(textRecords), correctTokenId]
          );
        }
      } else {
        // Token ID not found - but the name might exist with a different token_id
        // This can happen when OpenSea sends wrapped token ID but we have labelhash, or vice versa
        // Check by name if we have a resolved real name (not a placeholder)
        if (nameToStore && nameToStore.endsWith('.eth') && !nameToStore.startsWith('token-')) {
          const existingByNameResult = await this.pool.query(
            'SELECT id, token_id FROM ens_names WHERE name = $1',
            [nameToStore]
          );

          if (existingByNameResult.rows.length > 0) {
            // Found by name - use the existing record
            ensNameId = existingByNameResult.rows[0].id;
            const existingTokenId = existingByNameResult.rows[0].token_id;
            logger.info(`Found ${nameToStore} by name lookup (existing token_id: ${existingTokenId}, event token_id: ${correctTokenId})`);

            // Update metadata if needed (but don't change token_id or owner)
            await this.pool.query(
              `UPDATE ens_names SET
                expiry_date = COALESCE($1, expiry_date),
                registration_date = COALESCE($2, registration_date),
                metadata = COALESCE($3, metadata),
                updated_at = NOW()
              WHERE id = $4`,
              [expiryDate, registrationDate, JSON.stringify(textRecords), ensNameId]
            );
          } else {
            // Name truly doesn't exist, create it
            const initialOwner = resolvedOwner?.toLowerCase() || '0x0000000000000000000000000000000000000000';

            const insertResult = await this.pool.query(
              `INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, metadata, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
               ON CONFLICT (token_id) DO UPDATE SET
                 name = CASE
                   WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' THEN EXCLUDED.name
                   ELSE ens_names.name
                 END,
                 expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
                 registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
                 metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
                 updated_at = NOW()
               RETURNING id`,
              [correctTokenId, nameToStore, initialOwner, expiryDate, registrationDate, JSON.stringify(textRecords)]
            );
            ensNameId = insertResult.rows[0].id;
          }
        } else {
          // Placeholder name or couldn't resolve - just try to insert/upsert
          const initialOwner = resolvedOwner?.toLowerCase() || '0x0000000000000000000000000000000000000000';

          const insertResult = await this.pool.query(
            `INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
             ON CONFLICT (token_id) DO UPDATE SET
               name = CASE
                 WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' THEN EXCLUDED.name
                 ELSE ens_names.name
               END,
               expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
               registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
               metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
               updated_at = NOW()
             RETURNING id`,
            [correctTokenId, nameToStore, initialOwner, expiryDate, registrationDate, JSON.stringify(textRecords)]
          );
          ensNameId = insertResult.rows[0].id;
        }
      }

      const offerQuery = `
        INSERT INTO offers (
          ens_name_id,
          buyer_address,
          offer_amount_wei,
          currency_address,
          order_hash,
          order_data,
          status,
          source,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'opensea', $7)
        ON CONFLICT (order_hash, source)
        DO UPDATE SET
          offer_amount_wei = EXCLUDED.offer_amount_wei,
          expires_at = EXCLUDED.expires_at,
          status = 'pending'
      `;

      // Parse the currency from the payload - OpenSea provides payment_token info
      const currencyAddress = payment_token?.address || '0x0000000000000000000000000000000000000000';  // ETH

      // Parse expiration date safely
      let expiresAt = null;
      if (expiration_date) {
        try {
          if (typeof expiration_date === 'number') {
            // Unix timestamp - multiply by 1000 if it's in seconds
            expiresAt = new Date(expiration_date > 10000000000 ? expiration_date : expiration_date * 1000);
          } else if (typeof expiration_date === 'string') {
            // ISO date string
            expiresAt = new Date(expiration_date);
          }
          // Validate the date
          if (expiresAt && isNaN(expiresAt.getTime())) {
            logger.warn(`Invalid expiration date in bid: ${expiration_date}`);
            expiresAt = null;
          }
        } catch (err) {
          logger.warn(`Failed to parse bid expiration date: ${expiration_date}`);
          expiresAt = null;
        }
      }

      const offerResult = await this.pool.query(offerQuery + ' RETURNING id', [
        ensNameId,
        bidderAddress.toLowerCase(),
        base_price,  // Use base_price instead of bid_amount
        currencyAddress,
        order_hash || null,  // Include order_hash
        JSON.stringify(eventData),
        expiresAt,
      ]);

      logger.info(`Offer received for token ${tokenId} from ${bidderAddress}`);

      // Publish highest offer update job
      if (offerResult.rows.length > 0 && ensNameId && base_price) {
        const published = await safePublishJob(QUEUE_NAMES.UPDATE_HIGHEST_OFFER, {
          ensNameId,
          offerId: offerResult.rows[0].id,
          offerAmountWei: base_price,
          currencyAddress: currencyAddress || '0x0000000000000000000000000000000000000000',
        }, 'item_received_bid');

        if (published) {
          logger.debug(`Published update-highest-offer job for ENS name ${ensNameId}`);
        }
      }
    } catch (error: any) {
      logger.error(`Failed to handle item_received_bid: ${error.message}`);
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private async handleCollectionOffer(payload: any) {
    try {
      logger.info('Processing collection_offer event');
      logger.debug('Full collection_offer payload:', JSON.stringify(payload, null, 2));

      // The payload might be nested
      const eventData = payload.payload || payload;

      // Collection offers apply to the entire collection, not specific items
      const { collection, base_price, maker, created_date, expiration_date, order_hash, payment_token } = eventData;

      if (!collection?.slug || collection.slug !== 'ens') {
        logger.debug(`Collection offer for non-ENS collection: ${collection?.slug}`);
        return;
      }

      if (!base_price || !maker?.address) {
        logger.warn('Missing required fields in collection offer event');
        return;
      }

      logger.info(`Collection offer received for ENS: ${base_price} from ${maker.address}`);

      // Collection offers are broad offers for any item in the collection
      // We can track these separately or just log them for now
      // Since they don't apply to a specific ENS name, we might want a separate table
      // For now, let's just log them

    } catch (error: any) {
      logger.error(`Failed to handle collection_offer: ${error.message}`);
      logger.debug('Full payload:', JSON.stringify(payload, null, 2));
    }
  }

  private handleReconnect() {
    if (!this.isRunning) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      logger.info(`Reconnecting to OpenSea Stream (attempt ${this.reconnectAttempts})...`);
      setTimeout(() => this.connect(), this.reconnectInterval);
    } else {
      logger.error('Max reconnection attempts reached for OpenSea Stream');
    }
  }

  /**
   * Catch up on events that may have been missed during WebSocket disconnection
   * by querying the OpenSea API for recent listings
   */
  private async catchUpMissedEvents() {
    if (!this.disconnectedAt) {
      return;
    }

    const disconnectDuration = Date.now() - this.disconnectedAt.getTime();

    // Don't try to catch up if we were disconnected for too long
    if (disconnectDuration > this.CATCHUP_WINDOW_MS) {
      logger.warn(`Disconnected for ${Math.round(disconnectDuration / 1000)}s, exceeds catch-up window. Some events may have been missed.`);
      return;
    }

    logger.info(`Catching up on events missed during ${Math.round(disconnectDuration / 1000)}s disconnection...`);

    try {
      // Query OpenSea API for recent ENS listings
      const response = await fetch(
        'https://api.opensea.io/api/v2/listings/collection/ens/all?limit=50',
        {
          headers: {
            'Accept': 'application/json',
            'X-API-KEY': config.opensea.apiKey!,
          },
        }
      );

      if (!response.ok) {
        logger.error(`Failed to fetch recent listings from OpenSea: ${response.status} ${response.statusText}`);
        return;
      }

      const data = await response.json() as { listings?: any[] };
      const listings = data.listings || [];

      logger.info(`Fetched ${listings.length} recent listings from OpenSea API for catch-up`);

      let processedCount = 0;
      for (const listing of listings) {
        try {
          // Convert OpenSea API listing format to stream event format
          const eventPayload = this.convertListingToEventPayload(listing);
          if (eventPayload) {
            // The deduplication logic will skip any events we've already processed
            await this.handleItemListed(eventPayload);
            processedCount++;
          }
        } catch (error: any) {
          logger.error(`Error processing catch-up listing: ${error.message}`);
        }
      }

      logger.info(`Catch-up complete: processed ${processedCount} listings`);
    } catch (error: any) {
      logger.error(`Failed to catch up on missed events: ${error.message}`);
    }
  }

  /**
   * Converts an OpenSea API listing response to the stream event payload format
   */
  private convertListingToEventPayload(listing: any): any | null {
    try {
      const protocol_data = listing.protocol_data;
      if (!protocol_data) {
        return null;
      }

      // Extract token ID from the offer items
      const offerItem = protocol_data.parameters?.offer?.[0];
      if (!offerItem?.identifierOrCriteria) {
        return null;
      }

      const tokenId = offerItem.identifierOrCriteria;

      // Extract price from consideration items (first item is usually the payment)
      const considerationItem = protocol_data.parameters?.consideration?.[0];
      const basePrice = considerationItem?.startAmount || '0';

      // Build the event payload in the same format as stream events
      return {
        item: {
          nft_id: `ethereum/0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85/${tokenId}`,
          metadata: {
            name: listing.protocol_data?.parameters?.offer?.[0]?.token || null,
          },
        },
        base_price: basePrice,
        payment_token: {
          address: considerationItem?.token || '0x0000000000000000000000000000000000000000',
        },
        maker: {
          address: protocol_data.parameters?.offerer,
        },
        order_hash: listing.order_hash,
        expiration_date: protocol_data.parameters?.endTime
          ? parseInt(protocol_data.parameters.endTime)
          : null,
      };
    } catch (error: any) {
      logger.debug(`Failed to convert listing to event payload: ${error.message}`);
      return null;
    }
  }

  /**
   * Upsert ENS name - handles duplicate name and token_id constraints
   */
  private async upsertEnsName(
    tokenId: string,
    name: string,
    ownerAddress: string,
    includeTransferDate = false,
    expiryDate: Date | null = null,
    registrationDate: Date | null = null,
    textRecords: Record<string, string> = {},
    creationDate: Date | null = null
  ): Promise<number> {
    // Normalize owner address to lowercase
    const normalizedOwner = ownerAddress.toLowerCase();

    try {
      // Use INSERT ... ON CONFLICT to avoid race conditions
      const upsertQuery = includeTransferDate ? `
        INSERT INTO ens_names (token_id, name, owner_address, last_transfer_date, expiry_date, registration_date, creation_date, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), $4, $5, $7, $6, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          name = CASE
            WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' OR ens_names.name LIKE '[%].eth' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          last_transfer_date = NOW(),
          expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
          registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
          creation_date = COALESCE(EXCLUDED.creation_date, ens_names.creation_date),
          metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
          updated_at = NOW()
        RETURNING id
      ` : `
        INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, creation_date, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $7, $6, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          name = CASE
            WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' OR ens_names.name LIKE '[%].eth' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
          registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
          creation_date = COALESCE(EXCLUDED.creation_date, ens_names.creation_date),
          metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.pool.query(upsertQuery, [
        tokenId,
        name,
        normalizedOwner,
        expiryDate,
        registrationDate,
        JSON.stringify(textRecords),
        creationDate
      ]);
      return result.rows[0].id;
    } catch (error: any) {
      // If we get a unique constraint violation on name, it means the name already exists
      // with a different token_id. This could be a data inconsistency issue.
      if (error.code === '23505' && error.constraint === 'ens_names_real_name_unique') {
        logger.warn(`ENS name "${name}" already exists with different token_id. Updating existing record.`);

        // Update the existing record by name - this ensures ownership gets updated
        const updateQuery = includeTransferDate ? `
          UPDATE ens_names SET
            owner_address = $2,
            last_transfer_date = NOW(),
            expiry_date = COALESCE($3, expiry_date),
            registration_date = COALESCE($4, registration_date),
            creation_date = COALESCE($6, creation_date),
            metadata = COALESCE($5, metadata),
            updated_at = NOW()
          WHERE name = $1
          RETURNING id
        ` : `
          UPDATE ens_names SET
            owner_address = $2,
            expiry_date = COALESCE($3, expiry_date),
            registration_date = COALESCE($4, registration_date),
            creation_date = COALESCE($6, creation_date),
            metadata = COALESCE($5, metadata),
            updated_at = NOW()
          WHERE name = $1
          RETURNING id
        `;

        const updateResult = await this.pool.query(updateQuery, [
          name,
          normalizedOwner,
          expiryDate,
          registrationDate,
          JSON.stringify(textRecords),
          creationDate
        ]);

        if (updateResult.rows.length > 0) {
          logger.info(`Updated ownership for "${name}" to ${normalizedOwner}`);
          return updateResult.rows[0].id;
        }

        // Fallback: just fetch the ID if update didn't return anything
        const existingQuery = 'SELECT id FROM ens_names WHERE name = $1';
        const existingResult = await this.pool.query(existingQuery, [name]);

        if (existingResult.rows.length > 0) {
          return existingResult.rows[0].id;
        }
      }

      // Re-throw if it's a different error
      throw error;
    }
  }
}