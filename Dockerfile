FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Data volume for SQLite database + cache
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.js"]
