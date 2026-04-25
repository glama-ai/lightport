FROM node:24-alpine

WORKDIR /app

# Upgrade system packages and install pnpm
RUN apk upgrade --no-cache && npm install -g pnpm

# Copy package files first
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install

# Copy the rest of the application
COPY . .

# Build
RUN pnpm run build

EXPOSE 8787

CMD ["pnpm", "run", "start:node"]