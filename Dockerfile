FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/freewheel.db
ENV MCP_PATH=/mcp
ENV HEALTH_PATH=/health

EXPOSE 3000

CMD ["node", "src/main.js"]
