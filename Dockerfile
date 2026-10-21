FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV TZ=America/Fortaleza

# ferramentas para compilar o better-sqlite3, caso não haja binário pronto
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY *.js *.html *.css ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
