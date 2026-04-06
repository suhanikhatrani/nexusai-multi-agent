FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY backend/package*.json ./
RUN npm ci --only=production

# Copy backend source
COPY backend/server.js ./
COPY frontend/ ./frontend/

# Create directory for SQLite database
RUN mkdir -p /data

# Cloud Run sets PORT automatically
ENV PORT=8080
ENV DATABASE_PATH=/data/nexusai.db

EXPOSE 8080

CMD ["node", "server.js"]
