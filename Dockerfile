FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq git python3 make g++

WORKDIR /app

RUN git clone https://github.com/KevinFlynn1212/ceelo-game.git /app

RUN npm install

ENV PORT=3000
ENV AUTH_PORT=4001

EXPOSE 3000

CMD node auth-server.js & node server.js
