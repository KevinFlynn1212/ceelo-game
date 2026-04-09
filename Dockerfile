FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq git python3 make g++

WORKDIR /app

# Copy package.json first for layer caching
COPY package.json ./

# Install dependencies
RUN npm install

# Copy all source files
COPY . .

ENV PORT=3000
ENV AUTH_PORT=4001

EXPOSE 3000

CMD node auth-server.js & node server.js
