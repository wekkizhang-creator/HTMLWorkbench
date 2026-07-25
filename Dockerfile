FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HEALTHCHECK_HOST=localhost:3000
ENV HTML_WORKBENCH_DATA_DIR=/data

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "const http=require('node:http');const port=Number(process.env.PORT||3000);const request=http.get({hostname:'127.0.0.1',path:'/healthz',port,headers:{Host:process.env.HEALTHCHECK_HOST||('localhost:'+port)}},(response)=>process.exit(response.statusCode>=200&&response.statusCode<300?0:1));request.setTimeout(4000,()=>request.destroy());request.on('error',()=>process.exit(1));"]

CMD ["node", "server.js"]
