FROM node:22-alpine

RUN apk add --no-cache git ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data logs uploads

EXPOSE 3000

CMD ["node", "server/index.js"]
