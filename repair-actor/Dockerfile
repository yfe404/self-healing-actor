FROM apify/actor-node:22

COPY package*.json ./
# `npm install`, not `npm ci`: the image's npm 10 reads this npm 12 lockfile as out of sync.
RUN npm --quiet set progress=false && npm install --include=dev --no-audit --no-fund

COPY . ./
RUN npm run build && npm prune --omit=dev

CMD npm start --silent
