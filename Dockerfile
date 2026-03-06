FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Default command starts credential daemon and all active bots interactively.
# Run with: docker run -it -v ./profiles:/app/profiles <image>
# For a specific bot: docker run -it ... <image> node unlock-start.js <bot-name>
CMD ["node", "unlock-start.js"]
