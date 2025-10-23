'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useProfileActivity, ActivityEvent } from '@/hooks/useProfile';
import { formatEther } from 'viem';

interface ProfileActivityProps {
  address: string;
  limit?: number;
}

export function ProfileActivity({ address, limit = 50 }: ProfileActivityProps) {
  const { data, isLoading, error, refetch } = useProfileActivity(address, limit);
  const [liveActivity, setLiveActivity] = useState<ActivityEvent[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  // WebSocket connection for live updates
  useEffect(() => {
    if (!address) return;

    const ws = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}/activity`);

    ws.onopen = () => {
      console.log('Activity WebSocket connected');
      setWsConnected(true);

      // Subscribe to this address
      ws.send(JSON.stringify({
        type: 'subscribe_address',
        address: address.toLowerCase(),
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'activity_event') {
          // Add new activity to the beginning of the list
          setLiveActivity((prev) => [message.data, ...prev]);
        } else if (message.type === 'subscribed') {
          console.log('Subscribed to address activity:', message);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.log('WebSocket error:', error);
      setWsConnected(false);
    };

    ws.onclose = () => {
      console.log('Activity WebSocket disconnected');
      setWsConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'unsubscribe_address',
          address: address.toLowerCase(),
        }));
      }
      ws.close();
    };
  }, [address]);

  // Combine live activity with fetched data
  const allActivity = [...liveActivity, ...(data?.data || [])];

  // Remove duplicates by id
  const uniqueActivity = allActivity.filter(
    (activity, index, self) =>
      index === self.findIndex((a) => a.id === activity.id)
  );

  // Sort by created_at descending
  const sortedActivity = uniqueActivity.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Limit to requested number
  const displayActivity = sortedActivity.slice(0, limit);

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'listed':
        return '🏷️';
      case 'listing_updated':
        return '✏️';
      case 'offer_made':
        return '💰';
      case 'bought':
        return '🛒';
      case 'sold':
        return '💵';
      case 'offer_accepted':
        return '✅';
      case 'cancelled':
        return '❌';
      case 'mint':
        return '✨';
      case 'burn':
        return '🔥';
      case 'sent':
        return '📤';
      case 'received':
        return '📥';
      default:
        return '📝';
    }
  };

  const getEventLabel = (eventType: string) => {
    return eventType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
        <h2 className="text-2xl font-bold text-white mb-6">Activity</h2>
        <div className="animate-pulse space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
        <h2 className="text-2xl font-bold text-white mb-6">Activity</h2>
        <p className="text-red-400">Failed to load activity</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-white">Activity</h2>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`}></span>
          <span className="text-sm text-gray-400">
            {wsConnected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>

      {displayActivity.length === 0 ? (
        <p className="text-gray-400">No activity found for this address.</p>
      ) : (
        <div className="space-y-3">
          {displayActivity.map((activity) => (
            <Link
              key={activity.id}
              href={`/names/${activity.name}`}
              className="block bg-gray-900 rounded-lg p-4 border border-gray-700 hover:border-purple-500 transition"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">{getEventIcon(activity.event_type)}</span>
                    <span className="text-white font-semibold">
                      {getEventLabel(activity.event_type)}
                    </span>
                    <span className="text-purple-400 font-mono">{activity.name}</span>
                  </div>

                  <div className="text-sm text-gray-400 space-y-1">
                    <p>
                      <span className="text-gray-500">From:</span>{' '}
                      <span className="font-mono">
                        {`${activity.actor_address.slice(0, 6)}...${activity.actor_address.slice(-4)}`}
                      </span>
                    </p>
                    {activity.counterparty_address && (
                      <p>
                        <span className="text-gray-500">To:</span>{' '}
                        <span className="font-mono">
                          {`${activity.counterparty_address.slice(0, 6)}...${activity.counterparty_address.slice(-4)}`}
                        </span>
                      </p>
                    )}
                    {activity.price_wei && (
                      <p>
                        <span className="text-gray-500">Price:</span>{' '}
                        <span className="text-white font-semibold">
                          {formatEther(BigInt(activity.price_wei))} ETH
                        </span>
                      </p>
                    )}
                    <p>
                      <span className="text-gray-500">Platform:</span>{' '}
                      <span className="capitalize">{activity.platform}</span>
                    </p>
                  </div>
                </div>

                <div className="text-right text-xs text-gray-500">
                  {new Date(activity.created_at).toLocaleString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
