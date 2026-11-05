FROM node:22-alpine

WORKDIR /app

# node-pg-migrate is a dev dependency and the migrate service needs it, so install everything first.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN mkdir -p uploads/question-imports && chown -R node:node /app/uploads

ENV NODE_ENV=production
USER node
EXPOSE 4100
CMD ["node", "src/server.js"]
