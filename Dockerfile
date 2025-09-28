FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (will install prebuilt binaries for Linux)
RUN npm ci --only=production

# Copy source code
COPY . .

# Expose port (not really needed for the bot, but good practice)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]