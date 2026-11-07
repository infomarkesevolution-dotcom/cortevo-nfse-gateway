FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV PORT=8080
ENV CERT_DIR=/data/certs
RUN mkdir -p /data/certs

EXPOSE 8080
CMD ["node", "server.js"]
