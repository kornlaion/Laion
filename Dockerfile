# Railway builds this automatically when a Dockerfile is present.
# ffmpeg renders the videos; fonts-thai-tlwg gives libass a Thai font (Loma) for subtitles.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-thai-tlwg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "api/server.mjs"]
