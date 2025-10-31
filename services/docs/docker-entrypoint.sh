#!/bin/sh
set -e

# Default to port 80 if PORT is not set (for local Docker)
export PORT=${PORT:-80}

echo "Starting nginx on port $PORT..."

# Substitute environment variables in nginx config
envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

# Start nginx
exec nginx -g 'daemon off;'
