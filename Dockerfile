FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN mkdir -p data public/uploads

EXPOSE 19100

CMD ["node", "server.js"]
