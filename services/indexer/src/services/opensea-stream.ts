import WebSocket from 'ws';
import { config, getPostgresPool, createSale, isEthOrWeth } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';

interface PhoenixMessage {
  topic: string;
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
    this.connect();
  }

  async stop() {
    logger.info('Stopping OpenSea Stream listener...');
    this.isRunning = false;
    this.stopHeartbeat();
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

    this.ws.on('open', () => {
      logger.info('Connected to OpenSea Stream API');
      this.reconnectAttempts = 0;
      this.subscribe();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message: PhoenixMessage = JSON.parse(data.toString());

        // Log the message structure for debugging
        logger.debug(`Received Phoenix message - Topic: ${message.topic}, Event: ${message.event}`);

        // Handle Phoenix protocol messages
        if (message.event === 'phx_reply') {
          // This is a reply to our subscription
          if (message.payload?.status === 'ok') {
            logger.info('Successfully subscribed to topic:', message.topic);
          } else if (message.payload?.status === 'error') {
            logger.error('Failed to subscribe to topic:', message.topic, message.payload);
          }
        } else if (message.event === 'phx_error') {
          logger.error('Phoenix error:', message.payload);
        } else if (message.event === 'phx_close') {
          logger.warn('Phoenix channel closed:', message.topic);
        } else if (message.topic.startsWith('collection:') && message.event !== 'phx_reply') {
          // This is an actual OpenSea event
          logger.info(`Received OpenSea event: ${message.event} for topic: ${message.topic}`);
          this.handlePhoenixEvent(message);
        }
      } catch (error: any) {
        logger.error(`Failed to parse OpenSea message: ${error.message}`);
        logger.debug('Raw message:', data.toString());
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
      this.stopHeartbeat();
      this.handleReconnect();
    });

    this.ws.on('ping', () => {
      this.ws?.pong();
    });
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
        case 'item_metadata_updated':
          logger.debug('Metadata updated event - skipping');
          break;
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

      // Extract token ID from nft_id (format might be like "ethereum/0x.../tokenId")
      const tokenId = item.nft_id.split('/').pop();

      logger.info(`Creating listing for token ID: ${tokenId}`);

      // Try to get the ENS name from metadata first (e.g., "277.eth")
      let nameToStore = item.metadata?.name || null;
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // If no name in metadata or it doesn't look like an ENS name, try to resolve it
      if (!nameToStore || !nameToStore.endsWith('.eth')) {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
        if (resolvedData) {
          nameToStore = resolvedData.name;
          correctTokenId = resolvedData.correctTokenId; // Use the corrected token_id from resolver
          expiryDate = resolvedData.expiryDate;
          resolvedOwner = resolvedData.ownerAddress;
          registrationDate = resolvedData.registrationDate;
          textRecords = resolvedData.textRecords;
          logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
        } else if (nameToStore && !nameToStore.endsWith('.eth')) {
          // If we have a name but it's not an ENS name, use placeholder
          nameToStore = `token-${tokenId}`;
        } else if (!nameToStore) {
          nameToStore = `token-${tokenId}`;
        }
      }

      logger.info(`Storing ENS name: ${nameToStore} for token ID: ${tokenId} (corrected: ${correctTokenId})`);

      // Use maker address as the owner (they are listing their own item)
      const ownerAddress = maker.address.toLowerCase();
      const ensNameId = await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, false, expiryDate, registrationDate, textRecords);

      // Create or update listing
      // First, cancel any existing active listings for this ENS name and seller
      const cancelExistingQuery = `
        UPDATE listings
        SET status = 'cancelled', updated_at = NOW()
        WHERE ens_name_id = $1
        AND seller_address = $2
        AND status = 'active'
        AND (order_hash IS NULL OR order_hash != $3)
      `;

      await this.pool.query(cancelExistingQuery, [
        ensNameId,
        maker.address.toLowerCase(),
        order_hash || 'none'
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
        base_price || '0',
        payment_token?.address || '0x0000000000000000000000000000000000000000',
        order_hash || null,
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

      // Extract ENS name from metadata and normalize placeholders
      let nameToStore = item.metadata?.name || null;
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Normalize placeholder names: OpenSea may send "#12345..." which we convert to "token-12345"
      if (!nameToStore || !nameToStore.endsWith('.eth')) {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
        if (resolvedData) {
          nameToStore = resolvedData.name;
          correctTokenId = resolvedData.correctTokenId; // Use the corrected token_id from resolver
          expiryDate = resolvedData.expiryDate;
          resolvedOwner = resolvedData.ownerAddress;
          registrationDate = resolvedData.registrationDate;
          textRecords = resolvedData.textRecords;
          logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
        } else if (nameToStore && (nameToStore.startsWith('#') || !nameToStore.endsWith('.eth'))) {
          // Convert OpenSea's #-prefix or other non-.eth names to standard placeholder
          nameToStore = `token-${tokenId}`;
        } else if (!nameToStore) {
          nameToStore = `token-${tokenId}`;
        }
      }

      logger.info(`Processing sale for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // First ensure the ENS name exists
      const buyerAddress = taker?.address?.toLowerCase() || null;
      const sellerAddress = maker?.address?.toLowerCase() || null;

      // After a sale, the buyer is the new owner
      const ownerAddress = buyerAddress || '0x0000000000000000000000000000000000000000';
      const ensNameId = await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, true, expiryDate, registrationDate, textRecords);

      // Find the listing that's being sold
      let listingId: number | undefined;
      if (sellerAddress) {
        const findListingQuery = `
          SELECT id FROM listings
          WHERE ens_name_id = $1
          AND seller_address = $2
          AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        `;

        const listingResult = await this.pool.query(findListingQuery, [
          ensNameId,
          sellerAddress,
        ]);

        if (listingResult.rows.length > 0) {
          listingId = listingResult.rows[0].id;
        }
      }

      // Record sale in sales table
      if (buyerAddress && sellerAddress) {
        try {
          const sale = await createSale({
            ensNameId,
            sellerAddress,
            buyerAddress,
            salePriceWei: sale_price || '0',
            currencyAddress: eventData.payment_token?.address,
            listingId,
            transactionHash: transaction?.transaction_hash || `opensea_${Date.now()}`,
            blockNumber: transaction?.block_number || 0,
            orderHash: eventData.order_hash,
            orderData: eventData,
            source: 'opensea',
            platformFeeWei: eventData.protocol_fee?.value,
            creatorFeeWei: eventData.creator_fee?.value,
            metadata: {
              collection: eventData.collection,
              item_metadata: item.metadata
            },
            saleDate: new Date(),
          });

          logger.info(`Sale created in sales table for token ${tokenId}`);

          // Publish club sales stats job if sale has clubs and currency is ETH or WETH
          if (sale?.clubs && Array.isArray(sale.clubs) && sale.clubs.length > 0) {
            const currencyAddress = eventData.payment_token?.address || '0x0000000000000000000000000000000000000000';
            if (isEthOrWeth(currencyAddress)) {
              try {
                const PgBoss = require('pg-boss');
                const boss = new PgBoss({ connectionString: config.database.url });
                await boss.start();
                await boss.send('update-club-sales-stats', {
                  clubNames: sale.clubs,
                  salePriceWei: sale_price || '0',
                });
                await boss.stop();
                logger.info(`Published club sales stats job for clubs: ${sale.clubs.join(', ')}`);
              } catch (queueError: any) {
                logger.error(`Failed to publish club sales stats job: ${queueError.message}`);
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
          transaction?.transaction_hash || `opensea_${Date.now()}`,
          transaction?.block_number || 0,
          sellerAddress,
          buyerAddress,
          sale_price || '0',
          new Date(),
        ]);
      }

      logger.info(`Sale recorded for token ${tokenId}`);
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

      // Extract ENS name from metadata and normalize placeholders
      let nameToStore = item.metadata?.name || null;
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Normalize placeholder names: OpenSea may send "#12345..." which we convert to "token-12345"
      if (!nameToStore || !nameToStore.endsWith('.eth')) {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
        if (resolvedData) {
          nameToStore = resolvedData.name;
          correctTokenId = resolvedData.correctTokenId; // Use the corrected token_id from resolver
          expiryDate = resolvedData.expiryDate;
          resolvedOwner = resolvedData.ownerAddress;
          registrationDate = resolvedData.registrationDate;
          textRecords = resolvedData.textRecords;
          logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
        } else if (nameToStore && (nameToStore.startsWith('#') || !nameToStore.endsWith('.eth'))) {
          // Convert OpenSea's #-prefix or other non-.eth names to standard placeholder
          nameToStore = `token-${tokenId}`;
        } else if (!nameToStore) {
          nameToStore = `token-${tokenId}`;
        }
      }

      logger.info(`Processing transfer for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // Ensure ENS name exists and update owner
      // For transfers, always use the recipient from the event as source of truth
      // The Graph may have stale data due to indexing lag, so we trust the OpenSea event
      const ownerAddress = newOwner;
      await this.upsertEnsName(correctTokenId, nameToStore, ownerAddress, true, expiryDate, registrationDate, textRecords);

      logger.info(`Transfer recorded for token ${tokenId} to ${to_account.address}`);
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
      `;

      const result = await this.pool.query(updateQuery, [
        order_hash,
        sellerAddress,
      ]);

      if (result && result.rowCount !== null && result.rowCount > 0) {
        logger.info(`Listing cancelled for order_hash ${order_hash}`);
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

      // Extract ENS name from metadata and normalize placeholders
      let nameToStore = item.metadata?.name || null;
      let expiryDate: Date | null = null;
      let resolvedOwner: string | null = null;
      let registrationDate: Date | null = null;
      let textRecords: Record<string, string> = {};
      let correctTokenId = tokenId; // Default to OpenSea's token_id

      // Normalize placeholder names: OpenSea may send "#12345..." which we convert to "token-12345"
      if (!nameToStore || !nameToStore.endsWith('.eth')) {
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenId);
        if (resolvedData) {
          nameToStore = resolvedData.name;
          correctTokenId = resolvedData.correctTokenId; // Use the corrected token_id from resolver
          expiryDate = resolvedData.expiryDate;
          resolvedOwner = resolvedData.ownerAddress;
          registrationDate = resolvedData.registrationDate;
          textRecords = resolvedData.textRecords;
          logger.debug(`Resolved token ${tokenId} to correctTokenId: ${correctTokenId}`);
        } else if (nameToStore && (nameToStore.startsWith('#') || !nameToStore.endsWith('.eth'))) {
          // Convert OpenSea's #-prefix or other non-.eth names to standard placeholder
          nameToStore = `token-${tokenId}`;
        } else if (!nameToStore) {
          nameToStore = `token-${tokenId}`;
        }
      }

      logger.info(`Processing bid for: ${nameToStore} (token ${tokenId}, corrected: ${correctTokenId})`);

      // For offers, we should NOT update the owner - only ensure the ENS name exists in the database
      // The owner should only be updated by blockchain Transfer events
      let ensNameId: number;

      // First, try to get existing ENS name by token_id
      const existingNameResult = await this.pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
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
        // Name doesn't exist, create it with owner from The Graph
        // Use resolved owner if available, otherwise use zero address temporarily
        // (the indexer will fix it when it processes the actual Transfer event)
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

      await this.pool.query(offerQuery, [
        ensNameId,
        bidderAddress.toLowerCase(),
        base_price,  // Use base_price instead of bid_amount
        currencyAddress,
        order_hash || null,  // Include order_hash
        JSON.stringify(eventData),
        expiresAt,
      ]);

      logger.info(`Offer received for token ${tokenId} from ${bidderAddress}`);
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
   * Upsert ENS name - handles duplicate name and token_id constraints
   */
  private async upsertEnsName(
    tokenId: string,
    name: string,
    ownerAddress: string,
    includeTransferDate = false,
    expiryDate: Date | null = null,
    registrationDate: Date | null = null,
    textRecords: Record<string, string> = {}
  ): Promise<number> {
    // Normalize owner address to lowercase
    const normalizedOwner = ownerAddress.toLowerCase();

    try {
      // Use INSERT ... ON CONFLICT to avoid race conditions
      const upsertQuery = includeTransferDate ? `
        INSERT INTO ens_names (token_id, name, owner_address, last_transfer_date, expiry_date, registration_date, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), $4, $5, $6, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          name = CASE
            WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          last_transfer_date = NOW(),
          expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
          registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
          metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
          updated_at = NOW()
        RETURNING id
      ` : `
        INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          name = CASE
            WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
          registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
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
        JSON.stringify(textRecords)
      ]);
      return result.rows[0].id;
    } catch (error: any) {
      // If we get a unique constraint violation on name, it means the name already exists
      // with a different token_id. This could be a data inconsistency issue.
      if (error.code === '23505' && error.constraint === 'ens_names_real_name_unique') {
        logger.warn(`ENS name "${name}" already exists with different token_id. Fetching existing record.`);

        // Fetch the existing record by name
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