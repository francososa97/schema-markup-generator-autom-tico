FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm install

COPY . .
RUN npm run prisma:generate && npm run build

EXPOSE 3000
CMD ["npm", "start"]
