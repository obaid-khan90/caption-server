# Use a lightweight Node.js base image
FROM node:18-bullseye-slim

# Install the real FFmpeg binary
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies (only production to save space/time)
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on (Railway maps this automatically)
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]
