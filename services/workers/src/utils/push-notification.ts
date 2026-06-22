import { getPostgresPool, config } from '../../../shared/src'
import { logger } from '../utils/logger'
import type { SendNotificationJob } from '../queue'
import webPush from 'web-push'

const FRONTEND_URL = config.frontend.url

interface PushSubscriptionRow {
	id: number
	endpoint: string
	p256dh: string
	auth: string
}

function configureWebPush(): boolean {
	if (
		!config.webPush.enabled ||
		!config.webPush.publicKey ||
		!config.webPush.privateKey
	) {
		return false
	}

	webPush.setVapidDetails(
		config.webPush.subject,
		config.webPush.publicKey,
		config.webPush.privateKey,
	)

	return true
}

function buildPushBody(
	type: SendNotificationJob['type'],
	ensName: string,
	metadata: Record<string, any> | undefined,
): string {
	switch (type) {
		case 'new-listing':
			return `${ensName} was listed${typeof metadata?.priceWei === 'string' ? ' on Grails' : ''}`
		case 'price-change':
			return `${ensName} has a new listing price`
		case 'sale':
			return `${ensName} sold`
		case 'new-offer':
		case 'offer-received':
			return `${ensName} received a new offer`
		case 'listing-sold':
			return `Your listing for ${ensName} sold`
		case 'listing-cancelled-ownership-change':
		case 'listing-cancelled':
			return `The listing for ${ensName} was cancelled`
		case 'comment-received':
			return `${ensName} received a new comment`
	}
}

function buildPushTitle(type: SendNotificationJob['type']): string {
	switch (type) {
		case 'new-listing':
			return 'New listing'
		case 'price-change':
			return 'Price changed'
		case 'sale':
			return 'Name sold'
		case 'new-offer':
		case 'offer-received':
			return 'New offer'
		case 'listing-sold':
			return 'Listing sold'
		case 'listing-cancelled-ownership-change':
		case 'listing-cancelled':
			return 'Listing cancelled'
		case 'comment-received':
			return 'New comment'
	}
}

export async function sendPushNotifications(params: {
	userId: number
	type: SendNotificationJob['type']
	ensName: string
	notificationId: number
	metadata?: Record<string, unknown>
}): Promise<void> {
	if (!configureWebPush()) {
		logger.debug(
			{ userId: params.userId },
			'Web Push not configured, skipping push delivery',
		)
		return
	}

	const pool = getPostgresPool()
	const subscriptionsResult = await pool.query<PushSubscriptionRow>(
		`SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = $1
       AND enabled = TRUE
       AND (expiration_time IS NULL OR expiration_time > NOW())`,
		[params.userId],
	)

	if (subscriptionsResult.rows.length === 0) {
		logger.debug(
			{ userId: params.userId },
			'No active push subscriptions for user',
		)
		return
	}

	const payload = JSON.stringify({
		title: buildPushTitle(params.type),
		body: buildPushBody(params.type, params.ensName, params.metadata),
		url: `${FRONTEND_URL}/${params.ensName}`,
		notificationId: params.notificationId,
		type: params.type,
		metadata: params.metadata || {},
	})

	const results = await Promise.allSettled(
		subscriptionsResult.rows.map(
			async (subscriptionRow: PushSubscriptionRow) => {
				const subscription: webPush.PushSubscription = {
					endpoint: subscriptionRow.endpoint,
					keys: {
						p256dh: subscriptionRow.p256dh,
						auth: subscriptionRow.auth,
					},
				}

				try {
					await webPush.sendNotification(subscription, payload, {
						TTL: config.webPush.ttlSeconds,
					})
				} catch (error) {
					if (
						error instanceof webPush.WebPushError &&
						(error.statusCode === 404 || error.statusCode === 410)
					) {
						await pool.query(
							'DELETE FROM push_subscriptions WHERE id = $1',
							[subscriptionRow.id],
						)
						logger.info(
							{
								userId: params.userId,
								subscriptionId: subscriptionRow.id,
								statusCode: error.statusCode,
							},
							'Removed stale push subscription',
						)
						return
					}

					throw error
				}
			},
		),
	)

	const failedCount = results.filter(
		(result: PromiseSettledResult<void>) => result.status === 'rejected',
	).length
	if (failedCount > 0) {
		logger.warn(
			{
				userId: params.userId,
				failedCount,
				total: subscriptionsResult.rows.length,
			},
			'Some push deliveries failed',
		)
	}
}
