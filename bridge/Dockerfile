FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY tests ./tests

RUN npm run build

CMD ["npm", "run", "start"]
